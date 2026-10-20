import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// UI language behavior uses mocked APIs and runs against either UI build.
export default defineConfig({
  ...base,
  testMatch: "i18n.spec.ts",
  projects: base.projects?.map((project) => ({
    ...project,
    use: { ...project.use, channel: undefined },
  })),
  use: { ...base.use, baseURL: "http://127.0.0.1:18281" },
  webServer: {
    command: "npm run dev -- --port 18281",
    url: "http://127.0.0.1:18281/login",
    reuseExistingServer: false,
  },
});
