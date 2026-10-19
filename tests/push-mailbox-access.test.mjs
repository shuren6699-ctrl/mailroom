import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { notifyNewEmail } from "../src/worker/notifications/push.ts";

const notification = { threadId: 10, senderName: "Customer", senderAddress: "customer@example.net", subject: "Private request" };

async function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  db.exec(`UPDATE global_settings SET browser_notifications_enabled = 1;
    INSERT INTO mailboxes (id, address) VALUES (1, 'allowed@example.com'), (2, 'private@example.com');
    INSERT INTO threads (id, mailbox_id, last_message_at) VALUES (10, 1, '2026-10-01'), (20, 2, '2026-10-02');
    INSERT INTO members (email, role, enabled) VALUES
      ('admin@example.com', 'admin', 1), ('allowed@example.com', 'member', 1),
      ('other@example.com', 'member', 1), ('disabled@example.com', 'admin', 0);
    INSERT INTO member_mailboxes (member_email, mailbox_id) VALUES ('allowed@example.com', 1), ('other@example.com', 2);`);
  const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const browser = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const browserKey = Buffer.from(await crypto.subtle.exportKey("raw", browser.publicKey)).toString("base64url");
  const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
  for (const [name, email] of [["admin", "admin@example.com"], ["allowed", "allowed@example.com"], ["allowed-second", "allowed@example.com"], ["other", "other@example.com"], ["disabled", "disabled@example.com"], ["legacy", null]]) {
    db.prepare("INSERT INTO push_subscriptions (endpoint, member_email, p256dh, auth) VALUES (?, ?, ?, ?)")
      .run(`https://push.example.net/${name}`, email, browserKey, auth);
  }
  function statement(sql, args = []) {
    return {
      bind: (...values) => statement(sql, values),
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { const result = db.prepare(sql).run(...args); return { meta: { changes: result.changes } }; },
    };
  }
  const delivered = [];
  t.mock.method(globalThis, "fetch", async (endpoint, options) => {
    delivered.push({ endpoint, options });
    return new Response(null, { status: 201 });
  });
  return {
    db,
    delivered,
    async decrypt(delivery) {
      const headers = new Headers(delivery.options.headers);
      const salt = Buffer.from(headers.get("encryption").slice("salt=".length), "base64url");
      const senderBytes = Buffer.from(headers.get("crypto-key").slice("dh=".length), "base64url");
      const sender = await crypto.subtle.importKey("raw", senderBytes, { name: "ECDH", namedCurve: "P-256" }, false, []);
      const secret = await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, browser.privateKey, 256);
      const secretKey = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
      const hkdf = (key, salt, info, length) => crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length);
      const pseudo = await hkdf(secretKey, Buffer.from(auth, "base64url"), Buffer.from("Content-Encoding: auth\0"), 256);
      const pseudoKey = await crypto.subtle.importKey("raw", pseudo, "HKDF", false, ["deriveBits"]);
      const receiverBytes = Buffer.from(browserKey, "base64url");
      const context = Buffer.concat([Buffer.from("P-256\0"), Buffer.from([0, 65]), receiverBytes, Buffer.from([0, 65]), senderBytes]);
      const keyBytes = await hkdf(pseudoKey, salt, Buffer.concat([Buffer.from("Content-Encoding: aesgcm\0"), context]), 128);
      const nonce = await hkdf(pseudoKey, salt, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), context]), 96);
      const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, delivery.options.body);
      return JSON.parse(Buffer.from(plain).subarray(2 + new DataView(plain).getUint16(0)).toString("utf8"));
    },
    env: {
      DB: { prepare: statement },
      VAPID_PUBLIC_KEY: "configured-public-key",
      VAPID_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey("jwk", signing.privateKey)),
      VAPID_SUBJECT: "mailto:admin@example.com",
    },
  };
}

test("push delivers encrypted notifications only to enabled admins and members granted the thread mailbox", async (t) => {
  const f = await fixture(t);
  await notifyNewEmail(f.env, notification);
  assert.deepEqual(f.delivered.map((item) => item.endpoint).sort(), [
    "https://push.example.net/admin", "https://push.example.net/allowed", "https://push.example.net/allowed-second",
  ]);
  for (const delivery of f.delivered) {
    assert.equal(delivery.options.method, "POST");
    assert.ok(delivery.options.body.byteLength > 0);
    assert.equal(new Headers(delivery.options.headers).get("content-encoding"), "aesgcm");
    const payload = await f.decrypt(delivery);
    assert.deepEqual(payload.data, {
      url: "/inbox/10", threadId: 10,
      recipientEmail: delivery.endpoint.endsWith("/admin") ? "admin@example.com" : "allowed@example.com",
    });
    assert.equal(payload.title, "新邮件");
    assert.equal(payload.body, "打开收件箱查看新邮件。");
    assert.equal(JSON.stringify(payload).includes("Private request"), false);
  }

  f.delivered.length = 0;
  await notifyNewEmail(f.env, { ...notification, threadId: 20 });
  assert.deepEqual(f.delivered.map((item) => item.endpoint).sort(), ["https://push.example.net/admin", "https://push.example.net/other"]);
});

test("push rechecks revoked grants and disabled memberships on every delivery", async (t) => {
  const f = await fixture(t);
  f.db.exec("DELETE FROM member_mailboxes WHERE member_email = 'allowed@example.com'");
  await notifyNewEmail(f.env, notification);
  assert.deepEqual(f.delivered.map((item) => item.endpoint), ["https://push.example.net/admin"]);
  f.delivered.length = 0;
  f.db.exec("UPDATE members SET enabled = 0 WHERE email = 'admin@example.com'");
  await notifyNewEmail(f.env, notification);
  assert.deepEqual(f.delivered, []);
});

test("push sends nothing for unknown conversations or globally disabled notifications", async (t) => {
  const f = await fixture(t);
  await notifyNewEmail(f.env, { ...notification, threadId: 999 });
  assert.deepEqual(f.delivered, []);
  f.db.exec("UPDATE global_settings SET browser_notifications_enabled = 0");
  await notifyNewEmail(f.env, notification);
  assert.deepEqual(f.delivered, []);
});

test("expired eligible push endpoints are removed without touching legacy or unauthorized subscriptions", async (t) => {
  const f = await fixture(t);
  t.mock.method(globalThis, "fetch", async (endpoint) => new Response(null, { status: endpoint.endsWith("/admin") ? 410 : 201 }));
  await notifyNewEmail(f.env, notification);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = 'https://push.example.net/admin'").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint IN ('https://push.example.net/legacy', 'https://push.example.net/other', 'https://push.example.net/disabled')").get().n, 3);
});
