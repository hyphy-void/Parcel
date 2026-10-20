import { equal, hash, hmac, token } from "./crypto.mjs";
import {
  PASSWORD_PROTOCOL,
  passwordParameters,
  storePassword,
  verifyPassword,
} from "./password.mjs";
import {
  generateSecret,
  matchTotp,
  openSecret,
  recoveryCodes,
  sealSecret,
} from "./totp.mjs";
import { json, Problem } from "./service.mjs";

const SESSION = "__Host-parcel_admin";
const ENROLLMENT = "__Host-parcel_admin_enrollment";
const SESSION_TTL = 12 * 3600;
const ENROLLMENT_TTL = 600;
const deny = () => {
  throw new Problem(
    401,
    "invalid_credentials",
    "密码或验证码不正确，已使用的动态码需等待下一次更新",
  );
};
const cookie = (name, value, ttl) =>
  `${name}=${value}; Path=/; Max-Age=${ttl}; Secure; HttpOnly; SameSite=Strict`;
function readCookie(request, name) {
  const value = request.headers
    .get("Cookie")
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(name + "="))
    ?.slice(name.length + 1);
  return value && /^[A-Za-z0-9_-]{32}$/.test(value) ? value : "";
}
export function authRoute(path, method, mode) {
  // Keep mode discovery outside Access's existing /api/v1/auth/* protection so
  // the public landing page does not start an email login just by rendering.
  if (path === "/api/v1/auth-config")
    return { allowed: method === "GET", admin: false };
  if (mode !== "totp") return null;
  const action = path.slice("/api/v1/auth/".length);
  if (
    !path.startsWith("/api/v1/auth/") ||
    !["login", "setup", "recover", "enroll", "confirm"].includes(action)
  )
    return null;
  return { allowed: method === "POST", admin: action === "enroll" };
}

export class AdminAuth {
  constructor(service) {
    this.s = service;
    this.c = service.c;
  }
  credentials() {
    return this.s.first("SELECT * FROM admin_credentials WHERE id=1");
  }
  async configuration() {
    if (this.c.adminAuth !== "totp") return json({ auth_mode: "access" });
    const credentials = await this.credentials();
    return json({
      auth_mode: "totp",
      initialized: !!credentials,
      setup_available: !!this.c.ADMIN_SETUP_TOKEN && !credentials,
      password_protocol: PASSWORD_PROTOCOL,
      password_kdf: credentials
        ? passwordParameters(credentials.password_hash)
        : undefined,
    });
  }
  async authenticate(request) {
    const raw = readCookie(request, SESSION);
    if (!raw) return null;
    const sessionHash = await hash(raw);
    const row = await this.s.first(
      "SELECT s.* FROM admin_sessions s JOIN admin_credentials c ON c.version=s.version WHERE s.token_hash=? AND s.expires>?",
      sessionHash,
      this.s.now(),
    );
    return row
      ? {
          subject: "parcel-admin",
          email: "",
          csrf: row.csrf,
          sessionHash,
          version: row.version,
        }
      : null;
  }
  async limit(request, action) {
    const ip = request.headers.get("CF-Connecting-IP");
    // D1 is authoritative across isolates and restarts; the optional edge limiter
    // is an additional layer. Never use caller-supplied forwarded IP headers.
    if (!ip || ip.length > 45 || !/^[a-fA-F0-9:.]+$/.test(ip))
      throw new Problem(403, "client_ip_missing", "请求未经过受信任入口");
    const now = this.s.now(),
      window = Math.floor(now / 60);
    const scope = action === "login" ? "login" : "enrollment";
    const keys = [
      [`admin-auth:${scope}:ip:${await hmac(this.c.SESSION_SECRET, ip)}`, 5],
      [`admin-auth:${scope}:global`, 30],
    ];
    const results = await this.s.db.batch(
      keys.map(([key]) =>
        this.s.stmt(
          "INSERT INTO rate_limits(key,window,count,expires) VALUES(?,?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END,window=excluded.window,expires=excluded.expires RETURNING count",
          key,
          window,
          now + 120,
        ),
      ),
    );
    if (results.some((r, i) => r.results[0].count > keys[i][1]))
      throw new Problem(429, "rate_limited", "尝试次数过多，请一分钟后重试");
  }
  recoveryHash(code) {
    const normalized =
      typeof code === "string" ? code.replace(/[\s-]/g, "").toLowerCase() : "";
    return hmac(
      this.c.SESSION_SECRET,
      `parcel-admin-recovery-v1\n${/^[a-f0-9]{32}$/.test(normalized) ? normalized : "invalid"}`,
    );
  }
  async password(data, credentials) {
    return (
      credentials &&
      !Object.hasOwn(data, "password") &&
      (await verifyPassword(
        data.password_proof,
        credentials.password_hash,
        this.c.SESSION_SECRET,
      ))
    );
  }
  async checkedStep(credentials, code) {
    return matchTotp(
      await openSecret(credentials.totp_secret, this.c.SESSION_SECRET),
      code,
      this.s.now(),
      credentials.last_step,
    );
  }
  async login(data) {
    const credentials = await this.credentials();
    if (!(await this.password(data, credentials))) deny();
    const step = await this.checkedStep(credentials, data.code);
    if (step < 0) deny();
    const raw = token(),
      sessionHash = await hash(raw),
      csrf = token();
    // The conditional update consumes a TOTP step exactly once, including
    // concurrent logins. Session creation is in the same D1 transaction.
    const result = await this.s.db.batch([
      this.s.stmt(
        "UPDATE admin_credentials SET last_step=? WHERE id=1 AND version=? AND last_step<? RETURNING id",
        step,
        credentials.version,
        step,
      ),
      this.s.stmt(
        "INSERT INTO admin_sessions(token_hash,version,csrf,expires) SELECT ?,?,?,? WHERE changes()=1",
        sessionHash,
        credentials.version,
        csrf,
        this.s.now() + SESSION_TTL,
      ),
    ]);
    if (!result[0].results.length) deny();
    await this.s.audit("admin_login", "admin");
    return json({ authenticated: true, csrf }, 200, {
      "Set-Cookie": cookie(SESSION, raw, SESSION_TTL),
    });
  }
  async begin(action, data, identity) {
    const credentials = await this.credentials();
    let passwordHash,
      previousVersion = "",
      recoveryHash = "",
      setupKeyHash = "";
    if (action === "setup") {
      if (credentials)
        throw new Problem(
          409,
          "already_initialized",
          "管理员已初始化，请直接登录",
        );
      if (
        !this.c.ADMIN_SETUP_TOKEN ||
        typeof data.setup_token !== "string" ||
        !equal(
          await hash(data.setup_token),
          await hash(this.c.ADMIN_SETUP_TOKEN),
        )
      )
        deny();
      if (Object.hasOwn(data, "password"))
        throw new Problem(400, "invalid_password", "请使用安全密码处理模块");
      try {
        passwordHash = await storePassword(
          data.password_proof,
          this.c.SESSION_SECRET,
        );
      } catch {
        throw new Problem(
          400,
          "invalid_password",
          "密码参数不正确，请刷新重试",
        );
      }
      setupKeyHash = await hash(this.c.ADMIN_SETUP_TOKEN);
    } else {
      if (!(await this.password(data, credentials))) deny();
      previousVersion = credentials.version;
      passwordHash = credentials.password_hash;
      if (action === "recover") {
        recoveryHash = await this.recoveryHash(data.recovery_code);
        if (
          !(await this.s.first(
            "SELECT 1 FROM admin_recovery_codes WHERE code_hash=? AND version=?",
            recoveryHash,
            previousVersion,
          ))
        )
          deny();
      } else {
        if (!identity || identity.version !== previousVersion) deny();
        const step = await this.checkedStep(credentials, data.code);
        if (step < 0) deny();
        const result = await this.s.run(
          "UPDATE admin_credentials SET last_step=? WHERE id=1 AND version=? AND last_step<?",
          step,
          previousVersion,
          step,
        );
        if (result.meta.changes !== 1) deny();
      }
    }
    const raw = token(),
      secret = generateSecret();
    await this.s.run(
      "INSERT INTO admin_enrollments(token_hash,password_hash,totp_secret,previous_version,recovery_hash,setup_key_hash,expires) VALUES(?,?,?,?,?,?,?)",
      await hash(raw),
      passwordHash,
      await sealSecret(secret, this.c.SESSION_SECRET),
      previousVersion,
      recoveryHash,
      setupKeyHash,
      this.s.now() + ENROLLMENT_TTL,
    );
    const label = encodeURIComponent(
      `Parcel:admin@${new URL(this.c.PUBLIC_URL).hostname}`,
    );
    return json(
      {
        secret,
        otpauth_uri: `otpauth://totp/${label}?secret=${secret}&issuer=Parcel&algorithm=SHA1&digits=6&period=30`,
        expires_in: ENROLLMENT_TTL,
      },
      200,
      { "Set-Cookie": cookie(ENROLLMENT, raw, ENROLLMENT_TTL) },
    );
  }
  async confirm(data, request) {
    const pendingHash = await hash(readCookie(request, ENROLLMENT));
    const pending = await this.s.first(
      "SELECT * FROM admin_enrollments WHERE token_hash=? AND expires>?",
      pendingHash,
      this.s.now(),
    );
    if (!pending)
      throw new Problem(401, "enrollment_expired", "绑定已过期，请重新开始");
    if (
      !pending.previous_version &&
      (!this.c.ADMIN_SETUP_TOKEN ||
        !equal(pending.setup_key_hash, await hash(this.c.ADMIN_SETUP_TOKEN)))
    )
      deny();
    const step = await matchTotp(
      await openSecret(pending.totp_secret, this.c.SESSION_SECRET),
      data.code,
      this.s.now(),
    );
    if (step < 0) deny();
    const version = token(),
      raw = token(),
      csrf = token(),
      codes = recoveryCodes();
    const recoveryHashes = await Promise.all(
      codes.map((code) => this.recoveryHash(code)),
    );
    const guard = "EXISTS(SELECT 1 FROM admin_credentials WHERE version=?)";
    const pendingGuard =
      "EXISTS(SELECT 1 FROM admin_enrollments WHERE token_hash=? AND expires>?)";
    const update = pending.previous_version
      ? this.s.stmt(
          `UPDATE admin_credentials SET totp_secret=?,last_step=?,version=? WHERE id=1 AND version=? AND ${pendingGuard} AND (?='' OR EXISTS(SELECT 1 FROM admin_recovery_codes WHERE code_hash=? AND version=?)) RETURNING id`,
          pending.totp_secret,
          step,
          version,
          pending.previous_version,
          pendingHash,
          this.s.now(),
          pending.recovery_hash,
          pending.recovery_hash,
          pending.previous_version,
        )
      : this.s.stmt(
          `INSERT OR IGNORE INTO admin_credentials(id,password_hash,totp_secret,last_step,version) SELECT 1,?,?,?,? WHERE ${pendingGuard} RETURNING id`,
          pending.password_hash,
          pending.totp_secret,
          step,
          version,
          pendingHash,
          this.s.now(),
        );
    const results = await this.s.db.batch([
      update,
      this.s.stmt(`DELETE FROM admin_sessions WHERE ${guard}`, version),
      this.s.stmt(`DELETE FROM admin_recovery_codes WHERE ${guard}`, version),
      ...recoveryHashes.map((codeHash) =>
        this.s.stmt(
          `INSERT INTO admin_recovery_codes(code_hash,version) SELECT ?,? WHERE ${guard}`,
          codeHash,
          version,
          version,
        ),
      ),
      this.s.stmt(
        `INSERT INTO admin_sessions(token_hash,version,csrf,expires) SELECT ?,?,?,? WHERE ${guard}`,
        await hash(raw),
        version,
        csrf,
        this.s.now() + SESSION_TTL,
        version,
      ),
      this.s.stmt(`DELETE FROM admin_enrollments WHERE ${guard}`, version),
    ]);
    if (!results[0].results.length)
      throw new Problem(
        409,
        "enrollment_changed",
        "管理员凭据已更新，请重新登录",
      );
    await this.s.audit(
      pending.previous_version ? "admin_totp_rebound" : "admin_initialized",
      "admin",
    );
    const headers = new Headers();
    headers.append("Set-Cookie", cookie(SESSION, raw, SESSION_TTL));
    headers.append("Set-Cookie", cookie(ENROLLMENT, "", 0));
    return json(
      { authenticated: true, csrf, recovery_codes: codes },
      200,
      headers,
    );
  }
  async dispatch(path, data, identity, request) {
    const action = path.slice("/api/v1/auth/".length);
    if (this.c.adminAuth !== "totp") return null;
    if (action === "session")
      return json({
        authenticated: true,
        auth_mode: "totp",
        password_protocol: PASSWORD_PROTOCOL,
        csrf: identity.csrf,
      });
    if (action === "logout") {
      await this.s.run(
        "DELETE FROM admin_sessions WHERE token_hash=?",
        identity.sessionHash,
      );
      return json({ ok: true }, 200, { "Set-Cookie": cookie(SESSION, "", 0) });
    }
    await this.limit(request, action);
    if (action === "login") return this.login(data);
    if (action === "confirm") return this.confirm(data, request);
    return this.begin(action, data, identity);
  }
}
