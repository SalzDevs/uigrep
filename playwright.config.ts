import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: "test-results/playwright",
  reporter: "list",
  use: {
    browserName: "chromium",
    channel: "chromium",
    baseURL: "http://localhost:1420",
    headless: true,
    viewport: { width: 1280, height: 900 },
    screenshot: "only-on-failure",
    // Pairing credentials must not be recorded in network traces.
    trace: "off",
    video: "off",
  },
  webServer: {
    command: "pnpm --filter @uigrep/desktop dev --host localhost",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
