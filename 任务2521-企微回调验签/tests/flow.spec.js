import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(fs.readFileSync(path.join(dirname, '..', 'data', 'test-vectors.json'), 'utf8'));
const { token, encodingAesKey } = vectors.config;
const ALL_EVENTS = ['change_contact', 'add_external_contact', 'del_external_contact', 'edit_external_contact'];

const qs = (query) => new URLSearchParams(query).toString();
const endpoint = (query) => `/api/wecom/callback?${qs(query)}`;
const encryptedField = (body) => /<Encrypt><!\[CDATA\[([\s\S]*?)\]\]><\/Encrypt>/.exec(body)?.[1] || '';
const handSign = (query, ciphertext) => crypto.createHash('sha1')
  .update([token, String(query.timestamp), query.nonce, ciphertext].sort().join(''), 'utf8')
  .digest('hex');

const makeCallback = (request, payload) => request.post('/api/wecom/_test/make-callback', { data: payload || {} });
const postCallback = (request, envelope, query) => request.post(endpoint(query || envelope.query), {
  headers: { 'content-type': 'text/xml' },
  data: envelope.body,
});
const eventsOf = async (request) => (await (await request.get('/api/wecom/_test/events')).json());
const logsOf = async (request) => (await (await request.get('/api/wecom/_test/logs')).json()).logs;

test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/wecom/_test/reset')).ok()).toBeTruthy();
});

test('健康检查与元信息暴露回调契约，演示界面可加载', async ({ request, page }) => {
  const health = await (await request.get('/api/wecom/health')).json();
  expect(health.ok).toBe(true);
  expect(health.service).toBe('wecom-callback-poc');
  expect(health.event_rows).toBe(0);

  const meta = await (await request.get('/api/wecom/meta')).json();
  expect(meta.supported_events).toEqual(ALL_EVENTS);
  expect(meta.config_source).toContain('environment variables');
  expect(meta.timestamp_window_sec).toBe(300);

  await page.goto('/');
  await expect(page.getByTestId('tab-verify')).toBeVisible();
  await expect(page.getByTestId('panel-verify')).toBeVisible();
});

test('地址验证：验签通过后解密 echostr 并返回原文', async ({ request }) => {
  const envelope = await (await request.post('/api/wecom/_test/make-url-check', { data: {} })).json();
  expect(handSign(envelope.query, envelope.query.echostr)).toBe(envelope.query.msg_signature);

  const res = await request.get(endpoint(envelope.query));
  expect(res.status()).toBe(200);
  expect(await res.text()).toBe('fictional-url-verification-echo');

  const bad = await request.get(endpoint({ ...envelope.query, msg_signature: '0'.repeat(40) }));
  expect(bad.status()).toBe(403);
  expect((await bad.json()).code).toBe('FORBIDDEN');
});

test('错误签名与超过 300 秒的时间偏差都返回 403，且不解密不入库', async ({ request }) => {
  const envelope = await (await makeCallback(request, { event_type: 'change_contact' })).json();

  const badSignature = await postCallback(request, envelope, { ...envelope.query, msg_signature: '0'.repeat(40) });
  expect(badSignature.status()).toBe(403);
  expect((await badSignature.json()).code).toBe('FORBIDDEN');

  const staleTimestamp = String(Math.floor(Date.now() / 1000) - 400);
  const stale = await (await makeCallback(request, { event_type: 'change_contact', timestamp: staleTimestamp })).json();
  expect(handSign(stale.query, encryptedField(stale.body))).toBe(stale.query.msg_signature);
  const staleResult = await postCallback(request, stale);
  expect(staleResult.status()).toBe(403);
  expect((await staleResult.json()).code).toBe('FORBIDDEN');

  const logs = await logsOf(request);
  expect(logs.some((l) => l.code === 'signature_rejected')).toBe(true);
  expect(logs.some((l) => l.code === 'timestamp_rejected' && l.delta > 300)).toBe(true);
  expect(logs.some((l) => l.code === 'event_decrypt_failed')).toBe(false);
  expect(logs.some((l) => l.code === 'url_decrypt_failed')).toBe(false);
  expect((await eventsOf(request)).rows).toHaveLength(0);
});

test('同一事件推送三次只入库一条，且只处理一次', async ({ request }) => {
  const envelope = await (await makeCallback(request, {
    event_type: 'change_contact', marker: 'dedup-marker-D9F2',
  })).json();
  expect(handSign(envelope.query, encryptedField(envelope.body))).toBe(envelope.query.msg_signature);

  const statuses = [];
  for (let i = 0; i < 3; i += 1) {
    const res = await postCallback(request, envelope);
    expect(res.status()).toBe(200);
    statuses.push((await res.json()).status);
  }
  expect(statuses).toEqual(['processed', 'duplicate', 'duplicate']);

  const table = await eventsOf(request);
  expect(table.rows).toHaveLength(1);
  expect(table.processed_count).toBe(1);
  expect(table.rows[0].status).toBe('processed');
  expect(table.rows[0].event_type).toBe('change_contact');
  expect(JSON.parse(table.rows[0].payload_json).Name).toBe('dedup-marker-D9F2');

  const processedAt = table.rows[0].processed_at;
  await postCallback(request, envelope);
  const after = await eventsOf(request);
  expect(after.rows).toHaveLength(1);
  expect(after.processed_count).toBe(1);
  expect(after.rows[0].processed_at).toBe(processedAt);
  expect(after.rows[0].received_at).toBe(table.rows[0].received_at);

  const accepted = (await logsOf(request)).filter((l) => l.code === 'event_accepted');
  expect(accepted.filter((l) => l.row_status === 'processed')).toHaveLength(1);
  expect(accepted.filter((l) => l.row_status === 'duplicate')).toHaveLength(3);
});

test('四类事件都解析为结构化事件记录', async ({ request }) => {
  for (const eventType of ALL_EVENTS) {
    const envelope = await (await makeCallback(request, { event_type: eventType })).json();
    const res = await postCallback(request, envelope);
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe('processed');
  }
  const table = await eventsOf(request);
  expect(table.rows).toHaveLength(4);
  expect(table.rows.map((r) => r.event_type).sort()).toEqual(ALL_EVENTS.slice().sort());
  for (const row of table.rows) {
    expect(row.dedup_key).toMatch(/^evt_[0-9a-f]{64}$/);
    expect(JSON.parse(row.payload_json).Event).toBe(row.event_type);
  }
});

test('receiveid 与配置不符时拒绝推送', async ({ request }) => {
  const envelope = await (await makeCallback(request, {
    event_type: 'change_contact', receiveid: 'wwWrongCorp',
  })).json();
  const res = await postCallback(request, envelope);
  expect(res.status()).toBe(403);
  expect((await logsOf(request)).some((l) => l.code === 'receiveid_mismatch')).toBe(true);
  expect((await eventsOf(request)).rows).toHaveLength(0);
});

test('日志不含明文消息体、密文、Token 或 EncodingAESKey', async ({ request }) => {
  const marker = 'UNIQUE_SECRET_MARKER_7f3a91c4';
  const envelope = await (await makeCallback(request, {
    event_type: 'change_contact', marker,
  })).json();
  expect((await postCallback(request, envelope)).status()).toBe(200);
  await postCallback(request, envelope, { ...envelope.query, msg_signature: '0'.repeat(40) });

  const table = await eventsOf(request);
  expect(JSON.parse(table.rows[0].payload_json).Name).toBe(marker);

  const logText = JSON.stringify(await logsOf(request));
  expect(logText).toContain('event_accepted');
  expect(logText).not.toContain(marker);
  expect(logText).not.toContain(encodingAesKey);
  expect(logText).not.toContain(token);
  expect(logText).not.toContain(encryptedField(envelope.body));
});

test('演示界面：重复推送显示去重结果，事件表只有一行', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-verify').click();
  await page.getByTestId('push-thrice').click();
  await expect(page.getByTestId('push-result')).toContainText('duplicate');
  await expect(page.getByTestId('row-count')).toContainText('1');
  await page.getByTestId('tab-events').click();
  await expect(page.getByTestId('event-row')).toHaveCount(1);
});

test('演示界面：地址验证与安全自检均显示 PASS', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-verify').click();
  await page.getByTestId('url-check').click();
  await expect(page.getByTestId('url-check-result')).toContainText('PASS');

  await page.getByTestId('tab-security').click();
  await expect(page.getByTestId('selftest-result')).toContainText('PASS');
  await expect(page.getByTestId('log-safe')).toContainText('PASS');
});
