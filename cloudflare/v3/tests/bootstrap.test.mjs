import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CloudflareAPI,
  resources,
  validate,
  plan,
  workerConfig,
  workerSecrets,
  verifyAdministrator,
} from "../../../scripts/deploy-v3.mjs";
import { readFile } from "node:fs/promises";

function mock() {
  const data = {
    db: [],
    bucket: null,
    cors: {
      rules: [
        {
          id: "unrelated-cors",
          allowed: { origins: ["https://other.example"], methods: ["GET"] },
        },
      ],
    },
    lifecycle: {
      rules: [
        {
          id: "unrelated-lifecycle",
          enabled: true,
          conditions: { prefix: "elsewhere/" },
        },
      ],
    },
  };
  const calls = [];
  const request = async (path, method = "GET", body) => {
    const key = path.split("?")[0];
    calls.push({ key, method, body });
    if (key === "/workers/subdomain") return { subdomain: "example" };
    if (key === "/d1/database") {
      if (method === "POST") {
        data.db.push({ name: body.name, uuid: "test-db" });
        return data.db[0];
      }
      return data.db;
    }
    if (key === "/r2/buckets/parcel") return data.bucket;
    if (key === "/r2/buckets") {
      data.bucket = { name: body.name };
      return data.bucket;
    }
    if (key.endsWith("/cors") || key.endsWith("/lifecycle")) {
      const type = key.split("/").at(-1);
      if (method === "PUT") data[type] = body;
      return data[type];
    }
    throw new Error("unexpected request");
  };
  return { data, calls, api: { request, list: (path) => request(path) } };
}
const config = () =>
  validate({
    accountId: "a".repeat(32),
    workersPaid: true,
  });
test("bootstrap retries reuse D1/R2 and preserve other rules without calling any Access API", async () => {
  const m = mock(),
    c = config(),
    state = { accessAppId: "historical-state-is-never-used" };
  let saves = 0;
  const first = await resources(c, m.api, state, async () => saves++);
  const before = m.calls.length;
  const second = await resources(c, m.api, state);
  assert.deepEqual(first, second);
  assert.ok(saves >= 3);
  assert.equal(
    m.calls.filter((c) => c.method === "POST" && c.key === "/d1/database")
      .length,
    1,
  );
  assert.equal(
    m.calls.filter((c) => c.method === "POST" && c.key === "/r2/buckets")
      .length,
    1,
  );
  assert.equal(
    m.calls
      .slice(before)
      .filter((c) => c.method === "PUT" && c.key.endsWith("/cors")).length,
    0,
  );
  assert.equal(m.data.cors.rules[0].id, "unrelated-cors");
  assert.equal(m.data.lifecycle.rules[0].id, "unrelated-lifecycle");
  const abort = m.data.lifecycle.rules.find(
    (r) => r.id === "parcel-abort-multipart",
  );
  assert.equal(abort.conditions.prefix, "parcel/v3/");
  assert.equal(abort.deleteObjectsTransition, undefined);
  assert.ok(m.calls.every((c) => !c.key.startsWith("/access/")));
  assert.deepEqual(m.data.cors.rules[1].allowed.headers, [
    "Content-Type",
    "Range",
    "X-Amz-Meta-Parcel-Upload",
  ]);
  assert.deepEqual(first, {
    databaseId: "test-db",
    publicUrl: "https://parcel.example.workers.dev",
  });
});

test("new deployment plans need no email or organization and reject obsolete login settings", () => {
  const c = config();
  const p = plan(c);
  assert.equal(p.adminAuth, "totp");
  assert.doesNotMatch(
    JSON.stringify(p),
    /Access|Zero Trust|adminEmails|teamDomain|email/,
  );
  for (const key of ["adminEmails", "teamDomain", "accessAppId"])
    assert.throws(
      () => validate({ ...c, [key]: "obsolete" }),
      /obsolete administrator settings/,
    );
  for (const key of ["ADMIN_AUTH", "ADMIN_EMAILS", "ADMIN_SETUP_TOKEN"])
    assert.throws(
      () => validate({ ...c, vars: { [key]: "private" } }),
      /numeric limits/,
    );
});

test("generated Worker configuration forces TOTP and keeps initialization secrets out of vars", async () => {
  const template = JSON.parse(
    await readFile(new URL("../../../wrangler.json", import.meta.url), "utf8"),
  );
  Object.assign(template.vars, {
    ADMIN_AUTH: "access",
    ACCESS_TEAM_DOMAIN: "obsolete",
    ACCESS_AUD: "obsolete",
    ADMIN_EMAILS: "obsolete",
    ADMIN_SETUP_TOKEN: "do-not-publish",
  });
  const generated = workerConfig(
    config(),
    { databaseId: "test-db", publicUrl: "https://parcel.example.workers.dev" },
    template,
    (p) => p,
  );
  assert.equal(generated.vars.ADMIN_AUTH, "totp");
  assert.equal(generated.vars.ACTIVE, "false");
  assert.equal(generated.vars.R2_BUCKET_NAME, "parcel");
  assert.doesNotMatch(
    JSON.stringify(generated),
    /ACCESS_TEAM_DOMAIN|ACCESS_AUD|ADMIN_EMAILS|ADMIN_SETUP_TOKEN|do-not-publish/,
  );
});

test("first bootstrap requires a private setup token and repeat deploys never restore it", () => {
  const credentials = {
    CLOUDFLARE_API_TOKEN: "do-not-deploy",
    SESSION_SECRET: "ab".repeat(32),
    R2_ACCESS_KEY_ID: "id",
    R2_SECRET_ACCESS_KEY: "secret",
  };
  assert.throws(() => workerSecrets(credentials), /ADMIN_SETUP_TOKEN/);
  credentials.ADMIN_SETUP_TOKEN = "x".repeat(43);
  const first = workerSecrets(credentials);
  assert.equal(first.ADMIN_SETUP_TOKEN, credentials.ADMIN_SETUP_TOKEN);
  assert.equal(first.CLOUDFLARE_API_TOKEN, undefined);
  const repeated = workerSecrets(credentials, { deployed: true });
  assert.equal(repeated.ADMIN_SETUP_TOKEN, undefined);
  assert.equal(repeated.SESSION_SECRET, first.SESSION_SECRET);
});

test("activation requires initialized TOTP; maintenance permits protected first enrollment", async () => {
  const publicUrl = "https://parcel.example.workers.dev";
  const check = (info, activate = false, status = 200) =>
    verifyAdministrator(publicUrl, {
      activate,
      fetcher: async (url, options) => {
        assert.equal(url, publicUrl + "/api/v1/auth-config");
        assert.equal(options.redirect, "manual");
        return Response.json(info, { status });
      },
    });
  const fresh = {
    auth_mode: "totp",
    initialized: false,
    setup_available: true,
  };
  assert.deepEqual(await check(fresh), fresh);
  await assert.rejects(check(fresh, true), /remains in maintenance/);
  await check(
    { auth_mode: "totp", initialized: true, setup_available: false },
    true,
  );
  for (const info of [
    { auth_mode: "access" },
    { auth_mode: "totp", initialized: false, setup_available: false },
  ])
    await assert.rejects(check(info), /not ready/);
  await assert.rejects(check(fresh, true, 503), /not ready/);
  await assert.rejects(
    verifyAdministrator(publicUrl, {
      fetcher: async () => new Response("redirect", { status: 302 }),
    }),
    /probe failed/,
  );
});
test("bootstrap refuses unmanaged existing resources and never enables paid billing", async () => {
  const m = mock();
  await resources({ ...config(), workersPaid: false }, m.api);
  assert.ok(!m.calls.some((c) => /subscription|billing/.test(c.key)));
  const fresh = mock();
  fresh.data.bucket = { name: "parcel" };
  await assert.rejects(resources(config(), fresh.api), /Existing bucket/);
  assert.equal(fresh.calls.filter((c) => c.method === "PUT").length, 0);
});
test("Cloudflare API errors do not expose tokens, body or credential-bearing URLs", async () => {
  const api = new CloudflareAPI("a".repeat(32), "do-not-print", async () =>
    Response.json(
      {
        success: false,
        errors: [{ code: 10000, message: "do-not-print credentials" }],
      },
      { status: 403 },
    ),
  );
  await assert.rejects(
    api.request("/d1/database"),
    (e) => e.message.includes("10000") && !e.message.includes("do-not-print"),
  );
  const failed = new CloudflareAPI("a".repeat(32), "do-not-print", async () => {
    throw new Error("do-not-print");
  });
  await assert.rejects(
    failed.request("/d1/database"),
    (e) => !e.message.includes("do-not-print"),
  );
  assert.equal(JSON.stringify(plan(config())).includes("do-not-print"), false);
  assert.throws(() =>
    validate({ ...config(), publicUrl: "https://user:password@example.com" }),
  );
});
