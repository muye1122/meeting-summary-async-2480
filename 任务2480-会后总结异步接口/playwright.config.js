import { defineConfig } from '@playwright/test';
import os from 'os';
import path from 'path';

export default defineConfig({
  testDir: './tests',
  outputDir: path.join(os.tmpdir(), 'pw-results-meeting-summary'),
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    // 复用系统已安装的 Edge，避免下载 Chromium；换机器无 Edge 时可去掉 channel
    channel: 'msedge',
    trace: 'off',
    screenshot: 'off',
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    { command: 'node mock-server/index.js', url: 'http://localhost:3001/api/v1/health', reuseExistingServer: true, timeout: 30000 },
    { command: 'npm run dev', url: 'http://localhost:5173', reuseExistingServer: true, timeout: 30000 },
  ],
});
