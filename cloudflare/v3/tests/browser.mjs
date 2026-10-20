import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  chromium,
  firefox,
  expect,
} from "../../../web/node_modules/@playwright/test/index.mjs";
import { fixture as rawFixture } from "./fixture.mjs";
import { totp } from "../totp.mjs";

const fixture = (t, options = {}) =>
  rawFixture(t, {
    ...options,
    ...(process.env.PARCEL_V3_BROWSER_ASSETS
      ? { assetDirectory: process.env.PARCEL_V3_BROWSER_ASSETS }
      : {}),
  });

for (const [name, engine, viewport] of [
  ["chromium", chromium, { width: 1440, height: 1000 }],
  ["firefox", firefox, { width: 1440, height: 1000 }],
  ["mobile", chromium, { width: 390, height: 844 }],
]) {
  test(
    `native admin QR enrollment, login, recovery and logout (${name})`,
    { timeout: 120000 },
    async (t) => {
      const setupToken = "browser-test-initialization-" + "x".repeat(32);
      const f = await fixture(t, {
        config: { ADMIN_AUTH: "totp", ADMIN_SETUP_TOKEN: setupToken },
      });
      const browser = await engine.launch({ headless: true });
      t.after(() => browser.close());
      const context = await browser.newContext({
        viewport,
        acceptDownloads: true,
      });
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await context.route("**/*", async (route) => {
        const request = route.request();
        assert.equal(
          new URL(request.url()).origin,
          f.config.PUBLIC_URL,
          "authentication must stay on this origin",
        );
        const headers = {
          ...request.headers(),
          "CF-Connecting-IP": "198.51.100.22",
        };
        for (const key of [
          "host",
          "content-length",
          "transfer-encoding",
          "accept-encoding",
          "connection",
        ])
          delete headers[key];
        const body = request.postDataBuffer();
        if (body && new URL(request.url()).pathname.startsWith("/api/v1/auth/"))
          assert.ok(
            !body.includes(Buffer.from("native-admin-password")),
            "plaintext password must not leave the browser",
          );
        const response = await f.mf.dispatchFetch(request.url(), {
          method: request.method(),
          headers,
          body: body || undefined,
        });
        const outputHeaders = Object.fromEntries(response.headers);
        const setCookies = response.headers.getSetCookie();
        if (setCookies.length)
          outputHeaders["set-cookie"] = setCookies.join("\n");
        await route.fulfill({
          status: response.status,
          headers: outputHeaders,
          body: Buffer.from(await response.arrayBuffer()),
        });
      });
      await page.goto(f.config.PUBLIC_URL + "/login");
      await expect(
        page.getByRole("heading", { name: "设置管理员登录" }),
      ).toBeVisible();
      await page.getByLabel("初始化密钥").fill(setupToken);
      await page
        .getByLabel("管理员密码", { exact: true })
        .fill("native-admin-password");
      await page.getByLabel("确认密码").fill("native-admin-password");
      await page.getByRole("button", { name: "继续绑定认证器" }).click();
      await expect(
        page.getByRole("heading", { name: "扫码绑定认证器" }),
      ).toBeVisible();
      await expect(
        page.getByRole("img", { name: "使用认证器扫描此二维码绑定 Parcel" }),
      ).toBeVisible();
      await page.getByText("无法扫码？手动输入密钥").click();
      const secret = await page.locator(".totp-secret code").innerText();
      assert.match(secret, /^[A-Z2-7]{32}$/);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await mkdir(resolve("../.parcel-v3/auth-previews"), { recursive: true });
      await page.screenshot({
        path: resolve(`../.parcel-v3/auth-previews/enrollment-${name}.png`),
        fullPage: true,
      });
      // Accept the previous valid step so a fresh current code can log in next.
      await page
        .getByLabel("动态验证码", { exact: true })
        .fill(await totp(secret, Math.floor(Date.now() / 30000) - 1));
      await page.getByRole("button", { name: "确认绑定" }).click();
      await expect(
        page.getByRole("heading", { name: "保存恢复码" }),
      ).toBeVisible();
      const recovery = await page
        .locator(".recovery-codes code")
        .first()
        .innerText();
      await expect(page.locator(".recovery-codes li")).toHaveCount(8);
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: "下载恢复码" }).click();
      assert.equal(
        (await downloadPromise).suggestedFilename(),
        "parcel-recovery-codes.txt",
      );
      await page.getByLabel("我已安全保存恢复码").check();
      await page.getByRole("button", { name: "进入管理页面" }).click();
      await expect(page.getByRole("link", { name: "登录安全" })).toBeVisible();
      await page.getByRole("button", { name: "退出登录" }).click();
      await expect(
        page.getByRole("heading", { name: "管理员登录", exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: resolve(`../.parcel-v3/auth-previews/login-${name}.png`),
        fullPage: true,
      });
      await page
        .getByLabel("管理员密码", { exact: true })
        .fill("native-admin-password");
      await page
        .getByLabel("动态验证码", { exact: true })
        .fill(await totp(secret, Math.floor(Date.now() / 30000)));
      await page.getByRole("button", { name: "登录 Parcel" }).click();
      await expect(page.getByRole("link", { name: "登录安全" })).toBeVisible();
      await page.getByRole("link", { name: "登录安全" }).click();
      await expect(
        page.getByRole("heading", { name: "更换认证器" }),
      ).toBeVisible();
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "security page must fit mobile width",
      );
      await page.screenshot({
        path: resolve(`../.parcel-v3/auth-previews/security-${name}.png`),
        fullPage: true,
      });
      await page.getByRole("button", { name: "退出登录" }).click();
      await page
        .getByRole("button", { name: "无法使用认证器？使用恢复码" })
        .click();
      await page
        .getByLabel("管理员密码", { exact: true })
        .fill("native-admin-password");
      await page.getByLabel("恢复码", { exact: true }).fill(recovery);
      await page.getByRole("button", { name: "继续绑定认证器" }).click();
      await expect(
        page.getByRole("heading", { name: "扫码绑定认证器" }),
      ).toBeVisible();
      await f.db.prepare("DELETE FROM rate_limits").run();
      await page.getByText("无法扫码？手动输入密钥").click();
      const replacement = await page.locator(".totp-secret code").innerText();
      assert.notEqual(replacement, secret);
      await page
        .getByLabel("动态验证码", { exact: true })
        .fill(await totp(replacement, Math.floor(Date.now() / 30000)));
      await page.getByRole("button", { name: "确认绑定" }).click();
      await expect(
        page.getByRole("heading", { name: "保存恢复码" }),
      ).toBeVisible();
      assert.equal(
        (await context.storageState()).origins.length,
        0,
        "no credential in localStorage",
      );
      assert.deepEqual(errors, []);
      assert.equal(f.unexpected, 0);
    },
  );
}

for (const [name, viewport] of [
  ["chromium", { width: 1440, height: 1000 }],
  ["mobile", { width: 390, height: 844 }],
]) {
  test(
    `E2EE password rewrap, encrypted key backup and ciphertext authentication (${name})`,
    { timeout: 120000 },
    async (t) => {
      const f = await fixture(t),
        browser = await chromium.launch({ headless: true });
      t.after(() => browser.close());
      const context = await browser.newContext({
        viewport,
        acceptDownloads: true,
      });
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const original = Buffer.from(
        "Synthetic browser confidentiality and backup acceptance.\n".repeat(32),
      );
      const privateName = "sensitive-browser-file.txt",
        oldPassword = "first-download-password",
        newPassword = "replacement-download-password";
      let puts = 0,
        cipherGets = 0,
        unlockCalls = 0,
        corrupt = false,
        unexpectedFileDownloads = 0;
      await page.addInitScript(() => {
        window.__parcelTestSaves = 0;
        window.showSaveFilePicker = async () => {
          window.__parcelTestSaves++;
          throw new Error(
            "Corrupt ciphertext must never reach the file writer",
          );
        };
      });
      page.on("download", (download) => {
        if (!download.suggestedFilename().startsWith("parcel-key-"))
          unexpectedFileDownloads++;
      });
      await context.route("**/*", async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (url.origin === f.config.PUBLIC_URL) {
          const headers = {
            ...request.headers(),
            "CF-Connecting-IP": "198.51.100.9",
          };
          if (
            /^\/(admin|login|api\/v1\/(auth|admin|uploads))(\/|$)/.test(
              url.pathname,
            )
          )
            headers["Cf-Access-Jwt-Assertion"] = f.jwt;
          for (const key of [
            "host",
            "content-length",
            "transfer-encoding",
            "accept-encoding",
            "connection",
          ])
            delete headers[key];
          const body = request.postDataBuffer();
          if (body) {
            assert.ok(
              !body.includes(Buffer.from(privateName)),
              "plaintext filename must not enter any API body",
            );
            assert.ok(
              !body.includes(Buffer.from(oldPassword)) &&
                !body.includes(Buffer.from(newPassword)),
              "plaintext sharing password must not enter any API body",
            );
          }
          if (url.pathname.endsWith("/unlock")) unlockCalls++;
          const response = await f.mf.dispatchFetch(request.url(), {
            method: request.method(),
            headers,
            body: body || undefined,
          });
          const outputHeaders = Object.fromEntries(response.headers);
          const cookies = response.headers.getSetCookie();
          if (cookies.length) outputHeaders["set-cookie"] = cookies.join("\n");
          return route.fulfill({
            status: response.status,
            headers: outputHeaders,
            body: Buffer.from(await response.arrayBuffer()),
          });
        }
        assert.equal(url.origin, f.config.R2_ENDPOINT);
        const key = decodeURIComponent(
          url.pathname.slice(`/${f.config.R2_BUCKET_NAME}/`.length),
        );
        if (request.method() === "PUT") {
          const row = await f.db
            .prepare("SELECT id FROM uploads WHERE storage_key=?")
            .bind(key)
            .first();
          const ciphertext = request.postDataBuffer();
          assert.ok(ciphertext && ciphertext.length === original.length + 28);
          assert.ok(!ciphertext.includes(original.subarray(0, 64)));
          const result = await f.put(
            row.id,
            Number(url.searchParams.get("partNumber")),
            ciphertext,
          );
          puts++;
          return route.fulfill({
            status: 200,
            headers: {
              "Access-Control-Allow-Origin": f.config.PUBLIC_URL,
              "Access-Control-Expose-Headers": "ETag",
              ETag: `"${result.etag}"`,
            },
            body: "",
          });
        }
        assert.equal(request.method(), "GET");
        cipherGets++;
        const object = await f.bucket.get(key),
          all = Buffer.from(await object.arrayBuffer());
        const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers().range || "");
        assert.ok(range);
        const start = Number(range[1]),
          end = Number(range[2]);
        const payload = Buffer.from(all.subarray(start, end + 1));
        if (corrupt) payload[20] ^= 1;
        return route.fulfill({
          status: 206,
          headers: {
            "Content-Type": "application/octet-stream",
            "Access-Control-Allow-Origin": f.config.PUBLIC_URL,
            "Access-Control-Expose-Headers": "Content-Range,Content-Length",
            "Content-Range": `bytes ${start}-${end}/${all.length}`,
            "Content-Length": String(payload.length),
          },
          body: payload,
        });
      });
      await page.goto(f.config.PUBLIC_URL + "/admin/new");
      await page.getByLabel("选择文件", { exact: true }).setInputFiles({
        name: privateName,
        mimeType: "text/plain",
        buffer: original,
      });
      await page.getByLabel("密码保护", { exact: true }).check();
      await page.getByLabel("分享密码", { exact: true }).fill(oldPassword);
      await page
        .getByRole("button", { name: "上传并创建分享", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "文件已装好，交给对方吧。" }),
      ).toBeVisible({ timeout: 30000 });
      const share = await f.db.prepare("SELECT * FROM shares").first();
      const fullURL = await page
        .getByLabel("分享链接", { exact: true })
        .inputValue();
      assert.equal(puts, 1);

      await page.goto(f.config.PUBLIC_URL + `/admin/shares/${share.id}`);
      await page.getByLabel("修改分享密码", { exact: true }).fill(newPassword);
      await page
        .getByRole("button", { name: "保存密码设置", exact: true })
        .click();
      await expect(
        page.getByText("密码已更新，无需重传文件。", { exact: false }),
      ).toBeVisible({ timeout: 30000 });
      const updated = await f.db
        .prepare("SELECT * FROM shares WHERE id=?")
        .bind(share.id)
        .first();
      assert.equal(updated.version, 2);
      assert.equal(updated.etag, share.etag);
      assert.equal(updated.size, share.size);
      assert.equal(
        puts,
        1,
        "password changes must not re-upload file ciphertext",
      );
      assert.notDeepEqual(
        JSON.parse(updated.encryption).envelope,
        JSON.parse(share.encryption).envelope,
      );
      const localEncryption = await page.evaluate(
        (id) =>
          new Promise((resolve, reject) => {
            const open = indexedDB.open("parcel-e2ee-v1");
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const db = open.result,
                request = db
                  .transaction("records")
                  .objectStore("records")
                  .get(`share-key:${id}`);
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                resolve(request.result?.encryption);
                db.close();
              };
            };
          }),
        share.id,
      );
      assert.deepEqual(
        localEncryption,
        JSON.parse(updated.encryption),
        "retained local key context must contain the current envelope",
      );

      await page.getByText("备份 / 导入本机分享密钥", { exact: true }).click();
      const backupPassphrase = "offline-backup-passphrase-2026";
      await page
        .getByLabel("备份口令（至少 12 字节）", { exact: true })
        .fill(backupPassphrase);
      const exportedPromise = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "导出加密备份", exact: true })
        .click();
      const exported = await exportedPromise,
        backupBytes = await readFile(await exported.path());
      const backup = JSON.parse(backupBytes.toString());
      assert.equal(backup.format, "parcel-e2ee-key-backup");
      assert.equal(backup.version, 1);
      for (const value of [
        privateName,
        backupPassphrase,
        fullURL.split("#k=")[1],
        newPassword,
      ])
        assert.ok(
          !backupBytes.includes(Buffer.from(value)),
          "key backup must contain only authenticated ciphertext",
        );
      await page.evaluate(
        (id) =>
          new Promise((resolve, reject) => {
            const open = indexedDB.open("parcel-e2ee-v1");
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const db = open.result,
                tx = db.transaction("records", "readwrite");
              tx.objectStore("records").delete(`share-key:${id}`);
              tx.oncomplete = () => {
                db.close();
                resolve();
              };
              tx.onerror = () => reject(tx.error);
            };
          }),
        share.id,
      );
      await page.reload();
      await expect(
        page.getByText("此浏览器没有解密密钥，无法显示文件名或复制可用链接。", {
          exact: false,
        }),
      ).toBeVisible();
      await expect(page.getByLabel("分享链接", { exact: true })).toHaveCount(0);
      await page.getByText("备份 / 导入本机分享密钥", { exact: true }).click();
      await page
        .getByLabel("备份口令（至少 12 字节）", { exact: true })
        .fill("incorrect-backup-passphrase");
      await page.getByLabel("导入密钥备份", { exact: true }).setInputFiles({
        name: exported.suggestedFilename(),
        mimeType: "application/json",
        buffer: backupBytes,
      });
      await expect(
        page.getByRole("alert").filter({ hasText: "备份密码不正确" }),
      ).toBeVisible({ timeout: 30000 });
      await expect(page.getByLabel("分享链接", { exact: true })).toHaveCount(0);
      await page
        .getByLabel("备份口令（至少 12 字节）", { exact: true })
        .fill(backupPassphrase);
      await page.getByLabel("导入密钥备份", { exact: true }).setInputFiles({
        name: exported.suggestedFilename(),
        mimeType: "application/json",
        buffer: backupBytes,
      });
      await expect(page.getByLabel("分享链接", { exact: true })).toHaveValue(
        fullURL,
        { timeout: 30000 },
      );
      assert.equal(puts, 1);

      await page.goto(fullURL);
      await expect(
        page.getByRole("heading", { name: "解锁加密分享", exact: true }),
      ).toBeVisible();
      await page.getByLabel("分享密码", { exact: true }).fill(oldPassword);
      await page.getByRole("button", { name: "解锁文件", exact: true }).click();
      await expect(
        page.getByRole("alert").filter({ hasText: "密码或链接密钥不正确" }),
      ).toBeVisible({ timeout: 30000 });
      assert.equal(
        unlockCalls,
        0,
        "wrong cryptographic password must fail locally before requesting a server grant",
      );
      await page.getByLabel("分享密码", { exact: true }).fill(newPassword);
      await page.getByRole("button", { name: "解锁文件", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "下载文件", exact: true }),
      ).toBeVisible({ timeout: 30000 });
      assert.equal(unlockCalls, 1);
      corrupt = true;
      await page.getByRole("button", { name: "下载文件", exact: true }).click();
      await expect(
        page.getByRole("alert").filter({ hasText: "文件分块认证失败" }),
      ).toBeVisible({ timeout: 30000 });
      await expect(
        page.getByRole("button", { name: "保存解密文件", exact: true }),
      ).toHaveCount(0);
      assert.ok(cipherGets >= 1);
      assert.equal(await page.evaluate(() => window.__parcelTestSaves), 0);
      assert.equal(unexpectedFileDownloads, 0);
      assert.equal(
        await page.evaluate(
          () =>
            new Promise((resolve, reject) => {
              const open = indexedDB.open("parcel-e2ee-v1");
              open.onerror = () => reject(open.error);
              open.onsuccess = () => {
                const db = open.result,
                  request = db
                    .transaction("chunks")
                    .objectStore("chunks")
                    .count();
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                  db.close();
                  resolve(request.result);
                };
              };
            }),
        ),
        0,
        "unauthenticated ciphertext must not be persisted as resumable content",
      );
      assert.equal(
        (
          await f.db
            .prepare("SELECT download_count FROM shares WHERE id=?")
            .bind(share.id)
            .first()
        ).download_count,
        1,
      );
      assert.deepEqual(errors, []);
      assert.equal(f.unexpected, 0);
    },
  );
}

for (const [name, engine, viewport] of [
  ["chromium", chromium, { width: 1440, height: 1000 }],
  ["firefox", firefox, { width: 1440, height: 1000 }],
  ["mobile", chromium, { width: 390, height: 844 }],
]) {
  test(
    `V3 frontend actual workerd/D1/R2 encrypted upload, password unwrap, streamed save and revoke (${name})`,
    {
      timeout: 120000,
      // Firefox's route interception omits XHR Blob bodies. The real HTTPS
      // suite exercises its actual ciphertext upload and saving path instead.
      skip:
        name === "firefox"
          ? "Firefox binary transport is covered by e2ee-browser.mjs over real HTTPS"
          : false,
    },
    async (t) => {
      const f = await fixture(t),
        browser = await engine.launch({ headless: true });
      t.after(() => browser.close());
      const context = await browser.newContext({
          viewport,
          acceptDownloads: true,
        }),
        page = await context.newPage();
      // Route.fulfill is not an HTTP origin that can install a Service Worker.
      // Exercise the native writer contract here; the HTTPS suite separately
      // proves the real browser Service Worker download path and disk output.
      await page.addInitScript(() => {
        window.__parcelTestSaved = [];
        window.showSaveFilePicker = async ({ suggestedName }) => ({
          async createWritable() {
            const record = {
              name: suggestedName,
              chunks: [],
              closed: false,
              aborted: false,
            };
            window.__parcelTestSaved.push(record);
            return {
              async write(bytes) {
                record.chunks.push(bytes.slice());
              },
              async close() {
                record.closed = true;
              },
              async abort() {
                record.aborted = true;
                record.chunks = [];
              },
            };
          },
        });
      });
      const passwordRequests = [];
      let puts = [],
        downloads = 0,
        apiCalls = 0,
        source;
      await context.route("**/*", async (route) => {
        const req = route.request(),
          url = new URL(req.url());
        if (url.origin === f.config.PUBLIC_URL) {
          const headers = {
            ...req.headers(),
            "CF-Connecting-IP": "198.51.100.9",
          };
          if (
            /^\/(admin|login|api\/v1\/(auth|admin|uploads))(\/|$)/.test(
              url.pathname,
            )
          )
            headers["Cf-Access-Jwt-Assertion"] = f.jwt;
          for (const key of [
            "host",
            "content-length",
            "transfer-encoding",
            "accept-encoding",
            "connection",
          ])
            delete headers[key];
          const body = req.postDataBuffer();
          if (
            body &&
            (/\/uploads$/.test(url.pathname) || /\/unlock$/.test(url.pathname))
          ) {
            const payload = JSON.parse(body.toString());
            if (/\/uploads$/.test(url.pathname)) {
              assert.equal(payload.name, undefined);
              assert.equal(payload.sha256, undefined);
              assert.equal(payload.encryption.version, 1);
              assert.ok(!body.includes(Buffer.from("v3-file.bin")));
            }
            if (payload.password_proof) {
              assert.equal(payload.password, undefined);
              assert.ok(!body.includes(Buffer.from("v3-password")));
              assert.equal(payload.password_proof.scheme, "client-argon2id-v1");
              passwordRequests.push(payload.password_proof);
            }
          }

          const response = await f.mf.dispatchFetch(req.url(), {
            method: req.method(),
            headers,
            body: body || undefined,
          });
          if (url.pathname.startsWith("/api/")) apiCalls++;
          return route.fulfill({
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body: Buffer.from(await response.arrayBuffer()),
          });
        }
        if (url.origin === f.config.R2_ENDPOINT) {
          const key = decodeURIComponent(
            url.pathname.slice(`/${f.config.R2_BUCKET_NAME}/`.length),
          );
          if (req.method() === "PUT") {
            const u = await f.db
              .prepare("SELECT id FROM uploads WHERE storage_key=?")
              .bind(key)
              .first();
            assert.ok(u);
            const bytes = req.postDataBuffer();
            assert.ok(bytes);
            assert.ok(
              !bytes.includes(source.subarray(0, 1024)),
              "R2 must receive ciphertext rather than the original file",
            );
            const result = await f.put(
              u.id,
              Number(url.searchParams.get("partNumber")),
              bytes,
            );
            puts.push(bytes.length);
            return route.fulfill({
              status: 200,
              headers: {
                "Access-Control-Allow-Origin": f.config.PUBLIC_URL,
                "Access-Control-Expose-Headers": "ETag",
                ETag: `"${result.etag}"`,
              },
              body: "",
            });
          }
          assert.equal(req.method(), "GET");
          downloads++;
          const object = await f.bucket.get(key);
          assert.ok(object);
          const bytes = Buffer.from(await object.arrayBuffer());
          const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers().range || "");
          assert.ok(
            range,
            "encrypted downloads request complete authenticated chunks",
          );
          const start = Number(range[1]),
            end = Number(range[2]);
          assert.ok(end < bytes.length);
          return route.fulfill({
            status: 206,
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Disposition": "attachment; filename=encrypted.parcel",
              "Access-Control-Allow-Origin": f.config.PUBLIC_URL,
              "Access-Control-Expose-Headers": "Content-Range, Content-Length",
              "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
              "Content-Length": String(end - start + 1),
            },
            body: bytes.subarray(start, end + 1),
          });
        }
        throw new Error(`Unexpected browser dependency: ${url.origin}`);
      });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(f.config.PUBLIC_URL + "/admin");
      await expect(
        page.getByText("Cloudflare 原生后端", { exact: false }),
      ).toBeVisible();
      await expect(
        page.getByText("本地磁盘可用", { exact: false }),
      ).toHaveCount(0);
      await page.goto(f.config.PUBLIC_URL + "/admin/new");
      const unlimited = name !== "firefox";
      if (unlimited) {
        await page.getByLabel("下载次数", { exact: true }).fill("7");
        await page.getByLabel("不限下载次数", { exact: true }).check();
        await expect(
          page.getByLabel("下载次数", { exact: true }),
        ).toBeDisabled();
        await page.getByLabel("不限下载次数", { exact: true }).uncheck();
        await expect(page.getByLabel("下载次数", { exact: true })).toHaveValue(
          "7",
        );
        await page.getByLabel("不限下载次数", { exact: true }).check();
        await page.getByLabel("有效期", { exact: true }).selectOption("3600");
      }
      const bytes = (source = Buffer.concat([
        Buffer.alloc(16 << 20, 0x61),
        Buffer.from("xyz"),
      ]));
      await page.getByLabel("选择文件", { exact: true }).setInputFiles({
        name: "v3-file.bin",
        mimeType: "application/octet-stream",
        buffer: bytes,
      });
      await page.getByLabel("密码保护", { exact: true }).check();
      await page.getByLabel("分享密码", { exact: true }).fill("v3-password");
      if (unlimited) {
        await mkdir(resolve("../dist/previews"), { recursive: true });
        await page.screenshot({
          path: resolve(`../dist/previews/v3-unlimited-${name}.png`),
          fullPage: true,
        });
      }
      await page.getByRole("button", { name: "上传并创建分享" }).click();
      await expect(
        page.getByRole("heading", { name: "文件已装好，交给对方吧。" }),
      ).toBeVisible({ timeout: 30000 });
      assert.deepEqual(puts, [(16 << 20) + 28, 31]);
      const share = await f.db.prepare("SELECT * FROM shares").first();
      assert.equal(share.size, bytes.length + 56);
      assert.equal(share.plaintext_size, bytes.length);
      assert.equal(share.name, "encrypted.parcel");
      assert.ok(!JSON.stringify(share).includes("v3-file.bin"));
      assert.equal(share.download_count, 0);
      assert.equal(share.max_downloads, unlimited ? -1 : 3);
      if (unlimited) {
        assert.equal(share.expires - share.created, 3600);
        await expect(page.getByText("不限次数", { exact: true })).toBeVisible();
      }
      if (name === "chromium") {
        await mkdir(resolve("../dist/previews"), { recursive: true });
        await page.screenshot({
          path: resolve("../dist/previews/v3-published.png"),
          fullPage: true,
        });
      }
      const fullURL = await page
        .getByLabel("分享链接", { exact: true })
        .inputValue();
      assert.match(fullURL, new RegExp(`/s/${share.id}#k=[A-Za-z0-9_-]{43}$`));
      await page.goto(fullURL);
      await expect(
        page.getByRole("heading", { name: "解锁加密分享" }),
      ).toBeVisible();
      await page.getByLabel("分享密码", { exact: true }).fill("v3-password");
      await page.getByRole("button", { name: "解锁文件", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "下载文件", exact: true }),
      ).toBeVisible();
      if (unlimited)
        await expect(page.getByText("不限次数", { exact: true })).toBeVisible();
      assert.equal(passwordRequests.length, 2);
      assert.deepEqual(passwordRequests[0], passwordRequests[1]);
      const browserStorage = await page.evaluate(() =>
        JSON.stringify({
          local: { ...localStorage },
          session: { ...sessionStorage },
        }),
      );
      assert.ok(!browserStorage.includes(passwordRequests[0].key));
      assert.ok(!browserStorage.includes("v3-password"));
      await page.getByRole("button", { name: "下载文件", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "保存解密文件", exact: true }),
      ).toBeVisible({ timeout: 30000 });
      await page
        .getByRole("button", { name: "保存解密文件", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "再次保存解密文件", exact: true }),
      ).toBeVisible({ timeout: 30000 });
      const saved = await page.evaluate(async () => {
        const record = window.__parcelTestSaved[0];
        const all = new Uint8Array(
          record.chunks.reduce((n, chunk) => n + chunk.length, 0),
        );
        let offset = 0;
        for (const chunk of record.chunks) {
          all.set(chunk, offset);
          offset += chunk.length;
        }
        const digest = await crypto.subtle.digest("SHA-256", all);
        return {
          name: record.name,
          closed: record.closed,
          aborted: record.aborted,
          chunkLengths: record.chunks.map((chunk) => chunk.length),
          hash: Array.from(new Uint8Array(digest), (value) =>
            value.toString(16).padStart(2, "0"),
          ).join(""),
        };
      });
      assert.equal(saved.name, "v3-file.bin");
      assert.equal(saved.closed, true);
      assert.equal(saved.aborted, false);
      assert.deepEqual(saved.chunkLengths, [16 << 20, 3]);
      assert.equal(
        saved.hash,
        createHash("sha256").update(bytes).digest("hex"),
      );
      await page
        .getByRole("button", { name: "再次保存解密文件", exact: true })
        .click();
      await expect
        .poll(() => page.evaluate(() => window.__parcelTestSaved.length))
        .toBe(2);
      await expect
        .poll(() => page.evaluate(() => window.__parcelTestSaved[1]?.closed))
        .toBe(true);
      assert.equal(
        (
          await f.db
            .prepare("SELECT download_count FROM shares WHERE id=?")
            .bind(share.id)
            .first()
        ).download_count,
        1,
      );
      await page.goto(f.config.PUBLIC_URL + "/admin/shares/" + share.id);
      if (unlimited)
        await expect(
          page.getByText("1 / 不限次数", { exact: true }),
        ).toBeVisible();
      await page.getByRole("button", { name: "撤销分享", exact: true }).click();
      await page.getByRole("button", { name: "确认撤销", exact: true }).click();
      await expect(
        page.getByText("已撤销", { exact: true }).first(),
      ).toBeVisible();
      await page.goto(fullURL);
      await expect(
        page.getByRole("heading", { name: "已撤销", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "下载文件", exact: true }),
      ).toHaveCount(0);
      assert.equal(downloads, 2);
      assert.ok(apiCalls > 10);
      assert.equal(f.unexpected, 0);
      assert.deepEqual(errors, []);
    },
  );
}
