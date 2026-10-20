import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname, sep } from "node:path";
import { chromium } from "../../web/node_modules/playwright/index.mjs";

const root = resolve(
  fileURLToPath(new URL("../../docs/site/", import.meta.url)),
);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".webp": "image/webp",
};
let server;
let baseURL;
let browser;

before(async () => {
  server = createServer(async (request, response) => {
    const path = resolve(
      root,
      `.${new URL(request.url, "http://localhost").pathname.replace(/\/$/, "/index.html")}`,
    );
    if (!path.startsWith(root + sep)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(path);
      response
        .writeHead(200, { "Content-Type": mime[extname(path)] || "text/plain" })
        .end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
});

async function validInputs(page) {
  await page.locator("#origin").fill("https://parcel.example.com/");
  await page.locator("#account").fill("a".repeat(32));
  await page.locator("#bucket").fill("parcel-test");
}

for (const locale of ["index.html", "zh.html"]) {
  const label = `Chromium ${locale}`;
  test(`${label}: field errors, safe output, stale results, and clipboard fallback`, async () => {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${baseURL}/${locale}#config`);
    await page.locator('button[type="submit"]').click();
    assert.equal(
      await page.locator("#origin").getAttribute("aria-invalid"),
      "true",
    );
    assert.equal(
      await page
        .locator("#origin")
        .evaluate((el) => el === document.activeElement),
      true,
    );
    assert.equal(await page.locator("#origin-error").isVisible(), true);
    await validInputs(page);
    for (const origin of [
      "not a url",
      "http://parcel.example.com",
      "https://parcel.example.com/path",
      "https://parcel.example.com:443",
      "https://user:password@parcel.example.com",
      "https://parcel.example.com?q=x",
      "https://parcel.example.com#fragment",
    ]) {
      await page.locator("#origin").fill(origin);
      await page.locator('button[type="submit"]').click();
      assert.equal(
        await page.locator("#origin").getAttribute("aria-invalid"),
        "true",
        origin,
      );
      assert.equal(await page.locator("#config-result").isVisible(), false);
    }
    await validInputs(page);
    await page.locator("#account").fill("not-an-account");
    await page.locator('button[type="submit"]').click();
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      "account",
    );
    assert.equal(await page.locator("#account-error").isVisible(), true);
    await validInputs(page);
    await page.locator("#bucket").fill("parcel-");
    await page.locator('button[type="submit"]').click();
    assert.equal(
      await page.locator("#bucket").getAttribute("aria-invalid"),
      "true",
    );
    await validInputs(page);
    await page.locator('button[type="submit"]').click();
    assert.equal(await page.locator("#config-result").isVisible(), true);
    await page.locator("#cors-output").locator("..").focus();
    await page.keyboard.press("ArrowDown");
    await page.waitForFunction(
      () => document.querySelector("#cors-output").parentElement.scrollTop > 0,
    );
    const cors = JSON.parse(await page.locator("#cors-output").textContent());
    assert.deepEqual(cors[0].AllowedOrigins, ["https://parcel.example.com"]);
    assert.ok(cors[0].AllowedHeaders.includes("X-Amz-Meta-Parcel-Upload"));
    assert.match(
      await page.locator("#vars-output").textContent(),
      /R2_BUCKET_NAME=parcel-test[\s\S]*ACTIVE=false$/,
    );
    assert.match(
      await page.locator("#vars-output").textContent(),
      /\nADMIN_AUTH=totp\n/,
    );
    assert.equal(await page.locator("#admin-auth").count(), 0);
    assert.doesNotMatch(
      await page.locator("#vars-output").textContent(),
      /ACCESS_TEAM_DOMAIN|ACCESS_AUD|ADMIN_EMAILS/,
    );
    assert.match(
      await page.locator("#auth-config-help").textContent(),
      /ADMIN_SETUP_TOKEN/,
    );
    await page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value) => {
            window.copiedGuideConfig = value;
          },
        },
      }),
    );
    await page.locator('[data-copy="vars-output"]').click();
    await page.waitForFunction(() => window.copiedGuideConfig);
    assert.equal(
      await page.evaluate(() => window.copiedGuideConfig),
      await page.locator("#vars-output").textContent(),
    );
    assert.match(
      await page.locator('[data-copy="vars-output"]').textContent(),
      /已复制|Copied/,
    );
    const commandButton = page.locator('[data-copy="secret-command"]');
    await commandButton.click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-copy="secret-command"]').dataset
          .copyState === "copied",
    );
    assert.equal(
      await page.evaluate(() => window.copiedGuideConfig),
      `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`,
    );
    assert.match(await commandButton.textContent(), /已复制|Copied/);
    await page.waitForFunction(
      () =>
        !document.querySelector('[data-copy="secret-command"]').dataset
          .copyState,
    );
    assert.match(await commandButton.textContent(), /复制命令|Copy command/);
    await page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error("Denied");
          },
        },
      }),
    );
    await page.locator('[data-copy="cors-output"]').click();
    await page.waitForFunction(() =>
      window.getSelection().toString().startsWith("["),
    );
    assert.equal(
      await page.locator(".output-block .copy-message").first().isVisible(),
      true,
    );
    assert.match(
      await page.locator('[data-copy="cors-output"]').textContent(),
      /复制失败|Copy failed/,
    );
    await page.locator("#bucket").fill("other-bucket");
    assert.equal(await page.locator("#config-result").isVisible(), false);
    assert.match(
      await page.locator("#config-message").textContent(),
      /重新生成|again/,
    );
    assert.deepEqual(errors, []);
    await page.close();
  });

  test(`${label}: hero scroll motion preserves type and respects reduced motion`, async () => {
    const page = await browser.newPage({ reducedMotion: "no-preference" });
    await page.goto(`${baseURL}/${locale}`);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForFunction(
        () =>
          document
            .querySelector(".hero")
            .style.getPropertyValue("--hero-progress") === "0.0000",
      );
      const font = await page
        .locator(".hero-line")
        .first()
        .evaluate((el) => getComputedStyle(el).font);
      await page.evaluate(() => window.scrollTo(0, 140));
      await page.waitForFunction(
        () =>
          Number(
            document
              .querySelector(".hero")
              .style.getPropertyValue("--hero-progress"),
          ) > 0.1,
      );
      const lines = await page.locator(".hero-line").evaluateAll((elements) =>
        elements.map((el) => {
          const style = getComputedStyle(el);
          const matrix = new DOMMatrixReadOnly(style.transform);
          const rect = el.getBoundingClientRect();
          return {
            x: matrix.m41,
            y: matrix.m42,
            font: style.font,
            left: rect.left,
            right: rect.right,
          };
        }),
      );
      assert.ok(lines[0].x > 0 && lines[1].x < 0);
      assert.ok(lines[0].y < 0 && lines[1].y > 0);
      assert.equal(lines[0].font, font);
      assert.ok(
        lines.every((line) => line.left >= 0 && line.right <= width),
        `headline clipping at ${width}`,
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.evaluate(() => window.scrollTo(0, 440));
      await page.waitForFunction(
        () =>
          document
            .querySelector(".hero")
            .style.getPropertyValue("--hero-progress") === "1.0000",
      );
      assert.ok(
        await page.locator(".hero-line").evaluateAll((elements) =>
          elements.every((el) => {
            const rect = el.getBoundingClientRect();
            const matrix = new DOMMatrixReadOnly(
              getComputedStyle(el).transform,
            );
            return (
              rect.left >= 0 &&
              rect.right <= innerWidth &&
              matrix.m11 === 1 &&
              matrix.m22 === 1
            );
          }),
        ),
        `full travel clips or distorts type at ${width}`,
      );
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(
      () =>
        !document.querySelector(".hero").hasAttribute("data-scroll-motion") &&
        [...document.querySelectorAll(".hero-line")].every(
          (el) => getComputedStyle(el).transform === "none",
        ),
    );
    assert.equal(
      await page.locator(".hero").getAttribute("data-scroll-motion"),
      null,
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction(
      () =>
        document
          .querySelector(".hero")
          .style.getPropertyValue("--hero-progress") === "0.0000",
    );
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForFunction(
      () => !document.querySelector(".hero").hasAttribute("data-scroll-motion"),
    );
    await page.close();
  });

  test(`${label}: narrow layouts, keyboard navigation, reduced motion, and FAQ deep links`, async () => {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      reducedMotion: "reduce",
    });
    await page.goto(`${baseURL}/${locale}`);
    await page.keyboard.press("Tab");
    assert.equal(
      await page
        .locator(".skip-link")
        .evaluate((el) => el === document.activeElement),
      true,
    );
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "main");
    await page.locator("#variables pre").focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(
      () => document.querySelector("#variables pre").scrollLeft > 0,
    );
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        `overflow at ${width}`,
      );
      const wide = await page.evaluate(() =>
        [
          ...document.querySelectorAll(
            "main h1, main h2, main h3, main p, main figure, main pre, article, .guide-content",
          ),
        ]
          .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
          .map((el) => el.className || el.tagName),
      );
      assert.deepEqual(wide, [], `clipped content at ${width}`);
      const headlineLines = await page.locator(".hero h1").evaluate((el) => {
        const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight);
        return el.getBoundingClientRect().height / lineHeight;
      });
      assert.ok(
        Math.abs(headlineLines - 2) < 0.05,
        `hero headline must stay on two lines at ${width}`,
      );
    }
    assert.equal(
      await page.evaluate(
        () =>
          document
            .getAnimations()
            .filter((animation) => animation.playState === "running").length,
      ),
      0,
    );
    await page.goto(`${baseURL}/${locale}#faq-updates`);
    assert.equal(await page.locator("#faq-updates").getAttribute("open"), "");
    assert.ok(
      (
        await page.locator("[data-language-switch]").getAttribute("href")
      ).endsWith("#faq-updates"),
    );
    await page.locator("#faq-login-loop summary").click();
    await page.waitForURL(/#faq-login-loop$/);
    assert.equal(await page.locator("#faq-updates").getAttribute("open"), null);
    await page.close();
  });
}

test("without JavaScript the guide, chapter links, screenshots, and CORS example remain usable", async () => {
  const page = await browser.newPage({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  });
  for (const locale of ["index.html", "zh.html"]) {
    await page.goto(`${baseURL}/${locale}#config`);
    assert.equal(await page.locator("#config-form").isVisible(), false);
    assert.equal(await page.locator("noscript pre").isVisible(), true);
    assert.equal(
      await page.locator(".contents-disclosure").getAttribute("open"),
      "",
    );
    assert.ok(
      (await page.locator("noscript pre").textContent()).includes(
        "X-Amz-Meta-Parcel-Upload",
      ),
    );
    assert.equal(await page.locator("img").count(), 6);
  }
  await page.close();
});
