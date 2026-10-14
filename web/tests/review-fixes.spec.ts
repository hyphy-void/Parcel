import { test, expect, type Page } from "@playwright/test";

async function newShare(page: Page) {
  await page.goto("/login");
  await page.getByLabel("管理员密码").fill("e2e-admin-password");
  await page.getByRole("button", { name: "登录 Parcel" }).click();
  await page.getByRole("link", { name: "新建分享" }).click();
}

test("创建被配额拒绝后清除草稿，允许换选更小文件", async ({ page }) => {
  await newShare(page);
  await page.route("**/api/v1/uploads", (route) =>
    route.fulfill({
      status: 507,
      json: { code: "r2_quota_exceeded", message: "R2 配额不足" },
    }),
  );
  await page.getByLabel("选择文件", { exact: true }).setInputFiles({
    name: "original.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("original"),
  });
  await page.getByRole("button", { name: "上传并创建分享" }).click();
  await expect(page.getByRole("alert")).toContainText("R2 配额不足");
  expect(
    await page.evaluate(() => localStorage.getItem("parcel.upload")),
  ).toBeNull();
  await page.getByLabel("选择文件", { exact: true }).setInputFiles({
    name: "smaller.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("x"),
  });
  await expect(page.getByText("smaller.bin", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("恢复不存在的上传草稿时解除文件选择限制", async ({ page }) => {
  await newShare(page);
  await page.evaluate(() =>
    localStorage.setItem(
      "parcel.upload",
      JSON.stringify({
        key: "missing-draft",
        name: "original.bin",
        size: 8,
        modified: 0,
      }),
    ),
  );
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("parcel.upload")))
    .toBeNull();
  await page.getByLabel("选择文件", { exact: true }).setInputFiles({
    name: "different.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("x"),
  });
  await expect(page.getByText("different.bin", { exact: true })).toBeVisible();
});

test("创建结果不确定时可通过取消入口查询并丢弃不存在的草稿", async ({
  page,
}) => {
  await newShare(page);
  await page.route("**/api/v1/uploads", (route) => route.abort("failed"));
  await page.getByLabel("选择文件", { exact: true }).setInputFiles({
    name: "uncertain.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("x"),
  });
  await page.getByRole("button", { name: "上传并创建分享" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("parcel.upload")),
  ).not.toBeNull();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "取消这次上传" }).click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("parcel.upload")))
    .toBeNull();
  await expect(
    page.getByRole("button", { name: "上传并创建分享" }),
  ).toBeDisabled();
});

for (const status of [409, 503]) {
  test(`发布期间取消返回 ${status} 后可恢复结果或继续查询`, async ({
    page,
  }) => {
    let canceled = false;
    const upload = {
      id: "cancel-race",
      name: "race.bin",
      size: 3,
      offset: 3,
      storage_backend: "r2",
      part_bytes: 0,
      state: "finalizing",
      share_id: "race-share",
      ttl_seconds: 3600,
      max_downloads: 3,
      error: "",
    };
    await page.route("**/api/v1/uploads/cancel-race", (route) => {
      if (route.request().method() === "DELETE") {
        canceled = true;
        return route.fulfill({
          status,
          json: {
            code: status === 409 ? "already_published" : "busy",
            message: status === 409 ? "文件已发布，请撤销分享" : "取消暂时失败",
          },
        });
      }
      return route.fulfill({
        json: {
          ...upload,
          state: canceled && status === 409 ? "completed" : "finalizing",
        },
      });
    });
    await page.route("**/api/v1/admin/shares/race-share", (route) =>
      route.fulfill({
        json: {
          id: "race-share",
          name: "race.bin",
          size: 3,
          url: "http://127.0.0.1:18280/s/race-share",
          expires: 9999999999,
          max_downloads: 3,
        },
      }),
    );
    await newShare(page);
    await page.evaluate(
      (u) =>
        localStorage.setItem(
          "parcel.upload",
          JSON.stringify({
            id: u.id,
            name: u.name,
            size: u.size,
            modified: 0,
          }),
        ),
      upload,
    );
    await page.reload();
    await expect(
      page.getByRole("button", { name: "正在完成上传", exact: true }),
    ).toBeDisabled();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "取消这次上传" }).click();
    if (status === 409) {
      await expect(
        page.getByRole("heading", { name: "文件已装好，交给对方吧。" }),
      ).toBeVisible();
      expect(
        await page.evaluate(() => localStorage.getItem("parcel.upload")),
      ).toBeNull();
    } else {
      await expect(page.getByRole("alert")).toContainText("取消暂时失败");
      await expect(
        page.getByRole("button", { name: "查询发布结果" }),
      ).toBeEnabled();
    }
  });
}
