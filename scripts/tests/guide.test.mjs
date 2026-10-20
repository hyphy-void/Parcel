import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const html = await readFile(resolve(root, "docs/site/index.html"), "utf8");
test("published guide ships every screenshot as a WebP with a real file", async () => {
  const sources = [...html.matchAll(/<img\s[^>]*src="([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.equal(sources.length, 6);
  for (const src of sources) {
    assert.match(src, /^images\/[a-z0-9-]+\.webp$/);
    assert.ok((await stat(resolve(root, "docs/site", src))).size > 0);
  }
});
test("both languages offer only password and TOTP enrollment", async () => {
  for (const locale of ["index.html", "zh.html"]) {
    const source = await readFile(resolve(root, "docs/site", locale), "utf8");
    assert.doesNotMatch(
      source,
      /id="access"|href="#access"|Cloudflare Access|ACCESS_TEAM_DOMAIN|ACCESS_AUD|ADMIN_EMAILS|id="admin-auth"|images\/(?:access|variables)\.webp/,
    );
    assert.match(source, /ADMIN_AUTH=totp/);
    assert.match(source, /ADMIN_SETUP_TOKEN/);
    assert.match(source, /data-e2ee-flow/);
    assert.match(source, /e2ee-sender/);
    assert.match(source, /e2ee-recipient/);
  }
});

test("both languages explain the actual file and password protection and native enrollment", async () => {
  for (const locale of ["index.html", "zh.html"]) {
    const source = (
      await readFile(resolve(root, "docs/site", locale), "utf8")
    ).replace(/\s+/g, " ");
    assert.match(source, /id="security"/);
    assert.match(source, /Argon2id/);
    assert.match(source, /AES-GCM/);
    assert.doesNotMatch(
      source,
      /It is not end-to-end encryption|这不是端到端加密/,
    );
    assert.match(source, /Cloudflare V3/);
    assert.match(source, /16 MiB/);
    assert.match(source, /HKDF/);
    assert.match(source, /32-byte|32 字节/);
    assert.match(source, /28 extra bytes|28 字节/);
    assert.match(source, /id="encrypted-sharing"/);
    assert.match(source, /IndexedDB/);
    assert.match(source, /SHA-256/);
    assert.match(source, /#k=…/);
    assert.match(source, /Go/);
    assert.match(source, /malware|恶意程序/);
    assert.match(source, /id="faq-screenshots"/);
    assert.match(source, /id="totp"/);
    assert.match(source, /ADMIN_SETUP_TOKEN/);
    assert.match(source, /X-Amz-Meta-Parcel-Upload/);
    assert.doesNotMatch(source, /otpauth:\/\//);
  }
});

test("E2EE guidance covers key loss, storage limits and the incompatible upgrade", async () => {
  const english = (
    await readFile(resolve(root, "docs/site/index.html"), "utf8")
  ).replace(/\s+/g, " ");
  const chinese = (
    await readFile(resolve(root, "docs/site/zh.html"), "utf8")
  ).replace(/\s+/g, " ");
  assert.match(english, /unrecoverable by the server/);
  assert.match(english, /twice the file size/);
  assert.match(english, /storage quotas/);
  assert.match(english, /does not delete existing D1 or R2/);
  assert.match(chinese, /服务器无法恢复/);
  assert.match(chinese, /两倍文件大小/);
  assert.match(chinese, /浏览器配额/);
  assert.match(chinese, /升级不会删除现有 D1 或 R2 数据/);
  const operations = await readFile(
    resolve(root, "docs/v3-deployment.md"),
    "utf8",
  );
  assert.match(operations, /0004_e2ee\.sql/);
  assert.match(operations, /0005_download_admissions\.sql/);
  assert.match(operations, /新版 E2EE 分享不能导出为 Go 可读分享/);
});
