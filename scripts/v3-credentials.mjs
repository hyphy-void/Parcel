import {
  lstat,
  readFile,
  mkdir,
  chmod,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CREDENTIAL_FIELDS = [
  "CLOUDFLARE_API_TOKEN",
  "SESSION_SECRET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
];
export const credentialsPath = (root = projectRoot) =>
  resolve(root, ".parcel-v3/cloudflare-credentials.json");

function validate(values) {
  if (!values || typeof values !== "object" || Array.isArray(values))
    throw new Error("Credentials must be a JSON object");
  const result = {};
  for (const [key, value] of Object.entries(values)) {
    if (!CREDENTIAL_FIELDS.includes(key))
      throw new Error("Credentials contain an unsupported field");
    if (value === "" || value === undefined) continue;
    if (
      typeof value !== "string" ||
      !value ||
      value.length > 256 ||
      /\s/.test(value) ||
      (key === "SESSION_SECRET" && !/^[a-fA-F0-9]{64}$/.test(value))
    )
      throw new Error(`Invalid credential field: ${key}`);
    result[key] = value;
  }
  return result;
}

// Kept for explicit Go-format R2 probe files; maintained V3 tools use JSON.
function legacyR2(raw) {
  const result = {};
  let pending;
  for (let line of raw.split("\n")) {
    line = line.trim();
    if (!line) continue;
    const label = [
      "Access Key ID",
      "Secret Access Key",
      "ACCESS_KEY_ID",
      "SECRET_ACCESS_KEY",
    ].find((v) => line.startsWith(v));
    if (label) {
      pending = label;
      line = line
        .slice(label.length)
        .trim()
        .replace(/^[:：=]+/, "")
        .trim();
      if (!line) continue;
    }
    if (!pending) continue;
    result[
      ["Access Key ID", "ACCESS_KEY_ID"].includes(pending)
        ? "R2_ACCESS_KEY_ID"
        : "R2_SECRET_ACCESS_KEY"
    ] = line;
    pending = undefined;
  }
  return result;
}

async function readCredentials(
  path,
  { optional = false, allowLegacyR2 = false } = {},
) {
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.mode & 0o077 || st.size > 16384)
      throw new Error("Use a regular private credential file with mode 0600");
    const raw = await readFile(path, "utf8");
    return validate(
      allowLegacyR2 && !raw.trim().startsWith("{")
        ? legacyR2(raw)
        : JSON.parse(raw),
    );
  } catch (error) {
    if (optional && error.code === "ENOENT") return {};
    // JSON parser errors can quote the input. Never forward them.
    throw new Error(
      "Cannot read credentials: use valid JSON in a regular 0600 file",
    );
  }
}

export async function loadCredentials({
  root = projectRoot,
  env = process.env,
  path,
  allowLegacyR2 = false,
  required = [],
} = {}) {
  const stored = await readCredentials(path || credentialsPath(root), {
    optional: path === undefined,
    allowLegacyR2,
  });
  const overrides = validate(
    Object.fromEntries(CREDENTIAL_FIELDS.map((key) => [key, env[key]])),
  );
  if (
    Boolean(overrides.R2_ACCESS_KEY_ID) !==
    Boolean(overrides.R2_SECRET_ACCESS_KEY)
  )
    throw new Error(
      "Environment overrides must provide both R2 credential fields",
    );
  const credentials = { ...stored, ...overrides };
  if (
    Boolean(credentials.R2_ACCESS_KEY_ID) !==
    Boolean(credentials.R2_SECRET_ACCESS_KEY)
  )
    throw new Error("Provide both R2 credential fields");
  for (const key of required) {
    if (!CREDENTIAL_FIELDS.includes(key))
      throw new Error("Unsupported required credential");
    if (!credentials[key]) throw new Error(`Missing credential: ${key}`);
  }
  return credentials;
}

export async function saveCredentials(values, { root = projectRoot } = {}) {
  const data = validate(values),
    path = credentialsPath(root);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temp = `${path}.${randomBytes(12).toString("hex")}.next`;
  let file;
  try {
    file = await open(temp, "wx", 0o600);
    await file.writeFile(JSON.stringify(data, null, 2) + "\n");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temp, path);
  } finally {
    await file?.close();
    await rm(temp, { force: true });
  }
}

export async function deploymentCredentials(
  name,
  { root = projectRoot, env = process.env, deployed = false } = {},
) {
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(name))
    throw new Error("Invalid Worker name");
  const credentials = await loadCredentials({
    root,
    env,
    required: ["CLOUDFLARE_API_TOKEN"],
  });
  if (!credentials.SESSION_SECRET) {
    let legacyExists = false;
    try {
      await lstat(resolve(root, ".parcel-v3", name, "secrets.json"));
      legacyExists = true;
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new Error("Cannot inspect legacy credentials");
    }
    if (deployed || legacyExists)
      throw new Error(
        "Existing deployment needs its original SESSION_SECRET in cloudflare-credentials.json; refusing implicit session rotation",
      );
    credentials.SESSION_SECRET = randomBytes(32).toString("hex");
    // Do not persist CI/environment overrides. Save only the newly generated key.
    const stored = await readCredentials(credentialsPath(root), {
      optional: true,
    });
    await saveCredentials(
      { ...stored, SESSION_SECRET: credentials.SESSION_SECRET },
      { root },
    );
  }
  return credentials;
}
