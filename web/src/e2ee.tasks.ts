import { argon2idAsync } from "@noble/hashes/argon2.js";
import { sha256 } from "@noble/hashes/sha2.js";

export type CryptoTask =
  | { kind: "hash"; file: Blob }
  | { kind: "argon2id"; password: string; salt: Uint8Array };

// File reads are bounded independently of the file size. This same implementation
// runs in the dedicated browser worker and in the Node protocol tests.
export async function runCryptoTask(
  task: CryptoTask,
  progress: (fraction: number) => void = () => {},
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (task.kind === "argon2id") {
    const input = new TextEncoder().encode(task.password);
    try {
      return await argon2idAsync(input, task.salt, {
        m: 32768,
        t: 2,
        p: 1,
        dkLen: 32,
        maxmem: 80 << 20,
        asyncTick: 10,
      });
    } finally {
      input.fill(0);
    }
  }
  const hash = sha256.create();
  try {
    const step = 4 << 20;
    for (let offset = 0; offset < task.file.size; offset += step) {
      signal?.throwIfAborted();
      const bytes = new Uint8Array(
        await task.file.slice(offset, offset + step).arrayBuffer(),
      );
      hash.update(bytes);
      bytes.fill(0);
      progress(Math.min(1, (offset + step) / task.file.size));
    }
    signal?.throwIfAborted();
    progress(1);
    return hash.digest();
  } catch (error) {
    hash.destroy();
    throw error;
  }
}
