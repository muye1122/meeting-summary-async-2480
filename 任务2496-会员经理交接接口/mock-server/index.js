/**
 * Member handover and CRM sync API (mock business service).
 *
 * Implements, with an in-memory data layer only:
 *   - six business endpoints (list, detail, package patch, assign, claim, return)
 *   - three-state handover machine: pending_claim / returned_for_info / claimed
 *   - role scoping: director (whole department), manager (department queue),
 *     consultant (only the handovers they signed)
 *   - optimistic locking (version snapshot + compare-and-swap) for claim, so
 *     concurrent claims yield exactly one winner and 409 for the rest
 *   - HANDOVER_INCOMPLETE (422), NOT_ASSIGNED_MANAGER (403), RETURN validation
 *   - notification records for the signing consultant and the technical lead
 *   - outbox-backed, idempotent CRM upsert with 1 / 5 / 30 minute backoff
 *
 * All organisations, people, phones and contract numbers below are SYNTHETIC
 * fictional demo data. No external services are contacted: the CRM client is a
 * local stub with a documented integration point in README.md.
 */
import express from 'express';
import * as outbox from './outbox.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
const PORT = process.env.PORT || 3001;

// ============================================================
// 1. State machine and validation helpers (pure functions)
// ============================================================
export const STATES = ['pending_claim', 'returned_for_info', 'claimed'];
export const STATE_LABELS = {
  pending_claim: '待领取',
  returned_for_info: '退回补充中',
  claimed: '已领取',
};

export const TRANSITIONS = {
  pending_claim: ['returned_for_info', 'claimed'],
  returned_for_info: ['pending_claim'],
  claimed: ['returned_for_info'],
};

export function canTransition(from, to) {
  return Object.prototype.hasOwnProperty.call(TRANSITIONS, from) && TRANSITIONS[from].includes(to);
}

export const REQUIRED_FIELDS = [
  { key: 'enterprise_name', label: '会员企业全称', minLength: 2 },
  { key: 'contact_name', label: '联系人姓名', minLength: 2 },
  { key: 'contact_phone', label: '联系人电话', pattern: /^1\d{10}$/ },
  { key: 'planned_onboarding_date', label: '计划入驻日期', pattern: /^\d{4}-\d{2}-\d{2}$/ },
  { key: 'contract_no', label: '合同号', minLength: 4 },
];

function fieldIsValid(value, field) {
  const text = String(value ?? '').trim();
  if (!text) return false;
  if (field.minLength && text.length < field.minLength) return false;
  if (field.pattern && !field.pattern.test(text)) return false;
  return true;
}

/** Recompute the missing-field list from the current package snapshot. */
export function recomputeMissingFields(pkg) {
  return REQUIRED_FIELDS.filter((field) => !fieldIsValid(pkg?.[field.key], field)).map((field) => field.key);
}

export function labelsForFields(keys) {
  return keys.map((key) => REQUIRED_FIELDS.find((f) => f.key === key)?.label || key);
}

export function validateReturnReason(reason) {
  const value = String(reason ?? '').trim();
  if (value.length < 10) {
    return { ok: false, code: 'REASON_TOO_SHORT', message: 'return reason must be at least 10 characters' };
  }
  return { ok: true, value };
}

// ============================================================
// 2. Synthetic actors and handover seed data
// ============================================================
export const ACTORS = [
  { id: 'actor-director', name: '示例·总监', role: 'director', department: 'dept-east', employee_id: 'EMP-9001' },
  { id: 'actor-manager-a', name: '示例·会员经理甲', role: 'manager', department: 'dept-east', employee_id: 'EMP-9002' },
  { id: 'actor-manager-b', name: '示例·会员经理乙', role: 'manager', department: 'dept-east', employee_id: 'EMP-9003' },
  { id: 'actor-manager-c', name: '示例·会员经理丙', role: 'manager', department: 'dept-west', employee_id: 'EMP-9004' },
  { id: 'actor-consultant-1', name: '示例·签约顾问甲', role: 'consultant', department: 'dept-east', employee_id: 'EMP-9005' },
  { id: 'actor-consultant-2', name: '示例·签约顾问乙', role: 'consultant', department: 'dept-east', employee_id: 'EMP-9006' },
  { id: 'actor-consultant-3', name: '示例·签约顾问丙', role: 'consultant', department: 'dept-west', employee_id: 'EMP-9007' },
  { id: 'actor-tech-lead', name: '示例·技术负责人', role: 'tech_lead', department: 'dept-platform', employee_id: 'EMP-9008' },
];

const COMPLETE_PACKAGE = {
  enterprise_name: '示例会员企业甲',
  contact_name: '示例联系人甲',
  contact_phone: '13800000001',
  planned_onboarding_date: '2026-12-15',
  contract_no: 'HT-2026-0001',
};

const HANDOVER_SEED = [
  {
    id: 'ho-1001', contract_id: 'CTR-2026-1001', department: 'dept-east',
    signing_consultant_id: 'actor-consultant-1', status: 'pending_claim',
    package: { ...COMPLETE_PACKAGE }, title: '示例企业甲会员交接',
  },
  {
    id: 'ho-1002', contract_id: 'CTR-2026-1002', department: 'dept-east',
    signing_consultant_id: 'actor-consultant-2', status: 'pending_claim',
    package: {
      ...COMPLETE_PACKAGE, enterprise_name: '示例会员企业乙',
      contract_no: 'HT-2026-1002', contact_phone: '', planned_onboarding_date: '',
    },
    title: '示例企业乙会员交接（材料待补）',
  },
  {
    id: 'ho-1003', contract_id: 'CTR-2026-1003', department: 'dept-east',
    signing_consultant_id: 'actor-consultant-1', status: 'pending_claim',
    assigned_manager_id: 'actor-manager-a',
    package: { ...COMPLETE_PACKAGE, enterprise_name: '示例会员企业丙', contract_no: 'HT-2026-1003' },
    title: '示例企业丙会员交接（已指定经理甲）',
  },
  {
    id: 'ho-1004', contract_id: 'CTR-2026-1004', department: 'dept-east',
    signing_consultant_id: 'actor-consultant-2', status: 'returned_for_info',
    return_reason: '联系人电话无法接通，请补充有效号码', returned_by: 'actor-manager-b',
    package: { ...COMPLETE_PACKAGE, enterprise_name: '示例会员企业丁', contract_no: 'HT-2026-1004', contact_phone: '' },
    title: '示例企业丁会员交接（退回补充中）',
  },
  {
    id: 'ho-1005', contract_id: 'CTR-2026-1005', department: 'dept-west',
    signing_consultant_id: 'actor-consultant-3', status: 'pending_claim',
    package: { ...COMPLETE_PACKAGE, enterprise_name: '示例会员企业戊', contract_no: 'HT-2026-1005' },
    title: '示例企业戊会员交接（其他部门）',
  },
  {
    id: 'ho-1006', contract_id: 'CTR-2026-1006', department: 'dept-east',
    signing_consultant_id: 'actor-consultant-1', status: 'claimed',
    claimed_by: 'actor-manager-a', claimed_at: '2026-11-23T09:00:00.000Z',
    crm_sync_status: 'synced', crm_sync_attempts: 1,
    package: { ...COMPLETE_PACKAGE, enterprise_name: '示例会员企业己', contract_no: 'HT-2026-1006' },
    title: '示例企业己会员交接（已完成）',
  },
];

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function findActor(id) { return ACTORS.find((actor) => actor.id === id); }
function findHandover(id) { return db.handovers.find((handover) => handover.id === id); }
function isoAt() { return new Date().toISOString(); }

let claimYieldMs = 0;

function makeHandover(seed) {
  const now = isoAt();
  const pkg = clone(seed.package || COMPLETE_PACKAGE);
  return {
    id: seed.id,
    contract_id: seed.contract_id,
    title: seed.title || '示例会员交接',
    department: seed.department,
    signing_consultant_id: seed.signing_consultant_id,
    assigned_manager_id: seed.assigned_manager_id || null,
    status: seed.status || 'pending_claim',
    claimed_by: seed.claimed_by || null,
    claimed_by_name: seed.claimed_by ? findActor(seed.claimed_by)?.name || null : null,
    claimed_at: seed.claimed_at || null,
    returned_by: seed.returned_by || null,
    return_reason: seed.return_reason || null,
    package: pkg,
    missing_fields: recomputeMissingFields(pkg),
    version: 0,
    crm_sync_status: seed.crm_sync_status || 'idle',
    crm_sync_attempts: seed.crm_sync_attempts || 0,
    crm_synced_at: null,
    created_at: now,
    updated_at: now,
  };
}

// ============================================================
// 3. In-memory store and audit helpers
// ============================================================
let db;
let seq = { event: 0, notification: 0 };

function resetStore() {
  seq = { event: 0, notification: 0 };
  claimYieldMs = 0;
  outbox.resetOutbox();
  db = {
    handovers: HANDOVER_SEED.map(makeHandover),
    events: [],
    notifications: [],
  };
}
resetStore();

function appendEvent({ handover, action, from, to, actor, detail }) {
  const event = {
    id: `ev_${String(++seq.event).padStart(6, '0')}`,
    handover_id: handover.id,
    action,
    from_status: from,
    to_status: to,
    actor_id: actor ? actor.id : 'system',
    actor_role: actor ? actor.role : 'system',
    detail: detail || null,
    created_at: isoAt(),
  };
  db.events.push(event);
  return event;
}

function pushNotification({ type, recipient_id, handover_id, message }) {
  const notification = {
    id: `nt_${String(++seq.notification).padStart(6, '0')}`,
    type,
    recipient_id,
    recipient_role: findActor(recipient_id)?.role || null,
    handover_id,
    message,
    created_at: isoAt(),
    read: false,
  };
  db.notifications.push(notification);
  return notification;
}

function publicHandover(handover) {
  return {
    id: handover.id,
    contract_id: handover.contract_id,
    title: handover.title,
    department: handover.department,
    signing_consultant_id: handover.signing_consultant_id,
    assigned_manager_id: handover.assigned_manager_id,
    status: handover.status,
    status_label: STATE_LABELS[handover.status],
    claimed_by: handover.claimed_by,
    claimed_by_name: handover.claimed_by_name,
    claimed_at: handover.claimed_at,
    returned_by: handover.returned_by,
    return_reason: handover.return_reason,
    package: clone(handover.package),
    missing_fields: clone(handover.missing_fields),
    missing_labels: labelsForFields(handover.missing_fields),
    version: handover.version,
    crm_sync_status: handover.crm_sync_status,
    crm_sync_attempts: handover.crm_sync_attempts,
    crm_synced_at: handover.crm_synced_at,
    created_at: handover.created_at,
    updated_at: handover.updated_at,
  };
}

// ============================================================
// 4. Permission and transition validation (pure helpers)
// ============================================================
export function canList(actor, handover) {
  if (!actor) return false;
  if (actor.role === 'director') return actor.department === handover.department;
  if (actor.role === 'manager') {
    return actor.department === handover.department
      && (handover.status === 'pending_claim'
        || handover.claimed_by === actor.id
        || handover.returned_by === actor.id);
  }
  if (actor.role === 'consultant') return handover.signing_consultant_id === actor.id;
  return false;
}

export function canView(actor, handover) {
  if (!actor) return false;
  if (actor.role === 'director' || actor.role === 'manager') return actor.department === handover.department;
  if (actor.role === 'consultant') return handover.signing_consultant_id === actor.id;
  return false;
}

export function validateClaim(actor, handover) {
  if (!actor || actor.role !== 'manager' || actor.department !== handover.department) {
    return { ok: false, status: 403, code: 'FORBIDDEN', message: 'only a membership manager of this department may claim' };
  }
  if (handover.assigned_manager_id && handover.assigned_manager_id !== actor.id) {
    return { ok: false, status: 403, code: 'NOT_ASSIGNED_MANAGER', message: 'this handover is assigned to another membership manager' };
  }
  if (handover.status === 'claimed') {
    return { ok: false, status: 409, code: 'ALREADY_CLAIMED', message: 'handover has already been claimed' };
  }
  if (handover.status !== 'pending_claim') {
    return { ok: false, status: 409, code: 'ILLEGAL_TRANSITION', message: `cannot claim from ${handover.status}` };
  }
  if (handover.missing_fields.length > 0) {
    return {
      ok: false,
      status: 422,
      code: 'HANDOVER_INCOMPLETE',
      message: 'handover package is incomplete; supplement the missing fields before claiming',
      missing_fields: clone(handover.missing_fields),
      missing_labels: labelsForFields(handover.missing_fields),
    };
  }
  return { ok: true };
}

/** Pure compare-and-swap guard, shared by commitClaim and the unit suite. */
export function assertClaimSnapshot(handover, snapshot) {
  if (!handover) return { ok: false, status: 404, code: 'HANDOVER_NOT_FOUND', message: 'handover not found' };
  if (handover.version !== snapshot.version || handover.status !== snapshot.status) {
    return { ok: false, status: 409, code: 'VERSION_CONFLICT', message: 'handover was changed by another request; retry' };
  }
  return { ok: true };
}

/**
 * Compare-and-swap commit for a claim. The caller passes the version/status
 * snapshot it validated. A concurrent writer that committed in the meantime
 * makes the snapshot stale, and this function returns 409 VERSION_CONFLICT.
 */
export function commitClaim(handoverId, actorId, snapshot) {
  const handover = findHandover(handoverId);
  const guard = assertClaimSnapshot(handover, snapshot);
  if (!guard.ok) return guard;
  const actor = findActor(actorId);
  const from = handover.status;
  handover.status = 'claimed';
  handover.claimed_by = actorId;
  handover.claimed_by_name = actor?.name || null;
  handover.claimed_at = isoAt();
  handover.version += 1;
  handover.updated_at = isoAt();
  handover.crm_sync_status = 'pending';
  appendEvent({ handover, action: 'claim', from, to: 'claimed', actor, detail: { external_ref: handover.contract_id } });
  outbox.enqueueCrmSync(handover);
  return { ok: true, handover: publicHandover(handover) };
}

// CRM status callback: keep the handover row in sync and raise notifications.
outbox.setStatusSink((update) => {
  const handover = findHandover(update.handover_id);
  if (!handover) return;
  handover.crm_sync_attempts = update.attempts;
  handover.updated_at = isoAt();
  if (update.status === 'synced') {
    handover.crm_sync_status = 'synced';
    handover.crm_synced_at = isoAt();
    appendEvent({
      handover, action: 'crm_sync_succeeded', from: handover.crm_sync_status, to: 'synced',
      actor: null, detail: { external_ref: update.external_ref, outbox_id: update.outbox_id },
    });
  } else if (update.status === 'failed') {
    handover.crm_sync_status = 'failed';
    pushNotification({
      type: 'crm_sync_failed',
      recipient_id: 'actor-tech-lead',
      handover_id: handover.id,
      message: `CRM sync failed after ${update.attempts} attempts for contract ${update.external_ref}: ${update.error}`,
    });
    appendEvent({
      handover, action: 'crm_sync_failed', from: 'retrying', to: 'failed',
      actor: null, detail: { external_ref: update.external_ref, attempts: update.attempts },
    });
  } else if (update.status === 'retry_scheduled') {
    handover.crm_sync_status = 'retrying';
  }
});

// ============================================================
// 5. Routes (mounted at /api/sales and /api/v1/sales)
// ============================================================
const router = express.Router();

function actorFromRequest(req) {
  const id = req.body?.actor || req.headers['x-actor'] || req.query.actor;
  return findActor(String(id || ''));
}

function requireActor(req, res) {
  const actor = actorFromRequest(req);
  if (!actor) {
    res.status(401).json({ code: 'ACTOR_REQUIRED', message: 'provide a known actor via body, X-Actor header or query' });
    return null;
  }
  return actor;
}

function fail(res, result) {
  return res.status(result.status).json({
    code: result.code,
    message: result.message,
    ...(result.missing_fields ? { missing_fields: result.missing_fields } : {}),
    ...(result.missing_labels ? { missing_labels: result.missing_labels } : {}),
  });
}

router.get('/health', (_req, res) => res.json({
  ok: true,
  service: 'member-handover-crm-sync',
  ts: Date.now(),
  counts: { handovers: db.handovers.length, events: db.events.length, outbox: outbox.getRows().length },
}));

router.get('/meta', (_req, res) => res.json({
  states: STATES,
  state_labels: STATE_LABELS,
  transitions: TRANSITIONS,
  required_fields: REQUIRED_FIELDS.map(({ key, label }) => ({ key, label })),
  backoff_minutes: outbox.BACKOFF_MINUTES,
  max_attempts: outbox.MAX_ATTEMPTS,
  actors: ACTORS,
}));

/** Business endpoint 1: scoped list with optional ?status= filter. */
router.get('/handovers', (req, res) => {
  const actor = requireActor(req, res);
  if (!actor) return;
  const status = req.query.status ? String(req.query.status) : null;
  if (status && !STATES.includes(status)) {
    return res.status(400).json({ code: 'INVALID_STATUS', message: `status must be one of ${STATES.join(', ')}` });
  }
  let list = db.handovers.filter((handover) => canList(actor, handover));
  if (status) list = list.filter((handover) => handover.status === status);
  res.json({
    total: list.length,
    actor: { id: actor.id, role: actor.role, department: actor.department },
    handovers: list.map((handover) => ({
      ...publicHandover(handover),
      claimable_by_you: validateClaim(actor, handover).ok,
    })),
  });
});

/** Business endpoint 2: detail. */
router.get('/handovers/:hid', (req, res) => {
  const actor = requireActor(req, res);
  if (!actor) return;
  const handover = findHandover(req.params.hid);
  if (!handover || !canView(actor, handover)) {
    return res.status(404).json({ code: 'HANDOVER_NOT_FOUND', message: 'handover not found' });
  }
  res.json({ ...publicHandover(handover), claimable_by_you: validateClaim(actor, handover).ok });
});

/** Business endpoint 3: signing consultant supplements the package. */
router.patch('/handovers/:hid/package', (req, res) => {
  const actor = requireActor(req, res);
  if (!actor) return;
  const handover = findHandover(req.params.hid);
  if (!handover) return res.status(404).json({ code: 'HANDOVER_NOT_FOUND', message: 'handover not found' });
  if (actor.role !== 'consultant' || actor.id !== handover.signing_consultant_id) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'only the signing consultant may supplement the package' });
  }
  if (!canTransition(handover.status, 'pending_claim') && handover.status !== 'pending_claim') {
    return res.status(409).json({
      code: 'ILLEGAL_TRANSITION',
      message: `package cannot be edited from ${handover.status}`,
      from: handover.status,
    });
  }
  const incoming = (req.body?.package && typeof req.body.package === 'object') ? req.body.package : (req.body || {});
  let changed = 0;
  for (const field of REQUIRED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(incoming, field.key)) {
      handover.package[field.key] = String(incoming[field.key] ?? '').trim();
      changed += 1;
    }
  }
  handover.missing_fields = recomputeMissingFields(handover.package);
  const from = handover.status;
  let autoReturned = false;
  if (handover.status === 'returned_for_info' && handover.missing_fields.length === 0) {
    handover.status = 'pending_claim';
    handover.return_reason = null;
    handover.returned_by = null;
    autoReturned = true;
  }
  handover.version += 1;
  handover.updated_at = isoAt();
  const event = appendEvent({
    handover, action: 'patch_package', from, to: handover.status, actor,
    detail: { changed_fields: changed, missing_fields: clone(handover.missing_fields), auto_returned: autoReturned },
  });
  res.json({
    ok: true,
    changed_fields: changed,
    missing_fields: clone(handover.missing_fields),
    missing_labels: labelsForFields(handover.missing_fields),
    auto_returned_to_pending_claim: autoReturned,
    from,
    to: handover.status,
    event,
    handover: publicHandover(handover),
  });
});

/** Business endpoint 4: director assigns a target manager (claim not yet done). */
router.post('/handovers/:hid/assign', (req, res) => {
  const actor = requireActor(req, res);
  if (!actor) return;
  const handover = findHandover(req.params.hid);
  if (!handover) return res.status(404).json({ code: 'HANDOVER_NOT_FOUND', message: 'handover not found' });
  if (actor.role !== 'director' || actor.department !== handover.department) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'only the department director may assign a manager' });
  }
  if (handover.status === 'claimed') {
    return res.status(409).json({ code: 'ALREADY_CLAIMED', message: 'a claimed handover cannot be reassigned' });
  }
  const target = findActor(String(req.body?.manager_id || ''));
  if (!target || target.role !== 'manager' || target.department !== handover.department) {
    return res.status(422).json({
      code: 'INVALID_TARGET_MANAGER',
      message: 'manager_id must reference a membership manager of the same department',
    });
  }
  const from = handover.status;
  handover.assigned_manager_id = target.id;
  handover.version += 1;
  handover.updated_at = isoAt();
  const event = appendEvent({
    handover, action: 'assign', from, to: handover.status, actor,
    detail: { assigned_manager_id: target.id },
  });
  res.json({
    ok: true,
    assigned_manager_id: target.id,
    status: handover.status,
    claim_completed: false,
    message: 'manager designated; the handover completes only when that manager actually claims it',
    from,
    to: handover.status,
    event,
    handover: publicHandover(handover),
  });
});

/** Business endpoint 5: optimistic-locked claim. */
router.post('/handovers/:hid/claim', async (req, res) => {
  const actor = requireActor(req, res);
  if (!actor) return;
  const handover = findHandover(req.params.hid);
  if (!handover) return res.status(404).json({ code: 'HANDOVER_NOT_FOUND', message: 'handover not found' });

  const check = validateClaim(actor, handover);
  if (!check.ok) return fail(res, check);

  // Snapshot the row we validated. If `claimYieldMs` is set (test helper), two
  // concurrent requests can validate the same snapshot before either commits;
  // the compare-and-swap in commitClaim then lets exactly one of them win.
  const snapshot = { version: handover.version, status: handover.status };
  if (claimYieldMs > 0) await new Promise((resolve) => setTimeout(resolve, claimYieldMs));

  const result = commitClaim(req.params.hid, actor.id, snapshot);
  if (!result.ok) return fail(res, result);
  res.json({
    ok: true,
    from: snapshot.status,
    to: 'claimed',
    claimed_by: result.handover.claimed_by,
    claimed_at: result.handover.claimed_at,
    version: result.handover.version,
    crm_sync_status: result.handover.crm_sync_status,
    handover: result.handover,
  });
});

/** Business endpoint 6: return for supplement, notify the signing consultant. */
router.post('/handovers/:hid/return', (req, res) => {
  const actor = requireActor(req, res);
  if (!actor) return;
  const handover = findHandover(req.params.hid);
  if (!handover) return res.status(404).json({ code: 'HANDOVER_NOT_FOUND', message: 'handover not found' });
  if (actor.role !== 'manager' || actor.department !== handover.department) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'only a membership manager of this department may return' });
  }
  if (handover.assigned_manager_id && handover.assigned_manager_id !== actor.id) {
    return res.status(403).json({ code: 'NOT_ASSIGNED_MANAGER', message: 'this handover is assigned to another membership manager' });
  }
  if (handover.status !== 'pending_claim' && handover.status !== 'claimed') {
    return res.status(409).json({ code: 'ILLEGAL_TRANSITION', message: `cannot return from ${handover.status}` });
  }
  const check = validateReturnReason(req.body?.reason);
  if (!check.ok) return res.status(422).json({ code: check.code, message: check.message });

  const from = handover.status;
  handover.status = 'returned_for_info';
  handover.return_reason = check.value;
  handover.returned_by = actor.id;
  let cancelledOutbox = 0;
  if (from === 'claimed') {
    handover.claimed_by = null;
    handover.claimed_by_name = null;
    handover.claimed_at = null;
    handover.crm_sync_status = 'idle';
    cancelledOutbox = outbox.cancelForHandover(handover.id);
  }
  handover.version += 1;
  handover.updated_at = isoAt();
  const event = appendEvent({
    handover, action: 'return', from, to: 'returned_for_info', actor,
    detail: { reason: check.value, cancelled_outbox_rows: cancelledOutbox },
  });
  const notification = pushNotification({
    type: 'return_for_info',
    recipient_id: handover.signing_consultant_id,
    handover_id: handover.id,
    message: `Handover ${handover.id} returned for information: ${check.value}`,
  });
  res.json({
    ok: true,
    from,
    to: 'returned_for_info',
    reason: check.value,
    event,
    notification,
    handover: publicHandover(handover),
  });
});

// ---------- Observability and integration inspection ----------
router.get('/events', (_req, res) => res.json({ total: db.events.length, events: db.events }));
router.get('/notifications', (_req, res) => res.json({ total: db.notifications.length, notifications: db.notifications }));
router.get('/outbox', (_req, res) => {
  const rows = outbox.getRows();
  res.json({ total: rows.length, simulated_now: new Date(outbox.now()).toISOString(), rows });
});
router.get('/crm-records', (_req, res) => {
  const records = outbox.getCrmRecords();
  res.json({ total: records.length, records });
});

router.get('/openapi.json', (_req, res) => res.json(openApiDocument()));

// ---------- Deterministic test helpers ----------
router.post('/test/reset', (_req, res) => {
  resetStore();
  res.json({ ok: true, handovers: db.handovers.length });
});
router.post('/test/advance', async (req, res) => {
  const result = await outbox.advanceAndFlush(Number(req.body?.ms || 0));
  res.json({ ok: true, ...result, rows: outbox.getRows(), crm_sync_status_by_handover: statusByHandover() });
});
router.post('/test/crm-failures', (req, res) => {
  const remaining = outbox.configureCrmFailures(req.body?.count ?? 0);
  res.json({ ok: true, failures_remaining: remaining });
});
router.post('/test/claim-yield', (req, res) => {
  claimYieldMs = Math.max(0, Number(req.body?.ms || 0));
  res.json({ ok: true, claim_yield_ms: claimYieldMs });
});
router.post('/test/set-package', (req, res) => {
  const handover = findHandover(String(req.body?.id || ''));
  if (!handover) return res.status(404).json({ code: 'HANDOVER_NOT_FOUND' });
  const patch = req.body?.package || {};
  for (const field of REQUIRED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, field.key)) {
      handover.package[field.key] = String(patch[field.key] ?? '').trim();
    }
  }
  handover.missing_fields = recomputeMissingFields(handover.package);
  handover.version += 1;
  handover.updated_at = isoAt();
  res.json({ ok: true, handover: publicHandover(handover) });
});

function statusByHandover() {
  return Object.fromEntries(db.handovers.map((handover) => [handover.id, handover.crm_sync_status]));
}

app.use('/api/sales', router);
app.use('/api/v1/sales', router);

// ============================================================
// 6. OpenAPI description (served as JSON, no extra delivery file)
// ============================================================
export function openApiDocument() {
  const handoverRef = { $ref: '#/components/schemas/Handover' };
  const errorResponses = {
    403: { description: 'Forbidden: wrong role, department or designated manager' },
    409: { description: 'Conflict: illegal transition, already claimed or version conflict' },
    422: { description: 'Validation failed: incomplete package, short reason or invalid target' },
  };
  return {
    openapi: '3.0.3',
    info: {
      title: 'Member Handover and CRM Sync API',
      version: '1.0.0',
      description: 'Synthetic demo. Node + Express + in-memory store; CRM delivered through an outbox with a local stub. No real personal or enterprise data.',
    },
    servers: [{ url: '/api/sales' }],
    paths: {
      '/handovers': {
        get: {
          summary: 'List handovers visible to the acting role',
          parameters: [
            { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: STATES } },
            { name: 'X-Actor', in: 'header', required: true, schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'Scoped handover list' }, ...errorResponses },
        },
      },
      '/handovers/{hid}': {
        get: {
          summary: 'Get one handover',
          parameters: [
            { name: 'hid', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'X-Actor', in: 'header', required: true, schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'Handover detail', content: { 'application/json': { schema: handoverRef } } }, 404: { description: 'Not found' } },
        },
      },
      '/handovers/{hid}/package': {
        patch: {
          summary: 'Signing consultant supplements the package; recompute missing_fields',
          parameters: [{ name: 'hid', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    actor: { type: 'string' },
                    package: {
                      type: 'object',
                      properties: Object.fromEntries(REQUIRED_FIELDS.map((field) => [field.key, { type: 'string' }])),
                    },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Package updated; returned_for_info may auto-return to pending_claim' }, ...errorResponses },
        },
      },
      '/handovers/{hid}/assign': {
        post: {
          summary: 'Director designates a target membership manager; claim is not completed',
          parameters: [{ name: 'hid', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['actor', 'manager_id'], properties: { actor: { type: 'string' }, manager_id: { type: 'string' } } } } },
          },
          responses: { 200: { description: 'Manager designated, status unchanged' }, ...errorResponses },
        },
      },
      '/handovers/{hid}/claim': {
        post: {
          summary: 'Membership manager claims; optimistic-locked, single winner',
          parameters: [{ name: 'hid', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['actor'], properties: { actor: { type: 'string' } } } } },
          },
          responses: {
            200: { description: 'Claimed; CRM sync row enqueued in outbox' },
            422: { description: 'HANDOVER_INCOMPLETE with missing_fields and missing_labels' },
            ...errorResponses,
          },
        },
      },
      '/handovers/{hid}/return': {
        post: {
          summary: 'Membership manager returns for supplement; notify signing consultant',
          parameters: [{ name: 'hid', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['actor', 'reason'], properties: { actor: { type: 'string' }, reason: { type: 'string', minLength: 10 } } } } },
          },
          responses: { 200: { description: 'Returned for information' }, ...errorResponses },
        },
      },
      '/outbox': { get: { summary: 'Inspect outbox rows and simulated clock' } },
      '/crm-records': { get: { summary: 'Inspect the idempotent CRM stub store keyed by contract_id' } },
      '/notifications': { get: { summary: 'Inspect consultant and technical-lead notifications' } },
    },
    components: {
      schemas: {
        Handover: {
          type: 'object',
          required: ['id', 'contract_id', 'status', 'missing_fields', 'version', 'crm_sync_status'],
          properties: {
            id: { type: 'string' },
            contract_id: { type: 'string', description: 'External reference used for idempotent CRM upsert' },
            status: { type: 'string', enum: STATES },
            assigned_manager_id: { type: 'string', nullable: true },
            claimed_by: { type: 'string', nullable: true },
            claimed_at: { type: 'string', nullable: true },
            package: { type: 'object' },
            missing_fields: { type: 'array', items: { type: 'string' } },
            missing_labels: { type: 'array', items: { type: 'string' } },
            version: { type: 'integer' },
            crm_sync_status: { type: 'string', enum: ['idle', 'pending', 'retrying', 'synced', 'failed'] },
            crm_sync_attempts: { type: 'integer' },
          },
        },
      },
    },
  };
}

// ============================================================
// 7. Boot (skipped when imported by the unit test runner)
// ============================================================
if (process.env.SALES_NO_LISTEN !== '1') {
  outbox.startWorker();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[mock] listening on http://0.0.0.0:${PORT}  handovers=${db.handovers.length}`);
  });
}
