import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { unstable_splitSqlQuery } from "wrangler";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { PASSWORD_PROTOCOL } from "../password.mjs";

export async function passwordProof(
  password,
  salt = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
  ).replace(/=+$/, ""),
) {
  const key = await argon2idAsync(
    new TextEncoder().encode(password),
    Uint8Array.from(atob(salt), (c) => c.charCodeAt(0)),
    { m: 32768, t: 2, p: 1, dkLen: 32, maxmem: 80 << 20 },
  );
  return {
    scheme: PASSWORD_PROTOCOL,
    salt,
    key: Array.from(key, (b) => b.toString(16).padStart(2, "0")).join(""),
  };
}

export async function fixture(t, options = {}) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "v3-test";
  const config = {
    PUBLIC_URL: "https://parcel.example.com",
    ACCESS_TEAM_DOMAIN: "https://parcel-test.cloudflareaccess.com",
    ACCESS_AUD: "v3-admin",
    ADMIN_EMAILS: "admin@example.com",
    SESSION_SECRET: "ab".repeat(32),
    R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
    R2_BUCKET_NAME: "parcel-v3",
    R2_ACCESS_KEY_ID: "test-access",
    R2_SECRET_ACCESS_KEY: "test-secret",
    ...options.config,
  };
  const jwt = await new SignJWT({ type: "app", email: "admin@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
    .setSubject("admin-id")
    .setIssuer(config.ACCESS_TEAM_DOMAIN)
    .setAudience(config.ACCESS_AUD)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
  const dir = await mkdtemp(join(tmpdir(), "parcel-v3-"));
  const parts = new Map();
  let listFailures = 0;
  let unexpected = 0;
  const mfOptions = convertV4MiniflareOptions({
    modules: true,
    script: await readFile(resolve("../dist/v3/worker.mjs"), "utf8"),
    compatibilityDate: "2026-10-10",
    bindings: config,
    d1Databases: { DB: "v3-test" },
    r2Buckets: { FILES: "v3-test" },
    d1Persist: join(dir, "d1"),
    r2Persist: join(dir, "r2"),
    serviceBindings: {
      ASSETS: async (request) => {
        const path = new URL(request.url).pathname;
        const filename = path.startsWith("/assets/")
          ? path.slice(1)
          : "index.html";
        return new Response(
          await readFile(resolve("../dist/v3-web", filename)),
          {
            headers: {
              "Content-Type": filename.endsWith(".js")
                ? "text/javascript"
                : filename.endsWith(".css")
                  ? "text/css"
                  : "text/html",
            },
          },
        );
      },
    },
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (
        url.origin === config.ACCESS_TEAM_DOMAIN &&
        url.pathname === "/cdn-cgi/access/certs"
      )
        return Response.json({ keys: [jwk] });
      if (
        url.origin === config.R2_ENDPOINT &&
        request.method === "GET" &&
        url.searchParams.has("uploadId")
      ) {
        if (listFailures) {
          listFailures--;
          return new Response("Unavailable", { status: 503 });
        }
        const entries = parts.get(url.searchParams.get("uploadId")) || [];
        return new Response(
          `<ListPartsResult><IsTruncated>false</IsTruncated>${entries.map((p) => `<Part><PartNumber>${p.number}</PartNumber><ETag>&quot;${p.etag}&quot;</ETag><Size>${p.size}</Size></Part>`).join("")}</ListPartsResult>`,
          { headers: { "Content-Type": "application/xml" } },
        );
      }
      unexpected++;
      throw new Error("Unexpected outbound dependency");
    },
  });
  mfOptions.resourcePersistencePath = dir;
  let mf = new Miniflare(mfOptions);
  t.after(async () => {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  let db = await mf.getD1Database("DB"),
    bucket = await mf.getR2Bucket("FILES");
  const migrations = (await readdir(resolve("v3/migrations")))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of migrations) {
    if (options.migrationsThrough && name > options.migrationsThrough) break;
    const statements = unstable_splitSqlQuery(
      await readFile(resolve("v3/migrations", name), "utf8"),
    );
    await db.batch(statements.map((sql) => db.prepare(sql)));
  }
  let csrf = "";
  async function api(
    path,
    { method = "GET", body, admin = true, cookie, headers = {}, expected } = {},
  ) {
    const h = {
      Origin: config.PUBLIC_URL,
      "CF-Connecting-IP": "198.51.100.9",
      ...headers,
    };
    if (admin) h["Cf-Access-Jwt-Assertion"] = jwt;
    if (admin && csrf && !Object.hasOwn(headers, "X-CSRF-Token"))
      h["X-CSRF-Token"] = csrf;
    if (body !== undefined) h["Content-Type"] = "application/json";
    if (cookie) h.Cookie = cookie;
    const response = await mf.dispatchFetch(config.PUBLIC_URL + path, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (expected !== undefined)
      assert.equal(response.status, expected, await response.clone().text());
    return response;
  }
  csrf = (await (await api("/api/v1/auth/session", { expected: 200 })).json())
    .csrf;
  const created = [];
  async function create(size = 7, extra = {}, key = crypto.randomUUID()) {
    const response = await api("/api/v1/uploads", {
      method: "POST",
      body: {
        name: "测试资料.bin",
        size,
        ttl_seconds: 3600,
        max_downloads: 3,
        ...extra,
      },
      headers: { "Idempotency-Key": key },
      expected: 201,
    });
    const u = await response.json();
    created.push(u.id);
    await api(`/api/v1/uploads/${u.id}`, { expected: 200 });
    return u;
  }
  async function row(id) {
    return db.prepare("SELECT * FROM uploads WHERE id=?").bind(id).first();
  }
  async function put(id, n, bytes) {
    const u = await row(id),
      payload = typeof bytes === "number" ? new Uint8Array(bytes) : bytes;
    const result = await bucket
      .resumeMultipartUpload(u.storage_key, u.multipart_id)
      .uploadPart(n, payload);
    const list = parts.get(u.multipart_id) || [];
    parts.set(
      u.multipart_id,
      [
        ...list.filter((p) => p.number !== n),
        { number: n, size: payload.byteLength, etag: result.etag },
      ].sort((a, b) => a.number - b.number),
    );
    return result;
  }
  async function wait(id, state = "completed") {
    for (let i = 0; i < 100; i++) {
      const u = await row(id);
      if (u.state === state) return u;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail(
      `upload did not reach ${state}: ${JSON.stringify(await row(id))}`,
    );
  }
  async function publish(size = 7, extra = {}) {
    const u = await create(size, extra);
    for (
      let n = 1, offset = 0;
      n <= Math.max(1, Math.ceil(size / (16 << 20)));
      n++
    ) {
      const count = Math.min(16 << 20, size - offset);
      await put(u.id, n, count);
      offset += count;
    }
    await api(`/api/v1/uploads/${u.id}/complete`, {
      method: "POST",
      expected: 202,
    });
    await wait(u.id);
    return await (
      await api(`/api/v1/admin/shares/${u.share_id}`, { expected: 200 })
    ).json();
  }
  return {
    config,
    jwt,
    api,
    create,
    publish,
    put,
    row,
    wait,
    parts,
    get db() {
      return db;
    },
    get bucket() {
      return bucket;
    },
    get mf() {
      return mf;
    },
    get unexpected() {
      return unexpected;
    },
    failLists(n = 1) {
      listFailures = n;
    },
    async restart() {
      await mf.dispose();
      mf = new Miniflare(mfOptions);
      db = await mf.getD1Database("DB");
      bucket = await mf.getR2Bucket("FILES");
    },
    async maintain() {
      await (await mf.getWorker()).scheduled({ cron: "*/5 * * * *" });
    },
  };
}
