import { argon2idAsync } from "@noble/hashes/argon2.js";

self.onmessage = async (
  event: MessageEvent<{ password: string; salt: string }>,
) => {
  const { password, salt } = event.data;
  const input = new TextEncoder().encode(password);
  try {
    const key = await argon2idAsync(
      input,
      Uint8Array.from(atob(salt), (c) => c.charCodeAt(0)),
      { m: 32768, t: 2, p: 1, dkLen: 32, maxmem: 80 << 20, asyncTick: 10 },
    );
    self.postMessage({
      key: Array.from(key, (b) => b.toString(16).padStart(2, "0")).join(""),
    });
    key.fill(0);
  } catch {
    self.postMessage({ error: "密码处理失败，请重试" });
  } finally {
    input.fill(0);
  }
};
