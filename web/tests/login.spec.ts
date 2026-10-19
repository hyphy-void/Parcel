import { test, expect } from "@playwright/test";

test("密码输入反馈、验证中状态与错误恢复", async ({ page }) => {
  await page.goto("/login");
  const password = page.getByLabel("管理员密码");
  const envelope = page.locator(".login-envelope-motion");
  const storyCaption = page.locator(".login-visual-status");
  await expect(storyCaption).toHaveText("文件分享，从这里开始。");
  await expect(envelope).toBeVisible();
  await password.fill("incorrect-password");
  expect(
    await envelope.evaluate((el) => el.getAnimations().length),
  ).toBeGreaterThan(0);
  await expect(password).toHaveAttribute("type", "password");
  await expect(storyCaption).toHaveText("文件分享，从这里开始。");
  await page.route("**/api/v1/auth/login", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ message: "管理员密码不正确" }),
    });
  });
  await page.getByRole("button", { name: "登录 Parcel" }).click();
  await expect(page.getByRole("button", { name: "正在登录…" })).toBeDisabled();
  await expect(password).toBeDisabled();
  await expect(storyCaption).toHaveText("文件分享，从这里开始。");
  await expect(page.getByRole("alert")).toHaveText("管理员密码不正确");
  await expect(password).toHaveAttribute("aria-invalid", "true");
  await expect(password).toBeFocused();
  await expect(storyCaption).toHaveText("文件分享，从这里开始。");
  await password.fill("try-again");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(password).toHaveAttribute("aria-invalid", "false");
});

test("减少动态效果时保持静止，深色模式仍可使用", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.goto("/login");
  const password = page.getByLabel("管理员密码");
  await password.fill("example-password");
  expect(
    await page
      .locator(".login-envelope-motion")
      .evaluate((el) => getComputedStyle(el).transform),
  ).toBe("none");
  expect(
    await page
      .locator(".login-envelope-motion")
      .evaluate((el) => el.getAnimations().length),
  ).toBe(0);
  await expect(page.getByRole("button", { name: "登录 Parcel" })).toBeEnabled();
  expect(
    await page
      .locator(".login-app")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe("rgb(24, 27, 24)");
});
