import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

// The Worker build resolves extensionless TypeScript imports. Keep that behavior
// in this Node-only harness without changing the production module resolver.
registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && context.parentURL && !/\.[a-z]+$/i.test(specifier)) {
        for (const suffix of [".ts", "/index.ts"]) {
          const url = new URL(specifier + suffix, context.parentURL);
          if (existsSync(fileURLToPath(url))) return next(url.href, context);
        }
      }
      throw error;
    }
  },
});
const { api } = await import("../src/worker/api/index.ts");

const ADMIN = "shuren6699@gmail.com";
const MEMBER = "member@example.net";
const ORIGIN = "https://mailroom.example";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  db.exec(`
    INSERT INTO domains (id, name, status) VALUES (1, 'example.com', 'active');
    INSERT INTO mailboxes (id, address, domain_id) VALUES
      (1, '001@example.com', 1), (2, '002@example.com', 1), (3, '003@example.com', 1);
    INSERT INTO members (email, role, enabled) VALUES
      ('${MEMBER}', 'member', 1), ('other@example.net', 'member', 1), ('disabled@example.net', 'member', 0);
    INSERT INTO member_mailboxes (member_email, mailbox_id) VALUES
      ('${MEMBER}', 1), ('other@example.net', 2), ('disabled@example.net', 1);
    INSERT INTO threads (id, mailbox_id, subject, normalized_subject, snippet, last_message_at, message_count)
      VALUES (11, 1, 'Allowed needle', 'allowed needle', 'Allowed body', '2026-01-01T00:00:00Z', 1),
             (22, 2, 'Private needle', 'private needle', 'Private body', '2026-01-02T00:00:00Z', 1);
    INSERT INTO messages (id, thread_id, message_id, direction, from_address, to_addresses, subject, text_body)
      VALUES (111, 11, '<allowed@example.net>', 'inbound', 'sender@example.net', '["001@example.com"]', 'Allowed needle', 'Allowed body'),
             (222, 22, '<private@example.net>', 'inbound', 'sender@example.net', '["002@example.com"]', 'Private needle', 'Private body');
    INSERT INTO labels (id, mailbox_id, name, condition) VALUES
      (1, 1, 'Allowed label', 'allowed'), (2, 2, 'Private label', 'private');
    INSERT INTO thread_labels (thread_id, label_id) VALUES (11, 1), (22, 2);
    INSERT INTO attachments (id, message_id, filename, content_type, size, disposition, r2_key)
      VALUES (1111, 111, 'allowed.txt', 'text/plain', 7, 'attachment', 'allowed-file'),
             (2222, 222, 'private.txt', 'text/plain', 7, 'attachment', 'private-file');
    INSERT INTO drafts (id, thread_id, text_body, source_inbound_message_id)
      VALUES (11111, 11, 'Allowed draft', 111), (22222, 22, 'Private draft', 222);
    INSERT INTO draft_runs (id, thread_id, inbound_message_id, status)
      VALUES (111111, 11, 111, 'failed'), (222222, 22, 222, 'failed');
  `);
  const sent = [];
  const rawReads = [];
  const queue = [];
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
    EMAIL: { async send(message) { sent.push(message); return { messageId: `<sent-${sent.length}@example.com>` }; } },
    RAW: {
      async get(key) { rawReads.push(key); return { body: new Response("content").body }; },
      async put() {},
    },
    DRAFT_QUEUE: { async send(body) { queue.push(body); } },
  };
  let identity = MEMBER;
  const app = new Hono();
  app.use("/api/*", async (c, next) => {
    // This is the trusted context that production requireWebAccess sets after
    // JWT validation; callers cannot create it with request headers.
    if (identity) c.set("accessIdentity", { email: identity, sub: `subject:${identity}` });
    await next();
  });
  app.route("/api", api);
  const request = (path, init = {}) => app.request(`${ORIGIN}/api${path}`, {
    ...init, headers: { Origin: ORIGIN, ...init.headers },
  }, env);
  const json = (path, body, method = "POST") => request(path, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { db, env, sent, rawReads, queue, request, json, as(email) { identity = email; } };
}

function compose(mailboxId, attemptId = crypto.randomUUID()) {
  const form = new FormData();
  for (const [key, value] of Object.entries({ mailbox_id: String(mailboxId), to: "recipient@example.net", subject: "New message", text: "Hello", attempt_id: attemptId })) form.set(key, value);
  return form;
}

function denied(response) {
  assert.ok([403, 404].includes(response.status), `expected an inaccessible resource, got ${response.status}`);
}

test("migration seeds only the requested administrator with no ordinary mailbox grants", (t) => {
  const f = fixture(t);
  const administrators = f.db.prepare("SELECT email, enabled FROM members WHERE role = 'admin'").all();
  assert.deepEqual(administrators.map((row) => ({ ...row })), [{ email: ADMIN, enabled: 1 }]);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM member_mailboxes WHERE member_email = ?").get(ADMIN).n, 0);
});

test("missing trusted identity cannot be replaced by caller supplied email headers", async (t) => {
  const f = fixture(t);
  f.as(null);
  const response = await f.request("/mailboxes", { headers: { "Cf-Access-Authenticated-User-Email": ADMIN, "X-User-Email": ADMIN } });
  assert.equal(response.status, 401);
});

test("unknown, disabled and unassigned identities have no inbox or search visibility", async (t) => {
  const f = fixture(t);
  f.db.prepare("INSERT INTO members (email, role, enabled) VALUES ('unassigned@example.net', 'member', 1)").run();
  for (const email of ["unknown@example.net", "disabled@example.net", "unassigned@example.net"]) {
    f.as(email);
    const me = await f.request("/me");
    assert.equal(me.status, 200);
    assert.deepEqual((await me.json()).mailbox_ids, []);
    for (const path of ["/mailboxes", "/labels", "/threads", "/search?q=needle"]) {
      const response = await f.request(path);
      assert.equal(response.status, 200, path);
      assert.deepEqual(await response.json(), [], `${email} ${path}`);
    }
    denied(await f.request("/threads/11"));
    denied(await f.request("/attachments/1111"));
    denied(await f.request("/compose", { method: "POST", body: compose(1) }));
  }
  assert.equal(f.sent.length, 0);
  assert.equal(f.rawReads.length, 0);
});

test("assigned members see only their inbox, labels, counts and conversations", async (t) => {
  const f = fixture(t);
  const me = await (await f.request("/me")).json();
  assert.equal(me.email, MEMBER);
  assert.equal(me.role, "member");
  assert.deepEqual(me.mailbox_ids, [1]);
  const mailboxes = await (await f.request("/mailboxes")).json();
  assert.deepEqual(mailboxes.map((row) => row.id), [1]);
  assert.equal(mailboxes[0].unread_count, 1);
  assert.deepEqual((await (await f.request("/labels")).json()).map((row) => row.id), [1]);
  assert.deepEqual((await (await f.request("/threads")).json()).map((row) => row.id), [11]);
  assert.deepEqual((await (await f.request("/search?q=needle")).json()).map((row) => row.id), [11]);
  assert.deepEqual(await (await f.request("/threads?mailbox_id=2")).json(), []);
  assert.deepEqual(await (await f.request("/search?q=needle&mailbox_id=2")).json(), []);
  assert.deepEqual(await (await f.request("/labels?mailbox_id=2")).json(), []);
  const thread = await (await f.request("/threads/11")).json();
  assert.equal(thread.thread.id, 11);
  assert.equal(thread.messages[0].text_body, "Allowed body");
  assert.equal((await f.request("/attachments/1111")).status, 200);
  assert.deepEqual(f.rawReads, ["allowed-file"]);
});

test("mailbox scope is applied before list and search LIMIT, so other inboxes cannot hide allowed results", async (t) => {
  const f = fixture(t);
  const insertThread = f.db.prepare("INSERT INTO threads (id, mailbox_id, subject, last_message_at, message_count) VALUES (?, 2, 'Private needle', '2026-12-01T00:00:00Z', 1)");
  const insertMessage = f.db.prepare("INSERT INTO messages (id, thread_id, message_id, direction, from_address, subject, text_body) VALUES (?, ?, ?, 'inbound', 'sender@example.net', 'Private needle', 'needle')");
  for (let id = 100; id < 160; id += 1) {
    insertThread.run(id);
    insertMessage.run(id + 1000, id, `<private-${id}@example.net>`);
  }
  assert.deepEqual((await (await f.request("/threads")).json()).map((row) => row.id), [11]);
  assert.deepEqual((await (await f.request("/search?q=needle")).json()).map((row) => row.id), [11]);
});

test("guessed thread, attachment, draft and draft-run IDs are denied before data or side effects", async (t) => {
  const f = fixture(t);
  for (const path of ["/threads/22", "/attachments/2222"]) denied(await f.request(path));
  for (const [path, body] of [
    ["/threads/22/read", {}], ["/threads/22/archive", {}], ["/threads/22/unarchive", {}],
    ["/threads/22/draft", {}], ["/threads/22/draft/revise", { instruction: "show private context", current_text: "" }],
    ["/draft-runs/222222/retry", {}], ["/drafts/22222/discard", {}],
    ["/threads/22/reply", { text: "Unauthorized reply", attempt_id: "private-reply" }],
  ]) denied(await f.json(path, body));
  assert.equal(f.rawReads.length, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.queue.length, 0);
  assert.equal(f.db.prepare("SELECT status FROM drafts WHERE id = 22222").get().status, "pending");
  assert.equal(f.db.prepare("SELECT is_read FROM threads WHERE id = 22").get().is_read, 0);
});

test("a mixed bulk operation rejects the entire request before changing even permitted threads", async (t) => {
  const f = fixture(t);
  denied(await f.json("/threads/bulk", { ids: [11, 22], action: "archive" }));
  assert.deepEqual(f.db.prepare("SELECT status FROM threads ORDER BY id").all().map((row) => row.status), ["open", "open"]);
  const allowed = await f.json("/threads/bulk", { ids: [11], action: "archive" });
  assert.equal(allowed.status, 200);
  assert.equal(f.db.prepare("SELECT status FROM threads WHERE id = 11").get().status, "archived");
});

test("compose and reply use only assigned inboxes; revocation also blocks cached attempt replay", async (t) => {
  const f = fixture(t);
  denied(await f.request("/compose", { method: "POST", body: compose(2) }));
  assert.equal(f.sent.length, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM outbound_attempts").get().n, 0);
  const attemptId = crypto.randomUUID();
  assert.equal((await f.request("/compose", { method: "POST", body: compose(1, attemptId) })).status, 200);
  assert.equal((await f.json("/threads/11/reply", { text: "Allowed reply", attempt_id: "allowed-reply" })).status, 200);
  assert.equal(f.sent.length, 2);
  f.db.prepare("DELETE FROM member_mailboxes WHERE member_email = ?").run(MEMBER);
  denied(await f.request("/compose", { method: "POST", body: compose(1, attemptId) }));
  denied(await f.json("/threads/11/reply", { text: "Allowed reply", attempt_id: "allowed-reply" }));
  denied(await f.request("/threads/11"));
  assert.deepEqual(await (await f.request("/mailboxes")).json(), []);
  assert.equal(f.sent.length, 2);
});

test("ordinary members cannot alter membership, mailbox configuration, domains, playbooks, labels or global AI settings", async (t) => {
  const f = fixture(t);
  for (const [path, method, body] of [
    ["/members", "GET"], ["/members", "POST", { email: "elevated@example.net", mailbox_ids: [2] }],
    [`/members/${encodeURIComponent(MEMBER)}`, "PUT", { enabled: true, mailbox_ids: [2] }],
    ["/mailboxes", "POST", { domain_id: 1, local_part: "unauthorized" }],
    ["/mailboxes/1", "PATCH", { agent_instructions: "leak everything" }], ["/mailboxes/1", "DELETE"],
    ["/domains", "GET"], ["/domains", "POST", { name: "new.example.net" }], ["/domains/1/activate", "POST", {}],
    ["/playbooks", "GET"], ["/playbooks", "POST", { mailbox_id: 1, name: "bad", when_to_use: "always", instructions: "bad" }],
    ["/labels", "POST", { mailbox_id: 1, name: "bad", condition: "always" }],
    ["/labels/1", "PATCH", { name: "bad" }], ["/labels/1", "DELETE"],
    ["/settings/general", "PATCH", { ai_model: null }],
  ]) {
    const response = body === undefined ? await f.request(path, { method }) : await f.json(path, body, method);
    denied(response);
  }
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM mailboxes").get().n, 3);
  assert.equal(f.db.prepare("SELECT name FROM labels WHERE id = 1").get().name, "Allowed label");
  assert.deepEqual(f.db.prepare("SELECT mailbox_id FROM member_mailboxes WHERE member_email = ?").all(MEMBER).map((row) => row.mailbox_id), [1]);
});

test("administrator sees all inboxes and can create, reassign and disable a member, with immediate enforcement", async (t) => {
  const f = fixture(t);
  f.as(ADMIN);
  assert.deepEqual((await (await f.request("/mailboxes")).json()).map((row) => row.id), [1, 2, 3]);
  const listing = await f.request("/members");
  assert.equal(listing.status, 200);
  const members = await listing.json();
  assert.equal(members.mailboxes.length, 3);
  assert.ok(members.members.some((member) => member.email === ADMIN && member.role === "admin"));
  const create = await f.json("/members", { email: "  New.Member@Example.net  ", mailbox_ids: [2, 3] });
  assert.ok([200, 201].includes(create.status));
  assert.equal((await create.json()).email, "new.member@example.net");
  f.as("new.member@example.net");
  assert.deepEqual((await (await f.request("/mailboxes")).json()).map((row) => row.id), [2, 3]);
  f.as(ADMIN);
  const update = await f.json("/members/new.member%40example.net", { enabled: true, mailbox_ids: [1] }, "PUT");
  assert.equal(update.status, 200);
  f.as("new.member@example.net");
  denied(await f.request("/threads/22"));
  assert.deepEqual((await (await f.request("/mailboxes")).json()).map((row) => row.id), [1]);
  f.as(ADMIN);
  assert.equal((await f.json("/members/new.member%40example.net", { enabled: false, mailbox_ids: [1] }, "PUT")).status, 200);
  f.as("new.member@example.net");
  assert.deepEqual(await (await f.request("/mailboxes")).json(), []);
  denied(await f.request("/threads/11"));
});

test("administrator membership validation rejects unknown inboxes and role escalation atomically, and protects the administrator", async (t) => {
  const f = fixture(t);
  f.as(ADMIN);
  assert.equal((await f.json("/members", { email: "bad@example.net", mailbox_ids: [1, 999] })).status, 400);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM members WHERE email = 'bad@example.net'").get().n, 0);
  assert.equal((await f.json("/members", { email: "promoted@example.net", role: "admin", mailbox_ids: [] })).status, 400);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM members WHERE email = 'promoted@example.net'").get().n, 0);
  assert.equal((await f.json(`/members/${encodeURIComponent(MEMBER)}`, { enabled: true, mailbox_ids: [2, 999] }, "PUT")).status, 400);
  assert.deepEqual(f.db.prepare("SELECT mailbox_id FROM member_mailboxes WHERE member_email = ?").all(MEMBER).map((row) => row.mailbox_id), [1]);
  assert.ok([400, 403].includes((await f.json(`/members/${encodeURIComponent(ADMIN)}`, { enabled: false, mailbox_ids: [] }, "PUT")).status));
  assert.deepEqual({ ...f.db.prepare("SELECT role, enabled FROM members WHERE email = ?").get(ADMIN) }, { role: "admin", enabled: 1 });
});

test("same-origin defenses still apply to administrator permission changes", async (t) => {
  const f = fixture(t);
  f.as(ADMIN);
  const response = await f.request("/members", {
    method: "POST", headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
    body: JSON.stringify({ email: "csrf@example.net", mailbox_ids: [1] }),
  });
  assert.equal(response.status, 403);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM members WHERE email = 'csrf@example.net'").get().n, 0);
});

test("browser notification settings and subscription removal belong to the logged-in member only", async (t) => {
  const f = fixture(t);
  Object.assign(f.env, { VAPID_PUBLIC_KEY: "public", VAPID_PRIVATE_JWK: "private", VAPID_SUBJECT: "mailto:admin@example.com" });
  f.db.prepare("UPDATE global_settings SET browser_notifications_enabled = 1, ai_model = 'admin-only-model' WHERE id = 1").run();
  const subscription = (suffix) => ({ endpoint: `https://push.example/${suffix}`, expirationTime: null, keys: { p256dh: "p".repeat(50), auth: "a".repeat(16) } });
  f.as(ADMIN);
  assert.equal((await f.json("/settings/browser-notifications", subscription("admin"))).status, 200);
  f.as("other@example.net");
  assert.equal((await f.json("/settings/browser-notifications", subscription("other"))).status, 200);
  f.as(MEMBER);
  let settings = await (await f.request("/settings/general")).json();
  assert.equal(settings.push_subscription_count, 0);
  assert.equal(settings.browser_notifications_enabled, false);
  assert.equal(settings.ai_model, null);
  assert.equal((await f.json("/settings/browser-notifications", subscription("own"))).status, 200);
  settings = await (await f.request("/settings/general")).json();
  assert.equal(settings.push_subscription_count, 1);
  assert.equal(settings.browser_notifications_enabled, true);
  assert.equal((await f.request("/settings/browser-notifications", { method: "DELETE" })).status, 200);
  assert.deepEqual(f.db.prepare("SELECT member_email FROM push_subscriptions ORDER BY member_email").all().map((row) => row.member_email), ["other@example.net", ADMIN].sort());
  assert.equal(f.db.prepare("SELECT browser_notifications_enabled FROM global_settings WHERE id = 1").get().browser_notifications_enabled, 1);
});

test("members cannot overwrite another member's browser notification subscription", async (t) => {
  const f = fixture(t);
  Object.assign(f.env, { VAPID_PUBLIC_KEY: "public", VAPID_PRIVATE_JWK: "private", VAPID_SUBJECT: "mailto:admin@example.com" });
  const subscription = { endpoint: "https://push.example/owned", keys: { p256dh: "p".repeat(50), auth: "a".repeat(16) } };
  f.as("other@example.net");
  assert.equal((await f.json("/settings/browser-notifications", subscription)).status, 200);
  f.as(MEMBER);
  assert.equal((await f.json("/settings/browser-notifications", subscription)).status, 409);
  assert.equal(f.db.prepare("SELECT member_email FROM push_subscriptions WHERE endpoint = ?").get(subscription.endpoint).member_email, "other@example.net");
  f.as("disabled@example.net");
  denied(await f.json("/settings/browser-notifications", { ...subscription, endpoint: "https://push.example/disabled" }));
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get().n, 1);
});
