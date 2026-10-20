import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { unstable_splitSqlQuery } from "wrangler";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OWNER = "shuren6699@gmail.com";
const ACCOUNT = "a".repeat(32);
const POLICY_ID = "5c559533-faa7-469f-9ad3-eb040cdfc137";
const TOKEN = "fake-runtime-test-token";
const ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/access/policies/${POLICY_ID}`;
const bundled = await build({
  stdin: {
    contents: `import { synchronizeAccessPolicy } from "./src/worker/access-sync.ts";
      export default { async fetch(request, env) {
        return Response.json(await synchronizeAccessPolicy(env));
      } };`,
    resolveDir: ROOT,
    sourcefile: "access-sync-runtime-entry.ts",
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
});

async function runtime(t, outboundService) {
  // Every outbound request is intercepted. No real credentials or external network are used.
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    compatibilityDate: "2026-08-01",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    script: bundled.outputFiles[0].text,
    bindings: {
      CF_ACCESS_API_TOKEN: TOKEN,
      ACCESS_SYNC_ACCOUNT_ID: ACCOUNT,
      ACCESS_SYNC_POLICY_ID: POLICY_ID,
    },
    d1Databases: { DB: "access-sync-runtime-test" },
    outboundService,
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  for (const file of readdirSync(new URL("../migrations/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
    await db.batch(unstable_splitSqlQuery(sql).map((statement) => db.prepare(statement)));
  }
  return { mf, db };
}

function currentPolicy() {
  return {
    id: POLICY_ID,
    account_id: ACCOUNT,
    name: "mailroom-team",
    decision: "allow",
    app_count: 1,
    include: [{ email: { email: OWNER } }, { email: { email: "legacy@example.net" } }],
    require: [],
    exclude: [],
    session_duration: "8h",
  };
}

test("Access sync executes GET and PUT in actual workerd with its deployed compatibility date", async (t) => {
  const calls = [];
  let policy = currentPolicy();
  const { mf, db } = await runtime(t, async (request) => {
    calls.push({ url: request.url, method: request.method });
    assert.equal(request.url, ENDPOINT);
    assert.equal(request.headers.get("Authorization"), `Bearer ${TOKEN}`);
    if (request.method === "PUT") policy = { ...policy, ...await request.json() };
    return Response.json({ success: true, result: policy });
  });
  const response = await mf.dispatchFetch("https://runtime-test.invalid/sync");
  const status = await response.json();
  assert.equal(status.state, "synced", status.message);
  assert.ok(status.last_synced_at);
  assert.deepEqual(calls.map((call) => call.method), ["GET", "PUT"]);
  assert.deepEqual(policy.include, [{ email: { email: OWNER } }]);
  assert.equal(policy.session_duration, "8h");
  const state = await db.prepare("SELECT revision, synced_revision, lease_token FROM access_sync_state WHERE id = 1").first();
  assert.equal(state.synced_revision, state.revision);
  assert.equal(state.lease_token, null);
});

test("Access sync in actual workerd rejects redirects without forwarding its token to another host", async (t) => {
  const urls = [];
  const { mf, db } = await runtime(t, async (request) => {
    urls.push(request.url);
    if (request.url !== ENDPOINT) return Response.json({ unexpected_follow: true });
    return new Response(null, { status: 302, headers: { Location: "https://untrusted.invalid/collect" } });
  });
  const status = await (await mf.dispatchFetch("https://runtime-test.invalid/sync")).json();
  assert.equal(status.state, "error");
  assert.equal(status.message, "Cloudflare 白名单同步失败，请检查 API Token 权限和目标策略后重试。");
  assert.deepEqual(urls, [ENDPOINT]);
  assert.ok(!JSON.stringify(status).includes(TOKEN));
  const state = await db.prepare("SELECT synced_revision, lease_token FROM access_sync_state WHERE id = 1").first();
  assert.equal(state.synced_revision, 0);
  assert.equal(state.lease_token, null);
});
