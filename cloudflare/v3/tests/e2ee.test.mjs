import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, encryptionManifest, passwordProof } from "./fixture.mjs";
import { E2EE_CHUNK_BYTES, E2EE_PART_BYTES } from "../encryption.mjs";

test("E2EE descriptors are mandatory, bounded and cannot include plaintext metadata or file keys", async (t) => {
  const f = await fixture(t);
  const create = (body) =>
    f.api("/api/v1/uploads", { method: "POST", body, expected: 400 });
  for (const encryption of [
    undefined,
    { ...encryptionManifest(7), version: 2 },
    { ...encryptionManifest(7), algorithm: "AES-CBC" },
    { ...encryptionManifest(7), plain_size: 8 },
    { ...encryptionManifest(7), chunk_count: 2 },
    { ...encryptionManifest(7), chunk_size: 1 },
    { ...encryptionManifest(7), file_id: "a".repeat(22) },
    { ...encryptionManifest(7), file_key: "forbidden" },
    { ...encryptionManifest(7), metadata: { name: "private.txt" } },
    {
      ...encryptionManifest(7),
      envelope: { ...encryptionManifest(7).envelope, ciphertext: "AAAA" },
    },
  ])
    await create({ size: 7, encryption });
  for (const metadata of [
    { name: "private.txt" },
    { type: "text/plain" },
    { sha256: "0".repeat(64) },
  ])
    assert.equal(
      (
        await (
          await create({
            size: 7,
            encryption: encryptionManifest(7),
            ...metadata,
          })
        ).json()
      ).code,
      "encrypted_metadata_required",
    );
  await create({
    size: 7,
    encryption: encryptionManifest(7),
    link_secret: "forbidden",
  });
  await create({
    size: 7,
    encryption: encryptionManifest(7),
    file_key: "forbidden",
  });
  const u = await f.create(7),
    row = await f.row(u.id);
  assert.equal(u.size, 7);
  assert.equal(u.stored_size, 35);
  assert.equal(u.name, "encrypted.parcel");
  assert.equal(row.name, "encrypted.parcel");
  assert.equal(row.plaintext_size, 7);
  assert.equal(row.size, 35);
  assert.deepEqual(JSON.parse(row.encryption), u.encryption);
  assert.equal(await f.bucket.head(row.storage_key), null);
});

test("ciphertext bytes, including the empty-file tag, drive reservations and exact multipart signatures", async (t) => {
  const f = await fixture(t, {
    config: { MAX_FILE_BYTES: "7", STORAGE_QUOTA_BYTES: "35" },
  });
  const u = await f.create(7);
  assert.equal(u.part_bytes, E2EE_CHUNK_BYTES);
  assert.equal(u.stored_part_bytes, E2EE_PART_BYTES);
  assert.deepEqual(
    await f.db.prepare("SELECT used,reserved FROM storage_usage").first(),
    { used: 0, reserved: 35 },
  );
  await f.api("/api/v1/uploads", {
    method: "POST",
    body: { size: 0, encryption: encryptionManifest(0) },
    expected: 507,
  });
  await f.api(`/api/v1/uploads/${u.id}`, { method: "DELETE", expected: 200 });
  const empty = await f.create(0);
  assert.equal(empty.stored_size, 28);
  const signed = await (
    await f.api(`/api/v1/uploads/${empty.id}/parts/1`, {
      method: "POST",
      expected: 200,
    })
  ).json();
  assert.equal(signed.size, 28);
  assert.equal(
    new URL(signed.url).searchParams.get("X-Amz-SignedHeaders"),
    "content-length;host",
  );
  await f.put(empty.id, 1, new Uint8Array(0));
  await f.api(`/api/v1/uploads/${empty.id}/complete`, {
    method: "POST",
    expected: 409,
  });
  await f.put(empty.id, 1, new Uint8Array(28));
  await f.api(`/api/v1/uploads/${empty.id}/complete`, {
    method: "POST",
    expected: 202,
  });
  await f.wait(empty.id);
  assert.deepEqual(
    await f.db.prepare("SELECT used,reserved FROM storage_usage").first(),
    { used: 28, reserved: 0 },
  );
});

test("multipart resumes expose plaintext progress but validate stored offsets after worker restart", async (t) => {
  const f = await fixture(t),
    u = await f.create(E2EE_CHUNK_BYTES + 3);
  await f.put(u.id, 1, E2EE_CHUNK_BYTES);
  await f.restart();
  const resumed = await (
    await f.api(`/api/v1/uploads/${u.id}`, { expected: 200 })
  ).json();
  assert.equal(resumed.offset, E2EE_CHUNK_BYTES);
  assert.equal(resumed.stored_offset, E2EE_PART_BYTES);
  assert.equal(resumed.stored_size, E2EE_CHUNK_BYTES + 3 + 56);
  assert.deepEqual(
    resumed.parts.map((p) => p.size),
    [E2EE_PART_BYTES],
  );
  await f.put(u.id, 2, 3);
  await f.api(`/api/v1/uploads/${u.id}/complete`, {
    method: "POST",
    expected: 202,
  });
  await f.wait(u.id);
  const completed = await (
    await f.api(`/api/v1/uploads/${u.id}`, { expected: 200 })
  ).json();
  assert.equal(completed.offset, E2EE_CHUNK_BYTES + 3);
  assert.equal(completed.stored_offset, completed.stored_size);
  const share = await (
    await f.api(`/api/v1/shares/${u.share_id}`, { admin: false, expected: 200 })
  ).json();
  assert.deepEqual(share.encryption, u.encryption);
  const ticket = await (
    await f.api(`/api/v1/shares/${share.id}/download-sessions`, {
      method: "POST",
      admin: false,
      expected: 201,
    })
  ).json();
  const signedURL = new URL(ticket.url);
  assert.equal(
    signedURL.searchParams.get("response-content-disposition"),
    'attachment; filename="encrypted.parcel"',
  );
  assert.ok(
    !signedURL.searchParams.get("X-Amz-SignedHeaders").includes("range"),
  );
});

test("password verifier and wrapping KDF must be independent; rewraps require current version and immutable file identity", async (t) => {
  const f = await fixture(t),
    proof = await passwordProof("share-password");
  const duplicateSalt = encryptionManifest(7, true);
  duplicateSalt.password_kdf.salt = proof.salt
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  await f.api("/api/v1/uploads", {
    method: "POST",
    body: { size: 7, encryption: duplicateSalt, password_proof: proof },
    expected: 400,
  });
  await f.api("/api/v1/uploads", {
    method: "POST",
    body: { size: 7, encryption: encryptionManifest(7, true) },
    expected: 400,
  });
  const share = await f.publish(7),
    manifest = encryptionManifest(7, true);
  await f.api(`/api/v1/admin/shares/${share.id}/password`, {
    method: "PATCH",
    body: {
      encryption: {
        ...manifest,
        file_id: Buffer.alloc(16, 1).toString("base64url"),
      },
      password_proof: proof,
      version: 1,
    },
    expected: 400,
  });
  await f.api(`/api/v1/admin/shares/${share.id}/password`, {
    method: "PATCH",
    body: { encryption: manifest, password_proof: proof },
    expected: 409,
  });
  const responses = await Promise.all(
    [1, 2].map(() =>
      f.api(`/api/v1/admin/shares/${share.id}/password`, {
        method: "PATCH",
        body: { encryption: manifest, password_proof: proof, version: 1 },
      }),
    ),
  );
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const locked = await (
    await f.api(`/api/v1/shares/${share.id}`, { admin: false, expected: 200 })
  ).json();
  assert.equal(locked.locked, true);
  assert.equal(locked.version, 2);
  assert.deepEqual(locked.encryption, manifest);
  assert.equal(locked.name, undefined);
  const row = await f.db
    .prepare("SELECT * FROM shares WHERE id=?")
    .bind(share.id)
    .first();
  assert.equal(row.name, "encrypted.parcel");
  assert.equal(row.sha256, "");
  assert.equal(row.size, 35);
});

test("root download service worker is an exact uncached JS asset, synthetic download URLs remain network404", async (t) => {
  const f = await fixture(t, {
    assets: (request) =>
      new Response(new URL(request.url).pathname, {
        headers: { "Content-Type": "text/javascript" },
      }),
  });
  for (const method of ["GET", "HEAD"]) {
    const response = await f.mf.dispatchFetch(
      f.config.PUBLIC_URL + "/parcel-download-sw.js",
      { method },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "text/javascript");
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    if (method === "GET")
      assert.equal(await response.text(), "/parcel-download-sw.js");
  }
  assert.equal(
    (
      await f.mf.dispatchFetch(
        f.config.PUBLIC_URL + "/parcel-download-sw.js/more",
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await f.mf.dispatchFetch(
        f.config.PUBLIC_URL + "/__parcel_download/anything",
      )
    ).status,
    404,
  );
});

test("lost download-admission response and concurrent retries recover one capability and charge one qualification", async (t) => {
  const f = await fixture(t),
    share = await f.publish(7, { max_downloads: 1 });
  const requestToken = Buffer.alloc(24, 23).toString("base64url");
  const admit = () =>
    f.api(`/api/v1/shares/${share.id}/download-sessions`, {
      method: "POST",
      admin: false,
      body: { request_token: requestToken },
    });
  // Deliberately discard the first response before the client could save it.
  assert.equal((await admit()).status, 201);
  await f.restart();
  const responses = await Promise.all(Array.from({ length: 6 }, admit));
  assert.deepEqual(
    responses.map((r) => r.status),
    [200, 200, 200, 200, 200, 200],
  );
  const tickets = await Promise.all(responses.map((r) => r.json()));
  assert.ok(tickets.every((ticket) => ticket.session === tickets[0].session));
  assert.notEqual(tickets[0].session, requestToken);
  assert.equal(
    (
      await f.db
        .prepare("SELECT download_count FROM shares WHERE id=?")
        .bind(share.id)
        .first()
    ).download_count,
    1,
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) AS count FROM download_sessions")
        .first()
    ).count,
    1,
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) AS count FROM download_admissions")
        .first()
    ).count,
    1,
  );
  assert.ok(
    !JSON.stringify(
      (await f.db.prepare("SELECT * FROM download_admissions").all()).results,
    ).includes(requestToken),
  );
});

test("simultaneous first download admissions are atomic, cannot cross shares, and expired tombstones never re-admit", async (t) => {
  const f = await fixture(t),
    share = await f.publish(7, { max_downloads: -1 });
  const requestToken = Buffer.alloc(24, 27).toString("base64url");
  const body = { request_token: requestToken };
  const responses = await Promise.all(
    Array.from({ length: 8 }, () =>
      f.api(`/api/v1/shares/${share.id}/download-sessions`, {
        method: "POST",
        admin: false,
        body,
      }),
    ),
  );
  assert.equal(responses.filter((r) => r.status === 201).length, 1);
  assert.equal(responses.filter((r) => r.status === 200).length, 7);
  const tickets = await Promise.all(responses.map((r) => r.json()));
  assert.ok(tickets.every((ticket) => ticket.session === tickets[0].session));
  assert.equal(
    (
      await f.db
        .prepare("SELECT download_count FROM shares WHERE id=?")
        .bind(share.id)
        .first()
    ).download_count,
    1,
  );
  const other = await f.publish(7, { max_downloads: -1 });
  await f.api(`/api/v1/shares/${other.id}/download-sessions`, {
    method: "POST",
    admin: false,
    body,
    expected: 409,
  });
  assert.equal(
    (
      await f.db
        .prepare("SELECT download_count FROM shares WHERE id=?")
        .bind(other.id)
        .first()
    ).download_count,
    0,
  );
  await f.db
    .prepare("UPDATE download_sessions SET expires=1 WHERE share_id=?")
    .bind(share.id)
    .run();
  await f.api(`/api/v1/shares/${share.id}/download-sessions`, {
    method: "POST",
    admin: false,
    body,
    expected: 410,
  });
  await f.maintain();
  assert.equal(
    (
      await f.db
        .prepare(
          "SELECT count(*) AS count FROM download_sessions WHERE share_id=?",
        )
        .bind(share.id)
        .first()
    ).count,
    0,
  );
  await f.api(`/api/v1/shares/${share.id}/download-sessions`, {
    method: "POST",
    admin: false,
    body,
    expected: 410,
  });
  assert.equal(
    (
      await f.db
        .prepare("SELECT download_count FROM shares WHERE id=?")
        .bind(share.id)
        .first()
    ).download_count,
    1,
  );
});

test("old admission requests cannot bypass password-version changes or revocation", async (t) => {
  const f = await fixture(t),
    share = await f.publish(7, { max_downloads: -1 });
  const body = { request_token: Buffer.alloc(24, 29).toString("base64url") };
  await f.api(`/api/v1/shares/${share.id}/download-sessions`, {
    method: "POST",
    admin: false,
    body,
    expected: 201,
  });
  await f.api(`/api/v1/admin/shares/${share.id}/password`, {
    method: "PATCH",
    body: { version: 1, encryption: encryptionManifest(7), password: "" },
    expected: 200,
  });
  await f.api(`/api/v1/shares/${share.id}/download-sessions`, {
    method: "POST",
    admin: false,
    body,
    expected: 410,
  });
  await f.api(`/api/v1/admin/shares/${share.id}`, {
    method: "DELETE",
    expected: 200,
  });
  await f.api(`/api/v1/shares/${share.id}/download-sessions`, {
    method: "POST",
    admin: false,
    body,
    expected: 410,
  });
  assert.equal(
    (
      await f.db
        .prepare("SELECT download_count FROM shares WHERE id=?")
        .bind(share.id)
        .first()
    ).download_count,
    1,
  );
});

test("admission persistence failures roll back the qualification and capability together", async (t) => {
  const f = await fixture(t),
    share = await f.publish(7, { max_downloads: 1 });
  await f.db
    .prepare(
      "CREATE TRIGGER fail_admission BEFORE INSERT ON download_admissions BEGIN SELECT RAISE(ABORT,'injected admission failure'); END",
    )
    .run();
  const body = { request_token: Buffer.alloc(24, 31).toString("base64url") };
  await f.api(`/api/v1/shares/${share.id}/download-sessions`, {
    method: "POST",
    admin: false,
    body,
    expected: 503,
  });
  assert.equal(
    (
      await f.db
        .prepare("SELECT download_count FROM shares WHERE id=?")
        .bind(share.id)
        .first()
    ).download_count,
    0,
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) AS count FROM download_sessions")
        .first()
    ).count,
    0,
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) AS count FROM download_admissions")
        .first()
    ).count,
    0,
  );
  await f.db.prepare("DROP TRIGGER fail_admission").run();
  await f.api(`/api/v1/shares/${share.id}/download-sessions`, {
    method: "POST",
    admin: false,
    body,
    expected: 201,
  });
});
