/**
 * Transactional-outbox style CRM synchronisation helper.
 *
 * A successful handover claim enqueues one outbox row. A timer (or an explicit
 * test flush) delivers the row to the CRM client. Failures are retried with a
 * 1 / 5 / 30 / 30 minute backoff; the fifth failure marks the sync as failed
 * and notifies the technical lead through a status callback.
 *
 * The CRM client is a local STUB by default (no real network, no real data).
 * Replace `setCrmClient` with a real adapter at the documented integration
 * point in README.md. All data is synthetic fictional demo data.
 */

export const BACKOFF_MINUTES = [1, 5, 30, 30];
export const MAX_ATTEMPTS = 5;

let rows = [];
let seq = 0;
let virtualNow = Date.now();
let crmClient = defaultCrmClient;
let crmFailuresRemaining = 0;
let statusSink = () => {};
let workerTimer = null;

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function isoAt(ms = virtualNow) { return new Date(ms).toISOString(); }

function defaultCrmClient(payload) {
  // Stub: idempotent upsert keyed by the contract id (external reference).
  if (crmFailuresRemaining > 0) {
    crmFailuresRemaining -= 1;
    const error = new Error('CRM stub failure (simulated transport error)');
    error.code = 'CRM_STUB_FAILURE';
    throw error;
  }
  const ref = payload.external_ref;
  const previous = crmRecords.get(ref) || { sync_count: 0 };
  const record = {
    ...previous,
    ...clone(payload),
    updated_at: isoAt(),
    sync_count: previous.sync_count + 1,
  };
  crmRecords.set(ref, record);
  return { ok: true, external_ref: ref, record };
}

const crmRecords = new Map();

/** Replace the stub with a real CRM adapter (integration point). */
export function setCrmClient(fn) {
  if (typeof fn !== 'function') throw new Error('crm client must be a function');
  crmClient = fn;
}

/** Receive status transitions so the handover row and notifications can be updated. */
export function setStatusSink(fn) {
  statusSink = typeof fn === 'function' ? fn : () => {};
}

/** Virtual clock used by tests to fast-forward without sleeping. */
export function now() { return virtualNow; }

export function advance(ms) {
  const amount = Number(ms);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('ms must be a non-negative number');
  virtualNow += amount;
  return virtualNow;
}

/** Make the stub fail the next N delivery attempts (test helper). */
export function configureCrmFailures(count) {
  crmFailuresRemaining = Math.max(0, Number(count) || 0);
  return crmFailuresRemaining;
}

/** Deterministic reset for unit and end-to-end tests. */
export function resetOutbox() {
  rows = [];
  seq = 0;
  virtualNow = Date.now();
  crmClient = defaultCrmClient;
  crmFailuresRemaining = 0;
  crmRecords.clear();
}

/** Build the idempotent CRM payload. contract_id is the external reference. */
export function buildCrmPayload(handover) {
  return {
    external_ref: handover.contract_id,
    contract_id: handover.contract_id,
    contract_no: handover.package?.contract_no || null,
    enterprise: {
      name: handover.package?.enterprise_name || null,
      department: handover.department,
    },
    contact: {
      name: handover.package?.contact_name || null,
      phone: handover.package?.contact_phone || null,
    },
    manager_assignment: {
      manager_id: handover.claimed_by,
      manager_name: handover.claimed_by_name || null,
    },
    planned_onboarding_date: handover.package?.planned_onboarding_date || null,
  };
}

/** Enqueue one delivery. The row is due immediately. */
export function enqueueCrmSync(handover) {
  const at = isoAt();
  const row = {
    id: `ob_${String(++seq).padStart(6, '0')}`,
    handover_id: handover.id,
    external_ref: handover.contract_id,
    status: 'pending',
    attempts: 0,
    max_attempts: MAX_ATTEMPTS,
    payload: buildCrmPayload(handover),
    next_attempt_at: virtualNow,
    created_at: at,
    updated_at: at,
    last_error: null,
    last_result: null,
  };
  rows.push(row);
  return clone(row);
}

/** Cancel an undelivered sync when a claimed handover is returned for info. */
export function cancelForHandover(handoverId) {
  let cancelled = 0;
  for (const row of rows) {
    if (row.handover_id === handoverId && row.status === 'pending') {
      row.status = 'cancelled';
      row.updated_at = isoAt();
      cancelled += 1;
    }
  }
  return cancelled;
}

export function getRows() { return clone(rows); }

export function getCrmRecords() {
  return Array.from(crmRecords.values()).map(clone);
}

/**
 * Deliver every row that is due at the current virtual time.
 * A row is marked `processing` synchronously before the await, so a worker
 * tick and a test flush can never deliver the same row twice.
 */
export async function processDue() {
  const due = rows.filter((row) => row.status === 'pending' && row.next_attempt_at <= virtualNow);
  for (const row of due) {
    row.status = 'processing';
    row.updated_at = isoAt();
    try {
      const result = await crmClient(clone(row.payload));
      row.status = 'done';
      row.last_result = result && result.ok !== false ? 'success' : 'unknown';
      row.last_error = null;
      row.updated_at = isoAt();
      statusSink({
        handover_id: row.handover_id,
        external_ref: row.external_ref,
        status: 'synced',
        attempts: row.attempts,
        outbox_id: row.id,
      });
    } catch (error) {
      row.attempts += 1;
      row.last_error = error?.message || 'CRM delivery failed';
      row.last_result = 'failure';
      row.updated_at = isoAt();
      if (row.attempts >= MAX_ATTEMPTS) {
        row.status = 'failed';
        statusSink({
          handover_id: row.handover_id,
          external_ref: row.external_ref,
          status: 'failed',
          attempts: row.attempts,
          outbox_id: row.id,
          error: row.last_error,
        });
      } else {
        const delayMinutes = BACKOFF_MINUTES[Math.min(row.attempts - 1, BACKOFF_MINUTES.length - 1)];
        row.next_attempt_at = virtualNow + delayMinutes * 60_000;
        row.status = 'pending';
        statusSink({
          handover_id: row.handover_id,
          external_ref: row.external_ref,
          status: 'retry_scheduled',
          attempts: row.attempts,
          outbox_id: row.id,
          delay_minutes: delayMinutes,
          next_attempt_at: isoAt(row.next_attempt_at),
          error: row.last_error,
        });
      }
    }
  }
  return { processed: due.length, due_count: due.length };
}

/** Test helper: move the virtual clock forward, then flush due deliveries. */
export async function advanceAndFlush(ms) {
  const advancedTo = advance(ms);
  const result = await processDue();
  return { simulated_now: isoAt(advancedTo), ...result };
}

/** Start the timer that simulates asynchronous outbox draining. */
export function startWorker(intervalMs = 100) {
  if (workerTimer) return workerTimer;
  workerTimer = setInterval(() => {
    processDue().catch((error) => console.error('[outbox] worker error', error));
  }, intervalMs);
  if (typeof workerTimer.unref === 'function') workerTimer.unref();
  return workerTimer;
}

export function stopWorker() {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
}
