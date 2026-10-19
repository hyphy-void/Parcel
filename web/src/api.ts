import type { PasswordParameters } from "./password";
export type Upload = {
  storage_backend: "local" | "r2";
  part_bytes: number;
  object_uploaded?: boolean;
  parts?: { number: number; size: number; etag: string }[];
  id: string;
  name: string;
  size: number;
  offset: number;
  state: string;
  share_id: string;
  ttl_seconds: number;
  max_downloads: number; // -1 means unlimited downloads.
  error: string;
};
export type Share = {
  storage_backend?: "local" | "r2";
  etag?: string;
  id: string;
  name?: string;
  size?: number;
  sha256?: string;
  created: number;
  expires: number;
  max_downloads: number; // -1 means unlimited downloads.
  download_count: number;
  state: string;
  error: string;
  password_required: boolean;
  password_protocol?: string;
  password_kdf?: PasswordParameters;
  locked?: boolean;
  availability: string;
  url: string;
};
export type Status = {
  backend_mode?: "serverless";
  password_protocol?: string;
  r2_used_bytes: number;
  r2_reserved_bytes: number;
  r2_quota_bytes: number;
  r2_available_bytes: number;
  storage_backend: "local" | "r2";
  upload_confirmation_bytes: number;
  used_bytes: number;
  reserved_bytes: number;
  pending_bytes: number;
  free_bytes: number;
  quota_bytes: number;
  min_free_bytes: number;
  max_file_bytes: number;
  chunk_bytes: number;
  default_ttl_seconds: number;
  max_ttl_seconds: number;
  default_download_limit: number;
  version: string;
  base_url: string;
};
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
  csrf = "",
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  if (csrf) headers.set("X-CSRF-Token", csrf);
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers,
    credentials: "same-origin",
    redirect: "manual",
  });
  if (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  ) {
    if (path !== "/auth/session" && /^\/(auth|admin|uploads)(\/|$)/.test(path))
      location.assign("/login");
    throw new ApiError("登录已失效，请重新验证身份", 401, "access_required");
  }
  if (!response.headers.get("Content-Type")?.includes("application/json"))
    throw new ApiError(
      "服务响应不正确，请稍后重试",
      response.status || 502,
      "invalid_response",
    );
  const data = await response.json();
  if (
    response.status === 401 &&
    data.code === "access_required" &&
    path !== "/auth/session" &&
    /^\/(auth|admin|uploads)(\/|$)/.test(path)
  )
    location.assign("/login");
  if (!response.ok)
    throw new ApiError(
      data.message || "请求失败，请重试",
      response.status,
      data.code,
    );
  return data as T;
}
export function bytes(n = 0): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let x = n / 1024,
    i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x.toFixed(x >= 10 ? 1 : 2)} ${units[i]}`;
}
export function date(n: number): string {
  return new Date(n * 1000).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
export function randomPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (n) => alphabet[n % alphabet.length]).join("");
}
export function randomShareCode(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const cutoff = 256 - (256 % alphabet.length);
  let code = "";
  while (code.length < 4) {
    for (const n of crypto.getRandomValues(new Uint8Array(8))) {
      if (n < cutoff) code += alphabet[n % alphabet.length];
      if (code.length === 4) break;
    }
  }
  return code;
}
export const availability: Record<string, string> = {
  available: "可下载",
  expired: "已过期",
  exhausted: "次数已用完",
  revoked: "已撤销",
  deleting: "等待清理",
  deleted: "已清理",
  missing: "文件不可用",
};

export type DownloadTicket = {
  url: string;
  expires: number;
  session?: string;
  session_expires?: number;
  max_ttl_seconds: number;
};
