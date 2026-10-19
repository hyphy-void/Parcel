import { test, expect } from "@playwright/test";

test("不限次数保留有效期和密码，独立下载累计计数且可撤销", async ({
  page,
}, testInfo) => {
  await page.goto("/login");
  await page.getByLabel("管理员密码").fill("e2e-admin-password");
  await page.getByRole("button", { name: "登录 Parcel" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.getByRole("link", { name: "新建分享" }).click();
  await page.getByLabel("选择文件", { exact: true }).setInputFiles({
    name: `unlimited-${testInfo.project.name}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from("unlimited downloads"),
  });
  await page.getByLabel("有效期", { exact: true }).selectOption("3600");
  await page.getByLabel("下载次数", { exact: true }).fill("7");
  await page.getByLabel("不限下载次数", { exact: true }).check();
  await expect(page.getByLabel("下载次数", { exact: true })).toBeDisabled();
  await page.getByLabel("不限下载次数", { exact: true }).uncheck();
  await expect(page.getByLabel("下载次数", { exact: true })).toHaveValue("7");
  await page.getByLabel("不限下载次数", { exact: true }).check();
  await page.getByLabel("密码保护", { exact: true }).check();
  await page.getByLabel("分享密码", { exact: true }).fill("unlimited-password");
  await page.getByRole("button", { name: "上传并创建分享" }).click();
  await expect(
    page.getByRole("heading", { name: "文件已装好，交给对方吧。" }),
  ).toBeVisible();
  await expect(page.getByText("不限次数", { exact: true })).toBeVisible();
  const url = await page.getByLabel("分享链接", { exact: true }).inputValue();
  const id = url.split("/").pop();
  await page.goto(url);
  await expect(
    page.getByRole("heading", { name: "输入密码，打开这份分享。" }),
  ).toBeVisible();
  await page.getByLabel("分享密码", { exact: true }).fill("unlimited-password");
  await page.getByRole("button", { name: "解锁文件", exact: true }).click();
  for (let n = 0; n < 2; n++) {
    await expect(page.getByText("不限次数", { exact: true })).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载文件", exact: true }).click();
    await download;
    // Reload discards the in-page ticket so the next download is a new admission.
    await page.reload();
  }
  const share = await (
    await page.request.get(`/api/v1/admin/shares/${id}`)
  ).json();
  expect(share.max_downloads).toBe(-1);
  expect(share.download_count).toBe(2);
  expect(share.expires - share.created).toBe(3600);
  expect(share.password_required).toBe(true);
  expect(share.availability).toBe("available");
  await page.goto(`/admin/shares/${id}`);
  await expect(page.getByText("2 / 不限次数", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "撤销分享", exact: true }).click();
  await page.getByRole("button", { name: "确认撤销", exact: true }).click();
  await page.goto(url);
  await expect(
    page.getByRole("heading", { name: "已撤销", exact: true }),
  ).toBeVisible();
});
