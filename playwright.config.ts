import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const PORT = 4571;
const TEST_DB_PATH = "./tests/.tmp/e2e.db";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : "html",
  globalSetup: path.resolve(__dirname, "tests/e2e/mocks/global-setup.ts"),
  globalTeardown: path.resolve(__dirname, "tests/e2e/mocks/global-teardown.ts"),
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `pnpm build && pnpm exec next start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      JWL_DB_PATH: TEST_DB_PATH,
      JWL_E2E: "1",
      NODE_ENV: "production",
    },
  },
});
