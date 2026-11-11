import test from "node:test";
import assert from "node:assert/strict";
import { ensureEmailRoutingRule } from "../src/worker/email-routing-sync.ts";

const TOKEN = "routing-token";
const ZONE = "b".repeat(32);
const url = `https://api.cloudflare.com/client/v4/zones/${ZONE}/email/routing/rules`;

function env(overrides = {}) {
  return { CF_EMAIL_ROUTING_API_TOKEN: TOKEN, EMAIL_ROUTING_ZONE_ID: ZONE, ...overrides };
}

test("reports not configured without the routing token", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (...args) => { calls.push(args); return Response.json({}); });
  const result = await ensureEmailRoutingRule(env({ CF_EMAIL_ROUTING_API_TOKEN: "" }), "004@example.com");
  assert.deepEqual(result, { configured: false, state: "not_configured", message: "尚未配置 Cloudflare Email Routing API Token，邮箱已保存但路由尚未同步。" });
  assert.equal(calls.length, 0);
});

test("does not create a duplicate when the mailbox already routes to this Worker", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (...args) => {
    calls.push(args);
    return Response.json({ success: true, result: [{ id: "rule-1", enabled: true, matchers: [{ type: "literal", field: "to", value: "004@example.com" }], actions: [{ type: "worker", value: ["mailroom"] }] }] });
  });
  const result = await ensureEmailRoutingRule(env(), "004@example.com");
  assert.equal(result.state, "synced");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], url);
  assert.equal(calls[0][1].method, "GET");
  assert.equal(calls[0][1].headers.Authorization, `Bearer ${TOKEN}`);
});

test("creates a literal Worker route when no matching rule exists", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (...args) => {
    calls.push(args);
    if (calls.length === 1) return Response.json({ success: true, result: [] });
    return Response.json({ success: true, result: { id: "rule-2" } }, { status: 200 });
  });
  const result = await ensureEmailRoutingRule(env(), "005@example.com");
  assert.equal(result.state, "synced");
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1].method, "POST");
  assert.deepEqual(JSON.parse(calls[1][1].body), {
    name: "005@example.com",
    enabled: true,
    source: "api",
    matchers: [{ type: "literal", field: "to", value: "005@example.com" }],
    actions: [{ type: "worker", value: ["mailroom"] }],
  });
});

test("refuses a conflicting rule and does not leak the token", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ success: true, result: [{ id: "rule-3", matchers: [{ type: "literal", field: "to", value: "006@example.com" }], actions: [{ type: "forward", value: ["owner@example.net"] }] }] }));
  const result = await ensureEmailRoutingRule(env(), "006@example.com");
  assert.equal(result.configured, true);
  assert.equal(result.state, "error");
  assert.match(result.message, /已存在/);
  assert.ok(!result.message.includes(TOKEN));
});

test("treats an invalid configured zone as a blocking sync error", async () => {
  const result = await ensureEmailRoutingRule(env({ EMAIL_ROUTING_ZONE_ID: "not-a-zone" }), "007@example.com");
  assert.deepEqual(result, { configured: true, state: "error", message: "Cloudflare 邮件路由同步配置无效，请检查 API Token 和 Zone ID。" });
});
