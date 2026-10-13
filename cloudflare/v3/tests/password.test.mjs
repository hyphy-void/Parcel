import { test } from "node:test";
import assert from "node:assert/strict";
import { passwordProof, fixture } from "./fixture.mjs";
import {
  storePassword,
  verifyPassword,
  wrapLegacyPassword,
  restoreLegacyPassword,
  passwordParameters,
  legacyPassword,
} from "../password.mjs";

test("browser Argon2 keeps the Go vector, encrypted verifier round-trips and rejects tampering", async () => {
  const secret = "ab".repeat(32);
  const legacy =
    "$argon2id$v=19$m=32768,t=2,p=1$MDEyMzQ1Njc4OWFiY2RlZg$A3W+APQ22i3uCifCT3RkV4zNYn7bSDZepRuL9Off/ao";
  const proof = await passwordProof("密码-test", legacyPassword(legacy).salt);
  const wrapped = await wrapLegacyPassword(legacy, secret);
  assert.equal(await restoreLegacyPassword(wrapped, secret), legacy);
  assert.equal(
    await restoreLegacyPassword(await storePassword(proof, secret), secret),
    legacy,
  );
  assert.ok(await verifyPassword(proof, wrapped, secret));
  assert.notEqual(wrapped, await storePassword(proof, secret));
  assert.ok(!wrapped.includes(legacyPassword(legacy).key));
  assert.ok(!wrapped.includes(proof.key));
  assert.equal(
    await verifyPassword({ ...proof, key: "00".repeat(32) }, wrapped, secret),
    false,
  );
  assert.equal(await verifyPassword(proof, wrapped, "cd".repeat(32)), false);
  assert.equal(
    await verifyPassword(
      proof,
      wrapped.slice(0, -1) + (wrapped.endsWith("A") ? "B" : "A"),
      secret,
    ),
    false,
  );
  assert.equal(
    await verifyPassword(proof, wrapped.replace("t=2", "t=1"), secret),
    false,
  );
  assert.deepEqual(passwordParameters(wrapped), {
    scheme: "client-argon2id-v1",
    salt: proof.salt,
    memory_kib: 32768,
    iterations: 2,
    parallelism: 1,
  });
  await assert.rejects(
    storePassword({ ...proof, memory_kib: 8 }, secret),
    /proof/,
  );
});

test("Free password endpoints reject plaintext and database verifier replay without issuing grants", async (t) => {
  const f = await fixture(t);
  await f.api("/api/v1/uploads", {
    method: "POST",
    body: { name: "test.bin", size: 1, password: "secret-password" },
    expected: 400,
  });
  const proof = await passwordProof("share-password");
  const share = await f.publish(7, { password_proof: proof });
  const row = await f.db
    .prepare("SELECT password_hash FROM shares WHERE id=?")
    .bind(share.id)
    .first();
  const locked = await (
    await f.api(`/api/v1/shares/${share.id}`, { admin: false, expected: 200 })
  ).json();
  assert.equal(locked.name, undefined);
  assert.equal(locked.password_kdf.salt, proof.salt);
  assert.ok(!JSON.stringify(locked).includes(row.password_hash));
  await f.api(`/api/v1/shares/${share.id}/unlock`, {
    admin: false,
    method: "POST",
    body: { password: "share-password" },
    expected: 401,
  });
  await f.api(`/api/v1/shares/${share.id}/unlock`, {
    admin: false,
    method: "POST",
    body: { password_proof: { ...proof, key: row.password_hash } },
    expected: 401,
  });
  assert.equal(
    (await f.db.prepare("SELECT count(*) AS n FROM share_grants").first()).n,
    0,
  );
  await f.api(`/api/v1/shares/${share.id}/unlock`, {
    admin: false,
    method: "POST",
    body: { password_proof: proof },
    expected: 200,
  });
});
