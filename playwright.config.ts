import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  timeout: 30000,
  expect: {
    timeout: 5000,
  },
  reporter: 'list',
  use: {
    headless: true,
    actionTimeout: 0,
    trace: 'on-first-retry',
  },
});