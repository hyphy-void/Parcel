import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { unstable_splitSqlQuery } from "wrangler";
import { fixture, passwordProof, encryptionManifest } from "./fixture.mjs";

test("unlimited downloads count past 100, retain passwords and expire normally", async (t) => {
  const f = await fixture(t);
  const proof = await passwordProof("unlimited-password");
  const s = await f.publish(7, { max_downloads: -1, password_proof: proof });
  assert.equal(s.max_downloads, -1);
  await f.api(`/api/v1/shares/${s.id}/download-sessions`, {
    method: "POST",
    admin: false,
    expected: 401,
  });
  const unlock = await f.api(`/api/v1/shares/${s.id}/unlock`, {
    method: "POST",
    admin: false,
    body: { password_proof: proof },
    expected: 200,
  });
  const cookie = unlock.headers.get("set-cookie").split(";")[0];
  await f.db
    .prepare("UPDATE shares SET download_count=99 WHERE id=?")
    .bind(s.id)
    .run();
  const tickets = await Promise.all(
    Array.from({ length: 8 }, async () =>
      (
        await f.api(`/api/v1/shares/${s.id}/download-sessions`, {
          method: "POST",
          admin: false,
          cookie,
          expected: 201,
        })
      ).json(),
    ),
  );
  await f.api(`/api/v1/shares/${s.id}/download-sessions/refresh`, {
    method: "POST",
    admin: false,
    body: { session: tickets[0].session },
    expected: 200,
  });
  let share = await (
    await f.api(`/api/v1/admin/shares/${s.id}`, { expected: 200 })
  ).json();
  assert.equal(share.download_count, 107);
  assert.equal(share.availability, "available");
  await f.db
    .prepare("UPDATE shares SET signed_until=0 WHERE id=?")
    .bind(s.id)
    .run();
  await f.maintain();
  assert.ok(await f.bucket.head((await f.row(s.upload_id)).storage_key));
  assert.equal(
    (
      await f.db
        .prepare("SELECT state FROM shares WHERE id=?")
        .bind(s.id)
        .first()
    ).state,
    "active",
  );
  await f.db.prepare("UPDATE shares SET expires=1 WHERE id=?").bind(s.id).run();
  await f.api(`/api/v1/shares/${s.id}/download-sessions`, {
    method: "POST",
    admin: false,
    cookie,
    expected: 410,
  });
  await f.api(`/api/v1/shares/${s.id}/download-sessions/refresh`, {
    method: "POST",
    admin: false,
    body: { session: tickets[0].session },
    expected: 410,
  });
  await f.maintain();
  share = await (
    await f.api(`/api/v1/admin/shares/${s.id}`, { expected: 200 })
  ).json();
  assert.equal(share.state, "deleted");
  assert.deepEqual(
    await f.db.prepare("SELECT used,reserved FROM storage_usage").first(),
    { used: 0, reserved: 0 },
  );
});

test("unlimited shares can be revoked, limits still reject invalid values and zero uses the default", async (t) => {
  const f = await fixture(t);
  for (const max_downloads of [-2, 101, 1.5]) {
    const response = await f.api("/api/v1/uploads", {
      method: "POST",
      body: { size: 0, encryption: encryptionManifest(0), max_downloads },
      expected: 400,
    });
    assert.equal((await response.json()).code, "invalid_limit");
  }
  assert.equal((await f.create(0, { max_downloads: 0 })).max_downloads, 3);
  const s = await f.publish(7, { max_downloads: -1 });
  const ticket = await (
    await f.api(`/api/v1/shares/${s.id}/download-sessions`, {
      method: "POST",
      admin: false,
      expected: 201,
    })
  ).json();
  await f.api(`/api/v1/admin/shares/${s.id}`, {
    method: "DELETE",
    expected: 200,
  });
  await f.api(`/api/v1/shares/${s.id}/download-sessions`, {
    method: "POST",
    admin: false,
    expected: 410,
  });
  await f.api(`/api/v1/shares/${s.id}/download-sessions/refresh`, {
    method: "POST",
    admin: false,
    body: { session: ticket.session },
    expected: 410,
  });
});

test("D1 migration preserves all rows, foreign keys, pending reservations and quota triggers", async (t) => {
  const f = await fixture(t, { migrationsThrough: "0001.sql" });
  // Seed the retired schema directly. The current application deliberately
  // cannot create or download plaintext-format shares, even during migration.
  const s = { id: "a".repeat(32), upload_id: "b".repeat(32) },
    pending = "c".repeat(32),
    now = Math.floor(Date.now() / 1000);
  await f.db.batch([
    f.db
      .prepare(
        "INSERT INTO uploads(id,name,size,ttl,max_downloads,state,storage_key,share_id,created,updated) VALUES(?,?,7,3600,3,'completed',?,?,?,?)",
      )
      .bind(s.upload_id, "legacy.bin", "legacy-complete", s.id, now, now),
    f.db
      .prepare(
        "INSERT INTO shares(id,upload_id,storage_key,name,size,created,expires,max_downloads,download_count,etag) VALUES(?,?,'legacy-complete','legacy.bin',7,?,?,3,1,'legacy-etag')",
      )
      .bind(s.id, s.upload_id, now, now + 3600),
    f.db
      .prepare(
        "INSERT INTO uploads(id,name,size,ttl,max_downloads,state,storage_key,share_id,created,updated) VALUES(?,?,11,3600,3,'created',?,?,?,?)",
      )
      .bind(pending, "pending.bin", "legacy-pending", "d".repeat(32), now, now),
    f.db
      .prepare(
        "INSERT INTO share_grants(token_hash,share_id,version,expires) VALUES('legacy-grant',?,1,?)",
      )
      .bind(s.id, now + 1800),
    f.db
      .prepare(
        "INSERT INTO download_sessions(token_hash,share_id,version,state,created,activated,last_activity,expires) VALUES('legacy-session',?,1,'active',?,?,?,?)",
      )
      .bind(s.id, now, now, now, now + 1800),
  ]);
  const tables = [
    "uploads",
    "shares",
    "share_grants",
    "download_sessions",
    "storage_usage",
  ];
  const snapshot = async () =>
    Promise.all(
      tables.map(
        async (name) =>
          (await f.db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all())
            .results,
      ),
    );
  const before = await snapshot();
  const statements = unstable_splitSqlQuery(
    await readFile(
      new URL("../migrations/0002_unlimited_downloads.sql", import.meta.url),
      "utf8",
    ),
  );
  await f.db.batch(statements.map((sql) => f.db.prepare(sql)));
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(
    (await f.db.prepare("PRAGMA foreign_key_check").all()).results,
    [],
  );
  await assert.rejects(
    f.db
      .prepare("UPDATE shares SET download_count=4 WHERE id=?")
      .bind(s.id)
      .run(),
    /CHECK constraint/,
  );
  const encryptionMigration = unstable_splitSqlQuery(
    await readFile(
      new URL("../migrations/0004_e2ee.sql", import.meta.url),
      "utf8",
    ),
  );
  await f.db.batch(encryptionMigration.map((sql) => f.db.prepare(sql)));
  const oldShare = await f.db
    .prepare("SELECT * FROM shares WHERE id=?")
    .bind(s.id)
    .first();
  assert.equal(oldShare.plaintext_size, 7);
  assert.equal(oldShare.encryption, "");
  assert.equal(oldShare.name, "legacy.bin");
  assert.deepEqual(
    (await f.db.prepare("PRAGMA foreign_key_check").all()).results,
    [],
  );
  await f.api(`/api/v1/shares/${s.id}`, { admin: false, expected: 410 });
  await f.api(`/api/v1/shares/${s.id}/download-sessions`, {
    method: "POST",
    admin: false,
    expected: 410,
  });
  const unlimited = await f.publish(3, { max_downloads: -1 });
  assert.deepEqual(
    await f.db.prepare("SELECT used,reserved FROM storage_usage").first(),
    { used: 38, reserved: 11 },
  );
  await f.api(`/api/v1/admin/shares/${unlimited.id}`, {
    method: "DELETE",
    expected: 200,
  });
  await f.maintain();
  assert.deepEqual(
    await f.db.prepare("SELECT used,reserved FROM storage_usage").first(),
    { used: 7, reserved: 11 },
  );
});
