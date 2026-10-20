-- Keep idempotent admissions after an expired download session is reaped, so a
-- lost response cannot consume a second qualification when retried. Records
-- contain only hashes, never client request tokens or file decryption keys.
CREATE TABLE download_admissions (
  request_hash TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE
);
CREATE INDEX download_admission_share ON download_admissions(share_id);
