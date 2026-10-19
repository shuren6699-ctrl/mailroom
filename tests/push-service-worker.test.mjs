import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const payload = {
  title: "新邮件", body: "打开收件箱查看新邮件。", tag: "conversation-10",
  data: { url: "/inbox/10", threadId: 10, recipientEmail: "owner@example.com" },
};
const me = { email: "owner@example.com", enabled: true, role: "member", mailbox_ids: [1] };

function fixture({ identity = me, authStatus = 200, threadStatus = 200, fail = false, redirected = false, contentType = "application/json", finalIdentity = identity } = {}) {
  const handlers = new Map();
  const displayed = [];
  const requests = [];
  const opened = [];
  let identityReads = 0;
  const self = {
    addEventListener(name, handler) { handlers.set(name, handler); },
    location: { origin: "https://mailroom.example" },
    registration: { async showNotification(title, options) { displayed.push({ title, ...options }); } },
    clients: { async matchAll() { return []; }, async openWindow(url) { opened.push(url); } },
  };
  vm.runInNewContext(readFileSync("public/sw.js", "utf8"), {
    self, URL,
    async fetch(url, options) {
      requests.push({ url: String(url), options });
      if (fail) throw new Error("Offline");
      const isMe = String(url).endsWith("/api/me");
      if (isMe) identityReads++;
      const value = isMe ? (identityReads > 1 ? finalIdentity : identity) : { thread: { id: 10, mailbox_id: 1, subject: "Private request", last_from: "Private Customer" }, messages: [], drafts: [], draft_run: null };
      const status = isMe ? authStatus : threadStatus;
      const response = Response.json(value, { status, headers: { "Content-Type": contentType } });
      Object.defineProperty(response, "redirected", { value: redirected });
      return response;
    },
  });
  async function push(value = payload) {
    let pending = Promise.resolve();
    handlers.get("push")({ data: { json() { if (value instanceof Error) throw value; return value; } }, waitUntil(value) { pending = value; } });
    await pending;
  }
  async function click(data = payload.data) {
    let pending = Promise.resolve();
    handlers.get("notificationclick")({ notification: { data, close() {} }, waitUntil(value) { pending = value; } });
    await pending;
  }
  return { push, click, displayed, requests, opened };
}

test("service worker verifies the current recipient and thread authorization before showing private content", async () => {
  const f = fixture();
  await f.push();
  assert.equal(f.displayed.length, 1);
  assert.equal(f.displayed[0].body, "Private request");
  assert.ok(f.requests.some((request) => request.url.endsWith("/api/threads/10")));
  assert.ok(f.requests.some((request) => request.url.endsWith("/api/me")));
  for (const request of f.requests) {
    assert.equal(new URL(request.url, "https://mailroom.example").origin, "https://mailroom.example");
    assert.equal(request.options.credentials, "same-origin");
    assert.equal(request.options.cache, "no-store");
    assert.equal(request.options.redirect, "error");
  }
});

test("service worker drops notifications for another signed-in account or a disabled recipient", async () => {
  for (const identity of [{ ...me, email: "other@example.com", role: "admin" }, { ...me, enabled: false }]) {
    const f = fixture({ identity });
    await f.push();
    assert.deepEqual(f.displayed, []);
  }
});

test("service worker drops queued notifications after thread access is revoked", async () => {
  for (const options of [{ threadStatus: 403 }, { threadStatus: 404 }, { identity: { ...me, mailbox_ids: [] } }]) {
    const f = fixture(options);
    await f.push();
    assert.deepEqual(f.displayed, []);
  }
});

test("service worker fails closed on offline authentication, redirects, malformed and legacy payloads", async () => {
  for (const options of [{ fail: true }, { authStatus: 401 }, { authStatus: 403 }, { redirected: true }, { contentType: "text/html" }]) {
    const f = fixture(options);
    await assert.doesNotReject(f.push());
    assert.deepEqual(f.displayed, []);
  }
  for (const value of [new Error("Bad JSON"), null, { title: "Legacy private content", body: "Secret", data: { url: "/inbox/10" } }, { ...payload, data: { ...payload.data, threadId: "10" } }]) {
    const f = fixture();
    await assert.doesNotReject(f.push(value));
    assert.deepEqual(f.displayed, []);
  }
});

test("service worker rechecks identity after thread lookup and protects notification clicks after account switches", async () => {
  const switched = fixture({ finalIdentity: { ...me, email: "other@example.com", role: "admin" } });
  await switched.push();
  assert.deepEqual(switched.displayed, []);
  const authorized = fixture();
  await authorized.click({ ...payload.data, url: "https://attacker.example/" });
  assert.deepEqual(authorized.opened, ["https://mailroom.example/inbox/10"]);
  const other = fixture({ identity: { ...me, email: "other@example.com" } });
  await other.click();
  assert.deepEqual(other.opened, []);
});

test("service worker permits enabled admins and drops grants revoked during authorization", async () => {
  const admin = fixture({ identity: { ...me, role: "admin", mailbox_ids: [] } });
  await admin.push();
  assert.equal(admin.displayed.length, 1);
  for (const finalIdentity of [{ ...me, mailbox_ids: [] }, { ...me, enabled: false }]) {
    const revoked = fixture({ finalIdentity });
    await revoked.push();
    assert.deepEqual(revoked.displayed, []);
  }
});
