import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const base = new URL(
  process.env.PARCEL_E2E_BASE_URL || "http://127.0.0.1:18280",
);
const data = mkdtempSync(join(root, ".parcel-e2e-"));
const env = {
  ...process.env,
  PARCEL_DATA_DIR: data,
  PARCEL_LISTEN_ADDR: base.host,
  PARCEL_BASE_URL: base.origin,
  PARCEL_REQUIRED_MOUNT: "",
  PARCEL_CLEANUP_INTERVAL: "1s",
  PARCEL_MIN_FREE_BYTES: "0",
};
const binary = join(root, "bin/parcel");
const init = spawnSync(binary, ["admin-password", "--password-stdin"], {
  env,
  input: "e2e-admin-password\n",
  encoding: "utf8",
});
if (init.status !== 0) throw new Error(init.stderr);
const server = spawn(binary, ["serve"], { env, stdio: "inherit" });
function stop(signal) {
  server.kill(signal);
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGTERM"));
server.on("exit", (code) => {
  rmSync(data, { recursive: true, force: true });
  process.exit(code || 0);
});
