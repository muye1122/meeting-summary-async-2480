/**
 * SOP template version release service - runnable in-memory demo.
 *
 * Implements:
 *   - POST /api/sop/templates/{id}/publish  { release_notes }
 *       validate template integrity (>=1 step, all required step fields,
 *       non-empty release_notes), freeze the draft as version_no+1 with a
 *       deep-copied snapshot, write an audit record with a step diff summary.
 *   - POST /api/sop/templates/{id}/disable
 *       stop creating new instances; already running instances may still
 *       execute to completion; write an audit record with a diff summary.
 *   - Version isolation: each instance keeps a deep copy of the published
 *       version snapshot taken at trigger time. Later publishes, disables
 *       and draft edits never mutate a running instance.
 *   - There is NO endpoint to migrate a running instance to another version
 *       (documented in README.md).
 *
 * New instances always use the latest published version. The in-memory
 * store stands in for a real database; swap it in production. All data is
 * SYNTHETIC. No external services and no real personal or enterprise data.
 */
import express from 'express';
import crypto from 'node:crypto';
import { clone, diffSteps, emptyDiff, summarizeDiff, diffSummary } from './diff.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
const PORT = process.env.PORT || 3001;

// Re-export the pure diff helpers so unit tests and consumers can import
// everything from this single module.
export { clone, diffSteps, emptyDiff, summarizeDiff, diffSummary } from './diff.js';

// ============================================================
// 1. Constants and pure validation helpers
// ============================================================
export const TEMPLATE_STATUS = ['draft', 'published', 'disabled'];
export const INSTANCE_STATUS = ['running', 'completed'];
export const STEP_STATUS = ['pending', 'done'];

/** Every published step must carry these fields with a non-empty value. */
export const STEP_REQUIRED_FIELDS = ['id', 'title', 'assignee_role', 'time_limit_hours'];

export function validateReleaseNotes(notes) {
  const value = String(notes ?? '').trim();
  if (!value) {
    return { ok: false, code: 'RELEASE_NOTES_REQUIRED', message: 'release_notes must be a non-empty string' };
  }
  return { ok: true, value };
}

/**
 * Validate that a template draft is complete enough to be published.
 * Returns 422-shaped errors: non-empty release notes, at least one step,
 * every required field present, positive numeric time_limit_hours, unique ids.
 */
export function validateTemplateIntegrity(template, releaseNotes) {
  const notes = validateReleaseNotes(releaseNotes);
  if (!notes.ok) return notes;
  if (!template) {
    return { ok: false, code: 'TEMPLATE_NOT_FOUND', message: 'template not found' };
  }
  const steps = template.draft?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, code: 'TEMPLATE_NO_STEPS', message: 'template must contain at least one step' };
  }

  const invalid = [];
  const seen = new Set();
  steps.forEach((step, index) => {
    for (const field of STEP_REQUIRED_FIELDS) {
      const value = step?.[field];
      const empty = value === undefined || value === null
        || (typeof value === 'string' && value.trim() === '')
        || (Array.isArray(value) && value.length === 0);
      if (empty) invalid.push({ index, id: step?.id ?? null, field, reason: 'required' });
    }
    const hours = step?.time_limit_hours;
    if (hours !== undefined && hours !== null && hours !== ''
      && (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0)) {
      invalid.push({ index, id: step?.id ?? null, field: 'time_limit_hours', reason: 'must be a positive number' });
    }
    const id = String(step?.id ?? '');
    if (id && seen.has(id)) {
      invalid.push({ index, id, field: 'id', reason: 'duplicate step id' });
    }
    if (id) seen.add(id);
  });

  if (invalid.length) {
    return {
      ok: false,
      code: 'STEP_INCOMPLETE',
      message: 'one or more steps have missing or invalid required fields',
      invalid,
    };
  }
  return { ok: true, value: notes.value, step_count: steps.length };
}

function digest(steps) {
  return crypto.createHash('sha256').update(JSON.stringify(steps)).digest('hex');
}

// ============================================================
// 2. Synthetic seed data
// ============================================================
const SEED_TEMPLATES = [
  {
    id: 'tpl-intake-review',
    name: '会员入会资料审核',
    description: '示例模板（虚构）：入会资料的收集、核验、风控与归档。',
    steps: [
      { id: 'step-1', title: '收集入会申请', description: '收集示例申请表单', assignee_role: '会员经理', time_limit_hours: 24 },
      { id: 'step-2', title: '核验资质材料', description: '核对示例资质文件', assignee_role: '复核专员', time_limit_hours: 36 },
      { id: 'step-3', title: '完成风控校验', description: '运行示例风控规则', assignee_role: '风控专员', time_limit_hours: 48 },
      { id: 'step-4', title: '归档并通知', description: '归档示例结果并通知', assignee_role: '运营助理', time_limit_hours: 12 },
    ],
  },
];

function makeTemplate(seed) {
  const now = new Date().toISOString();
  return {
    id: seed.id,
    name: seed.name,
    description: seed.description || '',
    status: 'draft',
    current_version: 0,
    versions: [],
    draft: { steps: clone(seed.steps || []) },
    created_at: now,
    updated_at: now,
  };
}

// ============================================================
// 3. In-memory store
// ============================================================
let db;
let seq = { instance: 0, audit: 0 };

function resetStore() {
  seq = { instance: 0, audit: 0 };
  db = {
    templates: SEED_TEMPLATES.map(makeTemplate),
    instances: [],
    auditLog: [],
  };
}
resetStore();

const findTemplate = (id) => db.templates.find((t) => t.id === String(id));
const findInstance = (id) => db.instances.find((i) => i.id === String(id));
const latestVersion = (template) => (
  template.versions.length
    ? template.versions.reduce((a, b) => (b.version_no > a.version_no ? b : a))
    : null
);

function publicVersion(version) {
  return {
    version_no: version.version_no,
    step_count: version.steps.length,
    steps: clone(version.steps),
    release_notes: version.release_notes,
    published_at: version.published_at,
    snapshot_digest: version.snapshot_digest,
  };
}

function publicTemplate(template) {
  const latest = latestVersion(template);
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    status: template.status,
    current_version: template.current_version,
    latest_version_no: latest?.version_no ?? null,
    draft: { steps: clone(template.draft.steps) },
    created_at: template.created_at,
    updated_at: template.updated_at,
  };
}

function publicInstance(instance) {
  return {
    id: instance.id,
    template_id: instance.template_id,
    template_version: instance.template_version,
    template_snapshot: clone(instance.template_snapshot),
    template_snapshot_digest: instance.template_snapshot_digest,
    steps: clone(instance.steps),
    status: instance.status,
    triggered_at: instance.triggered_at,
    completed_at: instance.completed_at,
  };
}

function writeAudit(record) {
  db.auditLog.push({
    id: `aud_${String(++seq.audit).padStart(6, '0')}`,
    ...record,
  });
}

// ============================================================
// 4. Business operations (also exported for direct unit testing)
// ============================================================

/** Publish the current draft as a new frozen version. */
export function publishTemplate(templateId, body = {}) {
  const template = findTemplate(templateId);
  if (!template) {
    return { error: { status: 404, code: 'TEMPLATE_NOT_FOUND', message: 'template not found' } };
  }
  if (template.status === 'disabled') {
    return { error: { status: 409, code: 'TEMPLATE_DISABLED', message: 'a disabled template cannot be published' } };
  }
  const check = validateTemplateIntegrity(template, body?.release_notes);
  if (!check.ok) return { error: { status: 422, ...check } };

  const previous = latestVersion(template);
  const beforeSteps = previous ? previous.steps : [];
  const afterSteps = clone(template.draft.steps);
  const diff = diffSteps(beforeSteps, afterSteps);
  const summary = diffSummary(diff, { from_version: previous?.version_no ?? null, to_version: template.current_version + 1 });
  const versionNo = template.current_version + 1;
  const at = new Date().toISOString();
  const version = {
    version_no: versionNo,
    steps: clone(afterSteps),
    release_notes: check.value,
    published_at: at,
    snapshot_digest: digest(afterSteps),
  };

  // Commit: version freeze + pointer bump + audit in one synchronous block.
  template.versions.push(version);
  template.current_version = versionNo;
  template.status = 'published';
  template.updated_at = at;
  writeAudit({
    category: 'template_publish',
    action: 'publish',
    template_id: template.id,
    from_version: previous?.version_no ?? null,
    to_version: versionNo,
    release_notes: check.value,
    diff,
    diff_summary: summary,
    at,
  });

  return {
    ok: true,
    template: publicTemplate(template),
    version: publicVersion(version),
    diff,
    diff_summary: summary,
  };
}

/** Disable a template: no new instances, running instances keep going. */
export function disableTemplate(templateId, body = {}) {
  const template = findTemplate(templateId);
  if (!template) {
    return { error: { status: 404, code: 'TEMPLATE_NOT_FOUND', message: 'template not found' } };
  }
  if (template.status === 'disabled') {
    return { error: { status: 409, code: 'TEMPLATE_ALREADY_DISABLED', message: 'template is already disabled' } };
  }

  const previous = latestVersion(template);
  // Disable does not change steps, so the diff against the last published
  // version is empty by design; the audit record still carries all three lists.
  const diff = previous ? diffSteps(previous.steps, previous.steps) : emptyDiff();
  const fromVersion = previous?.version_no ?? null;
  const summary = diffSummary(diff, { from_version: fromVersion, to_version: fromVersion });
  const at = new Date().toISOString();
  template.status = 'disabled';
  template.updated_at = at;
  writeAudit({
    category: 'template_disable',
    action: 'disable',
    template_id: template.id,
    from_version: previous?.version_no ?? null,
    to_version: previous?.version_no ?? null,
    release_notes: String(body?.reason ?? '').trim() || null,
    diff,
    diff_summary: summary,
    note: 'new instance triggering stopped; running instances continue to completion',
    at,
  });

  return {
    ok: true,
    template: publicTemplate(template),
    diff,
    diff_summary: summary,
    running_instances: db.instances.filter((i) => i.status === 'running').length,
  };
}

/**
 * Trigger a new instance from the latest published version.
 * The snapshot is a deep copy: later publishes, disables and draft edits
 * cannot change this instance or any instance created before them.
 */
export function triggerInstance(templateId) {
  const template = findTemplate(templateId);
  if (!template) {
    return { error: { status: 404, code: 'TEMPLATE_NOT_FOUND', message: 'template not found' } };
  }
  if (template.status === 'disabled') {
    return { error: { status: 409, code: 'TEMPLATE_DISABLED', message: 'template is disabled; no new instances can be created' } };
  }
  if (!latestVersion(template)) {
    return { error: { status: 409, code: 'TEMPLATE_NOT_PUBLISHED', message: 'template has no published version yet' } };
  }

  const version = latestVersion(template);
  const snapshot = clone(version.steps);
  const at = new Date().toISOString();
  const instance = {
    id: `ins_${String(++seq.instance).padStart(5, '0')}`,
    template_id: template.id,
    template_version: version.version_no,
    template_snapshot: snapshot,
    template_snapshot_digest: digest(snapshot),
    steps: snapshot.map((s) => ({ id: s.id, title: s.title, status: 'pending' })),
    status: 'running',
    triggered_at: at,
    completed_at: null,
  };
  db.instances.push(instance);
  return { ok: true, instance: publicInstance(instance) };
}

/** Complete one step of a running instance (never reads the template). */
export function completeStep(instanceId, stepId) {
  const instance = findInstance(instanceId);
  if (!instance) return { error: { status: 404, code: 'INSTANCE_NOT_FOUND', message: 'instance not found' } };
  if (instance.status === 'completed') {
    return { error: { status: 409, code: 'INSTANCE_COMPLETED', message: 'instance is already completed' } };
  }
  const step = instance.steps.find((s) => s.id === String(stepId));
  if (!step) return { error: { status: 404, code: 'STEP_NOT_FOUND', message: 'step not found in instance snapshot' } };

  step.status = 'done';
  if (instance.steps.every((s) => s.status === 'done')) {
    instance.status = 'completed';
    instance.completed_at = new Date().toISOString();
  }
  return { ok: true, instance: publicInstance(instance) };
}

/** Complete a whole running instance; independent of template status. */
export function completeInstance(instanceId) {
  const instance = findInstance(instanceId);
  if (!instance) return { error: { status: 404, code: 'INSTANCE_NOT_FOUND', message: 'instance not found' } };
  if (instance.status === 'completed') {
    return { error: { status: 409, code: 'INSTANCE_COMPLETED', message: 'instance is already completed' } };
  }
  instance.steps.forEach((s) => { s.status = 'done'; });
  instance.status = 'completed';
  instance.completed_at = new Date().toISOString();
  return { ok: true, instance: publicInstance(instance) };
}

/** Replace the editable draft steps. Published versions are untouched. */
export function updateDraft(templateId, steps) {
  const template = findTemplate(templateId);
  if (!template) return { error: { status: 404, code: 'TEMPLATE_NOT_FOUND', message: 'template not found' } };
  if (!Array.isArray(steps)) {
    return { error: { status: 400, code: 'STEPS_REQUIRED', message: 'steps must be an array' } };
  }
  template.draft.steps = clone(steps);
  template.updated_at = new Date().toISOString();
  return { ok: true, template: publicTemplate(template) };
}

// ============================================================
// 5. HTTP API (mounted at both /api/sop and /api/v1/sop)
// ============================================================
const router = express.Router();
const sendError = (res, err) => res.status(err.status).json({ ok: false, ...err });

router.get('/health', (_req, res) => res.json({
  ok: true,
  service: 'template-version-release',
  ts: Date.now(),
  counts: {
    templates: db.templates.length,
    versions: db.templates.reduce((n, t) => n + t.versions.length, 0),
    instances: db.instances.length,
    audit: db.auditLog.length,
  },
}));

router.get('/meta', (_req, res) => res.json({
  template_status: TEMPLATE_STATUS,
  instance_status: INSTANCE_STATUS,
  step_status: STEP_STATUS,
  required_step_fields: STEP_REQUIRED_FIELDS,
  compare_step_fields: ['title', 'description', 'assignee_role', 'time_limit_hours', 'skippable'],
  instance_migration_supported: false,
  note: 'running instances keep their snapshot; no migrate-to-new-version endpoint is provided',
}));

router.post('/test/reset', (_req, res) => {
  resetStore();
  res.json({ ok: true, templates: db.templates.length, instances: db.instances.length });
});

router.get('/templates', (_req, res) => res.json({
  total: db.templates.length,
  templates: db.templates.map(publicTemplate),
}));

router.get('/templates/:id', (req, res) => {
  const template = findTemplate(req.params.id);
  if (!template) return res.status(404).json({ ok: false, code: 'TEMPLATE_NOT_FOUND', message: 'template not found' });
  res.json({ template: publicTemplate(template) });
});

router.get('/templates/:id/versions', (req, res) => {
  const template = findTemplate(req.params.id);
  if (!template) return res.status(404).json({ ok: false, code: 'TEMPLATE_NOT_FOUND', message: 'template not found' });
  const versions = [...template.versions].sort((a, b) => b.version_no - a.version_no).map(publicVersion);
  res.json({ template_id: template.id, total: versions.length, versions });
});

router.put('/templates/:id/draft', (req, res) => {
  const result = updateDraft(req.params.id, req.body?.steps);
  if (result.error) return sendError(res, result.error);
  res.json(result);
});

router.post('/templates/:id/publish', (req, res) => {
  const result = publishTemplate(req.params.id, req.body || {});
  if (result.error) return sendError(res, result.error);
  res.json(result);
});

router.post('/templates/:id/disable', (req, res) => {
  const result = disableTemplate(req.params.id, req.body || {});
  if (result.error) return sendError(res, result.error);
  res.json(result);
});

router.post('/templates/:id/instances', (req, res) => {
  const result = triggerInstance(req.params.id);
  if (result.error) return sendError(res, result.error);
  res.status(201).json(result);
});

router.get('/instances', (req, res) => {
  let rows = db.instances;
  if (req.query.template_id) rows = rows.filter((i) => i.template_id === String(req.query.template_id));
  res.json({ total: rows.length, instances: rows.map(publicInstance) });
});

router.get('/instances/:id', (req, res) => {
  const instance = findInstance(req.params.id);
  if (!instance) return res.status(404).json({ ok: false, code: 'INSTANCE_NOT_FOUND', message: 'instance not found' });
  res.json({ instance: publicInstance(instance) });
});

router.post('/instances/:id/complete', (req, res) => {
  const result = completeInstance(req.params.id);
  if (result.error) return sendError(res, result.error);
  res.json(result);
});

router.post('/instances/:id/steps/:stepId/complete', (req, res) => {
  const result = completeStep(req.params.id, req.params.stepId);
  if (result.error) return sendError(res, result.error);
  res.json(result);
});

router.get('/audit', (req, res) => {
  let rows = db.auditLog;
  if (req.query.template_id) rows = rows.filter((a) => a.template_id === String(req.query.template_id));
  if (req.query.category) rows = rows.filter((a) => a.category === String(req.query.category));
  res.json({ total: rows.length, records: rows });
});

router.get('/openapi.json', (_req, res) => res.json({
  openapi: '3.0.3',
  info: {
    title: 'SOP Template Version Release API',
    version: '1.0.0',
    description: 'Synthetic demo. In-memory store, version snapshots and step diff summaries.',
  },
  paths: {
    '/api/sop/templates/{id}/publish': {
      post: { summary: 'validate, freeze a new version and write an audit record with diff', responses: { 200: { description: 'ok' }, 409: { description: 'disabled' }, 422: { description: 'validation failed' } } },
    },
    '/api/sop/templates/{id}/disable': {
      post: { summary: 'stop new instances; running instances keep going', responses: { 200: { description: 'ok' }, 409: { description: 'already disabled' } } },
    },
    '/api/sop/templates/{id}/instances': {
      post: { summary: 'trigger an instance from the latest published version snapshot', responses: { 201: { description: 'created' }, 409: { description: 'disabled / not published' } } },
    },
    '/api/sop/instances/{id}/complete': {
      post: { summary: 'complete a running instance regardless of template status', responses: { 200: { description: 'ok' } } },
    },
    '/api/sop/audit': {
      get: { summary: 'audit log including publish/disable diff summaries', responses: { 200: { description: 'ok' } } },
    },
  },
}));

app.use('/api/sop', router);
app.use('/api/v1/sop', router);

// ============================================================
// 6. Boot (skipped when imported by the unit test runner)
// ============================================================
if (process.env.SOP_NO_LISTEN !== '1') {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[template-version-release] listening on http://0.0.0.0:${PORT}  templates=${db.templates.length}`);
  });
}
