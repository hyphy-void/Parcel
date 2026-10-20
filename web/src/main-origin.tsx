import { getLocale, LanguageSwitcher, t, useLocale } from "./i18n";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock3,
  Copy,
  File,
  FolderOpen,
  HardDrive,
  KeyRound,
  Loader2,
  LockKeyhole,
  LogOut,
  Package,
  Pause,
  Plus,
  RefreshCw,
  ShieldCheck,
  Share2,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import {
  api,
  ApiError,
  type DownloadTicket,
  availability,
  bytes,
  decimal,
  date,
  randomPassword,
  randomShareCode,
  sleep,
  type Share,
  type Status,
  type Upload,
} from "./api";
import { passwordBody, passwordSalt } from "./password";
import { NativeAdminForm } from "./admin-auth";
import "./style.css";
import "./login.css";

type Auth = {
  password_protocol?: string;
  csrf: string;
  auth_mode?: "password" | "access" | "totp";
  email?: string;
};
function desktopAutofocus() {
  return matchMedia("(min-width: 768px) and (pointer: fine)").matches;
}
function useLeaveWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
}
function ErrorMessage({ message }: { message: string }) {
  return message ? (
    <div className="alert" role="alert">
      {t(message)}
    </div>
  ) : null;
}
function Loading({ text = "正在加载…" }: { text?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <Loader2 className="spin" size={20} aria-hidden="true" />
      {t(text)}
    </div>
  );
}
function ParcelEnvelope({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`parcel-envelope ${compact ? "envelope-small" : ""}`}
      aria-hidden="true"
    >
      <div className="envelope-sheet">
        <File size={30} strokeWidth={1.5} aria-hidden="true" />
        <span className="sheet-line" />
        <span className="sheet-line short" />
      </div>
      <div className="envelope-pocket">
        <Package size={24} strokeWidth={1.5} aria-hidden="true" />
        <span translate="no">Parcel</span>
      </div>
      <span className="envelope-seal">
        <Check size={18} aria-hidden="true" />
      </span>
    </div>
  );
}
function Shell({
  children,
  auth,
  pageClass = "",
}: {
  children: React.ReactNode;
  auth?: Auth;
  pageClass?: string;
}) {
  const [error, setError] = useState("");
  async function logout() {
    try {
      const result = await api<{ logout_url?: string }>(
        "/auth/logout",
        { method: "POST" },
        auth?.csrf,
      );
      location.assign(
        result.logout_url === "/cdn-cgi/access/logout"
          ? result.logout_url
          : "/login",
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className={`app ${auth ? "admin-app" : "public-app"} ${pageClass}`}>
      <a className="skip-link" href="#main-content">
        {t("跳到主要内容")}
      </a>
      <header>
        <a href={auth ? "/admin" : "/"} className="brand" translate="no">
          <span className="brand-icon">
            <Package size={23} aria-hidden="true" />
          </span>
          <span className="brand-wordmark">
            <strong>Parcel</strong>
            <span className="brand-tag">{t("临时文件分享")}</span>
          </span>
        </a>
        {auth ? (
          <nav
            aria-label={t("主导航")}
            className={auth.auth_mode === "totp" ? "totp-nav" : undefined}
          >
            <a
              href="/admin"
              aria-current={location.pathname === "/admin" ? "page" : undefined}
            >
              {t("我的分享")}
            </a>
            <a
              href="/admin/new"
              aria-current={
                location.pathname === "/admin/new" ? "page" : undefined
              }
            >
              {t("上传文件")}
            </a>
            {auth.auth_mode === "totp" && (
              <a
                href="/admin/security"
                aria-current={
                  location.pathname === "/admin/security" ? "page" : undefined
                }
              >
                {t("登录安全")}
              </a>
            )}
            <button
              className="text-button"
              onClick={logout}
              aria-label={t("退出登录")}
            >
              <LogOut size={17} aria-hidden="true" />
              <span>{t("退出")}</span>
            </button>
          </nav>
        ) : (
          <a href="/login" className="text-button">
            {t("管理入口")}
            <ArrowRight size={15} aria-hidden="true" />
          </a>
        )}
        <div className="header-tools">
          <LanguageSwitcher />
          <a
            className="github-link"
            href="https://github.com/hyphy-void/Parcel"
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t("GitHub 仓库（在新标签页打开）")}
            title={t("GitHub 仓库")}
          >
            <span className="github-mark" aria-hidden="true" />
          </a>
        </div>
      </header>
      <main id="main-content" tabIndex={-1}>
        <ErrorMessage message={error} />
        {children}
      </main>
      <footer>
        <span>
          <span className="footer-brand" translate="no">
            Parcel
          </span>
          {t("让文件轻装上路。")}
        </span>
        <span>
          <ShieldCheck size={16} aria-hidden="true" />
          <span>{t("自托管存储，到期自动清理")}</span>
          <a
            href={
              getLocale() === "en"
                ? "https://parcelwiki.pages.dev/"
                : "https://parcelwiki.pages.dev/zh.html"
            }
          >
            {t("部署手册")}
          </a>
        </span>
      </footer>
    </div>
  );
}
async function copyText(
  content: string,
  input: HTMLInputElement | HTMLTextAreaElement | null,
) {
  const copySelection = () => {
    try {
      if (!input) return false;
      const active = document.activeElement;
      input.focus({ preventScroll: true });
      input.select();
      input.setSelectionRange(0, content.length);
      const success = document.execCommand("copy");
      if (success && active instanceof HTMLElement)
        active.focus({ preventScroll: true });
      return success;
    } catch {
      return false;
    }
  };
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(content);
      return true;
    } catch {
      return copySelection();
    }
  }
  // Keep the HTTP fallback synchronous so the click's user activation applies.
  return copySelection();
}
function CopyField({
  value,
  name = t("文件"),
  password,
  passwordRequired = false,
  children,
}: {
  value: string;
  name?: string;
  password?: string;
  passwordRequired?: boolean;
  children?: React.ReactNode;
}) {
  const linkRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const id = React.useId();
  const missingPassword = passwordRequired && !password;
  const content = t(
    "我用 Parcel 分享了「{0}」\n链接：{1}{2}",
    name,
    value,
    password
      ? t("\n提取码：{0}", password)
      : missingPassword
        ? t("\n提取码：请向分享者获取")
        : "",
  );
  const [copied, setCopied] = useState<"link" | "message">();
  const [linkFallback, setLinkFallback] = useState(false);
  const [messageStatus, setMessageStatus] = useState("");
  const [sharing, setSharing] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(undefined), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  async function copyLink() {
    setCopied(undefined);
    setLinkFallback(false);
    if (await copyText(value, linkRef.current)) setCopied("link");
    else setLinkFallback(true);
  }
  async function copyMessage() {
    setCopied(undefined);
    setMessageStatus("");
    if (await copyText(content, messageRef.current)) {
      setCopied("message");
      setMessageStatus("分享文案已复制，可以粘贴发送给对方。");
    } else {
      setMessageStatus("分享文案已选中，请使用系统的复制操作。");
    }
  }
  function openShare() {
    setMessageStatus("");
    setCopied(undefined);
    dialogRef.current?.showModal();
  }
  async function sendShare() {
    setSharing(true);
    setMessageStatus("");
    try {
      // The URL is already in the text; a separate url would duplicate it.
      await navigator.share({ title: name, text: content });
    } catch (e) {
      if ((e as Error).name !== "AbortError")
        setMessageStatus("暂时无法打开系统分享，请复制文案后发送。");
    } finally {
      setSharing(false);
    }
  }
  return (
    <div className="copy-wrapper">
      <label htmlFor={`${id}-link`}>{t("分享链接")}</label>
      <div className="copy-field">
        <input
          id={`${id}-link`}
          name="share-link"
          autoComplete="off"
          spellCheck={false}
          translate="no"
          ref={linkRef}
          readOnly
          value={value}
        />
        <button type="button" onClick={copyLink} aria-label={t("复制分享链接")}>
          {copied === "link" ? (
            <Check size={18} aria-hidden="true" />
          ) : (
            <Copy size={18} aria-hidden="true" />
          )}
        </button>
      </div>
      <small
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={linkFallback ? undefined : "sr-only"}
      >
        {linkFallback
          ? t("链接已选中，请使用系统的复制操作。")
          : copied === "link"
            ? t("分享链接已复制。")
            : ""}
      </small>
      {children}
      <button
        type="button"
        className={`button primary ${children ? "full" : "share-action"}`}
        onClick={openShare}
      >
        <Share2 size={18} aria-hidden="true" />
        {t("分享")}
      </button>
      <dialog
        ref={dialogRef}
        className="share-dialog"
        aria-labelledby={`${id}-title`}
      >
        <div className="share-dialog-heading">
          <h2 id={`${id}-title`}>{t("分享文件")}</h2>
          <button
            type="button"
            className="share-close"
            aria-label={t("关闭分享")}
            onClick={() => dialogRef.current?.close()}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <p className="muted">{t("复制下面的文案，发给接收文件的人。")}</p>
        {missingPassword && (
          <p className="note">
            {t("无法读取原提取码，请另外发送，或在分享详情中设置新密码。")}
          </p>
        )}
        <label htmlFor={`${id}-message`}>{t("分享文案")}</label>
        <textarea
          id={`${id}-message`}
          name="share-message"
          autoComplete="off"
          spellCheck={false}
          ref={messageRef}
          readOnly
          value={content}
          className="copy-content"
        />
        <div className="share-dialog-actions">
          <button
            type="button"
            className="button primary"
            onClick={copyMessage}
          >
            {copied === "message" ? (
              <Check size={17} aria-hidden="true" />
            ) : (
              <Copy size={17} aria-hidden="true" />
            )}
            {copied === "message" ? t("已复制") : t("复制分享文案")}
          </button>
          {window.isSecureContext && typeof navigator.share === "function" && (
            <button
              type="button"
              className="button secondary"
              onClick={sendShare}
              disabled={sharing}
            >
              <Share2 size={17} aria-hidden="true" />
              {sharing ? t("正在打开…") : t("系统分享")}
            </button>
          )}
        </div>
        <small role="status" aria-live="polite" aria-atomic="true">
          {t(messageStatus)}
        </small>
      </dialog>
    </div>
  );
}
type LoginVisualHandle = { pulse: () => void };
const LoginVisual = React.memo(
  React.forwardRef<LoginVisualHandle, { focused: boolean; busy: boolean }>(
    function LoginVisual({ focused, busy }, ref) {
      useLocale();
      const envelope = useRef<HTMLDivElement>(null);
      const pulseAnimation = useRef<Animation | undefined>(undefined);
      React.useImperativeHandle(
        ref,
        () => ({
          pulse() {
            if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
            pulseAnimation.current?.cancel();
            pulseAnimation.current = envelope.current?.animate(
              [
                { transform: "translateY(0) rotate(0deg)" },
                { transform: "translateY(-5px) rotate(-2deg)", offset: 0.3 },
                { transform: "translateY(0) rotate(0deg)" },
              ],
              { duration: 360, easing: "cubic-bezier(.16, 1, .3, 1)" },
            );
          },
        }),
        [],
      );
      useEffect(() => () => pulseAnimation.current?.cancel(), []);
      return (
        <section
          className="login-story"
          data-focused={focused}
          data-busy={busy}
        >
          <div className="story-copy">
            <p className="story-title">
              {t("分享一份文件，")}
              <br />
              {t("少一份牵挂。")}
            </p>
            <p>
              {t("上传，发出链接。")}
              <br />
              {t("到期自动清理。")}
            </p>
          </div>
          <div className="login-envelope-display">
            <div ref={envelope} className="login-envelope-motion">
              <ParcelEnvelope />
            </div>
          </div>
          <div className="login-visual-status" aria-hidden="true">
            <ShieldCheck size={16} aria-hidden="true" />
            <span>{t("文件分享，从这里开始。")}</span>
          </div>
        </section>
      );
    },
  ),
);
function Login() {
  const [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [focused, setFocused] = useState(false);
  const visual = useRef<LoginVisualHandle>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const errorAnimation = useRef<Animation | undefined>(undefined);
  useEffect(() => () => errorAnimation.current?.cancel(), []);
  useEffect(() => {
    if (error && !busy) passwordInput.current?.focus({ preventScroll: true });
  }, [error, busy]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/auth/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      location.assign("/admin");
    } catch (e) {
      setError((e as Error).message);
      if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
        errorAnimation.current?.cancel();
        errorAnimation.current = form.current?.animate(
          [
            { transform: "translateX(0)" },
            { transform: "translateX(-5px)" },
            { transform: "translateX(4px)" },
            { transform: "translateX(-2px)" },
            { transform: "translateX(0)" },
          ],
          { duration: 320, easing: "ease-out" },
        );
      }
    } finally {
      setBusy(false);
    }
  }
  if (import.meta.env.VITE_ADMIN_AUTH === "v3") {
    return (
      <Shell pageClass="login-app">
        <div className="login-layout">
          <LoginVisual ref={visual} focused={focused} busy={busy} />
          <div className="auth-card">
            <NativeAdminForm onBusy={setBusy} onFocus={setFocused} />
          </div>
        </div>
      </Shell>
    );
  }
  if (import.meta.env.VITE_ADMIN_AUTH === "access") {
    return (
      <Shell pageClass="login-app">
        <div className="login-layout">
          <LoginVisual ref={visual} focused={false} busy={false} />
          <div className="auth-card">
            <h1>{t("让文件轻装上路。")}</h1>
            <p className="muted">
              {t("验证管理员身份后，上传文件并管理分享。")}
            </p>
            <a className="button primary full" href="/admin">
              {t("进入管理页面")}
              <ArrowRight size={18} aria-hidden="true" />
            </a>
          </div>
        </div>
      </Shell>
    );
  }
  return (
    <Shell pageClass="login-app">
      <div className="login-layout">
        <LoginVisual ref={visual} focused={focused} busy={busy} />
        <div className="auth-card">
          <h1>{t("让文件轻装上路。")}</h1>
          <p className="muted">{t("登录后上传文件，创建你的临时分享。")}</p>
          <form ref={form} onSubmit={submit} aria-busy={busy}>
            <label htmlFor="admin-password">{t("管理员密码")}</label>
            <input
              ref={passwordInput}
              id="admin-password"
              name="password"
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError("");
                visual.current?.pulse();
              }}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              aria-invalid={!!error}
              aria-describedby={error ? "login-error" : undefined}
              disabled={busy}
              autoComplete="current-password"
              required
              autoFocus={desktopAutofocus()}
            />
            <div id="login-error">
              <ErrorMessage message={error} />
            </div>
            <button className="button primary full" disabled={busy}>
              {busy ? (
                <Loader2 size={18} className="spin" aria-hidden="true" />
              ) : (
                <ArrowRight size={18} aria-hidden="true" />
              )}
              {busy ? t("正在登录…") : t("登录 Parcel")}
            </button>
          </form>
          <p className="note">
            <ShieldCheck size={16} aria-hidden="true" />
            <span>{t("密码由服务器管理员初始化。")}</span>
          </p>
        </div>
      </div>
    </Shell>
  );
}
function Dashboard({ auth }: { auth: Auth }) {
  const [status, setStatus] = useState<Status>(),
    [items, setItems] = useState<Share[]>([]),
    [total, setTotal] = useState(0),
    [cleaned, setCleaned] = useState(0),
    [confirmClear, setConfirmClear] = useState(false),
    [clearing, setClearing] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const [page, setPage] = useState(() => {
    const requested = Number(new URLSearchParams(location.search).get("page"));
    return Number.isSafeInteger(requested) && requested > 0 ? requested : 1;
  });
  async function load() {
    try {
      const [s, list] = await Promise.all([
        api<Status>("/admin/status"),
        api<{ items: Share[]; total: number; cleaned_count: number }>(
          `/admin/shares?page=${page}`,
        ),
      ]);
      setStatus(s);
      setItems(list.items);
      setTotal(list.total);
      setCleaned(list.cleaned_count ?? 0);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  async function clearHistory() {
    setClearing(true);
    setError("");
    try {
      let removed = 0,
        remaining = true;
      while (remaining) {
        const result = await api<{ removed: number; remaining?: boolean }>(
          "/admin/shares/cleaned",
          { method: "DELETE" },
          auth.csrf,
        );
        removed += result.removed;
        remaining = result.remaining === true && result.removed > 0;
      }
      setConfirmClear(false);
      setMessage(`已清除 ${removed} 条已清理记录。`);
      if (page !== 1) {
        const url = new URL(location.href);
        url.searchParams.set("page", "1");
        history.replaceState(null, "", url);
        setPage(1);
      } else await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setClearing(false);
    }
  }
  useEffect(() => {
    void load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [page]);
  return (
    <Shell auth={auth}>
      <section className="page-heading">
        <div>
          <h1>{t("我的分享")}</h1>
          <p className="muted">{t("把文件交给对方，把收尾交给 Parcel。")}</p>
        </div>
        <a className="button primary" href="/admin/new">
          <Plus size={19} aria-hidden="true" />
          {t("新建分享")}
        </a>
      </section>
      <ErrorMessage message={error} />
      {status && (
        <div className="stats">
          <div className="stat">
            <span>
              <HardDrive size={18} aria-hidden="true" />
              {status.storage_backend === "r2"
                ? t("R2 存储额度")
                : t("存储用量")}
            </span>
            <strong>
              {status.storage_backend === "r2"
                ? `${decimal((status.r2_used_bytes ?? 0) / 1e9)}\u00a0GB`
                : bytes(status.used_bytes)}
              <small>
                {" "}
                /{" "}
                {status.storage_backend === "r2"
                  ? `${decimal((status.r2_quota_bytes ?? 9e9) / 1e9)}\u00a0GB`
                  : bytes(status.quota_bytes)}
              </small>
            </strong>
            <div className="meter">
              <span
                style={{
                  transform: `scaleX(${Math.min(1, Math.max(0, status.storage_backend === "r2" ? ((status.r2_used_bytes ?? 0) + (status.r2_reserved_bytes ?? 0)) / (status.r2_quota_bytes ?? 9e9) : (status.used_bytes + status.reserved_bytes) / status.quota_bytes))})`,
                }}
              />
            </div>
            <small>
              {status.storage_backend === "r2"
                ? t(
                    "上传及临时预留 {0} · 剩余 {1} GB",
                    bytes(status.r2_reserved_bytes),
                    decimal((status.r2_available_bytes ?? 0) / 1e9),
                  )
                : t(
                    "上传预留 {0} · 待清理 {1}",
                    bytes(status.reserved_bytes),
                    bytes(status.pending_bytes),
                  )}
            </small>
            <small className="budget-state">
              {status.storage_backend === "r2" &&
                ((status.r2_available_bytes ?? 1) <= 0
                  ? t("额度已满，暂停新上传")
                  : t("额度保护已启用 · 满额暂停新上传"))}
            </small>
          </div>
          <div className="stat">
            <span>
              <FolderOpen size={18} aria-hidden="true" />
              {t("分享记录")}
            </span>
            <strong>
              {new Intl.NumberFormat(getLocale()).format(total)}
              <small>{t("个分享")}</small>
            </strong>
            <small>{t("到期、撤销或次数用完后自动回收文件")}</small>
          </div>
          <div className="stat">
            <span>
              <ShieldCheck size={18} aria-hidden="true" />
              {status.backend_mode === "serverless"
                ? t("云端服务")
                : t("你的服务器")}
            </span>
            <strong>
              {status.storage_backend === "r2"
                ? t("私有 R2 存储")
                : t("本地存储")}
            </strong>
            <small>
              {status.backend_mode === "serverless"
                ? t("Cloudflare 原生后端")
                : t("本地磁盘可用 {0}", bytes(status.free_bytes))}{" "}
              · v{status.version}
            </small>
          </div>
        </div>
      )}
      {status?.storage_backend === "r2" && (
        <p className="r2-budget-note">
          {t(
            "按 Parcel 管理的文件计量，包含尚未释放的临时空间。账户月度免费存储与读写额度以 Cloudflare 为准。",
          )}
        </p>
      )}
      <section className="panel">
        <div className="panel-title share-list-title">
          <div className="list-heading">
            <h2>{t("分享记录")}</h2>
            <span>
              {total}
              {t("个文件")}
            </span>
          </div>
          <div className="list-actions">
            <button className="text-button" onClick={load} disabled={clearing}>
              <RefreshCw size={15} aria-hidden="true" />
              {t("刷新")}
            </button>
            <button
              className="text-button clear-history"
              disabled={loading || clearing || cleaned === 0}
              onClick={() => {
                setMessage("");
                setConfirmClear(true);
              }}
            >
              <Trash2 size={15} aria-hidden="true" />
              {t("清除已清理")}
            </button>
          </div>
        </div>
        {confirmClear && (
          <div className="clear-history-confirm" role="alert">
            <div>
              <strong>{t("清除 {0} 条已清理记录？", cleaned)}</strong>
              <p>{t("记录清除后无法恢复。可下载和等待清理的分享会保留。")}</p>
            </div>
            <div className="list-actions">
              <button
                className="text-button"
                disabled={clearing}
                onClick={() => setConfirmClear(false)}
              >
                {t("取消")}
              </button>
              <button
                className="button danger-outline"
                disabled={clearing}
                onClick={clearHistory}
              >
                {clearing ? t("正在清除…") : t("确认清除")}
              </button>
            </div>
          </div>
        )}
        {message && (
          <p className="history-message" role="status">
            {t(message)}
          </p>
        )}
        {loading ? (
          <Loading />
        ) : items.length ? (
          <div className="share-list">
            <div className="list-columns" aria-hidden="true">
              <span>{t("文件")}</span>
              <span>{t("已用下载资格")}</span>
              <span>{t("状态")}</span>
            </div>
            {items.map((s) => (
              <a
                className="share-row"
                href={`/admin/shares/${s.id}`}
                key={s.id}
              >
                <div className="file-icon" aria-hidden="true">
                  <File size={23} strokeWidth={1.5} aria-hidden="true" />
                </div>
                <div className="file-info">
                  <strong>{s.name}</strong>
                  <span>
                    <span>{bytes(s.size)}</span>
                    <span>
                      {s.password_required && (
                        <LockKeyhole size={12} aria-hidden="true" />
                      )}
                      {s.password_required ? t("密码保护") : t("无密码")}
                    </span>
                    <span>{date(s.created)}</span>
                  </span>
                </div>
                <div className="row-count">
                  <strong>
                    {s.download_count} /{" "}
                    {s.max_downloads === -1 ? t("不限次数") : s.max_downloads}
                  </strong>
                  <span className="mobile-count-label">{t("下载资格")}</span>
                </div>
                <span
                  className={`badge ${s.availability === "available" ? "green" : ""}`}
                >
                  {t(availability[s.availability]) || s.availability}
                </span>
                <ArrowRight
                  size={17}
                  className="row-arrow"
                  aria-hidden="true"
                />
              </a>
            ))}
          </div>
        ) : (
          <div className="empty">
            <ParcelEnvelope compact />
            <p className="empty-title">{t("这里，留给你要分享的文件。")}</p>
            <p>{t("上传文件，设置规则，把链接交给需要的人。")}</p>
            <a className="button secondary" href="/admin/new">
              <Plus size={17} aria-hidden="true" />
              {t("上传文件")}
            </a>
          </div>
        )}
        {total > 20 && (
          <div className="pagination">
            {page > 1 ? (
              <a className="button secondary" href={`/admin?page=${page - 1}`}>
                {t("上一页")}
              </a>
            ) : (
              <span className="button secondary" aria-disabled="true">
                {t("上一页")}
              </span>
            )}
            <span>{t("第 {0} 页", page)}</span>
            {page * 20 < total ? (
              <a className="button secondary" href={`/admin?page=${page + 1}`}>
                {t("下一页")}
              </a>
            ) : (
              <span className="button secondary" aria-disabled="true">
                {t("下一页")}
              </span>
            )}
          </div>
        )}
      </section>
    </Shell>
  );
}

type SavedUpload = {
  passwordSalt?: string;
  id?: string;
  key?: string;
  name: string;
  size: number;
  modified: number;
  ttl?: number;
  limit?: number;
  protect?: boolean;
};
const savedKey = "parcel.upload";
function loadSaved(): SavedUpload | undefined {
  try {
    const v = localStorage.getItem(savedKey);
    return v ? JSON.parse(v) : undefined;
  } catch {
    return undefined;
  }
}
function NewShare({ auth }: { auth: Auth }) {
  const initialSaved = useRef(loadSaved()).current;
  const [settings, setSettings] = useState<Status>(),
    [file, setFile] = useState<File>(),
    [password, setPassword] = useState(""),
    [protect, setProtect] = useState(initialSaved?.protect || false),
    [ttl, setTTL] = useState(initialSaved?.ttl || 86400),
    [limit, setLimit] = useState(initialSaved?.limit || 3),
    [error, setError] = useState(""),
    [phase, setPhase] = useState(initialSaved ? "recovering" : "idle"),
    [upload, setUpload] = useState<Upload>(),
    [saved, setSaved] = useState(initialSaved),
    [result, setResult] = useState<Share>(),
    [drag, setDrag] = useState(false),
    [sending, setSending] = useState<{ offset: number; loaded: number }>(),
    [rulesDirty, setRulesDirty] = useState(false),
    [validation, setValidation] = useState<{
      limit?: string;
      password?: string;
    }>({});
  const limitInput = useRef<HTMLInputElement>(null);
  const previousLimit = useRef(3);
  const sharePasswordInput = useRef<HTMLInputElement>(null);
  useLeaveWarning(!result && (!!file || !!saved || rulesDirty));
  const input = useRef<HTMLInputElement>(null),
    pause = useRef(false),
    xhr = useRef<XMLHttpRequest | undefined>(undefined),
    alive = useRef(true),
    running = useRef(false),
    generation = useRef(0);
  useEffect(() => {
    alive.current = true;
    api<Status>("/admin/status")
      .then((s) => {
        setSettings(s);
        setTTL(initialSaved?.ttl || s.default_ttl_seconds);
        setLimit(initialSaved?.limit || s.default_download_limit);
        previousLimit.current = s.default_download_limit;
      })
      .catch((e) => setError(e.message));
    if (saved)
      api<Upload>(
        saved.id ? `/uploads/${saved.id}` : "/uploads/lookup",
        saved.id ? {} : { headers: { "Idempotency-Key": saved.key || "" } },
      )
        .then((u) => {
          if (!alive.current) return;
          setUpload(u);
          setTTL(u.ttl_seconds);
          setLimit(u.max_downloads);
          if (u.state === "completed")
            void done(u).catch((e) => setError(e.message));
          else if (u.state === "finalizing")
            void poll(u.id).catch((e) => {
              setError(e.message);
              setPhase(
                e instanceof ApiError && e.code === "upload_not_finalizing"
                  ? "failed"
                  : "pending",
              );
            });
          else if (["created", "uploading"].includes(u.state))
            setPhase("paused");
          else resetUpload();
        })
        .catch((e) => {
          if (!alive.current) return;
          if (e instanceof ApiError && e.status === 404) {
            clearDraft();
            setPhase("idle");
          } else {
            setError(e.message);
            setPhase("failed");
          }
        });
    return () => {
      alive.current = false;
      pause.current = true;
      xhr.current?.abort();
    };
  }, []);
  function clearDraft() {
    localStorage.removeItem(savedKey);
    setSaved(undefined);
  }
  function resetUpload() {
    clearDraft();
    setUpload(undefined);
    setSending(undefined);
    setFile(undefined);
    setPhase("idle");
    setError("");
    setRulesDirty(false);
    setValidation({});
  }
  function choose(f?: File) {
    if (!f) return;
    if (settings && f.size > settings.max_file_bytes) {
      setError(`单文件不能超过 ${bytes(settings.max_file_bytes)}`);
      return;
    }
    if (
      saved &&
      (f.name !== saved.name ||
        f.size !== saved.size ||
        f.lastModified !== saved.modified)
    ) {
      setError("请选择原来的文件；文件名、大小或修改时间与上传记录不一致。");
      return;
    }
    setFile(f);
    setError("");
  }
  async function done(u: Upload, epoch = generation.current) {
    const s = await api<Share>(`/admin/shares/${u.share_id}`);
    if (!alive.current || epoch !== generation.current) return;
    setError("");
    setResult(s);
    setPhase("done");
    localStorage.removeItem(savedKey);
    setSaved(undefined);
  }
  async function poll(id: string, epoch = generation.current) {
    if (!alive.current || epoch !== generation.current) return;
    setPhase("checking");
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (!alive.current || epoch !== generation.current) return;
      if (Date.now() >= deadline)
        throw new Error(
          "发布确认超时，上传任务已保留。可稍后查询结果，无需重新上传文件。",
        );
      let u: Upload;
      try {
        u = await api<Upload>(`/uploads/${id}`, {
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        if (!alive.current || epoch !== generation.current) return;
        throw new Error(
          e instanceof ApiError
            ? e.message
            : "暂时无法查询发布结果，上传任务已保留。请稍后再查询。",
        );
      }
      if (!alive.current || epoch !== generation.current) return;
      setUpload(u);
      if (u.state === "completed") {
        await done(u, epoch);
        return;
      }
      if (u.state !== "finalizing")
        throw new ApiError(
          u.error || "上传已经失效，请重新上传",
          409,
          "upload_not_finalizing",
        );
      if (u.error)
        throw new Error(`${u.error}。上传任务已保留，可稍后查询结果。`);
      await sleep(1000);
    }
  }
  async function chunk(u: Upload, blob: Blob, epoch: number): Promise<number> {
    const direct = u.storage_backend === "r2";
    const legacyPut = direct && u.part_bytes === 0;
    setSending(undefined);
    const target: { url: string; headers?: Record<string, string> } = direct
      ? await api<{ url: string; headers?: Record<string, string> }>(
          legacyPut
            ? `/uploads/${u.id}/object`
            : `/uploads/${u.id}/parts/${Math.floor(u.offset / u.part_bytes) + 1}`,
          { method: "POST" },
          auth.csrf,
        )
      : { url: `/api/v1/uploads/${u.id}` };
    if (pause.current || !alive.current || epoch !== generation.current)
      throw new Error("上传已暂停");
    await new Promise<void>((resolve, reject) => {
      const x = new XMLHttpRequest();
      xhr.current = x;
      x.open(direct ? "PUT" : "PATCH", target.url);
      if (!direct) {
        x.setRequestHeader("X-CSRF-Token", auth.csrf);
        x.setRequestHeader("Upload-Offset", String(u.offset));
      }
      // XHR appends repeated headers; signed headers must be sent exactly once.
      const headers = new Headers(target.headers);
      if (!headers.has("Content-Type"))
        headers.set("Content-Type", "application/octet-stream");
      headers.forEach((value, name) => x.setRequestHeader(name, value));
      x.timeout = legacyPut ? 900000 : 125000;
      const updateProgress = (loaded: number) => {
        if (alive.current && epoch === generation.current && xhr.current === x)
          setSending({ offset: u.offset, loaded: Math.min(loaded, blob.size) });
      };
      x.upload.onprogress = (e) => updateProgress(e.loaded);
      const releaseRequest = () => {
        if (xhr.current === x) xhr.current = undefined;
      };
      x.onload = () => {
        if (x.status >= 200 && x.status < 300) {
          updateProgress(blob.size);
          releaseRequest();
          resolve();
        } else if (direct) {
          releaseRequest();
          const code = new DOMParser()
            .parseFromString(x.responseText, "application/xml")
            .querySelector("Code")?.textContent;
          const reason =
            code === "SignatureDoesNotMatch"
              ? "上传签名校验失败"
              : code === "AccessDenied"
                ? "存储访问被拒绝"
                : "存储服务拒绝了请求";
          reject(
            new ApiError(
              `R2 ${legacyPut ? "整文件" : "分块"}上传失败（HTTP ${x.status}）：${reason}。上传任务已保留。`,
              x.status,
              code === "RequestExpired" || code === "ExpiredToken"
                ? "r2_url_expired"
                : "r2_upload_rejected",
            ),
          );
        } else {
          releaseRequest();
          try {
            const data = JSON.parse(x.responseText);
            reject(
              new ApiError(data.message || "上传失败", x.status, data.code),
            );
          } catch {
            reject(new Error("服务器响应异常"));
          }
        }
      };
      x.onerror = () => {
        releaseRequest();
        reject(new Error("连接中断或 R2 CORS 未配置"));
      };
      x.ontimeout = () => {
        releaseRequest();
        reject(new Error(legacyPut ? "整文件传输超时" : "分块传输超时"));
      };
      x.onabort = () => {
        releaseRequest();
        reject(new Error("上传已暂停"));
      };
      x.send(blob);
    });
    return u.offset + blob.size;
  }
  async function start() {
    if (!settings || running.current) return;
    if (upload?.state === "finalizing") {
      running.current = true;
      const epoch = ++generation.current;
      setError("");
      try {
        await poll(upload.id, epoch);
      } catch (e) {
        if (alive.current && epoch === generation.current) {
          setError((e as Error).message);
          setPhase(
            e instanceof ApiError && e.code === "upload_not_finalizing"
              ? "failed"
              : "pending",
          );
        }
      } finally {
        running.current = false;
      }
      return;
    }
    if (!file) return;
    if (!upload) {
      const errors = {
        limit:
          !Number.isInteger(limit) ||
          (limit !== -1 && (limit < 1 || limit > 100))
            ? "请输入 1 到 100 之间的整数。"
            : undefined,
        password:
          protect && new TextEncoder().encode(password).length < 4
            ? "分享密码至少需要 4 字节，例如 abcd。"
            : undefined,
      };
      setValidation(errors);
      if (errors.limit || errors.password) {
        (errors.limit ? limitInput : sharePasswordInput).current?.focus();
        return;
      }
    }
    if (
      !upload &&
      file.size > (settings.upload_confirmation_bytes ?? 100_000_000) &&
      !window.confirm(
        t(
          `文件超过 100 MB（100,000,000 字节），大小为 ${bytes(file.size)}。确认继续上传？`,
        ),
      )
    )
      return;
    running.current = true;
    const epoch = ++generation.current;
    pause.current = false;
    setPhase("uploading");
    setError("");
    let u = upload;
    try {
      if (!u) {
        const key = saved?.key || randomPassword();
        const draft: SavedUpload = {
          key,
          name: file.name,
          size: file.size,
          modified: file.lastModified,
          ttl,
          limit,
          protect,
          passwordSalt: saved?.passwordSalt || passwordSalt(),
        };
        localStorage.setItem(savedKey, JSON.stringify(draft));
        setSaved(draft);
        const protectedBody = await passwordBody(
          protect ? password : "",
          settings.password_protocol,
          draft.passwordSalt,
        );
        if (epoch !== generation.current || !alive.current) return;
        u = await api<Upload>(
          "/uploads",
          {
            method: "POST",
            headers: { "Idempotency-Key": key },
            body: JSON.stringify({
              name: file.name,
              confirm_large:
                file.size > (settings.upload_confirmation_bytes ?? 100_000_000),
              size: file.size,
              ...protectedBody,
              ttl_seconds: ttl,
              max_downloads: limit,
            }),
          },
          auth.csrf,
        );
        if (epoch !== generation.current || !alive.current) return;
        const s = { ...draft, id: u.id };
        localStorage.setItem(savedKey, JSON.stringify(s));
        setSaved(s);
        setUpload(u);
      }
      if (u.state === "finalizing") {
        await poll(u.id, epoch);
        return;
      }
      u = await api<Upload>(`/uploads/${u.id}`);
      if (epoch !== generation.current || !alive.current) return;
      setUpload(u);
      if (u.state === "completed") {
        await done(u, epoch);
        return;
      }
      if (u.state === "finalizing") {
        await poll(u.id, epoch);
        return;
      }
      let retry = 0;
      while (
        (u.offset < u.size ||
          (u.storage_backend === "r2" &&
            u.size === 0 &&
            (u.part_bytes === 0 ? !u.object_uploaded : !u.parts?.length))) &&
        !pause.current
      ) {
        try {
          const offset = await chunk(
            u,
            file.slice(
              u.offset,
              u.offset +
                (u.storage_backend === "r2"
                  ? u.part_bytes || u.size
                  : settings.chunk_bytes),
            ),
            epoch,
          );
          if (epoch !== generation.current || !alive.current) return;
          u =
            u.storage_backend === "r2"
              ? await api<Upload>(`/uploads/${u.id}`)
              : { ...u, offset };
          setUpload(u);
          if (
            u.storage_backend === "r2" &&
            (u.part_bytes === 0 || u.size <= u.part_bytes) &&
            ["created", "uploading"].includes(u.state) &&
            (u.part_bytes === 0
              ? !u.object_uploaded
              : !u.parts?.length || u.offset !== u.size)
          )
            throw new ApiError(
              "R2 已响应上传成功，但服务端尚未确认完整对象。任务已保留，请稍后继续；不会自动重传整个文件。",
              409,
              "r2_upload_unverified",
            );
          setSending(undefined);
          retry = 0;
        } catch (e) {
          setSending(undefined);
          if (pause.current) break;
          if (
            ++retry > 3 ||
            (e instanceof ApiError &&
              e.code !== "r2_url_expired" &&
              [400, 401, 403, 409, 413, 507].includes(e.status))
          )
            throw e;
          setPhase("retrying");
          await sleep(500 * 2 ** retry);
          if (pause.current) break;
          u = await api<Upload>(`/uploads/${u.id}`);
          if (epoch !== generation.current || !alive.current) return;
          setUpload(u);
          setPhase("uploading");
        }
      }
      if (epoch !== generation.current || !alive.current) return;
      if (pause.current) {
        setPhase("paused");
        return;
      }
      setPhase("checking");
      u = await api<Upload>(
        `/uploads/${u.id}/complete`,
        { method: "POST", signal: AbortSignal.timeout(90_000) },
        auth.csrf,
      );
      if (epoch !== generation.current || !alive.current) return;
      setUpload(u);
      await poll(u.id, epoch);
    } catch (e) {
      if (alive.current && epoch === generation.current) {
        // A definite rejection never created a task. Network/5xx uncertainty
        // retains the idempotency key so a lost success can still be recovered.
        if (
          !u &&
          e instanceof ApiError &&
          [400, 401, 403, 413, 429, 507].includes(e.status)
        )
          clearDraft();
        setError((e as Error).message);
        setPhase(
          e instanceof ApiError && e.code === "upload_not_finalizing"
            ? "failed"
            : u?.state === "finalizing"
              ? "pending"
              : u
                ? "paused"
                : "failed",
        );
      }
    } finally {
      running.current = false;
      setSending(undefined);
    }
  }
  async function cancel() {
    if (
      !window.confirm(
        t("取消这次上传？已上传的数据和续传记录将被删除，无法恢复。"),
      )
    )
      return;
    const epoch = ++generation.current;
    pause.current = true;
    xhr.current?.abort();
    setPhase("canceling");
    let current = upload;
    try {
      if (!current && saved?.key) {
        current = await api<Upload>("/uploads/lookup", {
          headers: { "Idempotency-Key": saved.key },
          signal: AbortSignal.timeout(30_000),
        });
      }
      if (current) {
        await api(
          `/uploads/${current.id}`,
          {
            method: "DELETE",
            signal: AbortSignal.timeout(90_000),
          },
          auth.csrf,
        );
      }
      if (alive.current && epoch === generation.current) resetUpload();
    } catch (e) {
      if (!alive.current || epoch !== generation.current) return;
      if (e instanceof ApiError && e.status === 404) {
        resetUpload();
        return;
      }
      // Cancellation stopped the old poll. Reconcile with the server instead
      // of leaving the page in checking with no operation able to finish it.
      if (current) {
        try {
          current = await api<Upload>(`/uploads/${current.id}`, {
            signal: AbortSignal.timeout(30_000),
          });
          if (!alive.current || epoch !== generation.current) return;
          setUpload(current);
          if (current.state === "completed") {
            await done(current, epoch);
            return;
          }
        } catch {
          // Keep the task and allow a later explicit query/retry.
        }
      }
      if (!alive.current || epoch !== generation.current) return;
      setPhase(current?.state === "finalizing" ? "pending" : "paused");
      setError((e as Error).message);
    }
  }
  const backend = upload?.storage_backend ?? settings?.storage_backend;
  const busy = [
    "uploading",
    "retrying",
    "checking",
    "canceling",
    "recovering",
  ].includes(phase);
  // The active request has its own start offset. Adding to a freshly confirmed
  // upload.offset would count that request twice during the handoff to R2.
  const transferred = upload
    ? Math.min(
        upload.size,
        Math.max(upload.offset, sending ? sending.offset + sending.loaded : 0),
      )
    : 0;
  const emptyTransferred =
    upload &&
    (upload.object_uploaded ||
      !!upload.parts?.length ||
      ["finalizing", "completed"].includes(upload.state));
  const ratio = upload
    ? upload.size
      ? transferred / upload.size
      : emptyTransferred
        ? 1
        : 0
    : 0;
  if (result)
    return (
      <Shell auth={auth}>
        <div className="success-card">
          <div className="symbol success">
            <CheckCircle2 size={35} aria-hidden="true" />
          </div>
          <h1>{t("文件已装好，交给对方吧。")}</h1>
          <p className="muted">
            {result.name} · {bytes(result.size)}
          </p>
          <CopyField
            value={result.url}
            name={result.name}
            password={protect ? password : undefined}
            passwordRequired={result.password_required}
          >
            {protect && password && (
              <div className="password-display">
                <LockKeyhole size={17} aria-hidden="true" />
                <span>{t("分享密码")}</span>
                <code>{password}</code>
              </div>
            )}
            <div className="rule-grid">
              <div>
                <Clock3 size={18} aria-hidden="true" />
                <strong>{date(result.expires)}</strong>
                <span>{t("到期自动失效")}</span>
              </div>
              <div>
                <ArrowDown size={18} aria-hidden="true" />
                <strong>
                  {result.max_downloads === -1
                    ? t("不限次数")
                    : t("{0} 次", result.max_downloads)}
                </strong>
                <span>{t("新下载资格")}</span>
              </div>
            </div>
          </CopyField>
          <a
            className="button secondary full"
            href={`/admin/shares/${result.id}`}
          >
            {t("查看分享详情")}
            <ArrowRight size={17} aria-hidden="true" />
          </a>
          <a className="back-link" href="/admin">
            {t("返回我的分享")}
          </a>
        </div>
      </Shell>
    );
  return (
    <Shell auth={auth}>
      <a className="back-link" href="/admin">
        <ArrowLeft size={16} aria-hidden="true" />
        {t("我的分享")}
      </a>
      <section className="page-heading compact">
        <div>
          <h1>{t("新建分享")}</h1>
          <p className="muted">
            {t("选一份文件，设好规则，就可以发送链接了。")}
          </p>
        </div>
      </section>
      <ErrorMessage message={error} />
      <div className="new-grid">
        <section className="panel upload-panel">
          <div className="panel-title">
            <h2>{t("选择文件")}</h2>
            <span className="muted">{t("单文件分享")}</span>
          </div>
          <input
            ref={input}
            type="file"
            name="share-file"
            className="sr-only"
            tabIndex={-1}
            aria-label={t("选择文件")}
            onChange={(e) => choose(e.target.files?.[0])}
            disabled={busy}
          />
          <button
            type="button"
            aria-label={t("选择要分享的文件")}
            className={`dropzone ${drag ? "drag" : ""}`}
            disabled={busy}
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              if (!busy) choose(e.dataTransfer.files[0]);
            }}
          >
            <ParcelEnvelope compact />
            <strong>
              {file
                ? file.name
                : saved
                  ? t("重新选择 {0}", saved.name)
                  : t("把文件放在这里")}
            </strong>
            <span>
              {file
                ? bytes(file.size)
                : settings
                  ? t("支持单个文件，最大 {0}", bytes(settings.max_file_bytes))
                  : t("正在读取服务器配置…")}
            </span>
            <span className="choose-file-label">
              <Plus size={16} aria-hidden="true" />
              {file ? t("重新选择文件") : t("点击选择，或拖入文件")}
            </span>
          </button>
          {saved && !file && (
            <p className="note">
              {t(
                "发现未完成上传。重新选择原文件后可继续；文件名与大小匹配不能保证内容未改变。",
              )}
            </p>
          )}
          {upload?.storage_backend === "local" &&
            settings?.storage_backend === "r2" && (
              <p className="note">
                {t(
                  "这是启用 R2 前创建的本地上传任务，继续上传仍会经过服务器。 如需直传 R2，请取消这次上传后新建任务。",
                )}
              </p>
            )}
          {upload && (
            <div className="progress-card">
              <div>
                <strong role="status" aria-live="polite" aria-atomic="true">
                  {phase === "checking"
                    ? t("传输完成，正在发布…")
                    : phase === "pending"
                      ? t("等待发布结果")
                      : phase === "failed"
                        ? t("上传未完成")
                        : phase === "paused"
                          ? t("上传已暂停")
                          : phase === "retrying"
                            ? t("等待重试…")
                            : ratio === 1
                              ? t("传输完成，正在确认…")
                              : t("正在上传…")}
                </strong>
                <span>{Math.floor(ratio * 100)}%</span>
              </div>
              <div
                className="meter"
                role="progressbar"
                aria-label={t("文件上传进度")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.floor(ratio * 100)}
              >
                <span
                  style={{
                    transform: `scaleX(${ratio})`,
                    transition: ratio === 1 ? "none" : undefined,
                  }}
                />
              </div>
              <small>
                {t("已上传")} {bytes(transferred)} / {bytes(upload.size)}
              </small>
              {phase === "checking" && (
                <p className="note">
                  <Loader2 size={15} className="spin" aria-hidden="true" />
                  {t("正在核对文件并生成分享链接，无需重新上传。")}
                </p>
              )}
            </div>
          )}
          <div className="upload-bottom">
            <ShieldCheck size={18} aria-hidden="true" />
            <p>
              {backend === "r2"
                ? t(
                    "文件直传到私有 R2 存储。分享失效后，Parcel 会自动回收空间。",
                  )
                : t("文件只保存在本机。分享失效后，Parcel 会自动回收空间。")}
            </p>
          </div>
        </section>
        <section className="panel rules-panel">
          <div className="panel-title">
            <h2>{t("分享规则")}</h2>
          </div>
          <fieldset disabled={busy || !!upload || !settings}>
            <label htmlFor="share-ttl">{t("有效期")}</label>
            <select
              id="share-ttl"
              name="share-ttl"
              autoComplete="off"
              value={ttl}
              onChange={(e) => {
                setTTL(Number(e.target.value));
                setRulesDirty(true);
              }}
            >
              {Array.from(
                new Set([
                  3600,
                  86400,
                  604800,
                  settings?.default_ttl_seconds || 86400,
                ]),
              )
                .filter((v) => !settings || v <= settings.max_ttl_seconds)
                .map((v) => (
                  <option key={v} value={v}>
                    {v === 3600
                      ? t("1 小时")
                      : v === 86400
                        ? t("24 小时")
                        : v === 604800
                          ? t("7 天")
                          : t("{0} 秒", v)}
                  </option>
                ))}
            </select>
            <small>{t("从文件校验并发布成功时开始计算。")}</small>
            <label htmlFor="share-limit">{t("下载次数")}</label>
            <input
              ref={limitInput}
              id="share-limit"
              name="share-limit"
              autoComplete="off"
              aria-invalid={!!validation.limit}
              aria-describedby={
                validation.limit ? "share-limit-error" : undefined
              }
              type="number"
              min={1}
              max={100}
              disabled={limit === -1}
              value={limit === -1 ? "" : limit}
              placeholder={limit === -1 ? t("不限次数…") : undefined}
              onChange={(e) => {
                setLimit(Number(e.target.value));
                setRulesDirty(true);
                setValidation((v) => ({ ...v, limit: undefined }));
              }}
            />
            <label className="toggle-row" htmlFor="unlimited-downloads">
              <span>{t("不限下载次数")}</span>
              <input
                id="unlimited-downloads"
                name="unlimited-downloads"
                type="checkbox"
                checked={limit === -1}
                onChange={(e) => {
                  if (e.target.checked) previousLimit.current = limit;
                  setLimit(e.target.checked ? -1 : previousLimit.current);
                  setRulesDirty(true);
                  setValidation((v) => ({ ...v, limit: undefined }));
                }}
              />
            </label>
            <small>
              {limit === -1
                ? t("有效期内可不限次数下载，密码保护仍然生效。")
                : backend === "r2"
                  ? t("获取下载地址消耗一次，同一会话续签不重复计数。")
                  : t("首次准许传输消耗一次，同一会话续传不重复计数。")}
            </small>
            <div id="share-limit-error">
              <ErrorMessage message={validation.limit || ""} />
            </div>
            <label className="toggle-row" htmlFor="protect">
              <span>{t("密码保护")}</span>
              <input
                id="protect"
                name="protect"
                type="checkbox"
                checked={protect}
                onChange={(e) => {
                  setProtect(e.target.checked);
                  setRulesDirty(true);
                  setValidation((v) => ({ ...v, password: undefined }));
                  if (e.target.checked && !password)
                    setPassword(randomShareCode());
                }}
              />
            </label>
            {protect && (
              <div className="password-field">
                <input
                  ref={sharePasswordInput}
                  name="share-password"
                  spellCheck={false}
                  aria-invalid={!!validation.password}
                  aria-describedby={
                    validation.password ? "share-password-error" : undefined
                  }
                  aria-label={t("分享密码")}
                  type="text"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setRulesDirty(true);
                    setValidation((v) => ({ ...v, password: undefined }));
                  }}
                  placeholder={t("例如 abcd…")}
                  autoComplete="off"
                />
                <button
                  className="text-button"
                  onClick={() => {
                    setPassword(randomShareCode());
                    setRulesDirty(true);
                    setValidation((v) => ({ ...v, password: undefined }));
                  }}
                  type="button"
                >
                  {t("换一个")}
                </button>
              </div>
            )}
            <div id="share-password-error">
              <ErrorMessage message={validation.password || ""} />
            </div>
          </fieldset>
          <div className="actions">
            {["uploading", "retrying"].includes(phase) ? (
              <button
                className="button secondary full"
                onClick={() => {
                  pause.current = true;
                  xhr.current?.abort();
                }}
              >
                <Pause size={17} aria-hidden="true" />
                {t("暂停上传")}
              </button>
            ) : (
              <button
                className="button primary full"
                onClick={start}
                disabled={
                  (!file && upload?.state !== "finalizing") ||
                  !settings ||
                  ["checking", "canceling", "recovering"].includes(phase)
                }
              >
                {phase === "checking" ? (
                  <Loader2 className="spin" size={18} aria-hidden="true" />
                ) : (
                  <UploadCloud size={18} aria-hidden="true" />
                )}
                {phase === "checking"
                  ? backend === "r2"
                    ? t("正在完成上传…")
                    : t("正在校验…")
                  : upload?.state === "finalizing"
                    ? t("查询发布结果")
                    : upload
                      ? t("继续上传")
                      : t("上传并创建分享")}
              </button>
            )}
            {(upload || saved) && (
              <button
                className="text-button danger cancel-upload"
                onClick={cancel}
                disabled={phase === "canceling" || phase === "recovering"}
              >
                <X size={16} aria-hidden="true" />
                {t("取消这次上传")}
              </button>
            )}
          </div>
        </section>
      </div>
    </Shell>
  );
}
function ShareDetail({ auth, id }: { auth: Auth; id: string }) {
  const [share, setShare] = useState<Share>(),
    [copyPassword, setCopyPassword] = useState<string>(),
    [error, setError] = useState(""),
    [password, setPassword] = useState(""),
    [message, setMessage] = useState(""),
    [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [passwordError, setPasswordError] = useState("");
  const passwordInput = useRef<HTMLInputElement>(null);
  useLeaveWarning(!!password);
  async function load() {
    try {
      setShare(await api<Share>(`/admin/shares/${id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [id]);
  async function revoke() {
    setBusy(true);
    try {
      await api(`/admin/shares/${id}`, { method: "DELETE" }, auth.csrf);
      setConfirm(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordError("");
    if (password && new TextEncoder().encode(password).length < 4) {
      setPasswordError("分享密码至少需要 4 字节，例如 abcd。");
      passwordInput.current?.focus();
      return;
    }
    setError("");
    setBusy(true);
    setMessage("");
    try {
      await api(
        `/admin/shares/${id}/password`,
        {
          method: "PATCH",
          body: JSON.stringify(
            await passwordBody(password, auth.password_protocol),
          ),
        },
        auth.csrf,
      );
      setMessage(
        password
          ? "密码已更新，旧授权已失效。分享文案会附上新提取码。"
          : "密码保护已关闭，旧授权已失效。",
      );
      setCopyPassword(password || undefined);
      setPassword("");
      await load();
    } catch (e) {
      setPasswordError((e as Error).message);
      passwordInput.current?.focus();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Shell auth={auth}>
      <a className="back-link" href="/admin">
        <ArrowLeft size={16} aria-hidden="true" />
        {t("我的分享")}
      </a>
      <ErrorMessage message={error} />
      {share ? (
        <>
          <section className="page-heading compact">
            <div>
              <h1>{t("分享详情")}</h1>
              <p className="filename-title" translate="no">
                {share.name}
              </p>
              <p className="muted">
                {bytes(share.size)}
                {t("· 创建于")}
                {date(share.created)}
              </p>
            </div>
            <span
              className={`badge ${share.availability === "available" ? "green" : ""}`}
            >
              {t(availability[share.availability])}
            </span>
          </section>
          <div className="detail-grid">
            <section className="panel detail-main">
              <CopyField
                value={share.url}
                name={share.name}
                password={share.password_required ? copyPassword : undefined}
                passwordRequired={share.password_required}
              />
              <div className="rule-grid">
                <div>
                  <Clock3 size={20} aria-hidden="true" />
                  <strong>{date(share.expires)}</strong>
                  <span>{t("到期时间")}</span>
                </div>
                <div>
                  <ArrowDown size={20} aria-hidden="true" />
                  <strong>
                    {share.download_count} /{" "}
                    {share.max_downloads === -1
                      ? t("不限次数")
                      : share.max_downloads}
                  </strong>
                  <span>{t("已用下载资格")}</span>
                </div>
                <div>
                  <LockKeyhole size={20} aria-hidden="true" />
                  <strong>
                    {share.password_required ? t("已启用") : t("未启用")}
                  </strong>
                  <span>{t("密码保护")}</span>
                </div>
              </div>
              <label>
                {share.storage_backend === "r2" ? "R2 ETag" : "SHA-256"}
              </label>
              <code className="hash">
                {share.storage_backend === "r2" ? share.etag : share.sha256}
              </code>
              {share.storage_backend === "r2" && (
                <p className="muted">
                  {t("对象大小及上传任务已由服务端核验；ETag 不是 SHA-256。")}
                </p>
              )}
              <p className="note">
                {t(
                  "次数用完后，已开始的有效会话仍可续传；会话结束后再回收文件。",
                )}
              </p>
              {share.error && <ErrorMessage message={share.error} />}
              <a
                className="button secondary"
                href={`/s/${id}`}
                target="_blank"
                rel="noreferrer"
              >
                {t("打开接收页")}
                <ArrowRight size={16} aria-hidden="true" />
              </a>
            </section>
            <section className="panel detail-tools">
              <h2>{t("管理分享")}</h2>
              {share.state === "active" && share.availability !== "expired" ? (
                <>
                  <form onSubmit={changePassword}>
                    <label htmlFor="new-password">{t("修改分享密码")}</label>
                    <input
                      ref={passwordInput}
                      id="new-password"
                      name="new-password"
                      spellCheck={false}
                      aria-invalid={!!passwordError}
                      aria-describedby={
                        passwordError ? "new-password-error" : undefined
                      }
                      type="text"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        setPasswordError("");
                      }}
                      placeholder={t("例如 abcd；留空关闭密码保护…")}
                      autoComplete="off"
                    />
                    <div id="new-password-error">
                      <ErrorMessage message={passwordError} />
                    </div>
                    <button className="button secondary full" disabled={busy}>
                      {busy && (
                        <Loader2
                          className="spin"
                          size={18}
                          aria-hidden="true"
                        />
                      )}
                      {busy ? t("正在保存…") : t("保存密码设置")}
                    </button>
                    {message && (
                      <p className="note" role="status">
                        {t(message)}
                      </p>
                    )}
                  </form>
                  <div className="divider" />
                  {confirm ? (
                    <div className="confirm">
                      <p>{t("撤销后，链接立即失效，文件将进入清理流程。")}</p>
                      <button
                        className="button destructive full"
                        onClick={revoke}
                        disabled={busy}
                      >
                        {t("确认撤销")}
                      </button>
                      <button
                        className="text-button"
                        onClick={() => setConfirm(false)}
                      >
                        {t("保留分享")}
                      </button>
                    </div>
                  ) : (
                    <button
                      className="button danger-outline full"
                      onClick={() => setConfirm(true)}
                    >
                      <Trash2 size={17} aria-hidden="true" />
                      {t("撤销分享")}
                    </button>
                  )}
                </>
              ) : (
                <p className="muted">
                  {t("此分享已失效。需要重新分享时，请创建新的分享。")}
                </p>
              )}
            </section>
          </div>
        </>
      ) : error ? (
        <section className="panel detail-main">
          <h1>{t("无法读取分享")}</h1>
          <p className="note">{t("请检查链接，或返回我的分享重新选择。")}</p>
        </section>
      ) : (
        <Loading />
      )}
    </Shell>
  );
}
function Receive({ id }: { id: string }) {
  const passwordInput = useRef<HTMLInputElement>(null);
  const [unlockError, setUnlockError] = useState("");
  const [share, setShare] = useState<Share>(),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [ticket, setTicket] = useState<DownloadTicket | undefined>(() => {
      try {
        return (
          JSON.parse(
            sessionStorage.getItem(`parcel.download.${id}`) || "null",
          ) || undefined
        );
      } catch {
        return undefined;
      }
    });
  async function load() {
    try {
      setShare(await api<Share>(`/shares/${id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, [id]);
  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setUnlockError("");
    try {
      setShare(
        await api<Share>(`/shares/${id}/unlock`, {
          method: "POST",
          body: JSON.stringify(
            await passwordBody(
              password,
              share?.password_protocol,
              share?.password_kdf?.salt,
              share?.password_kdf,
            ),
          ),
        }),
      );
      setPassword("");
    } catch (e) {
      setUnlockError((e as Error).message);
      passwordInput.current?.focus();
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    setBusy(true);
    setError("");
    try {
      let t = ticket;
      if (t?.session) {
        t = await api<DownloadTicket>(
          `/shares/${id}/download-sessions/refresh`,
          {
            method: "POST",
            body: JSON.stringify({ session: t.session }),
          },
        );
      } else if (!t) {
        t = await api<DownloadTicket>(`/shares/${id}/download-sessions`, {
          method: "POST",
        });
      }
      setTicket(t);
      if (t.session) {
        try {
          sessionStorage.setItem(`parcel.download.${id}`, JSON.stringify(t));
        } catch {
          /* Private browser policies must not prevent the download. */
        }
      }
      if (!t.session) {
        const head = await fetch(t.url, {
          method: "HEAD",
          credentials: "same-origin",
        });
        if (!head.ok) {
          if (head.status !== 503) setTicket(undefined);
          throw new Error(
            head.status === 503
              ? "下载繁忙，请稍后重试。"
              : "下载会话或分享已失效，请重新打开链接。",
          );
        }
      }
      const a = document.createElement("a");
      a.href = t.url;
      a.download = "";
      document.body.append(a);
      a.click();
      a.remove();
      await sleep(500);
      if (!t.session) {
        const active = await fetch(t.url, {
          method: "HEAD",
          credentials: "same-origin",
        });
        if (
          active.ok &&
          active.headers.get("X-Download-Session-State") === "active"
        )
          setTicket({
            ...t,
            expires: Number(active.headers.get("X-Download-Session-Expires")),
          });
      }
      await load();
    } catch (e) {
      if (e instanceof ApiError && [401, 410].includes(e.status)) {
        setTicket(undefined);
        try {
          sessionStorage.removeItem(`parcel.download.${id}`);
        } catch {
          /* Unavailable storage. */
        }
        await load();
      }
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const inactive =
      share && !["available", "exhausted"].includes(share.availability),
    canDownload =
      share &&
      !inactive &&
      !share.locked &&
      (share.availability === "available" || !!ticket);
  return (
    <Shell>
      <div className="receive-card">
        {!share ? (
          <>
            <div className="symbol">
              <Package size={34} aria-hidden="true" />
            </div>
            {error ? (
              <>
                <h1>{t("无法打开分享")}</h1>
                <p className="muted">
                  {t("请检查链接，或联系分享者重新发送。")}
                </p>
              </>
            ) : (
              <Loading />
            )}
          </>
        ) : inactive ? (
          <>
            <div className="symbol">
              <Clock3 size={32} aria-hidden="true" />
            </div>
            <h1>{t(availability[share.availability]) || t("分享已失效")}</h1>
            <p className="muted">
              {t("文件无法继续下载，请联系分享者重新发送。")}
            </p>
          </>
        ) : share.locked ? (
          <>
            <div className="symbol">
              <LockKeyhole size={32} aria-hidden="true" />
            </div>
            <h1>{t("输入密码，打开这份分享。")}</h1>
            <p className="muted">{t("这份文件设置了密码保护。")}</p>
            <form onSubmit={unlock}>
              <label htmlFor="receive-password">{t("分享密码")}</label>
              <input
                ref={passwordInput}
                id="receive-password"
                aria-invalid={!!t(unlockError)}
                aria-describedby={
                  t(unlockError) ? "receive-password-error" : undefined
                }
                name="share-password"
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setUnlockError("");
                }}
                autoComplete="off"
                required
                autoFocus={desktopAutofocus()}
              />
              <div id="receive-password-error">
                <ErrorMessage message={t(unlockError)} />
              </div>
              <button className="button primary full" disabled={busy}>
                {busy ? (
                  <Loader2 className="spin" size={18} aria-hidden="true" />
                ) : (
                  <KeyRound size={18} aria-hidden="true" />
                )}
                {busy ? t("正在验证…") : t("解锁文件")}
              </button>
            </form>
          </>
        ) : (
          <>
            <div className="symbol">
              <File size={34} aria-hidden="true" />
            </div>
            <h1>{t("接收文件")}</h1>
            <p className="filename-title" translate="no">
              {share.name}
            </p>
            <p className="file-size">{bytes(share.size)}</p>
            <div className="rule-grid">
              <div>
                <Clock3 size={19} aria-hidden="true" />
                <strong>{date(share.expires)}</strong>
                <span>{t("有效期至")}</span>
              </div>
              <div>
                <ArrowDown size={19} aria-hidden="true" />
                <strong>
                  {share.max_downloads === -1
                    ? t("不限次数")
                    : t(
                        "{0} 次",
                        Math.max(0, share.max_downloads - share.download_count),
                      )}
                </strong>
                <span>{t("剩余新下载资格")}</span>
              </div>
            </div>
            <button
              className="button primary full download-button"
              onClick={download}
              disabled={busy || !canDownload}
            >
              {busy ? (
                <Loader2 className="spin" size={20} aria-hidden="true" />
              ) : (
                <ArrowDown size={20} aria-hidden="true" />
              )}
              {busy
                ? t("正在准备…")
                : ticket
                  ? t("再次下载 / 继续")
                  : t("下载文件")}
            </button>
            {ticket && (
              <a
                className="direct-download"
                href={ticket.url}
                download
                onClick={
                  ticket.session
                    ? (e) => {
                        e.preventDefault();
                        void download();
                      }
                    : undefined
                }
              >
                {t("若下载未开始，点击此处重新下载")}
              </a>
            )}
            <p className="note">
              {share.storage_backend === "r2"
                ? t("获取下载地址消耗一次资格。")
                : t("首次准许传输消耗一次资格。")}
              {t(
                "同一有效会话内重试不重复扣次。文件保存进度请查看浏览器下载列表。",
              )}
            </p>
            {ticket?.session && (
              <p className="muted">
                {t(
                  "下载地址有效 5 分钟。断线后点击下载会续签同一会话，不重复扣次数；下载工具续传时请替换地址并保留 Range 偏移。",
                )}
              </p>
            )}
            {share.availability === "exhausted" && !ticket && (
              <p className="note">{t("下载次数已用完，请联系分享者。")}</p>
            )}
          </>
        )}
        <ErrorMessage message={error} />
        <div className="receive-foot">
          <ShieldCheck size={15} aria-hidden="true" />
          {t("由分享者的 Parcel 服务器交付")}
        </div>
      </div>
    </Shell>
  );
}
function App() {
  useLocale();
  const path = location.pathname,
    [auth, setAuth] = useState<Auth>(),
    [ready, setReady] = useState(false),
    [error, setError] = useState("");
  const admin = path.startsWith("/admin");
  useEffect(() => {
    if (!admin) {
      setReady(true);
      return;
    }
    api<Auth>("/auth/session")
      .then((a) => {
        setAuth(a);
        setReady(true);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401)
          location.replace("/login");
        else {
          setError(e.message);
          setReady(true);
        }
      });
  }, [admin]);
  if (path === "/login" || path === "/") return <Login />;
  if (path.startsWith("/s/")) return <Receive id={path.split("/")[2]} />;
  if (!ready)
    return (
      <Shell>
        <Loading />
      </Shell>
    );
  if (error)
    return (
      <Shell>
        <h1>{t("暂时无法连接")}</h1>
        <p className="note">{t("请刷新页面重试，或稍后再次打开。")}</p>
        <ErrorMessage message={error} />
      </Shell>
    );
  if (auth?.auth_mode === "totp" && path === "/admin/security")
    return (
      <Shell auth={auth}>
        <div className="auth-card auth-security">
          <NativeAdminForm
            csrf={auth.csrf}
            security
            onAuthenticated={(csrf) => setAuth({ ...auth, csrf })}
          />
          <a className="text-button auth-recover" href="/admin">
            {t("返回我的分享")}
          </a>
        </div>
      </Shell>
    );
  if (auth && path === "/admin/new") return <NewShare auth={auth} />;
  if (auth && path.startsWith("/admin/shares/"))
    return <ShareDetail auth={auth} id={path.split("/")[3]} />;
  if (auth && path === "/admin") return <Dashboard auth={auth} />;
  return (
    <Shell>
      <div className="empty">
        <h1>{t("页面不存在")}</h1>
        <a href="/" className="button secondary">
          {t("返回 Parcel")}
        </a>
      </div>
    </Shell>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
