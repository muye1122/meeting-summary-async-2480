/**
 * Async post-meeting summary service - runnable in-memory demo.
 *
 * Flow: preprocess -> map (semaphore, concurrency <= 4) -> optional hierarchical
 * reduce -> system envelope (speaker_legend / confidentiality) -> generic draft
 * pipeline -> review queue at L1 only. No outbound capability, no amounts.
 *
 * Every record in this service is SYNTHETIC. The Redis cache, the meeting
 * gateway calls (ops.meeting.map / ops.meeting.reduce) and the draft pipeline
 * are all in-process mocks; README.md lists the production replacement points.
 */
import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json({ limit: '2mb' }));
const PORT = process.env.PORT || 3001;
const API = '/api/v1';

const ok = (res, data, code = 200) => res.status(code).json(data);
const fail = (res, code, message, status = 400) => res.status(status).json({ code, message });
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

// ------------------------------------------------------------------
// 0. Parameters (all read from constants / env; no external services)
// ------------------------------------------------------------------
export const MAX_CONCURRENCY = 4;
export const SEGMENT_GROUP_SIZE = 10;
export const HIERARCHICAL_THRESHOLD = 20;
export const MAP_MAX_ATTEMPTS = 3;          // one call + two gateway retries
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const TEMPLATE_VERSION = 'summary-template-v1';
const MAP_LATENCY_MS = 12;
const REDUCE_LATENCY_MS = 5;

const PHASES = ['preprocess', 'map', 'reduce', 'drafted', 'failed'];

// ------------------------------------------------------------------
// 1. Queue-backed semaphore
// ------------------------------------------------------------------
/** Counting semaphore implemented with a FIFO wait queue (no dependency). */
export class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.waiting = [];
    this.maxObserved = 0;
  }

  async acquire() {
    if (this.active >= this.max) {
      await new Promise((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    if (this.active > this.maxObserved) this.maxObserved = this.active;
  }

  release() {
    this.active -= 1;
    if (this.waiting.length > 0) {
      const next = this.waiting.shift();
      next();
    }
  }
}

// ------------------------------------------------------------------
// 2. In-memory stand-in for Redis: TTL cache keyed by text hash + version
// ------------------------------------------------------------------
const segmentCache = new Map(); // key -> { value, expiresAt }

/** key = SHA-256(segment text) + template version. */
export function segmentCacheKey(text, version = TEMPLATE_VERSION) {
  const hash = crypto.createHash('sha256').update(String(text)).digest('hex');
  return `${hash}|${version}`;
}

function cacheGet(key) {
  const item = segmentCache.get(key);
  if (!item) return null;
  if (item.expiresAt <= Date.now()) {
    segmentCache.delete(key);
    metrics.cache.evictions += 1;
    return null;
  }
  return item.value;
}

function cacheSet(key, value) {
  segmentCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ------------------------------------------------------------------
// 3. In-memory stores and observable metrics
// ------------------------------------------------------------------
let db;
let metrics;
let testConfig;

function freshDb() {
  return { jobs: new Map(), reviewQueue: [], outboundCalls: 0 };
}

function freshMetrics() {
  return {
    preprocessCalls: 0,
    mapCalls: [],       // one entry per logical map invocation (retries are inside `attempts`)
    reduceCalls: [],    // { level: 'local' | 'final', group_index, input_count }
    concurrency: { current: 0, max: 0 },
    cache: { hits: 0, misses: 0, sets: 0, evictions: 0, size: 0, ttl_hours: 24 },
  };
}

function resetStore() {
  db = freshDb();
  segmentCache.clear();
  metrics = freshMetrics();
  testConfig = { mapDelayMs: MAP_LATENCY_MS, failSegments: [] };
  return { ok: true, note: 'in-memory jobs, cache, review queue and metrics reset; synthetic data only' };
}
resetStore();

// ------------------------------------------------------------------
// 4. Mock meeting operations (call counts are recorded for assertions)
// ------------------------------------------------------------------
/** Deterministic mock of "meeting transcript preprocessing". */
function mockOpsMeetingPreprocess(transcript) {
  metrics.preprocessCalls += 1;
  const lines = String(transcript || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  return lines.map((line, i) => ({ index: i + 1, text: line }));
}

/**
 * Deterministic mock of `ops.meeting.map`.
 * Always awaits a small delay so overlapping in-flight calls are observable.
 * A configured failing segment exhausts all attempts and returns {ok:false}.
 */
async function mockOpsMeetingMap(segment) {
  metrics.concurrency.current += 1;
  if (metrics.concurrency.current > metrics.concurrency.max) {
    metrics.concurrency.max = metrics.concurrency.current;
  }
  const record = {
    segment: segment.index,
    cache_key: segmentCacheKey(segment.text),
    attempts: 0,
    ok: false,
    ts: now(),
  };
  metrics.mapCalls.push(record);
  try {
    for (let attempt = 1; attempt <= MAP_MAX_ATTEMPTS; attempt += 1) {
      record.attempts = attempt;
      await sleep(testConfig.mapDelayMs);
      if (!testConfig.failSegments.includes(segment.index)) {
        record.ok = true;
        const summary = `【第${segment.index}段·虚构摘要】${segment.text.slice(0, 60)}`;
        return { ok: true, summary, attempt };
      }
    }
    return { ok: false, error: 'GATEWAY_RETRY_EXHAUSTED', segment: segment.index };
  } finally {
    metrics.concurrency.current -= 1;
  }
}

/** Deterministic mock of `ops.meeting.reduce` (local or final level). */
async function mockOpsMeetingReduce(level, groupIndex, inputs) {
  const record = { level, group_index: groupIndex, input_count: inputs.length, ts: now() };
  metrics.reduceCalls.push(record);
  await sleep(REDUCE_LATENCY_MS);
  const label = level === 'local' ? `局部汇总${groupIndex + 1}` : '最终汇总';
  const text = `【${label}·虚构】共${inputs.length}项：${inputs.join('；')}`;
  return { level, text };
}

// ------------------------------------------------------------------
// 5. System envelope and generic draft pipeline
// ------------------------------------------------------------------
function buildSpeakerLegend(roles) {
  const list = Array.isArray(roles) ? roles : [];
  if (list.length === 0) return [{ role: 'unknown', label: '未标注角色（虚构）' }];
  return list.map((role, i) => ({ role: String(role), label: `角色${i + 1}·${role}（虚构）` }));
}

function deriveConfidentiality(type) {
  const value = String(type || '');
  if (/confidential|保密|闭门|secret/i.test(value)) return 'confidential';
  if (/internal|内部/i.test(value)) return 'internal';
  return 'internal-only';
}

/** The only sink for generated text: review queue at L1. No outbound path. */
function enqueueReviewDraft(job) {
  const draft = {
    draft_id: 'draft_' + crypto.randomBytes(5).toString('hex'),
    job_id: job.job_id,
    review_level: 'L1',
    status: 'pending_review',
    subject: String(job.meta.title || '未命名会议（虚构）'),
    body: job.summary_text,
    speaker_legend: job.speaker_legend,
    confidentiality: job.confidentiality,
    meeting_type: job.meta.type || null,
    meeting_date: job.meta.date ?? null,
    event_id: job.meta.event_id ?? null,
    attendee_roles: job.meta.attendee_roles || [],
    segment_count: job.map_total,
    amount: null, // generated content never computes amounts
    created_at: now(),
  };
  db.reviewQueue.push(draft);
  return draft.draft_id;
}

// ------------------------------------------------------------------
// 6. Pipeline
// ------------------------------------------------------------------
function publicJob(job) {
  return {
    job_id: job.job_id,
    phase: job.phase,
    map_done: job.mapped.filter(Boolean).length,
    map_total: job.map_total,
    failed_segments: [...job.failed_segments].sort((a, b) => a - b),
    error_code: job.error_code,
    retry_count: job.retry_count,
    reduce_calls: job.reduce_calls,
    local_summaries: job.local_summaries,
    review_draft_id: job.review_draft_id,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

function createJob(transcript, meta) {
  const job_id = 'job_' + crypto.randomUUID();
  const job = {
    job_id,
    transcript,
    meta,
    phase: 'preprocess',
    map_total: 0,
    mapped: [],
    segments: [],
    failed_segments: [],
    error_code: null,
    retry_count: 0,
    reduce_calls: 0,
    local_summaries: 0,
    summary_text: null,
    speaker_legend: null,
    confidentiality: null,
    review_draft_id: null,
    created_at: now(),
    updated_at: now(),
  };
  db.jobs.set(job_id, job);
  return job;
}

/**
 * Map phase: one logical call per segment, guarded by the semaphore.
 * The cache is consulted for every segment on every run, so a retry reuses
 * all successful segment results and only calls the gateway for misses.
 */
async function runMapPhase(job) {
  const semaphore = new Semaphore(MAX_CONCURRENCY);
  await Promise.all(job.segments.map(async (segment) => {
    await semaphore.acquire();
    try {
      const key = segmentCacheKey(segment.text);
      const cached = cacheGet(key);
      if (cached && cached.ok) {
        metrics.cache.hits += 1;
        job.mapped[segment.index - 1] = cached;
        return;
      }
      metrics.cache.misses += 1;
      const result = await mockOpsMeetingMap(segment);
      if (result.ok) {
        const value = {
          ok: true,
          segment: segment.index,
          summary: result.summary,
          template_version: TEMPLATE_VERSION,
        };
        cacheSet(key, value);
        metrics.cache.sets += 1;
        job.mapped[segment.index - 1] = value;
        job.failed_segments = job.failed_segments.filter((n) => n !== segment.index);
      } else {
        if (!job.failed_segments.includes(segment.index)) job.failed_segments.push(segment.index);
      }
      job.updated_at = now();
    } finally {
      semaphore.release();
    }
  }));
}

/**
 * Reduce phase. Only when segments > 20: local groups of 10, then one final
 * reduce over the local summaries. Small meetings skip reduce entirely.
 */
async function buildSummary(job) {
  const summaries = job.mapped.filter(Boolean).map((m) => m.summary);
  let text;
  let localCount = 0;
  let reduceCalls = 0;

  if (summaries.length > HIERARCHICAL_THRESHOLD) {
    const groups = [];
    for (let i = 0; i < summaries.length; i += SEGMENT_GROUP_SIZE) {
      groups.push(summaries.slice(i, i + SEGMENT_GROUP_SIZE));
    }
    const locals = [];
    for (let i = 0; i < groups.length; i += 1) {
      locals.push(await mockOpsMeetingReduce('local', i, groups[i]));
      localCount += 1;
      reduceCalls += 1;
    }
    const final = await mockOpsMeetingReduce('final', 0, locals.map((item) => item.text));
    reduceCalls += 1;
    text = final.text;
  } else {
    text = summaries.join('\n');
  }

  job.reduce_calls = reduceCalls;
  job.local_summaries = localCount;
  job.summary_text = text;
  job.speaker_legend = buildSpeakerLegend(job.meta.attendee_roles);
  job.confidentiality = deriveConfidentiality(job.meta.type);
}

async function runJob(jobId) {
  const job = db.jobs.get(jobId);
  if (!job) return;
  try {
    if (job.phase === 'preprocess') {
      job.segments = mockOpsMeetingPreprocess(job.transcript);
      job.mapped = new Array(job.segments.length).fill(null);
      job.map_total = job.segments.length;
      job.phase = 'map';
      job.updated_at = now();
    }

    await runMapPhase(job);
    if (job.failed_segments.length > 0) {
      job.phase = 'failed';
      job.error_code = 'MAP_SEGMENT_FAILED';
      job.updated_at = now();
      return;
    }

    job.phase = 'reduce';
    job.error_code = null;
    job.updated_at = now();
    await buildSummary(job);

    job.phase = 'drafted';
    job.review_draft_id = enqueueReviewDraft(job);
    job.updated_at = now();
  } catch (error) {
    job.phase = 'failed';
    job.error_code = error && error.code ? error.code : 'PIPELINE_FAILED';
    job.updated_at = now();
  }
}

// Fire-and-forget launcher used by both API routes.
function launchJob(jobId) {
  void runJob(jobId).catch(() => { /* runJob records its own failure state */ });
}

// ------------------------------------------------------------------
// 7. Multipart parsing (no extra package installed)
// ------------------------------------------------------------------
function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  const boundary = match ? String(match[1] || match[2] || '').trim() : '';
  if (!boundary) return {};
  const fields = {};
  const delimiter = Buffer.from('--' + boundary);
  let cursor = buffer.indexOf(delimiter);
  while (cursor !== -1) {
    const next = buffer.indexOf(delimiter, cursor + delimiter.length);
    if (next === -1) break;
    let part = buffer.subarray(cursor + delimiter.length, next);
    if (part.length >= 2 && part[0] === 13 && part[1] === 10) part = part.subarray(2);
    if (part.length >= 2 && part[part.length - 2] === 13 && part[part.length - 1] === 10) {
      part = part.subarray(0, part.length - 2);
    }
    const divider = part.indexOf(Buffer.from('\r\n\r\n'));
    if (divider !== -1) {
      const headers = part.subarray(0, divider).toString('utf8');
      const value = part.subarray(divider + 4).toString('utf8');
      const nameMatch = /name="([^"]+)"/i.exec(headers);
      if (nameMatch) fields[nameMatch[1]] = value;
    }
    cursor = next;
  }
  return fields;
}

function readRequestFields(req) {
  const contentType = String(req.headers['content-type'] || '');
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (contentType.includes('multipart/form-data')) {
    return parseMultipart(raw, contentType);
  }
  if (contentType.includes('application/json')) {
    let json = {};
    try { json = JSON.parse(raw.toString('utf8') || '{}'); } catch { json = {}; }
    return { text: json.text, meeting_meta: JSON.stringify(json.meeting_meta || {}) };
  }
  return { text: raw.toString('utf8') };
}

// ------------------------------------------------------------------
// 8. HTTP API
// ------------------------------------------------------------------
app.get(`${API}/health`, (_req, res) => ok(res, {
  ok: true,
  service: 'meeting-summary-async',
  ts: Date.now(),
  jobs: db.jobs.size,
  review_queue: db.reviewQueue.length,
}));

app.get(`${API}/meta`, (_req, res) => ok(res, {
  phases: PHASES,
  max_concurrency: MAX_CONCURRENCY,
  segment_group_size: SEGMENT_GROUP_SIZE,
  hierarchical_threshold: HIERARCHICAL_THRESHOLD,
  map_max_attempts: MAP_MAX_ATTEMPTS,
  cache_ttl_hours: CACHE_TTL_MS / 3600000,
  template_version: TEMPLATE_VERSION,
  review_level: 'L1',
  outbound_capability: false,
  effective_semantics: 'Generated text is stored in the review queue only; no outbound delivery and no amount calculation.',
}));

app.post(`${API}/ops/meeting-summaries/generate`, express.raw({ type: () => true, limit: '10mb' }), (req, res) => {
  const fields = readRequestFields(req);
  const transcript = String(fields.text || fields.file || '').trim();
  let meta = {};
  try { meta = JSON.parse(fields.meeting_meta || '{}'); } catch { meta = {}; }

  if (!transcript) return fail(res, 'TRANSCRIPT_REQUIRED', 'text or file is required', 400);
  if (!meta.title || !meta.type) return fail(res, 'MEETING_META_REQUIRED', 'meeting_meta.title and meeting_meta.type are required', 400);

  const normalizedMeta = {
    title: String(meta.title),
    type: String(meta.type),
    date: meta.date ?? null,
    event_id: meta.event_id ?? null,
    attendee_roles: Array.isArray(meta.attendee_roles) ? meta.attendee_roles : [],
  };
  const job = createJob(transcript, normalizedMeta);
  launchJob(job.job_id);
  return ok(res, { ok: true, job: publicJob(job) }, 202);
});

app.get(`${API}/ops/jobs/:job_id`, (req, res) => {
  const job = db.jobs.get(String(req.params.job_id));
  if (!job) return fail(res, 'JOB_NOT_FOUND', 'job not found', 404);
  return ok(res, publicJob(job));
});

app.post(`${API}/ops/jobs/:job_id/retry`, (req, res) => {
  const job = db.jobs.get(String(req.params.job_id));
  if (!job) return fail(res, 'JOB_NOT_FOUND', 'job not found', 404);
  if (job.phase !== 'failed') return fail(res, 'JOB_NOT_RETRYABLE', 'only a failed job can be retried', 409);
  if (job.failed_segments.length === 0) return fail(res, 'NO_FAILED_SEGMENTS', 'no failed segment to retry', 409);
  job.retry_count += 1;
  job.phase = 'map';
  job.updated_at = now();
  launchJob(job.job_id);
  return ok(res, publicJob(job), 202);
});

app.get(`${API}/review-queue`, (_req, res) => ok(res, {
  table: 'review_queue',
  total: db.reviewQueue.length,
  rows: db.reviewQueue,
}));

app.get(`${API}/observability/outbound`, (_req, res) => ok(res, {
  outbound_calls: db.outboundCalls,
  note: 'No outbound channel exists in this service; the counter is never incremented.',
}));

app.get(`${API}/ops/metrics`, (_req, res) => ok(res, {
  preprocess_calls: metrics.preprocessCalls,
  map_calls: metrics.mapCalls,
  reduce_calls: metrics.reduceCalls,
  concurrency: metrics.concurrency,
  cache: { ...metrics.cache, size: segmentCache.size },
  template_version: TEMPLATE_VERSION,
}));

app.get(`${API}/openapi.json`, (_req, res) => ok(res, {
  openapi: '3.0.3',
  info: {
    title: 'Async Post-Meeting Summary API',
    version: '1.0.0',
    description: 'Synthetic demo. Segmented map/reduce pipeline, TTL segment cache, review-queue-only output.',
  },
  servers: [{ url: API }],
  paths: {
    '/health': { get: { summary: 'Health check' } },
    '/meta': { get: { summary: 'Pipeline parameters and limits' } },
    '/ops/meeting-summaries/generate': { post: { summary: 'Start a summary job (multipart: text or file + meeting_meta)', responses: { 202: { description: 'accepted' }, 400: { description: 'invalid input' } } } },
    '/ops/jobs/{job_id}': { get: { summary: 'Progress: phase, map_done, map_total', responses: { 200: { description: 'progress' }, 404: { description: 'not found' } } } },
    '/ops/jobs/{job_id}/retry': { post: { summary: 'Re-run only failed segments; successes use cache', responses: { 202: { description: 'accepted' }, 409: { description: 'not retryable' } } } },
    '/review-queue': { get: { summary: 'L1 drafts awaiting human review' } },
    '/ops/metrics': { get: { summary: 'Map/reduce call counts, concurrency and cache stats' } },
    '/observability/outbound': { get: { summary: 'Outbound counter, always zero' } },
  },
  components: {
    schemas: {
      JobProgress: {
        type: 'object',
        required: ['job_id', 'phase', 'map_done', 'map_total'],
        properties: {
          job_id: { type: 'string' },
          phase: { type: 'string', enum: PHASES },
          map_done: { type: 'integer' },
          map_total: { type: 'integer' },
          failed_segments: { type: 'array', items: { type: 'integer' } },
          error_code: { type: 'string', nullable: true },
        },
      },
    },
  },
}));

app.post(`${API}/test/reset`, (_req, res) => ok(res, resetStore()));

/** Test-only deterministic controls: gateway latency and failing segment numbers. */
app.post(`${API}/test/config`, (req, res) => {
  const body = req.body || {};
  if (Number.isFinite(Number(body.mapDelayMs))) {
    testConfig.mapDelayMs = Math.max(0, Math.min(Number(body.mapDelayMs), 5000));
  }
  if (Array.isArray(body.failSegments)) {
    testConfig.failSegments = body.failSegments.map(Number).filter(Number.isInteger);
  }
  return ok(res, { ok: true, ...testConfig });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[meeting-summary-async] listening on http://0.0.0.0:${PORT}  concurrency=${MAX_CONCURRENCY}  cache_ttl_hours=24`);
});
