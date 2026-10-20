import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  chmod,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  credentialsPath,
  loadCredentials,
  saveCredentials,
  deploymentCredentials,
} from "../v3-credentials.mjs";

const values = {
  CLOUDFLARE_API_TOKEN: "test-account-token",
  SESSION_SECRET: "ab".repeat(32),
  R2_ACCESS_KEY_ID: "test-access-key",
  R2_SECRET_ACCESS_KEY: "test-secret-key",
};
async function workspace(t) {
  const root = await mkdtemp(resolve(tmpdir(), "parcel-credentials-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("a fresh machine loads all four credentials from the single private file", async (t) => {
  const root = await workspace(t);
  await saveCredentials(values, { root });
  assert.deepEqual(await loadCredentials({ root, env: {} }), values);
  assert.equal((await stat(credentialsPath(root))).mode & 0o777, 0o600);
  assert.equal((await stat(resolve(root, ".parcel-v3"))).mode & 0o777, 0o700);
  await assert.rejects(
    stat(resolve(root, ".parcel-v3/parcel-v3/secrets.json")),
    { code: "ENOENT" },
  );
});

test("CI overrides are in memory; R2 pairs cannot mix environment and file keys", async (t) => {
  const root = await workspace(t);
  await saveCredentials(values, { root });
  const env = {
    CLOUDFLARE_API_TOKEN: "ci-token",
    R2_ACCESS_KEY_ID: "ci-access",
    R2_SECRET_ACCESS_KEY: "ci-secret",
  };
  const result = await deploymentCredentials("parcel-v3", {
    root,
    env,
    deployed: true,
  });
  assert.equal(result.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_API_TOKEN);
  assert.equal(result.R2_SECRET_ACCESS_KEY, env.R2_SECRET_ACCESS_KEY);
  assert.equal(result.SESSION_SECRET, values.SESSION_SECRET);
  assert.deepEqual(
    JSON.parse(await readFile(credentialsPath(root), "utf8")),
    values,
  );
  await assert.rejects(
    loadCredentials({ root, env: { R2_ACCESS_KEY_ID: "ci-access" } }),
    /both R2/,
  );
});

test("temporary enrollment credentials stay private and invalid tokens never leak in diagnostics", async (t) => {
  const root = await workspace(t);
  const ADMIN_SETUP_TOKEN = "x".repeat(43);
  await saveCredentials({ ...values, ADMIN_SETUP_TOKEN }, { root });
  assert.equal(
    (await loadCredentials({ root, env: {} })).ADMIN_SETUP_TOKEN,
    ADMIN_SETUP_TOKEN,
  );
  const override = "y".repeat(43);
  assert.equal(
    (await loadCredentials({ root, env: { ADMIN_SETUP_TOKEN: override } }))
      .ADMIN_SETUP_TOKEN,
    override,
  );
  assert.equal(
    JSON.parse(await readFile(credentialsPath(root), "utf8")).ADMIN_SETUP_TOKEN,
    ADMIN_SETUP_TOKEN,
  );
  for (const token of [
    "private-but-too-short",
    "x".repeat(129),
    "not-url-safe+".repeat(4),
  ])
    await assert.rejects(
      saveCredentials({ ...values, ADMIN_SETUP_TOKEN: token }, { root }),
      (e) =>
        /Invalid credential field: ADMIN_SETUP_TOKEN/.test(e.message) &&
        !e.message.includes(token),
    );
});

test("environment-only CI needs no private file and never creates a secret copy", async (t) => {
  const root = await workspace(t);
  assert.deepEqual(
    await deploymentCredentials("parcel-v3", {
      root,
      env: values,
      deployed: true,
    }),
    values,
  );
  await assert.rejects(stat(credentialsPath(root)), { code: "ENOENT" });
});

test("first bootstrap saves a new session key once in the canonical file", async (t) => {
  const root = await workspace(t);
  const { SESSION_SECRET, ...initial } = values;
  await saveCredentials(initial, { root });
  const first = await deploymentCredentials("parcel-v3", { root, env: {} });
  assert.match(first.SESSION_SECRET, /^[a-f0-9]{64}$/);
  const second = await deploymentCredentials("parcel-v3", {
    root,
    env: {},
    deployed: true,
  });
  assert.deepEqual(second, first);
  assert.deepEqual(await loadCredentials({ root, env: {} }), first);
  await assert.rejects(
    stat(resolve(root, ".parcel-v3/parcel-v3/secrets.json")),
    { code: "ENOENT" },
  );
});

test("lost or unmerged session keys stop before creating a replacement", async (t) => {
  const root = await workspace(t);
  const { SESSION_SECRET, ...initial } = values;
  await saveCredentials(initial, { root });
  await assert.rejects(
    deploymentCredentials("parcel-v3", { root, env: {}, deployed: true }),
    /refusing implicit session rotation/,
  );
  await mkdir(resolve(root, ".parcel-v3/parcel-v3"));
  await writeFile(
    resolve(root, ".parcel-v3/parcel-v3/secrets.json"),
    JSON.stringify({ SESSION_SECRET }),
    { mode: 0o600 },
  );
  await assert.rejects(
    deploymentCredentials("parcel-v3", { root, env: {} }),
    /refusing implicit session rotation/,
  );
  assert.equal(
    (await loadCredentials({ root, env: {} })).SESSION_SECRET,
    undefined,
  );
});

test("malformed, public, symlinked and invalid credential files never leak their contents", async (t) => {
  const root = await workspace(t);
  await saveCredentials(values, { root });
  const path = credentialsPath(root);
  await writeFile(path, "very-private-value-is-not-json");
  await assert.rejects(
    loadCredentials({ root, env: {} }),
    (e) =>
      !e.message.includes("very-private-value") &&
      /Cannot read credentials/.test(e.message),
  );
  await saveCredentials(values, { root });
  await chmod(path, 0o644);
  await assert.rejects(loadCredentials({ root, env: {} }), /0600/);
  await rm(path);
  const other = resolve(root, "other.json");
  await writeFile(other, JSON.stringify(values), { mode: 0o600 });
  await symlink(other, path);
  await assert.rejects(loadCredentials({ root, env: {} }), /0600/);
  await rm(path);
  await saveCredentials({ ...values, SESSION_SECRET: "" }, { root });
  await assert.rejects(
    loadCredentials({ root, env: {}, required: ["SESSION_SECRET"] }),
    /Missing credential: SESSION_SECRET/,
  );
  await assert.rejects(
    saveCredentials(
      { ...values, SESSION_SECRET: "very-private-invalid-key" },
      { root },
    ),
    (e) => !e.message.includes("very-private"),
  );
  await assert.rejects(
    saveCredentials({ ...values, unexpected: "private" }, { root }),
    /unsupported field/,
  );
});

test("explicit R2 probe files use the shared loader, including legacy Go format", async (t) => {
  const root = await workspace(t);
  const path = resolve(root, "r2.credentials");
  await writeFile(
    path,
    "Access Key ID:\ntest-access-key\nSecret Access Key: test-secret-key\n",
    { mode: 0o600 },
  );
  const required = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
  assert.deepEqual(
    await loadCredentials({
      root,
      path,
      env: {},
      allowLegacyR2: true,
      required,
    }),
    {
      R2_ACCESS_KEY_ID: values.R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: values.R2_SECRET_ACCESS_KEY,
    },
  );
  await assert.rejects(
    loadCredentials({ root, path, env: {} }),
    /Cannot read credentials/,
  );
  await assert.rejects(
    loadCredentials({ root, path: resolve(root, "missing.json"), env: values }),
    /Cannot read credentials/,
  );
});
