-- Additive migration: existing Access deployments and share data stay valid.
CREATE TABLE admin_credentials (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  totp_secret TEXT NOT NULL,
  last_step INTEGER NOT NULL,
  version TEXT NOT NULL UNIQUE
);
CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  version TEXT NOT NULL REFERENCES admin_credentials(version) ON DELETE CASCADE ON UPDATE CASCADE,
  csrf TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires);
CREATE TABLE admin_recovery_codes (
  code_hash TEXT PRIMARY KEY,
  version TEXT NOT NULL REFERENCES admin_credentials(version) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE admin_enrollments (
  token_hash TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  totp_secret TEXT NOT NULL,
  previous_version TEXT NOT NULL,
  recovery_hash TEXT NOT NULL,
  setup_key_hash TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX admin_enrollments_expiry ON admin_enrollments(expires);
