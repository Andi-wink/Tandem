import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Single worker by design. The suite runs against the Next.js DEV server, which compiles
  // routes on demand; several parallel workers navigating to different routes at once (now one
  // more with the /capture quick-capture route) contend on that single compiler and produce
  // intermittent 30s navigation timeouts / chrome-error navigations on unrelated specs
  // (action-items, command-palette, settings, sidebar). A serial run is deterministically green.
  // Override with PLAYWRIGHT_WORKERS if you accept the flakiness for a faster local run.
  workers: process.env.PLAYWRIGHT_WORKERS ? Number(process.env.PLAYWRIGHT_WORKERS) : 1,
  reporter: [['html', { outputFolder: './playwright-report' }], ['list']],
  outputDir: './test-results',

  use: {
    baseURL: 'http://localhost:3118',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'pnpm run dev',
    url: 'http://localhost:3118',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
