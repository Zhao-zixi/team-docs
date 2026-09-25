import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const setupToken = "teamshelf-e2e-setup-token-2026-only-for-isolated-tests";
const dataDir = mkdtempSync(path.join(tmpdir(), "teamshelf-e2e-"));
export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results/playwright",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 12_000 },
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:4187", trace: "retain-on-failure", screenshot: "only-on-failure", ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
  webServer: {
    command: "npm run build && node --env-file-if-exists=.env dist/server/server/index.js",
    url: "http://127.0.0.1:4187/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: { ...process.env, PORT: "4187", APP_ORIGIN: "http://127.0.0.1:4187", SETUP_TOKEN: setupToken, DATA_DIR: dataDir, COOKIE_SECURE: "false", NODE_ENV: "production" },
  },
});