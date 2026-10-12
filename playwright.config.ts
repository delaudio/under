import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./visual",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  updateSnapshots: "none",
  snapshotPathTemplate: "{testDir}/baselines/{platform}/{arg}{ext}",
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  },
  expect: { toHaveScreenshot: { animations: "disabled", maxDiffPixels: 0 } },
  webServer: {
    command: "bun scripts/serve-storybook.ts",
    url: "http://127.0.0.1:6017/index.json",
    reuseExistingServer: false,
  },
});
