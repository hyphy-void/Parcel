import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { unstable_splitSqlQuery } from "wrangler";
import { fixture, passwordProof } from "./fixture.mjs";

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
      body: { name: "invalid", size: 0, max_downloads },
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
  const proof = await passwordProof("existing-password");
  const s = await f.publish(7, { password_proof: proof });
  await f.create(11);
  const unlock = await f.api(`/api/v1/shares/${s.id}/unlock`, {
    method: "POST",
    admin: false,
    body: { password_proof: proof },
    expected: 200,
  });
  const cookie = unlock.headers.get("set-cookie").split(";")[0];
  const ticket = await (
    await f.api(`/api/v1/shares/${s.id}/download-sessions`, {
      method: "POST",
      admin: false,
      cookie,
      expected: 201,
    })
  ).json();
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
  await f.api(`/api/v1/shares/${s.id}/download-sessions/refresh`, {
    method: "POST",
    admin: false,
    body: { session: ticket.session },
    expected: 200,
  });
  await f.api(`/api/v1/shares/${s.id}/download-sessions`, {
    method: "POST",
    admin: false,
    cookie,
    expected: 201,
  });
  await assert.rejects(
    f.db
      .prepare("UPDATE shares SET download_count=4 WHERE id=?")
      .bind(s.id)
      .run(),
    /CHECK constraint/,
  );
  const unlimited = await f.publish(3, { max_downloads: -1 });
  assert.deepEqual(
    await f.db.prepare("SELECT used,reserved FROM storage_usage").first(),
    { used: 10, reserved: 11 },
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
