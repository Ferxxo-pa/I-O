CREATE TABLE IF NOT EXISTS boxes (
  id TEXT PRIMARY KEY,
  device_key TEXT NOT NULL,
  envelope TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS boxes_expires ON boxes (expires_at);
