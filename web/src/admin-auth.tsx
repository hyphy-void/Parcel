import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { ArrowRight, Download, Loader2, ShieldCheck } from "lucide-react";
import { api } from "./api";
import { passwordBody, type PasswordParameters } from "./password";

type Configuration = {
  auth_mode: "access" | "totp";
  initialized: boolean;
  setup_available: boolean;
  password_protocol: string;
  password_kdf?: PasswordParameters;
};
type Enrollment = { secret: string; otpauth_uri: string; expires_in: number };

export function NativeAdminForm({
  csrf = "",
  security = false,
  onBusy,
  onFocus,
  onAuthenticated,
}: {
  csrf?: string;
  security?: boolean;
  onBusy?: (value: boolean) => void;
  onFocus?: (value: boolean) => void;
  onAuthenticated?: (csrf: string) => void;
}) {
  const [config, setConfig] = useState<Configuration>();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [code, setCode] = useState("");
  const [recover, setRecover] = useState(false);
  const [enrollment, setEnrollment] = useState<Enrollment>();
  const [qr, setQr] = useState("");
  const [codes, setCodes] = useState<string[]>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    let active = true;
    api<Configuration>("/auth-config")
      .then((value) => {
        if (active) setConfig(value);
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    onBusy?.(busy);
  }, [busy, onBusy]);
  useEffect(() => {
    if (!enrollment) return;
    let active = true;
    QRCode.toDataURL(enrollment.otpauth_uri, {
      width: 240,
      margin: 4,
      errorCorrectionLevel: "M",
    })
      .then((value) => {
        if (active) setQr(value);
      })
      .catch(() => {
        if (active) setError("二维码生成失败，可使用下方密钥手动绑定。");
      });
    const timer = setTimeout(() => {
      setEnrollment(undefined);
      setQr("");
      setCode("");
      setError("绑定已过期，请重新开始。");
    }, enrollment.expires_in * 1000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [enrollment]);

  const setup = config?.auth_mode === "totp" && !config.initialized;
  function enterAdministration() {
    setAuthenticated(true);
    setPassword("");
    setConfirmation("");
    setSetupToken("");
    setCode("");
    location.replace("/admin");
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!config || busy) return;
    setBusy(true);
    setError("");
    let loginAttempted = false;
    try {
      if (enrollment) {
        const result = await api<{ recovery_codes: string[]; csrf: string }>(
          "/auth/confirm",
          { method: "POST", body: JSON.stringify({ code }) },
        );
        setEnrollment(undefined);
        setQr("");
        setCode("");
        setCodes(result.recovery_codes);
        onAuthenticated?.(result.csrf);
      } else {
        if (setup && (password.length < 12 || password !== confirmation))
          throw new Error("请设置至少 12 位密码，并确认两次输入一致。");
        const proof = await passwordBody(
          password,
          config.password_protocol,
          config.password_kdf?.salt,
          config.password_kdf,
        );
        const action = setup
          ? "setup"
          : recover
            ? "recover"
            : security
              ? "enroll"
              : "login";
        loginAttempted = action === "login";
        const result = await api<Enrollment>(
          `/auth/${action}`,
          {
            method: "POST",
            body: JSON.stringify({
              ...proof,
              ...(setup
                ? { setup_token: setupToken }
                : recover
                  ? { recovery_code: code }
                  : { code }),
            }),
          },
          csrf,
        );
        setPassword("");
        setConfirmation("");
        setSetupToken("");
        setCode("");
        if (action === "login") enterAdministration();
        else setEnrollment(result);
      }
    } catch (e) {
      if (loginAttempted) {
        // The login cookie can arrive even when the response body is lost or
        // stalls. Reconcile before asking for another TOTP code, which may
        // already have been consumed by the successful first request.
        try {
          const session = await api<{ csrf: string }>("/auth/session", {
            signal: AbortSignal.timeout(5_000),
          });
          if (session.csrf) {
            enterAdministration();
            return;
          }
        } catch {
          /* The original error remains actionable. */
        }
      }
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function downloadCodes() {
    if (!codes) return;
    const url = URL.createObjectURL(
      new Blob(
        [
          `Parcel 管理员恢复码\n${location.origin}\n\n每个恢复码仅可使用一次，需要同时输入管理员密码。\n重新绑定认证器后，旧恢复码全部失效。请离线妥善保存。\n\n${codes.join("\n")}\n`,
        ],
        { type: "text/plain;charset=utf-8" },
      ),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "parcel-recovery-codes.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (authenticated)
    return (
      <>
        <h1>登录成功</h1>
        <p className="muted">
          正在进入管理页面。若页面未跳转，可使用下方链接。
        </p>
        <a className="button primary full" href="/admin">
          进入管理页面 <ArrowRight size={18} aria-hidden="true" />
        </a>
      </>
    );

  if (!config)
    return (
      <>
        <h1>管理员登录</h1>
        <p className="muted" role="status">
          {error || "正在加载登录设置…"}
        </p>
        {error && (
          <button
            className="button secondary"
            onClick={() => location.reload()}
          >
            重新加载
          </button>
        )}
      </>
    );
  if (config.auth_mode === "access")
    return (
      <>
        <h1>让文件轻装上路。</h1>
        <p className="muted">验证管理员身份后，上传文件并管理分享。</p>
        <a className="button primary full" href="/admin">
          进入管理页面 <ArrowRight size={18} aria-hidden="true" />
        </a>
      </>
    );
  if (codes)
    return (
      <>
        <h1>保存恢复码</h1>
        <p className="muted">
          认证器已绑定。丢失手机时，使用管理员密码和恢复码重新绑定。
        </p>
        <p className="note">
          恢复码仅显示这一次。每个只能使用一次，请保存在安全的位置。
        </p>
        <ul className="recovery-codes" aria-label="一次性恢复码">
          {codes.map((value) => (
            <li key={value}>
              <code>{value}</code>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="button secondary full"
          onClick={downloadCodes}
        >
          <Download size={18} aria-hidden="true" />
          下载恢复码
        </button>
        <label className="auth-checkbox">
          <input
            type="checkbox"
            checked={saved}
            onChange={(e) => setSaved(e.target.checked)}
          />
          我已安全保存恢复码
        </label>
        <button
          className="button primary full"
          disabled={!saved}
          onClick={() => {
            setCodes(undefined);
            location.assign("/admin");
          }}
        >
          进入管理页面 <ArrowRight size={18} aria-hidden="true" />
        </button>
      </>
    );
  return (
    <>
      <h1>
        {enrollment
          ? "扫码绑定认证器"
          : setup
            ? "设置管理员登录"
            : recover
              ? "恢复认证器"
              : security
                ? "更换认证器"
                : "管理员登录"}
      </h1>
      <p className="muted">
        {enrollment
          ? "用认证器扫描二维码，再输入生成的 6 位动态验证码。"
          : setup
            ? "输入初始化密钥并设置密码，然后绑定认证器。"
            : recover
              ? "输入管理员密码和一个未使用的恢复码，重新绑定认证器。"
              : security
                ? "验证密码和当前动态码后，绑定新的认证器。完成后其他登录和旧恢复码都会失效。"
                : "输入管理员密码和认证器中的动态验证码。"}
      </p>
      {setup && !config.setup_available ? (
        <p className="alert" role="alert">
          请先在部署设置中配置管理员初始化密钥，再刷新此页。
        </p>
      ) : (
        <form
          onSubmit={submit}
          aria-busy={busy}
          onFocus={() => onFocus?.(true)}
          onBlur={() => onFocus?.(false)}
        >
          {enrollment ? (
            <>
              <div className="totp-qr">
                {qr ? (
                  <img
                    src={qr}
                    width="240"
                    height="240"
                    alt="使用认证器扫描此二维码绑定 Parcel"
                  />
                ) : (
                  <span role="status">正在生成二维码…</span>
                )}
              </div>
              <details className="totp-secret">
                <summary>无法扫码？手动输入密钥</summary>
                <p>
                  账户：Parcel 管理员；类型：基于时间；6 位数字，每 30 秒更新。
                </p>
                <code>{enrollment.secret}</code>
              </details>
              <p className="note">
                请在 10 分钟内完成。二维码和密钥可生成登录验证码，请勿分享。
              </p>
            </>
          ) : (
            <>
              {setup && (
                <>
                  <label htmlFor="admin-setup-token">初始化密钥</label>
                  <input
                    id="admin-setup-token"
                    type="password"
                    autoComplete="off"
                    value={setupToken}
                    onChange={(e) => setSetupToken(e.target.value)}
                    disabled={busy}
                    required
                  />
                </>
              )}
              <label htmlFor="admin-password">管理员密码</label>
              <input
                id="admin-password"
                name="password"
                type="password"
                autoComplete={setup ? "new-password" : "current-password"}
                minLength={setup ? 12 : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
                required
              />
              {setup && (
                <>
                  <label htmlFor="admin-password-confirm">确认密码</label>
                  <input
                    id="admin-password-confirm"
                    type="password"
                    autoComplete="new-password"
                    value={confirmation}
                    onChange={(e) => setConfirmation(e.target.value)}
                    disabled={busy}
                    required
                  />
                </>
              )}
            </>
          )}
          {(!setup || enrollment) && (
            <>
              <label htmlFor="admin-code">
                {recover && !enrollment ? "恢复码" : "动态验证码"}
              </label>
              <input
                id="admin-code"
                name="code"
                className={recover && !enrollment ? "" : "totp-code"}
                type="text"
                inputMode={recover && !enrollment ? "text" : "numeric"}
                autoComplete={recover && !enrollment ? "off" : "one-time-code"}
                pattern={recover && !enrollment ? undefined : "[0-9]{6}"}
                maxLength={recover && !enrollment ? 64 : 6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={busy}
                required
                aria-describedby="admin-code-help"
              />
              <p id="admin-code-help" className="note">
                {recover && !enrollment
                  ? "确认新认证器后，该恢复码和其余旧恢复码都会失效。"
                  : "使用认证器当前显示的 6 位数字。若刚刚用过，请等待下一次更新。"}
              </p>
            </>
          )}
          {error && (
            <div className="alert" role="alert">
              {error}
            </div>
          )}
          <button className="button primary full" disabled={busy}>
            {busy ? (
              <Loader2 size={18} className="spin" aria-hidden="true" />
            ) : (
              <ArrowRight size={18} aria-hidden="true" />
            )}
            {busy
              ? "正在验证…"
              : enrollment
                ? "确认绑定"
                : setup || recover || security
                  ? "继续绑定认证器"
                  : "登录 Parcel"}
          </button>
        </form>
      )}
      {!setup && !enrollment && !security && (
        <button
          type="button"
          className="text-button auth-recover"
          disabled={busy}
          onClick={() => {
            setRecover(!recover);
            setCode("");
            setError("");
          }}
        >
          {recover ? "返回动态验证码登录" : "无法使用认证器？使用恢复码"}
        </button>
      )}
      {enrollment && (
        <button
          type="button"
          className="text-button auth-recover"
          disabled={busy}
          onClick={() => {
            setEnrollment(undefined);
            setCode("");
            setQr("");
            setError("");
          }}
        >
          重新开始绑定
        </button>
      )}
      <p className="note">
        <ShieldCheck size={16} aria-hidden="true" />
        <span>密码与认证器双重验证。</span>
      </p>
    </>
  );
}
