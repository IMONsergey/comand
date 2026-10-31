import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/ui',
  timeout: 45_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        ...(process.env.COMAND_E2E_CHANNEL ? { channel: process.env.COMAND_E2E_CHANNEL } : {}),
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: 'mobile',
      use: {
        ...devices['Desktop Chrome'],
        ...(process.env.COMAND_E2E_CHANNEL ? { channel: process.env.COMAND_E2E_CHANNEL } : {}),
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    ...(process.env.COMAND_E2E_WEBKIT === '1'
      ? [
          {
            name: 'webkit-desktop',
            use: {
              ...devices['Desktop Safari'],
              viewport: { width: 1440, height: 1000 },
            },
          },
          { name: 'webkit-mobile', use: { ...devices['iPhone 13'] } },
        ]
      : []),
  ],
});
