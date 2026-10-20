import { equal, hash, hmac, token } from "./crypto.mjs";
import {
  PASSWORD_PROTOCOL,
  passwordParameters,
  storePassword,
  verifyPassword,
} from "./password.mjs";
import { PART_BYTES, URL_TTL, R2Store } from "./r2.mjs";
import {
  E2EE_CHUNK_BYTES,
  E2EE_PART_BYTES,
  validateEncryption,
  storedEncryption,
  sameFileEncryption,
} from "./encryption.mjs";

export class Problem extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => {
  throw new Problem(status, code, message);
};
export const json = (value, status = 200, headers = {}) =>
  Response.json(value, { status, headers });
const integer = (value, fallback, min, max) => {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new Error("Invalid numeric configuration");
  return n;
};
export function configuration(env) {
  const adminAuth = env.ADMIN_AUTH || "access";
  if (!["access", "totp"].includes(adminAuth))
    throw new Error("Invalid administrator authentication mode");
  for (const key of [
    "PUBLIC_URL",
    ...(adminAuth === "access"
      ? ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "ADMIN_EMAILS"]
      : []),
    "SESSION_SECRET",
    "R2_ENDPOINT",
    "R2_BUCKET_NAME",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
  ])
    if (typeof env[key] !== "string" || !env[key] || /[\r\n]/.test(env[key]))
      throw new Error("Missing V3 configuration");
  for (const key of [
    "PUBLIC_URL",
    "R2_ENDPOINT",
    ...(adminAuth === "access" ? ["ACCESS_TEAM_DOMAIN"] : []),
  ]) {
    const u = new URL(env[key]);
    if (
      u.protocol !== "https:" ||
      u.origin !== env[key] ||
      u.username ||
      u.password ||
      u.port
    )
      throw new Error("Invalid origin");
  }
  if (
    (adminAuth === "access" &&
      !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(
        env.ACCESS_TEAM_DOMAIN,
      )) ||
    !/^https:\/\/[a-z0-9.-]+\.r2\.cloudflarestorage\.com$/.test(
      env.R2_ENDPOINT,
    ) ||
    !/^[-a-z0-9]{3,63}$/.test(env.R2_BUCKET_NAME) ||
    !/^[a-fA-F0-9]{64}$/.test(env.SESSION_SECRET) ||
    !env.DB ||
    !env.FILES
  )
    throw new Error("Invalid V3 configuration");
  if (
    env.ADMIN_SETUP_TOKEN !== undefined &&
    !/^[A-Za-z0-9_-]{32,128}$/.test(env.ADMIN_SETUP_TOKEN)
  )
    throw new Error(
      "Administrator setup token must be a random secret of at least 32 URL-safe characters",
    );
  const emails =
    adminAuth === "access"
      ? env.ADMIN_EMAILS.split(",").map((s) => s.trim().toLowerCase())
      : [];
  if (emails.some((s) => !/^\S+@[^\s@,]+$/.test(s)))
    throw new Error("Invalid allowlist");
  const maxTTL = integer(env.MAX_SHARE_TTL_SECONDS, 604800, 1, 31536000);
  return {
    ...env,
    adminAuth,
    emails,
    quota: integer(
      env.STORAGE_QUOTA_BYTES,
      20 * 2 ** 30,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    maxFile: integer(env.MAX_FILE_BYTES, 8 * 2 ** 30, 1, PART_BYTES * 10000),
    maxTTL,
    defaultTTL: integer(env.DEFAULT_SHARE_TTL_SECONDS, 86400, 1, maxTTL),
    downloadLimit: integer(env.DEFAULT_DOWNLOAD_LIMIT, 3, 1, 100),
    downloadTTL: integer(env.DOWNLOAD_MAX_TTL_SECONDS, 28800, 300, 86400),
    uploadTTL: integer(env.UPLOAD_IDLE_TTL_SECONDS, 86400, 300, 604800),
    cleanupBatch: integer(
      env.CLEANUP_BATCH_SIZE,
      1,
      1,
      env.WORKERS_PLAN === "paid" ? 30 : 1,
    ),
    enabled: env.ACTIVE !== "false",
  };
}
const writable = ["created", "uploading"];
const countParts = (u) => Math.max(1, Math.ceil(u.size / u.part_bytes));
const sizePart = (u, n) =>
  Math.min(u.part_bytes, u.size - (n - 1) * u.part_bytes);
function validParts(u, parts) {
  return (
    parts.length === countParts(u) &&
    parts.every(
      (p, i) => p.number === i + 1 && p.size === sizePart(u, i + 1) && p.etag,
    )
  );
}
export class Service {
  constructor(config, ctx, deps = {}) {
    this.c = config;
    this.db = config.DB;
    this.ctx = ctx;
    this.now = deps.now || (() => Math.floor(Date.now() / 1000));
    this.r2 = deps.store || new R2Store(config, this.now, deps.fetch);
  }
  stmt(sql, ...args) {
    return this.db.prepare(sql).bind(...args);
  }
  first(sql, ...args) {
    return this.stmt(sql, ...args).first();
  }
  run(sql, ...args) {
    return this.stmt(sql, ...args).run();
  }
  async rows(sql, ...args) {
    return (await this.stmt(sql, ...args).all()).results;
  }
  audit(action, target, result = "ok") {
    return this.run(
      "INSERT INTO audit_events(action,target,result,created) VALUES(?,?,?,?)",
      action,
      target,
      result,
      this.now(),
    );
  }
  async csrf(identity) {
    if (this.c.adminAuth === "totp") return identity.csrf;
    return hmac(
      this.c.SESSION_SECRET,
      `parcel-v3-csrf\n${identity.subject}\n${identity.email}`,
    );
  }
  async limits(request, path, identity) {
    const ip = request.headers.get("CF-Connecting-IP");
    if (!ip || ip.length > 45 || !/^[a-fA-F0-9:.]+$/.test(ip))
      fail(403, "client_ip_missing", "请求未经过受信任入口");
    // The optional Workers binding handles general traffic. Persistent D1
    // limits below protect expensive/authority-changing public operations.
    const limiter = identity ? this.c.ADMIN_LIMITER : this.c.API_LIMITER;
    if (
      limiter &&
      !(await limiter.limit({ key: identity?.subject || ip })).success
    )
      fail(429, "rate_limited", "请求过于频繁，请稍后重试");
    if (!/\/(unlock|download-sessions(?:\/refresh)?)$/.test(path)) return;
    const now = this.now(),
      window = Math.floor(now / 60);
    const keys = [[`ip:${await hmac(this.c.SESSION_SECRET, ip)}`, 20]];
    if (path.endsWith("/unlock"))
      keys.push([`share:${path.split("/")[4]}`, 20]);
    const result = await this.db.batch(
      keys.map(([key]) =>
        this.stmt(
          `INSERT INTO rate_limits(key,window,count,expires) VALUES(?,?,1,?)
      ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END,
      window=excluded.window,expires=excluded.expires RETURNING count`,
          key,
          window,
          now + 120,
        ),
      ),
    );
    if (result.some((r, i) => r.results[0].count > keys[i][1]))
      fail(429, "rate_limited", "请求过于频繁，请稍后重试");
  }
  uploadJSON(u, parts) {
    const encryption = storedEncryption(u);
    return {
      id: u.id,
      name: "encrypted.parcel",
      size: u.plaintext_size,
      offset:
        u.offset === u.size
          ? u.plaintext_size
          : Math.floor(u.offset / u.part_bytes) * E2EE_CHUNK_BYTES,
      stored_size: u.size,
      stored_offset: u.offset,
      encryption,
      unsupported: !encryption,
      ttl_seconds: u.ttl,
      max_downloads: u.max_downloads,
      state: u.state,
      share_id: u.share_id,
      created: u.created,
      updated: u.updated,
      error: u.error,
      storage_backend: "r2",
      part_bytes: E2EE_CHUNK_BYTES,
      stored_part_bytes: u.part_bytes,
      ...(parts ? { parts } : {}),
    };
  }
  availability(s) {
    return s.state !== "active"
      ? s.state
      : s.expires <= this.now()
        ? "expired"
        : s.max_downloads !== -1 && s.download_count >= s.max_downloads
          ? "exhausted"
          : "available";
  }
  shareJSON(s) {
    const encryption = storedEncryption(s);
    return {
      id: s.id,
      upload_id: s.upload_id,
      name: encryption ? "encrypted.parcel" : "旧版分享（已停用）",
      size: s.plaintext_size,
      stored_size: s.size,
      sha256: "",
      encryption,
      unsupported: !encryption,
      created: s.created,
      expires: s.expires,
      max_downloads: s.max_downloads,
      download_count: s.download_count,
      version: s.version,
      state: s.state,
      error: s.error,
      storage_backend: "r2",
      etag: s.etag,
      password_required: !!s.password_hash,
      password_protocol: PASSWORD_PROTOCOL,
      password_kdf: encryption
        ? passwordParameters(s.password_hash)
        : undefined,
      availability: this.availability(s),
      url: this.c.PUBLIC_URL + "/s/" + s.id,
    };
  }
  async upload(id) {
    const u = await this.first("SELECT * FROM uploads WHERE id=?", id);
    if (!u) fail(404, "not_found", "上传不存在");
    return u;
  }
  async share(id) {
    const s = await this.first("SELECT * FROM shares WHERE id=?", id);
    if (!s) fail(404, "not_found", "分享不存在");
    return s;
  }
  requireEncryption(row) {
    const encryption = storedEncryption(row);
    if (!encryption)
      fail(410, "encryption_required", "旧版分享已停用，请重新加密上传文件");
    return encryption;
  }
  validatePasswordEnvelope(encryption, data) {
    if (!!encryption.password_kdf !== !!data.password_proof)
      fail(400, "invalid_encryption", "密码保护与加密密钥封装不一致");
    // The online verifier must use an independent Argon2 salt. It may never
    // accidentally disclose the password-derived root used by the envelope.
    const proofSalt = data.password_proof?.salt;
    if (
      encryption.password_kdf &&
      typeof proofSalt === "string" &&
      proofSalt.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") ===
        encryption.password_kdf.salt
    )
      fail(
        400,
        "invalid_encryption",
        "密码验证和文件加密必须使用独立的派生参数",
      );
  }
  async lease(table, id, states) {
    const value = token();
    const row = await this.first(
      `UPDATE ${table} SET lease_token=?,lease_until=? WHERE id=? AND lease_until<=? AND state IN (${states.map(() => "?").join(",")}) RETURNING *`,
      value,
      this.now() + 90,
      id,
      this.now(),
      ...states,
    );
    if (!row) {
      const row = await this.first(`SELECT state FROM ${table} WHERE id=?`, id);
      if (!row) fail(404, "not_found", "任务不存在");
      if (!states.includes(row.state))
        fail(409, "upload_not_writable", "上传状态已改变");
      fail(503, "busy", "任务正在处理，请稍后重试");
    }
    return row;
  }
  release(table, row) {
    return this.run(
      `UPDATE ${table} SET lease_token='',lease_until=0 WHERE id=? AND lease_token=?`,
      row.id,
      row.lease_token,
    );
  }
  async ensureMultipart(u) {
    if (u.multipart_id) return u;
    const id = await this.r2.create(u);
    const changed = await this.run(
      "UPDATE uploads SET multipart_id=? WHERE id=? AND lease_token=? AND lease_until>? AND state IN ('created','uploading')",
      id,
      u.id,
      u.lease_token,
      this.now(),
    );
    if (changed.meta.changes !== 1) {
      await this.r2.abort({ ...u, multipart_id: id });
      fail(503, "busy", "任务处理超时，请重试");
    }
    u.multipart_id = id;
    return u;
  }
  async refresh(u) {
    await this.ensureMultipart(u);
    const parts = await this.r2.parts(u);
    let offset = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.number !== i + 1 || p.size !== sizePart(u, i + 1) || !p.etag) break;
      offset += p.size;
    }
    const changed = await this.first(
      "UPDATE uploads SET offset=?,state='uploading',updated=? WHERE id=? AND lease_token=? AND lease_until>? AND state IN ('created','uploading') RETURNING id",
      offset,
      this.now(),
      u.id,
      u.lease_token,
      this.now(),
    );
    if (!changed) fail(503, "busy", "任务处理超时，请重试");
    return {
      u: { ...u, offset, state: "uploading", updated: this.now() },
      parts,
    };
  }
  async create(data, request) {
    const plainSize = data.size;
    if (
      !Number.isSafeInteger(plainSize) ||
      plainSize < 0 ||
      plainSize > this.c.maxFile
    )
      fail(413, "file_too_large", "文件超过大小限制");
    if (
      data.name !== undefined ||
      data.type !== undefined ||
      data.sha256 !== undefined
    )
      fail(
        400,
        "encrypted_metadata_required",
        "文件名和校验值必须在浏览器端加密",
      );
    if (
      Object.keys(data).some(
        (key) =>
          ![
            "size",
            "encryption",
            "ttl_seconds",
            "max_downloads",
            "password",
            "password_proof",
            "confirm_large",
          ].includes(key),
      )
    )
      fail(400, "invalid_encryption", "上传请求包含不支持的加密参数");
    let encryption, size;
    try {
      ({ encryption, storedSize: size } = validateEncryption(
        data.encryption,
        plainSize,
      ));
    } catch {
      fail(400, "invalid_encryption", "请使用端到端加密上传协议");
    }
    this.validatePasswordEnvelope(encryption, data);
    const name = "encrypted.parcel";
    if (plainSize > 100000000 && data.confirm_large !== true)
      fail(400, "confirmation_required", "超过 100 MB 需要确认后上传");
    const ttl = data.ttl_seconds || this.c.defaultTTL,
      limit = data.max_downloads || this.c.downloadLimit;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > this.c.maxTTL)
      fail(400, "invalid_ttl", "分享有效期不合法");
    if (
      !Number.isSafeInteger(limit) ||
      (limit !== -1 && (limit < 1 || limit > 100))
    )
      fail(400, "invalid_limit", "下载次数应为 1–100，或选择不限次数");
    if (data.password !== undefined && data.password !== "")
      fail(400, "password_derivation_required", "请使用浏览器密码处理协议");
    const password = data.password_proof || null;
    const raw = request.headers.get("Idempotency-Key") || "";
    if (raw.length > 128 || /[\x00-\x1f]/.test(raw))
      fail(400, "invalid_idempotency_key", "幂等键不合法");
    const idem = raw ? await hash(raw) : null;
    const fingerprint = await hmac(
      this.c.SESSION_SECRET,
      JSON.stringify({ size, plainSize, encryption, ttl, limit, password }),
    );
    const existing = async () => {
      const u = idem
        ? await this.first("SELECT * FROM uploads WHERE idem=?", idem)
        : null;
      if (u && u.request_hash !== fingerprint)
        fail(409, "idempotency_conflict", "幂等键已用于其他上传");
      return u;
    };
    const found = await existing();
    if (found) return json(this.uploadJSON(found));
    const passwordHash = await this.passwordHash(data);
    const id = token(),
      share = token(),
      now = this.now();
    // Both the quota predicate and trigger execute inside the same D1 write.
    const inserted = await this.first(
      `INSERT INTO uploads(id,name,size,plaintext_size,encryption,part_bytes,ttl,max_downloads,password_hash,state,storage_key,share_id,created,updated,idem,request_hash)
      SELECT ?,?,?,?,?,?,?,?,?,'created',?,?,?,?,?,? FROM storage_usage WHERE id=1 AND ?<=?-used-reserved
      AND (SELECT count(*) FROM uploads WHERE state NOT IN ('completed','cleaned'))<100
      ON CONFLICT(idem) DO NOTHING RETURNING *`,
      id,
      name,
      size,
      plainSize,
      JSON.stringify(encryption),
      E2EE_PART_BYTES,
      ttl,
      limit,
      passwordHash,
      `parcel/v3/${id}`,
      share,
      now,
      now,
      idem,
      fingerprint,
      size,
      this.c.quota,
    );
    if (!inserted) {
      const raced = await existing();
      if (raced) return json(this.uploadJSON(raced));
      fail(
        507,
        "r2_quota_exceeded",
        "R2 存储保护额度不足或未完成任务过多，请等待清理释放空间",
      );
    }
    this.ctx.waitUntil(this.audit("upload_created", id));
    return json(this.uploadJSON(inserted), 201);
  }
  async getUpload(id) {
    let u = await this.upload(id);
    this.requireEncryption(u);
    if (u.state === "finalizing") {
      if (u.retry_at <= this.now()) this.ctx.waitUntil(this.finalize(id));
      return json(this.uploadJSON(u));
    }
    if (!writable.includes(u.state)) return json(this.uploadJSON(u));
    u = await this.lease("uploads", id, writable);
    try {
      const r = await this.refresh(u);
      return json(this.uploadJSON(r.u, r.parts));
    } finally {
      await this.release("uploads", u);
    }
  }
  async signPart(id, number) {
    let u = await this.lease("uploads", id, writable);
    try {
      this.requireEncryption(u);
      if (!Number.isSafeInteger(number) || number < 1 || number > countParts(u))
        fail(400, "invalid_part", "分块编号不合法");
      await this.ensureMultipart(u);
      const size = sizePart(u, number),
        url = await this.r2.signPart(u, number, size);
      // A successful signing is upload activity too (important for a slow link).
      await this.run(
        "UPDATE uploads SET updated=? WHERE id=? AND lease_token=?",
        this.now(),
        id,
        u.lease_token,
      );
      return json({ url, size, expires: this.now() + URL_TTL });
    } finally {
      await this.release("uploads", u);
    }
  }
  async complete(id) {
    let u = await this.upload(id);
    this.requireEncryption(u);
    if (u.state === "completed") return json(this.uploadJSON(u), 202);
    if (u.state !== "finalizing") {
      u = await this.lease("uploads", id, writable);
      try {
        const refreshed = await this.refresh(u);
        if (!validParts(u, refreshed.parts))
          fail(409, "upload_incomplete", "R2 分块尚未完整或大小不匹配");
        u = refreshed.u;
        const changed = await this.first(
          "UPDATE uploads SET state='finalizing',updated=? WHERE id=? AND lease_token=? AND lease_until>? AND state IN ('created','uploading') RETURNING id",
          this.now(),
          id,
          u.lease_token,
          this.now(),
        );
        if (!changed) fail(503, "busy", "任务处理超时，请重试");
      } finally {
        await this.release("uploads", u);
      }
    }
    this.ctx.waitUntil(this.finalize(id));
    return json(this.uploadJSON({ ...u, state: "finalizing" }), 202);
  }
  async finalize(id) {
    let u;
    try {
      u = await this.lease("uploads", id, ["finalizing"]);
      let object = await this.r2.head(u.storage_key);
      if (!object) {
        const parts = await this.r2.parts(u);
        if (!validParts(u, parts))
          fail(409, "r2_mismatch", "R2 分块大小与任务不一致");
        try {
          await this.r2.complete(u, parts);
        } catch (error) {
          object = await this.r2.head(u.storage_key);
          if (!object) throw error;
        }
        object = object || (await this.r2.head(u.storage_key));
      }
      if (
        !object ||
        object.size !== u.size ||
        object.customMetadata?.["parcel-upload"] !== u.id ||
        !object.etag
      )
        fail(409, "r2_mismatch", "R2 对象与上传任务不一致");
      const now = this.now();
      const result = await this.db.batch([
        this.stmt(
          `INSERT INTO shares(id,upload_id,storage_key,name,size,plaintext_size,encryption,password_hash,created,expires,max_downloads,etag)
          SELECT share_id,id,storage_key,name,size,plaintext_size,encryption,password_hash,?,?+ttl,max_downloads,? FROM uploads
          WHERE id=? AND state='finalizing' AND lease_token=? AND lease_until>? ON CONFLICT(upload_id) DO NOTHING`,
          now,
          now,
          object.etag,
          u.id,
          u.lease_token,
          now,
        ),
        this.stmt(
          `UPDATE uploads SET state='completed',offset=size,updated=?,error='' WHERE id=? AND state='finalizing' AND lease_token=? AND lease_until>?
          AND EXISTS(SELECT 1 FROM shares WHERE upload_id=uploads.id) RETURNING id`,
          now,
          u.id,
          u.lease_token,
          now,
        ),
      ]);
      if (result[1].results.length !== 1)
        fail(503, "busy", "发布租约失效，将自动恢复");
      await this.audit("upload_published", id);
    } catch (e) {
      if (u) {
        const mismatch = e.code === "r2_mismatch";
        await this.run(
          "UPDATE uploads SET state=?,error=?,attempts=attempts+1,retry_at=? WHERE id=? AND state='finalizing' AND lease_token=?",
          mismatch ? "failed" : "finalizing",
          mismatch ? e.message : "存储服务暂时不可用，将自动重试",
          this.now() + Math.min(3600, 2 ** Math.min(u.attempts + 1, 10) * 5),
          id,
          u.lease_token,
        );
      } else if (
        e.code !== "busy" &&
        e.code !== "upload_not_writable" &&
        e.code !== "not_found"
      )
        throw e;
    } finally {
      if (u) await this.release("uploads", u);
    }
  }
  async cancel(id) {
    let u = await this.upload(id);
    if (["finalizing", "completed"].includes(u.state))
      fail(
        409,
        u.state === "completed" ? "already_completed" : "upload_finalizing",
        "上传已进入发布流程，请查询结果或撤销分享",
      );
    if (u.state === "cleaned") return json({ ok: true });
    u = await this.lease("uploads", id, [...writable, "failed", "canceled"]);
    try {
      await this.run(
        "UPDATE uploads SET state='canceled',updated=? WHERE id=? AND lease_token=?",
        this.now(),
        id,
        u.lease_token,
      );
      u.state = "canceled";
      await this.r2.abort(u);
      await this.r2.delete(u.storage_key);
      await this.run(
        "UPDATE uploads SET state='cleaned',error='',updated=? WHERE id=? AND lease_token=? AND state='canceled'",
        this.now(),
        id,
        u.lease_token,
      );
      return json({ ok: true });
    } finally {
      await this.release("uploads", u);
    }
  }
  async granted(request, s) {
    if (!s.password_hash) return true;
    const value = request.headers
      .get("Cookie")
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(`parcel_grant_${s.id}=`))
      ?.split("=")[1];
    if (!value || !/^[A-Za-z0-9_-]{32}$/.test(value)) return false;
    return !!(await this.first(
      "SELECT 1 FROM share_grants WHERE token_hash=? AND share_id=? AND version=? AND expires>?",
      await hash(value),
      s.id,
      s.version,
      this.now(),
    ));
  }
  async getShare(id, request) {
    const s = await this.share(id);
    const encryption = this.requireEncryption(s);
    if (!(await this.granted(request, s)))
      return json({
        id,
        password_required: true,
        password_protocol: PASSWORD_PROTOCOL,
        password_kdf: passwordParameters(s.password_hash),
        encryption,
        version: s.version,
        locked: true,
        availability: this.availability(s),
      });
    return json(this.shareJSON(s));
  }
  async unlock(id, data) {
    const s = await this.share(id);
    this.requireEncryption(s);
    if (s.state !== "active" || s.expires <= this.now())
      fail(410, "share_expired", "分享已失效");
    if (
      s.password_hash &&
      !(await verifyPassword(
        data.password_proof,
        s.password_hash,
        this.c.SESSION_SECRET,
      ))
    )
      fail(401, "invalid_password", "分享密码不正确");
    const value = token(),
      expires = this.now() + 1800;
    const changed = await this.run(
      `INSERT INTO share_grants(token_hash,share_id,version,expires)
      SELECT ?,id,version,? FROM shares WHERE id=? AND version=? AND state='active' AND expires>?`,
      await hash(value),
      expires,
      id,
      s.version,
      this.now(),
    );
    if (changed.meta.changes !== 1)
      fail(410, "share_expired", "分享权限已经改变，请重新打开链接");
    return json(this.shareJSON(s), 200, {
      "Set-Cookie": `parcel_grant_${id}=${value}; Path=/api/v1/shares/${id}; Secure; HttpOnly; SameSite=Strict; Max-Age=1800`,
    });
  }
  async revoke(id) {
    const s = await this.share(id);
    if (s.state === "deleted") return json({ ok: true });
    await this.db.batch([
      this.stmt(
        "UPDATE shares SET state='revoked',version=version+1 WHERE id=? AND state NOT IN ('deleted','deleting')",
        id,
      ),
      this.stmt(
        "UPDATE download_sessions SET state='revoked' WHERE share_id=?",
        id,
      ),
      this.stmt("DELETE FROM share_grants WHERE share_id=?", id),
      this.stmt(
        "INSERT INTO audit_events(action,target,result,created) VALUES('share_revoked',?,'ok',?)",
        id,
        this.now(),
      ),
    ]);
    return json({ ok: true });
  }
  async passwordHash(data) {
    if (data.password !== undefined && data.password !== "")
      fail(400, "password_derivation_required", "请使用浏览器密码处理协议");
    if (data.password_proof === undefined) return "";
    try {
      return await storePassword(data.password_proof, this.c.SESSION_SECRET);
    } catch {
      fail(400, "invalid_password", "密码保护参数不正确");
    }
  }
  async changePassword(id, data) {
    const s = await this.share(id),
      current = this.requireEncryption(s);
    if (
      Object.keys(data).some(
        (key) =>
          !["encryption", "password", "password_proof", "version"].includes(
            key,
          ),
      )
    )
      fail(400, "invalid_encryption", "密码更新请求包含不支持的加密参数");
    if (data.password_proof === undefined && data.password !== "")
      fail(400, "invalid_password", "请提供新密码或明确移除密码保护");
    let encryption;
    try {
      ({ encryption } = validateEncryption(data.encryption, s.plaintext_size));
    } catch {
      fail(400, "invalid_encryption", "请提供重新封装后的加密密钥");
    }
    if (!sameFileEncryption(current, encryption))
      fail(400, "invalid_encryption", "文件加密参数不能改变");
    this.validatePasswordEnvelope(encryption, data);
    if (!Number.isSafeInteger(data.version) || data.version !== s.version)
      fail(409, "share_changed", "分享设置已经改变，请刷新后重试");
    const password = await this.passwordHash(data);
    const result = await this.db.batch([
      this.stmt(
        "UPDATE shares SET password_hash=?,encryption=?,version=version+1 WHERE id=? AND version=? AND state='active' AND expires>? RETURNING version",
        password,
        JSON.stringify(encryption),
        id,
        s.version,
        this.now(),
      ),
      this.stmt(
        "UPDATE download_sessions SET state='revoked' WHERE share_id=? AND version!=(SELECT version FROM shares WHERE id=?)",
        id,
        id,
      ),
      this.stmt(
        "DELETE FROM share_grants WHERE share_id=? AND version!=(SELECT version FROM shares WHERE id=?)",
        id,
        id,
      ),
    ]);
    if (!result[0].meta.changes) {
      const current = await this.share(id);
      if (current.version !== s.version)
        fail(409, "share_changed", "分享设置已经改变，请刷新后重试");
      fail(410, "share_expired", "分享已失效");
    }
    this.ctx.waitUntil(this.audit("share_password_changed", id));
    return json({ ok: true });
  }
  grantPredicate() {
    return "(password_hash='' OR EXISTS(SELECT 1 FROM share_grants WHERE token_hash=? AND share_id=shares.id AND version=shares.version AND expires>?))";
  }
  async grantHash(request, id) {
    const value =
      request.headers
        .get("Cookie")
        ?.split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith(`parcel_grant_${id}=`))
        ?.slice(`parcel_grant_${id}=`.length) || "";
    return hash(value);
  }
  async recoverAdmission(id, request, value, admission) {
    if (admission.share_id !== id)
      fail(409, "idempotency_conflict", "下载请求标识已用于其他分享");
    if (
      admission.token_hash !== (await hash(value)) ||
      !(await this.first(
        "SELECT 1 FROM download_sessions WHERE token_hash=? AND share_id=?",
        admission.token_hash,
        id,
      ))
    )
      fail(410, "download_unavailable", "原下载会话已失效，请明确建立新会话");
    return this.download(id, request, { session: value }, true);
  }
  async download(id, request, data, refresh = false) {
    const s = await this.share(id);
    this.requireEncryption(s);
    let now = this.now();
    let admissionHash = null,
      admissionValue;
    if (!refresh && data.request_token !== undefined) {
      if (
        typeof data.request_token !== "string" ||
        !/^[A-Za-z0-9_-]{32}$/.test(data.request_token)
      )
        fail(400, "invalid_idempotency_key", "下载请求标识不合法");
      admissionHash = await hash(
        `parcel-v3-download-admission-v1\n${data.request_token}`,
      );
      const derived = await hmac(
        this.c.SESSION_SECRET,
        `parcel-v3-download-capability-v1\n${id}\n${data.request_token}`,
      );
      admissionValue = btoa(
        String.fromCharCode(
          ...derived
            .slice(0, 48)
            .match(/../g)
            .map((byte) => parseInt(byte, 16)),
        ),
      )
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
      const existing = await this.first(
        "SELECT * FROM download_admissions WHERE request_hash=?",
        admissionHash,
      );
      if (existing)
        return this.recoverAdmission(id, request, admissionValue, existing);
    }
    if (!refresh && !(await this.granted(request, s)))
      fail(401, "share_locked", "请先验证分享密码");
    const grant = await this.grantHash(request, id);
    let session, value, expiry;
    if (refresh) {
      value = data.session;
      if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(value))
        fail(401, "invalid_ticket", "下载会话无效");
      session = await this.first(
        "SELECT * FROM download_sessions WHERE token_hash=? AND share_id=?",
        await hash(value),
        id,
      );
      if (!session) fail(401, "invalid_ticket", "下载会话无效");
      if (
        session.state !== "active" ||
        session.version !== s.version ||
        session.expires <= now ||
        session.last_activity + 1800 <= now ||
        s.state !== "active" ||
        s.expires <= now
      )
        fail(410, "download_unavailable", "下载会话或分享已失效");
      expiry = session.expires;
    } else {
      if (this.availability(s) !== "available")
        fail(410, "share_unavailable", "分享已失效或下载次数已用完");
      value = admissionValue || token();
      expiry = now + this.c.downloadTTL;
    }
    // Sign before the transaction: signing failures never consume a count. All
    // authorization predicates are rechecked in the atomic write, not just above.
    const signedAt = this.now();
    const url = await this.r2.signGet(s),
      sessionHash = await hash(value);
    // Expiry can advance while signing yields. Validate with a fresh timestamp
    // at admission and retain the actual signing deadline separately.
    now = this.now();
    if (!refresh) expiry = now + this.c.downloadTTL;
    const urlExpires = signedAt + URL_TTL,
      retain = Math.max(expiry, urlExpires);
    let result;
    if (refresh) {
      result = await this.db.batch([
        this.stmt(
          `UPDATE download_sessions SET last_activity=? WHERE token_hash=? AND share_id=? AND state='active' AND expires>max(?,unixepoch()) AND last_activity>max(?,unixepoch()-1800)
          AND version=? AND EXISTS(SELECT 1 FROM shares WHERE id=? AND state='active' AND expires>max(?,unixepoch()) AND version=?) RETURNING token_hash`,
          now,
          sessionHash,
          id,
          now,
          now - 1800,
          s.version,
          id,
          now,
          s.version,
        ),
        this.stmt(
          `UPDATE shares SET signed_until=max(signed_until,?) WHERE id=? AND state='active' AND expires>max(?,unixepoch()) AND version=?
          AND EXISTS(SELECT 1 FROM download_sessions WHERE token_hash=? AND share_id=? AND state='active' AND version=? AND last_activity=?)`,
          retain,
          id,
          now,
          s.version,
          sessionHash,
          id,
          s.version,
          now,
        ),
      ]);
    } else {
      result = await this.db.batch([
        this.stmt(
          `INSERT INTO download_sessions(token_hash,share_id,version,state,created,activated,last_activity,expires)
          SELECT ?,id,version,'active',?,?,?,? FROM shares WHERE id=? AND state='active' AND expires>max(?,unixepoch()) AND version=?
          AND (max_downloads=-1 OR download_count<max_downloads) AND ${this.grantPredicate()}
          AND (? IS NULL OR NOT EXISTS(SELECT 1 FROM download_admissions WHERE request_hash=?))
          ON CONFLICT(token_hash) DO NOTHING RETURNING token_hash`,
          sessionHash,
          now,
          now,
          now,
          expiry,
          id,
          now,
          s.version,
          grant,
          now,
          admissionHash,
          admissionHash,
        ),
        this.stmt(
          `UPDATE shares SET download_count=download_count+1,signed_until=max(signed_until,?) WHERE id=?
          AND changes()=1 AND EXISTS(SELECT 1 FROM download_sessions WHERE token_hash=? AND share_id=shares.id)`,
          retain,
          id,
          sessionHash,
        ),
        ...(admissionHash
          ? [
              this.stmt(
                `INSERT INTO download_admissions(request_hash,share_id,token_hash)
          SELECT ?,share_id,token_hash FROM download_sessions WHERE token_hash=? AND share_id=?
          ON CONFLICT(request_hash) DO NOTHING`,
                admissionHash,
                sessionHash,
                id,
              ),
            ]
          : []),
      ]);
    }
    if (!refresh && admissionHash && result[0].meta.changes !== 1) {
      const admitted = await this.first(
        "SELECT * FROM download_admissions WHERE request_hash=?",
        admissionHash,
      );
      if (admitted)
        return this.recoverAdmission(id, request, admissionValue, admitted);
    }
    if (result[0].meta.changes !== 1)
      fail(
        410,
        refresh ? "download_unavailable" : "share_unavailable",
        "分享权限或下载资格已经改变",
      );
    return json(
      {
        url,
        session: value,
        expires: urlExpires,
        session_expires: expiry,
        max_ttl_seconds: this.c.downloadTTL,
      },
      refresh ? 200 : 201,
    );
  }
  async list(page) {
    const result = await this.db.batch([
      this.stmt(
        "SELECT * FROM shares ORDER BY created DESC,id LIMIT 20 OFFSET ?",
        (page - 1) * 20,
      ),
      this.stmt(
        "SELECT count(*) AS total,coalesce(sum(state='deleted'),0) AS cleaned_count FROM shares",
      ),
    ]);
    return json({
      items: result[0].results.map((s) => this.shareJSON(s)),
      page,
      ...result[1].results[0],
    });
  }
  async status() {
    const result = await this.db.batch([
      this.stmt("SELECT * FROM storage_usage WHERE id=1"),
      this.stmt(
        "SELECT coalesce(sum(size),0) AS pending FROM shares WHERE state='deleting'",
      ),
      this.stmt(
        "SELECT count(*) AS active_uploads FROM uploads WHERE state IN ('created','uploading')",
      ),
      this.stmt(
        "SELECT count(*) AS active_finalizations FROM uploads WHERE state='finalizing'",
      ),
    ]);
    const { used, reserved } = result[0].results[0],
      available = Math.max(0, this.c.quota - used - reserved);
    return json({
      storage_backend: "r2",
      backend_mode: "serverless",
      password_protocol: PASSWORD_PROTOCOL,
      encryption_required: true,
      version: "3.0.0-dev",
      base_url: this.c.PUBLIC_URL,
      used_bytes: used,
      reserved_bytes: reserved,
      pending_bytes: result[1].results[0].pending,
      free_bytes: available,
      quota_bytes: this.c.quota,
      min_free_bytes: 0,
      r2_used_bytes: used,
      r2_reserved_bytes: reserved,
      r2_available_bytes: available,
      r2_quota_bytes: this.c.quota,
      upload_confirmation_bytes: 100000000,
      max_file_bytes: this.c.maxFile,
      chunk_bytes: PART_BYTES,
      default_ttl_seconds: this.c.defaultTTL,
      max_ttl_seconds: this.c.maxTTL,
      default_download_limit: this.c.downloadLimit,
      ...result[2].results[0],
      ...result[3].results[0],
    });
  }
  async dispatch(path, method, data, identity, request) {
    if (path === "/api/v1/auth/session")
      return json({
        authenticated: true,
        auth_mode: "access",
        password_protocol: PASSWORD_PROTOCOL,
        email: identity.email,
        csrf: await this.csrf(identity),
      });
    if (path === "/api/v1/auth/logout")
      return json({ ok: true, logout_url: "/cdn-cgi/access/logout" });
    if (path === "/api/v1/admin/status") return this.status();
    if (path === "/api/v1/uploads") return this.create(data, request);
    if (path === "/api/v1/uploads/lookup") {
      const raw = request.headers.get("Idempotency-Key") || "";
      if (!raw || raw.length > 128)
        fail(400, "invalid_idempotency_key", "请提供有效幂等键");
      const u = await this.first(
        "SELECT * FROM uploads WHERE idem=?",
        await hash(raw),
      );
      if (!u) fail(404, "not_found", "上传不存在");
      return json(this.uploadJSON(u));
    }
    if (path === "/api/v1/admin/shares")
      return this.list(
        Number(new URL(request.url).searchParams.get("page") || 1),
      );
    if (path === "/api/v1/admin/shares/cleaned") {
      const removed = (
        await this.rows(
          "DELETE FROM shares WHERE id IN (SELECT id FROM shares WHERE state='deleted' LIMIT 100) RETURNING id",
        )
      ).length;
      return json({
        removed,
        remaining: !!(await this.first(
          "SELECT 1 FROM shares WHERE state='deleted' LIMIT 1",
        )),
      });
    }
    const segments = path.split("/"),
      id = segments[4],
      action = segments.slice(5).join("/");
    if (segments[3] === "uploads") {
      if (!action)
        return method === "GET" ? this.getUpload(id) : this.cancel(id);
      if (action === "complete") return this.complete(id);
      if (action.startsWith("parts/"))
        return this.signPart(id, Number(segments[6]));
      fail(409, "legacy_upload_unsupported", "V3 使用 Multipart 分块上传");
    }
    if (segments[3] === "admin") {
      const shareID = segments[5];
      if (segments[6] === "password") return this.changePassword(shareID, data);
      return method === "GET"
        ? json(this.shareJSON(await this.share(shareID)))
        : this.revoke(shareID);
    }
    if (!action) return this.getShare(id, request);
    if (action === "unlock") return this.unlock(id, data);
    return this.download(id, request, data, action.endsWith("/refresh"));
  }
  async cleanupShare(id) {
    let s;
    try {
      // Claim and block new tickets atomically before issuing a remote delete.
      const lease = token(),
        now = this.now();
      s = await this.first(
        `UPDATE shares SET state='deleting',lease_token=?,lease_until=? WHERE id=? AND state!='deleted' AND signed_until<=? AND retry_at<=? AND lease_until<=?
        AND (state!='active' OR expires<=? OR (max_downloads!=-1 AND download_count>=max_downloads)) RETURNING *`,
        lease,
        now + 90,
        id,
        now,
        now,
        now,
        now,
      );
      if (!s) return;
      await this.r2.delete(s.storage_key);
      await this.run(
        "UPDATE shares SET state='deleted',deleted_at=?,error='',lease_token='',lease_until=0 WHERE id=? AND lease_token=? AND lease_until>?",
        this.now(),
        id,
        s.lease_token,
        this.now(),
      );
    } catch {
      if (s)
        await this.run(
          "UPDATE shares SET error='文件清理失败，将自动重试',delete_attempts=delete_attempts+1,retry_at=? WHERE id=? AND lease_token=?",
          this.now() +
            Math.min(3600, 5 * 2 ** Math.min(s.delete_attempts + 1, 10)),
          id,
          s.lease_token,
        );
    } finally {
      if (s) await this.release("shares", s);
    }
  }
  async cleanupUpload(id) {
    let u;
    try {
      u = await this.lease("uploads", id, [...writable, "failed", "canceled"]);
      if (
        writable.includes(u.state) &&
        u.updated > this.now() - this.c.uploadTTL
      )
        return;
      await this.run(
        "UPDATE uploads SET state='canceled' WHERE id=? AND lease_token=?",
        id,
        u.lease_token,
      );
      await this.r2.abort(u);
      await this.r2.delete(u.storage_key);
      await this.run(
        "UPDATE uploads SET state='cleaned',error='',updated=? WHERE id=? AND lease_token=? AND lease_until>?",
        this.now(),
        id,
        u.lease_token,
        this.now(),
      );
    } catch {
      if (u)
        await this.run(
          "UPDATE uploads SET error='上传清理失败，将自动重试',attempts=attempts+1,retry_at=? WHERE id=? AND lease_token=?",
          this.now() + Math.min(3600, 5 * 2 ** Math.min(u.attempts + 1, 10)),
          id,
          u.lease_token,
        );
    } finally {
      if (u) await this.release("uploads", u);
    }
  }
  async maintain() {
    const now = this.now();
    await this.run(
      "UPDATE uploads SET state='failed',error='发布等待超时，任务将清理' WHERE id IN (SELECT id FROM uploads WHERE state='finalizing' AND updated<? AND lease_until<=? LIMIT 100)",
      now - this.c.uploadTTL,
      now,
    );
    const tasks = await this.rows(
      `SELECT id,state,'upload' AS kind FROM uploads WHERE state='finalizing' AND retry_at<=? AND lease_until<=?
      UNION ALL SELECT id,state,'upload' FROM uploads WHERE state IN ('failed','canceled') AND retry_at<=? AND lease_until<=?
      UNION ALL SELECT id,state,'upload' FROM uploads WHERE state IN ('created','uploading') AND updated<=? AND retry_at<=? AND lease_until<=? LIMIT ?`,
      now,
      now,
      now,
      now,
      now - this.c.uploadTTL,
      now,
      now,
      this.c.cleanupBatch,
    );
    const shares = await this.rows(
      "SELECT id FROM shares WHERE state!='deleted' AND (state!='active' OR expires<=? OR (max_downloads!=-1 AND download_count>=max_downloads)) AND signed_until<=? AND retry_at<=? AND lease_until<=? LIMIT ?",
      now,
      now,
      now,
      now,
      this.c.cleanupBatch,
    );
    // Sequential requests keep background subrequests and memory bounded.
    for (const task of tasks) {
      if (task.state === "finalizing") await this.finalize(task.id);
      else await this.cleanupUpload(task.id);
    }
    for (const s of shares) await this.cleanupShare(s.id);
    await this.db.batch([
      this.stmt(
        "DELETE FROM share_grants WHERE token_hash IN (SELECT token_hash FROM share_grants WHERE expires<=? LIMIT 100)",
        now,
      ),
      this.stmt(
        "DELETE FROM download_sessions WHERE token_hash IN (SELECT token_hash FROM download_sessions WHERE expires<=? LIMIT 100)",
        now,
      ),
      this.stmt(
        "DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE expires<=? LIMIT 100)",
        now,
      ),
      ...(this.c.adminAuth === "totp"
        ? [
            this.stmt(
              "DELETE FROM admin_sessions WHERE token_hash IN (SELECT token_hash FROM admin_sessions WHERE expires<=? LIMIT 100)",
              now,
            ),
            this.stmt(
              "DELETE FROM admin_enrollments WHERE token_hash IN (SELECT token_hash FROM admin_enrollments WHERE expires<=? LIMIT 100)",
              now,
            ),
          ]
        : []),
      this.stmt(
        "DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events WHERE created<? LIMIT 100)",
        now - 30 * 86400,
      ),
      this.stmt(
        "DELETE FROM uploads WHERE id IN (SELECT id FROM uploads WHERE state IN ('cleaned','completed') AND updated<? AND NOT EXISTS(SELECT 1 FROM shares WHERE upload_id=uploads.id) LIMIT 100)",
        now - 7 * 86400,
      ),
    ]);
  }
}
