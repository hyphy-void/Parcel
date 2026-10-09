import assert from "node:assert/strict";
import { test } from "node:test";
import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { createGateway } from "../gateway.mjs";

// Real JS -> HTTP -> Go verification, with a temporary SQLite DB and no calls
// to a production R2 bucket or Cloudflare account.
test("Pages gateway interoperates with the real Go origin and Access CSRF", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "parcel-gateway-"));
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const local = `http://127.0.0.1:${port}`;
  const secret = "ab".repeat(32);
  await writeFile(join(directory, "gateway.secret"), secret, { mode: 0o600 });
  await writeFile(
    join(directory, "r2.credentials"),
    "ACCESS_KEY_ID=fake\nSECRET_ACCESS_KEY=fake\n",
    { mode: 0o600 },
  );
  const env = {
    PUBLIC_URL: "https://parcel.example.com",
    ORIGIN_URL: "https://parcel-origin.example.com",
    ACCESS_TEAM_DOMAIN: "https://parcel-test.cloudflareaccess.com",
    ACCESS_AUD: "admin-audience",
    ADMIN_EMAILS: "admin@example.com",
    R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
    GATEWAY_HMAC_SECRET: secret,
    ORIGIN_ACCESS_CLIENT_ID: "service-id",
    ORIGIN_ACCESS_CLIENT_SECRET: "service-secret",
  };
  const binary = resolve(process.env.PARCEL_TEST_BINARY || "../bin/parcel");
  const processEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("PARCEL_")),
  );
  const child = spawn(binary, ["serve"], {
    env: {
      ...processEnv,
      PARCEL_DATA_DIR: join(directory, "data"),
      PARCEL_LISTEN_ADDR: `127.0.0.1:${port}`,
      PARCEL_BASE_URL: env.PUBLIC_URL,
      PARCEL_ADMIN_AUTH: "access",
      PARCEL_GATEWAY_SECRET_FILE: join(directory, "gateway.secret"),
      PARCEL_STORAGE_BACKEND: "r2",
      PARCEL_R2_ENDPOINT: env.R2_ENDPOINT,
      PARCEL_R2_BUCKET: "test",
      PARCEL_R2_CREDENTIALS_FILE: join(directory, "r2.credentials"),
      PARCEL_MIN_FREE_BYTES: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let output = "";
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
    await rm(directory, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(local + "/readyz")).ok) {
        ready = true;
        break;
      }
    } catch {}
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, `Origin did not start: ${output}`);
  let admin = true;
  const gateway = createGateway({
    verifyAccess: async () => {
      if (!admin) throw new Error("No Access");
      return { subject: "admin-id", email: "admin@example.com" };
    },
    // Node 24 fetch replaces Host; model Caddy's explicit header_up Host using
    // the HTTP client so this integration exercises the production wire format.
    fetch: (url, options) =>
      new Promise((resolve, reject) => {
        const upstream = httpRequest(
          local + new URL(url).pathname + new URL(url).search,
          {
            method: options.method,
            signal: options.signal,
            headers: {
              ...Object.fromEntries(options.headers),
              Host: new URL(env.PUBLIC_URL).host,
            },
          },
          (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
              const headers = new Headers();
              for (let i = 0; i < response.rawHeaders.length; i += 2)
                headers.append(
                  response.rawHeaders[i],
                  response.rawHeaders[i + 1],
                );
              resolve(
                new Response(Buffer.concat(chunks), {
                  status: response.statusCode,
                  headers,
                }),
              );
            });
          },
        );
        upstream.on("error", reject);
        upstream.end(options.body);
      }),
  });
  const request = (path, options = {}) =>
    new Request(env.PUBLIC_URL + path, {
      ...options,
      headers: {
        "CF-Connecting-IP": "198.51.100.9",
        Origin: env.PUBLIC_URL,
        ...options.headers,
      },
    });
  const session = await gateway.fetch(request("/api/v1/auth/session"), env);
  assert.equal(session.status, 200, await session.clone().text());
  const identity = await session.json();
  assert.equal(identity.auth_mode, "access");
  assert.equal(identity.email, "admin@example.com");
  assert.match(identity.csrf, /^[a-f0-9]{64}$/);
  const status = await gateway.fetch(request("/api/v1/admin/status"), env);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).storage_backend, "r2");
  const denied = await gateway.fetch(
    request("/api/v1/auth/logout", { method: "POST" }),
    env,
  );
  assert.equal(denied.status, 403);
  const logout = await gateway.fetch(
    request("/api/v1/auth/logout", {
      method: "POST",
      headers: { "X-CSRF-Token": identity.csrf },
    }),
    env,
  );
  assert.equal(logout.status, 200);
  assert.equal((await logout.json()).logout_url, "/cdn-cgi/access/logout");
  const unknown = await gateway.fetch(
    request("/api/v1/shares/" + "a".repeat(32)),
    env,
  );
  assert.equal(unknown.status, 404);
  // Public routes have no admin identity, even while an admin is browsing.
  admin = false;
  assert.equal(
    (await gateway.fetch(request("/api/v1/shares/" + "a".repeat(32)), env))
      .status,
    404,
  );
  assert.equal(
    (await gateway.fetch(request("/api/v1/admin/status"), env)).status,
    401,
  );
  const direct = await fetch(local + "/api/v1/admin/status", {
    headers: {
      Host: "parcel.example.com",
      "X-Parcel-Email": "admin@example.com",
    },
  });
  assert.equal(direct.status, 403);
});
