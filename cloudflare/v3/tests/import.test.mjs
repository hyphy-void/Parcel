import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { manifest, importSnapshot } from "../../../scripts/import-v3.mjs";
import { fixture } from "./fixture.mjs";
const envelope = (data) => {
  const payload = JSON.stringify(data);
  return JSON.stringify({
    payload,
    sha256: createHash("sha256").update(payload).digest("hex"),
  });
};
// These fixtures model the retired Go protocol. New E2EE objects have different
// byte accounting and cannot be converted into a Go rollback snapshot.
async function legacyRows(f) {
  await f.db.batch([
    f.db.prepare(
      "UPDATE uploads SET size=plaintext_size,offset=plaintext_size,part_bytes=16777216,encryption=''",
    ),
    f.db.prepare("UPDATE shares SET size=plaintext_size,encryption=''"),
    f.db.prepare(
      "UPDATE storage_usage SET used=(SELECT coalesce(sum(size),0) FROM shares WHERE deleted_at=0),reserved=0 WHERE id=1",
    ),
  ]);
}
test("migration is resumable and exact on real D1, refuses merging a second authority", async (t) => {
  const f = await fixture(t),
    s = await f.publish(7);
  await legacyRows(f);
  const rows = {};
  for (const table of [
    "uploads",
    "shares",
    "share_grants",
    "download_sessions",
  ])
    rows[table] = (await f.db.prepare(`SELECT * FROM ${table}`).all()).results;
  const data = manifest(
    envelope({
      format: 1,
      source: "go-sqlite-schema3",
      bucket: "parcel-v3",
      exported: 1,
      rows,
      usage: { used: 7, reserved: 0 },
    }),
  );
  await f.db.batch([
    f.db.prepare("DELETE FROM shares"),
    f.db.prepare("DELETE FROM uploads"),
  ]);
  const query = (qs) =>
    f.db.batch(qs.map((q) => f.db.prepare(q.sql).bind(...q.params)));
  let fault = true;
  await assert.rejects(
    importSnapshot(data, async (qs) => {
      if (
        fault &&
        qs.some((q) => q.sql.startsWith("INSERT OR IGNORE INTO shares"))
      ) {
        fault = false;
        throw new Error("connection lost");
      }
      return query(qs);
    }),
  );
  assert.equal(
    (await f.db.prepare("SELECT complete FROM parcel_import").first()).complete,
    0,
  );
  const result = await importSnapshot(data, query);
  assert.equal(result.usage.used, 7);
  assert.deepEqual(await importSnapshot(data, query), result);
  await assert.rejects(
    importSnapshot({ ...data, fingerprint: "other" }, query),
    /another import/,
  );
  await f.db
    .prepare("UPDATE shares SET download_count=1 WHERE id=?")
    .bind(s.id)
    .run();
  await assert.rejects(importSnapshot(data, query), /content mismatch/);
  assert.equal(
    (
      await f.db
        .prepare("SELECT download_count FROM shares WHERE id=?")
        .bind(s.id)
        .first()
    ).download_count,
    1,
  );
});
test("migration checksum, upload state and format are validated", () => {
  const data = {
    format: 1,
    source: "go-sqlite-schema3",
    bucket: "parcel-v3",
    rows: {
      uploads: [{ state: "uploading" }],
      shares: [],
      share_grants: [],
      download_sessions: [],
    },
    usage: { used: 0, reserved: 0 },
  };
  assert.throws(() => manifest(envelope(data)), /unfinished/);
  assert.throws(
    () => manifest(JSON.stringify({ payload: "{}", sha256: "bad" })),
    /checksum/,
  );
  data.rows.uploads = [{ state: "completed", encryption: "{}" }];
  assert.throws(() => manifest(envelope(data)), /not a legacy Go/);
});

test("D1 rollback export requires maintenance drain and no outstanding jobs", async (t) => {
  const { exportSnapshot } = await import("../../../scripts/export-d1-v3.mjs");
  const f = await fixture(t);
  const config = {
    name: "parcel-v3",
    d1_databases: [{ database_id: "test-db" }],
    r2_buckets: [{ bucket_name: "parcel-v3" }],
  };
  let active = "true",
    since = "0";
  const api = {
    async request(path, method, body) {
      if (path.endsWith("/settings"))
        return {
          bindings: [
            { name: "ACTIVE", type: "plain_text", text: active },
            { name: "MAINTENANCE_SINCE", type: "plain_text", text: since },
          ],
        };
      return f.db.batch([f.db.prepare(body.sql).bind(...body.params)]);
    },
  };
  await assert.rejects(exportSnapshot(config, api), /Freeze/);
  active = "false";
  since = String(Math.floor(Date.now() / 1000));
  await assert.rejects(exportSnapshot(config, api), /16 minutes/);
  since = String(Math.floor(Date.now() / 1000) - 1000);
  const u = await f.create(7);
  await assert.rejects(exportSnapshot(config, api), /pending uploads/);
  await f.api(`/api/v1/uploads/${u.id}`, { method: "DELETE", expected: 200 });
  const s = await f.publish(7);
  await f.api(`/api/v1/shares/${s.id}/download-sessions`, {
    admin: false,
    method: "POST",
    expected: 201,
  });
  await assert.rejects(
    exportSnapshot(config, api),
    /encrypted files cannot be exported/,
  );
  await legacyRows(f);
  const envelope = await exportSnapshot(config, api),
    data = JSON.parse(envelope.payload);
  assert.equal(data.source, "d1-v3");
  assert.equal(data.rows.shares[0].download_count, 1);
  assert.equal(data.usage.used, 7);
  assert.equal(data.rows.download_sessions.length, 1);
});

test("protected Go migration encrypts D1 verifiers, resumes old imports and exports exact rollback hashes", async (t) => {
  const { restoreLegacyPassword } = await import("../password.mjs");
  const { exportSnapshot } = await import("../../../scripts/export-d1-v3.mjs");
  const f = await fixture(t),
    share = await f.publish(7);
  await legacyRows(f);
  const secret = "ab".repeat(32);
  const legacy =
    "$argon2id$v=19$m=32768,t=2,p=1$MDEyMzQ1Njc4OWFiY2RlZg$A3W+APQ22i3uCifCT3RkV4zNYn7bSDZepRuL9Off/ao";
  await f.db
    .prepare("UPDATE shares SET password_hash=? WHERE id=?")
    .bind(legacy, share.id)
    .run();
  const rows = {};
  for (const table of [
    "uploads",
    "shares",
    "share_grants",
    "download_sessions",
  ])
    rows[table] = (await f.db.prepare(`SELECT * FROM ${table}`).all()).results;
  const data = manifest(
    envelope({
      format: 1,
      source: "go-sqlite-schema3",
      bucket: "parcel-v3",
      exported: 1,
      rows,
      usage: { used: 7, reserved: 0 },
    }),
  );
  await f.db.batch([
    f.db.prepare("DELETE FROM shares"),
    f.db.prepare("DELETE FROM uploads"),
  ]);
  const query = (qs) =>
    f.db.batch(qs.map((q) => f.db.prepare(q.sql).bind(...q.params)));
  await assert.rejects(importSnapshot(data, query), /secret/);
  await importSnapshot(data, query, { sessionSecret: secret });
  const stored = (
    await f.db
      .prepare("SELECT password_hash FROM shares WHERE id=?")
      .bind(share.id)
      .first()
  ).password_hash;
  assert.ok(stored.startsWith("$parcel-a2$"));
  assert.equal(await restoreLegacyPassword(stored, secret), legacy);
  await importSnapshot(data, query, { sessionSecret: secret });
  assert.equal(
    (
      await f.db
        .prepare("SELECT password_hash FROM shares WHERE id=?")
        .bind(share.id)
        .first()
    ).password_hash,
    stored,
  );
  await assert.rejects(
    importSnapshot(data, query, { sessionSecret: "cd".repeat(32) }),
  );
  await f.db
    .prepare("UPDATE shares SET password_hash=? WHERE id=?")
    .bind(legacy, share.id)
    .run();
  await importSnapshot(data, query, { sessionSecret: secret });
  assert.ok(
    (
      await f.db
        .prepare("SELECT password_hash FROM shares WHERE id=?")
        .bind(share.id)
        .first()
    ).password_hash.startsWith("$parcel-a2$"),
  );
  const config = {
    name: "parcel-v3",
    d1_databases: [{ database_id: "test-db" }],
    r2_buckets: [{ bucket_name: "parcel-v3" }],
  };
  const api = {
    async request(path, method, body) {
      if (path.endsWith("/settings"))
        return {
          bindings: [
            { name: "ACTIVE", type: "plain_text", text: "false" },
            {
              name: "MAINTENANCE_SINCE",
              type: "plain_text",
              text: String(Math.floor(Date.now() / 1000) - 1000),
            },
          ],
        };
      return query([{ sql: body.sql, params: body.params }]);
    },
  };
  await assert.rejects(exportSnapshot(config, api), /secret/);
  const exported = JSON.parse(
    (await exportSnapshot(config, api, { sessionSecret: secret })).payload,
  );
  assert.equal(exported.rows.shares[0].password_hash, legacy);
  assert.equal(
    exported.rows.shares[0].download_count,
    rows.shares[0].download_count,
  );
});
