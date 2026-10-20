import { test, expect, type Page } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.route("**/api/v1/auth-config", (route) =>
    route.fulfill({
      json: {
        auth_mode: "totp",
        initialized: true,
        password_protocol: "sha256-v1",
      },
    }),
  );
  await context.route("**/api/v1/auth/session", (route) =>
    route.fulfill({
      json: { csrf: "test-csrf", auth_mode: "totp" },
    }),
  );
  await context.route("**/api/v1/admin/status", (route) =>
    route.fulfill({
      json: {
        storage_backend: "local",
        used_bytes: 0,
        reserved_bytes: 0,
        pending_bytes: 0,
        free_bytes: 1e9,
        quota_bytes: 1e9,
        max_file_bytes: 1024,
        default_ttl_seconds: 86400,
        max_ttl_seconds: 604800,
        default_download_limit: 3,
        version: "test",
      },
    }),
  );
  await context.route("**/api/v1/admin/shares?**", (route) =>
    route.fulfill({
      json: { items: [], total: 0, cleaned_count: 2 },
    }),
  );
});

async function english(page: Page) {
  await page
    .getByRole("button", { name: "Switch to English", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}

test("language persists through reload, navigation, and another tab", async ({
  page,
  context,
}) => {
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "我的分享", exact: true }),
  ).toBeVisible();
  await english(page);
  await expect(
    page.getByRole("heading", { name: "My shares", exact: true }),
  ).toBeVisible();
  await noOverflow(page);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "My shares", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Upload file", exact: true })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "New share" })).toBeVisible();
  await expect(page).toHaveTitle("Parcel · Temporary file sharing");
  const second = await context.newPage();
  await second.goto("/login");
  await expect(
    second.getByLabel("Admin password", { exact: true }),
  ).toBeVisible();
  await second.getByRole("button", { name: "切换到中文", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("heading", { name: "新建分享" })).toBeVisible();
  await noOverflow(page);
});

test("switching preserves the selected file, rules, password, and validation", async ({
  page,
}, testInfo) => {
  await page.goto("/admin/new");
  const file = page.getByLabel("选择文件", { exact: true });
  await file.setInputFiles({
    name: "中文文件.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello"),
  });
  await page.getByLabel("下载次数", { exact: true }).fill("1.5");
  await page.getByLabel("密码保护", { exact: true }).check();
  await page.getByLabel("分享密码", { exact: true }).fill("keep-this-password");
  await page
    .getByRole("button", { name: "上传并创建分享", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("1 到 100 之间的整数");
  await english(page);
  await expect(page.getByRole("alert")).toContainText(
    "whole number between 1 and 100",
  );
  await expect(page.getByLabel("Download limit", { exact: true })).toHaveValue(
    "1.5",
  );
  await expect(page.getByLabel("Share password", { exact: true })).toHaveValue(
    "keep-this-password",
  );
  await expect(
    page.getByLabel("Password protection", { exact: true }),
  ).toBeChecked();
  expect(
    await page
      .getByLabel("Choose file", { exact: true })
      .evaluate((input: HTMLInputElement) => input.files?.[0].name),
  ).toBe("中文文件.txt");
  await noOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("upload-english.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "切换到中文", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("1 到 100 之间的整数");
});

test("dynamic size errors and native confirmation use the selected language", async ({
  page,
}) => {
  await page.goto("/admin/new");
  await page.getByLabel("选择文件", { exact: true }).setInputFiles({
    name: "large.txt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(2048),
  });
  await expect(page.getByRole("alert")).toContainText("单文件不能超过");
  await english(page);
  await expect(page.getByRole("alert")).toContainText(
    "A single file cannot exceed",
  );
  await page.getByLabel("Choose file", { exact: true }).setInputFiles({
    name: "resume.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("resume"),
  });
  await page.route("**/api/v1/uploads", (route) =>
    route.fulfill({
      status: 503,
      json: { code: "busy", message: "密码验证繁忙，请稍后重试" },
    }),
  );
  await page
    .getByRole("button", { name: "Upload and create share", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Password verification is busy",
  );
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Cancel this upload?");
    await dialog.dismiss();
  });
  await page
    .getByRole("button", { name: "Cancel this upload", exact: true })
    .click();
});

test("login fields survive switching and blocked storage still permits switching", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Blocked", "SecurityError");
    };
  });
  await page.goto("/login");
  await page
    .getByLabel("管理员密码", { exact: true })
    .fill("keep-login-password");
  await english(page);
  await expect(page.getByLabel("Admin password", { exact: true })).toHaveValue(
    "keep-login-password",
  );
  await noOverflow(page);
  await page.getByRole("button", { name: "切换到中文", exact: true }).click();
  await expect(page.getByLabel("管理员密码", { exact: true })).toHaveValue(
    "keep-login-password",
  );
});

test("share status, dated records, cleanup notices, and security settings switch together", async ({
  page,
}) => {
  await page.route("**/api/v1/admin/shares?**", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: "language-test",
            name: "original.txt",
            size: 5,
            availability: "expired",
            created: 1699963200,
            download_count: 1,
            max_downloads: 3,
            password_required: false,
          },
        ],
        total: 1,
        cleaned_count: 2,
      },
    }),
  );
  await page.goto("/admin");
  await english(page);
  await expect(page.getByText("Expired", { exact: true })).toBeVisible();
  await expect(page.getByText("Nov 14", { exact: false })).toBeVisible();
  await page
    .getByRole("button", { name: "Clear cleaned-up records", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Clear 2 cleaned-up records?",
  );
  await page.route("**/api/v1/admin/shares/cleaned", (route) =>
    route.fulfill({ json: { removed: 2 } }),
  );
  await page
    .getByRole("button", { name: "Confirm removal", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Removed 2 cleaned-up records.",
  );
  await page.getByRole("button", { name: "切换到中文", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "已清除 2 条已清理记录。",
  );
  await english(page);
  await page.getByRole("link", { name: "Login security", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Replace authenticator", exact: true }),
  ).toBeVisible();
  await noOverflow(page);
});
