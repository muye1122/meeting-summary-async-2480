/**
 * End-to-end flow and delivery-shape checks. API assertions use the mock API
 * directly; page navigation goes through Vite, which proxies /api to it.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const API = 'http://127.0.0.1:3001/api/v1';
const body = (r) => r.json();
const reset = async (request) => {
  const r = await request.post(API + '/test/reset');
  expect(r.ok()).toBeTruthy();
};

const DELIVERABLES = [
  'package.json', 'index.html', 'vite.config.js', 'playwright.config.js',
  'Dockerfile', 'docker-compose.yml', 'server.js',
  'mock-server/index.js', 'mock-server/router.js',
  'migrations/001_create_quote_approvals.sql',
  'migrations/002_create_quote_approval_steps.sql',
  'src/App.jsx', 'src/main.jsx', 'src/styles.css',
  'tests/flow.spec.js', 'tests/approval.test.js',
  'README.md', '验证记录.md', '投标文本.txt',
];

test('repository is runnable: required files, scripts and docs exist', async () => {
  const root = path.resolve('.');
  for (const f of DELIVERABLES) {
    expect(fs.existsSync(path.join(root, f)), `missing file: ${f}`).toBeTruthy();
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const s of ['dev', 'mock', 'dev:all', 'build', 'test']) {
    expect(pkg.scripts[s], `missing script: ${s}`).toBeTruthy();
  }
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  expect(readme).toContain('docker compose up');
  expect(readme).toContain('npm install');
  expect(readme).toContain('npm test');
  expect(readme).toContain('site_manager');
  expect(readme).toContain('```mermaid');
});

test('delivered files use functional names only, never an identifier', async () => {
  const root = path.resolve('.');
  // Assembled at runtime so this source file never contains the literal pattern.
  const n = String.fromCharCode(50, 52, 48, 52);
  const code = ['S3', 'SALES', '029'].join('-');
  const marker = 'T' + 'ask';
  const forbidden = new RegExp(
    `#\\s*${n}\\b|${code}|\\b${marker}\\s*#?\\s*${n}\\b|任务\\s*${n}|任务编号\\s*${n}`,
    'i'
  );
  for (const f of DELIVERABLES) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    expect(forbidden.test(text), `identifier-like text found in ${f}`).toBe(false);
  }
  // The only numeric occurrence is the public brief URL in the bid header.
  const bid = fs.readFileSync(path.join(root, '投标文本.txt'), 'utf8');
  expect(bid).toContain('https://clawhunt.store/p/' + n);
});

test('API health, meta and OpenAPI contract are exposed', async ({ request }) => {
  const health = await body(await request.get(API + '/health'));
  expect(health.service).toBe('quote-approval-flow');

  const meta = await body(await request.get(API + '/meta'));
  expect(meta.tiers).toEqual(['rep', 'supervisor', 'site_manager']);
  expect(meta.approval_statuses).toContain('pending');
  expect(meta.valid_until_days).toBe(15);
  expect(meta.reminder_hours.manager).toBe(48);

  const spec = await body(await request.get(API + '/openapi.json'));
  expect(spec.openapi).toMatch(/^3\./);
  expect(spec.info.title).toBe('Quotation Approval Workflow API');
  for (const p of [
    '/api/v1/sales/quotes/{qid}/submit',
    '/api/v1/sales/approvals',
    '/api/v1/sales/approvals/{aid}/approve',
    '/api/v1/sales/approvals/{aid}/reject',
    '/api/v1/sales/approvals/{aid}/withdraw',
    '/api/v1/approvals/reminder-sweep',
  ]) {
    expect(spec.paths[p], `missing path ${p}`).toBeTruthy();
  }
  expect(spec.components.schemas.Approval.required).toContain('snapshot_hash');
});

test('UI demo drives a site_manager quote through both approval steps', async ({ page, request }) => {
  await reset(request);
  await page.goto('/');

  await expect(page.getByTestId('app-title')).toBeVisible();
  await expect(page.getByTestId('quote-table')).toBeVisible();
  await expect(page.getByTestId('route-table')).toContainText('site_manager');

  await page.getByTestId('submit-Q-1003').click();
  await expect(page.getByTestId('submit-msg')).toContainText('apr_0001');
  await expect(page.getByTestId('quote-status-Q-1003')).toContainText('pending');

  // The submitter does not see this approval in the todo tab; the current
  // step approver does, so switch actor before inspecting it.
  await page.getByTestId('actor-select').selectOption('u-sup-01');
  await expect(page.getByTestId('tab-result')).toContainText('u-sup-01');
  await expect(page.getByTestId('approval-status-apr_0001')).toContainText('pending');
  await expect(page.getByTestId('current-approver-apr_0001')).toHaveText('u-sup-01');

  await page.getByTestId('approve-apr_0001').click();

  // The submitter's "mine" tab shows the approval at every step, unlike todo.
  await page.getByTestId('actor-select').selectOption('u-rep-01');
  await page.getByTestId('tab-mine').click();
  await expect(page.getByTestId('tab-result')).toContainText('u-rep-01');
  await expect(page.getByTestId('approval-status-apr_0001')).toContainText('pending');
  await expect(page.getByTestId('current-approver-apr_0001')).toHaveText('u-mgr-01');
  await expect(page.getByTestId('steps-apr_0001')).toContainText('1:approved');

  // The club manager now sees it in todo and gives the final approval.
  await page.getByTestId('actor-select').selectOption('u-mgr-01');
  await page.getByTestId('tab-todo').click();
  await expect(page.getByTestId('tab-result')).toContainText('u-mgr-01');
  await expect(page.getByTestId('approval-row-apr_0001')).toBeVisible();
  await page.getByTestId('approve-apr_0001').click();

  await page.getByTestId('actor-select').selectOption('u-rep-01');
  await page.getByTestId('tab-mine').click();
  await expect(page.getByTestId('approval-status-apr_0001')).toContainText('approved');
  await expect(page.getByTestId('quote-status-Q-1003')).toContainText('approved');
  await expect(page.getByTestId('events-table')).toContainText('quote.approved');
});

test('UI demo shows rep auto-approval and the frozen-clock manager notification', async ({ page, request }) => {
  await reset(request);
  await page.goto('/');

  await page.getByTestId('submit-Q-1001').click();
  // A terminal rep approval is not in anyone's todo tab; mine shows it.
  await page.getByTestId('tab-mine').click();
  await expect(page.getByTestId('approval-status-apr_0001')).toContainText('approved');
  await expect(page.getByTestId('steps-apr_0001')).toContainText('1:approved');

  await page.getByTestId('set-now').fill('2026-11-24T00:00:00.000Z');
  await page.getByTestId('set-now-btn').click();
  await expect(page.getByTestId('clock-msg')).toContainText('2026-11-24');

  await page.getByTestId('submit-Q-1003').click();
  await page.getByTestId('set-now').fill('2026-11-26T01:00:00.000Z');
  await page.getByTestId('set-now-btn').click();
  await page.getByTestId('run-reminder').click();

  await expect(page.getByTestId('reminder-result')).toContainText('会所经理通知 1');
  await expect(page.getByTestId('notifications-table')).toContainText('u-mgr-01');
  await expect(page.getByTestId('notifications-count')).toContainText('2');
});
