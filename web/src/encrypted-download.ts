import { type DownloadTicket, sleep } from "./api";
import {
  type FileContext,
  ciphertextPartLength,
  ciphertextSize,
  createPlaintextHasher,
  decryptPart,
} from "./e2ee";
import {
  cacheChunk,
  cachedChunk,
  localRecord,
  requireDownloadSpace,
  saveLocalRecord,
} from "./transfer-storage";

async function readCiphertext(
  response: Response,
  length: number,
): Promise<ArrayBuffer> {
  if (!response.body) throw new Error("加密块响应没有内容。");
  const bytes = new Uint8Array(length);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (offset + next.value.byteLength > length)
        throw new Error("加密块超出预期长度，已停止传输。");
      bytes.set(next.value, offset);
      offset += next.value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (offset !== length) throw new Error("加密块传输不完整，请继续下载。");
  return bytes.buffer;
}

export type DownloadState = { completedParts: number; received: number };
export function cacheID(context: FileContext): string {
  return context.encryption.file_id;
}
export async function downloadState(
  context: FileContext,
): Promise<DownloadState> {
  return (
    (await localRecord<DownloadState>(`download:${cacheID(context)}`)) || {
      completedParts: 0,
      received: 0,
    }
  );
}
export async function prepareDownloadSaving(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  await navigator.serviceWorker.register("/parcel-download-sw.js", {
    scope: "/",
  });
  const registration = await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        navigator.serviceWorker.removeEventListener("controllerchange", ready);
        reject(new Error("安全保存模块尚未就绪，请刷新分享页后重试。"));
      }, 15_000);
      function ready() {
        if (!navigator.serviceWorker.controller) return;
        clearTimeout(timeout);
        navigator.serviceWorker.removeEventListener("controllerchange", ready);
        resolve();
      }
      navigator.serviceWorker.addEventListener("controllerchange", ready);
      // Claim can race the listener registration.
      if (navigator.serviceWorker.controller) ready();
      else registration.active?.postMessage({ type: "parcel-claim" });
    });
  }
}
export async function stageEncryptedDownload(
  context: FileContext,
  ticket: (refresh: boolean) => Promise<DownloadTicket>,
  onProgress: (state: DownloadState) => void,
  signal: AbortSignal,
): Promise<DownloadState> {
  const encryption = context.encryption;
  const id = cacheID(context);
  const state = await downloadState(context);
  const total = ciphertextSize(encryption.plain_size);
  await requireDownloadSpace(Math.max(0, total - state.received));
  let activeTicket: DownloadTicket | undefined;
  let received = 0;
  for (let index = 0; index < encryption.chunk_count; index++) {
    signal.throwIfAborted();
    let data = await cachedChunk(id, index);
    if (!data) {
      const length = ciphertextPartLength(encryption, index);
      const start = index * (encryption.chunk_size + 28);
      let lastError: unknown;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          if (!activeTicket || activeTicket.expires <= Date.now() / 1000 + 30)
            activeTicket = await ticket(!!activeTicket);
          const response = await fetch(activeTicket.url, {
            headers: { Range: `bytes=${start}-${start + length - 1}` },
            credentials: "omit",
            referrerPolicy: "no-referrer",
            signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
          });
          if ([401, 403].includes(response.status)) {
            await response.body?.cancel();
            activeTicket = await ticket(true);
            throw new Error("下载地址已续签，正在重试当前加密块。");
          }
          const range = response.headers.get("Content-Range");
          const expectedRange = `bytes ${start}-${start + length - 1}/${total}`;
          if (
            (response.status !== 206 || range !== expectedRange) &&
            !(response.status === 200 && start === 0 && length === total)
          ) {
            await response.body?.cancel();
            throw new Error(
              "存储服务未返回正确的加密块范围，已停止下载以避免损坏文件。",
            );
          }
          if (
            response.headers.has("Content-Length") &&
            Number(response.headers.get("Content-Length")) !== length
          ) {
            await response.body?.cancel();
            throw new Error("加密块长度不正确。");
          }
          data = await readCiphertext(response, length);
          // Authenticate before persisting. Saving authenticates again, so a
          // corrupted or externally changed local cache cannot corrupt output.
          await decryptPart(new Uint8Array(data), context, index);
          await cacheChunk(id, index, new Uint8Array(data));
          break;
        } catch (error) {
          signal.throwIfAborted();
          lastError = error;
          if (attempt === 3) throw error;
          await sleep(500 * 2 ** attempt);
        }
      }
      if (!data) throw lastError || new Error("加密块下载失败。");
    }
    if (data.byteLength !== ciphertextPartLength(encryption, index))
      throw new Error("本机密文缓存已损坏，请清除本机续传缓存后重试。");
    received += data.byteLength;
    const next = { completedParts: index + 1, received };
    await saveLocalRecord(`download:${id}`, next);
    onProgress(next);
  }
  return { completedParts: encryption.chunk_count, received };
}

async function* plaintextParts(
  context: FileContext,
  onProgress: (bytes: number) => void,
  signal: AbortSignal,
) {
  const hasher = createPlaintextHasher();
  let bytes = 0;
  for (let index = 0; index < context.encryption.chunk_count; index++) {
    signal.throwIfAborted();
    const ciphertext = await cachedChunk(cacheID(context), index);
    if (!ciphertext)
      throw new Error("本机续传缓存缺少加密块，请继续下载后再保存。");
    const plaintext = await decryptPart(
      new Uint8Array(ciphertext),
      context,
      index,
    );
    hasher.update(plaintext);
    bytes += plaintext.byteLength;
    // Verify the authenticated whole-file hash before the last part is handed
    // to a sink; an integrity failure never produces a completed saved file.
    if (
      index === context.encryption.chunk_count - 1 &&
      hasher.digestHex() !== context.metadata.sha256
    )
      throw new Error("文件完整性校验失败，已停止保存。请清除缓存后重试。");
    yield plaintext;
    onProgress(bytes);
  }
}

type SaveFileHandle = {
  createWritable(): Promise<{
    write(value: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }>;
};
export function nativeSaveAvailable(): boolean {
  return (
    typeof (window as unknown as { showSaveFilePicker?: unknown })
      .showSaveFilePicker === "function"
  );
}
export async function saveDecryptedDownload(
  context: FileContext,
  onProgress: (bytes: number) => void,
  signal: AbortSignal,
): Promise<void> {
  if (context.encryption.plain_size === 0) {
    for await (const _part of plaintextParts(context, onProgress, signal)) {
      /* Authenticate the sole empty chunk. */
    }
    const url = URL.createObjectURL(
      new Blob([], { type: "application/octet-stream" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = context.metadata.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return;
  }
  const picker = (
    window as unknown as {
      showSaveFilePicker?: (options: {
        suggestedName: string;
      }) => Promise<SaveFileHandle>;
    }
  ).showSaveFilePicker;
  if (picker) {
    // Called before the first await so the picker retains the button gesture.
    const handle = await picker({ suggestedName: context.metadata.name });
    const writer = await handle.createWritable();
    try {
      for await (const part of plaintextParts(context, onProgress, signal))
        await writer.write(part);
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => {});
      throw error;
    }
    return;
  }
  if (!("serviceWorker" in navigator))
    throw new Error(
      "此浏览器无法流式保存大文件，请使用支持 Service Worker 的最新版浏览器。",
    );
  await prepareDownloadSaving();
  const worker = navigator.serviceWorker.controller;
  if (!worker)
    throw new Error(
      "此浏览器无法启动安全流式保存，请使用最新版 Chrome、Edge、Firefox 或 Safari。",
    );
  const channel = new MessageChannel();
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
  const iterator = plaintextParts(context, onProgress, signal);
  await new Promise<void>((resolve, reject) => {
    let started = false;
    let consuming = false;
    let sentBytes = 0;
    let ending = false;
    const timeout = setTimeout(
      () => finish(new Error("浏览器未启动保存，请允许此网站下载文件后重试。")),
      60_000,
    );
    function finish(error?: Error) {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      channel.port1.close();
      if (error) reject(error);
      else resolve();
    }
    function abort() {
      channel.port1.postMessage({ type: "error", message: "保存已取消" });
      finish(new DOMException("保存已取消", "AbortError"));
    }
    signal.addEventListener("abort", abort, { once: true });
    channel.port1.onmessage = async ({ data }) => {
      if (data.type === "ready" && !started) {
        started = true;
        const frame = document.createElement("iframe");
        // An explicit `download` attribute bypasses Service Worker fetch in
        // Chromium. A same-origin frame navigation reaches the worker and
        // avoids triggering this page's active-transfer leave warning.
        // Keep the frame until the page closes, so detachment cannot cancel a
        // browser download that is still flushing its final bytes to disk.
        frame.src = `/__parcel_download/${token}`;
        frame.hidden = true;
        frame.title = "安全流式保存";
        document.body.append(frame);
      } else if (data.type === "pull" && !consuming && !ending) {
        clearTimeout(timeout);
        consuming = true;
        try {
          signal.throwIfAborted();
          const next = await iterator.next();
          if (next.done) {
            ending = true;
            channel.port1.postMessage({ type: "end" });
          } else {
            const buffer = next.value.buffer.slice(
              next.value.byteOffset,
              next.value.byteOffset + next.value.byteLength,
            );
            channel.port1.postMessage({ type: "chunk", buffer }, [buffer]);
            sentBytes += next.value.byteLength;
            // A browser can finish as soon as Content-Length bytes arrive.
            // Close explicitly with the last chunk instead of relying on one
            // extra pull after the advertised file length has been delivered.
            if (sentBytes === context.encryption.plain_size) {
              ending = true;
              const end = await iterator.next();
              if (!end.done) throw new Error("解密后的文件长度不正确。");
              channel.port1.postMessage({ type: "end" });
            }
          }
        } catch (error) {
          channel.port1.postMessage({
            type: "error",
            message: (error as Error).message,
          });
          finish(error as Error);
        } finally {
          consuming = false;
        }
      } else if (data.type === "saved") finish();
      else if (data.type === "cancel")
        finish(
          new DOMException(
            "浏览器已取消保存，密文续传缓存仍保留。",
            "AbortError",
          ),
        );
      else if (data.type === "error") finish(new Error(data.message));
    };
    worker.postMessage(
      {
        type: "parcel-save",
        token,
        size: context.encryption.plain_size,
        name: context.metadata.name,
      },
      [channel.port2],
    );
  });
}
