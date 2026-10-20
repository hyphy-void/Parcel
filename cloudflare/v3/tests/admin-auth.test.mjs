import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, passwordProof, encryptionManifest } from "./fixture.mjs";
import { configuration } from "../service.mjs";
import { matchTotp, openSecret, sealSecret, totp } from "../totp.mjs";

const setupToken = "test-initialization-token-" + "x".repeat(32);
const config = {
  ADMIN_AUTH: "totp",
  ADMIN_SETUP_TOKEN: setupToken,
  ACCESS_TEAM_DOMAIN: "",
  ACCESS_AUD: "",
  ADMIN_EMAILS: "",
};

test("an unconfigured authentication mode defaults to password + TOTP and can enroll during maintenance", async (t) => {
  const f = await fixture(t, {
    config: {
      ADMIN_AUTH: undefined,
      ACCESS_TEAM_DOMAIN: undefined,
      ACCESS_AUD: undefined,
      ADMIN_EMAILS: undefined,
      ADMIN_SETUP_TOKEN: setupToken,
      ACTIVE: "false",
    },
  });
  assert.equal(
    configuration({ ...f.config, DB: f.db, FILES: f.bucket }).adminAuth,
    "totp",
  );
  const before = await (
    await f.api("/api/v1/auth-config", { admin: false, expected: 200 })
  ).json();
  assert.equal(before.auth_mode, "totp");
  assert.equal(before.initialized, false);
  assert.equal(before.setup_available, true);
  await f.api("/api/v1/admin/status", { admin: false, expected: 401 });
  const admin = await initialize(f);
  const after = await (
    await f.api("/api/v1/auth-config", { admin: false, expected: 200 })
  ).json();
  assert.equal(after.initialized, true);
  assert.equal(after.setup_available, false);
  await f.api("/api/v1/auth/session", { cookie: admin.cookie, expected: 200 });
  await f.api("/api/v1/admin/status", { cookie: admin.cookie, expected: 503 });
  await f.api("/api/v1/shares/" + "a".repeat(32), {
    admin: false,
    expected: 503,
  });
});
const step = () => Math.floor(Date.now() / 30000);
export function cookies(response) {
  return response.headers
    .getSetCookie()
    .filter((s) => !s.includes("Max-Age=0;"))
    .map((s) => s.split(";")[0])
    .join("; ");
}
async function post(f, action, body, extra = {}) {
  return f.api(`/api/v1/auth/${action}`, {
    admin: false,
    method: "POST",
    body,
    ...extra,
  });
}
export async function initialize(f) {
  const proof = await passwordProof("a-long-admin-password");
  const begin = await post(
    f,
    "setup",
    { setup_token: setupToken, password_proof: proof },
    { expected: 200 },
  );
  const enrollment = await begin.json();
  const finish = await post(
    f,
    "confirm",
    { code: await totp(enrollment.secret, step() - 1) },
    { cookie: cookies(begin), expected: 200 },
  );
  return {
    proof,
    secret: enrollment.secret,
    cookie: cookies(finish),
    ...(await finish.json()),
  };
}

test("TOTP matches all RFC 6238 SHA-1 test vectors, enforces window/replay and encrypts secrets", async () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  for (const [time, expected] of [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ]) {
    assert.equal(await totp(secret, Math.floor(time / 30), 8), expected);
  }
  const now = 1234567890,
    current = Math.floor(now / 30),
    code = await totp(secret, current);
  assert.equal(await matchTotp(secret, code, now), current);
  assert.equal(await matchTotp(secret, code, now, current), -1);
  assert.equal(await matchTotp(secret, code, now + 90), -1);
  assert.equal(await matchTotp(secret, Number(code), now), -1);
  const sealed = await sealSecret(secret, "ab".repeat(32));
  assert.ok(!sealed.includes(secret));
  assert.equal(await openSecret(sealed, "ab".repeat(32)), secret);
  await assert.rejects(openSecret(sealed, "cd".repeat(32)));
});

test("native setup requires deployment secret and a real TOTP before exposing any admin API", async (t) => {
  const f = await fixture(t, { config });
  const c = configuration({ ...f.config, DB: f.db, FILES: f.bucket });
  assert.equal(c.adminAuth, "totp");
  assert.throws(() =>
    configuration({
      ...f.config,
      ADMIN_AUTH: "bad",
      DB: f.db,
      FILES: f.bucket,
    }),
  );
  assert.throws(() =>
    configuration({
      ...f.config,
      ADMIN_SETUP_TOKEN: "weak",
      DB: f.db,
      FILES: f.bucket,
    }),
  );
  const info = await (
    await f.api("/api/v1/auth-config", { admin: false, expected: 200 })
  ).json();
  assert.equal(info.initialized, false);
  assert.ok(!JSON.stringify(info).includes(setupToken));
  await f.api("/api/v1/admin/status", {
    expected: 401,
    headers: { "Cf-Access-Jwt-Assertion": "fake", "X-Parcel-Admin": "yes" },
  });
  await post(f, "setup", { setup_token: "wrong" }, { expected: 401 });
  await post(f, "confirm", { code: "123456" }, { expected: 401 });
  const admin = await initialize(f);
  assert.equal(admin.recovery_codes.length, 8);
  const session = await f.api("/api/v1/auth/session", {
    cookie: admin.cookie,
    expected: 200,
  });
  assert.equal((await session.json()).auth_mode, "totp");
  await f.api("/api/v1/uploads", {
    cookie: admin.cookie,
    method: "POST",
    body: { size: 0, encryption: encryptionManifest(0) },
    headers: {
      "X-CSRF-Token": admin.csrf,
      "Idempotency-Key": crypto.randomUUID(),
    },
    expected: 201,
  });
  const credentials = await f.db
    .prepare("SELECT * FROM admin_credentials")
    .first();
  assert.ok(!credentials.password_hash.includes(admin.proof.key));
  assert.ok(!credentials.totp_secret.includes(admin.secret));
  const recoveryRows = await f.db
    .prepare("SELECT * FROM admin_recovery_codes")
    .all();
  for (const code of admin.recovery_codes)
    assert.ok(!JSON.stringify(recoveryRows).includes(code));
  await post(
    f,
    "setup",
    { setup_token: setupToken, password_proof: admin.proof },
    { expected: 409 },
  );
  const html = await f.mf.dispatchFetch(f.config.PUBLIC_URL + "/login");
  assert.equal(html.status, 200);
});

test("password and TOTP are both mandatory, concurrent replay permits only one session, CSRF/logout/expiry survive restart", async (t) => {
  const f = await fixture(t, { config }),
    admin = await initialize(f);
  const code = await totp(admin.secret, step());
  await post(
    f,
    "login",
    { password_proof: { ...admin.proof, key: "0".repeat(64) }, code },
    { expected: 401 },
  );
  await post(f, "login", { password_proof: admin.proof }, { expected: 401 });
  const results = await Promise.all([
    post(f, "login", { password_proof: admin.proof, code }),
    post(f, "login", { password_proof: admin.proof, code }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
  const success = results.find((r) => r.status === 200),
    sessionCookie = cookies(success),
    session = await success.json();
  assert.match(
    success.headers.get("Set-Cookie"),
    /__Host-parcel_admin=.*Secure; HttpOnly; SameSite=Strict/,
  );
  await post(f, "logout", {}, { cookie: sessionCookie, expected: 403 });
  await f.restart();
  await f.api("/api/v1/admin/status", { cookie: sessionCookie, expected: 200 });
  await post(
    f,
    "logout",
    {},
    {
      cookie: sessionCookie,
      headers: { "X-CSRF-Token": session.csrf },
      expected: 200,
    },
  );
  await f.api("/api/v1/auth/session", { cookie: sessionCookie, expected: 401 });
  await f.db.prepare("UPDATE admin_sessions SET expires=0").run();
  await f.api("/api/v1/auth/session", { cookie: admin.cookie, expected: 401 });
});

test("recovery only authorizes enrollment; concurrent recovery consumes the code once and revokes old sessions/codes", async (t) => {
  const f = await fixture(t, { config }),
    admin = await initialize(f);
  await f.db.prepare("DELETE FROM rate_limits").run();
  const recovery = {
    password_proof: admin.proof,
    recovery_code: admin.recovery_codes[0],
  };
  const pending = await Promise.all([
    post(f, "recover", recovery, { expected: 200 }),
    post(f, "recover", recovery, { expected: 200 }),
  ]);
  const enrollment = await Promise.all(pending.map((r) => r.json()));
  await f.api("/api/v1/admin/status", {
    cookie: cookies(pending[0]),
    expected: 401,
  });
  const results = await Promise.all(
    pending.map(async (r, i) =>
      post(
        f,
        "confirm",
        { code: await totp(enrollment[i].secret, step() - 1) },
        { cookie: cookies(r) },
      ),
    ),
  );
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.ok(results.every((r) => [200, 401, 409].includes(r.status)));
  const finish = results.find((r) => r.status === 200),
    replacement = await finish.json();
  assert.equal(replacement.recovery_codes.length, 8);
  await f.api("/api/v1/auth/session", { cookie: admin.cookie, expected: 401 });
  await f.api("/api/v1/auth/session", {
    cookie: cookies(finish),
    expected: 200,
  });
  await f.db.prepare("DELETE FROM rate_limits").run();
  await post(f, "recover", recovery, { expected: 401 });
  await post(
    f,
    "login",
    { password_proof: admin.proof, code: await totp(admin.secret, step()) },
    { expected: 401 },
  );
});

test("binding needs session, CSRF and both factors; expired enrollment cannot initialize; rate limits persist", async (t) => {
  const f = await fixture(t, { config }),
    admin = await initialize(f);
  await post(
    f,
    "enroll",
    { password_proof: admin.proof, code: await totp(admin.secret, step()) },
    { cookie: admin.cookie, expected: 403 },
  );
  const begin = await post(
    f,
    "enroll",
    { password_proof: admin.proof, code: await totp(admin.secret, step()) },
    {
      cookie: admin.cookie,
      headers: { "X-CSRF-Token": admin.csrf },
      expected: 200,
    },
  );
  const enrollment = await begin.json();
  await f.db.prepare("UPDATE admin_enrollments SET expires=0").run();
  await post(
    f,
    "confirm",
    { code: await totp(enrollment.secret, step()) },
    { cookie: cookies(begin), expected: 401 },
  );
  await f.api("/api/v1/auth/session", { cookie: admin.cookie, expected: 200 });
  for (let i = 0; i < 5; i++) await post(f, "login", {}, { expected: 401 });
  await f.restart();
  const limit = await post(f, "login", {}, { expected: 429 });
  assert.equal(limit.headers.get("Retry-After"), "60");
  await post(
    f,
    "login",
    {},
    { headers: { Origin: "https://attacker.example" }, expected: 403 },
  );
});

test("failed recovery transaction preserves both factors, sessions and recovery codes; initialization also works in maintenance", async (t) => {
  const f = await fixture(t, { config: { ...config, ACTIVE: "false" } });
  const admin = await initialize(f);
  await f.api("/api/v1/admin/status", { cookie: admin.cookie, expected: 503 });
  const before = await f.db.prepare("SELECT * FROM admin_credentials").first();
  const begin = await post(
    f,
    "recover",
    { password_proof: admin.proof, recovery_code: admin.recovery_codes[0] },
    { expected: 200 },
  );
  const enrollment = await begin.json();
  await f.db
    .prepare(
      "CREATE TRIGGER fail_recovery BEFORE INSERT ON admin_recovery_codes BEGIN SELECT RAISE(ABORT,'injected'); END",
    )
    .run();
  const code = await totp(enrollment.secret, step());
  await post(f, "confirm", { code }, { cookie: cookies(begin), expected: 503 });
  assert.deepEqual(
    await f.db.prepare("SELECT * FROM admin_credentials").first(),
    before,
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) AS n FROM admin_recovery_codes")
        .first()
    ).n,
    8,
  );
  await f.api("/api/v1/auth/session", { cookie: admin.cookie, expected: 200 });
  await f.db.prepare("DROP TRIGGER fail_recovery").run();
  await post(f, "confirm", { code }, { cookie: cookies(begin), expected: 200 });
  await f.api("/api/v1/auth/session", { cookie: admin.cookie, expected: 401 });
  await f.db.prepare("DELETE FROM admin_credentials").run();
  assert.equal(
    (await f.db.prepare("SELECT count(*) AS n FROM admin_sessions").first()).n,
    0,
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) AS n FROM admin_recovery_codes")
        .first()
    ).n,
    0,
  );
});
