/**
 * Approval workflow tests. Every case hits the running HTTP API, so the exact
 * same routes, state machine and snapshot guard used by the demo are exercised.
 * Five customer acceptance criteria are named explicitly below. All records
 * are synthetic fictional data.
 */
import { test, expect } from '@playwright/test';

const API = 'http://127.0.0.1:3001/api/v1';
const FREEZE = '2026-11-24T00:00:00.000Z';

const reset = async (request) => {
  const r = await request.post(API + '/test/reset');
  expect(r.ok()).toBeTruthy();
};

async function post(request, path, data = {}) {
  const r = await request.post(API + path, { data });
  return { status: r.status(), data: await r.json() };
}

async function get(request, path) {
  const r = await request.get(API + path);
  return r.json();
}

async function setNow(request, iso) {
  const r = await post(request, '/test/set-now', { now: iso });
  expect(r.status).toBe(200);
  return r.data.now;
}

async function submit(request, qid, submittedBy = 'u-rep-01') {
  const r = await post(request, `/sales/quotes/${qid}/submit`, {
    submitted_by: submittedBy,
    client_ip: '203.0.113.9',
  });
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return r.data;
}

async function act(request, aid, action, actorId, comment = '') {
  return post(request, `/sales/approvals/${aid}/${action}`, {
    actor_id: actorId,
    comment,
    client_ip: '203.0.113.9',
  });
}

// ------------------------------------------------------------------
// Acceptance 1: only the current step approver may act
// ------------------------------------------------------------------
test('acceptance 1: a non-current-step approver calling approve returns 403', async ({ request }) => {
  await reset(request);
  const { approval } = await submit(request, 'Q-1003');
  expect(approval.current_step).toBe(1);
  expect(approval.current_approver_id).toBe('u-sup-01');

  // The club manager is a legitimate later-step approver, but not the current one.
  const tooEarly = await act(request, approval.id, 'approve', 'u-mgr-01');
  expect(tooEarly.status).toBe(403);
  expect(tooEarly.data.code).toBe('NOT_CURRENT_APPROVER');
  expect(tooEarly.data.expected).toBe('u-sup-01');
  expect(tooEarly.data.actual).toBe('u-mgr-01');

  // An unrelated actor is refused on reject too.
  const stranger = await act(request, approval.id, 'reject', 'u-rep-02', 'missing commercial basis here');
  expect(stranger.status).toBe(403);
  expect(stranger.data.code).toBe('NOT_CURRENT_APPROVER');

  // The stored step log is untouched by the refused attempts.
  const steps = await get(request, `/steps?approval_id=${approval.id}`);
  expect(steps.total).toBe(2);
  expect(steps.steps.every((s) => s.action === 'pending')).toBe(true);
});

// ------------------------------------------------------------------
// Acceptance 2: defensive snapshot hash guard
// ------------------------------------------------------------------
test('acceptance 2: a tampered calc_snapshot makes approve return 409 QUOTE_CHANGED_SINCE_SUBMIT', async ({ request }) => {
  await reset(request);
  const { approval } = await submit(request, 'Q-1002');
  const original = approval.snapshot_hash;

  const tamper = await post(request, '/test/tamper-snapshot', { qid: 'Q-1002' });
  expect(tamper.status).toBe(200);
  expect(tamper.data.new_hash).not.toBe(original);

  const r = await act(request, approval.id, 'approve', 'u-sup-01');
  expect(r.status).toBe(409);
  expect(r.data.code).toBe('QUOTE_CHANGED_SINCE_SUBMIT');
  expect(r.data.expected).toBe(original);
  expect(r.data.actual).toBe(tamper.data.new_hash);

  // No step row was appended and the quote is still blocked.
  const detail = await get(request, `/sales/approvals/${approval.id}`);
  expect(detail.approval.status).toBe('pending');
  expect(detail.approval.steps).toHaveLength(1);
  expect(detail.quote.snapshot_hash).toBe(tamper.data.new_hash);
});

test('the snapshot guard also protects the reject path', async ({ request }) => {
  await reset(request);
  const { approval } = await submit(request, 'Q-1003');
  await post(request, '/test/tamper-snapshot', { qid: 'Q-1003' });
  const r = await act(request, approval.id, 'reject', 'u-sup-01', 'snapshot no longer matches');
  expect(r.status).toBe(409);
  expect(r.data.code).toBe('QUOTE_CHANGED_SINCE_SUBMIT');
});

// ------------------------------------------------------------------
// Acceptance 3: site_manager needs two sequential approvals
// ------------------------------------------------------------------
test('acceptance 3: site_manager quote is approved only after supervisor then club manager', async ({ request }) => {
  await reset(request);
  expect(await setNow(request, FREEZE)).toBe(FREEZE);

  const { approval, quote } = await submit(request, 'Q-1003');
  expect(approval.tier).toBe('site_manager');
  expect(approval.status).toBe('pending');
  expect(approval.steps.map((s) => s.approver_role)).toEqual(['supervisor', 'site_manager']);
  expect(quote.status).toBe('pending');

  // First step: supervisor.
  const first = await act(request, approval.id, 'approve', 'u-sup-01', 'commercial basis checked');
  expect(first.status, JSON.stringify(first.data)).toBe(200);
  expect(first.data.approval.status).toBe('pending');
  expect(first.data.approval.current_step).toBe(2);
  expect(first.data.approval.current_approver_id).toBe('u-mgr-01');
  expect(first.data.quote.status).toBe('pending');
  expect(first.data.quote.valid_until).toBeNull();

  // The supervisor cannot approve a second time; they are no longer current.
  const repeat = await act(request, approval.id, 'approve', 'u-sup-01');
  expect(repeat.status).toBe(403);
  expect(repeat.data.code).toBe('NOT_CURRENT_APPROVER');

  // Second step: club manager -> terminal approval.
  const second = await act(request, approval.id, 'approve', 'u-mgr-01');
  expect(second.status, JSON.stringify(second.data)).toBe(200);
  expect(second.data.approval.status).toBe('approved');
  expect(second.data.approval.current_step).toBeNull();
  expect(second.data.quote.status).toBe('approved');
  expect(second.data.quote.valid_until).toBe('2026-12-09T00:00:00.000Z'); // frozen now + 15 days

  const events = await get(request, '/events');
  const approved = events.events.filter((e) => e.type === 'quote.approved');
  expect(approved).toHaveLength(1);
  expect(approved[0].quote_id).toBe('Q-1003');
  expect(approved[0].via).toBe('all_steps');

  // Append-only: initial pending rows still exist, new rows were added.
  const steps = await get(request, `/steps?approval_id=${approval.id}`);
  expect(steps.steps.map((s) => `${s.step_no}:${s.action}`)).toEqual([
    '1:pending', '2:pending', '1:approved', '2:approved',
  ]);
  expect(new Set(steps.steps.map((s) => s.id)).size).toBe(4);
});

// ------------------------------------------------------------------
// Acceptance 4: reject comment minimum length
// ------------------------------------------------------------------
test('acceptance 4: reject with a comment shorter than 10 characters returns 422', async ({ request }) => {
  await reset(request);
  const { approval } = await submit(request, 'Q-1003');

  const nine = '123456789';
  const short = await act(request, approval.id, 'reject', 'u-sup-01', nine);
  expect(short.status).toBe(422);
  expect(short.data.code).toBe('COMMENT_TOO_SHORT');
  expect(short.data.actual_length).toBe(9);
  expect(short.data.min_length).toBe(10);

  const blank = await act(request, approval.id, 'reject', 'u-sup-01', '   ');
  expect(blank.status).toBe(422);
  expect(blank.data.code).toBe('COMMENT_TOO_SHORT');

  const ten = await act(request, approval.id, 'reject', 'u-sup-01', '1234567890');
  expect(ten.status, JSON.stringify(ten.data)).toBe(200);
  expect(ten.data.approval.status).toBe('rejected');
  expect(ten.data.quote.status).toBe('rejected');
  expect(ten.data.step.comment).toBe('1234567890');

  const detail = await get(request, `/sales/approvals/${approval.id}`);
  expect(detail.approval.steps.map((s) => s.action)).toEqual(['pending', 'pending', 'rejected', 'skipped']);
});

// ------------------------------------------------------------------
// Acceptance 5: 24h / 48h reminders with a frozen clock
// ------------------------------------------------------------------
test('acceptance 5: 48h pending step notifies the club manager under a frozen clock', async ({ request }) => {
  await reset(request);
  await setNow(request, FREEZE);
  const { approval } = await submit(request, 'Q-1003');

  let sweep = await post(request, '/approvals/reminder-sweep', {});
  expect(sweep.status).toBe(200);
  expect(sweep.data.notifications).toBe(0);

  await setNow(request, '2026-11-24T23:00:00.000Z'); // 23h
  sweep = await post(request, '/approvals/reminder-sweep', {});
  expect(sweep.data.notifications).toBe(0);

  await setNow(request, '2026-11-25T01:00:00.000Z'); // 25h
  sweep = await post(request, '/approvals/reminder-sweep', {});
  expect(sweep.data.approver_reminders).toBe(1);
  expect(sweep.data.manager_reminders).toBe(0);

  await setNow(request, '2026-11-26T01:00:00.000Z'); // 49h
  sweep = await post(request, '/approvals/reminder-sweep', {});
  expect(sweep.data.approver_reminders).toBe(0); // already sent once
  expect(sweep.data.manager_reminders).toBe(1);

  const log = await get(request, '/notifications');
  expect(log.total).toBe(2);
  const manager = log.notifications.find((n) => n.level === 'manager');
  expect(manager).toMatchObject({
    recipient_id: 'u-mgr-01',
    recipient_role: 'site_manager',
    approval_id: approval.id,
    step_no: 1,
    channel: 'stub',
  });
  expect(manager.age_hours).toBe(49);
  expect(log.notifications.find((n) => n.level === 'approver').recipient_id).toBe('u-sup-01');

  // Idempotent: rerunning the sweep must not duplicate notifications.
  const again = await post(request, '/approvals/reminder-sweep', {});
  expect(again.data.notifications).toBe(0);
  expect((await get(request, '/notifications')).total).toBe(2);
});

// ------------------------------------------------------------------
// Tier routing, authority ceiling and contract
// ------------------------------------------------------------------
test('rep tier is approved at submit with the fixed authority comment', async ({ request }) => {
  await reset(request);
  await setNow(request, FREEZE);
  const { approval, quote } = await submit(request, 'Q-1001', 'u-rep-01');

  expect(approval.status).toBe('approved');
  expect(approval.steps).toHaveLength(1);
  expect(approval.steps[0]).toMatchObject({
    step_no: 1,
    action: 'approved',
    approver_id: 'u-rep-01',
    approver_role: 'rep',
    comment: "Within advisor's authority",
    client_ip: '203.0.113.9',
  });
  expect(quote.status).toBe('approved');
  expect(quote.valid_until).toBe('2026-12-09T00:00:00.000Z');
  const events = await get(request, '/events');
  expect(events.events[0].via).toBe('within_authority');
});

test('amounts above the tier ceiling and unknown tiers return 422 without creating an approval', async ({ request }) => {
  await reset(request);
  await post(request, '/test/seed-quote', { qid: 'Q-HIGH', tier: 'rep', amount: 50000 });
  const over = await post(request, '/sales/quotes/Q-HIGH/submit', { submitted_by: 'u-rep-01' });
  expect(over.status).toBe(422);
  expect(over.data.code).toBe('QUOTE_EXCEEDS_MAX_AUTHORITY');
  expect(over.data.max_amount).toBe(1000);

  await post(request, '/test/seed-quote', { qid: 'Q-ODD', tier: 'unknown', amount: 10 });
  const odd = await post(request, '/sales/quotes/Q-ODD/submit', { submitted_by: 'u-rep-01' });
  expect(odd.status).toBe(422);
  expect(odd.data.code).toBe('UNKNOWN_TIER');

  expect((await get(request, '/sales/approvals?tab=mine&actor_id=u-rep-01')).approvals).toHaveLength(0);
});

test('snapshot hash is canonical: key order does not change the digest', async ({ request }) => {
  await reset(request);
  await post(request, '/test/seed-quote', {
    qid: 'Q-A', tier: 'rep', amount: 10,
    calc_snapshot: { a: 1, b: { x: 2, y: 3 } },
  });
  await post(request, '/test/seed-quote', {
    qid: 'Q-B', tier: 'rep', amount: 10,
    calc_snapshot: { b: { y: 3, x: 2 }, a: 1 },
  });
  const a = await submit(request, 'Q-A');
  const b = await submit(request, 'Q-B');
  expect(a.quote.snapshot_hash).toBe(b.quote.snapshot_hash);
  expect(a.quote.snapshot_hash).toMatch(/^[0-9a-f]{64}$/);
});

// ------------------------------------------------------------------
// Remaining state rules
// ------------------------------------------------------------------
test('withdraw is submitter-only, pending-only, and appends skipped step rows', async ({ request }) => {
  await reset(request);
  const { approval } = await submit(request, 'Q-1003', 'u-rep-01');

  const wrong = await act(request, approval.id, 'withdraw', 'u-sup-01');
  expect(wrong.status).toBe(403);
  expect(wrong.data.code).toBe('NOT_SUBMITTER');

  const ok = await act(request, approval.id, 'withdraw', 'u-rep-01');
  expect(ok.status, JSON.stringify(ok.data)).toBe(200);
  expect(ok.data.approval.status).toBe('withdrawn');
  expect(ok.data.quote.status).toBe('draft');
  expect(ok.data.approval.steps.map((s) => s.action)).toEqual([
    'pending', 'pending', 'skipped', 'skipped',
  ]);

  const late = await act(request, approval.id, 'withdraw', 'u-rep-01');
  expect(late.status).toBe(409);
  expect(late.data.code).toBe('APPROVAL_NOT_PENDING');

  // The quote returns to draft and can be submitted again.
  const resubmit = await submit(request, 'Q-1003', 'u-rep-01');
  expect(resubmit.approval.id).not.toBe(approval.id);
});

test('approval tabs filter todo, mine and done consistently', async ({ request }) => {
  await reset(request);
  const first = await submit(request, 'Q-1003', 'u-rep-01'); // wait for u-sup-01
  await submit(request, 'Q-1002', 'u-rep-02'); // wait for u-sup-01 too

  const todoSup = await get(request, '/sales/approvals?tab=todo&actor_id=u-sup-01');
  expect(todoSup.total).toBe(2);
  const todoMgr = await get(request, '/sales/approvals?tab=todo&actor_id=u-mgr-01');
  expect(todoMgr.total).toBe(0);

  const mineRep = await get(request, '/sales/approvals?tab=mine&actor_id=u-rep-01');
  expect(mineRep.total).toBe(1);
  expect(mineRep.approvals[0].id).toBe(first.approval.id);

  await act(request, first.approval.id, 'approve', 'u-sup-01');
  await act(request, first.approval.id, 'approve', 'u-mgr-01');
  const doneMgr = await get(request, '/sales/approvals?tab=done&actor_id=u-mgr-01');
  expect(doneMgr.total).toBe(1);
  expect(doneMgr.approvals[0].status).toBe('approved');

  const badResponse = await request.get(API + '/sales/approvals?tab=weird&actor_id=u-rep-01');
  expect(badResponse.status()).toBe(400);
  expect((await badResponse.json()).code).toBe('BAD_TAB');
});

test('a terminal approval refuses further approve / reject attempts', async ({ request }) => {
  await reset(request);
  const { approval } = await submit(request, 'Q-1001');
  const again = await act(request, approval.id, 'approve', 'u-rep-01');
  expect(again.status).toBe(409);
  expect(again.data.code).toBe('APPROVAL_NOT_PENDING');
});

test('meta and contract expose routing, thresholds and the snapshot algorithm', async ({ request }) => {
  await reset(request);
  const meta = await get(request, '/meta');
  expect(meta.tiers).toEqual(['rep', 'supervisor', 'site_manager']);
  expect(meta.valid_until_days).toBe(15);
  expect(meta.reminder_hours).toEqual({ approver: 24, manager: 48 });
  expect(meta.tier_routes.find((r) => r.tier === 'site_manager').steps)
    .toEqual(['supervisor', 'site_manager']);
  expect(meta.snapshot_algorithm).toContain('sha256');

  const contract = await get(request, '/contract/summary');
  expect(contract.step_actions).toEqual(['pending', 'approved', 'rejected', 'skipped']);
  expect(contract.notification_channel).toBe('stub');

  const spec = await get(request, '/openapi.json');
  expect(spec.openapi).toMatch(/^3\./);
  expect(spec.info.title).toBe('Quotation Approval Workflow API');
  expect(spec.components.schemas.Approval.required).toContain('snapshot_hash');
});
