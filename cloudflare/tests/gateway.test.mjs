import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import {
  configuration,
  createGateway,
  route,
  signedHeaders,
  verifyAccess,
} from "../gateway.mjs";

export const env = {
  PUBLIC_URL: "https://parcel.example.com",
  ORIGIN_URL: "https://parcel-origin.example.com",
  ACCESS_TEAM_DOMAIN: "https://parcel-test.cloudflareaccess.com",
  ACCESS_AUD: "admin-audience",
  ADMIN_EMAILS: "admin@example.com",
  R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  GATEWAY_HMAC_SECRET: "ab".repeat(32),
  ORIGIN_ACCESS_CLIENT_ID: "service-id",
  ORIGIN_ACCESS_CLIENT_SECRET: "service-secret",
  ASSETS: {
    fetch: async (request) =>
      new Response(new URL(request.url).pathname, {
        headers: { "Content-Type": "text/html" },
      }),
  },
};
const id = "a".repeat(32);
const identity = { subject: "admin-id", email: "admin@example.com" };
function request(path, options = {}) {
  return new Request(env.PUBLIC_URL + path, {
    ...options,
    headers: {
      "CF-Connecting-IP": "198.51.100.9",
      Origin: env.PUBLIC_URL,
      ...options.headers,
    },
  });
}
const json = (value = {}) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });

test("configuration fails closed for missing secrets, insecure origins and empty allowlists", () => {
  for (const field of [
    "PUBLIC_URL",
    "ORIGIN_URL",
    "ACCESS_AUD",
    "ADMIN_EMAILS",
    "GATEWAY_HMAC_SECRET",
    "ORIGIN_ACCESS_CLIENT_ID",
    "ORIGIN_ACCESS_CLIENT_SECRET",
  ])
    assert.throws(() => configuration({ ...env, [field]: "" }));
  for (const url of [
    "http://parcel-origin.example.com",
    "https://parcel-origin.example.com/path",
    env.PUBLIC_URL,
    "https://user:password@parcel-origin.example.com",
  ])
    assert.throws(() => configuration({ ...env, ORIGIN_URL: url }));
});

test("public share navigation works across sites and never calls the origin", async () => {
  const gateway = createGateway({
    fetch: () => assert.fail("static request sent to Pi"),
  });
  const response = await gateway.fetch(
    request(`/s/${id}`, { headers: { "Sec-Fetch-Site": "cross-site" } }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "/");
  assert.match(
    response.headers.get("Content-Security-Policy"),
    /account\.r2\.cloudflarestorage\.com/,
  );
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
});

test("SPA routes avoid Pages index.html canonical redirects", async () => {
  const gateway = createGateway({ verifyAccess: async () => identity });
  const pagesEnv = {
    ...env,
    ASSETS: {
      fetch: async (request) => new URL(request.url).pathname === "/index.html"
        ? new Response(null, { status: 308, headers: { Location: "/" } })
        : new Response("SPA", { headers: { "Content-Type": "text/html" } }),
    },
  };
  for (const path of ["/", `/s/${id}`, "/admin", "/admin/new"])
    assert.equal((await gateway.fetch(request(path), pagesEnv)).status, 200, path);
});

test("administration, uploads and session routes require verified Access identity", async () => {
  const gateway = createGateway({
    fetch: () => assert.fail("unauthorized request reached origin"),
  });
  for (const path of [
    "/admin",
    "/admin/new",
    "/login",
    "/api/v1/auth/session",
    "/api/v1/admin/status",
    "/api/v1/uploads/lookup",
  ]) {
    const response = await gateway.fetch(
      request(path, {
        headers: {
          "X-Parcel-Subject": "forged",
          "CF-Access-Authenticated-User-Email": "admin@example.com",
        },
      }),
      env,
    );
    assert.equal(response.status, 401, path);
  }
});

test("unknown paths, encoded IDs, preview hosts and binary routes never reach origin", async () => {
  const gateway = createGateway({
    fetch: () => assert.fail("unexpected origin call"),
    verifyAccess: async () => identity,
  });
  for (const path of [
    "/readyz",
    "/healthz",
    "/.env",
    "/_worker.js",
    "/api/v1/unknown",
    `/api/v1/downloads/${id}/file`,
    "/api/v1/shares/%61" + "a".repeat(31),
  ])
    assert.ok((await gateway.fetch(request(path), env)).status >= 400, path);
  assert.equal(
    (
      await gateway.fetch(
        new Request("https://preview.pages.dev/api/v1/admin/status"),
        env,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await gateway.fetch(
        request(`/api/v1/uploads/${id}`, { method: "PATCH" }),
        env,
      )
    ).status,
    405,
  );
  assert.equal(
    route(`/api/v1/uploads/${id}/parts/10000`, "POST").allowed,
    true,
  );
  assert.equal(route(`/api/v1/uploads/${id}/parts/10001`, "POST"), null);
});

test("foreign API Origin and preflights are rejected before forwarding", async () => {
  const gateway = createGateway({
    fetch: () => assert.fail("CSRF reached origin"),
  });
  assert.equal(
    (
      await gateway.fetch(
        request(`/api/v1/shares/${id}/unlock`, {
          method: "POST",
          headers: { Origin: "https://evil.example" },
        }),
        env,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await gateway.fetch(
        request(`/api/v1/shares/${id}`, {
          headers: { "Sec-Fetch-Site": "cross-site" },
        }),
        env,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await gateway.fetch(
        request(`/api/v1/shares/${id}/unlock`, { method: "OPTIONS" }),
        env,
      )
    ).status,
    405,
  );
});

test("bounded JSON parsing rejects oversized, malformed and stalled bodies", async () => {
  const gateway = createGateway({
    fetch: () => assert.fail("invalid body forwarded"),
    bodyTimeoutMs: 20,
  });
  for (const [body, status, type] of [
    ["x".repeat(65537), 413, "application/json"],
    ["{}{}", 400, "application/json"],
    ["[]", 400, "application/json"],
    ["{}", 415, "text/plain"],
  ]) {
    assert.equal(
      (
        await gateway.fetch(
          request(`/api/v1/shares/${id}/unlock`, {
            method: "POST",
            body,
            headers: { "Content-Type": type },
          }),
          env,
        )
      ).status,
      status,
    );
  }
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
    },
  });
  const stalled = request(`/api/v1/shares/${id}/unlock`, {
    method: "POST",
    body,
    duplex: "half",
    headers: { "Content-Type": "application/json" },
  });
  assert.equal((await gateway.fetch(stalled, env)).status, 408);
});

test("signed origin requests bind identity, body, path, CSRF and grant cookie", async () => {
  const body = new TextEncoder().encode('{"session":"test"}');
  const req = request(`/api/v1/shares/${id}/download-sessions/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": "csrf",
      "Idempotency-Key": "idem",
      Cookie: `CF_Authorization=secret; parcel_grant_${id}=grant; unrelated=private`,
      "X-Parcel-Subject": "forged",
      "CF-Access-Client-Secret": "forged",
      "X-Forwarded-For": "127.0.0.1",
    },
  });
  const headers = await signedHeaders(
    req,
    configuration(env),
    identity,
    body,
    1234000,
  );
  const canonical = [
    "parcel-gateway-v1",
    "1234",
    headers.get("X-Parcel-Nonce"),
    "POST",
    new URL(req.url).pathname,
    env.PUBLIC_URL,
    identity.subject,
    identity.email,
    "198.51.100.9",
    headers.get("X-Parcel-Body-SHA256"),
    "application/json",
    "csrf",
    "idem",
    `parcel_grant_${id}=grant`,
  ].join("\n");
  assert.equal(
    headers.get("X-Parcel-Signature"),
    createHmac("sha256", Buffer.from(env.GATEWAY_HMAC_SECRET, "hex"))
      .update(canonical)
      .digest("hex"),
  );
  assert.equal(
    headers.get("CF-Access-Client-Secret"),
    env.ORIGIN_ACCESS_CLIENT_SECRET,
  );
  assert.equal(headers.get("Cookie"), `parcel_grant_${id}=grant`);
  assert.equal(headers.get("X-Forwarded-For"), null);
  assert.equal(headers.get("CF-Access-Jwt-Assertion"), null);
});

test("Access redirects, upstream failure and internal cookies never leak to clients", async () => {
  for (const reply of [
    new Response(null, {
      status: 302,
      headers: { Location: "https://team.cloudflareaccess.com/login" },
    }),
    new Response("<html>denied</html>", { status: 403 }),
  ]) {
    const gateway = createGateway({ fetch: async () => reply });
    assert.equal(
      (await gateway.fetch(request(`/api/v1/shares/${id}`), env)).status,
      502,
    );
  }
  const gateway = createGateway({
    fetch: async () => {
      const response = json({ locked: false });
      response.headers.append(
        "Set-Cookie",
        "CF_Authorization=internal-secret; Secure",
      );
      response.headers.append(
        "Set-Cookie",
        `parcel_grant_${id}=grant; Path=/api/v1/shares/${id}; HttpOnly; Secure; SameSite=Strict`,
      );
      response.headers.set("CF-Access-Client-Secret", "never-leak");
      return response;
    },
  });
  const response = await gateway.fetch(
    request(`/api/v1/shares/${id}/unlock`, {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    }),
    env,
  );
  assert.equal(response.headers.getSetCookie().length, 1);
  assert.match(response.headers.getSetCookie()[0], /^parcel_grant_/);
  assert.equal(response.headers.get("CF-Access-Client-Secret"), null);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
});

test("edge throttles sensitive requests before origin work and recovers next minute", async () => {
  let calls = 0,
    time = Date.now();
  const gateway = createGateway({
    now: () => time,
    fetch: async () => {
      calls++;
      return json();
    },
  });
  for (let i = 0; i < 20; i++)
    assert.equal(
      (
        await gateway.fetch(
          request(`/api/v1/shares/${id}/download-sessions`, { method: "POST" }),
          env,
        )
      ).status,
      200,
    );
  const denied = await gateway.fetch(
    request(`/api/v1/shares/${id}/download-sessions`, { method: "POST" }),
    env,
  );
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get("Retry-After"), "60");
  assert.equal(calls, 20);
  time += 60001;
  assert.equal(
    (
      await gateway.fetch(
        request(`/api/v1/shares/${id}/download-sessions`, { method: "POST" }),
        env,
      )
    ).status,
    200,
  );
});

test("real RSA Access JWT verification rejects wrong app, issuer, lifetime, identity and forged signature", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  const keyset = createLocalJWKSet({ keys: [jwk] });
  const config = configuration(env);
  const token = async (changes = {}) =>
    new SignJWT({
      type: "app",
      email: "admin@example.com",
      sub: "admin-id",
      iss: env.ACCESS_TEAM_DOMAIN,
      aud: env.ACCESS_AUD,
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000),
      ...changes,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .sign(privateKey);
  const check = async (jwt) =>
    verifyAccess(
      request("/admin", { headers: { "Cf-Access-Jwt-Assertion": jwt } }),
      config,
      keyset,
    );
  assert.deepEqual(await check(await token()), identity);
  for (const claims of [
    { aud: "origin-service-audience" },
    { iss: "https://evil.example" },
    { exp: 1 },
    { iat: Math.floor(Date.now() / 1000) + 120 },
    { email: "other@example.com" },
    { email: undefined },
    { sub: "" },
    { type: "service" },
  ])
    await assert.rejects(check(await token(claims)));
  const valid = await token();
  const segments = valid.split(".");
  segments[1] = Buffer.from(
    JSON.stringify({ email: "admin@example.com" }),
  ).toString("base64url");
  await assert.rejects(check(segments.join(".")));
});
