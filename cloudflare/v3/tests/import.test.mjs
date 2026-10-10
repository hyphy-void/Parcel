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
test("migration is resumable and exact on real D1, refuses merging a second authority", async (t) => {
  const f = await fixture(t),
    s = await f.publish(7);
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
  const envelope = await exportSnapshot(config, api),
    data = JSON.parse(envelope.payload);
  assert.equal(data.source, "d1-v3");
  assert.equal(data.rows.shares[0].download_count, 1);
  assert.equal(data.usage.used, 7);
  assert.equal(data.rows.download_sessions.length, 1);
});
