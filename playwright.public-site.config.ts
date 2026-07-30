import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/public-site",
  forbidOnly: !!process.env.CI,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "./test-results/public-site-playwright",
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  webServer: {
    command: "node scripts/serve-public-site.mjs",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
