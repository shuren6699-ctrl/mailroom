import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { getAccessSyncStatus, synchronizeAccessPolicy, accessSyncRevisionStatement } from "../src/worker/access-sync.ts";

const ADMIN = "shuren6699@gmail.com";
const ACCOUNT = "a".repeat(32);
const POLICY = "5c559533-faa7-469f-9ad3-eb040cdfc137";
const TOKEN = "test-secret-must-never-be-returned";
const ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/access/policies/${POLICY}`;

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  function statement(sql, args = []) {
    return {
      bind: (...values) => statement(sql, values),
      async first(column) { const row = db.prepare(sql).get(...args); return column ? row?.[column] ?? null : row ?? null; },
      async all() { return { results: db.prepare(sql).all(...args), success: true }; },
      async run() {
        const result = db.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
    };
  }
  const env = {
    DB: {
      prepare: statement,
      async batch(statements) {
        db.exec("BEGIN IMMEDIATE");
        try {
          const results = [];
          for (const item of statements) results.push(await item.run());
          db.exec("COMMIT");
          return results;
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      },
    },
    CF_ACCESS_API_TOKEN: TOKEN,
    ACCESS_SYNC_ACCOUNT_ID: ACCOUNT,
    ACCESS_SYNC_POLICY_ID: POLICY,
  };
  const add = (email, enabled = 1, role = "member") => db.prepare("INSERT INTO members (email, enabled, role) VALUES (?, ?, ?)").run(email, enabled, role);
  const state = () => ({ ...db.prepare("SELECT * FROM access_sync_state WHERE id = 1").get() });
  return { db, env, add, state };
}

function policy(overrides = {}) {
  return {
    id: POLICY, account_id: ACCOUNT, app_count: 1, reusable: true,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    name: "mailroom-team", decision: "allow",
    include: [{ email: { email: ADMIN } }, { email: { email: "legacy@example.net" } }],
    require: [{ auth_method: { auth_method: "mfa" } }], exclude: [{ ip: { ip: "192.0.2.0/24" } }],
    session_duration: "8h", approval_required: true,
    approval_groups: [{ approvals_needed: 1, email_addresses: [ADMIN] }],
    isolation_required: true, purpose_justification_required: true, purpose_justification_prompt: "Explain access",
    mfa_config: { allowed_authenticators: ["security_key"], mfa_disabled: false, session_duration: "1h" },
    connection_rules: { rdp: { allowed_clipboard_local_to_remote_formats: ["text"], allowed_clipboard_remote_to_local_formats: [] } },
    ...overrides,
  };
}

function upstream(t, initial = policy(), onRequest) {
  let current = structuredClone(initial);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const request = { url: String(url), ...init };
    calls.push(request);
    if (onRequest) {
      const result = await onRequest(request, current);
      if (result) return result;
    }
    if (init.method === "PUT") current = { ...current, ...JSON.parse(init.body) };
    return Response.json({ success: true, result: current, errors: [], messages: [] });
  });
  return { calls, current: () => current, writes: () => calls.filter((item) => item.method === "PUT") };
}

function assertSafe(status, f) {
  assert.equal(status.state, "error");
  assert.ok(status.message.length > 0);
  assert.ok(!JSON.stringify(status).includes(TOKEN));
  assert.ok(!JSON.stringify(f.state()).includes(TOKEN));
  assert.equal(f.state().lease_token, null);
  assert.equal(f.state().synced_revision, 0);
}

test("migration starts pending and revision increments participate in atomic member batches", async (t) => {
  const f = fixture(t);
  assert.equal(f.state().revision, 1);
  assert.equal(f.state().synced_revision, 0);
  assert.equal((await getAccessSyncStatus(f.env)).state, "pending");
  await f.env.DB.batch([
    f.env.DB.prepare("INSERT INTO members (email) VALUES ('first@example.net')"),
    accessSyncRevisionStatement(f.env.DB),
  ]);
  assert.equal(f.state().revision, 2);
  await assert.rejects(f.env.DB.batch([
    accessSyncRevisionStatement(f.env.DB),
    f.env.DB.prepare("INSERT INTO members (email) VALUES ('first@example.net')"),
  ]));
  assert.equal(f.state().revision, 2);
});

test("absent token stays not configured and never contacts Cloudflare", async (t) => {
  const f = fixture(t);
  delete f.env.CF_ACCESS_API_TOKEN;
  const cf = upstream(t);
  const status = await synchronizeAccessPolicy(f.env);
  assert.equal(status.configured, false);
  assert.equal(status.state, "not_configured");
  assert.equal(cf.calls.length, 0);
});

test("enabled member emails are canonical sorted deduplicated, disabled and legacy emails removed, owner retained", async (t) => {
  const f = fixture(t);
  f.add(" Zed@Example.net ");
  f.add("zed@example.net");
  f.add("alice@example.net");
  f.add("disabled@example.net", 0);
  const cf = upstream(t);
  const status = await synchronizeAccessPolicy(f.env);
  assert.equal(status.state, "synced");
  assert.deepEqual(cf.current().include, [
    { email: { email: "alice@example.net" } },
    { email: { email: ADMIN } },
    { email: { email: "zed@example.net" } },
  ]);
  assert.equal(f.state().synced_revision, 1);
  assert.ok(status.last_synced_at);
  assert.equal(f.state().lease_token, null);
  assert.equal((await getAccessSyncStatus(f.env)).state, "synced");
  for (const request of cf.calls) {
    assert.equal(request.url, ENDPOINT);
    assert.equal(request.redirect, "manual");
    assert.ok(request.signal instanceof AbortSignal);
    assert.equal(new Headers(request.headers).get("Authorization"), `Bearer ${TOKEN}`);
  }
});

test("PUT retains all documented safety constraints without sending response metadata", async (t) => {
  const f = fixture(t);
  const original = policy();
  const cf = upstream(t, original);
  assert.equal((await synchronizeAccessPolicy(f.env)).state, "synced");
  const written = JSON.parse(cf.writes()[0].body);
  for (const key of ["require", "exclude", "session_duration", "approval_required", "approval_groups", "isolation_required", "purpose_justification_required", "purpose_justification_prompt", "mfa_config", "connection_rules"]) {
    assert.deepEqual(written[key], original[key], key);
  }
  for (const key of ["id", "account_id", "app_count", "created_at", "updated_at", "reusable"]) assert.ok(!(key in written), key);
});

test("owner must be the sole enabled administrator before any remote write", async (t) => {
  for (const mutation of [
    (f) => f.db.prepare("UPDATE members SET enabled = 0 WHERE email = ?").run(ADMIN),
    (f) => f.db.prepare("UPDATE members SET role = 'member' WHERE email = ?").run(ADMIN),
    (f) => f.add("another-admin@example.net", 1, "admin"),
  ]) {
    const f = fixture(t);
    mutation(f);
    const cf = upstream(t);
    assertSafe(await synchronizeAccessPolicy(f.env), f);
    assert.equal(cf.writes().length, 0);
  }
});

test("unexpected targets, Everyone and mixed include rules fail closed before PUT", async (t) => {
  for (const invalid of [
    { name: "other-policy" }, { decision: "bypass" }, { decision: "deny" },
    { id: "00000000-0000-0000-0000-000000000000" }, { account_id: "b".repeat(32) },
    { include: [{ everyone: {} }] }, { include: [{ email_domain: { domain: "example.net" } }] },
    { include: [{ email: { email: ADMIN }, everyone: {} }] }, { include: [] },
    { include: [{ email: { email: "*@example.net" } }] },
    { future_security_constraint: true },
  ]) {
    const f = fixture(t);
    const cf = upstream(t, policy(invalid));
    assertSafe(await synchronizeAccessPolicy(f.env), f);
    assert.equal(cf.writes().length, 0, JSON.stringify(invalid));
  }
});

test("a policy reused by another application or lacking attachment metadata is never changed", async (t) => {
  for (const appCount of [0, 2, undefined]) {
    const f = fixture(t);
    const cf = upstream(t, policy({ app_count: appCount }));
    assertSafe(await synchronizeAccessPolicy(f.env), f);
    assert.equal(cf.writes().length, 0);
  }
});

test("invalid target configuration cannot redirect the API token to a caller chosen endpoint", async (t) => {
  for (const values of [
    { ACCESS_SYNC_ACCOUNT_ID: "https://attacker.example" },
    { ACCESS_SYNC_POLICY_ID: "../policies/other" },
    { CF_ACCESS_API_TOKEN: `${TOKEN}\r\nInjected: secret` },
  ]) {
    const f = fixture(t);
    Object.assign(f.env, values);
    const cf = upstream(t);
    const status = await synchronizeAccessPolicy(f.env);
    assert.equal(status.state, "error");
    assert.ok(!JSON.stringify(status).includes(TOKEN));
    assert.equal(cf.calls.length, 0);
  }
});

test("CF rejection and network errors remain safe retryable statuses and release the lease", async (t) => {
  for (const behavior of [
    () => new Response(`upstream details ${TOKEN}`, { status: 403 }),
    () => Response.json({ success: false, errors: [{ message: TOKEN }] }),
    () => { throw new Error(`network request headers ${TOKEN}`); },
  ]) {
    const f = fixture(t);
    upstream(t, policy(), behavior);
    const status = await synchronizeAccessPolicy(f.env);
    assertSafe(status, f);
    assert.match(status.message, /重试/);
    assert.equal((await getAccessSyncStatus(f.env)).state, "error");
  }
});

test("a successful PUT with the wrong emails or weakened constraints is never reported synced", async (t) => {
  for (const invalid of [
    { include: [{ email: { email: "wrong@example.net" } }] },
    { require: [] }, { exclude: [] }, { session_duration: "24h" },
  ]) {
    const f = fixture(t);
    upstream(t, policy(), (request, current) => {
      if (request.method === "PUT") return Response.json({ success: true, result: { ...current, ...JSON.parse(request.body), ...invalid } });
    });
    assertSafe(await synchronizeAccessPolicy(f.env), f);
  }
});

test("a hanging CF request is aborted within a bounded timeout and can be retried", async (t) => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  upstream(t, policy(), (request) => new Promise((resolve, reject) => {
    request.signal.addEventListener("abort", () => reject(new Error(`aborted ${TOKEN}`)), { once: true });
    started();
  }));
  const syncing = synchronizeAccessPolicy(f.env);
  await entered;
  t.mock.timers.tick(15_001);
  assertSafe(await syncing, f);
});

test("a valid Cloudflare policy response delayed six seconds can complete synchronization", async (t) => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const cf = upstream(t, policy(), (request, current) => {
    if (request.method === "GET") return new Promise((resolve) => {
      setTimeout(() => resolve(Response.json({ success: true, result: current })), 6_000);
      started();
    });
  });
  const syncing = synchronizeAccessPolicy(f.env);
  await entered;
  t.mock.timers.tick(6_000);
  const status = await syncing;
  assert.equal(status.state, "synced");
  assert.ok(status.last_synced_at);
  assert.equal(cf.writes().length, 1);
  assert.equal(f.state().synced_revision, 1);
  assert.equal(f.state().lease_token, null);
});

test("an active database lease serializes independent synchronizers and a stale lease can be reclaimed", async (t) => {
  const f = fixture(t);
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let paused = false;
  const cf = upstream(t, policy(), async () => {
    if (!paused) { paused = true; entered(); await gate; }
  });
  const first = synchronizeAccessPolicy(f.env);
  await started;
  const token = f.state().lease_token;
  const second = await synchronizeAccessPolicy(f.env);
  assert.equal(second.state, "pending");
  assert.equal(cf.calls.length, 1);
  assert.equal(f.state().lease_token, token);
  release();
  assert.equal((await first).state, "synced");
  f.db.prepare("UPDATE access_sync_state SET lease_token = 'dead-worker', lease_until = 0").run();
  assert.equal((await synchronizeAccessPolicy(f.env)).state, "synced");
  assert.equal(f.state().lease_token, null);
});

test("a revision changed during CF GET is reconciled using the latest enabled list", async (t) => {
  const f = fixture(t);
  f.add("removed@example.net");
  let changed = false;
  const cf = upstream(t, policy(), async (request) => {
    if (request.method === "GET" && !changed) {
      changed = true;
      await f.env.DB.batch([
        f.env.DB.prepare("UPDATE members SET enabled = 0 WHERE email = 'removed@example.net'"),
        f.env.DB.prepare("INSERT INTO members (email) VALUES ('latest@example.net')"),
        accessSyncRevisionStatement(f.env.DB),
      ]);
    }
  });
  assert.equal((await synchronizeAccessPolicy(f.env)).state, "synced");
  assert.deepEqual(cf.current().include, [{ email: { email: "latest@example.net" } }, { email: { email: ADMIN } }]);
  assert.equal(f.state().synced_revision, 2);
});

test("a revision changed during PUT never marks the new revision as synchronized prematurely", async (t) => {
  const f = fixture(t);
  let writes = 0;
  const cf = upstream(t, policy(), async (request) => {
    if (request.method === "PUT") {
      writes++;
      if (writes === 1) {
        await f.env.DB.batch([
          f.env.DB.prepare("INSERT INTO members (email) VALUES ('late@example.net')"),
          accessSyncRevisionStatement(f.env.DB),
        ]);
        assert.notEqual((await getAccessSyncStatus(f.env)).state, "synced");
        assert.equal(f.state().synced_revision, 0);
      }
    }
  });
  assert.equal((await synchronizeAccessPolicy(f.env)).state, "synced");
  assert.equal(writes, 2);
  assert.deepEqual(cf.current().include, [{ email: { email: "late@example.net" } }, { email: { email: ADMIN } }]);
  assert.equal(f.state().synced_revision, 2);
});

test("continuous membership changes stop after bounded attempts and remain pending", async (t) => {
  const f = fixture(t);
  const cf = upstream(t, policy(), async (request) => {
    if (request.method === "PUT") await accessSyncRevisionStatement(f.env.DB).run();
  });
  assert.equal((await synchronizeAccessPolicy(f.env)).state, "pending");
  assert.ok(cf.writes().length > 0 && cf.writes().length <= 3);
  assert.equal(f.state().synced_revision, 0);
  assert.equal(f.state().last_synced_at, null);
  assert.equal(f.state().lease_token, null);
});

test("a new lease owner cannot be released or have its state overwritten by the old worker", async (t) => {
  const f = fixture(t);
  const cf = upstream(t, policy(), async (request) => {
    if (request.method === "GET") f.db.prepare("UPDATE access_sync_state SET lease_token = 'other-worker', lease_until = ?").run(Date.now() + 60_000);
  });
  assert.equal((await synchronizeAccessPolicy(f.env)).state, "pending");
  assert.equal(cf.writes().length, 0);
  assert.equal(f.state().lease_token, "other-worker");
  assert.equal(f.state().synced_revision, 0);
});

test("stored error text is never trusted as a user visible message", async (t) => {
  const f = fixture(t);
  f.db.prepare("UPDATE access_sync_state SET last_error = ?").run(TOKEN);
  const status = await getAccessSyncStatus(f.env);
  assert.equal(status.state, "error");
  assert.ok(!JSON.stringify(status).includes(TOKEN));
});

test("policy validation reports safe actionable reasons and persists them without weakening guards", async (t) => {
  const cases = [
    [{ app_count: undefined }, /应用关联数量缺失或格式无效/, "policy_attachment_metadata"],
    [{ app_count: 2 }, /并非仅供一个应用使用/, "policy_attachment_count"],
    [{ name: "other-policy" }, /名称、ID 或允许操作不匹配/, "policy_identity"],
    [{ future_security_constraint: TOKEN }, /包含当前同步程序不支持的字段/, "policy_fields"],
    [{ include: [{ everyone: {} }] }, /邮箱包含规则格式不受支持/, "policy_rules"],
    [{ require: null }, /Require 或 Exclude 规则格式无效/, "policy_constraints"],
  ];
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));
  for (const [override, message, reason] of cases) {
    const f = fixture(t);
    const cf = upstream(t, policy(override));
    const status = await synchronizeAccessPolicy(f.env);
    assertSafe(status, f);
    assert.match(status.message, message);
    assert.equal((await getAccessSyncStatus(f.env)).message, status.message);
    assert.equal(cf.writes().length, 0);
    const diagnostic = warnings.at(-1)?.[1];
    assert.equal(diagnostic?.phase, "get");
    assert.equal(diagnostic?.reason, reason);
  }
  assert.ok(!JSON.stringify(warnings).includes(TOKEN));
  assert.ok(!JSON.stringify(warnings).includes("legacy@example.net"));
});

test("unsupported-field diagnostics bound and sanitize names without logging payload values or credentials", async (t) => {
  const f = fixture(t);
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));
  const extras = { safe_future_field: { nested: TOKEN }, [TOKEN]: "private-value", ["x".repeat(65)]: "private-value" };
  for (let i = 0; i < 20; i++) extras[`future_${i}`] = TOKEN;
  const cf = upstream(t, policy(extras));
  const status = await synchronizeAccessPolicy(f.env);
  assertSafe(status, f);
  assert.match(status.message, /包含当前同步程序不支持的字段/);
  assert.equal(cf.writes().length, 0);
  const diagnostic = warnings[0]?.[1];
  assert.equal(diagnostic?.phase, "get");
  assert.equal(diagnostic?.reason, "policy_fields");
  assert.equal(diagnostic?.unexpected_field_count, 23);
  assert.ok(diagnostic.unexpected_fields.includes("safe_future_field"));
  assert.ok(diagnostic.unexpected_fields.length <= 16);
  assert.ok(diagnostic.unexpected_fields.every((name) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)));
  assert.ok(!JSON.stringify(warnings).includes(TOKEN));
  assert.ok(!JSON.stringify(warnings).includes("private-value"));
});

test("PUT guard and content comparison failures identify their stage and never report synced", async (t) => {
  const cases = [
    [{ app_count: undefined }, /应用关联数量缺失或格式无效/, "policy_attachment_metadata"],
    [{ include: [{ email: { email: "wrong@example.net" } }] }, /返回的邮箱白名单与已保存成员不一致/, "policy_emails_changed"],
    [{ require: [] }, /返回的安全约束与原策略不一致/, "policy_constraints_changed"],
  ];
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));
  for (const [override, message, reason] of cases) {
    const f = fixture(t);
    upstream(t, policy(), (request, current) => {
      if (request.method === "PUT") return Response.json({ success: true, result: { ...current, ...JSON.parse(request.body), ...override } });
    });
    const status = await synchronizeAccessPolicy(f.env);
    assertSafe(status, f);
    assert.match(status.message, message);
    assert.equal((await getAccessSyncStatus(f.env)).message, status.message);
    assert.equal(warnings.at(-1)?.[1]?.phase, "put");
    assert.equal(warnings.at(-1)?.[1]?.reason, reason);
  }
  assert.ok(!JSON.stringify(warnings).includes(TOKEN));
  assert.ok(!JSON.stringify(warnings).includes("wrong@example.net"));
});

function requestDiagnostics(t) {
  const entries = [];
  t.mock.method(console, "info", (prefix, details) => entries.push({ prefix, ...details }));
  return entries;
}

function assertRequestDiagnosticsSafe(entries) {
  for (const entry of entries) {
    assert.equal(entry.prefix, "Cloudflare Access sync request");
    assert.ok(["GET", "PUT"].includes(entry.method));
    assert.ok(Number.isFinite(entry.elapsed_ms) && entry.elapsed_ms >= 0);
    assert.ok(Object.keys(entry).every((key) =>
      ["prefix", "method", "phase", "elapsed_ms", "status", "waiting_for", "reason"].includes(key)));
  }
  const serialized = JSON.stringify(entries);
  for (const privateText of [TOKEN, ENDPOINT, ADMIN, "legacy@example.net", "private-upstream-detail"]) {
    assert.ok(!serialized.includes(privateText), privateText);
  }
}

test("request diagnostics identify a GET timeout before response headers without exposing upstream data", async (t) => {
  const f = fixture(t);
  const entries = requestDiagnostics(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  upstream(t, policy(), (request) => new Promise((resolve, reject) => {
    request.signal.addEventListener("abort", () => reject(new Error(`private-upstream-detail ${TOKEN}`)), { once: true });
    started();
  }));
  const syncing = synchronizeAccessPolicy(f.env);
  await entered;
  t.mock.timers.tick(15_001);
  assertSafe(await syncing, f);
  assert.deepEqual(entries.map((entry) => entry.phase), ["request_start", "request_failed"]);
  const failure = entries.at(-1);
  assert.equal(failure.method, "GET");
  assert.equal(failure.waiting_for, "response_headers");
  assert.equal(failure.reason, "timeout");
  assert.ok(failure.elapsed_ms >= 15_000);
  assert.equal(failure.status, undefined);
  assertRequestDiagnosticsSafe(entries);
});

test("request diagnostics distinguish a PUT response body timeout after successful GET and headers", async (t) => {
  const f = fixture(t);
  const entries = requestDiagnostics(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  let started;
  const readingBody = new Promise((resolve) => { started = resolve; });
  const cf = upstream(t, policy(), (request) => {
    if (request.method !== "PUT") return;
    const response = new Response(`private-upstream-detail ${TOKEN}`, { status: 200 });
    t.mock.method(response, "json", () => new Promise((resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error(TOKEN)), { once: true });
      started();
    }));
    return response;
  });
  const syncing = synchronizeAccessPolicy(f.env);
  await readingBody;
  t.mock.timers.tick(15_001);
  assertSafe(await syncing, f);
  assert.equal(cf.writes().length, 1);
  assert.deepEqual(entries.filter((entry) => entry.method === "GET").map((entry) => entry.phase),
    ["request_start", "response_headers", "response_body"]);
  assert.deepEqual(entries.filter((entry) => entry.method === "PUT").map((entry) => entry.phase),
    ["request_start", "response_headers", "request_failed"]);
  const failure = entries.at(-1);
  assert.equal(failure.method, "PUT");
  assert.equal(failure.waiting_for, "response_body");
  assert.equal(failure.reason, "timeout");
  assert.equal(failure.status, 200);
  assert.ok(failure.elapsed_ms >= 15_000);
  assertRequestDiagnosticsSafe(entries);
});

test("request diagnostics retain HTTP rejection status while excluding headers and body text", async (t) => {
  const f = fixture(t);
  const entries = requestDiagnostics(t);
  const cf = upstream(t, policy(), () => new Response(`private-upstream-detail ${TOKEN}`, {
    status: 403, headers: { "X-Private": TOKEN, "CF-Ray": TOKEN },
  }));
  assertSafe(await synchronizeAccessPolicy(f.env), f);
  assert.equal(cf.writes().length, 0);
  assert.deepEqual(entries.map((entry) => entry.phase), ["request_start", "response_headers", "request_failed"]);
  assert.equal(entries.at(-1).status, 403);
  assert.equal(entries.at(-1).reason, "api");
  assert.equal(entries.at(-1).waiting_for, undefined);
  assertRequestDiagnosticsSafe(entries);
});

test("request diagnostics replace arbitrary network exception text with a fixed classification", async (t) => {
  const f = fixture(t);
  const entries = requestDiagnostics(t);
  upstream(t, policy(), () => { throw new Error(`private-upstream-detail ${TOKEN} ${ENDPOINT}`); });
  assertSafe(await synchronizeAccessPolicy(f.env), f);
  assert.deepEqual(entries.map((entry) => entry.phase), ["request_start", "request_failed"]);
  assert.equal(entries.at(-1).reason, "network");
  assert.equal(entries.at(-1).waiting_for, "response_headers");
  assertRequestDiagnosticsSafe(entries);
});
