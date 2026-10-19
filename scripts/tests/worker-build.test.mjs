import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { buildConfig } from "../prepare-worker-build.mjs";
import {
  deployProduction,
  productionDeployment,
} from "../deploy-production.mjs";

const template = JSON.parse(
  await readFile(new URL("../../wrangler.json", import.meta.url), "utf8"),
);
const settings = {
  accountId: "1234567890abcdef1234567890abcdef",
  workerName: "parcel-production",
  databaseId: "12345678-90ab-cdef-1234-567890abcdef",
  databaseName: "parcel-production",
  bucketName: "parcel-production",
};

test("production builds retain runtime configuration and use only existing resources", () => {
  const config = buildConfig(template, settings);
  assert.equal(config.vars, undefined);
  assert.equal(config.keep_vars, true);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.equal(config.d1_databases[0].database_id, settings.databaseId);
  assert.equal(config.r2_buckets[0].bucket_name, settings.bucketName);
  assert.ok(
    config.assets.directory.replaceAll("\\", "/").endsWith("/dist/v3-web"),
  );
  assert.ok(template.vars.PUBLIC_URL.includes("example.com"));
  assert.deepEqual(config.ratelimits, template.ratelimits);
  assert.deepEqual(config.triggers, template.triggers);
});

test("missing and placeholder database identities stop before deployment", () => {
  for (const databaseId of [
    undefined,
    "00000000-0000-0000-0000-000000000000",
    "../other-database",
  ])
    assert.throws(
      () => buildConfig(template, { ...settings, databaseId }),
      /databaseId/,
    );
});

test("build settings reject credentials and unexpected configuration", () => {
  assert.throws(
    () => buildConfig(template, { ...settings, SESSION_SECRET: "private" }),
    /only resource identifiers/,
  );
  assert.throws(
    () => buildConfig(template, { ...settings, vars: { ACTIVE: "false" } }),
    /only resource identifiers/,
  );
  assert.throws(() => buildConfig(template, null), /only resource identifiers/);
});

test("invalid account and resource names cannot select another deployment path", () => {
  assert.throws(
    () => buildConfig(template, { ...settings, accountId: "" }),
    /accountId/,
  );
  for (const key of ["workerName", "databaseName", "bucketName"])
    assert.throws(
      () => buildConfig(template, { ...settings, [key]: "../other" }),
      new RegExp(key),
    );
});

test("production deploy migrates the existing DB before publishing and retains runtime settings", async () => {
  const commands = [];
  await deployProduction(buildConfig(template, settings), async (args) =>
    commands.push(args),
  );
  assert.deepEqual(commands, [
    [
      "d1",
      "migrations",
      "apply",
      "DB",
      "--remote",
      "--config",
      ".parcel-v3/wrangler.builds.json",
    ],
    [
      "deploy",
      "--config",
      ".parcel-v3/wrangler.builds.json",
      "--keep-vars",
      "--no-x-auto-create",
    ],
  ]);
});

test("migration failures prevent Worker publication; unprepared config makes no remote calls", async () => {
  const calls = [];
  await assert.rejects(
    deployProduction(buildConfig(template, settings), async (args) => {
      calls.push(args);
      throw new Error("migration failure");
    }),
    /migration failure/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "d1");
  assert.throws(() => productionDeployment(template), /build:production/);
});
