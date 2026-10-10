export const PASSWORD_PROTOCOL = "client-argon2id-v1";
export type PasswordParameters = {
  scheme: string;
  salt: string;
  memory_kib: number;
  iterations: number;
  parallelism: number;
};
export function passwordSalt(): string {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
  ).replace(/=+$/, "");
}
export async function passwordBody(
  password: string,
  protocol?: string,
  salt = passwordSalt(),
  parameters?: PasswordParameters,
): Promise<Record<string, unknown>> {
  if (!password || protocol !== PASSWORD_PROTOCOL) return { password };
  const length = new TextEncoder().encode(password).length;
  if (length > 256) throw new Error("密码长度最多为 256 字节");
  if (
    !/^[A-Za-z0-9+/]{22}$/.test(salt) ||
    atob(salt).length !== 16 ||
    btoa(atob(salt)).replace(/=+$/, "") !== salt ||
    (parameters &&
      (parameters.scheme !== PASSWORD_PROTOCOL ||
        parameters.memory_kib !== 32768 ||
        parameters.iterations !== 2 ||
        parameters.parallelism !== 1))
  )
    throw new Error("密码保护参数不正确，请重新打开分享");
  const worker = new Worker(new URL("./password.worker.ts", import.meta.url), {
    type: "module",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const key = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("密码处理超时，请重试")),
        120000,
      );
      worker.onmessage = (
        event: MessageEvent<{ key?: string; error?: string }>,
      ) => {
        clearTimeout(timer);
        event.data.key
          ? resolve(event.data.key)
          : reject(new Error(event.data.error || "密码处理失败"));
      };
      worker.onerror = () => {
        clearTimeout(timer);
        reject(new Error("无法加载密码处理模块，请刷新重试"));
      };
      worker.postMessage({ password, salt });
    });
    return { password_proof: { scheme: PASSWORD_PROTOCOL, salt, key } };
  } finally {
    clearTimeout(timer);
    worker.terminate();
  }
}
