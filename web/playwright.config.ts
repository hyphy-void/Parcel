import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:18280";
export default defineConfig({
  testDir: "./tests",
  workers: 1,
  fullyParallel: false,
  timeout: 60000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: "chromium" },
    },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"], channel: "chromium" },
    },
  ],
  webServer: {
    command: "node tests/server.mjs",
    url: `${baseURL}/readyz`,
    reuseExistingServer: false,
    timeout: 120000,
  },
});
