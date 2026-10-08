ALTER TABLE uploads ADD COLUMN backend TEXT NOT NULL DEFAULT 'local';
ALTER TABLE uploads ADD COLUMN multipart_id TEXT NOT NULL DEFAULT '';
ALTER TABLE uploads ADD COLUMN part_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shares ADD COLUMN backend TEXT NOT NULL DEFAULT 'local';
ALTER TABLE shares ADD COLUMN etag TEXT NOT NULL DEFAULT '';
-- Conservative deletion deadline covers signed URLs and authorized transfers.
ALTER TABLE shares ADD COLUMN signed_until INTEGER NOT NULL DEFAULT 0;
INSERT INTO schema_migrations VALUES(2);
