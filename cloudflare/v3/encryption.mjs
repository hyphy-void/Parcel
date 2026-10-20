// Public protocol validation only. File keys, link secrets, decrypted metadata,
// and password-derived wrapping keys must never be sent to this service.
export const E2EE_CHUNK_BYTES = 16 << 20;
export const E2EE_OVERHEAD_BYTES = 28; // 12-byte IV + 16-byte GCM tag
export const E2EE_PART_BYTES = E2EE_CHUNK_BYTES + E2EE_OVERHEAD_BYTES;
const object = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));
function bytes(value, min, max = min) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value))
    return false;
  try {
    const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return (
      decoded.length >= min &&
      decoded.length <= max &&
      btoa(decoded)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "") === value
    );
  } catch {
    return false;
  }
}
export function validateEncryption(value, plainSize) {
  if (
    !object(value, [
      "version",
      "algorithm",
      "file_id",
      "plain_size",
      "chunk_size",
      "chunk_count",
      "envelope",
      "password_kdf",
    ]) ||
    value.version !== 1 ||
    value.algorithm !== "AES-256-GCM" ||
    !bytes(value.file_id, 16) ||
    !Number.isSafeInteger(plainSize) ||
    plainSize < 0 ||
    value.plain_size !== plainSize ||
    value.chunk_size !== E2EE_CHUNK_BYTES ||
    value.chunk_count !==
      Math.max(1, Math.ceil(plainSize / E2EE_CHUNK_BYTES)) ||
    value.chunk_count > 10000 ||
    !object(value.envelope, ["salt", "iv", "ciphertext"]) ||
    !bytes(value.envelope.salt, 16) ||
    !bytes(value.envelope.iv, 12) ||
    !bytes(value.envelope.ciphertext, 48, 8192)
  )
    throw new Error("Invalid end-to-end encryption manifest");
  if (value.password_kdf !== undefined) {
    const kdf = value.password_kdf;
    if (
      !object(kdf, [
        "scheme",
        "salt",
        "memory_kib",
        "iterations",
        "parallelism",
      ]) ||
      kdf.scheme !== "argon2id" ||
      !bytes(kdf.salt, 16) ||
      kdf.memory_kib !== 32768 ||
      kdf.iterations !== 2 ||
      kdf.parallelism !== 1
    )
      throw new Error("Invalid end-to-end encryption password KDF");
  }
  const storedSize = plainSize + E2EE_OVERHEAD_BYTES * value.chunk_count;
  if (!Number.isSafeInteger(storedSize))
    throw new Error("Invalid encrypted size");
  return { encryption: JSON.parse(JSON.stringify(value)), storedSize };
}
export function storedEncryption(row) {
  if (!row.encryption) return null;
  try {
    const parsed = JSON.parse(row.encryption);
    return validateEncryption(parsed, row.plaintext_size).storedSize ===
      row.size
      ? parsed
      : null;
  } catch {
    return null;
  }
}
export function sameFileEncryption(a, b) {
  return [
    "version",
    "algorithm",
    "file_id",
    "plain_size",
    "chunk_size",
    "chunk_count",
  ].every((key) => a[key] === b[key]);
}
