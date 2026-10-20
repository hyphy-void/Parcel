# Cloudflare V3 encrypted file protocol, version 1

This format belongs to the Cloudflare V3 browser application. The independent
Go/origin application uses its existing protocol and does not gain E2EE from
this change. The frontend entry chooses the V3 application only when built
with `VITE_ADMIN_AUTH=v3`.

## Trust boundary

An honest Parcel client encrypts before upload and decrypts after download.
Workers, D1 and R2 do not receive file keys, link secrets, original filenames,
MIME types, modification times or plaintext file hashes. The service can see
file lengths, chunk layout, access rules, timing, counts, encrypted envelopes
and network metadata. HTTPS and administrator authentication remain required.

The application code delivered by the site, the browser, its extensions and
the device must be trusted. A compromised operator that changes future
JavaScript could steal keys when a user next opens that code. This custom
format has automated integrity and transfer tests; it has not had an
independent cryptographic audit.

## Keys and envelope

The client generates independent random 32-byte file and link keys with
`crypto.getRandomValues`. The link key is canonical unpadded base64url in
`#k=...` (43 characters), and is never included in HTTP requests. It is still
a secret to anyone receiving the full URL, browser history, clipboard or
local browser storage. Do not send links to analytics or third-party tools.

The sealed metadata is UTF-8 JSON containing `file_key`, `name`, `type`,
`last_modified` and full-file `sha256`. Without a password, the wrapping-key
input is the link key. With one, it is the link key concatenated with a
32-byte Argon2id result (32 MiB memory, 2 iterations, parallelism 1, independent
random 16-byte salt). HKDF-SHA256 derives an AES-256-GCM key using the random
16-byte envelope salt and info `Parcel E2EE wrapping key v1`. AES-GCM seals
the metadata with a fresh random 12-byte IV and 128-bit tag.

The public descriptor contains version, algorithm, random 16-byte `file_id`,
plaintext length, fixed chunk size, chunk count, envelope and optional password
KDF parameters. Its bounded structure is validated on both sides. Canonical
base64url is used for binary descriptor values. Envelope ciphertext is limited
to 8192 bytes.

The existing online password proof uses a different random salt. D1 holds that
proof in a server-protected verifier for admission control; it cannot substitute
for the separately derived wrapping key. Both salts are public. Strong passwords
matter because someone with the full link and encrypted envelope can guess
passwords offline. The UI generates a random 16-character password by default.

## Chunks and authenticated data

Plaintext chunks are 16,777,216 bytes (16 MiB), except the last. Even an empty
file has one chunk. Each chunk is `IV[12] || AES-GCM ciphertext || tag[16]`,
so stored length is `plain_size + 28 * max(1, ceil(plain_size / 16777216))`.
Chunk index is zero based. Ciphertext range start is `index * 16777244`.

Retries generate a fresh random IV, including when re-encrypting the same
chunk. A client context guards at one million encryption attempts. The format
limits files to 10,000 chunks; the deployed service's plaintext file limit
remains 8 GiB. R2 parts and quota accounting use actual stored lengths.

AAD is UTF-8 `JSON.stringify` of an array. Let `I` be the ordered values
`[version, algorithm, file_id, plain_size, chunk_size, chunk_count]`.

- Chunk AAD is `["Parcel E2EE file chunk", ...I, index, plaintextChunkLength]`.
- Envelope AAD is `["Parcel E2EE file envelope", ...I, K]`, where `K` is null
  without a password, otherwise `[scheme, salt, memory_kib, iterations, parallelism]`.

The authenticated layout detects swapped, reordered, truncated and cross-file
chunks. The client checks the encrypted whole-file SHA-256 before handing the
last plaintext chunk to the saving sink.

## Upload and download recovery

Before upload, the browser hashes the full file with bounded reads. Before a
reselected file is resumed, it checks the full hash against sealed metadata.
The private upload context and idempotency key remain on the creating browser.
R2 part listing reconciles completed ciphertext parts after a lost response;
no offset reported by the browser is trusted for storage accounting.

Downloads stage authenticated ciphertext chunks in IndexedDB. Reloads reuse
complete chunks; a partial chunk is fetched again. Quota is checked before
admission. Optional persistent-storage permission never blocks the transfer.
A locally persisted random admission token makes initial response loss and
concurrent retries recover one session and charge one qualification. D1 keeps
hash-only admission tombstones so an expired admission cannot silently consume
another slot. A user must explicitly establish a new session when needed.

Five-minute signed URLs are refreshed within a valid download session without
recounting. The session has absolute and idle expiry and is versioned with the
share. Revocation, expiry or password changes deny future session recovery.

Saving authenticates ciphertext again and streams plaintext to a native file
writer, or to a same-origin Service Worker download with backpressure. There
is no whole-file Blob fallback for nonempty files. The browser needs enough
space for a ciphertext staging copy and the final file, as well as sufficient
origin storage quota. Clearing site data removes recovery state. Browser or
device eviction can still remove nonpersistent caches.

## Password changes, backup and migration

Changing a password rewraps the same file key and metadata using new envelope
salt, IV and optional password salt. An expected share version prevents stale
concurrent updates. R2 content does not change. Removing protection likewise
rewraps for the link key alone. New requests must pass the updated online gate.
Someone who already obtained a file key or plaintext cannot be made to forget
it; cached ciphertext can still be decrypted with that key.

The creating browser can export a context backup encrypted with its own
12–256 UTF-8-byte passphrase, Argon2id and domain-separated HKDF/AES-GCM.
It includes the file key and must be kept securely. Administrator login alone
cannot restore a missing local context. Lost link keys/contexts without a
usable backup cannot be recovered by the server.

Migrations `0004_e2ee.sql` and `0005_download_admissions.sql` are additive. They
do not encrypt or delete old objects. Retired V3 shares cannot be downloaded
with the new application; reupload from the original file. Historical rows
remain available for normal cleanup and administrative revocation. Go rollback
export refuses encrypted rows: retain a compatible E2EE Worker and D1/R2 backups.

## Acceptance

Build the V3 UI and Worker first. Focused commands:

```sh
npm run test:crypto
npm run test:v3
node --test web/tests/login-response.mjs # isolated V3 login test build required
npm run test:e2ee:https
PARCEL_E2EE_LARGE=1 npm run test:e2ee:https
```

The real HTTPS suite runs on Linux with Node 24, OpenSSL, NSS `certutil`
(`libnss3-tools`), installed Playwright browsers and the platform's Miniflare
binary. It creates an ephemeral CA and isolated Firefox certificate profile;
it never changes user or system certificate stores. It uses real HTTP, browser
storage, Service Worker and browser download, with a local D1/R2 fixture. No
Playwright request interception substitutes the saving path. The 8 GiB run is
opt-in because it writes and reads multiple file copies and takes minutes.
Reports and screenshots are written under ignored `.parcel-v3/e2ee-acceptance/`.
