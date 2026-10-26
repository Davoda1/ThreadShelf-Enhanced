import { defineConfig } from '@playwright/test';

/**
 * Playwright config. The server is booted per-worker by the test fixtures
 * (see test/playwright/fixtures.js) because each test wants an isolated
 * LanceDB directory.
 */
export default defineConfig({
  testDir: './test/playwright',
  fullyParallel: false, // server boot is expensive; keep serial for stability
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 5 * 60_000,
  expect: { timeout: 15_000 },
  use: {
    headless: true,
    // A locally installed browser is useful in offline/restricted build hosts.
    // Normal development and CI retain Playwright's pinned browser by default.
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : undefined,
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
