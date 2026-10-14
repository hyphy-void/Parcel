import { test, expect, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("管理员密码").fill("e2e-admin-password");
  await page.getByRole("button", { name: "登录 Parcel" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test("次数和密码校验说明错误并聚焦字段，不创建上传", async ({ page }) => {
  await login(page);
  await page.goto("/admin/new");
  let uploads = 0;
  await page.route("**/api/v1/uploads", async (route) => {
    uploads++;
    await route.abort();
  });
  await page.getByLabel("选择文件", { exact: true }).setInputFiles({
    name: "validation.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("validation"),
  });
  const limit = page.getByLabel("下载次数", { exact: true });
  await limit.fill("1.5");
  await page.getByLabel("密码保护", { exact: true }).check();
  const password = page.getByLabel("分享密码", { exact: true });
  await password.fill("a");
  const submit = page.getByRole("button", { name: "上传并创建分享" });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(limit).toBeFocused();
  await expect(limit).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#share-limit-error")).toContainText(
    "1 到 100 之间的整数",
  );
  await limit.fill("3");
  await submit.click();
  await expect(password).toBeFocused();
  await expect(password).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert")).toContainText("至少需要 4 字节");
  await password.fill("abcd");
  await expect(password).toHaveAttribute("aria-invalid", "false");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(uploads).toBe(0);
});

test("取消上传可放弃确认，确认前不删除草稿", async ({ page }) => {
  await login(page);
  await page.goto("/admin/new");
  await page.route("**/api/v1/uploads", (route) => route.abort());
  await page.getByLabel("选择文件", { exact: true }).setInputFiles({
    name: "cancel.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("cancel"),
  });
  await page.getByRole("button", { name: "上传并创建分享" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  const draft = await page.evaluate(() =>
    localStorage.getItem("parcel.upload"),
  );
  expect(draft).not.toBeNull();
  let lookups = 0;
  await page.route("**/api/v1/uploads/lookup", async (route) => {
    lookups++;
    await route.fulfill({ status: 404, json: { message: "上传不存在" } });
  });
  const cancel = page.getByRole("button", { name: "取消这次上传" });
  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    await dialog.dismiss();
  });
  await cancel.click();
  expect(await page.evaluate(() => localStorage.getItem("parcel.upload"))).toBe(
    draft,
  );
  expect(lookups).toBe(0);
  page.once("dialog", (dialog) => dialog.accept());
  await cancel.click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("parcel.upload")))
    .toBeNull();
  expect(lookups).toBe(1);
});

test("未提交的分享规则触发离页提示，取消离开保留输入", async ({ page }) => {
  await login(page);
  await page.goto("/admin/new");
  await page.getByLabel("下载次数", { exact: true }).fill("8");
  let warned = false;
  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("beforeunload");
    warned = true;
    await dialog.dismiss();
  });
  await page
    .getByRole("link", { name: "我的分享", exact: true })
    .last()
    .click();
  expect(warned).toBe(true);
  await expect(page).toHaveURL(/\/admin\/new$/);
  await expect(page.getByLabel("下载次数", { exact: true })).toHaveValue("8");
  page.once("dialog", (next) => next.accept());
  await page
    .getByRole("link", { name: "我的分享", exact: true })
    .last()
    .click();
  await expect(page).toHaveURL(/\/admin$/);
});

test("分页链接支持刷新和浏览器返回，保留当前页", async ({ page }) => {
  await page.route("**/api/v1/admin/shares?**", (route) => {
    const current = new URL(route.request().url()).searchParams.get("page");
    return route.fulfill({
      json: {
        items: [
          {
            id: "page-file",
            name: `第 ${current} 页文件`,
            size: 1,
            availability: "available",
            created: 1700000000,
            download_count: 0,
            max_downloads: 3,
          },
        ],
        total: 41,
        cleaned_count: 0,
      },
    });
  });
  await login(page);
  await page.getByRole("link", { name: "下一页", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\?page=2$/);
  await expect(page.getByText("第 2 页文件", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("第 2 页文件", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "上传文件", exact: true }).click();
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\?page=2$/);
  await expect(page.getByText("第 2 页文件", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "上一页", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\?page=1$/);
});

test("修改密码支持提交校验，服务端错误关联字段并恢复焦点", async ({ page }) => {
  await login(page);
  await page.route("**/api/v1/admin/shares/password-test", (route) =>
    route.fulfill({
      json: {
        id: "password-test",
        name: "password.txt",
        size: 1,
        state: "active",
        availability: "available",
        created: 1700000000,
        expires: 9999999999,
        download_count: 0,
        max_downloads: 3,
        password_required: false,
        url: "http://127.0.0.1:18280/s/password-test",
      },
    }),
  );
  let changes = 0;
  await page.route(
    "**/api/v1/admin/shares/password-test/password",
    async (route) => {
      changes++;
      await route.fulfill({
        status: 400,
        json: { message: "密码设置失败，请重试" },
      });
    },
  );
  await page.goto("/admin/shares/password-test");
  const password = page.getByLabel("修改分享密码");
  const save = page.getByRole("button", { name: "保存密码设置" });
  await password.fill("a");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(password).toBeFocused();
  await expect(password).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert")).toContainText("至少需要 4 字节");
  expect(changes).toBe(0);
  await password.fill("abcd");
  await save.click();
  await expect(page.getByRole("alert")).toContainText("密码设置失败，请重试");
  await expect(password).toBeFocused();
  await expect(password).toHaveAttribute(
    "aria-describedby",
    "new-password-error",
  );
  expect(changes).toBe(1);
});
