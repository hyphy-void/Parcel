import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.mjs";

test("V3 actual workerd serves assets and verifies Access/CSRF, rejects origin bypass", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.mf.dispatchFetch(f.config.PUBLIC_URL + "/")).status,
    200,
  );
  assert.equal(
    (await f.api("/api/v1/admin/status", { admin: false })).status,
    401,
  );
  assert.equal(
    (
      await f.api("/api/v1/uploads", {
        method: "POST",
        body: {},
        headers: { "X-CSRF-Token": "forged" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.api("/api/v1/uploads", {
        method: "POST",
        body: {},
        headers: { Origin: "https://attacker.example" },
      })
    ).status,
    403,
  );
  for (const path of [
    "/readyz",
    "/api/v1/downloads/" + "a".repeat(32) + "/file",
    "/api/v1/uploads/%2e",
  ])
    assert.ok([400, 404].includes((await f.api(path)).status));
  assert.equal(
    (await f.mf.dispatchFetch("https://preview.example/api/v1/admin/status"))
      .status,
    403,
  );
  const s = await (
    await f.api("/api/v1/admin/status", { expected: 200 })
  ).json();
  assert.equal(s.backend_mode, "serverless");
  assert.equal(s.chunk_bytes, 16 << 20);
  assert.equal(f.unexpected, 0);
});
test("D1 concurrent creation never over-reserves quota, idempotency survives restart", async (t) => {
  const f = await fixture(t, { config: { STORAGE_QUOTA_BYTES: "10" } });
  const body = { name: "配额.bin", size: 7 };
  const responses = await Promise.all(
    [1, 2, 3].map(() =>
      f.api("/api/v1/uploads", {
        method: "POST",
        body,
        headers: { "Idempotency-Key": crypto.randomUUID() },
      }),
    ),
  );
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 507, 507]);
  assert.equal(
    (await f.db.prepare("SELECT reserved FROM storage_usage").first()).reserved,
    7,
  );
  const r = responses.find((r) => r.status === 201),
    u = await r.json();
  await f.api(`/api/v1/uploads/${u.id}`, { method: "DELETE", expected: 200 });
  assert.equal(
    (await f.db.prepare("SELECT reserved FROM storage_usage").first()).reserved,
    0,
  );
  const key = crypto.randomUUID(),
    first = await f.create(7, {}, key);
  await f.restart();
  const repeated = await (
    await f.api("/api/v1/uploads", {
      method: "POST",
      body: {
        name: "测试资料.bin",
        size: 7,
        ttl_seconds: 3600,
        max_downloads: 3,
      },
      headers: { "Idempotency-Key": key },
      expected: 200,
    })
  ).json();
  assert.equal(first.id, repeated.id);
  await f.api("/api/v1/uploads", {
    method: "POST",
    body: { name: "different.bin", size: 7 },
    headers: { "Idempotency-Key": key },
    expected: 409,
  });
});
test("16 MiB multipart validates server sizes, last chunk and signed Content-Length", async (t) => {
  const f = await fixture(t);
  const u = await f.create((16 << 20) + 3);
  assert.equal(u.part_bytes, 16 << 20);
  const signed = await (
    await f.api(`/api/v1/uploads/${u.id}/parts/2`, {
      method: "POST",
      expected: 200,
    })
  ).json();
  const url = new URL(signed.url);
  assert.equal(signed.size, 3);
  assert.equal(url.searchParams.get("partNumber"), "2");
  assert.equal(
    url.searchParams.get("X-Amz-SignedHeaders"),
    "content-length;host",
  );
  await f.put(u.id, 1, 16 << 20);
  await f.put(u.id, 2, 2);
  await f.api(`/api/v1/uploads/${u.id}/complete`, {
    method: "POST",
    expected: 409,
  });
  const partial = await (
    await f.api(`/api/v1/uploads/${u.id}`, { expected: 200 })
  ).json();
  assert.equal(partial.offset, 16 << 20);
  await f.put(u.id, 2, 3);
  await f.api(`/api/v1/uploads/${u.id}/complete`, {
    method: "POST",
    expected: 202,
  });
  await f.wait(u.id);
  const usage = await f.db
    .prepare("SELECT used,reserved FROM storage_usage")
    .first();
  assert.deepEqual(usage, { used: u.size, reserved: 0 });
  await f.api(`/api/v1/uploads/${u.id}/complete`, {
    method: "POST",
    expected: 202,
  });
  assert.equal(
    (await f.db.prepare("SELECT count(*) AS n FROM shares").first()).n,
    1,
  );
});
test("zero-byte files publish and finalizing object recovers after complete-before-D1 crash", async (t) => {
  const f = await fixture(t);
  const empty = await f.publish(0);
  assert.equal(empty.size, 0);
  const u = await f.create(7);
  const part = await f.put(u.id, 1, 7),
    row = await f.row(u.id);
  await f.bucket
    .resumeMultipartUpload(row.storage_key, row.multipart_id)
    .complete([part]);
  await f.db
    .prepare(
      "UPDATE uploads SET state='finalizing',lease_token='dead-worker',lease_until=1 WHERE id=?",
    )
    .bind(u.id)
    .run();
  await f.restart();
  await f.maintain();
  await f.wait(u.id);
  const shares = await f.db
    .prepare("SELECT * FROM shares WHERE upload_id=?")
    .bind(u.id)
    .all();
  assert.equal(shares.results.length, 1);
  assert.equal(shares.results[0].size, 7);
  assert.equal(f.unexpected, 0);
});
test("twenty parallel download admissions consume exactly the final D1 slot; refresh does not recount", async (t) => {
  const f = await fixture(t);
  const s = await f.publish(7, { max_downloads: 1 });
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      f.api(`/api/v1/shares/${s.id}/download-sessions`, {
        admin: false,
        method: "POST",
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 410).length, 19);
  const ticket = await results.find((r) => r.status === 201).json();
  assert.equal(
    (
      await f.db
        .prepare("SELECT download_count FROM shares WHERE id=?")
        .bind(s.id)
        .first()
    ).download_count,
    1,
  );
  // Advance the persistent limiter's window so this specifically tests session refresh.
  await f.db.prepare("DELETE FROM rate_limits").run();
  await f.api(`/api/v1/shares/${s.id}/download-sessions/refresh`, {
    admin: false,
    method: "POST",
    body: { session: ticket.session },
    expected: 200,
  });
  assert.equal(
    (
      await f.db
        .prepare("SELECT download_count FROM shares WHERE id=?")
        .bind(s.id)
        .first()
    ).download_count,
    1,
  );
  await f.api(`/api/v1/admin/shares/${s.id}`, {
    method: "DELETE",
    expected: 200,
  });
  await f.api(`/api/v1/shares/${s.id}/download-sessions/refresh`, {
    admin: false,
    method: "POST",
    body: { session: ticket.session },
    expected: 410,
  });
});
test("revoked shares cannot issue a session or consume a stale authorization", async (t) => {
  const f = await fixture(t);
  const s = await f.publish(7);
  await f.db
    .prepare("UPDATE shares SET state='revoked',version=version+1 WHERE id=?")
    .bind(s.id)
    .run();
  await f.api(`/api/v1/shares/${s.id}/download-sessions`, {
    admin: false,
    method: "POST",
    expected: 410,
  });
  assert.equal(
    (
      await f.db
        .prepare("SELECT download_count FROM shares WHERE id=?")
        .bind(s.id)
        .first()
    ).download_count,
    0,
  );
});
test("cleanup retains signed downloads, retries expired leases, releases quota after R2 deletion", async (t) => {
  const f = await fixture(t);
  const s = await f.publish(7);
  const ticket = await (
    await f.api(`/api/v1/shares/${s.id}/download-sessions`, {
      admin: false,
      method: "POST",
      expected: 201,
    })
  ).json();
  assert.ok(ticket.url);
  await f.api(`/api/v1/admin/shares/${s.id}`, {
    method: "DELETE",
    expected: 200,
  });
  await f.maintain();
  const row = await f.db
    .prepare("SELECT * FROM shares WHERE id=?")
    .bind(s.id)
    .first();
  assert.equal(row.state, "revoked");
  assert.ok(await f.bucket.head(row.storage_key));
  await f.db
    .prepare(
      "UPDATE shares SET signed_until=1,lease_until=1,lease_token='crashed',state='deleting' WHERE id=?",
    )
    .bind(s.id)
    .run();
  await f.restart();
  await f.maintain();
  assert.equal(
    (
      await f.db
        .prepare("SELECT state FROM shares WHERE id=?")
        .bind(s.id)
        .first()
    ).state,
    "deleted",
  );
  assert.equal(await f.bucket.head(row.storage_key), null);
  assert.deepEqual(
    await f.db.prepare("SELECT used,reserved FROM storage_usage").first(),
    { used: 0, reserved: 0 },
  );
  const cleared = await f.api("/api/v1/admin/shares/cleaned", {
    method: "DELETE",
    expected: 200,
  });
  assert.equal((await cleared.json()).removed, 1);
  assert.equal(
    (await f.db.prepare("SELECT count(*) AS n FROM shares").first()).n,
    0,
  );
});
test("transient R2 errors retain uploads; cancel aborts multipart and frees reservation", async (t) => {
  const f = await fixture(t);
  const u = await f.create(7);
  await f.put(u.id, 1, 7);
  f.failLists();
  await f.api(`/api/v1/uploads/${u.id}`, { expected: 503 });
  assert.equal((await f.row(u.id)).state, "uploading");
  await f.api(`/api/v1/uploads/${u.id}`, { expected: 200 });
  await f.api(`/api/v1/uploads/${u.id}`, { method: "DELETE", expected: 200 });
  assert.equal((await f.row(u.id)).state, "cleaned");
  assert.equal(
    (await f.db.prepare("SELECT reserved FROM storage_usage").first()).reserved,
    0,
  );
});

test("password protection preserves Go Argon2id hashes, grants and sessions are versioned", async (t) => {
  const f = await fixture(t);
  const s = await f.publish(7);
  const legacy =
    "$argon2id$v=19$m=32768,t=2,p=1$MDEyMzQ1Njc4OWFiY2RlZg$A3W+APQ22i3uCifCT3RkV4zNYn7bSDZepRuL9Off/ao";
  await f.db
    .prepare("UPDATE shares SET password_hash=? WHERE id=?")
    .bind(legacy, s.id)
    .run();
  const locked = await (
    await f.api(`/api/v1/shares/${s.id}`, { admin: false, expected: 200 })
  ).json();
  assert.equal(locked.locked, true);
  assert.equal(locked.name, undefined);
  await f.api(`/api/v1/shares/${s.id}/unlock`, {
    admin: false,
    method: "POST",
    body: { password: "wrong" },
    expected: 401,
  });
  const start = performance.now();
  const unlock = await f.api(`/api/v1/shares/${s.id}/unlock`, {
    admin: false,
    method: "POST",
    body: { password: "密码-test" },
    expected: 200,
  });
  t.diagnostic(
    `Argon2id workerd wall time: ${Math.round(performance.now() - start)} ms (not production CPU measurement)`,
  );
  const cookie = unlock.headers.get("set-cookie").split(";")[0];
  const ticket = await (
    await f.api(`/api/v1/shares/${s.id}/download-sessions`, {
      admin: false,
      cookie,
      method: "POST",
      expected: 201,
    })
  ).json();
  await f.api(`/api/v1/admin/shares/${s.id}/password`, {
    method: "PATCH",
    body: { password: "new-password" },
    expected: 200,
  });
  await f.api(`/api/v1/shares/${s.id}/download-sessions`, {
    admin: false,
    cookie,
    method: "POST",
    expected: 401,
  });
  await f.api(`/api/v1/shares/${s.id}/download-sessions/refresh`, {
    admin: false,
    method: "POST",
    body: { session: ticket.session },
    expected: 410,
  });
  await f.api(`/api/v1/shares/${s.id}/unlock`, {
    admin: false,
    method: "POST",
    body: { password: "new-password" },
    expected: 200,
  });
  await f.api(`/api/v1/admin/shares/${s.id}/password`, {
    method: "PATCH",
    body: { password: "" },
    expected: 200,
  });
  assert.equal(
    (
      await (
        await f.api(`/api/v1/shares/${s.id}`, { admin: false, expected: 200 })
      ).json()
    ).password_required,
    false,
  );
});

test("D1 batch failure rolls back reservation and session count together", async (t) => {
  const f = await fixture(t);
  const s = await f.publish(7);
  await assert.rejects(
    f.db.batch([
      f.db
        .prepare("UPDATE shares SET download_count=download_count+1 WHERE id=?")
        .bind(s.id),
      f.db.prepare("UPDATE storage_usage SET used=-1 WHERE id=1"),
    ]),
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT download_count FROM shares WHERE id=?")
        .bind(s.id)
        .first()
    ).download_count,
    0,
  );
  assert.deepEqual(
    await f.db.prepare("SELECT used,reserved FROM storage_usage").first(),
    { used: 7, reserved: 0 },
  );
});

test("revocation interleaved between signing and D1 admission denies the stale ticket", async (t) => {
  const { Service, configuration } = await import("../service.mjs");
  const f = await fixture(t),
    s = await f.publish(7);
  let announce, unblock;
  const signed = new Promise((r) => (announce = r)),
    blocked = new Promise((r) => (unblock = r));
  const service = new Service(
    configuration({ ...f.config, DB: f.db, FILES: f.bucket }),
    { waitUntil() {} },
    {
      store: {
        async signGet() {
          announce();
          await blocked;
          return "https://r2.example/signed";
        },
      },
    },
  );
  const ticket = service.download(
    s.id,
    new Request(f.config.PUBLIC_URL + "/api/v1/shares/" + s.id),
    {},
  );
  await signed;
  await f.api(`/api/v1/admin/shares/${s.id}`, {
    method: "DELETE",
    expected: 200,
  });
  unblock();
  await assert.rejects(ticket, (e) => e.status === 410);
  assert.equal(
    (
      await f.db
        .prepare("SELECT download_count FROM shares WHERE id=?")
        .bind(s.id)
        .first()
    ).download_count,
    0,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) AS n FROM download_sessions").first())
      .n,
    0,
  );
});

test("signing failure cannot consume a download or create an authorization", async (t) => {
  const { Service, configuration } = await import("../service.mjs");
  const f = await fixture(t),
    s = await f.publish(7);
  const service = new Service(
    configuration({ ...f.config, DB: f.db, FILES: f.bucket }),
    { waitUntil() {} },
    {
      store: {
        async signGet() {
          throw new Error("signing failed");
        },
      },
    },
  );
  await assert.rejects(
    service.download(
      s.id,
      new Request(f.config.PUBLIC_URL + "/api/v1/shares/" + s.id),
      {},
    ),
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT download_count FROM shares WHERE id=?")
        .bind(s.id)
        .first()
    ).download_count,
    0,
  );
  assert.equal(
    (await f.db.prepare("SELECT count(*) AS n FROM download_sessions").first())
      .n,
    0,
  );
});

test("share expiry during asynchronous signing is rechecked before consuming a download", async (t) => {
  const { Service, configuration } = await import("../service.mjs");
  const f = await fixture(t),
    s = await f.publish(7);
  let now = Math.floor(Date.now() / 1000);
  await f.db
    .prepare("UPDATE shares SET expires=? WHERE id=?")
    .bind(now + 2, s.id)
    .run();
  let announce, unblock;
  const signed = new Promise((r) => (announce = r)),
    blocked = new Promise((r) => (unblock = r));
  const service = new Service(
    configuration({ ...f.config, DB: f.db, FILES: f.bucket }),
    { waitUntil() {} },
    {
      now: () => now,
      store: {
        async signGet() {
          announce();
          await blocked;
          return "https://r2.example/signed";
        },
      },
    },
  );
  const ticket = service.download(
    s.id,
    new Request(f.config.PUBLIC_URL + "/api/v1/shares/" + s.id),
    {},
  );
  await signed;
  now += 3;
  unblock();
  await assert.rejects(ticket, (e) => e.status === 410);
  assert.equal(
    (
      await f.db
        .prepare("SELECT download_count FROM shares WHERE id=?")
        .bind(s.id)
        .first()
    ).download_count,
    0,
  );
});

test("mismatched immutable R2 object never publishes and quota is released by confirmed cleanup", async (t) => {
  const f = await fixture(t),
    u = await f.create(7);
  await f.put(u.id, 1, 7);
  const row = await f.row(u.id);
  await f.bucket.put(row.storage_key, new Uint8Array(6), {
    customMetadata: { "parcel-upload": u.id },
  });
  await f.db
    .prepare("UPDATE uploads SET state='finalizing' WHERE id=?")
    .bind(u.id)
    .run();
  await f.maintain();
  assert.equal((await f.row(u.id)).state, "failed");
  assert.equal(
    (await f.db.prepare("SELECT count(*) AS n FROM shares").first()).n,
    0,
  );
  assert.equal(
    (await f.db.prepare("SELECT reserved FROM storage_usage").first()).reserved,
    7,
  );
  await f.db
    .prepare("UPDATE uploads SET retry_at=0 WHERE id=?")
    .bind(u.id)
    .run();
  await f.maintain();
  assert.equal((await f.row(u.id)).state, "cleaned");
  assert.equal(await f.bucket.head(row.storage_key), null);
  assert.equal(
    (await f.db.prepare("SELECT reserved FROM storage_usage").first()).reserved,
    0,
  );
});

test("R2 deletion failure preserves charged usage and retries durable cleanup after restart", async (t) => {
  const { Service, configuration } = await import("../service.mjs");
  const f = await fixture(t),
    s = await f.publish(7);
  await f.api(`/api/v1/admin/shares/${s.id}`, {
    method: "DELETE",
    expected: 200,
  });
  const service = new Service(
    configuration({ ...f.config, DB: f.db, FILES: f.bucket }),
    { waitUntil() {} },
    {
      store: {
        async delete() {
          throw new Error("R2 outage");
        },
      },
    },
  );
  await service.cleanupShare(s.id);
  let row = await f.db
    .prepare("SELECT * FROM shares WHERE id=?")
    .bind(s.id)
    .first();
  assert.equal(row.state, "deleting");
  assert.equal(row.delete_attempts, 1);
  assert.equal(
    (await f.db.prepare("SELECT used FROM storage_usage").first()).used,
    7,
  );
  assert.ok(await f.bucket.head(row.storage_key));
  await f.restart();
  await f.maintain();
  assert.ok(await f.bucket.head(row.storage_key));
  await f.db
    .prepare("UPDATE shares SET retry_at=0 WHERE id=?")
    .bind(s.id)
    .run();
  await f.maintain();
  assert.equal(
    (
      await f.db
        .prepare("SELECT state FROM shares WHERE id=?")
        .bind(s.id)
        .first()
    ).state,
    "deleted",
  );
  assert.equal(
    (await f.db.prepare("SELECT used FROM storage_usage").first()).used,
    0,
  );
  assert.equal(await f.bucket.head(row.storage_key), null);
});
