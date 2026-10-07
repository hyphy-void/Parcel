export type Upload = {
  id: string;
  name: string;
  size: number;
  offset: number;
  state: string;
  share_id: string;
  ttl_seconds: number;
  max_downloads: number;
  error: string;
};
export type Share = {
  id: string;
  name?: string;
  size?: number;
  sha256?: string;
  created: number;
  expires: number;
  max_downloads: number;
  download_count: number;
  state: string;
  error: string;
  password_required: boolean;
  locked?: boolean;
  availability: string;
  url: string;
};
export type Status = {
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
  });
  const data = await response.json();
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
