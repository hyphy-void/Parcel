import { test, expect } from "@playwright/test";

async function login(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("管理员密码").fill("e2e-admin-password");
  await page.getByRole("button", { name: "登录 Parcel" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

function contrast(a: string, b: string) {
  const luminance = (color: string) => {
    const components = color
      .match(/[\d.]+/g)!
      .slice(0, 3)
      .map((v) => {
        const c = Number(v) / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
    return components.reduce(
      (sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i],
      0,
    );
  };
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test("窄屏不抢焦点，键盘选择文件具有可见焦点", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await expect(page.getByLabel("管理员密码")).not.toBeFocused();
  await expect(page.getByLabel("管理员密码")).toHaveAttribute(
    "name",
    "password",
  );
  await login(page);
  await page.goto("/admin/new");
  const back = page.getByRole("link", { name: "我的分享", exact: true }).last();
  await back.focus();
  await page.keyboard.press("Tab");
  const choose = page.getByRole("button", { name: "选择要分享的文件" });
  await expect(choose).toBeFocused();
  await expect(choose).toBeVisible();
  expect(
    await choose.evaluate((el) => getComputedStyle(el).outlineStyle),
  ).not.toBe("none");
});

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}主题贯穿登录、上传、发布、详情与接收页`, async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/login");
    await page.locator("h1").click();
    const styles = await page.getByLabel("管理员密码").evaluate((el) => {
      const input = getComputedStyle(el);
      const surface = getComputedStyle(el.closest(".login-layout")!);
      return {
        border: input.borderTopColor,
        foreground: input.color,
        surface: surface.backgroundColor,
      };
    });
    expect(contrast(styles.border, styles.surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(styles.foreground, styles.surface)).toBeGreaterThanOrEqual(
      4.5,
    );
    const background = await page.evaluate(
      () => getComputedStyle(document.documentElement).backgroundColor,
    );
    const assertTheme = async () => {
      expect(
        await page.evaluate(
          () => getComputedStyle(document.documentElement).colorScheme,
        ),
      ).toBe(scheme);
      expect(
        await page.evaluate(
          () => getComputedStyle(document.documentElement).backgroundColor,
        ),
      ).toBe(background);
      const matchingMeta = await page.evaluate(
        () =>
          [
            ...document.querySelectorAll<HTMLMetaElement>(
              'meta[name="theme-color"]',
            ),
          ].find((el) => matchMedia(el.media).matches)?.content,
      );
      expect(matchingMeta).toBe(scheme === "dark" ? "#201d27" : "#f6f5fa");
      for (const panel of await page
        .locator(".panel, .success-card, .receive-card")
        .all()) {
        const colors = await panel.evaluate((el) => ({
          background: getComputedStyle(el).backgroundColor,
          text: getComputedStyle(el).color,
        }));
        expect(contrast(colors.text, colors.background)).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    };
    await assertTheme();
    await login(page);
    await page.getByRole("heading", { name: "分享记录" }).waitFor();
    await assertTheme();
    await page.goto("/admin/new");
    await page.getByLabel("有效期").waitFor();
    await assertTheme();
    const selectColors = await page.getByLabel("有效期").evaluate((el) => ({
      text: getComputedStyle(el).color,
      background: getComputedStyle(el).backgroundColor,
    }));
    expect(
      contrast(selectColors.text, selectColors.background),
    ).toBeGreaterThanOrEqual(4.5);
    await page.getByLabel("选择文件", { exact: true }).setInputFiles({
      name: `theme-${scheme}-${testInfo.project.name}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from("theme accessibility check"),
    });
    await page.getByRole("button", { name: "上传并创建分享" }).click();
    await page
      .getByRole("heading", { name: "文件已装好，交给对方吧。" })
      .waitFor();
    await assertTheme();
    const receiveUrl = await page
      .getByLabel("分享链接", { exact: true })
      .inputValue();
    await page.getByRole("link", { name: "查看分享详情" }).click();
    await page.getByRole("heading", { name: "管理分享" }).waitFor();
    await assertTheme();
    await page.goto(receiveUrl);
    await page.getByRole("button", { name: "下载文件", exact: true }).waitFor();
    await assertTheme();
  });
}
