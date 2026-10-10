import { equal, hash, utf8 } from "./crypto.mjs";

export const PASSWORD_PROTOCOL = "client-argon2id-v1";
const profile = "$argon2id$v=19$m=32768,t=2,p=1$";
const prefix = "$parcel-a2$v=1$m=32768,t=2,p=1$";
const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/=+$/, "");
const decode = (value, length) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+$/.test(value))
    throw new Error("Invalid password verifier");
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  if (bytes.length !== length || b64(bytes) !== value)
    throw new Error("Invalid password verifier");
  return bytes;
};
export function legacyPassword(encoded) {
  if (typeof encoded !== "string" || !encoded.startsWith(profile))
    throw new Error("Unsupported Argon2id profile");
  const fields = encoded.slice(profile.length).split("$");
  if (fields.length !== 2) throw new Error("Invalid password verifier");
  decode(fields[0], 16);
  decode(fields[1], 32);
  return { salt: fields[0], key: fields[1] };
}
function sealed(encoded) {
  if (typeof encoded !== "string" || !encoded.startsWith(prefix))
    throw new Error("Password verifier needs migration");
  const fields = encoded.slice(prefix.length).split("$");
  if (fields.length !== 3) throw new Error("Invalid password verifier");
  decode(fields[0], 16);
  return {
    salt: fields[0],
    iv: decode(fields[1], 12),
    ciphertext: decode(fields[2], 48),
  };
}
export function passwordParameters(encoded) {
  if (!encoded) return undefined;
  const { salt } = sealed(encoded);
  return {
    scheme: PASSWORD_PROTOCOL,
    salt,
    memory_kib: 32768,
    iterations: 2,
    parallelism: 1,
  };
}
function proof(value) {
  if (
    !value ||
    value.scheme !== PASSWORD_PROTOCOL ||
    typeof value.key !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.key) ||
    Object.keys(value).some((k) => !["scheme", "salt", "key"].includes(k))
  )
    throw new Error("Invalid password proof");
  decode(value.salt, 16);
  return {
    salt: value.salt,
    key: Uint8Array.from(value.key.match(/../g), (v) => parseInt(v, 16)),
  };
}
// A separate domain-derived key encrypts only the salted Argon2 output, never
// the password. AES-GCM authenticates the complete KDF profile and salt.
let cachedSecret, cachedKey;
async function encryptionKey(secret) {
  if (typeof secret !== "string" || !/^[a-fA-F0-9]{64}$/.test(secret))
    throw new Error("Password verifier secret is required");
  if (secret !== cachedSecret) {
    cachedKey = crypto.subtle.importKey(
      "raw",
      Uint8Array.from(
        (await hash(`parcel-v3-password-encryption-v1\n${secret}`)).match(
          /../g,
        ),
        (v) => parseInt(v, 16),
      ),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    cachedSecret = secret;
  }
  return cachedKey;
}
const aad = (salt) => utf8(prefix + salt);
async function seal(salt, key, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad(salt) },
      await encryptionKey(secret),
      key,
    ),
  );
  return `${prefix}${salt}$${b64(iv)}$${b64(ciphertext)}`;
}
export async function storePassword(value, secret) {
  const p = proof(value);
  try {
    return await seal(p.salt, p.key, secret);
  } finally {
    p.key.fill(0);
  }
}
export async function wrapLegacyPassword(encoded, secret) {
  if (!encoded) return "";
  if (encoded.startsWith(prefix)) {
    await restoreLegacyPassword(encoded, secret);
    return encoded;
  }
  const p = legacyPassword(encoded),
    key = decode(p.key, 32);
  try {
    return await seal(p.salt, key, secret);
  } finally {
    key.fill(0);
  }
}
export async function restoreLegacyPassword(encoded, secret) {
  if (!encoded) return "";
  if (encoded.startsWith(profile)) {
    legacyPassword(encoded);
    return encoded;
  }
  const p = sealed(encoded);
  const key = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: p.iv, additionalData: aad(p.salt) },
      await encryptionKey(secret),
      p.ciphertext,
    ),
  );
  try {
    return profile + p.salt + "$" + b64(key);
  } finally {
    key.fill(0);
  }
}
export async function verifyPassword(value, encoded, secret) {
  try {
    const p = proof(value),
      stored = sealed(encoded);
    let expected;
    try {
      if (!equal(p.salt, stored.salt)) return false;
      expected = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: stored.iv, additionalData: aad(stored.salt) },
          await encryptionKey(secret),
          stored.ciphertext,
        ),
      );
      return equal(b64(p.key), b64(expected));
    } finally {
      p.key.fill(0);
      expected?.fill(0);
    }
  } catch {
    return false;
  }
}
