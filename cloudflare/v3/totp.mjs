import { equal, hash, hex, utf8 } from "./crypto.mjs";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function generateSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let bits = 0,
    value = 0,
    result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(value >>> bits) & 31];
    }
  }
  return result;
}
function decode(secret) {
  if (!/^[A-Z2-7]+$/.test(secret)) throw new Error("Invalid TOTP secret");
  let bits = 0,
    value = 0;
  const bytes = [];
  for (const c of secret) {
    value = (value << 5) | alphabet.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  return new Uint8Array(bytes);
}
// RFC 6238: SHA-1, 30-second steps and six digits for authenticator compatibility.
export async function totp(secret, step, digits = 6) {
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(step));
  const key = await crypto.subtle.importKey(
    "raw",
    decode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = mac[mac.length - 1] & 15;
  const number = new DataView(mac.buffer).getUint32(offset) & 0x7fffffff;
  return String(number % 10 ** digits).padStart(digits, "0");
}
export async function matchTotp(secret, code, now, lastStep = -1) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return -1;
  const current = Math.floor(now / 30);
  let matched = -1;
  for (const step of [current - 1, current, current + 1]) {
    if (step > lastStep && equal(await totp(secret, step), code))
      matched = step;
  }
  return matched;
}

// Separate encryption domain from share passwords and all session MACs.
async function key(secret) {
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from(
      (await hash(`parcel-v3-admin-totp-encryption-v1\n${secret}`)).match(
        /../g,
      ),
      (b) => parseInt(b, 16),
    ),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export async function sealSecret(secret, sessionSecret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8("parcel-admin-totp-v1") },
    await key(sessionSecret),
    utf8(secret),
  );
  return `v1.${b64(iv)}.${b64(encrypted)}`;
}
export async function openSecret(encoded, sessionSecret) {
  const [version, iv, encrypted] = encoded.split(".");
  if (version !== "v1") throw new Error("Invalid TOTP envelope");
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: unb64(iv),
        additionalData: utf8("parcel-admin-totp-v1"),
      },
      await key(sessionSecret),
      unb64(encrypted),
    ),
  );
}
export function recoveryCodes() {
  return Array.from({ length: 8 }, () =>
    hex(crypto.getRandomValues(new Uint8Array(16)))
      .match(/.{8}/g)
      .join("-"),
  );
}
