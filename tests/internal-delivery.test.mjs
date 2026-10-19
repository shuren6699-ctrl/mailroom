import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { receiveEmail } from "../src/worker/email/receive.ts";
import { sendNewEmailAttempt } from "../src/worker/email/compose.ts";
import { sendReplyAttempt } from "../src/worker/email/reply.ts";

const ADDRESSES = { 2: "002@example.com", 3: "003@example.com" };
const migrations = readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort();

function fixture(t, { beforeMigration = false, receiveBeforeSendReturns = false, concurrentRawWrites = false } = {}) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of migrations) {
    if (!beforeMigration || Number(file.slice(0, 4)) <= 13) db.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  db.exec(`INSERT INTO domains (id, name, status) VALUES (1, 'example.com', 'active');
    INSERT INTO mailboxes (id, address, domain_id) VALUES (2, '002@example.com', 1), (3, '003@example.com', 1);`);
  const sent = [];
  const objects = new Map();
  let backgroundCalls = 0;
  let rawWrites = 0;
  let releaseRawWrites;
  const rawWriteBarrier = new Promise((resolve) => { releaseRawWrites = resolve; });
  function statement(sql, args = []) {
    return {
      bind: (...values) => statement(sql, values),
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
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
    RAW: {
      async put(key, value) {
        // Hold the first MIME write until both deliveries have reached storage.
        // This exercises the real insert race after both initial dedup reads.
        if (concurrentRawWrites && key.startsWith("raw/") && ++rawWrites <= 2) {
          if (rawWrites === 2) releaseRawWrites();
          await rawWriteBarrier;
        }
        objects.set(key, new Uint8Array(value));
      },
    },
    EMAIL: {
      async send(message) {
        const delivery = { ...message, messageId: `<sent-${sent.length + 1}@example.com>` };
        sent.push(delivery);
        if (receiveBeforeSendReturns) await deliverSent(sent.length - 1);
        return { messageId: delivery.messageId };
      },
    },
  };
  async function deliverRaw(raw, recipient) {
    const tasks = [];
    let rejection;
    await receiveEmail({
      to: recipient,
      raw: new Response(raw).body,
      setReject(reason) { rejection = reason; },
    }, env, { waitUntil(promise) { backgroundCalls += 1; tasks.push(promise); } });
    await Promise.all(tasks);
    assert.equal(rejection, undefined, "a configured inbox must accept the delivery");
  }
  async function deliverSent(index, recipient) {
    const message = sent[index];
    await deliverRaw(mime(message), recipient ?? address(message.to[0]));
  }
  const send = (mailboxId, to, extra = {}) => sendNewEmailAttempt(env, {
    attemptId: crypto.randomUUID(), mailboxId, to: [to], subject: "Internal delivery", text: "Internal body", sentBy: "human", ...extra,
  });
  return { db, env, sent, objects, send, deliverRaw, deliverSent, get backgroundCalls() { return backgroundCalls; } };
}

function address(value) { return typeof value === "string" ? value : value.email; }

function mime({ messageId, from, to, subject = "Internal delivery", text = "Internal body", headers = {}, attachments = [] }) {
  const head = [
    `Message-ID: ${messageId}`, `From: ${address(from)}`, `To: ${to.map(address).join(", ")}`,
    `Subject: ${subject}`, "MIME-Version: 1.0",
    ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
  ];
  if (!attachments.length) return [...head, "Content-Type: text/plain; charset=utf-8", "", text].join("\r\n");
  const boundary = "mailroom-internal-test-boundary";
  return [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "", text,
    ...attachments.flatMap((attachment) => [
      `--${boundary}`, `Content-Type: ${attachment.type}; name="${attachment.filename}"`,
      `Content-Disposition: attachment; filename="${attachment.filename}"`, "Content-Transfer-Encoding: base64", "",
      Buffer.from(attachment.content).toString("base64"),
    ]), `--${boundary}--`, ""].join("\r\n");
}

function incoming(f, mailboxId) {
  return f.db.prepare(`SELECT msg.* FROM messages msg JOIN threads t ON t.id = msg.thread_id
    WHERE t.mailbox_id = ? AND msg.direction = 'inbound' ORDER BY msg.id`).all(mailboxId);
}

test("internal delivery stores the recipient's inbound copy when the outbound copy already exists", async (t) => {
  const f = fixture(t);
  const result = await f.send(2, ADDRESSES[3]);
  await f.deliverSent(0);
  assert.equal(result.status, "sent");
  assert.equal(incoming(f, 3).length, 1);
  assert.equal(incoming(f, 3)[0].from_address, ADDRESSES[2]);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'outbound'").get().n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 2);
});

test("a recipient delivery arriving before provider send returns does not break outbound persistence", async (t) => {
  const f = fixture(t, { receiveBeforeSendReturns: true });
  const result = await f.send(2, ADDRESSES[3]);
  assert.equal(result.status, "sent");
  assert.equal(incoming(f, 3).length, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 2);
  assert.equal(f.db.prepare("SELECT status FROM outbound_attempts").get().status, "sent");
});

test("the same external RFC Message-ID is delivered independently to two inboxes", async (t) => {
  const f = fixture(t);
  const raw = mime({ messageId: "<shared@example.net>", from: "customer@example.net", to: Object.values(ADDRESSES) });
  await f.deliverRaw(raw, ADDRESSES[2]);
  await f.deliverRaw(raw, ADDRESSES[3]);
  assert.equal(incoming(f, 2).length, 1);
  assert.equal(incoming(f, 3).length, 1);
  assert.notEqual(incoming(f, 2)[0].thread_id, incoming(f, 3)[0].thread_id);
  const rawKeys = [...f.objects.keys()].filter((key) => key.startsWith("raw/"));
  assert.equal(rawKeys.length, 2);
  assert.ok(rawKeys.some((key) => key.startsWith("raw/2/")));
  assert.ok(rawKeys.some((key) => key.startsWith("raw/3/")));
});

test("a repeated inbound delivery leaves one conversation, message and attachment", async (t) => {
  const f = fixture(t);
  const raw = mime({ messageId: "<retry@example.net>", from: "customer@example.net", to: [ADDRESSES[2]],
    attachments: [{ filename: "receipt.txt", type: "text/plain", content: Buffer.from("one receipt") }] });
  await f.deliverRaw(raw, ADDRESSES[2]);
  const firstRow = incoming(f, 2)[0];
  const firstObjects = [...f.objects.keys()];
  const firstBackgroundCalls = f.backgroundCalls;
  await f.deliverRaw(raw, ADDRESSES[2]);
  assert.equal(incoming(f, 2).length, 1);
  assert.equal(incoming(f, 2)[0].id, firstRow.id);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM threads").get().n, 1);
  assert.equal(f.db.prepare("SELECT message_count FROM threads").get().message_count, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM attachments").get().n, 1);
  assert.deepEqual([...f.objects.keys()], firstObjects);
  assert.equal(f.backgroundCalls, firstBackgroundCalls);
});

test("an inbox can receive its own outbound message without suppressing either direction", async (t) => {
  const f = fixture(t);
  await f.send(2, ADDRESSES[2]);
  await f.deliverSent(0);
  assert.equal(incoming(f, 2).length, 1);
  assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM messages msg JOIN threads t ON t.id = msg.thread_id
    WHERE t.mailbox_id = 2 AND msg.direction = 'outbound'`).get().n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 2);
});

test("concurrent retries of the same inbound message complete once without orphan conversations or attachments", async (t) => {
  const f = fixture(t, { concurrentRawWrites: true });
  const raw = mime({ messageId: "<concurrent@example.net>", from: "customer@example.net", to: [ADDRESSES[2]],
    attachments: [{ filename: "concurrent.txt", type: "text/plain", content: Buffer.from("one concurrent receipt") }] });
  const results = await Promise.allSettled([
    f.deliverRaw(raw, ADDRESSES[2]),
    f.deliverRaw(raw, ADDRESSES[2]),
  ]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled"], "duplicate delivery races must both finish normally");
  assert.equal(incoming(f, 2).length, 1);
  const threads = f.db.prepare("SELECT id, message_count FROM threads").all();
  assert.equal(threads.length, 1, "the losing delivery must not leave an empty conversation");
  assert.equal(threads[0].message_count, 1);
  assert.equal(incoming(f, 2)[0].thread_id, threads[0].id);
  const attachments = f.db.prepare("SELECT message_id, r2_key FROM attachments").all();
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].message_id, incoming(f, 2)[0].id);
  assert.equal([...f.objects.keys()].filter((key) => key.startsWith("raw/")).length, 1);
  assert.equal([...f.objects.keys()].filter((key) => key.startsWith("attachments/")).length, 1);
  assert.equal(f.backgroundCalls, 2, "only the winning delivery should schedule labeling and notifications");
});

test("internal outbound and inbound attachments stay linked to the correct inbox and message", async (t) => {
  const f = fixture(t, { receiveBeforeSendReturns: true });
  const content = new TextEncoder().encode("a private internal attachment");
  await f.send(2, ADDRESSES[3], { attachments: [{ filename: "internal.txt", contentType: "text/plain", content }] });
  const attachments = f.db.prepare(`SELECT a.*, msg.direction, t.mailbox_id FROM attachments a
    JOIN messages msg ON msg.id = a.message_id JOIN threads t ON t.id = msg.thread_id ORDER BY a.id`).all();
  assert.equal(attachments.length, 2);
  for (const [mailboxId, direction] of [[2, "outbound"], [3, "inbound"]]) {
    const rows = attachments.filter((attachment) => attachment.mailbox_id === mailboxId && attachment.direction === direction);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].filename, "internal.txt");
    assert.ok(rows[0].r2_key.startsWith(`attachments/${mailboxId}/`));
    assert.deepEqual(f.objects.get(rows[0].r2_key), content);
  }
  assert.notEqual(attachments[0].message_id, attachments[1].message_id);
  assert.notEqual(attachments[0].r2_key, attachments[1].r2_key);
});

test("internal replies use canonical RFC headers and return to each inbox's original conversation", async (t) => {
  const f = fixture(t);
  const first = await f.send(2, ADDRESSES[3]);
  await f.deliverSent(0);
  const receivedBy3 = incoming(f, 3)[0];
  assert.ok(receivedBy3, "003 must have an inbound message to reply to");
  await sendReplyAttempt(f.env, {
    attemptId: "reply-003", threadId: receivedBy3.thread_id, inboundMessageId: receivedBy3.id,
    expectedRecipients: [ADDRESSES[2]], text: "Reply from 003", sentBy: "human",
  });
  assert.equal(f.sent[1].headers["In-Reply-To"], f.sent[0].messageId);
  assert.equal(f.sent[1].headers.References, f.sent[0].messageId);
  await f.deliverSent(1);
  const receivedBy2 = incoming(f, 2)[0];
  assert.ok(receivedBy2);
  assert.equal(receivedBy2.thread_id, first.conversation_id);
  await sendReplyAttempt(f.env, {
    attemptId: "reply-002", threadId: receivedBy2.thread_id, inboundMessageId: receivedBy2.id,
    expectedRecipients: [ADDRESSES[3]], text: "Reply from 002", sentBy: "human",
  });
  assert.equal(f.sent[2].headers["In-Reply-To"], f.sent[1].messageId);
  assert.equal(f.sent[2].headers.References, `${f.sent[0].messageId} ${f.sent[1].messageId}`);
  await f.deliverSent(2);
  const inbox3 = incoming(f, 3);
  assert.equal(inbox3.length, 2);
  assert.equal(inbox3[1].thread_id, receivedBy3.thread_id);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM threads").get().n, 2);
  assert.equal(f.db.prepare("SELECT message_count FROM threads WHERE id = ?").get(first.conversation_id).message_count, 3);
  assert.equal(f.db.prepare("SELECT message_count FROM threads WHERE id = ?").get(receivedBy3.thread_id).message_count, 3);
});

test("the incremental migration preserves legacy rows, attachments, foreign keys and search", async (t) => {
  const f = fixture(t, { beforeMigration: true });
  f.db.exec(`INSERT INTO threads (id, mailbox_id, subject, normalized_subject, message_count, last_message_at)
    VALUES (10, 2, 'Legacy receipt', 'legacy receipt', 1, '2026-10-01T00:00:00.000Z');
    INSERT INTO messages (id, thread_id, message_id, direction, from_address, subject, text_body, raw_key)
    VALUES (100, 10, '<legacy@example.net>', 'inbound', 'customer@example.net', 'Legacy receipt', 'Preserved original body', 'raw/2/legacy.eml');
    INSERT INTO attachments (id, message_id, filename, content_type, size, r2_key)
    VALUES (50, 100, 'legacy.txt', 'text/plain', 6, 'attachments/2/100/legacy.txt');
    INSERT INTO drafts (id, thread_id, text_body, source_inbound_message_id)
    VALUES (20, 10, 'Preserved draft', 100);`);
  const upgrades = migrations.filter((file) => Number(file.slice(0, 4)) > 13);
  assert.ok(upgrades.length > 0, "the delivery fix needs an incremental migration for existing databases");
  for (const file of upgrades) f.db.exec(readFileSync(`migrations/${file}`, "utf8"));
  assert.equal(f.db.prepare("SELECT text_body FROM messages WHERE id = 100").get().text_body, "Preserved original body");
  assert.equal(f.db.prepare("SELECT message_id FROM attachments WHERE id = 50").get().message_id, 100);
  assert.equal(f.db.prepare("SELECT source_inbound_message_id FROM drafts WHERE id = 20").get().source_inbound_message_id, 100);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'Preserved'").get().n, 1);
  assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  await f.deliverRaw(mime({ messageId: "<legacy@example.net>", from: "customer@example.net", to: [ADDRESSES[2]], subject: "Legacy receipt" }), ADDRESSES[2]);
  assert.equal(incoming(f, 2).length, 1, "a legacy inbound row still deduplicates retries");
  await sendReplyAttempt(f.env, { attemptId: "reply-legacy", threadId: 10, inboundMessageId: 100,
    expectedRecipients: ["customer@example.net"], text: "Reply to preserved message", sentBy: "human" });
  assert.equal(f.sent[0].headers["In-Reply-To"], "<legacy@example.net>");
  assert.equal(f.sent[0].headers.References, "<legacy@example.net>");
});
