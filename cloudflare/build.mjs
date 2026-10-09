import { build } from "esbuild";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist/pages");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(
  resolve(root, process.env.PARCEL_PAGES_WEB_DIR || "dist/pages-web"),
  output,
  { recursive: true },
);
await build({
  entryPoints: [resolve(root, "cloudflare/gateway.mjs")],
  outfile: resolve(output, "_worker.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
});
await writeFile(
  resolve(output, "_routes.json"),
  JSON.stringify({ version: 1, include: ["/*"], exclude: [] }, null, 2) + "\n",
);
// Safe also when the same package is used with Workers Static Assets.
await writeFile(
  resolve(output, ".assetsignore"),
  "_worker.js\n_routes.json\n.assetsignore\n",
);
console.log(
  "Built dist/pages: frontend + API gateway (no credentials included).",
);
