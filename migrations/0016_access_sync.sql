CREATE TABLE access_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  synced_revision INTEGER NOT NULL DEFAULT 0 CHECK (synced_revision >= 0 AND synced_revision <= revision),
  lease_token TEXT,
  lease_until INTEGER,
  last_synced_at TEXT,
  last_error TEXT
);

INSERT INTO access_sync_state (id) VALUES (1);
