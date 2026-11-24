import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// API assertions use the mock service directly; the page is served by Vite,
// which proxies /api to the same service.
const API = 'http://127.0.0.1:3001/api/sales';
const DIRECTOR = 'actor-director';
const MANAGER_A = 'actor-manager-a';
const MANAGER_B = 'actor-manager-b';
const CONSULTANT_1 = 'actor-consultant-1';
const CONSULTANT_2 = 'actor-consultant-2';

const reset = async (request) => {
  const response = await request.post(API + '/test/reset');
  expect(response.ok()).toBeTruthy();
};
const json = (response) => response.json();
const claim = (request, handoverId, actor) => request.post(`${API}/handovers/${handoverId}/claim`, { data: { actor } });

test('delivery is runnable: required files, scripts and documented integration point exist', async () => {
  const root = path.resolve('.');
  const required = [
    'package.json', 'index.html', 'vite.config.js', 'playwright.config.js',
    'Dockerfile', 'docker-compose.yml', 'server.js',
    'mock-server/index.js', 'mock-server/outbox.js',
    'src/App.jsx', 'src/main.jsx', 'src/styles.css',
    'tests/flow.spec.js', 'tests/handover.test.js',
    'README.md', '验证记录.md', '投标文本.txt',
  ];
  for (const file of required) {
    expect(fs.existsSync(path.join(root, file)), `missing file: ${file}`).toBeTruthy();
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const script of ['dev', 'mock', 'dev:all', 'build', 'test', 'test:unit', 'test:e2e']) {
    expect(pkg.scripts[script], `missing script: ${script}`).toBeTruthy();
  }
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  for (const marker of ['npm install', 'npm test', 'docker compose up', 'contract_id', 'Integration point']) {
    expect(readme.includes(marker), `README missing marker: ${marker}`).toBeTruthy();
  }
});

// ------------------------------------------------------------
// Acceptance 1: incomplete package -> 422 HANDOVER_INCOMPLETE + missing items
// ------------------------------------------------------------
test('acceptance 1: claiming an incomplete handover returns 422 and lists missing fields', async ({ request }) => {
  await reset(request);
  const response = await claim(request, 'ho-1002', MANAGER_A);
  expect(response.status()).toBe(422);
  const data = await json(response);
  expect(data.code).toBe('HANDOVER_INCOMPLETE');
  expect(data.missing_fields).toContain('contact_phone');
  expect(data.missing_fields).toContain('planned_onboarding_date');
  expect(data.missing_labels).toContain('联系人电话');
  expect((await json(await request.get(`${API}/handovers/ho-1002?actor=${MANAGER_A}`))).status).toBe('pending_claim');
});

// ------------------------------------------------------------
// Acceptance 2: two concurrent claims -> exactly one winner, one 409
// ------------------------------------------------------------
test('acceptance 2: concurrent claims yield exactly one success and one 409', async ({ request }) => {
  await reset(request);
  await request.post(API + '/test/claim-yield', { data: { ms: 25 } });
  const responses = await Promise.all([
    claim(request, 'ho-1001', MANAGER_A),
    claim(request, 'ho-1001', MANAGER_B),
  ]);
  const statuses = responses.map((response) => response.status()).sort();
  expect(statuses).toEqual([200, 409]);
  const winner = await json(responses.find((response) => response.status() === 200));
  expect([MANAGER_A, MANAGER_B]).toContain(winner.claimed_by);
  const loser = await json(responses.find((response) => response.status() === 409));
  expect(['VERSION_CONFLICT', 'ALREADY_CLAIMED']).toContain(loser.code);

  const detail = await json(await request.get(`${API}/handovers/ho-1001?actor=${DIRECTOR}`));
  expect(detail.status).toBe('claimed');
  expect(detail.claimed_by).toBe(winner.claimed_by);
  const outbox = await json(await request.get(API + '/outbox'));
  expect(outbox.total).toBe(1);
  expect(outbox.rows[0].external_ref).toBe('CTR-2026-1001');
});

// ------------------------------------------------------------
// Acceptance 3: designated manager A only; B gets 403
// ------------------------------------------------------------
test('acceptance 3: a handover assigned to manager A cannot be claimed by manager B', async ({ request }) => {
  await reset(request);
  const forbidden = await claim(request, 'ho-1003', MANAGER_B);
  expect(forbidden.status()).toBe(403);
  expect((await json(forbidden)).code).toBe('NOT_ASSIGNED_MANAGER');

  const allowed = await claim(request, 'ho-1003', MANAGER_A);
  expect(allowed.status()).toBe(200);
  expect((await json(allowed)).claimed_by).toBe(MANAGER_A);
});

// ------------------------------------------------------------
// Acceptance 4: five stub failures -> crm_sync_status failed + lead notification
// ------------------------------------------------------------
test('acceptance 4: five CRM stub failures mark the sync failed and notify the technical lead', async ({ request }) => {
  await reset(request);
  await request.post(API + '/test/crm-failures', { data: { count: 5 } });
  const claimed = await claim(request, 'ho-1001', MANAGER_A);
  expect(claimed.status()).toBe(200);
  // Flush the first (immediate) delivery attempt, then walk the 1/5/30/30 backoff.
  const firstFlush = await request.post(API + '/test/advance', { data: { ms: 0 } });
  expect(firstFlush.ok()).toBeTruthy();

  for (const minutes of [1, 5, 30, 30]) {
    const flushed = await request.post(API + '/test/advance', { data: { ms: minutes * 60_000 } });
    expect(flushed.ok()).toBeTruthy();
  }

  const detail = await json(await request.get(`${API}/handovers/ho-1001?actor=${MANAGER_A}`));
  expect(detail.crm_sync_status).toBe('failed');
  expect(detail.crm_sync_attempts).toBe(5);
  const outbox = await json(await request.get(API + '/outbox'));
  expect(outbox.rows[0].status).toBe('failed');
  expect(outbox.rows[0].attempts).toBe(5);
  const notifications = await json(await request.get(API + '/notifications'));
  const failureNotice = notifications.notifications.find((note) => note.type === 'crm_sync_failed');
  expect(failureNotice).toBeTruthy();
  expect(failureNotice.recipient_id).toBe('actor-tech-lead');
  expect(failureNotice.message).toContain('CTR-2026-1001');
});

// ------------------------------------------------------------
// Role-scoped listing, package patch, return and notifications
// ------------------------------------------------------------
test('role-scoped lists, package recompute, auto return to pending_claim and consultant notification', async ({ request }) => {
  await reset(request);
  const listFor = async (actor, status = '') => json(await request.get(
    `${API}/handovers?actor=${actor}${status ? `&status=${status}` : ''}`,
  ));
  const directorList = await listFor(DIRECTOR);
  expect(directorList.handovers.map((item) => item.id).sort())
    .toEqual(['ho-1001', 'ho-1002', 'ho-1003', 'ho-1004', 'ho-1006']);
  const managerList = await listFor(MANAGER_A, 'pending_claim');
  expect(managerList.handovers.map((item) => item.id).sort()).toEqual(['ho-1001', 'ho-1002', 'ho-1003']);
  const consultantList = await listFor(CONSULTANT_2);
  expect(consultantList.handovers.map((item) => item.id).sort()).toEqual(['ho-1002', 'ho-1004']);

  const forbiddenPatch = await request.patch(`${API}/handovers/ho-1004/package`, {
    data: { actor: MANAGER_A, package: { contact_phone: '13900000004' } },
  });
  expect(forbiddenPatch.status()).toBe(403);

  const patched = await request.patch(`${API}/handovers/ho-1004/package`, {
    data: { actor: CONSULTANT_2, package: { contact_phone: '13900000004' } },
  });
  expect(patched.status()).toBe(200);
  const patchedData = await json(patched);
  expect(patchedData.missing_fields).toEqual([]);
  expect(patchedData.auto_returned_to_pending_claim).toBe(true);
  expect(patchedData.to).toBe('pending_claim');

  const shortReturn = await request.post(`${API}/handovers/ho-1001/return`, { data: { actor: MANAGER_A, reason: '太短' } });
  expect(shortReturn.status()).toBe(422);
  expect((await json(shortReturn)).code).toBe('REASON_TOO_SHORT');

  const returned = await request.post(`${API}/handovers/ho-1001/return`, {
    data: { actor: MANAGER_A, reason: '联系人电话无法接通，请补充有效号码后再领取' },
  });
  expect(returned.status()).toBe(200);
  const returnedData = await json(returned);
  expect(returnedData.to).toBe('returned_for_info');
  expect(returnedData.notification.recipient_id).toBe(CONSULTANT_1);
  const notes = await json(await request.get(API + '/notifications'));
  expect(notes.notifications.some((note) => note.type === 'return_for_info' && note.recipient_id === CONSULTANT_1)).toBe(true);
});

// ------------------------------------------------------------
// Assign restrictions, happy-path CRM sync (idempotent stub) and OpenAPI
// ------------------------------------------------------------
test('assign constraints, successful CRM upsert and OpenAPI description', async ({ request }) => {
  await reset(request);
  const wrongRole = await request.post(`${API}/handovers/ho-1001/assign`, { data: { actor: MANAGER_A, manager_id: MANAGER_B } });
  expect(wrongRole.status()).toBe(403);
  const wrongTarget = await request.post(`${API}/handovers/ho-1001/assign`, { data: { actor: DIRECTOR, manager_id: 'actor-manager-c' } });
  expect(wrongTarget.status()).toBe(422);
  const assigned = await request.post(`${API}/handovers/ho-1001/assign`, { data: { actor: DIRECTOR, manager_id: MANAGER_B } });
  expect(assigned.status()).toBe(200);
  const assignedData = await json(assigned);
  expect(assignedData.claim_completed).toBe(false);
  expect(assignedData.status).toBe('pending_claim');

  const claimed = await claim(request, 'ho-1001', MANAGER_B);
  expect(claimed.status()).toBe(200);
  const flushed = await request.post(API + '/test/advance', { data: { ms: 0 } });
  expect(flushed.ok()).toBeTruthy();
  const crm = await json(await request.get(API + '/crm-records'));
  expect(crm.total).toBe(1);
  expect(crm.records[0].external_ref).toBe('CTR-2026-1001');
  expect(crm.records[0].contract_no).toBe('HT-2026-0001');
  expect(crm.records[0].manager_assignment.manager_id).toBe(MANAGER_B);
  const detail = await json(await request.get(`${API}/handovers/ho-1001?actor=${MANAGER_B}`));
  expect(detail.crm_sync_status).toBe('synced');

  const spec = await json(await request.get(API + '/openapi.json'));
  expect(spec.openapi).toBe('3.0.3');
  expect(Object.keys(spec.paths)).toContain('/handovers/{hid}/claim');
});

// ------------------------------------------------------------
// Demo page smoke test: the UI can drive a real claim
// ------------------------------------------------------------
test('demo page shows the handover workbench and claims a handover', async ({ page, request }) => {
  await reset(request);
  await page.goto('/');
  const list = page.getByTestId('handover-list');
  await expect(list).toBeVisible();
  await expect(list).toContainText('ho-1001');

  await page.getByTestId('handover-open-ho-1001').click();
  await expect(page.getByTestId('detail-id')).toHaveText('ho-1001');
  await page.getByTestId('action-claim').click();
  await expect(page.getByTestId('action-msg')).toContainText('claimed');

  const detail = await json(await request.get(`${API}/handovers/ho-1001?actor=${MANAGER_A}`));
  expect(detail.status).toBe('claimed');
});
