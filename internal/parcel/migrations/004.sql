-- -1 means unlimited downloads. Copy the complete foreign-key graph before
-- dropping old tables so ON DELETE CASCADE cannot remove grants or sessions.
CREATE TABLE shares_next(id TEXT PRIMARY KEY, upload_id TEXT NOT NULL UNIQUE REFERENCES uploads(id), storage_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, password_hash TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, expires INTEGER NOT NULL, max_downloads INTEGER NOT NULL CHECK(max_downloads=-1 OR max_downloads BETWEEN 1 AND 100), download_count INTEGER NOT NULL DEFAULT 0 CHECK(download_count>=0 AND (max_downloads=-1 OR download_count<=max_downloads)), version INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'active', error TEXT NOT NULL DEFAULT '', delete_attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER NOT NULL DEFAULT 0, backend TEXT NOT NULL DEFAULT 'local', etag TEXT NOT NULL DEFAULT '', signed_until INTEGER NOT NULL DEFAULT 0);
INSERT INTO shares_next SELECT * FROM shares;
CREATE TABLE share_grants_next(token_hash TEXT PRIMARY KEY, share_id TEXT NOT NULL REFERENCES shares_next(id) ON DELETE CASCADE, version INTEGER NOT NULL, expires INTEGER NOT NULL);
INSERT INTO share_grants_next SELECT * FROM share_grants;
CREATE TABLE download_sessions_next(token_hash TEXT PRIMARY KEY, share_id TEXT NOT NULL REFERENCES shares_next(id) ON DELETE CASCADE, version INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'issued', created INTEGER NOT NULL, activated INTEGER NOT NULL DEFAULT 0, last_activity INTEGER NOT NULL, expires INTEGER NOT NULL);
INSERT INTO download_sessions_next SELECT * FROM download_sessions;
DROP TABLE download_sessions;
DROP TABLE share_grants;
DROP TABLE shares;
ALTER TABLE shares_next RENAME TO shares;
ALTER TABLE share_grants_next RENAME TO share_grants;
ALTER TABLE download_sessions_next RENAME TO download_sessions;
CREATE INDEX download_share ON download_sessions(share_id,state,expires);
CREATE INDEX grant_share ON share_grants(share_id);
CREATE INDEX share_expiry ON shares(state,expires);
INSERT INTO schema_migrations VALUES(4);
