// Real HTTPS acceptance: no Playwright routing, real Service Worker, real
// browser download and persistent IndexedDB. Run from cloudflare/ on Linux
// (OpenSSL required). PARCEL_E2EE_LARGE=1 exercises the full 8 GiB limit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpsServer } from "node:https";
import { createServer as httpServer } from "node:http";
import { connect } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  readFile,
  mkdtemp,
  rm,
  open,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  chromium,
  firefox,
  expect,
} from "../../../web/node_modules/@playwright/test/index.mjs";
import { fixture } from "./fixture.mjs";

const large = process.env.PARCEL_E2EE_LARGE === "1";
const engines = (
  process.env.PARCEL_E2EE_BROWSERS ||
  (large ? "chromium" : "chromium,firefox,mobile")
).split(",");
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}
async function digest(path) {
  const hash = createHash("sha256");
  for await (const data of createReadStream(path)) hash.update(data);
  return hash.digest("hex");
}
async function harness(t, f, dir) {
  const cert = join(dir, "cert.pem"),
    key = join(dir, "key.pem"),
    ca = join(dir, "ca.pem"),
    caKey = join(dir, "ca-key.pem"),
    csr = join(dir, "server.csr"),
    extensions = join(dir, "extensions.cnf");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      caKey,
      "-out",
      ca,
      "-subj",
      "/CN=Parcel ephemeral acceptance CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      csr,
      "-subj",
      "/CN=parcel.example.com",
    ],
    { stdio: "ignore" },
  );
  await writeFile(
    extensions,
    "subjectAltName=DNS:parcel.example.com,DNS:account.r2.cloudflarestorage.com\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      ca,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-out",
      cert,
      "-days",
      "1",
      "-sha256",
      "-extfile",
      extensions,
    ],
    { stdio: "ignore" },
  );
  const stats = {
    put: 0,
    get: 0,
    droppedPut: 0,
    droppedGet: 0,
    droppedAdmission: 0,
    resumedRange: [],
    api: [],
  };
  const faults = {
    dropPut: false,
    dropAdmission: false,
    blockGetAfter: Infinity,
    corrupt: false,
    denyGet: 0,
  };
  const sockets = new Set();
  const server = httpsServer(
    { cert: await readFile(cert), key: await readFile(key) },
    async (req, res) => {
      try {
        const url = new URL(`https://${req.headers.host}${req.url}`);
        if (url.hostname === "account.r2.cloudflarestorage.com") {
          const cors = {
            "Access-Control-Allow-Origin": f.config.PUBLIC_URL,
            "Access-Control-Allow-Methods": "GET,PUT,HEAD,OPTIONS",
            "Access-Control-Allow-Headers":
              "Content-Type,Range,X-Amz-Meta-Parcel-Upload",
            "Access-Control-Expose-Headers":
              "ETag,Content-Length,Content-Range,Accept-Ranges",
          };
          if (req.method === "OPTIONS") {
            res.writeHead(204, cors).end();
            return;
          }
          const storageKey = decodeURIComponent(url.pathname)
            .split("/")
            .slice(2)
            .join("/");
          if (req.method === "PUT") {
            const upload = await f.db
              .prepare(
                "SELECT id FROM uploads WHERE multipart_id=? AND storage_key=?",
              )
              .bind(url.searchParams.get("uploadId"), storageKey)
              .first();
            assert.ok(upload, "signed upload identifies the existing object");
            const chunks = [];
            let bytes = 0;
            for await (const data of req) {
              bytes += data.length;
              assert.ok(bytes <= (16 << 20) + 28);
              chunks.push(data);
            }
            const data = Buffer.concat(chunks);
            const part = await f.put(
              upload.id,
              Number(url.searchParams.get("partNumber")),
              data,
            );
            stats.put++;
            if (large && stats.put % 64 === 0)
              console.log(`Uploaded ${stats.put} encrypted chunks`);
            if (faults.dropPut) {
              faults.dropPut = false;
              stats.droppedPut++;
              req.socket.destroy();
              return;
            }
            res
              .writeHead(200, {
                ...cors,
                "Content-Type": "application/octet-stream",
                ETag: `"${part.etag}"`,
              })
              .end();
            return;
          }
          if (req.method === "GET") {
            stats.get++;
            if (large && stats.get % 64 === 0)
              console.log(`Received ${stats.get} ciphertext ranges`);
            const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || "");
            assert.ok(range, "E2EE requests a bounded ciphertext range");
            const start = Number(range[1]),
              end = Number(range[2]);
            stats.resumedRange.push(start);
            if (faults.denyGet > 0) {
              faults.denyGet--;
              res.writeHead(403, cors).end();
              return;
            }
            if (start >= faults.blockGetAfter) {
              stats.droppedGet++;
              req.socket.destroy();
              return;
            }
            const object = await f.bucket.get(storageKey, {
              range: { offset: start, length: end - start + 1 },
            });
            assert.ok(object);
            res.writeHead(206, {
              ...cors,
              "Content-Length": end - start + 1,
              "Content-Range": `bytes ${start}-${end}/${object.size}`,
              "Accept-Ranges": "bytes",
            });
            if (faults.corrupt) {
              const data = new Uint8Array(await object.arrayBuffer());
              data[15] ^= 1;
              res.end(data);
            } else await pipeline(Readable.fromWeb(object.body), res);
            return;
          }
          res.writeHead(405, cors).end();
          return;
        }
        assert.equal(url.origin, f.config.PUBLIC_URL);
        assert.equal(url.hash, "", "fragment must never reach HTTP");
        const chunks = [];
        for await (const data of req) chunks.push(data);
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        if (url.pathname.startsWith("/api/"))
          stats.api.push({
            path: url.pathname,
            method: req.method,
            body: body?.toString(),
          });
        const headers = {
          ...req.headers,
          "CF-Connecting-IP": "198.51.100.19",
          "Cf-Access-Jwt-Assertion": f.jwt,
        };
        for (const name of [
          "host",
          "connection",
          "content-length",
          "transfer-encoding",
          "accept-encoding",
        ])
          delete headers[name];
        const response = await f.mf.dispatchFetch(url.href, {
          method: req.method,
          headers,
          body,
        });
        if (
          faults.dropAdmission &&
          url.pathname.endsWith("/download-sessions") &&
          response.status === 201
        ) {
          faults.dropAdmission = false;
          stats.droppedAdmission++;
          await response.body?.cancel();
          req.socket.destroy();
          return;
        }
        const output = Object.fromEntries(response.headers);
        const cookies = response.headers.getSetCookie();
        if (cookies.length) output["set-cookie"] = cookies;
        res.writeHead(response.status, output);
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        if (response.body) await pipeline(Readable.fromWeb(response.body), res);
        else res.end();
      } catch (error) {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(error));
        console.error("acceptance transport:", error.message);
      }
    },
  );
  const port = await listen(server);
  const proxy = httpServer();
  proxy.on("connect", (req, client, head) => {
    if (
      ![
        "parcel.example.com:443",
        "account.r2.cloudflarestorage.com:443",
      ].includes(req.url)
    ) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = connect(port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    sockets.add(client);
    sockets.add(upstream);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => sockets.delete(client));
    upstream.on("close", () => sockets.delete(upstream));
  });
  const proxyPort = await listen(proxy);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await Promise.all([
      new Promise((r) => server.close(r)),
      new Promise((r) => proxy.close(r)),
    ]);
  });
  return { proxy: `http://127.0.0.1:${proxyPort}`, cert: ca, stats, faults };
}

for (const name of engines)
  test(
    `real HTTPS E2EE streaming, integrity and recovery (${name}${large ? ", 8 GiB" : ""})`,
    { timeout: large ? 7200000 : 240000 },
    async (t) => {
      const dir = await mkdtemp(join(tmpdir(), "parcel-e2ee-browser-"));
      t.after(() => rm(dir, { recursive: true, force: true }));
      const f = await fixture(
        t,
        process.env.PARCEL_E2EE_ASSETS
          ? {
              assets: async (request) => {
                const path = new URL(request.url).pathname;
                const filename =
                  path.startsWith("/assets/") ||
                  path === "/parcel-download-sw.js"
                    ? path.slice(1)
                    : "index.html";
                return new Response(
                  await readFile(
                    resolve(process.env.PARCEL_E2EE_ASSETS, filename),
                  ),
                  {
                    headers: {
                      "Content-Type": filename.endsWith(".js")
                        ? "text/javascript"
                        : filename.endsWith(".css")
                          ? "text/css"
                          : "text/html",
                    },
                  },
                );
              },
            }
          : {},
      );
      const h = await harness(t, f, dir);
      const viewport =
        name === "mobile"
          ? { width: 390, height: 844 }
          : { width: 1440, height: 1000 };
      let context;
      if (name === "firefox") {
        // Firefox does not propagate Playwright's TLS-ignore setting into every
        // Service Worker fetch. Trust this one ephemeral test CA in this isolated
        // disposable profile; never change the user's or system certificate store.
        const profile = join(dir, "firefox-profile");
        await mkdir(profile);
        execFileSync("certutil", [
          "-N",
          "--empty-password",
          "-d",
          `sql:${profile}`,
        ]);
        execFileSync("certutil", [
          "-A",
          "-d",
          `sql:${profile}`,
          "-n",
          "Parcel ephemeral acceptance CA",
          "-t",
          "CT,,",
          "-i",
          h.cert,
        ]);
        context = await firefox.launchPersistentContext(profile, {
          headless: true,
          proxy: { server: h.proxy },
          viewport,
          acceptDownloads: true,
          firefoxUserPrefs: { "dom.serviceWorkers.testing.enabled": true },
        });
        t.after(() => context.close());
      } else {
        const options = {
          headless: true,
          proxy: { server: h.proxy },
          args: ["--ignore-certificate-errors"],
        };
        if (large) {
          // A private/incognito context deliberately has a much smaller storage
          // quota. A normal disposable profile models regular multi-GB downloads.
          context = await chromium.launchPersistentContext(
            join(dir, "chromium-profile"),
            {
              ...options,
              ignoreHTTPSErrors: true,
              acceptDownloads: true,
              viewport,
            },
          );
          t.after(() => context.close());
        } else {
          const browser = await chromium.launch(options);
          t.after(() => browser.close());
          context = await browser.newContext({
            ignoreHTTPSErrors: true,
            acceptDownloads: true,
            viewport,
          });
        }
      }
      context.on("console", (message) => {
        if (message.type() === "error")
          console.log("browser console:", message.text());
      });
      context.on("requestfailed", (request) => {
        if (request.url().includes("/__parcel_download/"))
          console.log("save request failed:", request.failure());
      });
      context.on("response", (response) => {
        if (response.url().includes("/__parcel_download/"))
          console.log(
            "save response:",
            response.status(),
            response.fromServiceWorker(),
          );
      });
      // Exercise the actual Service Worker fallback, including Chrome where a
      // native picker is normally available. This does not substitute the sink.
      await context.addInitScript(() =>
        Object.defineProperty(window, "showSaveFilePicker", {
          value: undefined,
          configurable: true,
        }),
      );
      if (name === "firefox")
        await context.addInitScript(() => {
          // An unanswered optional permission prompt must not block a transfer.
          Object.defineProperty(navigator.storage, "persist", {
            value: () => new Promise(() => {}),
          });
        });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("dialog", (d) => d.accept());
      const size = large ? 8 * 1024 ** 3 : (16 << 20) + 192333;
      const source = join(dir, "source-private-filename.bin");
      const fd = await open(source, "w");
      await fd.truncate(size);
      await fd.write(
        Buffer.from("Parcel plaintext never belongs in R2 or API"),
        0,
        42,
        0,
      );
      await fd.write(
        Buffer.from("tail-with-authenticated-full-file-hash"),
        0,
        37,
        size - 37,
      );
      await fd.close();
      const expectedHash = await digest(source);
      await page.goto(f.config.PUBLIC_URL + "/admin/new");
      await page.locator('input[name="share-file"]').setInputFiles(source);
      await page.locator("#share-limit").fill("1");
      if (!large) {
        await page.locator("#protect").check();
        await page
          .getByLabel("分享密码", { exact: true })
          .fill("browser-e2ee-private-password");
      }
      h.faults.dropPut = true;
      await page
        .getByRole("button", { name: "上传并创建分享", exact: true })
        .click();
      await expect
        .poll(() => h.stats.droppedPut, {
          timeout: large ? 3600000 : 60000,
          intervals: [20, 50, 100],
        })
        .toBe(1);
      // R2 committed the part but its response was lost. Reload and reselect the
      // original; server reconciliation must find that part without rewriting it.
      await page.reload();
      await page.locator('input[name="share-file"]').setInputFiles(source);
      await page.getByRole("button", { name: "继续上传", exact: true }).click();
      await expect(page.locator("input[readonly]").first()).toHaveValue(/#k=/, {
        timeout: large ? 3600000 : 120000,
      });
      const link = await page.locator("input[readonly]").first().inputValue();
      const id = new URL(link).pathname.split("/").at(-1);
      assert.equal(h.stats.droppedPut, 1);
      const row = await f.db
        .prepare("SELECT * FROM shares WHERE id=?")
        .bind(id)
        .first();
      assert.equal(row.name, "encrypted.parcel");
      assert.equal(
        row.size,
        size + 28 * Math.max(1, Math.ceil(size / (16 << 20))),
      );
      for (const request of h.stats.api) {
        assert.ok(!request.body?.includes("source-private-filename"));
        assert.ok(!request.body?.includes(new URL(link).hash.slice(3)));
        assert.ok(!request.body?.includes("browser-e2ee-private-password"));
      }
      const receiver = await context.newPage();
      receiver.on("dialog", (d) => d.accept());
      await receiver.goto(link.split("#")[0]);
      await expect(
        receiver.getByRole("heading", { name: "链接缺少解密密钥" }),
      ).toBeVisible();
      await receiver.goto(link);
      if (!large) {
        await receiver
          .getByLabel("分享密码", { exact: true })
          .fill("wrong-password");
        await receiver.getByRole("button", { name: "解锁文件" }).click();
        await expect(receiver.getByRole("alert")).toContainText(
          "密码或链接密钥不正确",
        );
        await receiver
          .getByLabel("分享密码", { exact: true })
          .fill("browser-e2ee-private-password");
        await receiver.getByRole("button", { name: "解锁文件" }).click();
      }
      await expect(
        receiver.getByRole("heading", { name: "接收加密文件" }),
      ).toBeVisible({ timeout: 30000 });
      h.faults.blockGetAfter = (16 << 20) + 28;
      h.faults.dropAdmission = true;
      await receiver
        .getByRole("button", { name: "下载文件", exact: true })
        .click();
      await expect(
        receiver.getByRole("button", { name: "继续接收密文", exact: true }),
      ).toBeVisible({ timeout: 60000 });
      assert.ok(h.stats.droppedGet >= 1);
      const firstPartGets = h.stats.resumedRange.filter((n) => n === 0).length;
      await receiver.reload();
      if (!large) {
        await receiver
          .getByLabel("分享密码", { exact: true })
          .fill("browser-e2ee-private-password");
        await receiver.getByRole("button", { name: "解锁文件" }).click();
      }
      await expect(
        receiver.getByRole("button", { name: "继续接收密文", exact: true }),
      ).toBeVisible({ timeout: 30000 });
      h.faults.blockGetAfter = Infinity;
      h.faults.denyGet = 1; // Simulate a URL expiring while the download session lives.
      await receiver
        .getByRole("button", { name: "继续接收密文", exact: true })
        .click();
      await expect(
        receiver.getByRole("button", { name: "保存解密文件", exact: true }),
      ).toBeVisible({ timeout: large ? 3600000 : 60000 });
      assert.equal(
        h.stats.resumedRange.filter((n) => n === 0).length,
        firstPartGets,
        "reload reuses the authenticated first chunk",
      );
      assert.equal(
        (
          await f.db
            .prepare("SELECT download_count FROM shares WHERE id=?")
            .bind(id)
            .first()
        ).download_count,
        1,
      );
      console.log(
        "saving worker registration:",
        await receiver.evaluate(async () => {
          try {
            const registration = await navigator.serviceWorker.register(
              "/parcel-download-sw.js",
              { scope: "/" },
            );
            return {
              active: registration.active?.state,
              installing: registration.installing?.state,
            };
          } catch (error) {
            return { error: error.message };
          }
        }),
      );
      await expect
        .poll(
          () => receiver.evaluate(() => !!navigator.serviceWorker.controller),
          { timeout: 20000 },
        )
        .toBe(true);
      const downloadPromise = receiver.waitForEvent("download", {
        timeout: 60000,
      });
      await receiver
        .getByRole("button", { name: "保存解密文件", exact: true })
        .click();
      const download = await downloadPromise;
      const output = join(dir, "decrypted.bin");
      try {
        await download.saveAs(output);
      } catch (error) {
        console.log(
          "save diagnostics:",
          await download.failure(),
          await receiver.locator("body").innerText(),
        );
        throw error;
      }
      assert.equal(await download.failure(), null);
      assert.equal(download.suggestedFilename(), "source-private-filename.bin");
      assert.equal(await digest(output), expectedHash);
      await expect(
        receiver.getByText("解密与 SHA-256 校验已完成。", { exact: false }),
      ).toBeVisible({ timeout: 30000 });
      assert.ok(
        await receiver.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "receive screen fits viewport",
      );
      assert.deepEqual(errors, []);
      assert.equal(h.stats.droppedAdmission, 1);
      const report = {
        browser: name,
        plaintextBytes: size,
        storedBytes: row.size,
        sha256: expectedHash,
        uploadParts: h.stats.put,
        ciphertextRangeRequests: h.stats.get,
        uploadLostResponseRecovered: true,
        lostDownloadAdmissionRecovered: true,
        downloadReloadResumed: true,
        expiredURLRefreshed: true,
        downloadCount: 1,
        genuineServiceWorkerSave: true,
      };
      await mkdir(resolve("../.parcel-v3/e2ee-acceptance"), {
        recursive: true,
      });
      await writeFile(
        resolve(
          `../.parcel-v3/e2ee-acceptance/${name}${large ? "-8gib" : ""}.json`,
        ),
        JSON.stringify(report, null, 2),
      );
      await receiver.screenshot({
        path: resolve(`../.parcel-v3/e2ee-acceptance/${name}.png`),
        fullPage: true,
      });
      console.log(JSON.stringify(report));
    },
  );
