import { test, expect } from "@playwright/test";

async function login(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("管理员密码").fill("e2e-admin-password");
  await page.getByRole("button", { name: "登录 Parcel" }).click();
  await page.getByRole("link", { name: "新建分享" }).click();
  await expect(page.getByLabel("选择文件", { exact: true })).toBeAttached();
}

for (const scenario of [
  { size: 100_000_000, accept: true, dialogs: 0 },
  { size: 100_000_001, accept: false, dialogs: 1 },
  { size: 100_000_001, accept: true, dialogs: 1 },
]) {
  test(`100 MB 确认边界 ${scenario.size} / ${scenario.accept}`, async ({
    page,
  }) => {
    await login(page);
    let dialogs = 0,
      creates = 0;
    page.on("dialog", async (dialog) => {
      dialogs++;
      expect(dialog.message()).toContain("100,000,000 字节");
      if (scenario.accept) await dialog.accept();
      else await dialog.dismiss();
    });
    await page.route("**/api/v1/uploads", async (route) => {
      creates++;
      expect(route.request().postDataJSON().confirm_large).toBe(
        scenario.size > 100_000_000,
      );
      await route.fulfill({
        status: 400,
        json: { message: "边界已验证", code: "test" },
      });
    });
    // Model a large selected file without allocating or uploading 100 MB.
    await page.evaluate((size) => {
      const input = document.querySelector(
        "input[type=file]",
      ) as HTMLInputElement;
      const file = new File(["x"], "large.bin");
      Object.defineProperty(file, "size", { value: size });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      // DataTransfer can clone File metadata, so attach size to its returned File.
      Object.defineProperty(input.files![0], "size", { value: size });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, scenario.size);
    await page.getByRole("button", { name: "上传并创建分享" }).click();
    if (scenario.accept)
      await expect(page.getByRole("alert")).toContainText("边界已验证");
    expect(dialogs).toBe(scenario.dialogs);
    expect(creates).toBe(scenario.accept ? 1 : 0);
  });
}

for (const resume of [true, false])
  test(`R2 ${resume ? "恢复已完成分块" : "新任务使用 16 MiB 分块"}，失败后续签直传，文件不发送到 Parcel PATCH`, async ({
    page,
  }) => {
    const partBytes = 16 << 20;
    const id = "r2-test-upload";
    let firstUploaded = resume,
      lastAttempts = 0,
      uploaded = false,
      completed = false,
      puts = 0,
      patches = 0;
    const upload = () => ({
      id,
      name: "resume.bin",
      size: partBytes + 3,
      offset: uploaded ? partBytes + 3 : firstUploaded ? partBytes : 0,
      storage_backend: "r2",
      part_bytes: partBytes,
      state: completed ? "completed" : "uploading",
      share_id: "r2-test-share",
      ttl_seconds: 86400,
      max_downloads: 3,
      error: "",
      parts: [
        ...(firstUploaded
          ? [{ number: 1, size: partBytes, etag: "first" }]
          : []),
        ...(uploaded ? [{ number: 2, size: 3, etag: "second" }] : []),
      ],
    });
    await page.route("**/api/v1/uploads**", async (route) => {
      const req = route.request();
      if (req.method() === "PATCH") patches++;
      if (/\/parts\/[12]$/.test(req.url()))
        await route.fulfill({
          json: {
            url:
              "https://test.r2.cloudflarestorage.com/part/" +
              req.url().split("/").at(-1),
            expires: 9999999999,
          },
        });
      else if (req.url().endsWith("/complete")) {
        completed = true;
        await route.fulfill({ status: 202, json: upload() });
      } else
        await route.fulfill({
          status: req.method() === "POST" ? 201 : 200,
          json: upload(),
        });
    });
    await page.route(
      "https://test.r2.cloudflarestorage.com/**",
      async (route) => {
        if (route.request().method() === "OPTIONS") {
          await route.fulfill({
            status: 204,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "PUT",
              "Access-Control-Allow-Headers": "content-type",
            },
          });
          return;
        }
        expect(route.request().method()).toBe("PUT");
        puts++;
        if (route.request().url().endsWith("/1")) {
          // Chromium exposes the body; Firefox reports Content-Length for large bodies.
          const transmitted =
            route.request().postDataBuffer()?.length ??
            Number(await route.request().headerValue("content-length"));
          expect(transmitted).toBe(partBytes);
          firstUploaded = true;
          await route.fulfill({
            status: 200,
            headers: { ETag: "first", "Access-Control-Allow-Origin": "*" },
          });
          return;
        }
        expect(route.request().postDataBuffer()?.toString()).toBe("xyz");
        if (++lastAttempts === 1) await route.abort("failed");
        else {
          uploaded = true;
          await route.fulfill({
            status: 200,
            headers: { ETag: "second", "Access-Control-Allow-Origin": "*" },
          });
        }
      },
    );
    await page.route("**/api/v1/admin/shares/r2-test-share", (route) =>
      route.fulfill({
        json: {
          id: "r2-test-share",
          name: "resume.bin",
          size: partBytes + 3,
          url: "http://127.0.0.1:18280/s/r2-test-share",
          expires: 9999999999,
          max_downloads: 3,
        },
      }),
    );
    await page.route("**/api/v1/admin/status", async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        json: { ...(await response.json()), storage_backend: "r2" },
      });
    });
    await page.route("**/admin/new", async (route) => {
      const response = await route.fetch();
      const headers = response.headers();
      headers["content-security-policy"] = headers[
        "content-security-policy"
      ].replace(
        "connect-src 'self'",
        "connect-src 'self' https://test.r2.cloudflarestorage.com",
      );
      await route.fulfill({ response, headers });
    });
    await login(page);
    await page.getByLabel("选择文件", { exact: true }).setInputFiles({
      name: "resume.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.concat([Buffer.alloc(partBytes), Buffer.from("xyz")]),
    });
    await expect(
      page.getByText("文件直传到私有 R2 存储。", { exact: false }),
    ).toBeVisible();
    await page.getByRole("button", { name: "上传并创建分享" }).click();
    await expect(
      page.getByRole("heading", { name: "文件已装好，交给对方吧。" }),
    ).toBeVisible();
    expect(puts).toBe(resume ? 2 : 3);
    expect(patches).toBe(0);
  });

test("R2 下载续签同一会话且不 HEAD 预签名 GET", async ({ page }) => {
  let issued = 0,
    refreshed = 0,
    heads = 0;
  await page.route("**/api/v1/shares/r2-share**", async (route) => {
    if (route.request().url().endsWith("/refresh")) {
      refreshed++;
      expect(route.request().postDataJSON()).toEqual({
        session: "same-session",
      });
      await route.fulfill({
        json: {
          url: "https://test.r2.cloudflarestorage.com/file",
          session: "same-session",
          expires: 9999999999,
        },
      });
    } else if (route.request().url().endsWith("/download-sessions")) {
      issued++;
      await route.fulfill({
        status: 201,
        json: {
          url: "https://test.r2.cloudflarestorage.com/file",
          session: "same-session",
          expires: 9999999999,
        },
      });
    } else
      await route.fulfill({
        json: {
          id: "r2-share",
          name: "direct.txt",
          size: 3,
          storage_backend: "r2",
          availability: issued ? "exhausted" : "available",
          max_downloads: 1,
          download_count: issued,
          expires: 9999999999,
        },
      });
  });
  await page.route(
    "https://test.r2.cloudflarestorage.com/file",
    async (route) => {
      if (route.request().method() === "HEAD") heads++;
      await route.fulfill({
        body: "abc",
        headers: {
          "Content-Disposition": 'attachment; filename="direct.txt"',
          "Content-Type": "application/octet-stream",
        },
      });
    },
  );
  await page.goto("/s/r2-share");
  await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "下载文件", exact: true }).click(),
  ]);
  await expect(
    page.getByRole("button", { name: "再次下载 / 继续" }),
  ).toBeEnabled();
  await page.reload();
  await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "再次下载 / 继续" }).click(),
  ]);
  expect(issued).toBe(1);
  expect(refreshed).toBe(1);
  expect(heads).toBe(0);
});

test("R2 会话失效后清除缓存，仍可用的分享允许申请新会话", async ({ page }) => {
  let issued = 0;
  await page.route("**/api/v1/shares/expired-session**", async (route) => {
    if (route.request().url().endsWith("/refresh")) {
      await route.fulfill({
        status: 410,
        json: { code: "download_unavailable", message: "会话已过期" },
      });
    } else if (route.request().url().endsWith("/download-sessions")) {
      issued++;
      await route.fulfill({
        status: 201,
        json: {
          url: "https://test.r2.cloudflarestorage.com/file",
          session: `session-${issued}`,
          expires: 9999999999,
        },
      });
    } else
      await route.fulfill({
        json: {
          id: "expired-session",
          name: "direct.txt",
          size: 3,
          storage_backend: "r2",
          availability: "available",
          max_downloads: 3,
          download_count: issued,
          expires: 9999999999,
        },
      });
  });
  await page.route("https://test.r2.cloudflarestorage.com/file", (route) =>
    route.fulfill({
      body: "abc",
      headers: { "Content-Disposition": 'attachment; filename="direct.txt"' },
    }),
  );
  await page.goto("/s/expired-session");
  await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "下载文件", exact: true }).click(),
  ]);
  await page.getByRole("button", { name: "再次下载 / 继续" }).click();
  await expect(page.getByRole("alert")).toContainText("会话已过期");
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("parcel.download.expired-session"),
    ),
  ).toBeNull();
  await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "下载文件", exact: true }).click(),
  ]);
  expect(issued).toBe(2);
});

async function restoreUpload(
  page: import("@playwright/test").Page,
  upload: Record<string, unknown>,
) {
  await login(page);
  await page.evaluate((u) => {
    localStorage.setItem(
      "parcel.upload",
      JSON.stringify({ id: u.id, name: u.name, size: u.size, modified: 0 }),
    );
  }, upload);
  await page.reload();
}

const pendingUpload = {
  id: "pending-r2-upload",
  name: "pending.bin",
  size: 3,
  offset: 3,
  storage_backend: "r2",
  part_bytes: 16 << 20,
  state: "finalizing",
  share_id: "pending-share",
  ttl_seconds: 86400,
  max_downloads: 3,
  error: "",
};

test("R2 发布超时保留任务，无需重选文件即可查询成功", async ({ page }) => {
  let published = false,
    creates = 0;
  await page.clock.install();
  await page.route("**/api/v1/uploads**", async (route) => {
    expect(route.request().method()).toBe("GET");
    if (route.request().method() === "POST") creates++;
    await route.fulfill({
      json: { ...pendingUpload, state: published ? "completed" : "finalizing" },
    });
  });
  await page.route("**/api/v1/admin/shares/pending-share", (route) =>
    route.fulfill({
      json: {
        id: "pending-share",
        name: "pending.bin",
        size: 3,
        url: "http://127.0.0.1:18280/s/pending-share",
        expires: 9999999999,
        max_downloads: 3,
      },
    }),
  );
  await restoreUpload(page, pendingUpload);
  await expect(
    page.getByText("正在完成 R2 上传…", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("R2 已保存", { exact: false })).toBeVisible();
  await page.clock.fastForward(121_000);
  await expect(page.getByRole("alert")).toContainText("发布确认超时");
  await expect(
    page.getByRole("button", { name: "查询发布结果" }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() => localStorage.getItem("parcel.upload")),
  ).not.toBeNull();
  published = true;
  await page.getByRole("button", { name: "查询发布结果" }).click();
  await expect(
    page.getByRole("heading", { name: "文件已装好，交给对方吧。" }),
  ).toBeVisible();
  expect(creates).toBe(0);
});

test("R2 后端发布错误显示并保留查询入口", async ({ page }) => {
  const u = { ...pendingUpload, error: "文件校验或发布失败" };
  await page.route("**/api/v1/uploads**", (route) =>
    route.fulfill({ json: u }),
  );
  await restoreUpload(page, u);
  await expect(page.getByRole("alert")).toContainText("文件校验或发布失败");
  await expect(
    page.getByRole("button", { name: "查询发布结果" }),
  ).toBeEnabled();
  await expect(page.getByText("等待发布结果", { exact: true })).toBeVisible();
});

test("R2 配置下恢复旧本地任务应说明实际存储路径", async ({ page }) => {
  const u = {
    ...pendingUpload,
    storage_backend: "local",
    state: "uploading",
    offset: 0,
    part_bytes: 0,
  };
  await page.route("**/api/v1/admin/status", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      json: { ...(await response.json()), storage_backend: "r2" },
    });
  });
  await page.route("**/api/v1/uploads**", (route) =>
    route.fulfill({ json: u }),
  );
  await restoreUpload(page, u);
  await expect(
    page.getByText("这是启用 R2 前创建的本地上传任务", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("文件只保存在本机。", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("文件直传到私有 R2 存储。", { exact: false }),
  ).toHaveCount(0);
});

for (const legacy of [false, true]) {
  for (const size of [0, 20 << 20]) {
    for (const outcome of ["success", "rejected", "unverified"]) {
      test(`${legacy ? "历史单 PUT" : "新单分块"}任务一次 PUT（${size} 字节，${outcome}）`, async ({
        page,
      }) => {
        let stored = false,
          published = false,
          puts = 0;
        const u = () => ({
          ...pendingUpload,
          id: "single-put-task",
          name: "whole.bin",
          size,
          offset: stored ? size : 0,
          part_bytes: legacy ? 0 : 100_000_000,
          parts: stored && !legacy ? [{ number: 1, size, etag: "whole" }] : [],
          object_uploaded: stored,
          state: published ? "completed" : "created",
        });
        await page.route("**/api/v1/uploads**", async (route) => {
          const req = route.request();
          expect(req.method()).not.toBe("PATCH");
          expect(req.url()).not.toContain(legacy ? "/parts/" : "/object");
          if (req.url().endsWith(legacy ? "/object" : "/parts/1")) {
            await route.fulfill({
              json: {
                url: "https://test.r2.cloudflarestorage.com/whole",
                headers: {
                  [size === 0 ? "Content-Type" : "content-type"]:
                    "application/octet-stream",
                  ...(legacy
                    ? { "X-Amz-Meta-Parcel-Upload": "single-put-task" }
                    : {}),
                },
              },
            });
          } else if (req.url().endsWith("/complete")) {
            expect(stored).toBe(true);
            published = true;
            await route.fulfill({ status: 202, json: u() });
          } else
            await route.fulfill({
              status: req.method() === "POST" ? 201 : 200,
              json: u(),
            });
        });
        await page.route(
          "https://test.r2.cloudflarestorage.com/**",
          async (route) => {
            if (route.request().method() === "OPTIONS") {
              await route.fulfill({
                status: 204,
                headers: {
                  "Access-Control-Allow-Origin": "*",
                  "Access-Control-Allow-Methods": "PUT",
                  "Access-Control-Allow-Headers":
                    "content-type,x-amz-meta-parcel-upload",
                },
              });
              return;
            }
            expect(route.request().method()).toBe("PUT");
            expect(await route.request().headerValue("content-type")).toBe(
              "application/octet-stream",
            );
            expect(
              await route.request().headerValue("x-amz-meta-parcel-upload"),
            ).toBe(legacy ? "single-put-task" : null);
            const transmitted =
              route.request().postDataBuffer()?.length ??
              Number(await route.request().headerValue("content-length"));
            expect(transmitted).toBe(size);
            puts++;
            stored = outcome === "success";
            await route.fulfill({
              status: outcome === "rejected" ? 403 : 200,
              headers: { "Access-Control-Allow-Origin": "*", ETag: "whole" },
              body:
                outcome === "rejected"
                  ? "<Error><Code>SignatureDoesNotMatch</Code></Error>"
                  : "",
            });
          },
        );
        await page.route("**/api/v1/admin/shares/pending-share", (route) =>
          route.fulfill({
            json: {
              id: "pending-share",
              name: "whole.bin",
              size,
              url: "http://127.0.0.1:18280/s/pending-share",
              expires: 9999999999,
              max_downloads: 3,
            },
          }),
        );
        await page.route("**/api/v1/admin/status", async (route) => {
          const response = await route.fetch();
          await route.fulfill({
            json: { ...(await response.json()), storage_backend: "r2" },
          });
        });
        await page.route("**/admin/new", async (route) => {
          const response = await route.fetch();
          const headers = response.headers();
          headers["content-security-policy"] = headers[
            "content-security-policy"
          ].replace(
            "connect-src 'self'",
            "connect-src 'self' https://test.r2.cloudflarestorage.com",
          );
          await route.fulfill({ response, headers });
        });
        await login(page);
        await page.getByLabel("选择文件", { exact: true }).setInputFiles({
          name: "whole.bin",
          mimeType: "application/octet-stream",
          buffer: Buffer.alloc(size),
        });
        await page.getByRole("button", { name: "上传并创建分享" }).click();
        if (outcome === "success") {
          await expect(
            page.getByRole("heading", { name: "文件已装好，交给对方吧。" }),
          ).toBeVisible();
        } else {
          await expect(page.getByRole("alert")).toContainText(
            outcome === "rejected" ? "签名校验失败" : "不会自动重传整个文件",
          );
          expect(published).toBe(false);
          expect(
            await page.evaluate(() => localStorage.getItem("parcel.upload")),
          ).not.toBeNull();
        }
        expect(puts).toBe(1);
      });
    }
  }
}
