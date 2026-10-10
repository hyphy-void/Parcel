#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename, chmod } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export class CloudflareAPI {
  constructor(account, token, fetcher = fetch) {
    this.account = account;
    this.token = token;
    this.fetcher = fetcher;
  }
  async request(path, method = "GET", body, missing = false) {
    let response;
    try {
      response = await this.fetcher(
        `https://api.cloudflare.com/client/v4/accounts/${this.account}${path}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
          redirect: "error",
        },
      );
    } catch {
      throw new Error(
        `Cloudflare ${method} request failed; no credentials or response body are logged`,
      );
    }
    if (missing && response.status === 404) return null;
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`Cloudflare returned invalid JSON (${response.status})`);
    }
    if (!response.ok || !data.success)
      throw new Error(
        `Cloudflare ${method} ${path.split("?")[0]} failed (${response.status}; codes ${(
          data.errors || []
        )
          .map((e) => e.code)
          .filter(Number.isInteger)
          .join(",")})`,
      );
    return data.result;
  }
  async list(path) {
    const all = [];
    for (let page = 1; page <= 100; page++) {
      const rows = await this.request(`${path}?page=${page}&per_page=100`);
      if (!Array.isArray(rows))
        throw new Error("Cloudflare resource list has an unexpected shape");
      all.push(...rows);
      if (rows.length < 100) return all;
    }
    throw new Error(
      "Resource list exceeds bootstrap limit; select resources explicitly",
    );
  }
}
export function validate(input) {
  const c = {
    name: "parcel-v3",
    databaseName: "parcel-v3",
    bucketName: "parcel-v3",
    adminEmails: [],
    workersPaid: false,
    active: false,
    ...input,
  };
  for (const key of ["name", "databaseName", "bucketName"])
    if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(c[key]))
      throw new Error(`Invalid ${key}`);
  if (!/^[a-f0-9]{32}$/.test(c.accountId || ""))
    throw new Error("Set accountId in the deployment config");
  if (
    !Array.isArray(c.adminEmails) ||
    !c.adminEmails.length ||
    c.adminEmails.some(
      (e) => typeof e !== "string" || !/^\S+@[^\s@,]+$/.test(e),
    )
  )
    throw new Error("Set an explicit administrator email allowlist");
  if (c.publicUrl) {
    const u = new URL(c.publicUrl);
    if (
      u.origin !== c.publicUrl ||
      u.protocol !== "https:" ||
      u.port ||
      u.username ||
      u.password
    )
      throw new Error("publicUrl must be an HTTPS origin");
  }
  if (
    c.teamDomain &&
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(c.teamDomain)
  )
    throw new Error("Invalid Access teamDomain");
  for (const key of [
    "workersPaid",
    "active",
    "allowExistingBucket",
    "allowExistingDatabase",
  ])
    if (c[key] !== undefined && typeof c[key] !== "boolean")
      throw new Error(`${key} must be boolean`);
  const allowedVars = [
    "STORAGE_QUOTA_BYTES",
    "MAX_FILE_BYTES",
    "MAX_SHARE_TTL_SECONDS",
    "DEFAULT_SHARE_TTL_SECONDS",
    "DEFAULT_DOWNLOAD_LIMIT",
    "DOWNLOAD_MAX_TTL_SECONDS",
    "UPLOAD_IDLE_TTL_SECONDS",
    "CLEANUP_BATCH_SIZE",
  ];
  if (
    c.vars &&
    Object.entries(c.vars).some(
      ([k, v]) => !allowedVars.includes(k) || !/^[1-9][0-9]*$/.test(v),
    )
  )
    throw new Error(
      "vars only accepts documented positive numeric limits, never secrets",
    );
  const ranges = {
    STORAGE_QUOTA_BYTES: [1, Number.MAX_SAFE_INTEGER],
    MAX_FILE_BYTES: [1, 16777216 * 10000],
    MAX_SHARE_TTL_SECONDS: [1, 31536000],
    DEFAULT_SHARE_TTL_SECONDS: [
      1,
      Number(c.vars?.MAX_SHARE_TTL_SECONDS || 604800),
    ],
    DEFAULT_DOWNLOAD_LIMIT: [1, 100],
    DOWNLOAD_MAX_TTL_SECONDS: [300, 86400],
    UPLOAD_IDLE_TTL_SECONDS: [300, 604800],
    CLEANUP_BATCH_SIZE: [1, c.workersPaid ? 30 : 1],
  };
  for (const [key, value] of Object.entries(c.vars || {})) {
    const n = Number(value),
      [min, max] = ranges[key];
    if (!Number.isSafeInteger(n) || n < min || n > max)
      throw new Error(`Invalid limit: ${key}`);
  }
  if (
    Number(c.vars?.DEFAULT_SHARE_TTL_SECONDS || 86400) >
    Number(c.vars?.MAX_SHARE_TTL_SECONDS || 604800)
  )
    throw new Error("Default share TTL exceeds maximum TTL");
  return c;
}
export function plan(c) {
  return {
    name: c.name,
    database: c.databaseName,
    bucket: c.bucketName,
    publicUrl: c.publicUrl || "derived from existing Workers subdomain",
    adminEmails: c.adminEmails,
    active: c.active,
    requires: [
      "Cloudflare account API token: Workers Scripts, D1, R2, Access Apps and Policies, Access Organizations/Identity Providers",
      "Bucket-scoped R2 S3 credentials",
      "Existing Zero Trust organization and Workers subdomain",
      "Workers Free or Paid; browser Argon2id with encrypted server verifiers",
    ],
    actions: [
      "Create/reuse D1",
      "Create private R2 bucket",
      "Merge managed CORS and multipart-abort lifecycle rules",
      "Create isolated administrator Access application",
      "Apply D1 migrations",
      "Deploy maintenance Worker and upload secrets",
      c.active
        ? "Activate and verify public API"
        : "Keep maintenance until migration/cutover",
    ],
    preserves: [
      "Existing Pages/Origin deployment and domains",
      "Existing R2 rules",
      "Stored session secret",
    ],
  };
}
export async function resources(c, api, state = {}, save = async () => {}) {
  const subdomain = await api.request("/workers/subdomain");
  if (!subdomain?.subdomain)
    throw new Error("Register your Workers subdomain before bootstrap");
  const publicUrl =
    c.publicUrl || `https://${c.name}.${subdomain.subdomain}.workers.dev`;
  if (publicUrl !== `https://${c.name}.${subdomain.subdomain}.workers.dev`)
    throw new Error(
      "Initial automated deployment requires this Worker's isolated workers.dev URL; custom-domain cutover follows verified migration",
    );
  const organization = await api.request("/access/organizations");
  const teamDomain = c.teamDomain || `https://${organization.auth_domain}`;
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain))
    throw new Error("Create a Zero Trust organization before bootstrap");
  const idps = await api.list("/access/identity_providers");
  if (!idps.length)
    await api.request("/access/identity_providers", "POST", {
      name: "Parcel email code",
      type: "onetimepin",
      config: {},
    });
  const databases = await api.list("/d1/database");
  const matches = databases.filter((d) => d.name === c.databaseName);
  if (matches.length > 1) throw new Error("Ambiguous D1 database name");
  if (
    matches[0] &&
    state.databaseId !== matches[0].uuid &&
    c.databaseId !== matches[0].uuid &&
    !c.allowExistingDatabase
  )
    throw new Error(
      "Existing D1 database is not recorded as managed; review it before allowExistingDatabase",
    );
  const db =
    matches[0] ||
    (await api.request("/d1/database", "POST", { name: c.databaseName }));
  state.databaseId = db.uuid;
  await save(state);
  let bucket = await api.request(
    `/r2/buckets/${c.bucketName}`,
    "GET",
    undefined,
    true,
  );
  if (bucket && !c.allowExistingBucket && state.bucketName !== c.bucketName)
    throw new Error(
      "Existing bucket is not recorded as managed. Set allowExistingBucket only after reviewing ownership/migration",
    );
  if (!bucket) await api.request("/r2/buckets", "POST", { name: c.bucketName });
  state.bucketName = c.bucketName;
  await save(state);
  for (const [kind, rule] of [
    [
      "cors",
      {
        id: "parcel-v3-browser",
        allowed: {
          origins: [publicUrl],
          methods: ["GET", "HEAD", "PUT"],
          headers: ["Content-Type", "Range"],
        },
        exposeHeaders: [
          "ETag",
          "Content-Length",
          "Content-Range",
          "Accept-Ranges",
        ],
        maxAgeSeconds: 3600,
      },
    ],
    [
      "lifecycle",
      {
        id: "parcel-v3-abort-multipart",
        enabled: true,
        conditions: { prefix: "parcel/v3/" },
        abortMultipartUploadsTransition: {
          condition: {
            type: "Age",
            maxAge: Math.max(
              86400,
              Number(c.vars?.UPLOAD_IDLE_TTL_SECONDS || 86400) + 300,
            ),
          },
        },
      },
    ],
  ]) {
    const path = `/r2/buckets/${c.bucketName}/${kind}`,
      existing = await api.request(path, "GET", undefined, true);
    const rules = existing?.rules || [];
    const next = { rules: [...rules.filter((r) => r.id !== rule.id), rule] };
    if (JSON.stringify(existing) !== JSON.stringify(next))
      await api.request(path, "PUT", next);
  }
  const name = `${c.name} administrator`,
    host = new URL(publicUrl).host;
  const destinations = [
    "/login",
    "/admin",
    "/admin/*",
    "/api/v1/auth/*",
    "/api/v1/admin/*",
    "/api/v1/uploads",
    "/api/v1/uploads/*",
  ].map((path) => ({ type: "public", uri: host + path }));
  const apps = await api.list("/access/apps"),
    found = apps.filter((a) => a.name === name);
  if (found.length > 1) throw new Error("Ambiguous managed Access application");
  const existing = found[0];
  if (existing && (state.accessAppId || c.accessAppId) !== existing.id)
    throw new Error(
      "Access application name already exists outside this bootstrap state; choose another Worker name",
    );
  const appBody = {
    name,
    type: "self_hosted",
    destinations,
    session_duration: "12h",
    app_launcher_visible: false,
    auto_redirect_to_identity: false,
    policies: [
      {
        name: "Parcel administrators",
        decision: "allow",
        precedence: 1,
        include: c.adminEmails.map((email) => ({ email: { email } })),
      },
    ],
  };
  const app = await api.request(
    existing ? `/access/apps/${existing.id}` : "/access/apps",
    existing ? "PUT" : "POST",
    appBody,
  );
  if (!app.aud || !app.id)
    throw new Error("Access application response is missing audience/id");
  state.accessAppId = app.id;
  state.publicUrl = publicUrl;
  await save(state);
  return { databaseId: db.uuid, publicUrl, teamDomain, accessAud: app.aud };
}
async function privateJSON(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + ".next";
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}
async function readJSON(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT" && fallback !== undefined) return fallback;
    if (/credentials|secrets/.test(path))
      throw new Error(
        "Private credentials JSON is invalid or unreadable; inspect it locally without printing secret values",
      );
    throw e;
  }
}
export async function localCredentials(name) {
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(name))
    throw new Error("Invalid Worker name");
  const supplied = await readJSON(
    resolve(root, ".parcel-v3/cloudflare-credentials.json"),
    {},
  );
  const stored = await readJSON(
    resolve(root, ".parcel-v3", name, "secrets.json"),
    {},
  );
  return Object.fromEntries(
    [
      "CLOUDFLARE_API_TOKEN",
      "SESSION_SECRET",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
    ].map((key) => [key, process.env[key] || supplied[key] || stored[key]]),
  );
}
export async function runWrangler(args, { input, env = process.env } = {}) {
  // Secret contents use stdin; arguments and diagnostics contain no secret values.
  await new Promise((accept, reject) => {
    const child = spawn(
      process.execPath,
      [
        resolve(root, "cloudflare/node_modules/wrangler/bin/wrangler.js"),
        ...args,
      ],
      {
        cwd: root,
        env: { ...env, WRANGLER_SEND_METRICS: "false" },
        stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (b) => {
      output = (output + b).slice(-16000);
    });
    child.stderr.on("data", (b) => {
      output = (output + b).slice(-16000);
    });
    child.on("error", () => reject(new Error("Unable to start Wrangler")));
    child.on("exit", (code) =>
      code === 0
        ? accept()
        : reject(
            new Error(
              `Wrangler ${args[0]} failed (${code}); inspect Cloudflare permissions/config. Output withheld to avoid credential leakage.`,
            ),
          ),
    );
    if (input) {
      child.stdin.on("error", () =>
        reject(new Error("Wrangler could not read the secret input")),
      );
      child.stdin.end(input);
    }
  });
}
async function main() {
  const args = process.argv.slice(2),
    configIndex = args.indexOf("--config");
  if (
    configIndex >= 0 &&
    (!args[configIndex + 1] || args[configIndex + 1].startsWith("--"))
  )
    throw new Error("--config requires a file path");
  const path = resolve(
    configIndex >= 0 ? args[configIndex + 1] : ".parcel-v3/deploy.json",
  );
  if (
    args.some(
      (a, i) =>
        !["--config", "--plan", "--activate"].includes(a) &&
        !(configIndex >= 0 && i === configIndex + 1),
    )
  )
    throw new Error(
      "Usage: node scripts/deploy-v3.mjs --config PATH [--plan] [--activate]",
    );
  const c = validate(await readJSON(path));
  if (args.includes("--activate")) c.active = true;
  if (args.includes("--plan")) {
    console.log(JSON.stringify(plan(c), null, 2));
    return;
  }
  const supplied = await readJSON(
    resolve(root, ".parcel-v3/cloudflare-credentials.json"),
    {},
  );
  const token =
    process.env.CLOUDFLARE_API_TOKEN || supplied.CLOUDFLARE_API_TOKEN;
  if (!token)
    throw new Error(
      "Set CLOUDFLARE_API_TOKEN locally or in CI; do not paste it into chat",
    );
  const folder = resolve(root, ".parcel-v3", c.name),
    statePath = resolve(folder, "state.json"),
    secretPath = resolve(folder, "secrets.json");
  const state = await readJSON(statePath, {}),
    stored = await readJSON(secretPath, {});
  if (state.accountId && state.accountId !== c.accountId)
    throw new Error("State belongs to another Cloudflare account");
  state.accountId = c.accountId;
  const secrets = {
    SESSION_SECRET:
      process.env.SESSION_SECRET ||
      supplied.SESSION_SECRET ||
      stored.SESSION_SECRET,
    R2_ACCESS_KEY_ID:
      process.env.R2_ACCESS_KEY_ID ||
      supplied.R2_ACCESS_KEY_ID ||
      stored.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY:
      process.env.R2_SECRET_ACCESS_KEY ||
      supplied.R2_SECRET_ACCESS_KEY ||
      stored.R2_SECRET_ACCESS_KEY,
  };
  const hasR2 = [secrets.R2_ACCESS_KEY_ID, secrets.R2_SECRET_ACCESS_KEY].every(
    (v) =>
      typeof v === "string" && v.length > 0 && v.length <= 256 && !/\s/.test(v),
  );
  if (
    [secrets.R2_ACCESS_KEY_ID, secrets.R2_SECRET_ACCESS_KEY].some(Boolean) &&
    !hasR2
  )
    throw new Error("Provide both valid R2 S3 credential fields");
  if (!secrets.SESSION_SECRET) {
    if (state.deployed)
      throw new Error(
        "Existing deployment needs its original SESSION_SECRET; refusing implicit session rotation",
      );
    secrets.SESSION_SECRET = randomBytes(32).toString("hex");
  }
  if (!/^[a-fA-F0-9]{64}$/.test(secrets.SESSION_SECRET))
    throw new Error("SESSION_SECRET must be 64 hex characters");
  await privateJSON(secretPath, secrets);
  await new Promise((accept, reject) => {
    const child = spawn("bash", [resolve(root, "scripts/build-v3.sh")], {
      cwd: root,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? accept()
        : reject(
            new Error("V3 build failed before Cloudflare resource changes"),
          ),
    );
  });
  const api = new CloudflareAPI(c.accountId, token),
    r = await resources(c, api, state, (s) => privateJSON(statePath, s));
  const template = await readJSON(resolve(root, "wrangler.json"));
  const config = {
    ...template,
    name: c.name,
    account_id: c.accountId,
    main: resolve(root, "cloudflare/v3/worker.mjs"),
    assets: { ...template.assets, directory: resolve(root, "dist/v3-web") },
    d1_databases: [
      {
        binding: "DB",
        database_name: c.databaseName,
        database_id: r.databaseId,
        migrations_dir: resolve(root, "cloudflare/v3/migrations"),
      },
    ],
    r2_buckets: [{ binding: "FILES", bucket_name: c.bucketName }],
    ...(c.workersPaid ? { limits: { cpu_ms: 30000 } } : {}),
    vars: {
      ...template.vars,
      ...c.vars,
      PUBLIC_URL: r.publicUrl,
      ACCESS_TEAM_DOMAIN: r.teamDomain,
      ACCESS_AUD: r.accessAud,
      ADMIN_EMAILS: c.adminEmails.join(","),
      R2_ENDPOINT: `https://${c.accountId}.r2.cloudflarestorage.com`,
      R2_BUCKET_NAME: c.bucketName,
      WORKERS_PLAN: c.workersPaid ? "paid" : "free",
      CLEANUP_BATCH_SIZE: String(
        c.vars?.CLEANUP_BATCH_SIZE || (c.workersPaid ? 30 : 1),
      ),
      ACTIVE: "false",
      MAINTENANCE_SINCE: String(Math.floor(Date.now() / 1000)),
    },
  };
  const wrangle = (args, options = {}) =>
    runWrangler(args, {
      ...options,
      env: { ...process.env, CLOUDFLARE_API_TOKEN: token },
    });
  const generated = resolve(folder, "wrangler.json");
  await privateJSON(generated, config);
  if (!hasR2)
    throw new Error(
      `Isolated D1/R2/Access resources are ready. Create an Object Read & Write S3 token scoped to bucket ${c.bucketName}, fill the local credentials JSON, then rerun the same deployment command. No Worker was deployed.`,
    );
  await wrangle([
    "d1",
    "migrations",
    "apply",
    "DB",
    "--remote",
    "--config",
    generated,
  ]);
  await wrangle(["deploy", "--config", generated]);
  state.deployed = true;
  await privateJSON(statePath, state);
  await wrangle(["secret", "bulk", "--config", generated], {
    input: JSON.stringify(secrets),
  });
  if (c.active) {
    config.vars.ACTIVE = "true";
    config.vars.MAINTENANCE_SINCE = "0";
    await privateJSON(generated, config);
    await wrangle(["deploy", "--config", generated]);
  }
  const probe = await fetch(`${r.publicUrl}/api/v1/shares/${"a".repeat(32)}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
  const data = await probe.json();
  if (
    probe.status !== (c.active ? 404 : 503) ||
    data.code !== (c.active ? "not_found" : "maintenance")
  )
    throw new Error(
      "Deployment public API probe failed; inspect deployment before switching any domains",
    );
  state.active = c.active;
  await privateJSON(statePath, state);
  console.log(
    `V3 deployed and public API verified: ${r.publicUrl}. Existing Pages/Go deployment remains in place.`,
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
