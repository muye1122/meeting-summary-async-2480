import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(fs.readFileSync(path.join(dirname, 'data', 'test-vectors.json'), 'utf8'));

// The application itself reads the three secrets only from environment variables.
// This harness feeds fictional values from the checked-in vectors to the spawned API.
const callbackEnv = {
  ...process.env,
  PORT: '3001',
  WECOM_TOKEN: vectors.config.token,
  WECOM_ENCODING_AES_KEY: vectors.config.encodingAesKey,
  WECOM_CORP_ID: vectors.config.corpId,
  ALLOW_TEST_HOOKS: '1',
};

export default defineConfig({
  testDir: './tests',
  outputDir: path.join(os.tmpdir(), 'pw-results-wecom-callback'),
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    channel: 'msedge',
    trace: 'off',
    screenshot: 'off',
    viewport: { width: 1360, height: 900 },
  },
  webServer: [
    {
      command: 'node mock-server/index.js',
      url: 'http://localhost:3001/api/wecom/health',
      env: callbackEnv,
      reuseExistingServer: true,
      timeout: 30000,
    },
    {
      command: 'npm run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 30000,
    },
  ],
});
