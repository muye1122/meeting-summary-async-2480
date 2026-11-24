import test from 'node:test';
import assert from 'node:assert/strict';

// Importing the service starts it unless this flag is set; this suite only
// needs the pure diff, clone and validation helpers.
process.env.SOP_NO_LISTEN = '1';

const {
  clone, diffSteps, emptyDiff, summarizeDiff, diffSummary,
  validateReleaseNotes, validateTemplateIntegrity, STEP_REQUIRED_FIELDS,
} = await import('../mock-server/index.js');

const V1_STEPS = [
  { id: 'step-1', title: '收集入会申请', description: '收集示例申请表单', assignee_role: '会员经理', time_limit_hours: 24 },
  { id: 'step-2', title: '核验资质材料', description: '核对示例资质文件', assignee_role: '复核专员', time_limit_hours: 36 },
  { id: 'step-3', title: '完成风控校验', description: '运行示例风控规则', assignee_role: '风控专员', time_limit_hours: 48 },
  { id: 'step-4', title: '归档并通知', description: '归档示例结果并通知', assignee_role: '运营助理', time_limit_hours: 12 },
];

test('diffSteps detects added, removed and modified steps with field-level changes', () => {
  const after = clone(V1_STEPS);
  after.find((s) => s.id === 'step-3').time_limit_hours = 24;   // modified
  const removedStep = after.find((s) => s.id === 'step-4');
  const idx = after.indexOf(removedStep);
  if (idx >= 0) after.splice(idx, 1);                           // deleted
  after.push({ id: 'step-5', title: '新增示例步骤', description: '新增', assignee_role: '运营助理', time_limit_hours: 8 });

  const diff = diffSteps(V1_STEPS, after);
  assert.deepEqual(diff.counts, { added: 1, removed: 1, modified: 1 });
  assert.deepEqual(diff.added.map((s) => s.id), ['step-5']);
  assert.deepEqual(diff.removed.map((s) => s.id), ['step-4']);
  assert.equal(diff.modified.length, 1);
  assert.equal(diff.modified[0].id, 'step-3');
  assert.deepEqual(diff.modified[0].changes, [
    { field: 'time_limit_hours', before: 48, after: 24 },
  ]);
});

test('diffSteps is empty for identical versions and summarizeDiff names all three categories', () => {
  const diff = diffSteps(V1_STEPS, clone(V1_STEPS));
  assert.deepEqual(diff.counts, { added: 0, removed: 0, modified: 0 });
  assert.deepEqual(emptyDiff(), diff);
  const text = summarizeDiff(diff);
  assert.match(text, /新增 0 步/);
  assert.match(text, /删除 0 步/);
  assert.match(text, /修改 0 步/);
});

test('diffSummary keeps structured added/removed/modified lists for audit records', () => {
  const after = clone(V1_STEPS);
  after.find((s) => s.id === 'step-3').time_limit_hours = 24;
  const diff = diffSteps(V1_STEPS, after);
  const summary = diffSummary(diff, { from_version: 1, to_version: 2 });

  assert.equal(summary.from_version, 1);
  assert.equal(summary.to_version, 2);
  assert.deepEqual(summary.added, []);
  assert.deepEqual(summary.removed, []);
  assert.deepEqual(summary.modified, [{
    id: 'step-3',
    fields: ['time_limit_hours'],
    changes: [{ field: 'time_limit_hours', before: 48, after: 24 }],
  }]);
  assert.match(summary.text, /修改 1 步/);
  assert.match(summary.text, /step-3\(time_limit_hours 48 → 24\)/);
});

test('validateReleaseNotes rejects empty and whitespace-only notes', () => {
  assert.equal(validateReleaseNotes(undefined).code, 'RELEASE_NOTES_REQUIRED');
  assert.equal(validateReleaseNotes('').ok, false);
  assert.equal(validateReleaseNotes('   \n  ').code, 'RELEASE_NOTES_REQUIRED');
  assert.deepEqual(validateReleaseNotes('  收紧时限  '), { ok: true, value: '收紧时限' });
});

test('validateTemplateIntegrity enforces at least one step and all required step fields', () => {
  assert.deepEqual(STEP_REQUIRED_FIELDS, ['id', 'title', 'assignee_role', 'time_limit_hours']);

  const empty = validateTemplateIntegrity({ draft: { steps: [] } }, '发布说明');
  assert.equal(empty.code, 'TEMPLATE_NO_STEPS');

  const missing = validateTemplateIntegrity({
    draft: { steps: [{ id: 'step-1', title: '示例步骤', assignee_role: '会员经理' }] },
  }, '发布说明');
  assert.equal(missing.code, 'STEP_INCOMPLETE');
  assert.ok(missing.invalid.some((e) => e.field === 'time_limit_hours' && e.reason === 'required'));

  const badHours = validateTemplateIntegrity({
    draft: { steps: [{ ...V1_STEPS[0], time_limit_hours: -3 }] },
  }, '发布说明');
  assert.equal(badHours.code, 'STEP_INCOMPLETE');
  assert.ok(badHours.invalid.some((e) => e.field === 'time_limit_hours' && e.reason.includes('positive')));

  const noNotes = validateTemplateIntegrity({ draft: { steps: V1_STEPS } }, '');
  assert.equal(noNotes.code, 'RELEASE_NOTES_REQUIRED');

  const ok = validateTemplateIntegrity({ draft: { steps: V1_STEPS } }, '首次发布');
  assert.equal(ok.ok, true);
  assert.equal(ok.step_count, 4);
});

test('clone makes a deep copy so a later draft edit cannot mutate a frozen snapshot', () => {
  const snapshot = clone(V1_STEPS);
  const draftStep = V1_STEPS.find((s) => s.id === 'step-3');
  draftStep.time_limit_hours = 24;
  assert.equal(snapshot.find((s) => s.id === 'step-3').time_limit_hours, 48);
  assert.notEqual(snapshot, V1_STEPS);
});
