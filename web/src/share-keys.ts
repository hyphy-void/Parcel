import type { Share } from "./api";
import { buildShareURL, type FileContext } from "./e2ee";
import { localRecord, saveLocalRecord } from "./transfer-storage";

export function shareContext(id: string): Promise<FileContext | undefined> {
  return localRecord<FileContext>(`share-key:${id}`);
}
export function retainShareContext(
  id: string,
  context: FileContext,
): Promise<void> {
  return saveLocalRecord(`share-key:${id}`, context);
}
export async function localShare(share: Share): Promise<Share> {
  if (!share.encryption)
    return {
      ...share,
      name: "不支持的未加密分享",
      url: "",
      key_available: false,
    };
  // Listing/revoking shares remains possible when browser storage is disabled.
  const context = await shareContext(share.id).catch(() => undefined);
  return {
    ...share,
    name: context?.metadata.name || "加密文件（本机无密钥）",
    size: share.encryption.plain_size,
    url: context ? buildShareURL(share.url, context) : "",
    key_available: !!context,
  };
}
