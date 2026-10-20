import { t } from "./i18n";
import React, { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  Clock3,
  File,
  KeyRound,
  Loader2,
  LockKeyhole,
  Pause,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  api,
  ApiError,
  availability,
  bytes,
  date,
  type DownloadTicket,
  type Share,
} from "./api";
import { parseLinkSecret, unlockEnvelope, type FileContext } from "./e2ee";
import { PASSWORD_PROTOCOL, passwordBody } from "./password";
import {
  cacheID,
  downloadState,
  prepareDownloadSaving,
  saveDecryptedDownload,
  stageEncryptedDownload,
  type DownloadState,
} from "./encrypted-download";
import {
  clearCachedDownload,
  deleteLocalRecord,
  localRecord,
  localRecordOrCreate,
  saveLocalRecord,
} from "./transfer-storage";

export function EncryptedReceive({ id }: { id: string }) {
  const passwordInput = useRef<HTMLInputElement>(null);
  const [secret, setSecret] = useState(() => parseLinkSecret(location.hash));
  const abort = useRef<AbortController | undefined>(undefined);
  const [share, setShare] = useState<Share>();
  const [context, setContext] = useState<FileContext>();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [unlockError, setUnlockError] = useState("");
  const [phase, setPhase] = useState("loading");
  const [progress, setProgress] = useState<DownloadState>({
    completedParts: 0,
    received: 0,
  });
  const [savedBytes, setSavedBytes] = useState(0);
  const [ticket, setTicket] = useState<DownloadTicket>();
  const [sessionExpired, setSessionExpired] = useState(false);
  const active = useRef(true);
  const loadEpoch = useRef(0);
  const busy = ["unlocking", "receiving", "saving"].includes(phase);
  useEffect(() => {
    const changed = () => {
      const next = parseLinkSecret(location.hash);
      if (next === secret) return;
      loadEpoch.current++;
      abort.current?.abort();
      setContext(undefined);
      setPassword("");
      setError("");
      setUnlockError("");
      setProgress({ completedParts: 0, received: 0 });
      setSessionExpired(false);
      setPhase("loading");
      setSecret(next);
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, [secret]);
  useEffect(() => {
    active.current = true;
    const epoch = ++loadEpoch.current;
    const current = () => active.current && epoch === loadEpoch.current;
    void (async () => {
      try {
        const value = await api<Share>(`/shares/${id}`);
        if (!current()) return;
        setShare(value);
        const previousTicket = await localRecord<DownloadTicket>(
          `download-ticket:${id}`,
        );
        if (!current()) return;
        setTicket(previousTicket);
        if (!value.encryption)
          throw new Error(
            "这份分享使用旧协议，无法在端到端加密模式下打开。请联系分享者重新上传。",
          );
        if (secret && !value.encryption.password_kdf) {
          const opened = await unlockEnvelope(value.encryption, secret, "");
          const cached = await downloadState(opened);
          if (!current()) return;
          setContext(opened);
          setProgress(cached);
        }
        setPhase("idle");
        void prepareDownloadSaving().catch(() => {
          /* Saving reports unsupported browsers when used. */
        });
      } catch (e) {
        if (current()) {
          setError((e as Error).message);
          setPhase("idle");
        }
      }
    })();
    return () => {
      active.current = false;
      abort.current?.abort();
    };
  }, [id, secret]);
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);
  async function unlock(event: React.FormEvent) {
    event.preventDefault();
    if (!share?.encryption || !secret) return;
    setPhase("unlocking");
    setUnlockError("");
    setError("");
    const epoch = loadEpoch.current;
    try {
      // The envelope uses its own Argon2id salt plus the fragment secret. The
      // separately salted server verifier is only an online access gate.
      const opened = await unlockEnvelope(share.encryption, secret, password);
      if (share.password_protocol !== PASSWORD_PROTOCOL)
        throw new Error("服务器未提供安全的密码验证协议。");
      const unlocked = await api<Share>(`/shares/${id}/unlock`, {
        method: "POST",
        body: JSON.stringify(
          await passwordBody(
            password,
            share.password_protocol,
            share.password_kdf?.salt,
            share.password_kdf,
          ),
        ),
      });
      const cached = await downloadState(opened);
      if (!active.current || epoch !== loadEpoch.current) return;
      setContext(opened);
      setShare(unlocked);
      setPassword("");
      setProgress(cached);
    } catch {
      if (!active.current || epoch !== loadEpoch.current) return;
      setUnlockError("密码或链接密钥不正确，无法解密这份分享。");
      passwordInput.current?.focus();
    } finally {
      if (active.current && epoch === loadEpoch.current) setPhase("idle");
    }
  }
  async function currentTicket(refresh: boolean): Promise<DownloadTicket> {
    let value = await localRecord<DownloadTicket>(`download-ticket:${id}`);
    if (value?.session) {
      if (refresh || value.expires <= Date.now() / 1000 + 30)
        value = await api<DownloadTicket>(
          `/shares/${id}/download-sessions/refresh`,
          { method: "POST", body: JSON.stringify({ session: value.session }) },
        );
    } else {
      const admission = await localRecordOrCreate(`download-admission:${id}`, {
        token: btoa(
          String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))),
        )
          .replace(/\+/g, "-")
          .replace(/\//g, "_"),
        version: share?.version,
      });
      value = await api<DownloadTicket>(`/shares/${id}/download-sessions`, {
        method: "POST",
        body: JSON.stringify({ request_token: admission.token }),
      });
    }
    if (!value?.session) throw new Error("服务器未提供端到端加密续传会话。");
    await saveLocalRecord(`download-ticket:${id}`, value);
    setTicket(value);
    return value;
  }
  async function receive() {
    if (!context || busy) return;
    setPhase("receiving");
    setError("");
    const controller = new AbortController();
    abort.current = controller;
    const epoch = loadEpoch.current;
    try {
      await stageEncryptedDownload(
        context,
        currentTicket,
        (value) => {
          if (active.current && epoch === loadEpoch.current) setProgress(value);
        },
        controller.signal,
      );
      if (!active.current || epoch !== loadEpoch.current) return;
      setPhase("ready");
      setShare(await api<Share>(`/shares/${id}`));
    } catch (e) {
      if (!active.current || epoch !== loadEpoch.current) return;
      if (!controller.signal.aborted) setError((e as Error).message);
      if (e instanceof ApiError && [401, 410].includes(e.status)) {
        await deleteLocalRecord(`download-ticket:${id}`);
        setTicket(undefined);
        setSessionExpired(true);
        try {
          const latest = await api<Share>(`/shares/${id}`);
          setShare(latest);
          if (latest.locked && latest.encryption?.password_kdf)
            setContext(undefined);
        } catch {
          /* Keep the failed request message. */
        }
      }
      setPhase("idle");
    } finally {
      if (abort.current === controller) abort.current = undefined;
    }
  }
  async function save() {
    if (!context || busy) return;
    setPhase("saving");
    setError("");
    setSavedBytes(0);
    const controller = new AbortController();
    abort.current = controller;
    const epoch = loadEpoch.current;
    try {
      await saveDecryptedDownload(
        context,
        (value) => {
          if (active.current && epoch === loadEpoch.current)
            setSavedBytes(value);
        },
        controller.signal,
      );
      if (!active.current || epoch !== loadEpoch.current) return;
      setPhase("saved");
    } catch (e) {
      if (!active.current || epoch !== loadEpoch.current) return;
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
      setPhase("ready");
    } finally {
      if (abort.current === controller) abort.current = undefined;
    }
  }
  async function clearCache() {
    if (
      !context ||
      !confirm(
        t(
          "清除本机密文续传缓存？已保存的文件和服务器上的分享不会改变。再次下载需要重新传输密文。",
        ),
      )
    )
      return;
    await clearCachedDownload(cacheID(context));
    setProgress({ completedParts: 0, received: 0 });
    setPhase("idle");
  }
  async function newDownloadSession() {
    if (
      !confirm(
        t(
          "原下载会话已失效。建立新会话会再消耗一次下载资格；本机已有密文块会继续使用。是否继续？",
        ),
      )
    )
      return;
    await deleteLocalRecord(`download-admission:${id}`);
    await deleteLocalRecord(`download-ticket:${id}`);
    setTicket(undefined);
    setSessionExpired(false);
    setError("");
    await receive();
  }
  const complete =
    !!context && progress.completedParts === context.encryption.chunk_count;
  const inactive =
    !!share && !["available", "exhausted"].includes(share.availability);
  const canReceive =
    !inactive && (share?.availability === "available" || !!ticket);
  const ratio = context
    ? phase === "saving"
      ? savedBytes / (context.encryption.plain_size || 1)
      : progress.completedParts / context.encryption.chunk_count
    : 0;
  return (
    <div className="receive-card encrypted-receive">
      <div className="symbol">
        <LockKeyhole size={34} aria-hidden="true" />
      </div>
      {!share ? (
        <>
          <h1>
            {phase === "loading" ? t("正在打开加密分享…") : t("无法打开分享")}
          </h1>
        </>
      ) : !secret ? (
        <>
          <h1>{t("链接缺少解密密钥")}</h1>
          <p className="note">
            {t(
              "请向分享者索取完整链接，包含 # 后的全部内容。服务器无法恢复丢失的密钥。",
            )}
          </p>
        </>
      ) : inactive && !complete ? (
        <>
          <h1>{t(availability[share.availability]) || t("分享已失效")}</h1>
          <p className="note">{t("无法继续获取密文，请联系分享者。")}</p>
        </>
      ) : !context && share.encryption?.password_kdf ? (
        <>
          <h1>{t("解锁加密分享")}</h1>
          <p className="note">
            {t("密码与链接密钥共同在此浏览器解密，服务器不会收到解密密钥。")}
          </p>
          <form onSubmit={unlock}>
            <label htmlFor="receive-password">{t("分享密码")}</label>
            <input
              ref={passwordInput}
              id="receive-password"
              name="share-password"
              type="password"
              value={password}
              autoComplete="off"
              required
              disabled={busy}
              aria-invalid={!!unlockError}
              aria-describedby={
                unlockError ? "receive-password-error" : undefined
              }
              onChange={(e) => {
                setPassword(e.target.value);
                setUnlockError("");
              }}
            />
            {t(unlockError) && (
              <p id="receive-password-error" className="alert" role="alert">
                {t(unlockError)}
              </p>
            )}
            <button className="button primary full" disabled={busy}>
              {busy ? (
                <Loader2 className="spin" size={18} />
              ) : (
                <KeyRound size={18} />
              )}
              {busy ? t("正在本机解密…") : t("解锁文件")}
            </button>
          </form>
        </>
      ) : context ? (
        <>
          <h1>{t("接收加密文件")}</h1>
          <p className="filename-title" translate="no">
            {context.metadata.name}
          </p>
          <p className="file-size">{bytes(context.encryption.plain_size)}</p>
          <div className="rule-grid">
            <div>
              <Clock3 size={19} />
              <strong>{date(share.expires)}</strong>
              <span>{t("有效期至")}</span>
            </div>
            <div>
              <ArrowDown size={19} />
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
          {(progress.received > 0 || busy) && (
            <div className="encrypted-progress">
              <div
                className="meter"
                role="progressbar"
                aria-label={
                  phase === "saving" ? t("解密保存进度") : t("密文接收进度")
                }
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.min(100, Math.floor(ratio * 100))}
              >
                <span style={{ transform: `scaleX(${Math.min(1, ratio)})` }} />
              </div>
              <p className="note" role="status">
                {phase === "saving"
                  ? t("正在解密并保存 {0}", bytes(savedBytes))
                  : complete
                    ? t("密文已完整接收，准备保存原文件。")
                    : t(
                        "已接收并校验 {0} 密文，可从完整块继续。",
                        bytes(progress.received),
                      )}
              </p>
            </div>
          )}
          {busy ? (
            <button
              className="button secondary full"
              onClick={() => abort.current?.abort()}
            >
              <Pause size={18} />
              {phase === "saving" ? t("取消保存") : t("暂停接收")}
            </button>
          ) : complete ? (
            <button
              className="button primary full download-button"
              onClick={save}
            >
              <ArrowDown size={20} />
              {phase === "saved" ? t("再次保存解密文件") : t("保存解密文件")}
            </button>
          ) : (
            <button
              className="button primary full download-button"
              onClick={receive}
              disabled={!canReceive || sessionExpired}
            >
              <ArrowDown size={20} />
              {progress.received ? t("继续接收密文") : t("下载文件")}
            </button>
          )}
          {phase === "saved" && (
            <p className="note" role="status">
              {t(
                "解密与 SHA-256 校验已完成。请在浏览器下载列表或所选目录确认保存结果。",
              )}
            </p>
          )}
          <p className="note">
            {t(
              "分块接收密文后，在浏览器校验、解密并流式写入文件。请保持页面打开；刷新后可继续接收，同一有效会话不重复扣次。",
            )}
          </p>
          <p className="note">
            {t(
              "大文件需要足够的本机空间临时保存一份密文，以及保存最终文件的空间。缓存仅存于此浏览器；清理网站数据会移除续传记录。",
            )}
          </p>
          <p className="note">
            {t(
              "浏览器如询问是否允许长期存储，可允许以降低续传缓存被自动清除的风险；暂不回答或拒绝均不阻止本次下载。",
            )}
          </p>
          {progress.received > 0 && (
            <button
              className="text-button"
              onClick={() =>
                void clearCache().catch((e) => setError(e.message))
              }
              disabled={busy}
            >
              <Trash2 size={16} />
              {t("清除本机续传缓存")}
            </button>
          )}
          {sessionExpired &&
            share.availability === "available" &&
            !complete && (
              <button
                className="button secondary full"
                disabled={busy}
                onClick={() =>
                  void newDownloadSession().catch((e) => setError(e.message))
                }
              >
                {t("建立新的下载会话")}
              </button>
            )}
          {!canReceive && !complete && (
            <p className="note">
              {t("下载次数已用完或会话失效，请联系分享者。")}
            </p>
          )}
        </>
      ) : (
        <p className="note">{t("正在本机读取加密信息…")}</p>
      )}
      {error && (
        <p className="alert" role="alert">
          {t(error)}
        </p>
      )}
      <div className="receive-foot">
        <ShieldCheck size={15} />
        {t("端到端加密 · 文件密钥留在浏览器")}
      </div>
    </div>
  );
}
