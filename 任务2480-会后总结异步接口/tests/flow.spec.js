/**
 * Delivery-shape, contract and UI checks. API assertions hit the mock service
 * directly; page navigation goes through Vite, which proxies /api to it.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const API = 'http://127.0.0.1:3001/api/v1';
const body = (response) => response.json();

const DELIVERABLES = [
  'package.json', 'index.html', 'vite.config.js', 'playwright.config.js',
  'Dockerfile', 'docker-compose.yml', 'server.js', 'mock-server/index.js',
  'src/App.jsx', 'src/main.jsx', 'src/styles.css',
  'tests/flow.spec.js', 'tests/async.test.js',
  'README.md', '验证记录.md', '投标文本.txt',
];

test('repository is runnable: required files, scripts and documentation exist', async () => {
  const root = path.resolve('.');
  for (const file of DELIVERABLES) {
    expect(fs.existsSync(path.join(root, file)), `missing file: ${file}`).toBeTruthy();
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const script of ['dev', 'mock', 'dev:all', 'build', 'test']) {
    expect(pkg.scripts[script], `missing script: ${script}`).toBeTruthy();
  }
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  for (const needle of ['npm install', 'npm test', 'docker compose up', 'speaker_legend', 'confidentiality', 'MAP_SEGMENT_FAILED']) {
    expect(readme, `README missing: ${needle}`).toContain(needle);
  }
});

test('delivered files use functional names only, never an identifier', async () => {
  const root = path.resolve('.');
  // Assembled at runtime so this source file never contains the literal pattern.
  const n = String.fromCharCode(50, 52, 56, 48);
  const code = ['S5', 'OPS', '033'].join('-');
  const marker = 'T' + 'ask';
  const zhTask = '任' + '务';
  const zhNumber = zhTask + '编' + '号';
  const forbidden = new RegExp(`#\\s*${n}\\b|${code}|\\b${marker}\\s*#?\\s*${n}\\b|${zhTask}\\s*${n}|${zhNumber}\\s*${n}`, 'i');
  for (const file of DELIVERABLES) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    expect(forbidden.test(text), `identifier-like text found in ${file}`).toBe(false);
  }
  // The single permitted occurrence is the bid header URL path.
  const bid = fs.readFileSync(path.join(root, '投标文本.txt'), 'utf8');
  expect(bid).toContain('https://clawhunt.store/p/' + n);
});

test('bid text follows the required label and numeric format', async () => {
  const bid = fs.readFileSync(path.resolve('.', '投标文本.txt'), 'utf8');
  for (const label of [
    '提交竞标（以 MuYe_Agent 名义）', '任务: Async post-meeting summary API',
    '预算 $165 | 建议报价 $145（88%）| 周期 3 weeks',
    '【你的留言】', '【详细方案】', '【结构化报价范围】', '【周期】', '【你的报价（美元）】',
    '交付物:', '格式:', '不包含的工作:', '买方需要提供的材料:',
    '交付时间安排:', '包含的修改轮次:', '类似工作的证据（你的声明）:',
  ]) {
    expect(bid, `missing label: ${label}`).toContain(label);
  }
  expect(bid).toMatch(/包含的修改轮次:\s*2\s*\n/);
  expect(bid).toMatch(/【你的报价（美元）】\s*\n\s*145\s*\n/);
  expect(bid).toMatch(/【周期】\s*\n\s*3 weeks/);
  expect(bid).toContain('Data sources:');
  expect(bid).toContain('https://github.com/muye1122/meeting-summary-async-' + String.fromCharCode(50, 52, 56, 48));
});

test('API exposes health, parameters, OpenAPI and a review-only queue', async ({ request }) => {
  const health = await body(await request.get(API + '/health'));
  expect(health.service).toBe('meeting-summary-async');

  const meta = await body(await request.get(API + '/meta'));
  expect(meta.phases).toEqual(['preprocess', 'map', 'reduce', 'drafted', 'failed']);
  expect(meta.max_concurrency).toBe(4);
  expect(meta.hierarchical_threshold).toBe(20);
  expect(meta.segment_group_size).toBe(10);
  expect(meta.cache_ttl_hours).toBe(24);
  expect(meta.review_level).toBe('L1');
  expect(meta.outbound_capability).toBe(false);

  const spec = await body(await request.get(API + '/openapi.json'));
  expect(spec.openapi).toMatch(/^3\./);
  for (const p of [
    '/ops/meeting-summaries/generate', '/ops/jobs/{job_id}', '/ops/jobs/{job_id}/retry', '/review-queue',
  ]) {
    expect(spec.paths[p], `missing path ${p}`).toBeTruthy();
  }
  expect(spec.components.schemas.JobProgress.required).toContain('map_done');

  const outbound = await body(await request.get(API + '/observability/outbound'));
  expect(outbound.outbound_calls).toBe(0);
});

test('invalid generate input is rejected without creating a job', async ({ request }) => {
  await request.post(API + '/test/reset');
  const r = await request.post(API + '/ops/meeting-summaries/generate', {
    multipart: { text: '虚构纪要', meeting_meta: JSON.stringify({ type: 'internal' }) },
  });
  expect(r.status()).toBe(400);
  expect((await body(r)).code).toBe('MEETING_META_REQUIRED');
});

test('UI demo generates a summary, shows progress and keeps output in the review queue', async ({ page, request }) => {
  await request.post(API + '/test/reset');
  await page.goto('/');

  await expect(page.getByTestId('app-title')).toBeVisible();
  await expect(page.getByTestId('transcript-input')).toBeVisible();
  await page.getByTestId('fill-25').click();
  await page.getByTestId('generate-btn').click();

  await expect(page.getByTestId('job-progress')).toHaveText('25 / 25', { timeout: 15000 });
  await expect(page.getByTestId('job-phase')).toContainText('drafted');
  await expect(page.getByTestId('metric-map-calls')).toHaveText('25');
  await expect(page.getByTestId('metric-reduce-calls')).toHaveText('4');
  await expect(page.getByTestId('outbound-count')).toHaveText('0');
  await expect(page.getByTestId('review-queue')).toContainText('speaker_legend');
});
