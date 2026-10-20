-- Keep the existing size columns as the authoritative stored-byte accounting
-- used by quota triggers and R2 multipart verification. No legacy objects are
-- rewritten or deleted; a blank descriptor identifies the retired format.
ALTER TABLE uploads ADD COLUMN plaintext_size INTEGER NOT NULL DEFAULT 0 CHECK(plaintext_size>=0);
ALTER TABLE uploads ADD COLUMN encryption TEXT NOT NULL DEFAULT '';
ALTER TABLE shares ADD COLUMN plaintext_size INTEGER NOT NULL DEFAULT 0 CHECK(plaintext_size>=0);
ALTER TABLE shares ADD COLUMN encryption TEXT NOT NULL DEFAULT '';
UPDATE uploads SET plaintext_size=size;
UPDATE shares SET plaintext_size=size;
