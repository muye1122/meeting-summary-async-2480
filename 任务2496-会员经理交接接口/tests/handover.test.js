import test from 'node:test';
import assert from 'node:assert/strict';

// The business module starts an HTTP listener on import unless this flag is set.
process.env.SALES_NO_LISTEN = '1';

const service = await import('../mock-server/index.js');
const outbox = await import('../mock-server/outbox.js');

const {
  STATES, TRANSITIONS, STATE_LABELS, REQUIRED_FIELDS, ACTORS,
  canTransition, recomputeMissingFields, labelsForFields, validateReturnReason,
  canList, canView, validateClaim, assertClaimSnapshot, openApiDocument,
} = service;

const actor = (id) => ACTORS.find((candidate) => candidate.id === id);
const completePackage = {
  enterprise_name: '示例会员企业甲',
  contact_name: '示例联系人甲',
  contact_phone: '13800000001',
  planned_onboarding_date: '2026-12-15',
  contract_no: 'HT-2026-0001',
};

function handover(overrides = {}) {
  const pkg = { ...completePackage, ...(overrides.package || {}) };
  return {
    id: 'ho-unit',
    contract_id: 'CTR-UNIT',
    department: 'dept-east',
    signing_consultant_id: 'actor-consultant-1',
    assigned_manager_id: null,
    status: 'pending_claim',
    claimed_by: null,
    returned_by: null,
    package: pkg,
    missing_fields: recomputeMissingFields(pkg),
    version: 0,
    ...overrides,
    package: pkg,
  };
}

test('three-state machine declares exactly the allowed edges', () => {
  assert.deepEqual(STATES, ['pending_claim', 'returned_for_info', 'claimed']);
  assert.deepEqual(Object.keys(STATE_LABELS).sort(), [...STATES].sort());
  assert.deepEqual(TRANSITIONS.pending_claim, ['returned_for_info', 'claimed']);
  assert.deepEqual(TRANSITIONS.returned_for_info, ['pending_claim']);
  assert.deepEqual(TRANSITIONS.claimed, ['returned_for_info']);
  for (const from of STATES) {
    for (const to of STATES) {
      assert.equal(canTransition(from, to), TRANSITIONS[from].includes(to), `${from} -> ${to}`);
    }
  }
  assert.equal(canTransition('pending_claim', 'pending_claim'), false);
});

test('missing fields are recomputed from the package and carry labels', () => {
  assert.deepEqual(recomputeMissingFields(completePackage), []);
  const partial = handover({ package: { contact_phone: '', planned_onboarding_date: '' } });
  assert.deepEqual(partial.missing_fields, ['contact_phone', 'planned_onboarding_date']);
  assert.deepEqual(labelsForFields(partial.missing_fields), ['联系人电话', '计划入驻日期']);
  const badPhone = recomputeMissingFields({ ...completePackage, contact_phone: '123' });
  assert.deepEqual(badPhone, ['contact_phone']);
  assert.equal(REQUIRED_FIELDS.length, 5);
});

test('return reason must be at least 10 characters after trimming', () => {
  assert.equal(validateReturnReason('').code, 'REASON_TOO_SHORT');
  assert.equal(validateReturnReason('太短的理由').ok, false);
  assert.equal(validateReturnReason('         ').ok, false);
  assert.equal(validateReturnReason('  联系人电话无法接通，请补充有效号码  ').value, '联系人电话无法接通，请补充有效号码');
});

test('claim validation covers role, assignment, state and completeness', () => {
  assert.equal(validateClaim(actor('actor-consultant-1'), handover()).code, 'FORBIDDEN');
  assert.equal(validateClaim(actor('actor-manager-c'), handover()).code, 'FORBIDDEN');
  assert.equal(validateClaim(actor('actor-manager-a'), handover({ assigned_manager_id: 'actor-manager-b' })).code, 'NOT_ASSIGNED_MANAGER');
  assert.equal(validateClaim(actor('actor-manager-a'), handover({ status: 'claimed' })).code, 'ALREADY_CLAIMED');
  assert.equal(validateClaim(actor('actor-manager-a'), handover({ status: 'returned_for_info' })).code, 'ILLEGAL_TRANSITION');
  const incomplete = validateClaim(actor('actor-manager-a'), handover({ package: { contact_phone: '' } }));
  assert.equal(incomplete.status, 422);
  assert.equal(incomplete.code, 'HANDOVER_INCOMPLETE');
  assert.deepEqual(incomplete.missing_fields, ['contact_phone']);
  assert.equal(validateClaim(actor('actor-manager-a'), handover()).ok, true);
});

test('list and detail visibility follow the acting role', () => {
  const own = handover();
  const otherDepartment = handover({ department: 'dept-west' });
  const assignedElsewhere = handover({ assigned_manager_id: 'actor-manager-b' });
  const claimedByOther = handover({ status: 'claimed', claimed_by: 'actor-manager-b' });
  assert.equal(canList(actor('actor-director'), own), true);
  assert.equal(canList(actor('actor-director'), otherDepartment), false);
  assert.equal(canList(actor('actor-manager-a'), own), true);
  assert.equal(canList(actor('actor-manager-a'), claimedByOther), false);
  assert.equal(canList(actor('actor-consultant-1'), own), true);
  assert.equal(canList(actor('actor-consultant-2'), own), false);
  assert.equal(canView(actor('actor-manager-a'), assignedElsewhere), true);
  assert.equal(canView(actor('actor-manager-a'), otherDepartment), false);
});

test('optimistic-locking guard rejects a stale snapshot with 409', () => {
  const row = { version: 4, status: 'pending_claim' };
  const snapshot = { version: 4, status: 'pending_claim' };
  assert.equal(assertClaimSnapshot(row, snapshot).ok, true);
  row.version = 5; // another writer committed first
  const stale = assertClaimSnapshot(row, snapshot);
  assert.equal(stale.ok, false);
  assert.equal(stale.status, 409);
  assert.equal(stale.code, 'VERSION_CONFLICT');
  row.version = 4;
  row.status = 'claimed';
  assert.equal(assertClaimSnapshot(row, snapshot).ok, false);
  assert.equal(assertClaimSnapshot(null, snapshot).status, 404);
});

test('CRM payload uses contract_id as external reference and upserts idempotently', async () => {
  outbox.resetOutbox();
  const entity = handover({ id: 'ho-crm', contract_id: 'CTR-2026-UNIT', claimed_by: 'actor-manager-a' });
  const payload = outbox.buildCrmPayload(entity);
  assert.equal(payload.external_ref, 'CTR-2026-UNIT');
  assert.equal(payload.contract_id, 'CTR-2026-UNIT');
  assert.equal(payload.contract_no, 'HT-2026-0001');
  assert.equal(payload.manager_assignment.manager_id, 'actor-manager-a');
  assert.equal(payload.planned_onboarding_date, '2026-12-15');

  await outbox.enqueueCrmSync(entity);
  await outbox.processDue();
  assert.equal(outbox.getRows()[0].status, 'done');
  assert.equal(outbox.getCrmRecords().length, 1);
  assert.equal(outbox.getCrmRecords()[0].sync_count, 1);

  await outbox.enqueueCrmSync(entity);
  await outbox.processDue();
  assert.equal(outbox.getCrmRecords().length, 1);
  assert.equal(outbox.getCrmRecords()[0].sync_count, 2);
});

test('five CRM failures move the sync to failed after 1/5/30/30 minute backoff', async () => {
  outbox.resetOutbox();
  const observed = [];
  outbox.setStatusSink((update) => observed.push(update));
  assert.deepEqual(outbox.BACKOFF_MINUTES, [1, 5, 30, 30]);
  assert.equal(outbox.MAX_ATTEMPTS, 5);
  outbox.configureCrmFailures(5);
  await outbox.enqueueCrmSync(handover({ id: 'ho-fail', contract_id: 'CTR-2026-FAIL' }));
  await outbox.processDue();
  assert.equal(observed[0].status, 'retry_scheduled');
  assert.equal(observed[0].delay_minutes, 1);
  for (const minutes of outbox.BACKOFF_MINUTES) {
    outbox.advance(minutes * 60_000);
    await outbox.processDue();
  }
  const row = outbox.getRows()[0];
  assert.equal(row.attempts, 5);
  assert.equal(row.status, 'failed');
  assert.equal(observed.at(-1).status, 'failed');
  assert.equal(observed.at(-1).attempts, 5);
  outbox.setStatusSink(() => {});
});

test('virtual clock fast-forward and cancelForHandover behave deterministically', async () => {
  outbox.resetOutbox();
  const before = outbox.now();
  outbox.advance(90_000);
  assert.equal(outbox.now(), before + 90_000);
  const entity = handover({ id: 'ho-cancel', contract_id: 'CTR-2026-CANCEL' });
  const row = await outbox.enqueueCrmSync(entity);
  assert.equal(outbox.cancelForHandover(entity.id), 1);
  assert.equal(outbox.getRows().find((item) => item.id === row.id).status, 'cancelled');
  await outbox.processDue();
  assert.equal(outbox.getRows().find((item) => item.id === row.id).attempts, 0);
});

test('OpenAPI description declares all six business endpoints', () => {
  const spec = openApiDocument();
  assert.equal(spec.openapi, '3.0.3');
  const paths = Object.keys(spec.paths);
  for (const path of [
    '/handovers', '/handovers/{hid}', '/handovers/{hid}/package',
    '/handovers/{hid}/assign', '/handovers/{hid}/claim', '/handovers/{hid}/return',
  ]) {
    assert.ok(paths.includes(path), `missing path ${path}`);
  }
  assert.deepEqual(spec.paths['/handovers'].get.parameters[0].schema.enum, STATES);
  assert.ok(spec.components.schemas.Handover.properties.missing_fields);
});
