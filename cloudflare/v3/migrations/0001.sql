-- D1 is the authority for the V3 deployment. Do not point Go at this database.
CREATE TABLE uploads (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>=0),
  offset INTEGER NOT NULL DEFAULT 0 CHECK(offset>=0 AND offset<=size),
  ttl INTEGER NOT NULL CHECK(ttl>0), max_downloads INTEGER NOT NULL CHECK(max_downloads BETWEEN 1 AND 100),
  password_hash TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK(state IN ('created','uploading','finalizing','completed','failed','canceled','cleaned')),
  storage_key TEXT NOT NULL UNIQUE, share_id TEXT NOT NULL UNIQUE,
  created INTEGER NOT NULL, updated INTEGER NOT NULL, idem TEXT UNIQUE, request_hash TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
  multipart_id TEXT NOT NULL DEFAULT '', part_bytes INTEGER NOT NULL DEFAULT 16777216 CHECK(part_bytes>0),
  lease_token TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE shares (
  id TEXT PRIMARY KEY, upload_id TEXT NOT NULL UNIQUE REFERENCES uploads(id), storage_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>=0), sha256 TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, expires INTEGER NOT NULL,
  max_downloads INTEGER NOT NULL CHECK(max_downloads BETWEEN 1 AND 100),
  download_count INTEGER NOT NULL DEFAULT 0 CHECK(download_count BETWEEN 0 AND max_downloads),
  version INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'active'
    CHECK(state IN ('active','expired','exhausted','revoked','deleting','deleted','missing')),
  error TEXT NOT NULL DEFAULT '', etag TEXT NOT NULL,
  signed_until INTEGER NOT NULL DEFAULT 0, delete_attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE share_grants (
  token_hash TEXT PRIMARY KEY, share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, expires INTEGER NOT NULL
);
CREATE TABLE download_sessions (
  token_hash TEXT PRIMARY KEY, share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'active',
  created INTEGER NOT NULL, activated INTEGER NOT NULL, last_activity INTEGER NOT NULL, expires INTEGER NOT NULL
);
CREATE TABLE storage_usage (
  id INTEGER PRIMARY KEY CHECK(id=1), used INTEGER NOT NULL DEFAULT 0 CHECK(used>=0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved>=0)
);
INSERT INTO storage_usage(id) VALUES(1);
-- Reservation/usage change in the same transaction as their authoritative rows.
CREATE TRIGGER upload_reserve_insert AFTER INSERT ON uploads BEGIN
 UPDATE storage_usage SET reserved=reserved+CASE WHEN NEW.state NOT IN ('completed','cleaned') THEN NEW.size ELSE 0 END WHERE id=1;
END;
CREATE TRIGGER upload_reserve_update AFTER UPDATE OF state,size ON uploads BEGIN
 UPDATE storage_usage SET reserved=reserved
  -CASE WHEN OLD.state NOT IN ('completed','cleaned') THEN OLD.size ELSE 0 END
  +CASE WHEN NEW.state NOT IN ('completed','cleaned') THEN NEW.size ELSE 0 END WHERE id=1;
END;
CREATE TRIGGER upload_reserve_delete AFTER DELETE ON uploads BEGIN
 UPDATE storage_usage SET reserved=reserved-CASE WHEN OLD.state NOT IN ('completed','cleaned') THEN OLD.size ELSE 0 END WHERE id=1;
END;
CREATE TRIGGER share_usage_insert AFTER INSERT ON shares BEGIN
 UPDATE storage_usage SET used=used+CASE WHEN NEW.state!='deleted' THEN NEW.size ELSE 0 END WHERE id=1;
END;
CREATE TRIGGER share_usage_update AFTER UPDATE OF state,size ON shares BEGIN
 UPDATE storage_usage SET used=used-CASE WHEN OLD.state!='deleted' THEN OLD.size ELSE 0 END
  +CASE WHEN NEW.state!='deleted' THEN NEW.size ELSE 0 END WHERE id=1;
END;
CREATE TRIGGER share_usage_delete AFTER DELETE ON shares BEGIN
 UPDATE storage_usage SET used=used-CASE WHEN OLD.state!='deleted' THEN OLD.size ELSE 0 END WHERE id=1;
END;
CREATE TABLE rate_limits(key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE audit_events(id INTEGER PRIMARY KEY, action TEXT NOT NULL, target TEXT NOT NULL, result TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX download_share ON download_sessions(share_id,state,expires);
CREATE INDEX download_expiry ON download_sessions(expires);
CREATE INDEX grant_share ON share_grants(share_id);
CREATE INDEX grant_expiry ON share_grants(expires);
CREATE INDEX share_expiry ON shares(state,expires,signed_until,retry_at);
CREATE INDEX share_history ON shares(created DESC,id);
CREATE INDEX upload_recovery ON uploads(state,retry_at,updated);
CREATE INDEX rate_expiry ON rate_limits(expires);
CREATE INDEX audit_created ON audit_events(created);
