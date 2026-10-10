import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  chromium,
  firefox,
  expect,
} from "../../../web/node_modules/@playwright/test/index.mjs";
import { fixture } from "./fixture.mjs";

for (const [name, engine, viewport] of [
  ["chromium", chromium, { width: 1440, height: 1000 }],
  ["firefox", firefox, { width: 1440, height: 1000 }],
  ["mobile", chromium, { width: 390, height: 844 }],
]) {
  test(
    `V3 frontend actual workerd/D1/R2 upload, password download and revoke (${name})`,
    { timeout: 120000 },
    async (t) => {
      const f = await fixture(t),
        browser = await engine.launch({ headless: true });
      t.after(() => browser.close());
      const context = await browser.newContext({
          viewport,
          acceptDownloads: true,
        }),
        page = await context.newPage();
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
            const bytes =
              req.postDataBuffer() ||
              source.slice(
                (Number(url.searchParams.get("partNumber")) - 1) * (16 << 20),
                Number(url.searchParams.get("partNumber")) * (16 << 20),
              );
            assert.ok(bytes);
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
          return route.fulfill({
            status: 200,
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Disposition": "attachment; filename=v3-file.bin",
              "Access-Control-Allow-Origin": f.config.PUBLIC_URL,
            },
            body: Buffer.from(await object.arrayBuffer()),
          });
        }
        throw new Error(`Unexpected browser dependency: ${url.origin}`);
      });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(f.config.PUBLIC_URL + "/admin/new");
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
      await page.getByRole("button", { name: "上传并创建分享" }).click();
      await expect(
        page.getByRole("heading", { name: "文件已装好，交给对方吧。" }),
      ).toBeVisible({ timeout: 30000 });
      assert.deepEqual(puts, [16 << 20, 3]);
      const share = await f.db.prepare("SELECT * FROM shares").first();
      assert.equal(share.size, bytes.length);
      assert.equal(share.download_count, 0);
      if (name === "chromium") {
        await mkdir(resolve("../dist/previews"), { recursive: true });
        await page.screenshot({
          path: resolve("../dist/previews/v3-published.png"),
          fullPage: true,
        });
      }
      await page.goto(f.config.PUBLIC_URL + "/s/" + share.id);
      await expect(
        page.getByRole("heading", { name: "输入密码，打开这份分享。" }),
      ).toBeVisible();
      await page.getByLabel("分享密码", { exact: true }).fill("v3-password");
      await page.getByRole("button", { name: "解锁文件", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "下载文件", exact: true }),
      ).toBeVisible();
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: "下载文件", exact: true }).click();
      const download = await downloadPromise,
        actual = await readFile(await download.path());
      assert.equal(
        createHash("sha256").update(actual).digest("hex"),
        createHash("sha256").update(bytes).digest("hex"),
      );
      await expect(
        page.getByRole("button", { name: "再次下载 / 继续" }),
      ).toBeVisible();
      const again = page.waitForEvent("download");
      await page.getByRole("button", { name: "再次下载 / 继续" }).click();
      await again;
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
      await page.getByRole("button", { name: "撤销分享", exact: true }).click();
      await page.getByRole("button", { name: "确认撤销", exact: true }).click();
      await expect(
        page.getByText("已撤销", { exact: true }).first(),
      ).toBeVisible();
      await page.goto(f.config.PUBLIC_URL + "/s/" + share.id);
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
