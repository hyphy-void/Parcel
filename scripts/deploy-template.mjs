import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export function templateDeployment(config) {
  const db = config.d1_databases?.find((b) => b.binding === "DB");
  const bucket = config.r2_buckets?.find((b) => b.binding === "FILES");
  if (
    !db?.database_id ||
    db.database_id === "00000000-0000-0000-0000-000000000000"
  ) {
    throw new Error(
      "Provision the DB binding using Deploy to Cloudflare before deploying; for CLI bootstrap use npm run deploy:bootstrap -- --config PATH.",
    );
  }
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(bucket?.bucket_name || "")) {
    throw new Error("Configure the FILES R2 bucket binding.");
  }
  return [
    [
      "d1",
      "migrations",
      "apply",
      "DB",
      "--remote",
      "--config",
      "wrangler.json",
    ],
    [
      "deploy",
      "--config",
      "wrangler.json",
      "--keep-vars",
      "--var",
      "ADMIN_AUTH:totp",
      "--var",
      `R2_BUCKET_NAME:${bucket.bucket_name}`,
    ],
  ];
}

async function run(args) {
  await new Promise((accept, reject) => {
    const child = spawn(
      process.execPath,
      [
        resolve(root, "cloudflare/node_modules/wrangler/bin/wrangler.js"),
        ...args,
      ],
      { cwd: root, stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? accept()
        : reject(
            new Error(
              "Cloudflare template deployment failed; correct the reported error and retry.",
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
    // Preserve the existing explicit CLI bootstrap and migration interface.
    if (process.argv.length > 2) {
      await import("./deploy-v3.mjs").then((m) => m.main());
    } else {
      const config = JSON.parse(
        await readFile(resolve(root, "wrangler.json"), "utf8"),
      );
      for (const command of templateDeployment(config)) await run(command);
      console.log(
        "Worker deployed with password + TOTP login. Configure secrets, PUBLIC_URL and R2 CORS; use npm run admin:setup-token to create the temporary ADMIN_SETUP_TOKEN secret, open /login to set a password and bind your authenticator, save recovery codes and remove the setup secret, then set ACTIVE=true. See the deployment guide.",
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
