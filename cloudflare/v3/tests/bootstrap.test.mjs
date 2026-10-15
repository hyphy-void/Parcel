import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CloudflareAPI,
  resources,
  validate,
  plan,
} from "../../../scripts/deploy-v3.mjs";

function mock() {
  const data = {
    db: [],
    bucket: null,
    apps: [],
    idps: [{ type: "onetimepin" }],
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
    if (key === "/access/organizations")
      return { auth_domain: "example.cloudflareaccess.com" };
    if (key === "/access/identity_providers") return data.idps;
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
    if (key.startsWith("/access/apps")) {
      if (method !== "GET") {
        const app = { ...body, id: "test-app", aud: "test-aud" };
        data.apps = [app];
        return app;
      }
      return data.apps;
    }
    throw new Error("unexpected request");
  };
  return { data, calls, api: { request, list: (path) => request(path) } };
}
const config = () =>
  validate({
    accountId: "a".repeat(32),
    adminEmails: ["admin@example.com"],
    workersPaid: true,
  });
test("bootstrap retries reuse D1/R2, preserve other rules, only protect administrator routes", async () => {
  const m = mock(),
    c = config(),
    state = {};
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
  const app = m.data.apps[0];
  assert.ok(
    app.destinations.every(
      (d) => !d.uri.includes("/s/") && !d.uri.endsWith("example.workers.dev/*"),
    ),
  );
  assert.deepEqual(app.policies[0].include, [
    { email: { email: "admin@example.com" } },
  ]);
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
