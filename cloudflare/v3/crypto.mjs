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
let hmacSecret, hmacKey;
export async function hmac(secret, value) {
  if (secret !== hmacSecret) {
    hmacKey = crypto.subtle.importKey(
      "raw",
      utf8(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    hmacSecret = secret;
  }
  const key = await hmacKey;
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
