import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// Compare deployed bytes with Git blobs, independent of checkout line endings.
const root = fileURLToPath(new URL("../", import.meta.url));
const git = (...args) => execFileSync("git", args, { cwd: root });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const base = "https://parcel-guide.pages.dev";

try {
  assert.ok(
    process.argv.length <= 3,
    "Usage: node scripts/verify-guide-production.mjs [ref]",
  );
  const commit = git(
    "rev-parse",
    "--verify",
    `${process.argv[2] || "HEAD"}^{commit}`,
  )
    .toString()
    .trim();
  const files = git("ls-tree", "-r", "--name-only", "-z", commit, "docs/site/")
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((path) => path.slice("docs/site/".length))
    .filter((path) =>
      /^(?:index\.html|zh\.html|404\.html|style\.css|guide\.js|_headers|images\/[a-z0-9-]+\.webp)$/.test(
        path,
      ),
    );
  for (const path of [
    "index.html",
    "zh.html",
    "404.html",
    "style.css",
    "guide.js",
    "_headers",
  ])
    assert.ok(files.includes(path), `Missing committed guide file: ${path}`);
  const blob = (path) => git("show", `${commit}:docs/site/${path}`);
  const headers = blob("_headers")
    .toString()
    .split(/\r?\n/)
    .filter((line) => /^\s+[^:]+:/.test(line))
    .map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    });
  const results = [];
  for (const path of files.filter((file) => file !== "_headers")) {
    const response = await fetch(`${base}/${path}?verify=${commit}`, {
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200, `${path}: HTTP status`);
    const expected = digest(blob(path));
    const actual = digest(Buffer.from(await response.arrayBuffer()));
    assert.equal(
      actual,
      expected,
      `${path}: deployed content differs from ${commit}`,
    );
    if (path === "index.html")
      for (const [name, value] of headers)
        assert.equal(
          response.headers.get(name),
          value,
          `${name}: deployed header differs`,
        );
    results.push({ path, sha256: actual });
  }
  const missing = await fetch(`${base}/guide-verification-missing-${commit}`, {
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(missing.status, 404, "Missing page must return HTTP 404");
  assert.equal(
    digest(Buffer.from(await missing.arrayBuffer())),
    digest(blob("404.html")),
    "Deployed 404 differs from Git",
  );
  console.log(
    JSON.stringify(
      {
        commit,
        base,
        assets: results.length,
        headers: headers.length,
        notFound: "matches",
        results,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
