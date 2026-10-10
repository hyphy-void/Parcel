import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));

export function buildConfig(template, settings) {
  const allowed = [
    "accountId",
    "workerName",
    "databaseId",
    "databaseName",
    "bucketName",
  ];
  if (
    !settings ||
    typeof settings !== "object" ||
    Array.isArray(settings) ||
    Object.keys(settings).some((key) => !allowed.includes(key))
  )
    throw new Error(
      "PARCEL_WORKER_BUILD_CONFIG must contain only resource identifiers",
    );
  if (!/^[a-f0-9]{32}$/.test(settings.accountId || ""))
    throw new Error("Configure a valid accountId");
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      settings.databaseId || "",
    ) ||
    settings.databaseId === "00000000-0000-0000-0000-000000000000"
  )
    throw new Error("Configure the existing production databaseId");
  for (const key of ["workerName", "databaseName", "bucketName"])
    if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(settings[key] || ""))
      throw new Error(`Configure a valid ${key}`);
  const config = structuredClone(template);
  // Runtime configuration stays on the existing Worker. Never upload template vars.
  delete config.vars;
  config.keep_vars = true;
  config.account_id = settings.accountId;
  config.name = settings.workerName;
  config.workers_dev = false;
  config.preview_urls = false;
  config.main = resolve(root, "cloudflare/v3/worker.mjs");
  config.assets.directory = resolve(root, "dist/v3-web");
  config.d1_databases = [
    {
      binding: "DB",
      database_name: settings.databaseName,
      database_id: settings.databaseId,
      migrations_dir: resolve(root, "cloudflare/v3/migrations"),
    },
  ];
  config.r2_buckets = [{ binding: "FILES", bucket_name: settings.bucketName }];
  return config;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const raw = process.env.PARCEL_WORKER_BUILD_CONFIG;
    if (!raw)
      throw new Error(
        "Set PARCEL_WORKER_BUILD_CONFIG in Cloudflare build variables",
      );
    let settings;
    try {
      settings = JSON.parse(raw);
    } catch {
      throw new Error("PARCEL_WORKER_BUILD_CONFIG must be valid JSON");
    }
    const template = JSON.parse(
      await readFile(resolve(root, "wrangler.json"), "utf8"),
    );
    const config = buildConfig(template, settings);
    await mkdir(resolve(root, ".parcel-v3"), { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(root, ".parcel-v3/wrangler.builds.json"),
      JSON.stringify(config, null, 2) + "\n",
      { mode: 0o600 },
    );
    console.log(
      "Prepared production Worker config; runtime variables and secrets are retained.",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
