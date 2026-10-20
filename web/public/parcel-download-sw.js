/* Same-origin, bounded-memory file saving. No network requests or file keys.
 * The page supplies at most one authenticated plaintext part per pull. */
const transfers = new Map();
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("message", (event) => {
  const data = event.data;
  if (
    !event.source?.url ||
    event.source.type !== "window" ||
    new URL(event.source.url).origin !== self.location.origin
  )
    return;
  // Firefox can bypass the worker for a reload, leaving an already activated
  // registration with an uncontrolled document. Activation will not run again.
  if (data?.type === "parcel-claim") {
    event.waitUntil(self.clients.claim());
    return;
  }
  if (
    data?.type !== "parcel-save" ||
    !/^[a-f0-9]{64}$/.test(data.token) ||
    !Number.isSafeInteger(data.size) ||
    data.size < 0 ||
    !event.ports[0]
  )
    return;
  const port = event.ports[0];
  transfers.set(data.token, {
    port,
    name: String(data.name).replace(/[\r\n]/g, ""),
    size: data.size,
  });
  setTimeout(() => {
    if (transfers.has(data.token)) {
      transfers.delete(data.token);
      port.postMessage({
        type: "error",
        message: "保存未开始，请再次点击保存。",
      });
      port.close();
    }
  }, 60_000);
  port.postMessage({ type: "ready" });
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    url.origin !== self.location.origin ||
    !url.pathname.startsWith("/__parcel_download/")
  )
    return;
  event.respondWith(
    (async () => {
      const token = url.pathname.slice("/__parcel_download/".length);
      const transfer = transfers.get(token);
      if (!transfer || event.request.method !== "GET")
        return new Response("下载保存会话已失效，请返回分享页重试。", {
          status: 410,
        });
      transfers.delete(token);
      const { port, name, size } = transfer;
      let resolvePull;
      let rejectPull;
      let finished;
      const completion = new Promise((resolve) => {
        finished = resolve;
      });
      event.waitUntil(completion);
      let controller;
      port.onmessage = ({ data }) => {
        if (data.type === "chunk" && data.buffer instanceof ArrayBuffer) {
          controller.enqueue(new Uint8Array(data.buffer));
          resolvePull?.();
        } else if (data.type === "end") {
          controller.close();
          resolvePull?.();
          port.postMessage({ type: "saved" });
          port.close();
          finished();
        } else if (data.type === "error") {
          controller.error(new Error(data.message || "文件保存失败"));
          rejectPull?.(new Error(data.message || "文件保存失败"));
          port.close();
          finished();
        }
      };
      const body = new ReadableStream(
        {
          start(value) {
            controller = value;
          },
          pull() {
            return new Promise((resolve, reject) => {
              resolvePull = resolve;
              rejectPull = reject;
              port.postMessage({ type: "pull" });
            });
          },
          cancel() {
            port.postMessage({ type: "cancel" });
            port.close();
            finished();
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(size),
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name || "download").replace(/'/g, "%27")}`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy": "default-src 'none'",
        },
      });
    })(),
  );
});
