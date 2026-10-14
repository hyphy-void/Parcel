import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

test("上传、密码解锁、原生下载与撤销形成完整闭环", async ({
  page,
  browser,
}, testInfo) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async () => {},
    }),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/login");
  await expect(
    page.getByRole("heading", { name: "让文件轻装上路。" }),
  ).toBeVisible();
  await page.getByLabel("管理员密码").fill("e2e-admin-password");
  await page.getByRole("button", { name: "登录 Parcel" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.getByRole("link", { name: "新建分享" }).click();
  const filename = `中文分享-${testInfo.project.name}.txt`;
  const payload = Buffer.from("Parcel browser acceptance\n你好，文件分享！");
  await page
    .getByLabel("选择文件", { exact: true })
    .setInputFiles({ name: filename, mimeType: "text/plain", buffer: payload });
  await page.getByLabel("密码保护", { exact: true }).check();
  const codeInput = page.getByLabel("分享密码", { exact: true });
  await expect(codeInput).toHaveValue(/^[a-z2-9]{4}$/);
  await page.getByRole("button", { name: "换一个", exact: true }).click();
  await expect(codeInput).toHaveValue(/^[a-z2-9]{4}$/);
  const code = await codeInput.inputValue();
  await page.getByLabel("下载次数", { exact: true }).fill("1");
  await page.getByRole("button", { name: "上传并创建分享" }).click();
  await expect(
    page.getByRole("heading", { name: "文件已装好，交给对方吧。" }),
  ).toBeVisible();
  const url = await page.getByLabel("分享链接", { exact: true }).inputValue();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    const probe = document.createElement("textarea");
    probe.id = "protected-copy-probe";
    probe.style.cssText =
      "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0";
    document.querySelector("main")!.appendChild(probe);
  });
  await page.getByRole("button", { name: "复制分享链接" }).click();
  const copyProbe = page.locator("#protected-copy-probe");
  await copyProbe.focus();
  await page.keyboard.press("Control+V");
  await expect(copyProbe).toHaveValue(url);
  await expect(page.getByRole("button", { name: "复制分享链接" })).toHaveText(
    "",
  );
  await page.getByRole("button", { name: "分享", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "分享文件" });
  const message = `我用 Parcel 分享了「${filename}」\n链接：${url}\n提取码：${code}`;
  await expect(dialog.getByLabel("分享文案")).toHaveValue(message);
  await dialog.getByRole("button", { name: "复制分享文案" }).click();
  await expect(dialog.getByRole("status")).toContainText("分享文案已复制");
  await page.screenshot({
    path: testInfo.outputPath("share-message-light.png"),
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector(".share-dialog .secondary")!)
        .backgroundColor ===
      getComputedStyle(document.querySelector(".share-dialog")!)
        .backgroundColor,
  );
  await page.screenshot({
    path: testInfo.outputPath("share-message-dark.png"),
  });
  await page.emulateMedia({ colorScheme: "light" });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "分享", exact: true }),
  ).toBeFocused();
  await copyProbe.fill("");
  await copyProbe.focus();
  await page.keyboard.press("Control+V");
  await expect(copyProbe).toHaveValue(message);
  await copyProbe.evaluate((node) => node.remove());
  await page.screenshot({
    path: testInfo.outputPath("published.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "查看分享详情" }).click();
  await page.getByRole("button", { name: "分享", exact: true }).click();
  await expect(dialog.getByText(/无法读取原提取码/)).toBeVisible();
  await expect(dialog.getByLabel("分享文案")).toHaveValue(
    `我用 Parcel 分享了「${filename}」\n链接：${url}\n提取码：请向分享者获取`,
  );
  await page.keyboard.press("Escape");
  const recipient = await browser.newContext(
    testInfo.project.name === "mobile-chromium"
      ? { viewport: { width: 390, height: 844 }, isMobile: true }
      : {},
  );
  const receive = await recipient.newPage();
  receive.on("pageerror", (error) => errors.push(error.message));
  await receive.goto(url);
  await expect(
    receive.getByRole("heading", { name: "输入密码，打开这份分享。" }),
  ).toBeVisible();
  await expect(receive.getByText(filename, { exact: true })).toHaveCount(0);
  await receive.getByLabel("分享密码").fill("wrong-password");
  await receive.getByRole("button", { name: "解锁文件" }).click();
  await expect(receive.getByRole("alert")).toContainText("分享密码不正确");
  await expect(receive.getByLabel("分享密码")).toBeFocused();
  await expect(receive.getByLabel("分享密码")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(receive.getByLabel("分享密码")).toHaveAttribute(
    "aria-describedby",
    "receive-password-error",
  );
  await receive.getByLabel("分享密码").fill(code);
  await receive.getByRole("button", { name: "解锁文件" }).click();
  await expect(receive.getByRole("heading", { name: filename })).toBeVisible();
  const [download] = await Promise.all([
    receive.waitForEvent("download"),
    receive.getByRole("button", { name: "下载文件", exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(filename);
  const saved = await download.path();
  expect(readFileSync(saved!)).toEqual(payload);
  await expect(
    receive.getByRole("button", { name: "再次下载 / 继续" }),
  ).toBeVisible();
  const [again] = await Promise.all([
    receive.waitForEvent("download"),
    receive.getByRole("button", { name: "再次下载 / 继续" }).click(),
  ]);
  expect(readFileSync((await again.path())!)).toEqual(payload);
  await page.reload();
  await expect(page.getByText("1 / 1", { exact: true })).toBeVisible();
  await receive.screenshot({
    path: testInfo.outputPath("receive.png"),
    fullPage: true,
  });
  await page.getByLabel("修改分享密码").fill("updated7");
  await page.getByRole("button", { name: "保存密码" }).click();
  await expect(
    page.getByText("密码已更新，旧授权已失效。分享文案会附上新提取码。"),
  ).toBeVisible();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (data: ShareData) => {
        (window as any).__shared = data;
      },
    }),
  );
  await page.getByRole("button", { name: "分享", exact: true }).click();
  await expect(dialog.getByLabel("分享文案")).toHaveValue(
    `我用 Parcel 分享了「${filename}」\n链接：${url}\n提取码：updated7`,
  );
  await dialog.getByRole("button", { name: "系统分享" }).click();
  expect(await page.evaluate(() => (window as any).__shared)).toEqual({
    title: filename,
    text: `我用 Parcel 分享了「${filename}」\n链接：${url}\n提取码：updated7`,
  });
  await page.evaluate(() =>
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async () => {
        throw new DOMException("Canceled", "AbortError");
      },
    }),
  );
  await dialog.getByRole("button", { name: "系统分享" }).click();
  await expect(dialog.getByRole("status")).toBeEmpty();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async () => {
        throw new DOMException("Denied", "NotAllowedError");
      },
    }),
  );
  await dialog.getByRole("button", { name: "系统分享" }).click();
  await expect(dialog.getByRole("status")).toContainText("请复制文案后发送");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "撤销分享", exact: true }).click();
  await page.getByRole("button", { name: "确认撤销", exact: true }).click();
  await receive.reload();
  await expect(
    receive.getByRole("heading", { name: /已撤销|等待清理|已清理/ }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  await recipient.close();
});

test("HTTP 兼容复制写入真实剪贴板，全部被拒时才提示手动复制", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("管理员密码").fill("e2e-admin-password");
  await page.getByRole("button", { name: "登录 Parcel" }).click();
  await page.getByRole("link", { name: "新建分享" }).click();
  await page.getByLabel("选择文件", { exact: true }).setInputFiles({
    name: "empty.txt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(0),
  });
  await page.getByRole("button", { name: "上传并创建分享" }).click();
  await expect(
    page.getByRole("heading", { name: "文件已装好，交给对方吧。" }),
  ).toBeVisible();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    }),
  );
  const link = await page.getByLabel("分享链接", { exact: true }).inputValue();
  await page.evaluate(() => {
    const probe = document.createElement("input");
    probe.id = "clipboard-paste-probe";
    document.querySelector("main")!.appendChild(probe);
  });
  const probe = page.locator("#clipboard-paste-probe");
  const copy = page.getByRole("button", { name: "复制分享链接" });
  await copy.click();
  await expect(copy).toHaveText("");
  await probe.focus();
  await page.keyboard.press("Control+V");
  await expect(probe).toHaveValue(link);
  await expect(page.getByRole("status")).toHaveText("分享链接已复制。");

  // A denied modern API must also fall back to an actual clipboard write.
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: () =>
          Promise.reject(new DOMException("Denied", "NotAllowedError")),
      },
      configurable: true,
    }),
  );
  await probe.fill("");
  await copy.click();
  await expect(copy).toHaveText("");
  await probe.focus();
  await page.keyboard.press("Control+V");
  await expect(probe).toHaveValue(link);

  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    document.execCommand = () => false;
  });
  await page.getByRole("button", { name: "复制分享链接" }).click();
  await expect(page.getByRole("status")).toContainText("链接已选中");
  await expect(copy).toHaveText("");
  expect(
    await page.getByLabel("分享链接", { exact: true }).evaluate((node) => {
      const input = node as HTMLInputElement;
      return [input.selectionStart, input.selectionEnd];
    }),
  ).toEqual([0, link.length]);
  await page.getByRole("button", { name: "分享", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "分享文件" });
  await expect(dialog.getByLabel("分享文案")).toHaveValue(
    `我用 Parcel 分享了「empty.txt」\n链接：${link}`,
  );
  await dialog.getByRole("button", { name: "复制分享文案" }).click();
  await expect(dialog.getByRole("status")).toContainText("分享文案已选中");
  expect(
    await dialog.getByLabel("分享文案").evaluate((node) => {
      const input = node as HTMLTextAreaElement;
      return input.selectionEnd - input.selectionStart === input.value.length;
    }),
  ).toBe(true);
});

test("创建回复丢失后刷新可以找回原上传，不重复预留空间", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("管理员密码").fill("e2e-admin-password");
  await page.getByRole("button", { name: "登录 Parcel" }).click();
  await page.getByRole("link", { name: "新建分享" }).click();
  const file = {
    name: "恢复上传.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("resume after a lost creation response"),
  };
  await page.getByLabel("选择文件", { exact: true }).setInputFiles(file);
  let lost = false;
  await page.route("**/api/v1/uploads", async (route) => {
    if (!lost && route.request().method() === "POST") {
      lost = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "上传并创建分享" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.reload();
  await expect(page.getByText("上传已暂停", { exact: true })).toBeVisible();
  // Playwright-created files have a new lastModified each time; use the real cached one.
  const metadata = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("parcel.upload")!),
  );
  await page.evaluate(
    ({ name, modified, contents }) => {
      const input = document.querySelector(
        "input[type=file]",
      ) as HTMLInputElement;
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([contents], name, {
          type: "text/plain",
          lastModified: modified,
        }),
      );
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    {
      name: file.name,
      modified: metadata.modified,
      contents: file.buffer.toString(),
    },
  );
  await page.getByRole("button", { name: "继续上传" }).click();
  await expect(
    page.getByRole("heading", { name: "文件已装好，交给对方吧。" }),
  ).toBeVisible();
  const state = await page.request.get("/api/v1/admin/status");
  expect((await state.json()).reserved_bytes).toBe(0);
});

test("分块上传暂停后从确认位置继续，取消后不被旧请求恢复", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("管理员密码").fill("e2e-admin-password");
  await page.getByRole("button", { name: "登录 Parcel" }).click();
  await page.getByRole("link", { name: "新建分享" }).click();
  const file = {
    name: "分块验收.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(20 << 20, 0x37),
  };
  let delay = true,
    reached!: () => void;
  let waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  await page.route("**/api/v1/uploads/*", async (route) => {
    if (
      route.request().method() === "PATCH" &&
      route.request().headers()["upload-offset"] === String(8 << 20) &&
      delay
    ) {
      delay = false;
      reached();
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    try {
      await route.continue();
    } catch {
      /* The paused or canceled XHR may already be gone. */
    }
  });
  await page.getByLabel("选择文件", { exact: true }).setInputFiles(file);
  await page.getByRole("button", { name: "上传并创建分享" }).click();
  await waiting;
  await page.getByRole("button", { name: "暂停上传" }).click();
  await expect(page.getByText("上传已暂停", { exact: true })).toBeVisible();
  const cached = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("parcel.upload")!),
  );
  const current = await page.request.get(`/api/v1/uploads/${cached.id}`);
  expect((await current.json()).offset).toBe(8 << 20);
  await page.getByRole("button", { name: "继续上传" }).click();
  await expect(
    page.getByRole("heading", { name: "文件已装好，交给对方吧。" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "返回我的分享" }).click();
  await page.getByRole("link", { name: "新建分享" }).click();
  delay = true;
  waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  await page.getByLabel("选择文件", { exact: true }).setInputFiles(file);
  await page.getByRole("button", { name: "上传并创建分享" }).click();
  await waiting;
  const canceled = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("parcel.upload")!),
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "取消这次上传" }).click();
  await expect(
    page.getByRole("button", { name: "上传并创建分享" }),
  ).toBeVisible();
  await page.waitForTimeout(1800);
  expect(
    await page.evaluate(() => localStorage.getItem("parcel.upload")),
  ).toBeNull();
  const stopped = await page.request.get(`/api/v1/uploads/${canceled.id}`);
  expect(["canceled", "cleaned"]).toContain((await stopped.json()).state);
});
