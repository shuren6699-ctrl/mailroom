CREATE TABLE members (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO members (email, role) VALUES ('shuren6699@gmail.com', 'admin');

CREATE TABLE member_mailboxes (
  member_email TEXT NOT NULL REFERENCES members(email) ON DELETE CASCADE,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  PRIMARY KEY (member_email, mailbox_id)
);
CREATE INDEX idx_member_mailboxes_mailbox ON member_mailboxes(mailbox_id);

ALTER TABLE push_subscriptions ADD COLUMN member_email TEXT REFERENCES members(email) ON DELETE CASCADE;
CREATE INDEX idx_push_subscriptions_member ON push_subscriptions(member_email);
