import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const configPath = ".parcel-v3/wrangler.builds.json";

export function productionDeployment(config) {
  const db = config.d1_databases?.find((b) => b.binding === "DB");
  const bucket = config.r2_buckets?.find((b) => b.binding === "FILES");
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      db?.database_id || "",
    ) ||
    db.database_id === "00000000-0000-0000-0000-000000000000" ||
    !db.migrations_dir ||
    !/^[a-z0-9][a-z0-9-]{2,62}$/.test(bucket?.bucket_name || "") ||
    config.vars !== undefined ||
    config.keep_vars !== true ||
    config.workers_dev !== false ||
    config.preview_urls !== false
  )
    throw new Error(
      "Run npm run build:production with the existing production resource identifiers first.",
    );
  return [
    ["d1", "migrations", "apply", "DB", "--remote", "--config", configPath],
    [
      "deploy",
      "--config",
      configPath,
      "--keep-vars",
      "--var",
      "ADMIN_AUTH:totp",
      "--no-x-auto-create",
    ],
  ];
}

export async function deployProduction(config, execute = run) {
  for (const command of productionDeployment(config)) await execute(command);
}

async function run(args) {
  await new Promise((accept, reject) => {
    const child = spawn(
      process.execPath,
      [
        resolve(root, "cloudflare/node_modules/wrangler/bin/wrangler.js"),
        ...args,
      ],
      // CI skips Wrangler's interactive migration prompt in Workers Builds.
      { cwd: root, stdio: "inherit", env: { ...process.env, CI: "true" } },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? accept()
        : reject(
            new Error(
              args[0] === "d1"
                ? "D1 migration failed; Worker deployment was not started. Check the migration diagnostics and D1 write permission, then retry the same command."
                : "Worker deployment failed after D1 migration. The migration preserves existing data; retry the same command.",
            ),
          ),
    );
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const config = JSON.parse(
      await readFile(resolve(root, configPath), "utf8"),
    );
    await deployProduction(config);
    console.log(
      "D1 migrations applied and Worker deployed with password + TOTP login; other Dashboard runtime variables and secrets retained.",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
