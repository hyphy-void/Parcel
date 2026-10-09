import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

test("built Pages bundle runs JWT, HMAC, assets and grant cookies inside workerd", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "runtime-key";
  const env = {
    PUBLIC_URL: "https://parcel.example.com",
    ORIGIN_URL: "https://parcel-origin.example.com",
    ACCESS_TEAM_DOMAIN: "https://parcel-test.cloudflareaccess.com",
    ACCESS_AUD: "admin-audience",
    ADMIN_EMAILS: "admin@example.com",
    R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
    GATEWAY_HMAC_SECRET: "ab".repeat(32),
    ORIGIN_ACCESS_CLIENT_ID: "service-id",
    ORIGIN_ACCESS_CLIENT_SECRET: "service-secret",
  };
  const id = "a".repeat(32);
  let originCalls = 0;
  const worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: await readFile(resolve("../dist/pages/_worker.js"), "utf8"),
      compatibilityDate: "2026-10-09",
      bindings: env,
      serviceBindings: {
        ASSETS: async (request) =>
          new Response(await readFile(resolve("../dist/pages/index.html")), {
            headers: { "Content-Type": "text/html" },
          }),
      },
      outboundService: async (request) => {
        const url = new URL(request.url);
        if (
          url.origin === env.ACCESS_TEAM_DOMAIN &&
          url.pathname === "/cdn-cgi/access/certs"
        )
          return new Response(JSON.stringify({ keys: [jwk] }), {
            headers: { "Content-Type": "application/json" },
          });
        assert.equal(url.origin, env.ORIGIN_URL);
        originCalls++;
        const h = request.headers;
        const canonical = [
          "parcel-gateway-v1",
          h.get("X-Parcel-Timestamp"),
          h.get("X-Parcel-Nonce"),
          request.method,
          url.pathname + url.search,
          env.PUBLIC_URL,
          h.get("X-Parcel-Subject"),
          h.get("X-Parcel-Email"),
          h.get("X-Parcel-Client-IP"),
          h.get("X-Parcel-Body-SHA256"),
          h.get("Content-Type") || "",
          h.get("X-CSRF-Token") || "",
          h.get("Idempotency-Key") || "",
          h.get("Cookie") || "",
        ].join("\n");
        assert.equal(
          h.get("X-Parcel-Signature"),
          createHmac("sha256", Buffer.from(env.GATEWAY_HMAC_SECRET, "hex"))
            .update(canonical)
            .digest("hex"),
        );
        const response = new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
        response.headers.append(
          "Set-Cookie",
          `parcel_grant_${id}=grant; Path=/api/v1/shares/${id}; Secure; HttpOnly; SameSite=Strict`,
        );
        response.headers.append(
          "Set-Cookie",
          "CF_Authorization=internal-secret; Secure",
        );
        return response;
      },
    }),
  );
  try {
    const root = await worker.dispatchFetch(env.PUBLIC_URL + "/");
    assert.equal(root.status, 200);
    assert.match(await root.text(), /<div id="root">/);
    assert.equal(
      (await worker.dispatchFetch(env.PUBLIC_URL + "/admin")).status,
      401,
    );
    const jwt = await new SignJWT({ type: "app", email: "admin@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "runtime-key" })
      .setSubject("admin-id")
      .setIssuer(env.ACCESS_TEAM_DOMAIN)
      .setAudience(env.ACCESS_AUD)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const admin = await worker.dispatchFetch(
      env.PUBLIC_URL + "/api/v1/auth/session",
      {
        headers: {
          "Cf-Access-Jwt-Assertion": jwt,
          "CF-Connecting-IP": "198.51.100.9",
        },
      },
    );
    assert.equal(admin.status, 200, await admin.clone().text());
    assert.equal(admin.headers.getSetCookie().length, 1);
    assert.match(admin.headers.getSetCookie()[0], /^parcel_grant_/);
    const publicAPI = await worker.dispatchFetch(
      env.PUBLIC_URL + `/api/v1/shares/${id}/unlock`,
      {
        method: "POST",
        headers: {
          Origin: env.PUBLIC_URL,
          "Content-Type": "application/json",
          "CF-Connecting-IP": "198.51.100.9",
        },
        body: '{"password":"test"}',
      },
    );
    assert.equal(publicAPI.status, 200, await publicAPI.clone().text());
    assert.equal(originCalls, 2);
  } finally {
    await worker.dispose();
  }
});
