import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Opt-in only: an operator supplies a short-lived admin session in a 0600
// file and cleans up the generated share. Never record auth, URLs, or traces.
const authPath = process.env.PARCEL_PRODUCTION_BROWSER_AUTH;
test.use({ trace: "off" });
test("公网完整前端上传 93607928 字节一次成功", async ({ page, context }) => {
  test.skip(!authPath, "requires explicitly supplied production probe session");
  test.setTimeout(180000);
  const auth = JSON.parse(readFileSync(authPath!, "utf8"));
  const origin = "https://parcel.playereconlab.com";
  await context.addCookies([
    {
      name: "parcel_admin",
      value: auth.token,
      url: origin,
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      expires: auth.expires,
    },
  ]);
  let puts = 0;
  page.on("request", (req) => {
    if (
      req.method() === "PUT" &&
      new URL(req.url()).hostname.endsWith(".r2.cloudflarestorage.com")
    )
      puts++;
  });
  const source = resolve("../.parcel-secrets/parcel-production-probe.bin");
  writeFileSync(source, Buffer.alloc(93607928), { mode: 0o600 });
  await page.goto(origin + "/admin/new");
  await page.getByLabel("选择文件", { exact: true }).setInputFiles(source);
  await page.getByRole("button", { name: "上传并创建分享" }).click();
  await expect(
    page.getByRole("heading", { name: "文件已装好，交给对方吧。" }),
  ).toBeVisible({ timeout: 150000 });
  expect(puts).toBe(1);
  // Only public identifiers are read from the visible link; auth stays private.
  const links = await page
    .getByRole("link")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLAnchorElement).href),
    );
  const adminLink = links.find((url) =>
    new URL(url).pathname.startsWith("/admin/shares/"),
  );
  if (!adminLink) throw new Error("published share link missing");
  const shareId = new URL(adminLink).pathname.split("/").pop();
  writeFileSync(
    resolve("../.parcel-secrets/browser-production-result.json"),
    JSON.stringify({ shareId, puts }),
    { mode: 0o600 },
  );
  const screenshot = process.env.PARCEL_PRODUCTION_BROWSER_SCREENSHOT;
  if (screenshot) await page.screenshot({ path: screenshot, fullPage: true });
});
