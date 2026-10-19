CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  name TEXT,
  code TEXT UNIQUE,
  location_id TEXT NOT NULL,
  owner_key_hash TEXT,
  pin_hash TEXT,
  shop_json TEXT NOT NULL DEFAULT '{}',
  fight_json TEXT,
  square_token_enc TEXT,
  square_webhook_enc TEXT,
  webhook_url TEXT,
  webhook_seen_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE people (
  company_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  made_cents INTEGER NOT NULL DEFAULT 0,
  hourly_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  consented_at INTEGER,
  consent_revoked_at INTEGER,
  consent_note TEXT,
  square_team_member_id TEXT,
  square_location_id TEXT,
  PRIMARY KEY (company_id, id)
);

CREATE TABLE devices (
  company_id TEXT NOT NULL,
  id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  square_team_member_id TEXT NOT NULL DEFAULT '',
  session_start INTEGER,
  last_seen_at INTEGER,
  stationary_at INTEGER,
  square_flag TEXT,
  revoked_at INTEGER,
  PRIMARY KEY (company_id, id)
);

CREATE TABLE punches (
  company_id TEXT NOT NULL,
  id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  person_name TEXT NOT NULL,
  type TEXT NOT NULL,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  accepted INTEGER NOT NULL,
  reason TEXT,
  received_at INTEGER NOT NULL,
  closes_day INTEGER NOT NULL DEFAULT 0,
  flag TEXT,
  PRIMARY KEY (company_id, id)
);

CREATE TABLE sessions (
  company_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  name TEXT NOT NULL,
  hourly_cents INTEGER NOT NULL,
  clocked_in INTEGER NOT NULL,
  clocked_in_at INTEGER,
  hour_started_at INTEGER,
  output_cents INTEGER NOT NULL DEFAULT 0,
  timecard_id TEXT,
  hold_at INTEGER,
  source TEXT,
  review TEXT,
  managed_by TEXT,
  PRIMARY KEY (company_id, person_id)
);

CREATE TABLE ledger (
  company_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  cents INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (company_id, id)
);

CREATE TABLE seen (
  company_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  status INTEGER NOT NULL,
  body TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (company_id, event_key)
);

CREATE TABLE watches (
  company_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  watch_json TEXT NOT NULL,
  PRIMARY KEY (company_id, person_id)
);

CREATE TABLE invites (
  code TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  name TEXT NOT NULL,
  device_id TEXT NOT NULL,
  token_enc TEXT NOT NULL,
  phone_url TEXT NOT NULL,
  opened_at INTEGER
);

CREATE TABLE audit (
  id TEXT PRIMARY KEY,
  company_id TEXT,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  ok INTEGER NOT NULL
);

CREATE TABLE rate_hits (
  key TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE INDEX idx_rate_hits ON rate_hits (key, ts);

CREATE TABLE square_cards (
  company_id TEXT NOT NULL,
  timecard_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  open INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  PRIMARY KEY (company_id, timecard_id)
);

CREATE TABLE square_log (
  company_id TEXT NOT NULL,
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  r2_key TEXT NOT NULL
);
