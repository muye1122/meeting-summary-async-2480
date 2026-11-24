/**
 * Pipeline tests against the running API. They assert the four buyer
 * acceptance criteria. All meeting content is synthetic.
 */
import { test, expect } from '@playwright/test';

const API = 'http://127.0.0.1:3001/api/v1';
const body = (response) => response.json();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function reset(request) {
  expect((await request.post(API + '/test/reset')).ok()).toBeTruthy();
}

async function configure(request, options) {
  const r = await request.post(API + '/test/config', { data: options });
  expect(r.ok()).toBeTruthy();
  return body(r);
}

function transcript(count, failAt = null) {
  return Array.from({ length: count }, (_, i) => {
    const index = i + 1;
    return `第${index}段：${index === failAt ? '网关故障模拟' : '虚构发言人发表简短意见'}。`;
  }).join('\n');
}

async function generate(request, count, options = {}) {
  const response = await request.post(API + '/ops/meeting-summaries/generate', {
    multipart: {
      text: transcript(count, options.failAt || null),
      meeting_meta: JSON.stringify({
        title: '虚构项目复盘会',
        type: options.type || 'internal',
        date: null,
        event_id: null,
        attendee_roles: ['主持人', '记录人', '业务代表'],
      }),
    },
  });
  const data = await body(response);
  expect(response.status(), JSON.stringify(data)).toBe(202);
  expect(data.ok).toBe(true);
  return data.job;
}

async function waitForPhase(request, jobId, phases, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await body(await request.get(`${API}/ops/jobs/${jobId}`));
    if (phases.includes(last.phase)) return last;
    await sleep(15);
  }
  throw new Error(`phase not reached within ${timeoutMs}ms: ${JSON.stringify(last)}`);
}

async function readMetrics(request) {
  return body(await request.get(API + '/ops/metrics'));
}

// ------------------------------------------------------------------
// Acceptance 1: 30 segments, concurrent map calls never exceed 4
// ------------------------------------------------------------------
test('30 segments: concurrent segment calls stay at or below the semaphore limit', async ({ request }) => {
  await reset(request);
  await configure(request, { mapDelayMs: 18, failSegments: [] });

  const job = await generate(request, 30);
  const done = await waitForPhase(request, job.job_id, ['drafted', 'failed']);
  expect(done.phase, JSON.stringify(done)).toBe('drafted');
  expect(done.map_total).toBe(30);
  expect(done.map_done).toBe(30);

  const m = await readMetrics(request);
  expect(m.map_calls).toHaveLength(30);
  expect(m.concurrency.max).toBeLessThanOrEqual(4);
  expect(m.concurrency.max).toBeGreaterThan(1); // real overlap was observed
  expect(m.cache.sets).toBe(30);

  const queue = await body(await request.get(API + '/review-queue'));
  expect(queue.total).toBe(1);
});

// ------------------------------------------------------------------
// Acceptance 2: 25 segments -> 3 local reduces + 1 final reduce
// ------------------------------------------------------------------
test('25 segments trigger hierarchical reduce with three local groups and one final call', async ({ request }) => {
  await reset(request);
  await configure(request, { mapDelayMs: 0, failSegments: [] });

  const job = await generate(request, 25);
  const done = await waitForPhase(request, job.job_id, ['drafted', 'failed']);
  expect(done.phase, JSON.stringify(done)).toBe('drafted');

  expect(done.reduce_calls).toBe(4);
  expect(done.local_summaries).toBe(3);

  const m = await readMetrics(request);
  expect(m.reduce_calls).toHaveLength(4);
  expect(m.reduce_calls.map((r) => r.level)).toEqual(['local', 'local', 'local', 'final']);
  expect(m.reduce_calls.map((r) => r.input_count)).toEqual([10, 10, 5, 3]);
  expect(m.map_calls).toHaveLength(25);
});

test('20 segments stay below the hierarchical threshold and skip reduce', async ({ request }) => {
  await reset(request);
  await configure(request, { mapDelayMs: 0, failSegments: [] });

  const job = await generate(request, 20);
  const done = await waitForPhase(request, job.job_id, ['drafted', 'failed']);
  expect(done.phase).toBe('drafted');
  expect(done.reduce_calls).toBe(0);
  expect(done.local_summaries).toBe(0);
  const m = await readMetrics(request);
  expect(m.reduce_calls).toHaveLength(0);
});

// ------------------------------------------------------------------
// Acceptance 3: failed segment 7 is re-run alone, others hit the cache
// ------------------------------------------------------------------
test('segment 7 retry invokes only that segment and reuses cached results', async ({ request }) => {
  await reset(request);
  await configure(request, { mapDelayMs: 0, failSegments: [7] });

  const job = await generate(request, 30);
  const failed = await waitForPhase(request, job.job_id, ['failed', 'drafted']);
  expect(failed.phase, JSON.stringify(failed)).toBe('failed');
  expect(failed.error_code).toBe('MAP_SEGMENT_FAILED');
  expect(failed.failed_segments).toEqual([7]);
  expect(failed.map_done).toBe(29);

  const before = await readMetrics(request);
  const firstMapSegments = before.map_calls.map((c) => c.segment);
  expect(firstMapSegments.filter((s) => s === 7)).toHaveLength(1);
  expect(firstMapSegments.filter((s) => s !== 7)).toHaveLength(29);

  // The simulated gateway recovers before the operator retries.
  await configure(request, { failSegments: [] });
  const retry = await request.post(`${API}/ops/jobs/${job.job_id}/retry`);
  expect(retry.status()).toBe(202);

  const done = await waitForPhase(request, job.job_id, ['drafted', 'failed']);
  expect(done.phase, JSON.stringify(done)).toBe('drafted');
  expect(done.failed_segments).toEqual([]);
  expect(done.error_code).toBeNull();
  expect(done.map_done).toBe(30);
  expect(done.retry_count).toBe(1);

  const after = await readMetrics(request);
  const secondMapSegments = after.map_calls.map((c) => c.segment);
  expect(secondMapSegments.filter((s) => s === 7)).toHaveLength(2);          // only segment 7 re-invoked
  expect(secondMapSegments.filter((s) => s !== 7)).toHaveLength(29);         // no other gateway calls
  expect(after.cache.hits - before.cache.hits).toBeGreaterThanOrEqual(29);   // successes came from cache

  const queue = await body(await request.get(API + '/review-queue'));
  expect(queue.total).toBe(1);
  expect(queue.rows[0].job_id).toBe(job.job_id);
  expect(queue.rows[0].review_level).toBe('L1');
});

// ------------------------------------------------------------------
// Acceptance 4: progress API reports map_done and map_total during map
// ------------------------------------------------------------------
test('progress API reports correct map_done and map_total while mapping', async ({ request }) => {
  await reset(request);
  await configure(request, { mapDelayMs: 80, failSegments: [] });

  const job = await generate(request, 30);
  let sawMapPhase = false;
  let sawPartialProgress = false;
  let lastTotal = null;
  let finished = null;
  const deadline = Date.now() + 12000;

  while (Date.now() < deadline) {
    const progress = await body(await request.get(`${API}/ops/jobs/${job.job_id}`));
    expect(progress.job_id).toBe(job.job_id);
    if (progress.phase === 'map') {
      sawMapPhase = true;
      expect(progress.map_total).toBe(30);
      expect(progress.map_done).toBeGreaterThanOrEqual(0);
      expect(progress.map_done).toBeLessThanOrEqual(30);
      if (progress.map_done > 0 && progress.map_done < 30) sawPartialProgress = true;
    }
    if (progress.phase === 'drafted') {
      finished = progress;
      break;
    }
    expect(progress.phase).not.toBe('failed');
    await sleep(10);
  }

  expect(sawMapPhase).toBe(true);
  expect(sawPartialProgress).toBe(true);
  expect(finished).not.toBeNull();
  expect(finished.map_total).toBe(30);
  expect(finished.map_done).toBe(30);
  expect(finished.phase).toBe('drafted');
});

// ------------------------------------------------------------------
// Supporting contract checks
// ------------------------------------------------------------------
test('generated text carries a system envelope and never leaves the review queue', async ({ request }) => {
  await reset(request);
  await configure(request, { mapDelayMs: 0, failSegments: [] });

  const job = await generate(request, 5, { type: 'confidential' });
  const done = await waitForPhase(request, job.job_id, ['drafted', 'failed']);
  expect(done.phase).toBe('drafted');

  const queue = await body(await request.get(API + '/review-queue'));
  expect(queue.rows).toHaveLength(1);
  const draft = queue.rows[0];
  expect(draft.confidentiality).toBe('confidential');
  expect(draft.speaker_legend.length).toBe(3);
  expect(draft.amount).toBeNull();
  expect(draft.status).toBe('pending_review');

  const outbound = await body(await request.get(API + '/observability/outbound'));
  expect(outbound.outbound_calls).toBe(0);
});
