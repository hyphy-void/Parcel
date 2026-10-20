// Browser-only state. File keys and ciphertext never leave this origin through
// this module. Ciphertext is staged on disk so download recovery is independent
// of the browser's download manager and never builds a whole-file Blob.
const databaseName = "parcel-e2ee-v1";
let database: Promise<IDBDatabase> | undefined;
let persistenceRequested = false;
function open(): Promise<IDBDatabase> {
  return (database ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("records");
      request.result.createObjectStore("chunks");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error("无法打开本机续传存储。请允许网站存储后重试。"));
    request.onblocked = () =>
      reject(
        new Error(
          "本机存储升级被另一标签页阻止，请关闭其他 Parcel 页面后重试。",
        ),
      );
  }));
}
export async function localRecord<T>(key: string): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction("records").objectStore("records").get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}
export async function saveLocalRecord(
  key: string,
  value: unknown,
): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("records", "readwrite");
    tx.objectStore("records").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () =>
      reject(tx.error || new Error("本机续传记录保存失败"));
  });
}
/** One atomic choice across tabs, before any network admission is attempted. */
export async function localRecordOrCreate<T>(
  key: string,
  value: T,
): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("records", "readwrite");
    const store = tx.objectStore("records");
    const request = store.get(key);
    let result = value;
    request.onsuccess = () => {
      if (request.result === undefined) store.put(value, key);
      else result = request.result as T;
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () =>
      reject(tx.error || new Error("无法保存本机下载会话标识。"));
  });
}
export async function deleteLocalRecord(key: string): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("records", "readwrite");
    tx.objectStore("records").delete(key);
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}
export async function cachedChunk(
  id: string,
  index: number,
): Promise<ArrayBuffer | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("chunks")
      .objectStore("chunks")
      .get(`${id}:${index}`);
    request.onsuccess = () =>
      resolve(request.result as ArrayBuffer | undefined);
    request.onerror = () => reject(request.error);
  });
}
export async function cacheChunk(
  id: string,
  index: number,
  value: Uint8Array,
): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("chunks", "readwrite");
    tx.objectStore("chunks").put(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
      `${id}:${index}`,
    );
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () =>
      reject(
        new Error(
          tx.error?.name === "QuotaExceededError"
            ? "本机续传空间不足。已接收的密文会保留；请释放磁盘空间后继续。"
            : "密文续传记录保存失败，请检查本机存储权限。",
        ),
      );
  });
}
export async function clearCachedDownload(id: string): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["chunks", "records"], "readwrite");
    tx.objectStore("chunks").delete(
      IDBKeyRange.bound(`${id}:`, `${id}:\uffff`),
    );
    tx.objectStore("records").delete(`download:${id}`);
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}
export async function requireDownloadSpace(bytes: number): Promise<void> {
  // Firefox can leave persist() pending until the user answers its native
  // permission prompt. Persistence protects against eviction; it is not a
  // prerequisite for quota checks, IndexedDB, or the current transfer.
  if (!persistenceRequested) {
    persistenceRequested = true;
    try {
      void navigator.storage?.persist?.().catch(() => false);
    } catch {
      /* Browser policy. Normal temporary storage can still work. */
    }
  }
  const estimate = await navigator.storage?.estimate?.();
  if (
    estimate?.quota !== undefined &&
    estimate.usage !== undefined &&
    estimate.quota - estimate.usage <
      bytes + Math.min(bytes * 0.05, 64 * 1024 * 1024)
  ) {
    throw new Error(
      "本机可用续传空间不足。下载需临时保存一份密文，请释放磁盘空间或换用空间充足的设备。",
    );
  }
  // Fail before consuming a download qualification if IndexedDB is disabled.
  await saveLocalRecord("storage-check", Date.now());
}
