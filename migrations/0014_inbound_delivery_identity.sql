-- Keep existing row IDs, foreign keys and outbound storage keys intact.
-- New inbound rows use message_id as a mailbox-scoped delivery key and keep
-- the wire Message-ID here. NULL means a legacy row or an outbound message.
ALTER TABLE messages ADD COLUMN rfc_message_id TEXT;

CREATE INDEX idx_messages_rfc_identity
  ON messages(COALESCE(rfc_message_id, message_id), direction, thread_id);
