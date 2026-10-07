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
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import {
  api,
  ApiError,
  availability,
  bytes,
  date,
  randomPassword,
  randomShareCode,
  sleep,
  type Share,
  type Status,
  type Upload,
} from "./api";
import "./style.css";
import "./login.css";

type Auth = { csrf: string };
function desktopAutofocus() {
  return matchMedia("(min-width: 768px) and (pointer: fine)").matches;
}
function ErrorMessage({ message }: { message: string }) {
  return message ? (
    <div className="alert" role="alert">
      {message}
    </div>
  ) : null;
}
function Loading({ text = "正在加载…" }: { text?: string }) {
  return (
    <div className="loading">
      <Loader2 className="spin" size={20} />
      {text}
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
        <File size={30} strokeWidth={1.5} />
        <span className="sheet-line" />
        <span className="sheet-line short" />
      </div>
      <div className="envelope-pocket">
        <Package size={24} strokeWidth={1.5} />
        <span>Parcel</span>
      </div>
      <span className="envelope-seal">
        <Check size={18} />
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
      await api("/auth/logout", { method: "POST" }, auth?.csrf);
      location.assign("/login");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className={`app ${auth ? "admin-app" : "public-app"} ${pageClass}`}>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <header>
        <a href={auth ? "/admin" : "/"} className="brand">
          <span className="brand-icon">
            <Package size={23} />
          </span>
          <span className="brand-wordmark">
            <strong>Parcel</strong>
            <span className="brand-tag">临时文件分享</span>
          </span>
        </a>
        {auth ? (
          <nav>
            <a
              href="/admin"
              aria-current={location.pathname === "/admin" ? "page" : undefined}
            >
              我的分享
            </a>
            <a
              href="/admin/new"
              aria-current={
                location.pathname === "/admin/new" ? "page" : undefined
              }
            >
              上传文件
            </a>
            <button
              className="text-button"
              onClick={logout}
              aria-label="退出登录"
            >
              <LogOut size={17} />
              <span>退出</span>
            </button>
          </nav>
        ) : (
          <a href="/login" className="text-button">
            管理入口 <ArrowRight size={15} />
          </a>
        )}
      </header>
      <main id="main-content" tabIndex={-1}>
        <ErrorMessage message={error} />
        {children}
      </main>
      <footer>
        <span>Parcel，让文件轻装上路。</span>
        <span>
          <ShieldCheck size={16} aria-hidden="true" />
          <span>自托管存储，到期自动清理</span>
        </span>
      </footer>
    </div>
  );
}
function CopyField({
  value,
  password,
  passwordRequired = false,
  label = "分享链接",
}: {
  value: string;
  password?: string;
  passwordRequired?: boolean;
  label?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const content = `链接：${value}${password ? `\n提取码：${password}` : ""}`;
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState(false);
  async function copy() {
    setCopied(false);
    setFallback(false);
    const copySelection = () => {
      try {
        const input = ref.current;
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
    let success = false;
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(content);
        success = true;
      } catch {
        success = copySelection();
      }
    } else {
      // Keep the HTTP fallback synchronous so the click's user activation applies.
      success = copySelection();
    }
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      setFallback(true);
    }
  }
  return (
    <div className="copy-wrapper">
      <label htmlFor="copy-link">{label}</label>
      <div className="copy-field">
        <input id="copy-link" readOnly value={value} />
        <button type="button" onClick={copy} aria-label="复制分享链接">
          {copied ? <Check size={18} /> : <Copy size={18} />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      {passwordRequired && !password && (
        <small>无法读取原提取码，复制内容仅含链接。</small>
      )}
      <textarea
        ref={ref}
        readOnly
        value={content}
        aria-label="分享内容"
        aria-hidden={!fallback}
        tabIndex={fallback ? 0 : -1}
        className={fallback ? "copy-content" : "sr-only"}
      />
      <small
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={fallback ? undefined : "sr-only"}
      >
        {fallback
          ? "分享内容已选中，请使用系统的复制操作。"
          : copied
            ? "分享链接已复制。"
            : ""}
      </small>
    </div>
  );
}
type LoginVisualHandle = { pulse: () => void };
const LoginVisual = React.memo(
  React.forwardRef<LoginVisualHandle, { focused: boolean; busy: boolean }>(
    function LoginVisual({ focused, busy }, ref) {
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
            <h2>
              分享一份文件，
              <br />
              少一份牵挂。
            </h2>
            <p>
              上传，发出链接。
              <br />
              到期之后，Parcel 帮你收好尾。
            </p>
          </div>
          <div className="login-envelope-display">
            <div ref={envelope} className="login-envelope-motion">
              <ParcelEnvelope />
            </div>
          </div>
          <div className="login-visual-status" aria-hidden="true">
            <ShieldCheck size={16} />
            <span>文件分享，从这里开始。</span>
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
  return (
    <Shell pageClass="login-app">
      <div className="login-layout">
        <LoginVisual ref={visual} focused={focused} busy={busy} />
        <div className="auth-card">
          <span className="auth-caption">
            <KeyRound size={16} aria-hidden="true" />
            <span>管理员登录</span>
          </span>
          <h1>让文件轻装上路。</h1>
          <p className="muted">登录后上传文件，创建你的临时分享。</p>
          <form ref={form} onSubmit={submit} aria-busy={busy}>
            <label htmlFor="admin-password">管理员密码</label>
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
                <Loader2 size={18} className="spin" />
              ) : (
                <ArrowRight size={18} />
              )}
              {busy ? "正在登录" : "登录 Parcel"}
            </button>
          </form>
          <p className="note">
            <ShieldCheck size={16} aria-hidden="true" />
            <span>密码由服务器管理员初始化。</span>
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
    [page, setPage] = useState(1),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  async function load() {
    try {
      const [s, list] = await Promise.all([
        api<Status>("/admin/status"),
        api<{ items: Share[]; total: number }>(`/admin/shares?page=${page}`),
      ]);
      setStatus(s);
      setItems(list.items);
      setTotal(list.total);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
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
          <h1>我的分享</h1>
          <p className="muted">把文件交给对方，把收尾交给 Parcel。</p>
        </div>
        <a className="button primary" href="/admin/new">
          <Plus size={19} />
          新建分享
        </a>
      </section>
      <ErrorMessage message={error} />
      {status && (
        <div className="stats">
          <div className="stat">
            <span>
              <HardDrive size={18} />
              存储用量
            </span>
            <strong>
              {bytes(status.used_bytes)}
              <small> / {bytes(status.quota_bytes)}</small>
            </strong>
            <div className="meter">
              <span
                style={{
                  width: `${Math.min(100, ((status.used_bytes + status.reserved_bytes) / status.quota_bytes) * 100)}%`,
                }}
              />
            </div>
            <small>
              上传预留 {bytes(status.reserved_bytes)} · 待清理{" "}
              {bytes(status.pending_bytes)}
            </small>
          </div>
          <div className="stat">
            <span>
              <FolderOpen size={18} />
              分享记录
            </span>
            <strong>
              {total}
              <small> 个分享</small>
            </strong>
            <small>到期、撤销或次数用完后自动回收文件</small>
          </div>
          <div className="stat">
            <span>
              <ShieldCheck size={18} />
              你的服务器
            </span>
            <strong>本地存储</strong>
            <small>
              磁盘可用 {bytes(status.free_bytes)} · v{status.version}
            </small>
          </div>
        </div>
      )}
      <section className="panel">
        <div className="panel-title">
          <div className="list-heading">
            <h2>分享记录</h2>
            <span>{total} 个文件</span>
          </div>
          <button className="text-button" onClick={load}>
            <RefreshCw size={15} />
            刷新
          </button>
        </div>
        {loading ? (
          <Loading />
        ) : items.length ? (
          <div className="share-list">
            <div className="list-columns" aria-hidden="true">
              <span>文件</span>
              <span>已用下载资格</span>
              <span>状态</span>
            </div>
            {items.map((s) => (
              <a
                className="share-row"
                href={`/admin/shares/${s.id}`}
                key={s.id}
              >
                <div className="file-icon" aria-hidden="true">
                  <File size={23} strokeWidth={1.5} />
                </div>
                <div className="file-info">
                  <strong>{s.name}</strong>
                  <span>
                    <span>{bytes(s.size)}</span>
                    <span>
                      {s.password_required && <LockKeyhole size={12} />}
                      {s.password_required ? "密码保护" : "无密码"}
                    </span>
                    <span>{date(s.created)}</span>
                  </span>
                </div>
                <div className="row-count">
                  <strong>
                    {s.download_count} / {s.max_downloads}
                  </strong>
                  <span className="mobile-count-label">下载资格</span>
                </div>
                <span
                  className={`badge ${s.availability === "available" ? "green" : ""}`}
                >
                  {availability[s.availability] || s.availability}
                </span>
                <ArrowRight size={17} className="row-arrow" />
              </a>
            ))}
          </div>
        ) : (
          <div className="empty">
            <ParcelEnvelope compact />
            <h3>这里，留给你要分享的文件。</h3>
            <p>上传文件，设置规则，把链接交给需要的人。</p>
            <a className="button secondary" href="/admin/new">
              <Plus size={17} />
              上传文件
            </a>
          </div>
        )}
        {total > 20 && (
          <div className="pagination">
            <button
              className="button secondary"
              disabled={page === 1}
              onClick={() => setPage(page - 1)}
            >
              上一页
            </button>
            <span>第 {page} 页</span>
            <button
              className="button secondary"
              disabled={page * 20 >= total}
              onClick={() => setPage(page + 1)}
            >
              下一页
            </button>
          </div>
        )}
      </section>
    </Shell>
  );
}

type SavedUpload = {
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
    [phase, setPhase] = useState("idle"),
    [upload, setUpload] = useState<Upload>(),
    [saved, setSaved] = useState(initialSaved),
    [result, setResult] = useState<Share>(),
    [drag, setDrag] = useState(false),
    [sending, setSending] = useState(0);
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
      })
      .catch((e) => setError(e.message));
    if (saved)
      api<Upload>(
        saved.id ? `/uploads/${saved.id}` : "/uploads/lookup",
        saved.id ? {} : { headers: { "Idempotency-Key": saved.key || "" } },
      )
        .then((u) => {
          setUpload(u);
          setTTL(u.ttl_seconds);
          setLimit(u.max_downloads);
          if (u.state === "completed")
            void done(u).catch((e) => setError(e.message));
          else if (u.state === "finalizing")
            void poll(u.id).catch((e) => {
              setError(e.message);
              setPhase("failed");
            });
          else if (["created", "uploading"].includes(u.state))
            setPhase("paused");
          else {
            localStorage.removeItem(savedKey);
            setSaved(undefined);
            setUpload(undefined);
          }
        })
        .catch((e) => {
          if (!(e instanceof ApiError && e.status === 404)) setError(e.message);
        });
    return () => {
      alive.current = false;
      pause.current = true;
      xhr.current?.abort();
    };
  }, []);
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
  async function done(u: Upload) {
    const s = await api<Share>(`/admin/shares/${u.share_id}`);
    if (!alive.current) return;
    setResult(s);
    setPhase("done");
    localStorage.removeItem(savedKey);
    setSaved(undefined);
  }
  async function poll(id: string, epoch = generation.current) {
    if (!alive.current || epoch !== generation.current) return;
    setPhase("checking");
    for (;;) {
      if (!alive.current || epoch !== generation.current) return;
      const u = await api<Upload>(`/uploads/${id}`);
      if (!alive.current || epoch !== generation.current) return;
      setUpload(u);
      if (u.state === "completed") {
        await done(u);
        return;
      }
      if (u.state !== "finalizing")
        throw new Error(u.error || "上传已经失效，请重新上传");
      await sleep(1000);
    }
  }
  function chunk(id: string, offset: number, blob: Blob): Promise<number> {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      xhr.current = x;
      x.open("PATCH", `/api/v1/uploads/${id}`);
      x.setRequestHeader("X-CSRF-Token", auth.csrf);
      x.setRequestHeader("Upload-Offset", String(offset));
      x.setRequestHeader("Content-Type", "application/octet-stream");
      x.timeout = 125000;
      x.upload.onprogress = (e) => setSending(e.loaded);
      x.onload = () => {
        try {
          const data = JSON.parse(x.responseText);
          if (x.status >= 200 && x.status < 300) resolve(data.offset);
          else
            reject(
              new ApiError(data.message || "上传失败", x.status, data.code),
            );
        } catch {
          reject(new Error("服务器响应异常"));
        }
      };
      x.onerror = () => reject(new Error("连接中断"));
      x.ontimeout = () => reject(new Error("分块传输超时"));
      x.onabort = () => reject(new Error("上传已暂停"));
      x.send(blob);
    });
  }
  async function start() {
    if (!file || !settings || running.current) return;
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
        };
        localStorage.setItem(savedKey, JSON.stringify(draft));
        setSaved(draft);
        u = await api<Upload>(
          "/uploads",
          {
            method: "POST",
            headers: { "Idempotency-Key": key },
            body: JSON.stringify({
              name: file.name,
              size: file.size,
              password: protect ? password : "",
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
      let retry = 0;
      while (u.offset < u.size && !pause.current) {
        try {
          const offset = await chunk(
            u.id,
            u.offset,
            file.slice(u.offset, u.offset + settings.chunk_bytes),
          );
          if (epoch !== generation.current || !alive.current) return;
          u = { ...u, offset };
          setUpload(u);
          setSending(0);
          retry = 0;
        } catch (e) {
          if (pause.current) break;
          if (
            ++retry > 3 ||
            (e instanceof ApiError && [401, 413, 507].includes(e.status))
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
      await api(`/uploads/${u.id}/complete`, { method: "POST" }, auth.csrf);
      await poll(u.id, epoch);
    } catch (e) {
      if (alive.current && epoch === generation.current) {
        setError((e as Error).message);
        setPhase(u ? "paused" : "failed");
      }
    } finally {
      running.current = false;
      setSending(0);
    }
  }
  async function cancel() {
    generation.current++;
    pause.current = true;
    xhr.current?.abort();
    if (!upload) return;
    try {
      await api(`/uploads/${upload.id}`, { method: "DELETE" }, auth.csrf);
      localStorage.removeItem(savedKey);
      setSaved(undefined);
      setUpload(undefined);
      setFile(undefined);
      setPhase("idle");
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const busy = ["uploading", "retrying", "checking"].includes(phase),
    ratio = upload ? (upload.size ? upload.offset / upload.size : 1) : 0;
  if (result)
    return (
      <Shell auth={auth}>
        <div className="success-card">
          <div className="symbol success">
            <CheckCircle2 size={35} />
          </div>
          <h1>文件已装好，交给对方吧。</h1>
          <p className="muted">
            {result.name} · {bytes(result.size)}
          </p>
          <CopyField
            value={result.url}
            password={protect ? password : undefined}
            passwordRequired={result.password_required}
          />
          {protect && password && (
            <div className="password-display">
              <LockKeyhole size={17} />
              <span>分享密码</span>
              <code>{password}</code>
            </div>
          )}
          <div className="rule-grid">
            <div>
              <Clock3 size={18} />
              <strong>{date(result.expires)}</strong>
              <span>到期自动失效</span>
            </div>
            <div>
              <ArrowDown size={18} />
              <strong>{result.max_downloads} 次</strong>
              <span>新下载资格</span>
            </div>
          </div>
          <a
            className="button primary full"
            href={`/admin/shares/${result.id}`}
          >
            查看分享详情 <ArrowRight size={17} />
          </a>
          <a className="back-link" href="/admin">
            返回我的分享
          </a>
        </div>
      </Shell>
    );
  return (
    <Shell auth={auth}>
      <a className="back-link" href="/admin">
        <ArrowLeft size={16} />
        我的分享
      </a>
      <section className="page-heading compact">
        <div>
          <h1>新建分享</h1>
          <p className="muted">选一份文件，设好规则，就可以发送链接了。</p>
        </div>
      </section>
      <ErrorMessage message={error} />
      <div className="new-grid">
        <section className="panel upload-panel">
          <div className="panel-title">
            <h2>
              <span className="step-number">1</span>选择文件
            </h2>
            <span className="muted">单文件分享</span>
          </div>
          <input
            ref={input}
            type="file"
            className="sr-only"
            tabIndex={-1}
            aria-label="选择文件"
            onChange={(e) => choose(e.target.files?.[0])}
            disabled={busy}
          />
          <button
            type="button"
            aria-label="选择要分享的文件"
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
                  ? `重新选择 ${saved.name}`
                  : "把文件放在这里"}
            </strong>
            <span>
              {file
                ? bytes(file.size)
                : settings
                  ? `支持单个文件，最大 ${bytes(settings.max_file_bytes)}`
                  : "正在读取服务器配置"}
            </span>
            <span className="choose-file-label">
              <Plus size={16} />
              {file ? "重新选择文件" : "点击选择，或拖入文件"}
            </span>
          </button>
          {saved && !file && (
            <p className="note">
              发现未完成上传。重新选择原文件后可继续；文件名与大小匹配不能保证内容未改变。
            </p>
          )}
          {upload && (
            <div className="progress-card">
              <div>
                <strong>
                  {phase === "checking"
                    ? "正在校验文件…"
                    : phase === "paused"
                      ? "上传已暂停"
                      : phase === "retrying"
                        ? "等待重试…"
                        : "正在上传…"}
                </strong>
                <span>{Math.floor(ratio * 100)}%</span>
              </div>
              <div className="meter">
                <span style={{ width: `${ratio * 100}%` }} />
              </div>
              <small>
                服务端已确认 {bytes(upload.offset)} / {bytes(upload.size)}
                {sending > 0 ? ` · 当前分块发送 ${bytes(sending)}` : ""}
              </small>
              {phase === "checking" && (
                <p className="note">
                  <Loader2 size={15} className="spin" />
                  校验完成后才会生成可用链接。
                </p>
              )}
            </div>
          )}
          <div className="upload-bottom">
            <ShieldCheck size={18} />
            <p>文件只保存在本机。分享失效后，Parcel 会自动回收空间。</p>
          </div>
        </section>
        <section className="panel rules-panel">
          <div className="panel-title">
            <h2>
              <span className="step-number">2</span>分享规则
            </h2>
          </div>
          <fieldset disabled={busy || !!upload}>
            <label htmlFor="share-ttl">有效期</label>
            <select
              id="share-ttl"
              value={ttl}
              onChange={(e) => setTTL(Number(e.target.value))}
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
                      ? "1 小时"
                      : v === 86400
                        ? "24 小时"
                        : v === 604800
                          ? "7 天"
                          : `${v} 秒`}
                  </option>
                ))}
            </select>
            <small>从文件校验并发布成功时开始计算。</small>
            <label htmlFor="share-limit">下载次数</label>
            <input
              id="share-limit"
              type="number"
              min={1}
              max={100}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            />
            <small>首次准许传输消耗一次，同一会话续传不重复计数。</small>
            <div className="toggle-row">
              <label htmlFor="protect">密码保护</label>
              <input
                id="protect"
                type="checkbox"
                checked={protect}
                onChange={(e) => {
                  setProtect(e.target.checked);
                  if (e.target.checked && !password)
                    setPassword(randomShareCode());
                }}
              />
            </div>
            {protect && (
              <div className="password-field">
                <input
                  aria-label="分享密码"
                  type="text"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="至少 4 位"
                  autoComplete="off"
                />
                <button
                  className="text-button"
                  onClick={() => setPassword(randomShareCode())}
                  type="button"
                >
                  换一个
                </button>
              </div>
            )}
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
                <Pause size={17} />
                暂停上传
              </button>
            ) : (
              <button
                className="button primary full"
                onClick={start}
                disabled={
                  !file ||
                  !settings ||
                  phase === "checking" ||
                  (!upload &&
                    (limit < 1 ||
                      limit > 100 ||
                      (protect &&
                        new TextEncoder().encode(password).length < 4)))
                }
              >
                {phase === "checking" ? (
                  <Loader2 className="spin" size={18} />
                ) : (
                  <UploadCloud size={18} />
                )}
                {phase === "checking"
                  ? "正在校验"
                  : upload
                    ? "继续上传"
                    : "上传并创建分享"}
              </button>
            )}
            {upload && (
              <button
                className="text-button danger cancel-upload"
                onClick={cancel}
              >
                <X size={16} />
                取消这次上传
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
    [busy, setBusy] = useState(false);
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
    setBusy(true);
    setMessage("");
    try {
      await api(
        `/admin/shares/${id}/password`,
        { method: "PATCH", body: JSON.stringify({ password }) },
        auth.csrf,
      );
      setMessage(
        password
          ? "密码已更新，旧授权已失效。复制分享时会附上新提取码。"
          : "密码保护已关闭，旧授权已失效。",
      );
      setCopyPassword(password || undefined);
      setPassword("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Shell auth={auth}>
      <a className="back-link" href="/admin">
        <ArrowLeft size={16} />
        我的分享
      </a>
      <ErrorMessage message={error} />
      {share ? (
        <>
          <section className="page-heading compact">
            <div>
              <p className="eyebrow">分享详情</p>
              <h1 className="filename-title">{share.name}</h1>
              <p className="muted">
                {bytes(share.size)} · 创建于 {date(share.created)}
              </p>
            </div>
            <span
              className={`badge ${share.availability === "available" ? "green" : ""}`}
            >
              {availability[share.availability]}
            </span>
          </section>
          <div className="detail-grid">
            <section className="panel detail-main">
              <CopyField
                value={share.url}
                password={share.password_required ? copyPassword : undefined}
                passwordRequired={share.password_required}
              />
              <div className="rule-grid">
                <div>
                  <Clock3 size={20} />
                  <strong>{date(share.expires)}</strong>
                  <span>到期时间</span>
                </div>
                <div>
                  <ArrowDown size={20} />
                  <strong>
                    {share.download_count} / {share.max_downloads}
                  </strong>
                  <span>已用下载资格</span>
                </div>
                <div>
                  <LockKeyhole size={20} />
                  <strong>
                    {share.password_required ? "已启用" : "未启用"}
                  </strong>
                  <span>密码保护</span>
                </div>
              </div>
              <label>SHA-256</label>
              <code className="hash">{share.sha256}</code>
              <p className="note">
                次数用完后，已开始的有效会话仍可续传；会话结束后再回收文件。
              </p>
              {share.error && <ErrorMessage message={share.error} />}
              <a
                className="button secondary"
                href={`/s/${id}`}
                target="_blank"
                rel="noreferrer"
              >
                打开接收页 <ArrowRight size={16} />
              </a>
            </section>
            <section className="panel detail-tools">
              <h2>管理分享</h2>
              {share.state === "active" && share.availability !== "expired" ? (
                <>
                  <form onSubmit={changePassword}>
                    <label htmlFor="new-password">修改分享密码</label>
                    <input
                      id="new-password"
                      type="text"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="留空以关闭密码保护"
                      autoComplete="off"
                    />
                    <button
                      className="button secondary full"
                      disabled={
                        busy ||
                        (!!password &&
                          new TextEncoder().encode(password).length < 4)
                      }
                    >
                      保存密码设置
                    </button>
                    {message && (
                      <p className="note" role="status">
                        {message}
                      </p>
                    )}
                  </form>
                  <div className="divider" />
                  {confirm ? (
                    <div className="confirm">
                      <p>撤销后，链接立即失效，文件将进入清理流程。</p>
                      <button
                        className="button destructive full"
                        onClick={revoke}
                        disabled={busy}
                      >
                        确认撤销
                      </button>
                      <button
                        className="text-button"
                        onClick={() => setConfirm(false)}
                      >
                        保留分享
                      </button>
                    </div>
                  ) : (
                    <button
                      className="button danger-outline full"
                      onClick={() => setConfirm(true)}
                    >
                      <Trash2 size={17} />
                      撤销分享
                    </button>
                  )}
                </>
              ) : (
                <p className="muted">
                  此分享已失效。需要重新分享时，请创建新的分享。
                </p>
              )}
            </section>
          </div>
        </>
      ) : (
        <Loading />
      )}
    </Shell>
  );
}
function Receive({ id }: { id: string }) {
  const [share, setShare] = useState<Share>(),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [ticket, setTicket] = useState<{
      url: string;
      expires: number;
      max_ttl_seconds: number;
    }>();
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
    try {
      setShare(
        await api<Share>(`/shares/${id}/unlock`, {
          method: "POST",
          body: JSON.stringify({ password }),
        }),
      );
      setPassword("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    setBusy(true);
    setError("");
    try {
      let t = ticket;
      if (!t)
        t = await api<{
          url: string;
          expires: number;
          max_ttl_seconds: number;
        }>(`/shares/${id}/download-sessions`, { method: "POST" });
      setTicket(t);
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
      const a = document.createElement("a");
      a.href = t.url;
      a.download = "";
      document.body.append(a);
      a.click();
      a.remove();
      await sleep(500);
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
      await load();
    } catch (e) {
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
        <p className="eyebrow">有人给你寄来了一份文件</p>
        {!share ? (
          <>
            <div className="symbol">
              <Package size={34} />
            </div>
            {!error && <Loading />}
          </>
        ) : inactive ? (
          <>
            <div className="symbol">
              <Clock3 size={32} />
            </div>
            <h1>{availability[share.availability] || "分享已失效"}</h1>
            <p className="muted">文件无法继续下载，请联系分享者重新发送。</p>
          </>
        ) : share.locked ? (
          <>
            <div className="symbol">
              <LockKeyhole size={32} />
            </div>
            <h1>输入密码，打开这份分享。</h1>
            <p className="muted">这份文件设置了密码保护。</p>
            <form onSubmit={unlock}>
              <label htmlFor="receive-password">分享密码</label>
              <input
                id="receive-password"
                name="share-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
                required
                autoFocus={desktopAutofocus()}
              />
              <button className="button primary full" disabled={busy}>
                {busy ? (
                  <Loader2 className="spin" size={18} />
                ) : (
                  <KeyRound size={18} />
                )}
                {busy ? "正在验证" : "解锁文件"}
              </button>
            </form>
          </>
        ) : (
          <>
            <div className="symbol">
              <File size={34} />
            </div>
            <h1 className="filename-title">{share.name}</h1>
            <p className="file-size">{bytes(share.size)}</p>
            <div className="rule-grid">
              <div>
                <Clock3 size={19} />
                <strong>{date(share.expires)}</strong>
                <span>有效期至</span>
              </div>
              <div>
                <ArrowDown size={19} />
                <strong>
                  {Math.max(0, share.max_downloads - share.download_count)} 次
                </strong>
                <span>剩余新下载资格</span>
              </div>
            </div>
            <button
              className="button primary full download-button"
              onClick={download}
              disabled={busy || !canDownload}
            >
              {busy ? (
                <Loader2 className="spin" size={20} />
              ) : (
                <ArrowDown size={20} />
              )}
              {busy ? "正在准备" : ticket ? "再次下载 / 继续" : "下载文件"}
            </button>
            {ticket && (
              <a className="direct-download" href={ticket.url} download>
                若下载未开始，点击此处重新下载
              </a>
            )}
            <p className="note">
              首次准许传输消耗一次资格。同一有效会话内重试不重复扣次。文件保存进度请查看浏览器下载列表。
            </p>
            {share.availability === "exhausted" && !ticket && (
              <p className="note">下载次数已用完，请联系分享者。</p>
            )}
          </>
        )}
        <ErrorMessage message={error} />
        <div className="receive-foot">
          <ShieldCheck size={15} />
          由分享者的 Parcel 服务器交付
        </div>
      </div>
    </Shell>
  );
}
function App() {
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
        <ErrorMessage message={error} />
      </Shell>
    );
  if (auth && path === "/admin/new") return <NewShare auth={auth} />;
  if (auth && path.startsWith("/admin/shares/"))
    return <ShareDetail auth={auth} id={path.split("/")[3]} />;
  if (auth && path === "/admin") return <Dashboard auth={auth} />;
  return (
    <Shell>
      <div className="empty">
        <h1>页面不存在</h1>
        <a href="/" className="button secondary">
          返回 Parcel
        </a>
      </div>
    </Shell>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
