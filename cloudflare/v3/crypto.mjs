import { argon2idAsync } from "@noble/hashes/argon2.js";

const encoder = new TextEncoder();
export const utf8 = (s) => encoder.encode(s);
export const hex = (bytes) =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
export const hash = async (s) =>
  hex(
    await crypto.subtle.digest("SHA-256", typeof s === "string" ? utf8(s) : s),
  );
export function token() {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}
export async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, utf8(value)));
}
export function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length)
    return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++)
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
const b64 = (value) => btoa(String.fromCharCode(...value)).replace(/=+$/, "");
const unb64 = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
// One Argon2 operation per isolate prevents concurrent requests multiplying the
// 32 MiB working set. This is a memory bound, not the distributed rate limiter.
let hashing = false;
async function derive(password, salt, opts) {
  if (hashing)
    throw Object.assign(new Error("密码处理繁忙，请稍后重试"), {
      status: 503,
      code: "busy",
    });
  hashing = true;
  try {
    return await argon2idAsync(utf8(password), salt, {
      ...opts,
      dkLen: 32,
      maxmem: 80 << 20,
      asyncTick: 10,
    });
  } finally {
    hashing = false;
  }
}
export async function hashPassword(password) {
  const length = typeof password === "string" ? utf8(password).length : 0;
  if (length < 4 || length > 256)
    throw Object.assign(new Error("密码长度应为 4–256 字节"), {
      status: 400,
      code: "invalid_password",
    });
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await derive(password, salt, { m: 32768, t: 2, p: 1 });
  return `$argon2id$v=19$m=32768,t=2,p=1$${b64(salt)}$${b64(key)}`;
}
export async function verifyPassword(password, encoded) {
  if (typeof password !== "string" || utf8(password).length > 256) return false;
  const match =
    /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(
      encoded,
    );
  if (!match) return false;
  const [m, t, p] = match.slice(1, 4).map(Number);
  if (m < 8 || m > 65536 || t < 1 || t > 5 || p < 1 || p > 4) return false;
  let salt, key;
  try {
    salt = unb64(match[4]);
    key = unb64(match[5]);
  } catch {
    return false;
  }
  if (salt.length !== 16 || key.length !== 32) return false;
  return equal(hex(await derive(password, salt, { m, t, p })), hex(key));
}
