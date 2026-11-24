import { defineConfig } from '@playwright/test';
import os from 'os';
import path from 'path';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.js',
  outputDir: path.join(os.tmpdir(), 'agent-eval-suite-results'),
  timeout: 120000,
  expect: { timeout: 20000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3001',
    trace: 'off',
    screenshot: 'off',
  },
  webServer: {
    command: 'node server.js',
    url: 'http://localhost:3001/api/v1/health',
    reuseExistingServer: true,
    timeout: 30000,
  },
});
