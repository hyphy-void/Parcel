import { createRemoteJWKSet, jwtVerify } from "jose";

const ID = "[A-Za-z0-9_-]{32}";
const encoder = new TextEncoder();
const keys = new Map();
const sha256 = async (bytes) =>
  hex(await crypto.subtle.digest("SHA-256", bytes));
const hex = (bytes) =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

export function configuration(env) {
  for (const name of [
    "PUBLIC_URL",
    "ORIGIN_URL",
    "ACCESS_TEAM_DOMAIN",
    "ACCESS_AUD",
    "ADMIN_EMAILS",
    "GATEWAY_HMAC_SECRET",
    "ORIGIN_ACCESS_CLIENT_ID",
    "ORIGIN_ACCESS_CLIENT_SECRET",
    "R2_ENDPOINT",
  ]) {
    if (typeof env[name] !== "string" || !env[name] || /[\r\n]/.test(env[name]))
      throw new Error("Missing gateway configuration");
  }
  for (const name of [
    "PUBLIC_URL",
    "ORIGIN_URL",
    "ACCESS_TEAM_DOMAIN",
    "R2_ENDPOINT",
  ]) {
    const url = new URL(env[name]);
    if (
      url.protocol !== "https:" ||
      url.origin !== env[name] ||
      url.username ||
      url.password ||
      url.port
    )
      throw new Error("Invalid origin");
  }
  if (
    env.PUBLIC_URL === env.ORIGIN_URL ||
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(
      env.ACCESS_TEAM_DOMAIN,
    ) ||
    !/^https:\/\/[a-z0-9.-]+\.r2\.cloudflarestorage\.com$/.test(
      env.R2_ENDPOINT,
    ) ||
    !/^[a-fA-F0-9]{64}$/.test(env.GATEWAY_HMAC_SECRET)
  )
    throw new Error("Invalid gateway configuration");
  const emails = env.ADMIN_EMAILS.split(",").map((s) => s.trim().toLowerCase());
  if (emails.some((s) => !/^[^\s@,]+@[^\s@,]+$/.test(s)))
    throw new Error("Invalid admin allowlist");
  return { ...env, emails };
}

export async function verifyAccess(request, config, testKeys) {
  // Verify the signature, issuer, application audience and lifetime. A service
  // token is never an administrator; the explicit email allowlist is mandatory.
  const token =
    request.headers.get("Cf-Access-Jwt-Assertion") ||
    request.headers
      .get("Cookie")
      ?.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];
  if (!token || token.length > 16384) throw new Error("Access required");
  let jwks = testKeys || keys.get(config.ACCESS_TEAM_DOMAIN);
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`${config.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`),
      { timeoutDuration: 5000 },
    );
    keys.set(config.ACCESS_TEAM_DOMAIN, jwks);
  }
  const { payload } = await jwtVerify(token, jwks, {
    issuer: config.ACCESS_TEAM_DOMAIN,
    audience: config.ACCESS_AUD,
    algorithms: ["RS256"],
    requiredClaims: ["exp", "iat", "sub", "email"],
  });
  if (
    payload.type !== "app" ||
    typeof payload.email !== "string" ||
    typeof payload.sub !== "string" ||
    payload.sub.length > 256 ||
    !payload.sub ||
    /[\r\n]/.test(payload.sub) ||
    payload.iat > Date.now() / 1000 + 15 ||
    !config.emails.includes(payload.email.toLowerCase())
  )
    throw new Error("Administrator denied");
  return { subject: payload.sub, email: payload.email.toLowerCase() };
}

// Strict route/method allowlist: Pages carries only R2 control-plane requests.
export function route(path, method) {
  const rules = [
    ["/api/v1/auth/session", ["GET"], true],
    ["/api/v1/auth/logout", ["POST"], true],
    ["/api/v1/admin/status", ["GET"], true],
    ["/api/v1/uploads", ["POST"], true],
    ["/api/v1/uploads/lookup", ["GET"], true],
    ["/api/v1/admin/shares", ["GET"], true],
    ["/api/v1/admin/shares/cleaned", ["DELETE"], true],
    [new RegExp(`^/api/v1/uploads/${ID}$`), ["GET", "DELETE"], true],
    [
      new RegExp(
        `^/api/v1/uploads/${ID}/(?:object|complete|parts/[1-9][0-9]{0,3}|parts/10000)$`,
      ),
      ["POST"],
      true,
    ],
    [new RegExp(`^/api/v1/admin/shares/${ID}$`), ["GET", "DELETE"], true],
    [new RegExp(`^/api/v1/admin/shares/${ID}/password$`), ["PATCH"], true],
    [new RegExp(`^/api/v1/shares/${ID}$`), ["GET"], false],
    [
      new RegExp(
        `^/api/v1/shares/${ID}/(?:unlock|download-sessions|download-sessions/refresh)$`,
      ),
      ["POST"],
      false,
    ],
  ];
  const rule = rules.find(([pattern]) =>
    typeof pattern === "string" ? pattern === path : pattern.test(path),
  );
  return rule ? { allowed: rule[1].includes(method), admin: rule[2] } : null;
}

export function security(response, config, api = false) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ${config?.R2_ENDPOINT || ""}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`,
  );
  if (api) headers.set("Cache-Control", "private, no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
export function problem(status, code, message) {
  return new Response(JSON.stringify({ code, message }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
    },
  });
}

export async function readBody(request, timeoutMs = 15000) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Body read timeout")), timeoutMs);
  });
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        throw new Error("Body too large");
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function signedHeaders(
  request,
  config,
  identity,
  body,
  now = Date.now(),
) {
  // Construct from an allowlist. Never forward browser identity, service tokens,
  // forwarding headers, authorization, or Access cookies to the internal origin.
  const headers = new Headers();
  for (const name of ["Content-Type", "X-CSRF-Token", "Idempotency-Key"]) {
    if (request.headers.has(name)) headers.set(name, request.headers.get(name));
  }
  const url = new URL(request.url);
  const shareID = url.pathname.match(
    new RegExp(`^/api/v1/shares/(${ID})(?:/|$)`),
  )?.[1];
  const grant =
    shareID &&
    request.headers
      .get("Cookie")
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(`parcel_grant_${shareID}=`));
  if (grant) headers.set("Cookie", grant);
  const timestamp = String(Math.floor(now / 1000));
  const nonce = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_");
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip || !/^[a-fA-F0-9:.]+$/.test(ip) || ip.length > 45)
    throw new Error("Missing Cloudflare client IP");
  const digest = await sha256(body);
  const subject = identity?.subject || "",
    email = identity?.email || "";
  const canonical = [
    "parcel-gateway-v1",
    timestamp,
    nonce,
    request.method,
    url.pathname + url.search,
    config.PUBLIC_URL,
    subject,
    email,
    ip,
    digest,
    headers.get("Content-Type") || "",
    headers.get("X-CSRF-Token") || "",
    headers.get("Idempotency-Key") || "",
    headers.get("Cookie") || "",
  ].join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(config.GATEWAY_HMAC_SECRET.match(/../g), (s) =>
      parseInt(s, 16),
    ),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  for (const [name, value] of Object.entries({
    "X-Parcel-Timestamp": timestamp,
    "X-Parcel-Nonce": nonce,
    "X-Parcel-Subject": subject,
    "X-Parcel-Email": email,
    "X-Parcel-Client-IP": ip,
    "X-Parcel-Body-SHA256": digest,
    "X-Parcel-Signature": hex(
      await crypto.subtle.sign("HMAC", key, encoder.encode(canonical)),
    ),
    "CF-Access-Client-Id": config.ORIGIN_ACCESS_CLIENT_ID,
    "CF-Access-Client-Secret": config.ORIGIN_ACCESS_CLIENT_SECRET,
  }))
    headers.set(name, value);
  if (request.headers.has("Origin")) headers.set("Origin", config.PUBLIC_URL);
  return headers;
}

export function createGateway(deps = {}) {
  const originFetch = deps.fetch || fetch;
  const authenticate = deps.verifyAccess || verifyAccess;
  const now = deps.now || Date.now;
  const limits = new Map();
  function allow(key, max) {
    const time = now();
    if (limits.size >= 10000) {
      for (const [k, v] of limits) if (v.until <= time) limits.delete(k);
      if (!limits.has(key) && limits.size >= 10000) return false;
    }
    let entry = limits.get(key);
    if (!entry || entry.until <= time) {
      entry = { count: 0, until: time + 60000 };
      limits.set(key, entry);
    }
    return ++entry.count <= max;
  }
  return {
    async fetch(request, env) {
      let config;
      try {
        config = configuration(env);
      } catch {
        return security(
          problem(503, "gateway_unconfigured", "网关配置尚未完成"),
        );
      }
      const respond = (response, api = true) => security(response, config, api);
      const url = new URL(request.url);
      if (url.origin !== config.PUBLIC_URL)
        return respond(problem(403, "host_denied", "请使用正式访问地址"));
      if (url.href.length > 2048 || /%|\\|\/\//.test(url.pathname))
        return respond(problem(400, "invalid_path", "请求路径不正确"));
      const apiRoute = route(url.pathname, request.method);
      if (url.pathname.startsWith("/api")) {
        if (!apiRoute) return respond(problem(404, "not_found", "接口不存在"));
        if (!apiRoute.allowed)
          return respond(problem(405, "method_not_allowed", "请求方法不支持"));
        if (
          url.search &&
          !(
            url.pathname === "/api/v1/admin/shares" &&
            /^\?page=[1-9][0-9]{0,5}$/.test(url.search)
          )
        )
          return respond(problem(400, "invalid_query", "请求参数不正确"));
      } else if (request.method !== "GET" && request.method !== "HEAD")
        return respond(problem(405, "method_not_allowed", "请求方法不支持"));
      const adminPage =
        url.pathname === "/login" ||
        url.pathname === "/admin" ||
        url.pathname.startsWith("/admin/");
      const staticPage =
        url.pathname === "/" ||
        adminPage ||
        new RegExp(`^/s/${ID}$`).test(url.pathname) ||
        /^\/assets\/[A-Za-z0-9._-]+$/.test(url.pathname) ||
        url.pathname === "/favicon.ico";
      if (!apiRoute && !staticPage)
        return respond(problem(404, "not_found", "页面不存在"));
      const origin = request.headers.get("Origin");
      if (
        (origin && origin !== config.PUBLIC_URL) ||
        (apiRoute &&
          !["GET", "HEAD"].includes(request.method) &&
          origin !== config.PUBLIC_URL) ||
        (apiRoute && request.headers.get("Sec-Fetch-Site") === "cross-site")
      )
        return respond(problem(403, "origin_denied", "请求来源不受信任"));
      // Cross-site page navigations (including emailed share links) are allowed.
      let identity;
      if (adminPage || apiRoute?.admin) {
        try {
          identity = await authenticate(request, config);
        } catch {
          return respond(
            problem(401, "access_required", "请通过管理入口验证身份"),
          );
        }
      }
      if (!apiRoute) {
        if (url.pathname === "/login")
          return respond(
            new Response(null, {
              status: 303,
              headers: { Location: "/admin" },
            }),
          );
        const assetURL = new URL(request.url);
        if (
          !url.pathname.startsWith("/assets/") &&
          url.pathname !== "/favicon.ico"
        )
          // Pages canonicalizes /index.html to /. Fetch the canonical asset
          // directly so SPA navigation cannot redirect back into this worker.
          assetURL.pathname = "/";
        const response = await env.ASSETS.fetch(new Request(assetURL, request));
        const secured = respond(response, adminPage);
        if (!url.pathname.startsWith("/assets/"))
          secured.headers.set("Cache-Control", "private, no-store");
        return secured;
      }
      const ip = request.headers.get("CF-Connecting-IP");
      if (!ip)
        return respond(
          problem(403, "client_ip_missing", "请求未经过受信任入口"),
        );
      if (
        !allow(`api:${identity?.subject || ip}`, identity ? 600 : 120) ||
        (/\/(?:unlock|download-sessions(?:\/refresh)?)$/.test(url.pathname) &&
          !allow(`sensitive:${ip}`, 20))
      ) {
        const response = problem(
          429,
          "rate_limited",
          "请求过于频繁，请稍后重试",
        );
        response.headers.set("Retry-After", "60");
        return respond(response);
      }
      const length = request.headers.get("Content-Length");
      if (length && (!/^\d+$/.test(length) || Number(length) > 65536))
        return respond(problem(413, "body_too_large", "请求正文过大"));
      let body;
      try {
        body = await readBody(request, deps.bodyTimeoutMs || 15000);
      } catch (error) {
        if (error.message === "Body read timeout")
          return respond(problem(408, "request_timeout", "请求正文读取超时"));
        return respond(problem(413, "body_too_large", "请求正文过大"));
      }
      if (body.length) {
        if (
          request.headers
            .get("Content-Type")
            ?.split(";")[0]
            .trim()
            .toLowerCase() !== "application/json"
        )
          return respond(problem(415, "json_required", "请使用 JSON 请求正文"));
        try {
          const data = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(body),
          );
          if (!data || typeof data !== "object" || Array.isArray(data))
            throw new Error();
        } catch {
          return respond(
            problem(400, "invalid_json", "请求正文必须是单个 JSON 对象"),
          );
        }
      }
      try {
        const headers = await signedHeaders(
          request,
          config,
          identity,
          body,
          now(),
        );
        const response = await originFetch(
          config.ORIGIN_URL + url.pathname + url.search,
          {
            method: request.method,
            headers,
            body: body.length ? body : undefined,
            redirect: "manual",
            signal: AbortSignal.timeout(15000),
            cf: { cacheTtl: 0, cacheEverything: false },
          },
        );
        // Access redirects or HTML must never be exposed as an API response.
        if (
          (response.status >= 300 && response.status < 400) ||
          !response.headers
            .get("Content-Type")
            ?.toLowerCase()
            .startsWith("application/json")
        ) {
          await response.body?.cancel();
          return respond(
            problem(
              503,
              "origin_unavailable",
              "Origin 鉴权或响应不正确，请检查服务配置",
            ),
          );
        }
        const result = respond(response);
        // Service Auth cookies belong to the internal origin, never the browser.
        result.headers.delete("Set-Cookie");
        for (const cookie of response.headers.getSetCookie()) {
          if (
            /^parcel_grant_[A-Za-z0-9_-]{32}=/.test(cookie) &&
            !/;\s*domain=/i.test(cookie)
          )
            result.headers.append("Set-Cookie", cookie);
        }
        for (const name of [...result.headers.keys()])
          if (name.startsWith("cf-access-") || name.startsWith("x-parcel-"))
            result.headers.delete(name);
        return result;
      } catch {
        return respond(
          problem(503, "origin_unavailable", "服务暂时不可用，请稍后重试"),
        );
      }
    },
  };
}
export default createGateway();
