import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { once } from "node:events";
import {
  chromium,
  firefox,
} from "../../web/node_modules/@playwright/test/index.mjs";

for (const [name, engine] of [
  ["chromium", chromium],
  ["firefox", firefox],
]) {
  test(`Access UI entry, CSRF logout and expired login navigation (${name})`, async () => {
    const server = createServer(async (request, response) => {
      const path = new URL(request.url, "http://localhost").pathname;
      const filename = path.startsWith("/assets/")
        ? path.slice(1)
        : "index.html";
      try {
        response.setHeader(
          "Content-Type",
          filename.endsWith(".js")
            ? "text/javascript"
            : filename.endsWith(".css")
              ? "text/css"
              : "text/html",
        );
        response.end(await readFile(resolve("../dist/pages-web", filename)));
      } catch {
        response.writeHead(404).end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      let expired = false,
        csrf = "";
      await page.route("**/api/v1/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        let data = {},
          status = 200;
        if (path === "/api/v1/auth/session") {
          data = expired
            ? { code: "access_required", message: "请通过管理入口验证身份" }
            : {
                csrf: "access-csrf",
                auth_mode: "access",
                email: "admin@example.com",
              };
          if (expired) status = 401;
        } else if (path === "/api/v1/auth/logout") {
          csrf = route.request().headers()["x-csrf-token"];
          data = { ok: true, logout_url: "/cdn-cgi/access/logout" };
        } else if (path === "/api/v1/admin/shares")
          data = { items: [], total: 0, cleaned_count: 0 };
        else
          data = {
            storage_backend: "r2",
            used_bytes: 0,
            reserved_bytes: 0,
            pending_bytes: 0,
            free_bytes: 10000000000,
            quota_bytes: 20000000000,
            r2_used_bytes: 0,
            r2_reserved_bytes: 0,
            r2_quota_bytes: 9000000000,
            r2_available_bytes: 9000000000,
          };
        await route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(data),
        });
      });
      await page.goto(base);
      assert.equal(
        await page.getByLabel("管理员密码", { exact: true }).count(),
        0,
      );
      assert.equal(
        await page
          .getByRole("link", { name: "进入管理页面" })
          .getAttribute("href"),
        "/admin",
      );
      if (name === "chromium")
        await page.screenshot({
          path: resolve("../docs/previews/access-login.png"),
          fullPage: true,
        });
      await page.getByRole("link", { name: "进入管理页面" }).click();
      await page.getByRole("button", { name: "退出登录" }).click();
      await page.waitForURL("**/cdn-cgi/access/logout");
      assert.equal(csrf, "access-csrf");
      expired = true;
      await page.goto(base + "/admin");
      await page.waitForURL("**/login");
    } finally {
      await browser.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}
