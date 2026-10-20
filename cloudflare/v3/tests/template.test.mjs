import { test } from "node:test";
import assert from "node:assert/strict";
import { templateDeployment } from "../../../scripts/deploy-template.mjs";
import { readFile } from "node:fs/promises";

test("template refuses an unprovisioned D1 before making remote changes", () => {
  assert.throws(
    () =>
      templateDeployment({
        d1_databases: [
          {
            binding: "DB",
            database_id: "00000000-0000-0000-0000-000000000000",
          },
        ],
      }),
    /Provision/,
  );
});
test("template migrates by binding and preserves dashboard settings with the provisioned bucket name", () => {
  const commands = templateDeployment({
    d1_databases: [
      {
        binding: "DB",
        database_id: "11111111-1111-1111-1111-111111111111",
        database_name: "fork-db",
      },
    ],
    r2_buckets: [{ binding: "FILES", bucket_name: "fork-files" }],
  });
  assert.equal(commands[0][3], "DB");
  assert.ok(commands[1].includes("--keep-vars"));
  assert.ok(commands[1].includes("R2_BUCKET_NAME:fork-files"));
  assert.ok(commands[1].includes("ADMIN_AUTH:totp"));
  assert.equal(JSON.stringify(commands).includes("secret"), false);
});

test("Deploy to Cloudflare exposes only password + TOTP administrator settings", async () => {
  const read = async (path) =>
    JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
  const template = await read("../../../wrangler.json");
  const pkg = await read("../../../package.json");
  const example = await read("../../../deploy/v3.example.json");
  assert.equal(template.vars.ADMIN_AUTH, "totp");
  assert.equal(template.vars.ACTIVE, "false");
  assert.ok(pkg.cloudflare.bindings.ADMIN_AUTH);
  assert.ok(pkg.cloudflare.bindings.ADMIN_SETUP_TOKEN);
  assert.equal(template.vars.ADMIN_SETUP_TOKEN, undefined);
  assert.equal(example.active, false);
  assert.equal(
    example.vars.STORAGE_QUOTA_BYTES,
    template.vars.STORAGE_QUOTA_BYTES,
  );
  assert.doesNotMatch(
    JSON.stringify([template, pkg.cloudflare, example]),
    /ACCESS_TEAM_DOMAIN|ACCESS_AUD|ADMIN_EMAILS|adminEmails|cloudflareaccess|Zero Trust/,
  );
});
