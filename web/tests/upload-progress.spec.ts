import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const part = 16 << 20;
const size = 40 << 20;

declare global {
  interface Window {
    uploadProgressProbe: {
      requests: Array<{
        size: number;
        progress: (loaded: number) => void;
        finish: () => void;
        fail: () => void;
      }>;
    };
  }
}

async function fixture(page: Page) {
  let confirmed = 0;
  let published = false;
  let releaseComplete: (() => void) | undefined;
  let releaseConfirmation: (() => void) | undefined;
  let holdConfirmation = false;
  const complete = new Promise<void>((resolve) => {
    releaseComplete = resolve;
  });
  const confirmation = new Promise<void>((resolve) => {
    releaseConfirmation = resolve;
  });
  const upload = () => ({
    id: "progress-task",
    name: "示例资料.zip",
    size,
    offset: confirmed,
    storage_backend: "r2",
    part_bytes: part,
    state: published ? "completed" : "uploading",
    share_id: "progress-share",
    ttl_seconds: 86400,
    max_downloads: 3,
    error: "",
    parts: Array.from({ length: Math.ceil(confirmed / part) }, (_, i) => ({
      number: i + 1,
      size: Math.min(part, confirmed - i * part),
      etag: `part-${i + 1}`,
    })),
  });
  await page.addInitScript(() => {
    window.uploadProgressProbe = { requests: [] };
    class ProgressXHR {
      upload = {
        onprogress: undefined as undefined | ((e: { loaded: number }) => void),
      };
      status = 0;
      responseText = "";
      onload?: () => void;
      onerror?: () => void;
      onabort?: () => void;
      ontimeout?: () => void;
      open() {}
      setRequestHeader() {}
      abort() {
        this.onabort?.();
      }
      send(blob: Blob) {
        window.uploadProgressProbe.requests.push({
          size: blob.size,
          progress: (loaded) => this.upload.onprogress?.({ loaded }),
          finish: () => {
            this.status = 200;
            this.onload?.();
          },
          fail: () => this.onerror?.(),
        });
      }
    }
    window.XMLHttpRequest = ProgressXHR as unknown as typeof XMLHttpRequest;
  });
  await page.route("**/api/v1/admin/status", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      json: { ...(await response.json()), storage_backend: "r2" },
    });
  });
  await page.route("**/api/v1/uploads**", async (route) => {
    if (/\/parts\/\d+$/.test(route.request().url())) {
      await route.fulfill({
        json: { url: "https://test.r2.cloudflarestorage.com/part" },
      });
    } else if (route.request().url().endsWith("/complete")) {
      await complete;
      published = true;
      await route.fulfill({ status: 202, json: upload() });
    } else {
      if (holdConfirmation && route.request().method() === "GET")
        await confirmation;
      await route.fulfill({
        status: route.request().method() === "POST" ? 201 : 200,
        json: upload(),
      });
    }
  });
  await page.route("**/api/v1/admin/shares/progress-share", (route) =>
    route.fulfill({
      json: {
        id: "progress-share",
        name: "示例资料.zip",
        size,
        url: "/s/progress-share",
        max_downloads: 3,
        expires: 9999999999,
      },
    }),
  );
  await page.goto("/login");
  await page.getByLabel("管理员密码").fill("e2e-admin-password");
  await page.getByRole("button", { name: "登录 Parcel" }).click();
  await page.getByRole("link", { name: "新建分享" }).click();
  await page.getByLabel("选择文件", { exact: true }).setInputFiles({
    name: "示例资料.zip",
    mimeType: "application/zip",
    buffer: Buffer.alloc(size),
  });
  await page.getByRole("button", { name: "上传并创建分享" }).click();
  return {
    confirm: (offset: number) => {
      confirmed = offset;
    },
    hold: () => {
      holdConfirmation = true;
    },
    release: () => {
      holdConfirmation = false;
      releaseConfirmation!();
    },
    publish: () => releaseComplete!(),
  };
}

async function waitRequest(page: Page, count: number) {
  await expect
    .poll(() => page.evaluate(() => window.uploadProgressProbe.requests.length))
    .toBe(count);
}
async function progress(page: Page, request: number, loaded: number) {
  await page.evaluate(
    ({ request, loaded }) =>
      window.uploadProgressProbe.requests[request].progress(loaded),
    { request, loaded },
  );
}
async function finish(page: Page, request: number) {
  await page.evaluate(
    (request) => window.uploadProgressProbe.requests[request].finish(),
    request,
  );
}

test("整个文件进度连续更新，分块交接不重复计数，100% 等待发布", async ({
  page,
}, testInfo) => {
  const f = await fixture(page);
  const bar = page.getByRole("progressbar", { name: "文件上传进度" });
  await waitRequest(page, 1);
  await progress(page, 0, 8 << 20);
  await expect(bar).toHaveAttribute("aria-valuenow", "20");
  await expect(page.locator(".progress-card small")).toHaveText(
    "已上传 8.00 MiB / 40.0 MiB",
  );
  f.hold();
  f.confirm(part);
  await finish(page, 0);
  await expect(bar).toHaveAttribute("aria-valuenow", "40");
  f.release();
  await waitRequest(page, 2);
  await expect(bar).toHaveAttribute("aria-valuenow", "40");
  await progress(page, 1, 8 << 20);
  await expect(bar).toHaveAttribute("aria-valuenow", "60");
  await expect(page.locator(".progress-card small")).toHaveText(
    "已上传 24.0 MiB / 40.0 MiB",
  );
  await expect(page.getByText("当前分块发送", { exact: false })).toHaveCount(0);
  await expect(page.getByText("R2 已保存", { exact: false })).toHaveCount(0);
  if (testInfo.project.name === "chromium") {
    await page.setViewportSize({ width: 1440, height: 1040 });
    await expect
      .poll(() =>
        bar.evaluate((element) => {
          const track = element.getBoundingClientRect().width;
          const fill = element.firstElementChild!.getBoundingClientRect().width;
          return Math.round((fill / track) * 100);
        }),
      )
      .toBe(60);
    await mkdir(resolve("../dist/previews"), { recursive: true });
    await page.screenshot({
      path: resolve("../dist/previews/upload-progress.png"),
      fullPage: true,
    });
  }
  f.confirm(2 * part);
  await finish(page, 1);
  await waitRequest(page, 3);
  await expect(bar).toHaveAttribute("aria-valuenow", "80");
  await progress(page, 2, 4 << 20);
  await expect(bar).toHaveAttribute("aria-valuenow", "90");
  f.confirm(size);
  await finish(page, 2);
  await expect(bar).toHaveAttribute("aria-valuenow", "100");
  await expect(
    page.getByText("传输完成，正在发布…", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "暂停上传" })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "文件已装好，交给对方吧。" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      window.uploadProgressProbe.requests.map((r) => r.size),
    ),
  ).toEqual([part, part, 8 << 20]);
  f.publish();
  await expect(
    page.getByRole("heading", { name: "文件已装好，交给对方吧。" }),
  ).toBeVisible();
});

test("失败重试和暂停恢复清除未确认发送量，忽略旧请求进度", async ({ page }) => {
  const f = await fixture(page);
  const bar = page.getByRole("progressbar", { name: "文件上传进度" });
  await waitRequest(page, 1);
  f.confirm(part);
  await finish(page, 0);
  await waitRequest(page, 2);
  await progress(page, 1, 8 << 20);
  await expect(bar).toHaveAttribute("aria-valuenow", "60");
  await page.evaluate(() => window.uploadProgressProbe.requests[1].fail());
  await expect(page.getByText("等待重试…", { exact: true })).toBeVisible();
  await expect(bar).toHaveAttribute("aria-valuenow", "40");
  await progress(page, 1, part);
  await expect(bar).toHaveAttribute("aria-valuenow", "40");
  await waitRequest(page, 3);
  await progress(page, 1, part);
  await expect(bar).toHaveAttribute("aria-valuenow", "40");
  await progress(page, 2, 4 << 20);
  await expect(bar).toHaveAttribute("aria-valuenow", "50");
  await page.getByRole("button", { name: "暂停上传" }).click();
  await expect(page.getByText("上传已暂停", { exact: true })).toBeVisible();
  await expect(bar).toHaveAttribute("aria-valuenow", "40");
  await page.getByRole("button", { name: "继续上传" }).click();
  await waitRequest(page, 4);
  await progress(page, 2, part);
  await expect(bar).toHaveAttribute("aria-valuenow", "40");
  await progress(page, 3, 8 << 20);
  await expect(bar).toHaveAttribute("aria-valuenow", "60");
  expect(
    await page.evaluate(() => window.uploadProgressProbe.requests[3].size),
  ).toBe(part);
  f.publish();
});
