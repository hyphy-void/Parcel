import { test, expect } from "@playwright/test";

test("清除已清理记录需确认，保留可用分享并显示 R2 保护额度", async ({
  page,
}) => {
  let removed = false,
    deletes = 0;
  const items = [
    {
      id: "active",
      name: "保留的文件.txt",
      size: 3,
      state: "active",
      availability: "available",
      created: 1700000000,
      download_count: 0,
      max_downloads: 3,
    },
    {
      id: "cleaned",
      name: "清理完成的文件.txt",
      size: 3,
      state: "deleted",
      availability: "deleted",
      created: 1700000000,
      download_count: 3,
      max_downloads: 3,
    },
  ];
  await page.route("**/api/v1/admin/status", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      json: {
        ...(await response.json()),
        storage_backend: "r2",
        r2_used_bytes: 1_000_000_000,
        r2_reserved_bytes: 200_000_000,
        r2_available_bytes: 7_800_000_000,
        r2_quota_bytes: 9_000_000_000,
      },
    });
  });
  await page.route("**/api/v1/admin/shares**", async (route) => {
    if (route.request().method() === "DELETE") {
      expect(route.request().url()).toContain("/shares/cleaned");
      expect(route.request().headers()["x-csrf-token"]).toBeTruthy();
      deletes++;
      removed = true;
      await route.fulfill({ json: { removed: 1 } });
    } else
      await route.fulfill({
        json: {
          items: removed ? [items[0]] : items,
          total: removed ? 1 : 2,
          cleaned_count: removed ? 0 : 1,
        },
      });
  });
  await page.goto("/login");
  await page.getByLabel("管理员密码").fill("e2e-admin-password");
  await page.getByRole("button", { name: "登录 Parcel" }).click();
  await expect(page.getByText("R2 存储额度", { exact: true })).toBeVisible();
  await expect(page.getByText("/ 9.00 GB", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "清除已清理", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("清除 1 条已清理记录");
  expect(deletes).toBe(0);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  expect(deletes).toBe(0);
  await page.getByRole("button", { name: "清除已清理", exact: true }).click();
  await page.getByRole("button", { name: "确认清除", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已清除 1 条");
  await expect(page.getByRole("link", { name: /保留的文件/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /清理完成/ })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "清除已清理", exact: true }),
  ).toBeDisabled();
  expect(deletes).toBe(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
