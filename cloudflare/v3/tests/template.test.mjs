import { test } from "node:test";
import assert from "node:assert/strict";
import { templateDeployment } from "../../../scripts/deploy-template.mjs";

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
  assert.equal(JSON.stringify(commands).includes("secret"), false);
});
