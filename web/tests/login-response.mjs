// Actual browser + HTTP response-body regression. Run after an isolated V3
// build: node --test web/tests/login-response.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, expect } from "../node_modules/@playwright/test/index.mjs";

const assets =
  process.env.PARCEL_LOGIN_WEB_DIR ||
  fileURLToPath(new URL("../../dist/v3-web-login-test/", import.meta.url));
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
};
async function fixture(t, { grant, hangBody }) {
  const requests = { login: 0, session: 0 };
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    const json = (status, data) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(data));
    };
    if (path === "/api/v1/auth-config")
      return json(200, {
        auth_mode: "totp",
        initialized: true,
        setup_available: false,
        password_protocol: "client-argon2id-v1",
        password_kdf: {
          scheme: "client-argon2id-v1",
          salt: Buffer.alloc(16, 7).toString("base64").replace(/=+$/, ""),
          memory_kib: 32768,
          iterations: 2,
          parallelism: 1,
        },
      });
    if (path === "/api/v1/auth/login") {
      requests.login++;
      let body = "";
      for await (const chunk of request) body += chunk;
      assert.ok(
        !body.includes("synthetic-test-password"),
        "the raw test password is not sent",
      );
      response.writeHead(200, {
        "Content-Type": "application/json",
        ...(grant
          ? {
              "Set-Cookie":
                "parcel_login_test=accepted; HttpOnly; SameSite=Strict; Path=/",
            }
          : {}),
      });
      response.flushHeaders();
      if (hangBody)
        response.write('{"csrf":'); // Deliberately never completes.
      else response.end('{"csrf":"synthetic-csrf"}');
      return;
    }
    if (path === "/api/v1/auth/session") {
      requests.session++;
      return request.headers.cookie?.includes("parcel_login_test=accepted")
        ? json(200, { csrf: "synthetic-csrf", auth_mode: "totp" })
        : json(401, { code: "access_required", message: "No test session" });
    }
    if (path === "/admin") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<h1>Administrator test target</h1>");
      return;
    }
    try {
      const target =
        path === "/login" || path === "/"
          ? resolve(assets, "index.html")
          : resolve(assets, `.${path}`);
      assert.ok(target.startsWith(resolve(assets)));
      const contents = await readFile(target);
      response.writeHead(200, {
        "Content-Type": types[extname(target)] || "application/octet-stream",
      });
      response.end(contents);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  // Only shorten the production default. Native fetch/body abort semantics are
  // preserved; the test server really sends headers and leaves the body open.
  await page.addInitScript(() => {
    const original = AbortSignal.timeout.bind(AbortSignal);
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: (duration) => original(duration === 30_000 ? 300 : duration),
    });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/login`);
  await page
    .getByLabel("管理员密码", { exact: true })
    .fill("synthetic-test-password");
  await page.getByLabel("动态验证码", { exact: true }).fill("123456");
  return { page, requests };
}

test(
  "a committed login whose response body stalls is reconciled using its cookie",
  { timeout: 30_000 },
  async (t) => {
    const { page, requests } = await fixture(t, {
      grant: true,
      hangBody: true,
    });
    await page
      .getByRole("button", { name: "登录 Parcel", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Administrator test target" }),
    ).toBeVisible();
    assert.equal(
      requests.login,
      1,
      "the already-consumed TOTP is not resubmitted",
    );
    assert.equal(
      requests.session,
      1,
      "the committed session is verified after the body timeout",
    );
  },
);

test(
  "a stalled login without an established session leaves an actionable error",
  { timeout: 30_000 },
  async (t) => {
    const { page, requests } = await fixture(t, {
      grant: false,
      hangBody: true,
    });
    await page
      .getByRole("button", { name: "登录 Parcel", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText("请求超时");
    await expect(
      page.getByRole("button", { name: "登录 Parcel", exact: true }),
    ).toBeEnabled();
    assert.equal(requests.login, 1);
    assert.equal(requests.session, 1);
    assert.match(page.url(), /\/login$/);
  },
);

test(
  "successful authentication retains a direct admin link when navigation is canceled",
  { timeout: 30_000 },
  async (t) => {
    const { page } = await fixture(t, { grant: true, hangBody: false });
    await page.evaluate(() =>
      window.addEventListener("beforeunload", (event) => {
        event.preventDefault();
        event.returnValue = "";
      }),
    );
    page.on("dialog", (dialog) => dialog.dismiss());
    await page
      .getByRole("button", { name: "登录 Parcel", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "登录成功", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "进入管理页面" }),
    ).toHaveAttribute("href", "/admin");
  },
);
