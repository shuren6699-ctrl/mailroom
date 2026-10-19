import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createMailroomServer } from "../src/mcp/server.ts";
import { getConversation, listInboxes, searchConversations } from "../src/worker/inbox/conversations.ts";

const member = { email: "member@example.com", role: "member", enabled: true, mailboxIds: [1] };

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  db.exec(`INSERT INTO domains (id, name, status) VALUES (1, 'example.com', 'active');
    INSERT INTO mailboxes (id, address, domain_id) VALUES (1, 'allowed@example.com', 1), (2, 'private@example.com', 1);
    INSERT INTO threads (id, mailbox_id, subject, snippet, last_message_at, message_count) VALUES
      (1, 1, 'Allowed oldest', 'Needle', '2026-10-01T00:00:00Z', 1),
      (2, 1, 'Allowed middle', 'Needle', '2026-10-02T00:00:00Z', 1),
      (3, 1, 'Allowed newest', 'Needle', '2026-10-03T00:00:00Z', 1),
      (4, 2, 'Private newest', 'Needle', '2026-10-04T00:00:00Z', 1),
      (5, 2, 'Private newer', 'Needle', '2026-10-05T00:00:00Z', 1),
      (6, 2, 'Private latest', 'Needle', '2026-10-06T00:00:00Z', 1);
    INSERT INTO messages (id, thread_id, message_id, direction, from_address, to_addresses, text_body)
      SELECT id, id, 'message-' || id || '@example.com', 'inbound', 'customer@example.net', '["allowed@example.com"]', 'Needle body'
      FROM threads;`);
  function statement(sql, args = []) {
    return {
      bind: (...values) => statement(sql, values),
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() {
        const result = db.prepare(sql).run(...args);
        return { meta: { changes: result.changes, last_row_id: result.lastInsertRowid } };
      },
    };
  }
  const sent = [];
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
    RAW: { async put() {} },
    EMAIL: { async send(message) { sent.push(message); return { messageId: `sent-${sent.length}@example.com` }; } },
  };
  return { db, env, sent };
}

test("MCP inbox lists expose only granted mailboxes", async (t) => {
  const { env } = fixture(t);
  assert.deepEqual((await listInboxes(env, member)).inboxes.map((inbox) => inbox.id), ["inbox_1"]);
  assert.deepEqual((await listInboxes(env, { ...member, enabled: false })).inboxes, []);
});

test("MCP search scopes rows before limits and cursor pagination", async (t) => {
  const { env } = fixture(t);
  const first = await searchConversations(env, { query: "needle", limit: 2 }, member);
  assert.deepEqual(first.conversations.map((item) => item.id), ["conversation_3", "conversation_2"]);
  assert.ok(first.next_cursor);
  const next = await searchConversations(env, { query: "needle", limit: 2, cursor: first.next_cursor }, member);
  assert.deepEqual(next.conversations.map((item) => item.id), ["conversation_1"]);
  assert.equal(next.next_cursor, null);
  assert.deepEqual((await searchConversations(env, { query: "needle", inboxId: 2, limit: 2 }, member)).conversations, []);
  assert.deepEqual((await searchConversations(env, { limit: 2 }, { ...member, mailboxIds: [] })).conversations, []);
  assert.deepEqual((await searchConversations(env, { limit: 2 }, { ...member, role: "admin", enabled: false })).conversations, []);
  assert.equal((await searchConversations(env, { limit: 10 }, { ...member, role: "admin", mailboxIds: [] })).conversations.length, 6);
});

test("MCP conversation details guard direct ids before returning message content", async (t) => {
  const { env } = fixture(t);
  assert.equal((await getConversation(env, 1, 30, member)).messages[0].text, "Needle body");
  await assert.rejects(getConversation(env, 4, 30, member), (error) => error.status === 403);
  await assert.rejects(getConversation(env, 1, 30, { ...member, enabled: false }), (error) => error.status === 403);
});

function mcpFixture(t, email = member.email) {
  const f = fixture(t);
  f.db.prepare("INSERT INTO members (email, role, enabled) VALUES (?, 'member', 1)").run(member.email);
  f.db.prepare("INSERT INTO member_mailboxes (member_email, mailbox_id) VALUES (?, 1)").run(member.email);
  const server = createMailroomServer(f.env, { email, sub: "verified-oauth-subject", clientId: "test-client", canSend: true });
  // Exercise the handlers registered at the MCP boundary without a network transport.
  const call = (name, input = {}) => server._registeredTools[name].handler(input, {});
  return { ...f, call };
}

function toolError(result) {
  assert.equal(result.isError, true);
  return JSON.parse(result.content[0].text).error;
}

test("every MCP tool call reloads grants for an existing OAuth identity", async (t) => {
  const f = mcpFixture(t);
  assert.deepEqual((await f.call("list_inboxes")).structuredContent.inboxes.map((item) => item.id), ["inbox_1"]);
  assert.equal((await f.call("get_conversation", { conversation_id: "conversation_1", message_limit: 30 })).structuredContent.messages.length, 1);
  assert.equal(toolError(await f.call("get_conversation", { conversation_id: "conversation_4", message_limit: 30 })).code, "forbidden");
  assert.equal(toolError(await f.call("search_conversations", { inbox_id: "inbox_2", limit: 2 })).code, "forbidden");
  assert.equal(toolError(await f.call("send_email", { inbox_id: "inbox_2", to: ["person@example.net"], subject: "Secret", text: "No", idempotency_key: "private-send-key" })).code, "forbidden");
  assert.equal(toolError(await f.call("reply_to_conversation", { conversation_id: "conversation_4", reply_to_message_id: "message_4", expected_recipients: ["customer@example.net"], text: "No", idempotency_key: "private-reply-key" })).code, "forbidden");
  assert.equal(f.sent.length, 0);

  f.db.prepare("DELETE FROM member_mailboxes WHERE member_email = ?").run(member.email);
  assert.deepEqual((await f.call("list_inboxes")).structuredContent.inboxes, []);
  assert.deepEqual((await f.call("search_conversations", { query: "needle", limit: 2 })).structuredContent.conversations, []);
  assert.equal(toolError(await f.call("get_conversation", { conversation_id: "conversation_1", message_limit: 30 })).code, "forbidden");
});

test("MCP checks revoked access before returning a completed send or reply replay", async (t) => {
  const f = mcpFixture(t);
  const compose = { inbox_id: "inbox_1", to: ["person@example.net"], subject: "New email", text: "Hello", idempotency_key: "completed-send-key" };
  const reply = { conversation_id: "conversation_1", reply_to_message_id: "message_1", expected_recipients: ["customer@example.net"], text: "Reply", idempotency_key: "completed-reply-key" };
  assert.equal((await f.call("send_email", compose)).structuredContent.status, "sent");
  assert.equal((await f.call("reply_to_conversation", reply)).structuredContent.status, "sent");
  assert.equal(f.sent.length, 2);
  f.db.prepare("DELETE FROM member_mailboxes WHERE member_email = ?").run(member.email);
  assert.equal(toolError(await f.call("send_email", compose)).code, "forbidden");
  assert.equal(toolError(await f.call("reply_to_conversation", reply)).code, "forbidden");
  assert.equal(f.sent.length, 2);
});

test("MCP identities without membership and disabled admins cannot read or send", async (t) => {
  const unknown = mcpFixture(t, "outsider@example.com");
  const unknownList = await unknown.call("list_inboxes");
  if (unknownList.isError) assert.equal(toolError(unknownList).code, "forbidden");
  else assert.deepEqual(unknownList.structuredContent.inboxes, []);
  assert.equal(toolError(await unknown.call("get_conversation", { conversation_id: "conversation_1", message_limit: 30 })).code, "forbidden");

  const disabled = mcpFixture(t);
  disabled.db.prepare("UPDATE members SET role = 'admin', enabled = 0 WHERE email = ?").run(member.email);
  const disabledList = await disabled.call("list_inboxes");
  if (disabledList.isError) assert.equal(toolError(disabledList).code, "forbidden");
  else assert.deepEqual(disabledList.structuredContent.inboxes, []);
  assert.equal(toolError(await disabled.call("send_email", { inbox_id: "inbox_1", to: ["person@example.net"], subject: "No", text: "No", idempotency_key: "disabled-send-key" })).code, "forbidden");
  assert.equal(disabled.sent.length, 0);
});
