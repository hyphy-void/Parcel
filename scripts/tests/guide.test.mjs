import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { route } from "../../cloudflare/gateway.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const html = await readFile(resolve(root, "docs/site/index.html"), "utf8");
test("published guide ships every screenshot as a WebP with a real file", async () => {
  const sources = [...html.matchAll(/<img\s[^>]*src="([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.ok(sources.length >= 7);
  for (const src of sources) {
    assert.match(src, /^images\/[a-z0-9-]+\.webp$/);
    assert.ok((await stat(resolve(root, "docs/site", src))).size > 0);
  }
});
test("the guide protects every current administrator API family including the auth session", () => {
  const id = "a".repeat(32);
  for (const [path, method] of [
    ["/api/v1/auth/session", "GET"],
    ["/api/v1/auth/logout", "POST"],
    ["/api/v1/admin/status", "GET"],
    ["/api/v1/admin/shares", "GET"],
    ["/api/v1/uploads", "POST"],
    [`/api/v1/uploads/${id}`, "GET"],
  ]) {
    assert.equal(route(path, method).admin, true);
    const required =
      path === "/api/v1/uploads"
        ? path
        : path.startsWith("/api/v1/uploads/")
          ? "/api/v1/uploads/*"
          : path.startsWith("/api/v1/auth/")
            ? "/api/v1/auth/*"
            : "/api/v1/admin/*";
    assert.ok(html.includes(required), `Missing Access path ${required}`);
  }
});
