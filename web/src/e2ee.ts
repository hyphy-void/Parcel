import { sha256 } from "@noble/hashes/sha2.js";
import type { CryptoTask } from "./e2ee.tasks.ts";

/** Wire format v1. Only this descriptor, never FileContext, belongs in an API. */
export type FileEncryption = {
  version: 1;
  algorithm: "AES-256-GCM";
  file_id: string;
  plain_size: number;
  chunk_size: number;
  chunk_count: number;
  envelope: { salt: string; iv: string; ciphertext: string };
  password_kdf?: {
    scheme: "argon2id";
    salt: string;
    memory_kib: 32768;
    iterations: 2;
    parallelism: 1;
  };
};

/** Private, serializable client state. Never send this to Parcel or analytics. */
export type FileContext = {
  encryption: FileEncryption;
  linkSecret: string;
  metadata: {
    file_key: string;
    name: string;
    type: string;
    last_modified: number;
    sha256: string;
  };
  encryption_attempts: number;
};

export const E2EE_CHUNK_SIZE = 16 << 20;
export const E2EE_CHUNK_OVERHEAD = 28;
export const E2EE_MAX_CHUNKS = 10_000;
// A conservative per-client lifetime guard on random 96-bit GCM IV generation.
// Retries always create a fresh IV; a paused upload never reuses a cached nonce.
export const E2EE_MAX_ENCRYPTIONS = 1_000_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function error(message = "加密信息不正确，请重新打开完整分享链接"): never {
  throw new Error(message);
}

export function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unbase64url(value: string, length?: number): Uint8Array {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length > 16_384
  )
    return error();
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(
      atob(value.replace(/-/g, "+").replace(/_/g, "/")),
      (character) => character.charCodeAt(0),
    );
  } catch {
    return error();
  }
  if (
    base64url(bytes) !== value ||
    (length !== undefined && bytes.length !== length)
  )
    return error();
  return bytes;
}

function random(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

export function ciphertextSize(size: number): number {
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > E2EE_CHUNK_SIZE * E2EE_MAX_CHUNKS
  )
    return error("文件大小超出端到端加密支持范围");
  return (
    size + Math.max(1, Math.ceil(size / E2EE_CHUNK_SIZE)) * E2EE_CHUNK_OVERHEAD
  );
}

export function validateEncryption(value: unknown): FileEncryption {
  if (!value || typeof value !== "object") return error();
  const e = value as FileEncryption;
  if (
    e.version !== 1 ||
    e.algorithm !== "AES-256-GCM" ||
    e.chunk_size !== E2EE_CHUNK_SIZE ||
    e.chunk_count !== Math.max(1, Math.ceil(e.plain_size / E2EE_CHUNK_SIZE))
  )
    return error();
  ciphertextSize(e.plain_size);
  unbase64url(e.file_id, 16);
  if (!e.envelope || typeof e.envelope !== "object") return error();
  unbase64url(e.envelope.salt, 16);
  unbase64url(e.envelope.iv, 12);
  const ciphertext = unbase64url(e.envelope.ciphertext);
  if (ciphertext.length < 48 || ciphertext.length > 8192) return error();
  if (e.password_kdf !== undefined) {
    const k = e.password_kdf;
    if (
      !k ||
      k.scheme !== "argon2id" ||
      k.memory_kib !== 32768 ||
      k.iterations !== 2 ||
      k.parallelism !== 1
    )
      return error();
    unbase64url(k.salt, 16);
  }
  return e;
}

function immutable(e: FileEncryption): unknown[] {
  return [
    e.version,
    e.algorithm,
    e.file_id,
    e.plain_size,
    e.chunk_size,
    e.chunk_count,
  ];
}

function envelopeAAD(e: FileEncryption): Uint8Array {
  const k = e.password_kdf;
  return encoder.encode(
    JSON.stringify([
      "Parcel E2EE file envelope",
      ...immutable(e),
      k ? [k.scheme, k.salt, k.memory_kib, k.iterations, k.parallelism] : null,
    ]),
  );
}

export function plaintextPartLength(e: FileEncryption, index: number): number {
  if (!Number.isSafeInteger(index) || index < 0 || index >= e.chunk_count)
    return error("文件分块位置不正确");
  return Math.min(
    e.chunk_size,
    Math.max(0, e.plain_size - index * e.chunk_size),
  );
}

export function ciphertextPartLength(e: FileEncryption, index: number): number {
  return plaintextPartLength(e, index) + E2EE_CHUNK_OVERHEAD;
}

function chunkAAD(e: FileEncryption, index: number): Uint8Array {
  return encoder.encode(
    JSON.stringify([
      "Parcel E2EE file chunk",
      ...immutable(e),
      index,
      plaintextPartLength(e, index),
    ]),
  );
}

async function task(
  request: CryptoTask,
  onProgress: (fraction: number) => void = () => {},
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  if (typeof Worker === "undefined") {
    const { runCryptoTask } = await import("./e2ee.tasks.ts");
    return runCryptoTask(request, onProgress, signal);
  }
  const worker = new Worker(new URL("./e2ee.worker.ts", import.meta.url), {
    type: "module",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<Uint8Array>((resolve, reject) => {
      abort = () =>
        reject(signal?.reason || new DOMException("已取消", "AbortError"));
      signal?.addEventListener("abort", abort, { once: true });
      // Hashing a multi-GB file can take minutes; only password KDF has a deadline.
      if (request.kind === "argon2id")
        timer = setTimeout(
          () => reject(new Error("密码处理超时，请重试")),
          120_000,
        );
      worker.onmessage = (
        event: MessageEvent<{
          value?: Uint8Array;
          progress?: number;
          error?: string;
        }>,
      ) => {
        if (event.data.progress !== undefined) onProgress(event.data.progress);
        else if (event.data.value) resolve(event.data.value);
        else reject(new Error(event.data.error || "本地加密准备失败"));
      };
      worker.onerror = () =>
        reject(new Error("无法加载加密模块，请刷新后重试"));
      worker.postMessage(request);
    });
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
    worker.terminate();
  }
}

export async function hashFile(
  file: Blob,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const bytes = await task({ kind: "hash", file }, onProgress, signal);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function createPlaintextHasher() {
  const hash = sha256.create();
  return {
    update(bytes: Uint8Array) {
      hash.update(bytes);
    },
    digestHex() {
      return Array.from(hash.digest(), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    },
    destroy() {
      hash.destroy();
    },
  };
}

async function wrappingKey(
  e: FileEncryption,
  linkSecret: string,
  password: string,
): Promise<CryptoKey> {
  const link = unbase64url(linkSecret, 32);
  const input = new Uint8Array(e.password_kdf ? 64 : 32);
  input.set(link);
  link.fill(0);
  try {
    if (e.password_kdf) {
      if (!password) return error("请输入分享密码");
      if (encoder.encode(password).length > 256)
        return error("密码长度最多为 256 字节");
      // This salt and output never enter the server password_proof protocol.
      const derived = await task({
        kind: "argon2id",
        password,
        salt: unbase64url(e.password_kdf.salt, 16),
      });
      input.set(derived, 32);
      derived.fill(0);
    }
    const key = await crypto.subtle.importKey(
      "raw",
      buffer(input),
      "HKDF",
      false,
      ["deriveKey"],
    );
    return await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: buffer(unbase64url(e.envelope.salt, 16)),
        info: buffer(encoder.encode("Parcel E2EE wrapping key v1")),
      },
      key,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } finally {
    input.fill(0);
  }
}

function validateMetadata(value: unknown): FileContext["metadata"] {
  if (!value || typeof value !== "object") return error();
  const m = value as FileContext["metadata"];
  unbase64url(m.file_key, 32);
  if (
    typeof m.name !== "string" ||
    !m.name ||
    encoder.encode(m.name).length > 2048 ||
    /[\u0000-\u001f\u007f/\\]/.test(m.name) ||
    typeof m.type !== "string" ||
    m.type.length > 256 ||
    !Number.isSafeInteger(m.last_modified) ||
    m.last_modified < 0 ||
    typeof m.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(m.sha256)
  )
    return error();
  return m;
}

export function validateFileContext(value: unknown): FileContext {
  if (!value || typeof value !== "object") return error();
  const c = value as FileContext;
  validateEncryption(c.encryption);
  unbase64url(c.linkSecret, 32);
  validateMetadata(c.metadata);
  if (
    !Number.isSafeInteger(c.encryption_attempts) ||
    c.encryption_attempts < 0 ||
    c.encryption_attempts > E2EE_MAX_ENCRYPTIONS
  )
    return error();
  return c;
}

export async function changePassword(
  context: FileContext,
  password: string,
): Promise<FileContext> {
  validateMetadata(context.metadata);
  const encryption: FileEncryption = {
    ...context.encryption,
    envelope: {
      salt: base64url(random(16)),
      iv: base64url(random(12)),
      ciphertext: "",
    },
  };
  delete encryption.password_kdf;
  if (password) {
    encryption.password_kdf = {
      scheme: "argon2id",
      salt: base64url(random(16)),
      memory_kib: 32768,
      iterations: 2,
      parallelism: 1,
    };
  }
  const key = await wrappingKey(encryption, context.linkSecret, password);
  const plaintext = encoder.encode(JSON.stringify(context.metadata));
  try {
    encryption.envelope.ciphertext = base64url(
      new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: buffer(unbase64url(encryption.envelope.iv, 12)),
            additionalData: buffer(envelopeAAD(encryption)),
            tagLength: 128,
          },
          key,
          buffer(plaintext),
        ),
      ),
    );
    validateEncryption(encryption);
    return { ...context, encryption };
  } finally {
    plaintext.fill(0);
  }
}

export async function createFileContext(
  file: File,
  password = "",
  onHashProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<FileContext> {
  ciphertextSize(file.size);
  const metadata = {
    file_key: base64url(random(32)),
    name: file.name,
    type: file.type,
    last_modified: file.lastModified,
    sha256: await hashFile(file, onHashProgress, signal),
  };
  const context: FileContext = {
    encryption: {
      version: 1,
      algorithm: "AES-256-GCM",
      file_id: base64url(random(16)),
      plain_size: file.size,
      chunk_size: E2EE_CHUNK_SIZE,
      chunk_count: Math.max(1, Math.ceil(file.size / E2EE_CHUNK_SIZE)),
      envelope: { salt: "", iv: "", ciphertext: "" },
    },
    linkSecret: base64url(random(32)),
    metadata,
    encryption_attempts: 0,
  };
  signal?.throwIfAborted();
  return changePassword(context, password);
}

export async function unlockEnvelope(
  encryption: FileEncryption,
  linkSecret: string,
  password = "",
): Promise<FileContext> {
  validateEncryption(encryption);
  const key = await wrappingKey(encryption, linkSecret, password);
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: buffer(unbase64url(encryption.envelope.iv, 12)),
          additionalData: buffer(envelopeAAD(encryption)),
          tagLength: 128,
        },
        key,
        buffer(unbase64url(encryption.envelope.ciphertext)),
      ),
    );
    const metadata = validateMetadata(JSON.parse(decoder.decode(plaintext)));
    return { encryption, linkSecret, metadata, encryption_attempts: 0 };
  } catch {
    return error("分享密码或解密密钥不正确，或加密信息已损坏");
  } finally {
    plaintext?.fill(0);
  }
}

export async function verifyOriginalFile(
  file: File,
  context: FileContext,
  onHashProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  validateFileContext(context);
  if (
    file.size !== context.encryption.plain_size ||
    (await hashFile(file, onHashProgress, signal)) !== context.metadata.sha256
  )
    return error("所选文件与原上传文件内容不同，请选择原文件继续上传");
}

async function fileKey(context: FileContext): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    buffer(unbase64url(context.metadata.file_key, 32)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptFilePart(
  file: Blob,
  context: FileContext,
  index: number,
): Promise<Uint8Array<ArrayBuffer>> {
  validateFileContext(context);
  if (file.size !== context.encryption.plain_size)
    return error("所选文件大小不正确");
  if (context.encryption_attempts >= E2EE_MAX_ENCRYPTIONS)
    return error("此文件加密重试次数过多，请创建新的上传任务");
  const length = plaintextPartLength(context.encryption, index);
  context.encryption_attempts++;
  const iv = random(12);
  const start = index * context.encryption.chunk_size;
  const plaintext = new Uint8Array(
    await file.slice(start, start + length).arrayBuffer(),
  );
  try {
    const encrypted = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: buffer(iv),
        additionalData: buffer(chunkAAD(context.encryption, index)),
        tagLength: 128,
      },
      await fileKey(context),
      buffer(plaintext),
    );
    const out = new Uint8Array(iv.length + encrypted.byteLength);
    out.set(iv);
    out.set(new Uint8Array(encrypted), iv.length);
    return out;
  } finally {
    plaintext.fill(0);
  }
}

export async function decryptPart(
  ciphertext: Uint8Array,
  context: FileContext,
  index: number,
): Promise<Uint8Array<ArrayBuffer>> {
  validateFileContext(context);
  if (ciphertext.length !== ciphertextPartLength(context.encryption, index))
    return error("加密文件分块长度不正确，下载内容可能不完整");
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: buffer(ciphertext.subarray(0, 12)),
          additionalData: buffer(chunkAAD(context.encryption, index)),
          tagLength: 128,
        },
        await fileKey(context),
        buffer(ciphertext.subarray(12)),
      ),
    );
  } catch {
    return error("文件分块认证失败，内容可能被修改或来自其他文件");
  }
}

export function parseLinkSecret(hash: string): string | undefined {
  const match = /^#k=([A-Za-z0-9_-]{43})$/.exec(hash);
  if (!match) return undefined;
  try {
    unbase64url(match[1], 32);
    return match[1];
  } catch {
    return undefined;
  }
}

export function buildShareURL(
  url: string,
  context: FileContext | string,
): string {
  const secret = typeof context === "string" ? context : context.linkSecret;
  unbase64url(secret, 32);
  return `${url.split("#")[0]}#k=${secret}`;
}

type KeyBackup = {
  format: "parcel-e2ee-key-backup";
  version: 1;
  salt: string;
  iv: string;
  ciphertext: string;
};

async function backupKey(password: string, salt: string): Promise<CryptoKey> {
  if (
    encoder.encode(password).length < 12 ||
    encoder.encode(password).length > 256
  )
    return error("密钥备份密码需要 12 至 256 字节");
  const derived = await task({
    kind: "argon2id",
    password,
    salt: unbase64url(salt, 16),
  });
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      buffer(derived),
      "HKDF",
      false,
      ["deriveKey"],
    );
    return await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: buffer(unbase64url(salt, 16)),
        info: buffer(encoder.encode("Parcel E2EE encrypted key backup v1")),
      },
      key,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } finally {
    derived.fill(0);
  }
}

export async function exportFileContext(
  context: FileContext,
  password: string,
): Promise<string> {
  validateFileContext(context);
  const backup: KeyBackup = {
    format: "parcel-e2ee-key-backup",
    version: 1,
    salt: base64url(random(16)),
    iv: base64url(random(12)),
    ciphertext: "",
  };
  const plaintext = encoder.encode(JSON.stringify(context));
  try {
    backup.ciphertext = base64url(
      new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: buffer(unbase64url(backup.iv, 12)),
            additionalData: buffer(
              encoder.encode("Parcel E2EE encrypted key backup v1"),
            ),
            tagLength: 128,
          },
          await backupKey(password, backup.salt),
          buffer(plaintext),
        ),
      ),
    );
    return JSON.stringify(backup, null, 2);
  } finally {
    plaintext.fill(0);
  }
}

export async function importFileContext(
  json: string,
  password: string,
): Promise<FileContext> {
  if (json.length > 24_000) return error("密钥备份文件过大");
  let backup: KeyBackup;
  try {
    backup = JSON.parse(json);
  } catch {
    return error("无法识别密钥备份文件");
  }
  if (backup?.format !== "parcel-e2ee-key-backup" || backup.version !== 1)
    return error("无法识别密钥备份文件");
  unbase64url(backup.salt, 16);
  unbase64url(backup.iv, 12);
  const ciphertext = unbase64url(backup.ciphertext);
  const key = await backupKey(password, backup.salt);
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: buffer(unbase64url(backup.iv, 12)),
          additionalData: buffer(
            encoder.encode("Parcel E2EE encrypted key backup v1"),
          ),
          tagLength: 128,
        },
        key,
        buffer(ciphertext),
      ),
    );
    return validateFileContext(JSON.parse(decoder.decode(plaintext)));
  } catch {
    return error("备份密码不正确，或密钥备份已损坏");
  } finally {
    plaintext?.fill(0);
  }
}
