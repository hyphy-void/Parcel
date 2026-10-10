import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
await mkdir(root + "dist/v3", { recursive: true });
await build({
  entryPoints: [root + "cloudflare/v3/worker.mjs"],
  outfile: root + "dist/v3/worker.mjs",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
});
console.log(
  "Built V3 Worker. D1/R2 bindings and secrets are configured at deployment.",
);
