CREATE TABLE IF NOT EXISTS boxes (
  id TEXT PRIMARY KEY,
  device_key TEXT NOT NULL,
  event TEXT NOT NULL,
  trigger TEXT NOT NULL,
  ts INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS boxes_expires ON boxes (expires_at);

CREATE TABLE IF NOT EXISTS hooks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  team_member_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS hooks_expires ON hooks (expires_at);
