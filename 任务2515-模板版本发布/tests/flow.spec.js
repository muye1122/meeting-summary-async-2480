import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// API assertions hit the mock service directly; Vite proxies the page's
// /api calls to the same service.
const API = 'http://127.0.0.1:3001/api/sop';
const TPL = 'tpl-intake-review';

const json = (r) => r.json();
const reset = async (request) => {
  const r = await request.post(API + '/test/reset');
  expect(r.ok()).toBeTruthy();
};
const step3Hours = (instance) => instance.template_snapshot.find((s) => s.id === 'step-3')?.time_limit_hours;

const draftSteps = async (request) => (await json(await request.get(`${API}/templates/${TPL}`))).template.draft.steps;

const setDraftSteps = async (request, steps) => {
  const r = await request.put(`${API}/templates/${TPL}/draft`, { data: { steps } });
  expect(r.status()).toBe(200);
  return json(r);
};

const setStep3Hours = async (request, hours) => setDraftSteps(request,
  (await draftSteps(request)).map((s) => (s.id === 'step-3' ? { ...s, time_limit_hours: hours } : s)));

const publish = async (request, release_notes) => {
  const r = await request.post(`${API}/templates/${TPL}/publish`, { data: { release_notes } });
  return { status: r.status(), data: await json(r) };
};

const trigger = async (request) => {
  const r = await request.post(`${API}/templates/${TPL}/instances`, { data: {} });
  return { status: r.status(), data: await json(r) };
};

const detailInstance = async (request, id) => (await json(await request.get(`${API}/instances/${id}`))).instance;

// ------------------------------------------------------------
// Delivery structure
// ------------------------------------------------------------
test('delivery is runnable: required files and scripts exist', async () => {
  const root = path.resolve('.');
  const required = [
    'package.json', 'index.html', 'vite.config.js', 'playwright.config.js',
    'Dockerfile', 'docker-compose.yml', 'server.js',
    'mock-server/index.js', 'mock-server/diff.js',
    'src/App.jsx', 'src/main.jsx', 'src/styles.css',
    'tests/flow.spec.js', 'tests/version.test.js',
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
  expect(readme).toContain('docker compose up');
  expect(readme).toContain('npm install');
  expect(readme).toContain('npm test');
});

// ------------------------------------------------------------
// Acceptance 1: v1 instance keeps its time limit after v2 is published
// ------------------------------------------------------------
test('acceptance 1: v1 instance keeps old step-3 limit, new instance uses v2', async ({ request }) => {
  await reset(request);

  const first = await publish(request, '首次发布：示例基线版本');
  expect(first.status, JSON.stringify(first.data)).toBe(200);
  expect(first.data.version.version_no).toBe(1);
  expect(first.data.version.steps.find((s) => s.id === 'step-3').time_limit_hours).toBe(48);

  const created = await trigger(request);
  expect(created.status).toBe(201);
  const instanceV1 = created.data.instance;
  expect(instanceV1.template_version).toBe(1);
  expect(step3Hours(instanceV1)).toBe(48);

  // Draft edit alone must not leak into an existing instance or a new instance.
  await setStep3Hours(request, 24);
  expect(step3Hours(await detailInstance(request, instanceV1.id))).toBe(48);
  const beforePublish = await trigger(request);
  expect(beforePublish.data.instance.template_version).toBe(1);
  expect(step3Hours(beforePublish.data.instance)).toBe(48);

  const second = await publish(request, '收紧第三步风控时限至 24 小时');
  expect(second.status, JSON.stringify(second.data)).toBe(200);
  expect(second.data.version.version_no).toBe(2);

  // The running v1 instance is frozen to its snapshot.
  const afterV2 = await detailInstance(request, instanceV1.id);
  expect(afterV2.template_version).toBe(1);
  expect(step3Hours(afterV2)).toBe(48);
  expect(afterV2.template_snapshot_digest).toBe(instanceV1.template_snapshot_digest);

  // A brand-new instance picks up the latest published version.
  const newInstance = await trigger(request);
  expect(newInstance.status).toBe(201);
  expect(newInstance.data.instance.template_version).toBe(2);
  expect(step3Hours(newInstance.data.instance)).toBe(24);

  // Executing a step of the v1 instance still reads its own snapshot.
  const stepped = await request.post(`${API}/instances/${instanceV1.id}/steps/step-3/complete`, { data: {} });
  expect(stepped.status()).toBe(200);
  expect(step3Hours((await stepped.json()).instance)).toBe(48);
});

// ------------------------------------------------------------
// Acceptance 2: disable rejects new triggers, running instances finish
// ------------------------------------------------------------
test('acceptance 2: after disable new triggers are rejected, existing instances complete', async ({ request }) => {
  await reset(request);
  const published = await publish(request, '发布基线版本以创建实例');
  expect(published.status).toBe(200);

  const created = await trigger(request);
  expect(created.status).toBe(201);
  const running = created.data.instance;
  expect(running.status).toBe('running');

  const disabled = await request.post(`${API}/templates/${TPL}/disable`, { data: { reason: '示例模板停用' } });
  expect(disabled.status()).toBe(200);
  const disabledData = await json(disabled);
  expect(disabledData.template.status).toBe('disabled');
  expect(disabledData.running_instances).toBe(1);

  const rejected = await trigger(request);
  expect(rejected.status).toBe(409);
  expect(rejected.data.code).toBe('TEMPLATE_DISABLED');

  // Publishing a disabled template is rejected too.
  const republish = await publish(request, '停用后不应可发布');
  expect(republish.status).toBe(409);
  expect(republish.data.code).toBe('TEMPLATE_DISABLED');

  // A running instance is independent of the template state and can finish.
  for (const step of running.steps) {
    const r = await request.post(`${API}/instances/${running.id}/steps/${step.id}/complete`, { data: {} });
    expect(r.status(), step.id).toBe(200);
  }
  const done = await detailInstance(request, running.id);
  expect(done.status).toBe('completed');
  expect(done.completed_at).not.toBeNull();
  expect(done.steps.every((s) => s.status === 'done')).toBe(true);
  expect(step3Hours(done)).toBe(48);
});

// ------------------------------------------------------------
// Acceptance 3: empty release_notes returns 422
// ------------------------------------------------------------
test('acceptance 3: empty or whitespace release_notes returns 422 and writes no audit', async ({ request }) => {
  await reset(request);

  for (const notes of [undefined, '', '   \n  ']) {
    const r = await request.post(`${API}/templates/${TPL}/publish`, {
      data: notes === undefined ? {} : { release_notes: notes },
    });
    expect(r.status(), JSON.stringify(notes)).toBe(422);
    const data = await json(r);
    expect(data.code).toBe('RELEASE_NOTES_REQUIRED');
  }

  const emptyAudit = await json(await request.get(API + '/audit'));
  expect(emptyAudit.total).toBe(0);

  const ok = await publish(request, '有效的发布说明');
  expect(ok.status).toBe(200);
  expect(ok.data.version.release_notes).toBe('有效的发布说明');

  const audit = await json(await request.get(API + '/audit'));
  expect(audit.total).toBe(1);
});

// ------------------------------------------------------------
// Acceptance 4: audit records carry added/removed/modified diff summaries
// ------------------------------------------------------------
test('acceptance 4: publish and disable audit records contain a diff summary', async ({ request }) => {
  await reset(request);

  // v1: all four steps are additions relative to "no previous version".
  const first = await publish(request, '基线：四个示例步骤');
  expect(first.status).toBe(200);
  expect(first.data.diff.added).toHaveLength(4);

  // v2: delete step-4, add step-5, modify step-3 time limit.
  const steps = (await draftSteps(request)).filter((s) => s.id !== 'step-4');
  steps.find((s) => s.id === 'step-3').time_limit_hours = 24;
  steps.push({ id: 'step-5', title: '新增示例步骤', description: '新增', assignee_role: '运营助理', time_limit_hours: 8 });
  await setDraftSteps(request, steps);

  const second = await publish(request, '删除归档步骤、新增步骤并收紧风控时限');
  expect(second.status, JSON.stringify(second.data)).toBe(200);
  expect(second.data.version.version_no).toBe(2);

  // Stub assertion: the in-memory audit store exposes both the raw diff and
  // the structured diff_summary with all three step categories.
  const audit = await json(await request.get(`${API}/audit?category=template_publish`));
  expect(audit.total).toBe(2);
  const latest = audit.records[audit.records.length - 1];

  expect(latest.action).toBe('publish');
  expect(latest.from_version).toBe(1);
  expect(latest.to_version).toBe(2);
  expect(Array.isArray(latest.diff.added)).toBe(true);
  expect(Array.isArray(latest.diff.removed)).toBe(true);
  expect(Array.isArray(latest.diff.modified)).toBe(true);

  expect(latest.diff_summary.added.map((s) => s.id)).toContain('step-5');
  expect(latest.diff_summary.removed.map((s) => s.id)).toContain('step-4');
  expect(latest.diff_summary.modified).toEqual([{
    id: 'step-3',
    fields: ['time_limit_hours'],
    changes: [{ field: 'time_limit_hours', before: 48, after: 24 }],
  }]);
  expect(latest.diff_summary.text).toContain('新增 1 步');
  expect(latest.diff_summary.text).toContain('删除 1 步');
  expect(latest.diff_summary.text).toContain('修改 1 步');

  // Disable also writes an audit record with a three-category diff summary
  // (empty here, because disabling does not change any step).
  await request.post(`${API}/templates/${TPL}/disable`, { data: {} });
  const disableAudit = await json(await request.get(`${API}/audit?category=template_disable`));
  expect(disableAudit.total).toBe(1);
  const disableRecord = disableAudit.records[0];
  expect(disableRecord.diff_summary.added).toEqual([]);
  expect(disableRecord.diff_summary.removed).toEqual([]);
  expect(disableRecord.diff_summary.modified).toEqual([]);
  expect(disableRecord.diff_summary.text).toContain('新增 0 步');
  expect(disableRecord.diff_summary.text).toContain('删除 0 步');
  expect(disableRecord.diff_summary.text).toContain('修改 0 步');
});

// ------------------------------------------------------------
// Extra validation: incomplete drafts cannot be published
// ------------------------------------------------------------
test('publish rejects a template with no steps or an incomplete step', async ({ request }) => {
  await reset(request);

  let r = await request.put(`${API}/templates/${TPL}/draft`, { data: { steps: [] } });
  expect(r.status()).toBe(200);
  let pub = await publish(request, '不应发布成功');
  expect(pub.status).toBe(422);
  expect(pub.data.code).toBe('TEMPLATE_NO_STEPS');

  r = await request.put(`${API}/templates/${TPL}/draft`, { data: { steps: [{ id: 'step-1', title: '缺字段步骤' }] } });
  expect(r.status()).toBe(200);
  pub = await publish(request, '不应发布成功');
  expect(pub.status).toBe(422);
  expect(pub.data.code).toBe('STEP_INCOMPLETE');
  expect(pub.data.invalid.some((e) => e.field === 'assignee_role')).toBe(true);

  const audit = await json(await request.get(API + '/audit'));
  expect(audit.total).toBe(0);
});

// ------------------------------------------------------------
// Demo page smoke test
// ------------------------------------------------------------
test('demo page renders versions, publishes and triggers an instance', async ({ page, request }) => {
  await reset(request);
  await page.goto('/');

  const list = page.getByTestId('template-list');
  await expect(list).toBeVisible();
  await expect(list).toContainText('会员入会资料审核');

  await page.getByTestId('template-open-' + TPL).click();
  await expect(page.getByTestId('draft-hours-step-3')).toHaveValue('48');

  await page.getByTestId('release-notes').fill('页面发布：示例基线');
  await page.getByTestId('publish-btn').click();
  await expect(page.getByTestId('action-msg')).toContainText('发布成功');
  await expect(page.getByTestId('version-row-1')).toBeVisible();

  await page.getByTestId('trigger-btn').click();
  await expect(page.getByTestId('version-row-1')).toContainText('48 小时');

  await page.getByTestId('tab-instances').click();
  const instances = page.getByTestId('instance-list');
  await expect(instances).toBeVisible();
  await expect(instances).toContainText('48 小时');

  const apiInstances = await json(await request.get(`${API}/instances`));
  expect(apiInstances.total).toBe(1);
  expect(apiInstances.instances[0].template_version).toBe(1);
});
