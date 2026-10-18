import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3017';

/**
 * Real-browser E2E configuration.
 *
 * There is no `page.route()` interception of our own API anywhere in the suite:
 * every request hits the real Next server, which reads a real SQLite file and
 * writes real image files to disk (TEST_STRATEGY §0/§2).
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  timeout: 90_000,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'test-results/e2e-results.json' }],
  ],
  outputDir: 'test-results/artifacts',

  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } },
    },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'] } },
  ],

  // Visual baselines are captured on Linux CI. On Windows the font rasteriser
  // differs enough to produce permanent false diffs, so local runs write to a
  // separate folder (ADR-007) instead of polluting the approved baselines.
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      maxDiffPixelRatio: 0.01,
    },
  },

  snapshotPathTemplate: process.env.CI
    ? '{testDir}/__screenshots__/{projectName}/{arg}{ext}'
    : '{testDir}/__screenshots__/local/{projectName}/{arg}{ext}',

  webServer: {
    command: 'npm run start:test',
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NODE_ENV: 'production',
      ISLE_E2E: '1',
      E2E_BASE_URL: baseURL,
    },
  },
});
