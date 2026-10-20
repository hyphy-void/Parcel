import { runCryptoTask, type CryptoTask } from "./e2ee.tasks";

self.onmessage = async (event: MessageEvent<CryptoTask>) => {
  try {
    const value = await runCryptoTask(event.data, (progress) => {
      self.postMessage({ progress });
    });
    self.postMessage({ value });
  } catch {
    self.postMessage({ error: "本地加密准备失败，请重试" });
  }
};
