/**
 * Quotation approval workflow service - runnable in-memory demo.
 *
 * Two synthetic tables model the contract:
 *   sales_quote_approvals      - one approval per submitted quote revision
 *   sales_quote_approval_steps - append-only step log (rows are never updated)
 *
 * The current step of an approval is derived from the LAST row written for each
 * step_no, so an approve / reject / skip action appends a new immutable row
 * instead of mutating an existing one.
 *
 * Every write is synchronous within one Node process. In production the
 * check-and-append block must become a real database transaction; see the
 * honest limits in README.md. All people, quotes and amounts are fictional.
 */
import express from 'express';
import crypto from 'node:crypto';
import {
  TIERS,
  TIER_AUTHORITY,
  REP_APPROVAL_COMMENT,
  routeApproval,
  tierRouteSummary,
} from './router.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
const PORT = process.env.PORT || 3001;

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'];
export const STEP_ACTIONS = ['pending', 'approved', 'rejected', 'skipped'];
export const VALID_UNTIL_DAYS = 15;
export const REMINDER_HOURS = { approver: 24, manager: 48 };
const HOUR_MS = 3600 * 1000;

// Synthetic actor registry. Roles are used for routing and for the stub
// notification recipient, never for real authentication.
const ACTOR_SEED = [
  { id: 'u-rep-01', name: '示例·林晓', roles: ['rep'], site_id: 'site-A' },
  { id: 'u-rep-02', name: '示例·陈晨', roles: ['rep'], site_id: 'site-B' },
  { id: 'u-sup-01', name: '示例·周涛', roles: ['supervisor'], site_id: 'site-A' },
  { id: 'u-sup-02', name: '示例·孙磊', roles: ['supervisor'], site_id: 'site-A' },
  { id: 'u-mgr-01', name: '示例·赵敏', roles: ['site_manager'], site_id: 'site-A' },
  { id: 'u-mgr-02', name: '示例·吴静', roles: ['site_manager'], site_id: 'site-B' },
];

const QUOTE_SEED = [
  {
    quote_id: 'Q-1001', revision: 1, tier: 'rep', amount: 800, site_id: 'site-A',
    calc_snapshot: { currency: 'USD', lines: [{ sku: 'SEAT', qty: 2, unit_price: 100 }], discount: 0 },
  },
  {
    quote_id: 'Q-1002', revision: 1, tier: 'supervisor', amount: 5000, site_id: 'site-A',
    calc_snapshot: { currency: 'USD', lines: [{ sku: 'DESK', qty: 5, unit_price: 1000 }], discount: 0 },
  },
  {
    quote_id: 'Q-1003', revision: 1, tier: 'site_manager', amount: 45000, site_id: 'site-A',
    calc_snapshot: { currency: 'USD', lines: [{ sku: 'ROOM', qty: 3, unit_price: 15000 }], discount: 0 },
  },
];

// ------------------------------------------------------------------
// 0. In-memory store and injected clock
// ------------------------------------------------------------------
let db;
let seq;
let frozenNow = null;

/** Test-only clock injection. null restores the real system clock. */
export function setNow(iso) {
  frozenNow = iso ? new Date(iso).toISOString() : null;
  return nowIso();
}

export function nowIso() {
  return frozenNow || new Date().toISOString();
}

function addDays(iso, days) {
  return new Date(new Date(iso).getTime() + days * 24 * HOUR_MS).toISOString();
}

function resetStore() {
  seq = { approval: 0, step: 0, notification: 0, event: 0 };
  frozenNow = null;
  db = {
    actors: ACTOR_SEED.map((a) => ({ ...a, roles: [...a.roles] })),
    quotes: QUOTE_SEED.map((q) => ({
      ...q,
      calc_snapshot: JSON.parse(JSON.stringify(q.calc_snapshot)),
      status: 'draft',
      valid_until: null,
      created_at: nowIso(),
    })),
    approvals: [],
    steps: [],
    notifications: [],
    events: [],
    reminders: new Set(),
  };
}
resetStore();

const clone = (v) => JSON.parse(JSON.stringify(v));
const findQuote = (id) => db.quotes.find((q) => q.quote_id === String(id));
const findApproval = (id) => db.approvals.find((a) => a.id === String(id));

// ------------------------------------------------------------------
// 1. Deterministic SHA-256 of calc_snapshot
// ------------------------------------------------------------------
/** Stable stringify so key order never changes the digest. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(',')}}`;
}

export function snapshotHash(snapshot) {
  return crypto.createHash('sha256').update(stableStringify(snapshot), 'utf8').digest('hex');
}

// ------------------------------------------------------------------
// 2. Append-only step log helpers
// ------------------------------------------------------------------
function appendStep(row) {
  const record = {
    id: `stp_${String(++seq.step).padStart(5, '0')}`,
    approval_id: row.approval_id,
    step_no: row.step_no,
    approver_id: row.approver_id,
    approver_role: row.approver_role,
    action: row.action,
    comment: String(row.comment ?? ''),
    acted_at: row.acted_at ?? null,
    client_ip: row.client_ip ?? null,
    created_at: row.created_at,
  };
  db.steps.push(record); // never update an existing row
  return record;
}

/** Latest immutable row per step_no, ordered by step number. */
function latestSteps(approvalId) {
  const byStep = new Map();
  for (const row of db.steps) {
    if (row.approval_id === approvalId) byStep.set(row.step_no, row);
  }
  return [...byStep.values()].sort((a, b) => a.step_no - b.step_no);
}

function currentStep(approval) {
  if (!approval || approval.status !== 'pending') return null;
  return latestSteps(approval.id).find((row) => row.action === 'pending') || null;
}

/** Append a skipped row for every step still pending (reject / withdraw). */
function skipRemaining(approvalId, at, comment) {
  const skipped = [];
  for (const row of latestSteps(approvalId)) {
    if (row.action !== 'pending') continue;
    skipped.push(appendStep({
      approval_id: approvalId,
      step_no: row.step_no,
      approver_id: row.approver_id,
      approver_role: row.approver_role,
      action: 'skipped',
      comment,
      acted_at: at,
      client_ip: null,
      created_at: at,
    }));
  }
  return skipped;
}

function emit(type, payload) {
  const event = {
    id: `evt_${String(++seq.event).padStart(5, '0')}`,
    type,
    at: nowIso(),
    ...payload,
  };
  db.events.push(event);
  return event;
}

/** Stub notification sink - no external call, no real email or IM. */
function notify(payload) {
  const record = {
    id: `ntf_${String(++seq.notification).padStart(5, '0')}`,
    at: nowIso(),
    channel: 'stub',
    ...payload,
  };
  db.notifications.push(record);
  return record;
}

// ------------------------------------------------------------------
// 3. Public projections
// ------------------------------------------------------------------
export function publicQuote(q) {
  return {
    quote_id: q.quote_id,
    revision: q.revision,
    tier: q.tier,
    amount: q.amount,
    site_id: q.site_id,
    status: q.status,
    calc_snapshot: clone(q.calc_snapshot),
    snapshot_hash: snapshotHash(q.calc_snapshot),
    valid_until: q.valid_until,
  };
}

export function publicApproval(a) {
  const active = currentStep(a);
  return {
    id: a.id,
    quote_id: a.quote_id,
    revision: a.revision,
    tier: a.tier,
    status: a.status,
    submitted_by: a.submitted_by,
    submitted_at: a.submitted_at,
    snapshot_hash: a.snapshot_hash,
    decided_at: a.decided_at,
    current_step: active ? active.step_no : null,
    current_approver_id: active ? active.approver_id : null,
    current_approver_role: active ? active.approver_role : null,
    steps: db.steps
      .filter((s) => s.approval_id === a.id)
      .map((s) => ({ ...s })),
  };
}

// ------------------------------------------------------------------
// 4. Business operations - the single write path
// ------------------------------------------------------------------
export function submitQuote(qid, body = {}) {
  const quote = findQuote(qid);
  if (!quote) {
    return { error: { status: 404, code: 'QUOTE_NOT_FOUND', message: 'quote not found' } };
  }
  if (quote.status !== 'draft') {
    return {
      error: {
        status: 409,
        code: 'QUOTE_NOT_SUBMITTABLE',
        message: 'only a draft quote can be submitted',
        quote_status: quote.status,
      },
    };
  }

  const submittedBy = String(body.submitted_by || 'u-rep-01');
  const route = routeApproval(quote.tier, quote.amount, db.actors, submittedBy);
  if (route.error) return { error: route.error };

  const at = nowIso();
  const approval = {
    id: `apr_${String(++seq.approval).padStart(4, '0')}`,
    quote_id: quote.quote_id,
    revision: quote.revision,
    tier: quote.tier,
    status: route.auto_approve ? 'approved' : 'pending',
    submitted_by: submittedBy,
    submitted_at: at,
    snapshot_hash: snapshotHash(quote.calc_snapshot),
    decided_at: route.auto_approve ? at : null,
    created_at: at,
  };
  db.approvals.push(approval);

  for (const spec of route.steps) {
    appendStep({
      approval_id: approval.id,
      step_no: spec.step_no,
      approver_id: spec.approver_id,
      approver_role: spec.approver_role,
      action: route.auto_approve ? 'approved' : 'pending',
      comment: route.auto_approve ? REP_APPROVAL_COMMENT : '',
      acted_at: route.auto_approve ? at : null,
      client_ip: route.auto_approve ? (body.client_ip || null) : null,
      created_at: at,
    });
  }

  if (route.auto_approve) {
    quote.status = 'approved';
    quote.valid_until = addDays(at, VALID_UNTIL_DAYS);
    emit('quote.approved', {
      quote_id: quote.quote_id,
      approval_id: approval.id,
      valid_until: quote.valid_until,
      via: 'within_authority',
    });
  } else {
    quote.status = 'pending';
  }

  return { ok: true, approval: publicApproval(approval), quote: publicQuote(quote) };
}

export function decide(approvalId, action, body = {}) {
  const approval = findApproval(approvalId);
  if (!approval) {
    return { error: { status: 404, code: 'APPROVAL_NOT_FOUND', message: 'approval not found' } };
  }
  if (approval.status !== 'pending') {
    return {
      error: {
        status: 409,
        code: 'APPROVAL_NOT_PENDING',
        message: 'approval is already in a terminal state',
        approval_status: approval.status,
      },
    };
  }

  const comment = String(body.comment ?? '');
  if (action === 'reject' && Array.from(comment.trim()).length < 10) {
    return {
      error: {
        status: 422,
        code: 'COMMENT_TOO_SHORT',
        message: 'reject requires a comment of at least 10 characters',
        min_length: 10,
        actual_length: Array.from(comment.trim()).length,
      },
    };
  }

  const step = currentStep(approval);
  if (!step) {
    return { error: { status: 409, code: 'NO_PENDING_STEP', message: 'no pending step to act on' } };
  }
  if (!body.actor_id || body.actor_id !== step.approver_id) {
    return {
      error: {
        status: 403,
        code: 'NOT_CURRENT_APPROVER',
        message: 'only the assigned approver of the current step may act',
        expected: step.approver_id,
        actual: body.actor_id || null,
        step_no: step.step_no,
      },
    };
  }

  const quote = findQuote(approval.quote_id);
  if (!quote) {
    return { error: { status: 404, code: 'QUOTE_NOT_FOUND', message: 'quote not found' } };
  }
  const currentHash = snapshotHash(quote.calc_snapshot);
  if (currentHash !== approval.snapshot_hash) {
    return {
      error: {
        status: 409,
        code: 'QUOTE_CHANGED_SINCE_SUBMIT',
        message: 'quote calc_snapshot changed since submission',
        expected: approval.snapshot_hash,
        actual: currentHash,
      },
    };
  }

  const at = nowIso();
  const record = appendStep({
    approval_id: approval.id,
    step_no: step.step_no,
    approver_id: step.approver_id,
    approver_role: step.approver_role,
    action: action === 'approve' ? 'approved' : 'rejected',
    comment,
    acted_at: at,
    client_ip: body.client_ip || null,
    created_at: at,
  });

  if (action === 'reject') {
    skipRemaining(approval.id, at, 'closed by rejection');
    approval.status = 'rejected';
    approval.decided_at = at;
    quote.status = 'rejected';
    emit('quote.rejected', { quote_id: quote.quote_id, approval_id: approval.id });
  } else if (!latestSteps(approval.id).some((s) => s.action === 'pending')) {
    approval.status = 'approved';
    approval.decided_at = at;
    quote.status = 'approved';
    quote.valid_until = addDays(at, VALID_UNTIL_DAYS);
    emit('quote.approved', {
      quote_id: quote.quote_id,
      approval_id: approval.id,
      valid_until: quote.valid_until,
      via: 'all_steps',
    });
  }

  return {
    ok: true,
    approval: publicApproval(approval),
    quote: publicQuote(quote),
    step: { ...record },
  };
}

export function withdrawApproval(approvalId, body = {}) {
  const approval = findApproval(approvalId);
  if (!approval) {
    return { error: { status: 404, code: 'APPROVAL_NOT_FOUND', message: 'approval not found' } };
  }
  if (!body.actor_id || body.actor_id !== approval.submitted_by) {
    return {
      error: {
        status: 403,
        code: 'NOT_SUBMITTER',
        message: 'only the submitter may withdraw an approval',
        expected: approval.submitted_by,
        actual: body.actor_id || null,
      },
    };
  }
  if (approval.status !== 'pending') {
    return {
      error: {
        status: 409,
        code: 'APPROVAL_NOT_PENDING',
        message: 'only a pending approval can be withdrawn',
        approval_status: approval.status,
      },
    };
  }

  const at = nowIso();
  skipRemaining(approval.id, at, 'withdrawn by submitter');
  approval.status = 'withdrawn';
  approval.decided_at = at;
  const quote = findQuote(approval.quote_id);
  if (quote && quote.status === 'pending') quote.status = 'draft';
  emit('quote.withdrawn', { quote_id: approval.quote_id, approval_id: approval.id });

  return { ok: true, approval: publicApproval(approval), quote: publicQuote(quote) };
}

// ------------------------------------------------------------------
// 5. Timed reminders - frozen clock injected through setNow()
// ------------------------------------------------------------------
export function runReminderSweep(nowInput) {
  const now = nowInput ? new Date(nowInput) : new Date(nowIso());
  const summary = {
    now: now.toISOString(),
    scanned: 0,
    skipped: 0,
    approver_reminders: 0,
    manager_reminders: 0,
    notifications: 0,
  };

  for (const approval of db.approvals) {
    if (approval.status !== 'pending') continue;
    const step = currentStep(approval);
    if (!step) {
      summary.skipped += 1;
      continue;
    }
    summary.scanned += 1;
    const ageHours = (now.getTime() - new Date(step.created_at).getTime()) / HOUR_MS;

    if (ageHours >= REMINDER_HOURS.approver) {
      const key = `${approval.id}:${step.step_no}:approver`;
      if (!db.reminders.has(key)) {
        db.reminders.add(key);
        notify({
          level: 'approver',
          recipient_id: step.approver_id,
          recipient_role: step.approver_role,
          approval_id: approval.id,
          step_no: step.step_no,
          age_hours: Math.round(ageHours * 100) / 100,
          message: `Step ${step.step_no} has been pending for ${Math.floor(ageHours)} hours`,
        });
        summary.approver_reminders += 1;
        summary.notifications += 1;
      }
    }

    if (ageHours >= REMINDER_HOURS.manager) {
      const quote = findQuote(approval.quote_id);
      const manager = db.actors.find(
        (a) => a.roles.includes('site_manager') && a.site_id === quote?.site_id
      ) || db.actors.find((a) => a.roles.includes('site_manager'));
      const key = `${approval.id}:${step.step_no}:manager`;
      if (manager && !db.reminders.has(key)) {
        db.reminders.add(key);
        notify({
          level: 'manager',
          recipient_id: manager.id,
          recipient_role: 'site_manager',
          approval_id: approval.id,
          step_no: step.step_no,
          age_hours: Math.round(ageHours * 100) / 100,
          message: `Step ${step.step_no} exceeded 48h; club manager notified`,
        });
        summary.manager_reminders += 1;
        summary.notifications += 1;
      }
    }
  }
  return summary;
}

// ------------------------------------------------------------------
// 6. HTTP API
// ------------------------------------------------------------------
const sendError = (res, err) => res.status(err.status).json({ ok: false, ...err });

app.get('/api/v1/health', (_req, res) => res.json({
  ok: true,
  service: 'quote-approval-flow',
  ts: Date.now(),
  now: nowIso(),
  counts: {
    quotes: db.quotes.length,
    approvals: db.approvals.length,
    steps: db.steps.length,
    notifications: db.notifications.length,
    events: db.events.length,
  },
}));

app.post('/api/v1/test/reset', (_req, res) => {
  resetStore();
  res.json({ ok: true, approvals: db.approvals.length, steps: db.steps.length });
});

app.post('/api/v1/test/set-now', (req, res) => {
  const now = setNow(req.body?.now ?? null);
  res.json({ ok: true, now });
});

// Test-only tampering helper: mutates calc_snapshot WITHOUT touching the
// approval, so the defensive hash check can be exercised deterministically.
app.post('/api/v1/test/tamper-snapshot', (req, res) => {
  const quote = findQuote(req.body?.qid);
  if (!quote) {
    return res.status(404).json({ ok: false, code: 'QUOTE_NOT_FOUND', message: 'quote not found' });
  }
  quote.calc_snapshot = {
    ...quote.calc_snapshot,
    tampered_at: nowIso(),
    note: 'unauthorized post-submit change (test fixture)',
  };
  res.json({ ok: true, qid: quote.quote_id, new_hash: snapshotHash(quote.calc_snapshot) });
});

app.post('/api/v1/test/seed-quote', (req, res) => {
  const qid = String(req.body?.qid || '');
  if (!qid) {
    return res.status(400).json({ ok: false, code: 'BAD_REQUEST', message: 'qid is required' });
  }
  const existing = findQuote(qid);
  const quote = existing || {
    quote_id: qid,
    calc_snapshot: { currency: 'USD', lines: [] },
    created_at: nowIso(),
  };
  if (req.body?.tier !== undefined) quote.tier = String(req.body.tier);
  if (req.body?.amount !== undefined) quote.amount = Number(req.body.amount);
  if (req.body?.site_id !== undefined) quote.site_id = String(req.body.site_id);
  if (req.body?.revision !== undefined) quote.revision = Number(req.body.revision);
  if (req.body?.calc_snapshot !== undefined) quote.calc_snapshot = clone(req.body.calc_snapshot);
  quote.status = 'draft';
  quote.valid_until = null;
  if (!existing) db.quotes.push(quote);
  res.status(201).json({ ok: true, quote: publicQuote(quote) });
});

app.get('/api/v1/meta', (_req, res) => res.json({
  service: 'quote-approval-flow',
  tiers: TIERS,
  tier_authority: TIER_AUTHORITY,
  tier_routes: tierRouteSummary(),
  approval_statuses: APPROVAL_STATUSES,
  step_actions: STEP_ACTIONS,
  valid_until_days: VALID_UNTIL_DAYS,
  reminder_hours: REMINDER_HOURS,
  rep_approval_comment: REP_APPROVAL_COMMENT,
  actors: db.actors,
  snapshot_algorithm: 'sha256 of canonical JSON of calc_snapshot',
  notification_channel: 'stub (in-process, no external call)',
}));

app.get('/api/v1/sales/quotes', (_req, res) => res.json({
  total: db.quotes.length,
  quotes: db.quotes.map(publicQuote),
}));

app.get('/api/v1/sales/quotes/:qid', (req, res) => {
  const quote = findQuote(req.params.qid);
  if (!quote) {
    return res.status(404).json({ ok: false, code: 'QUOTE_NOT_FOUND', message: 'quote not found' });
  }
  res.json({ quote: publicQuote(quote) });
});

const sales = express.Router();

sales.post('/quotes/:qid/submit', (req, res) => {
  const result = submitQuote(req.params.qid, req.body || {});
  if (result.error) return sendError(res, result.error);
  res.status(201).json({ ok: true, ...result });
});

sales.get('/approvals', (req, res) => {
  const actor = String(req.query.actor_id || req.header('x-actor-id') || '');
  const tab = String(req.query.tab || 'todo');
  if (!['todo', 'mine', 'done'].includes(tab)) {
    return res.status(400).json({ ok: false, code: 'BAD_TAB', message: 'tab must be todo, mine or done' });
  }
  let rows = db.approvals;
  if (tab === 'todo') {
    rows = rows.filter((a) => {
      const step = currentStep(a);
      return a.status === 'pending' && step && step.approver_id === actor;
    });
  } else if (tab === 'mine') {
    rows = rows.filter((a) => a.submitted_by === actor);
  } else {
    rows = rows.filter(
      (a) => APPROVAL_STATUSES.includes(a.status)
        && a.status !== 'pending'
        && (a.submitted_by === actor
          || db.steps.some((s) => s.approval_id === a.id && s.approver_id === actor && s.action !== 'pending'))
    );
  }
  res.json({
    tab,
    actor_id: actor,
    total: rows.length,
    approvals: rows.map(publicApproval),
  });
});

sales.get('/approvals/:aid', (req, res) => {
  const approval = findApproval(req.params.aid);
  if (!approval) {
    return res.status(404).json({ ok: false, code: 'APPROVAL_NOT_FOUND', message: 'approval not found' });
  }
  res.json({ approval: publicApproval(approval), quote: publicQuote(findQuote(approval.quote_id)) });
});

for (const [verb, action] of [['approve', 'approve'], ['reject', 'reject'], ['withdraw', null]]) {
  sales.post(`/approvals/:aid/${verb}`, (req, res) => {
    const result = action
      ? decide(req.params.aid, action, req.body || {})
      : withdrawApproval(req.params.aid, req.body || {});
    if (result.error) return sendError(res, result.error);
    res.json({ ok: true, ...result });
  });
}

app.use('/api/v1/sales', sales);
app.use('/api/sales', sales); // also serve the short paths from the brief

app.post('/api/v1/approvals/reminder-sweep', (req, res) => {
  res.json({ ok: true, ...runReminderSweep(req.body?.now) });
});
app.post('/api/approvals/reminder-sweep', (req, res) => {
  res.json({ ok: true, ...runReminderSweep(req.body?.now) });
});

app.get('/api/v1/notifications', (_req, res) => res.json({
  total: db.notifications.length,
  notifications: [...db.notifications],
}));

app.get('/api/v1/events', (_req, res) => res.json({ total: db.events.length, events: [...db.events] }));

app.get('/api/v1/steps', (req, res) => {
  let rows = db.steps;
  if (req.query.approval_id) rows = rows.filter((s) => s.approval_id === String(req.query.approval_id));
  res.json({ total: rows.length, steps: [...rows] });
});

// ------------------------------------------------------------------
// 7. OpenAPI description
// ------------------------------------------------------------------
const ok = (description) => ({ description });
const OPENAPI_PATHS = {
  '/api/v1/sales/quotes/{qid}/submit': {
    post: {
      summary: 'Submit a quote to the approval routing service',
      parameters: [{ name: 'qid', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                submitted_by: { type: 'string' },
                client_ip: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        201: ok('submitted, approval created'),
        404: ok('QUOTE_NOT_FOUND'),
        409: ok('QUOTE_NOT_SUBMITTABLE'),
        422: ok('UNKNOWN_TIER / INVALID_AMOUNT / QUOTE_EXCEEDS_MAX_AUTHORITY'),
      },
    },
  },
  '/api/v1/sales/approvals': {
    get: {
      summary: 'List approvals by tab (todo / mine / done)',
      parameters: [
        { name: 'tab', in: 'query', required: false, schema: { type: 'string', enum: ['todo', 'mine', 'done'] } },
        { name: 'actor_id', in: 'query', required: false, schema: { type: 'string' } },
      ],
      responses: { 200: ok('list'), 400: ok('BAD_TAB') },
    },
  },
  '/api/v1/sales/approvals/{aid}': {
    get: {
      summary: 'Approval detail with its append-only step log',
      parameters: [{ name: 'aid', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: ok('detail'), 404: ok('APPROVAL_NOT_FOUND') },
    },
  },
  '/api/v1/sales/approvals/{aid}/approve': {
    post: {
      summary: 'Approve the current step',
      parameters: [{ name: 'aid', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: ok('approved or advanced to next step'),
        403: ok('NOT_CURRENT_APPROVER'),
        409: ok('APPROVAL_NOT_PENDING / QUOTE_CHANGED_SINCE_SUBMIT'),
      },
    },
  },
  '/api/v1/sales/approvals/{aid}/reject': {
    post: {
      summary: 'Reject the approval; comment must be at least 10 characters',
      parameters: [{ name: 'aid', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: ok('rejected'), 403: ok('NOT_CURRENT_APPROVER'), 409: ok('QUOTE_CHANGED_SINCE_SUBMIT'), 422: ok('COMMENT_TOO_SHORT') },
    },
  },
  '/api/v1/sales/approvals/{aid}/withdraw': {
    post: {
      summary: 'Withdraw a pending approval; submitter only',
      parameters: [{ name: 'aid', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: ok('withdrawn'), 403: ok('NOT_SUBMITTER'), 409: ok('APPROVAL_NOT_PENDING') },
    },
  },
  '/api/v1/approvals/reminder-sweep': {
    post: {
      summary: 'Run the 24h / 48h reminder sweep with the injected clock',
      responses: { 200: ok('sweep summary') },
    },
  },
  '/api/v1/notifications': { get: { summary: 'Stub notification log', responses: { 200: ok('notifications') } } },
  '/api/v1/events': { get: { summary: 'Domain event log including quote.approved', responses: { 200: ok('events') } } },
  '/api/v1/meta': { get: { summary: 'Tiers, routing, thresholds and actor registry', responses: { 200: ok('meta') } } },
};

app.get('/api/v1/openapi.json', (_req, res) => res.json({
  openapi: '3.0.3',
  info: {
    title: 'Quotation Approval Workflow API',
    version: '1.0.0',
    description: 'Synthetic demo. Approvals are routed by tier and every step action appends an immutable row.',
  },
  servers: [{ url: '/api/v1' }],
  paths: OPENAPI_PATHS,
  components: {
    schemas: {
      Approval: {
        type: 'object',
        required: ['id', 'quote_id', 'revision', 'tier', 'status', 'submitted_by', 'snapshot_hash'],
        properties: {
          id: { type: 'string' },
          quote_id: { type: 'string' },
          revision: { type: 'integer' },
          tier: { type: 'string', enum: TIERS },
          status: { type: 'string', enum: APPROVAL_STATUSES },
          submitted_by: { type: 'string' },
          submitted_at: { type: 'string', format: 'date-time' },
          snapshot_hash: { type: 'string', description: 'SHA-256 of canonical calc_snapshot' },
          current_step: { type: 'integer', nullable: true },
          current_approver_id: { type: 'string', nullable: true },
          steps: { type: 'array', items: { $ref: '#/components/schemas/ApprovalStep' } },
        },
      },
      ApprovalStep: {
        type: 'object',
        required: ['id', 'approval_id', 'step_no', 'approver_id', 'approver_role', 'action'],
        properties: {
          id: { type: 'string' },
          approval_id: { type: 'string' },
          step_no: { type: 'integer' },
          approver_id: { type: 'string' },
          approver_role: { type: 'string' },
          action: { type: 'string', enum: STEP_ACTIONS },
          comment: { type: 'string' },
          acted_at: { type: 'string', format: 'date-time', nullable: true },
          client_ip: { type: 'string', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      Quote: {
        type: 'object',
        required: ['quote_id', 'revision', 'tier', 'status', 'snapshot_hash'],
        properties: {
          quote_id: { type: 'string' },
          revision: { type: 'integer' },
          tier: { type: 'string', enum: TIERS },
          amount: { type: 'number' },
          status: { type: 'string' },
          calc_snapshot: { type: 'object' },
          snapshot_hash: { type: 'string' },
          valid_until: { type: 'string', format: 'date-time', nullable: true },
        },
      },
    },
  },
}));

app.get('/api/v1/contract/summary', (_req, res) => res.json({
  contract: 'Quotation Approval Workflow Shared Contract v1',
  tiers: TIERS,
  approval_statuses: APPROVAL_STATUSES,
  step_actions: STEP_ACTIONS,
  tier_routes: tierRouteSummary(),
  valid_until_days: VALID_UNTIL_DAYS,
  reminder_hours: REMINDER_HOURS,
  snapshot_algorithm: 'sha256 of canonical JSON of calc_snapshot',
  notification_channel: 'stub',
}));

// ------------------------------------------------------------------
// 8. Boot
// ------------------------------------------------------------------
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[quote-approval-flow] listening on http://0.0.0.0:${PORT}`);
  });
}

export default app;
