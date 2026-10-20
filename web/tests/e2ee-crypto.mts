import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  E2EE_CHUNK_SIZE,
  E2EE_MAX_ENCRYPTIONS,
  base64url,
  buildShareURL,
  changePassword,
  ciphertextPartLength,
  ciphertextSize,
  createFileContext,
  createPlaintextHasher,
  decryptPart,
  encryptFilePart,
  exportFileContext,
  hashFile,
  importFileContext,
  parseLinkSecret,
  unbase64url,
  unlockEnvelope,
  validateEncryption,
  verifyOriginalFile,
  type FileContext,
} from "../src/e2ee.ts";

function file(bytes: Uint8Array | string, name = "private report.txt") {
  return new File([bytes], name, { type: "text/plain", lastModified: 1000 });
}

function copied<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

test("envelope keeps filename, SHA256 and independent file/link keys off wire", async () => {
  const original = file("The service must not receive this plaintext.");
  const c = await createFileContext(original);
  const wire = JSON.stringify(c.encryption);
  assert.ok(!wire.includes(original.name));
  assert.ok(!wire.includes(c.metadata.file_key));
  assert.ok(!wire.includes(c.linkSecret));
  assert.ok(!wire.includes(c.metadata.sha256));
  const fresh = await unlockEnvelope(copied(c.encryption), c.linkSecret);
  assert.deepEqual(fresh.metadata, c.metadata);
  const encrypted = await encryptFilePart(original, c, 0);
  assert.equal(encrypted.length, original.size + 28);
  assert.notEqual(Buffer.from(encrypted).toString(), await original.text());
  assert.equal(
    new TextDecoder().decode(await decryptPart(encrypted, fresh, 0)),
    await original.text(),
  );
  assert.equal(c.encryption_attempts, 1);
});

test("password is required cryptographically and has separate salts from proofs", async () => {
  const c = await createFileContext(file("secret"), "sample sharing password");
  assert.equal(c.encryption.password_kdf?.scheme, "argon2id");
  assert.notEqual(c.encryption.password_kdf?.salt, c.encryption.envelope.salt);
  await assert.rejects(() => unlockEnvelope(c.encryption, c.linkSecret));
  await assert.rejects(() =>
    unlockEnvelope(c.encryption, c.linkSecret, "wrong password"),
  );
  await assert.rejects(() =>
    unlockEnvelope(
      c.encryption,
      base64url(crypto.getRandomValues(new Uint8Array(32))),
      "sample sharing password",
    ),
  );
  assert.deepEqual(
    (
      await unlockEnvelope(
        c.encryption,
        c.linkSecret,
        "sample sharing password",
      )
    ).metadata,
    c.metadata,
  );
  // A 32-byte value transmitted by the independent server proof protocol cannot
  // substitute for this KDF's password input, even when represented as hex.
  await assert.rejects(() =>
    unlockEnvelope(c.encryption, c.linkSecret, "a".repeat(64)),
  );
});

test("rewrapping changes password without changing file DEK or encrypted object", async () => {
  const original = file("same encrypted bytes after password change");
  const c = await createFileContext(original, "first secret");
  const ciphertext = await encryptFilePart(original, c, 0);
  const changed = await changePassword(c, "second secret");
  assert.equal(changed.metadata.file_key, c.metadata.file_key);
  assert.equal(changed.linkSecret, c.linkSecret);
  assert.notDeepEqual(changed.encryption.envelope, c.encryption.envelope);
  assert.notEqual(
    changed.encryption.password_kdf?.salt,
    c.encryption.password_kdf?.salt,
  );
  await assert.rejects(() =>
    unlockEnvelope(changed.encryption, c.linkSecret, "first secret"),
  );
  const reopened = await unlockEnvelope(
    changed.encryption,
    c.linkSecret,
    "second secret",
  );
  assert.equal(
    new TextDecoder().decode(await decryptPart(ciphertext, reopened, 0)),
    await original.text(),
  );
  const removed = await changePassword(changed, "");
  assert.equal(removed.encryption.password_kdf, undefined);
  assert.deepEqual(
    (await unlockEnvelope(removed.encryption, removed.linkSecret)).metadata,
    c.metadata,
  );
});

test("chunk layout authenticates full and partial chunks, order and file identity", async () => {
  const source = new Uint8Array(E2EE_CHUNK_SIZE * 2 + 17);
  source[0] = 12;
  source[E2EE_CHUNK_SIZE] = 34;
  source[source.length - 1] = 56;
  const original = file(source);
  const c = await createFileContext(original);
  assert.equal(c.encryption.chunk_count, 3);
  assert.equal(ciphertextSize(source.length), source.length + 84);
  const chunks = [];
  const hash = createPlaintextHasher();
  for (let i = 0; i < 3; i++) {
    const encrypted = await encryptFilePart(original, c, i);
    chunks.push(encrypted);
    assert.equal(encrypted.length, ciphertextPartLength(c.encryption, i));
    const clear = await decryptPart(encrypted, c, i);
    hash.update(clear);
    assert.deepEqual(
      clear,
      source.subarray(i * E2EE_CHUNK_SIZE, (i + 1) * E2EE_CHUNK_SIZE),
    );
  }
  assert.equal(hash.digestHex(), c.metadata.sha256);
  await assert.rejects(() => decryptPart(chunks[0], c, 1));
  await assert.rejects(() =>
    decryptPart(chunks[0].subarray(0, chunks[0].length - 1), c, 0),
  );
  const wrongId = copied(c);
  wrongId.encryption.file_id = base64url(
    crypto.getRandomValues(new Uint8Array(16)),
  );
  await assert.rejects(() => decryptPart(chunks[0], wrongId, 0));
  const wrongLength = copied(c);
  wrongLength.encryption.plain_size--;
  await assert.rejects(() => decryptPart(chunks[0], wrongLength, 0));
  const flipped = chunks[0].slice();
  flipped[12] ^= 1;
  await assert.rejects(() => decryptPart(flipped, c, 0));
});

test("empty file and exact chunk boundary have unambiguous authenticated layout", async () => {
  for (const size of [0, E2EE_CHUNK_SIZE]) {
    const f = file(new Uint8Array(size));
    const c = await createFileContext(f);
    assert.equal(c.encryption.chunk_count, 1);
    assert.equal(ciphertextSize(size), size + 28);
    const encrypted = await encryptFilePart(f, c, 0);
    assert.equal((await decryptPart(encrypted, c, 0)).length, size);
    await assert.rejects(() => encryptFilePart(f, c, 1));
  }
});

test("retries use fresh IVs and resume verifies the whole file rather than samples", async () => {
  const source = new Uint8Array(9 << 20);
  source[0] = 1;
  const f = file(source);
  const c = await createFileContext(f);
  const first = await encryptFilePart(f, c, 0);
  const retry = await encryptFilePart(f, c, 0);
  assert.notDeepEqual(first.subarray(0, 12), retry.subarray(0, 12));
  assert.deepEqual(
    await decryptPart(first, c, 0),
    await decryptPart(retry, c, 0),
  );
  const saved = copied(c) as FileContext;
  await verifyOriginalFile(f, saved);
  source[4 << 20] = 2;
  await assert.rejects(
    () => verifyOriginalFile(file(source), saved),
    /原上传文件内容不同/,
  );
  const exhausted = { ...c, encryption_attempts: E2EE_MAX_ENCRYPTIONS };
  await assert.rejects(() => encryptFilePart(f, exhausted, 0), /重试次数过多/);
});

test("envelope authentication binds immutable layout and password parameters", async () => {
  const c = await createFileContext(
    file("manifest authentication"),
    "password",
  );
  for (const mutate of [
    (e: typeof c.encryption) => {
      e.file_id = base64url(crypto.getRandomValues(new Uint8Array(16)));
    },
    (e: typeof c.encryption) => {
      e.plain_size++;
    },
    (e: typeof c.encryption) => {
      delete e.password_kdf;
    },
    (e: typeof c.encryption) => {
      e.envelope.salt = base64url(crypto.getRandomValues(new Uint8Array(16)));
    },
    (e: typeof c.encryption) => {
      e.envelope.iv = base64url(crypto.getRandomValues(new Uint8Array(12)));
    },
  ]) {
    const altered = copied(c.encryption);
    mutate(altered);
    await assert.rejects(() =>
      unlockEnvelope(altered, c.linkSecret, "password"),
    );
  }
  const hugeKDF = copied(c.encryption);
  hugeKDF.password_kdf!.memory_kib = 1 as 32768;
  assert.throws(() => validateEncryption(hugeKDF));
});

test("URL fragment helpers require a complete canonical 32-byte secret", () => {
  const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const url = buildShareURL("https://example.test/s/publicid", secret);
  assert.equal(new URL(url).hash, `#k=${secret}`);
  assert.equal(new URL(url).pathname, "/s/publicid");
  assert.equal(parseLinkSecret(new URL(url).hash), secret);
  assert.equal(parseLinkSecret(`#k=${secret}&extra=1`), undefined);
  assert.equal(parseLinkSecret(`#${secret}`), undefined);
  assert.equal(parseLinkSecret("#k=missing"), undefined);
  assert.throws(() => unbase64url(`${secret}=`));
  assert.throws(() => ciphertextSize(-1));
  assert.throws(() => ciphertextSize(2 ** 53));
});

test("encrypted key backups recover contexts without plaintext secrets in export", async () => {
  const c = await createFileContext(
    file("recoverable secret"),
    "share password",
  );
  const exported = await exportFileContext(c, "long backup passphrase");
  assert.ok(!exported.includes(c.linkSecret));
  assert.ok(!exported.includes(c.metadata.file_key));
  assert.ok(!exported.includes(c.metadata.name));
  assert.deepEqual(
    await importFileContext(exported, "long backup passphrase"),
    c,
  );
  await assert.rejects(() =>
    importFileContext(exported, "incorrect passphrase"),
  );
  await assert.rejects(() => exportFileContext(c, "short"));
  const tampered = JSON.parse(exported);
  const data = unbase64url(tampered.ciphertext);
  data[20] ^= 1;
  tampered.ciphertext = base64url(data);
  await assert.rejects(() =>
    importFileContext(JSON.stringify(tampered), "long backup passphrase"),
  );
});

test("hashing agrees with independent SHA256 and honors cancellation", async () => {
  const source = new Uint8Array(10 << 20).fill(17);
  const progress: number[] = [];
  assert.equal(
    await hashFile(file(source), (value) => progress.push(value)),
    createHash("sha256").update(source).digest("hex"),
  );
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.length > 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => hashFile(file(source), undefined, controller.signal),
    /abort/i,
  );
});
