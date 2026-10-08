import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";
const manifest = process.env.PARCEL_BROWSER_R2_MANIFEST;
const probes: {
  size: number;
  url: string;
  headers: Record<string, string>;
  id: string;
}[] = manifest ? JSON.parse(readFileSync(manifest, "utf8")) : [];
test.use({ trace: "off" });
for (const probe of probes) {
  test(`真实浏览器 R2 PUT ${probe.size} 字节`, async ({ page }) => {
    test.setTimeout(120000);
    let stored = false,
      published = false,
      puts = 0,
      putStatus = 0;
    const origin = "https://parcel.playereconlab.com";
    const upload = () => ({
      id: probe.id,
      name: "browser-probe.bin",
      size: probe.size,
      offset: stored ? probe.size : 0,
      storage_backend: "r2",
      part_bytes: 0,
      object_uploaded: stored,
      state: published ? "completed" : "created",
      share_id: "probe-share",
      ttl_seconds: 3600,
      max_downloads: 3,
    });
    page.on("response", (r) => {
      if (r.url() === probe.url && r.request().method() === "PUT") {
        puts++;
        putStatus = r.status();
        stored = putStatus === 200;
      }
    });
    await page.route(origin + "/**", async (route) => {
      const req = route.request(),
        p = new URL(req.url()).pathname;
      if (p.startsWith("/assets/")) {
        const name = basename(p);
        await route.fulfill({
          body: readFileSync(resolve("dist/assets", name)),
          contentType: name.endsWith(".js")
            ? "application/javascript"
            : "text/css",
        });
        return;
      }
      if (!p.startsWith("/api/")) {
        await route.fulfill({
          body: readFileSync("dist/index.html"),
          contentType: "text/html",
        });
        return;
      }
      let data: any = {};
      let status = 200;
      if (p.endsWith("/auth/session"))
        data = { authenticated: true, csrf: "browser-probe-csrf" };
      else if (p.endsWith("/admin/status"))
        data = {
          storage_backend: "r2",
          upload_confirmation_bytes: 100000000,
          chunk_bytes: 8388608,
          max_file_bytes: 8589934592,
          default_ttl_seconds: 3600,
          max_ttl_seconds: 604800,
          default_download_limit: 3,
        };
      else if (p.endsWith("/object"))
        data = { url: probe.url, headers: probe.headers };
      else if (p.endsWith("/complete")) {
        published = true;
        data = upload();
        status = 202;
      } else if (p.includes("/uploads")) {
        data = upload();
        if (req.method() === "POST") status = 201;
      } else if (p.endsWith("/admin/shares/probe-share"))
        data = {
          id: "probe-share",
          name: "browser-probe.bin",
          size: probe.size,
          url: origin + "/s/probe-share",
          expires: 9999999999,
          max_downloads: 3,
        };
      await route.fulfill({ status, json: data });
    });
    await page.goto(origin + "/admin/new");
    const source = resolve("../.parcel-secrets/browser-probe.bin");
    writeFileSync(source, Buffer.alloc(probe.size), { mode: 0o600 });
    await page.getByLabel("选择文件", { exact: true }).setInputFiles(source);
    const firstPut = page.waitForResponse(
      (r) => r.url() === probe.url && r.request().method() === "PUT",
      { timeout: 90000 },
    );
    await page.getByRole("button", { name: "上传并创建分享" }).click();
    const response = await firstPut;
    if (response.status() !== 200) {
      const body = await response.text();
      const code =
        body.match(/<Code>([A-Za-z0-9_]+)<\/Code>/)?.[1] ?? "unknown";
      console.log(
        `R2 PUT size=${probe.size} HTTP=${response.status()} code=${code}`,
      );
      throw new Error(
        `R2 rejected browser PUT: HTTP ${response.status()} ${code}`,
      );
    }
    await expect(
      page.getByRole("heading", { name: "文件已装好，交给对方吧。" }),
    ).toBeVisible({ timeout: 100000 });
    expect(putStatus).toBe(200);
    expect(puts).toBe(1);
  });
}
