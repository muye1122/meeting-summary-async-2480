import React, { useCallback, useEffect, useState } from 'react';

/** Demo-only console. All records shown here are synthetic; no outbound path. */
const API = '/api/v1';

async function api(path, options = {}) {
  const response = await fetch(API + path, options);
  let data = {};
  try { data = await response.json(); } catch { /* non-json body */ }
  return { ok: response.ok, status: response.status, data };
}

const exampleTranscript = (count) =>
  Array.from({ length: count }, (_, i) => `第${i + 1}段：虚构发言人围绕虚构议题发表简短意见。`).join('\n');

export default function App() {
  const [meta, setMeta] = useState(null);
  const [transcript, setTranscript] = useState(exampleTranscript(25));
  const [form, setForm] = useState({ title: '虚构项目周会', type: 'internal', roles: '主持人,记录人,业务代表' });
  const [job, setJob] = useState(null);
  const [message, setMessage] = useState('');
  const [queue, setQueue] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [outbound, setOutbound] = useState(null);

  const loadSide = useCallback(async () => {
    const [q, m, o] = await Promise.all([
      api('/review-queue'), api('/ops/metrics'), api('/observability/outbound'),
    ]);
    if (q.ok) setQueue(q.data.rows || []);
    if (m.ok) setMetrics(m.data);
    if (o.ok) setOutbound(o.data);
  }, []);

  useEffect(() => {
    api('/meta').then((r) => { if (r.ok) setMeta(r.data); });
    loadSide();
  }, [loadSide]);

  useEffect(() => {
    if (!job || !['preprocess', 'map', 'reduce'].includes(job.phase)) return undefined;
    const timer = setInterval(async () => {
      const r = await api('/ops/jobs/' + job.job_id);
      if (r.ok) setJob(r.data);
      await loadSide();
    }, 150);
    return () => clearInterval(timer);
  }, [job, loadSide]);

  async function generate() {
    setMessage('');
    const body = new FormData();
    body.append('text', transcript);
    body.append('meeting_meta', JSON.stringify({
      title: form.title,
      type: form.type,
      date: null,
      event_id: null,
      attendee_roles: form.roles.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    }));
    const r = await api('/ops/meeting-summaries/generate', { method: 'POST', body });
    if (r.ok) {
      setJob(r.data.job);
      setMessage(`已受理 ${r.data.job.job_id}`);
    } else {
      setMessage(`受理失败 ${r.data.code || r.status}`);
    }
    await loadSide();
  }

  async function retry() {
    if (!job) return;
    const r = await api(`/ops/jobs/${job.job_id}/retry`, { method: 'POST' });
    if (r.ok) {
      setJob(r.data);
      setMessage(`已重跑失败段，次数 ${r.data.retry_count}`);
    } else {
      setMessage(`重跑失败 ${r.data.code || r.status}`);
    }
    await loadSide();
  }

  const phaseClass = job ? `badge ${job.phase}` : 'badge';

  return (
    <div className="app">
      <h1 data-testid="app-title">会后总结异步生成接口 · 演示台</h1>
      <div className="subtitle">
        虚构会议纪要 → 预处理 → 分段 map（并发 ≤ 4）→ 分层 reduce → 复核队列 L1；无外发、不计算金额。
      </div>

      <div className="grid">
        <div className="card">
          <h2>提交生成</h2>
          <label htmlFor="transcript">会议纪要文本（每行一段）</label>
          <textarea
            id="transcript"
            data-testid="transcript-input"
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
          />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="secondary" data-testid="fill-25" onClick={() => setTranscript(exampleTranscript(25))}>填充 25 段</button>
            <button className="secondary" data-testid="fill-30" onClick={() => setTranscript(exampleTranscript(30))}>填充 30 段</button>
          </div>
          <label htmlFor="title">会议标题</label>
          <input id="title" data-testid="meta-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <label htmlFor="type">会议类型</label>
          <select id="type" data-testid="meta-type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            <option value="internal">internal（内部）</option>
            <option value="confidential">confidential（保密）</option>
          </select>
          <label htmlFor="roles">参会角色（逗号分隔）</label>
          <input id="roles" data-testid="meta-roles" value={form.roles} onChange={(e) => setForm({ ...form, roles: e.target.value })} />
          <div className="row" style={{ marginTop: 14 }}>
            <button data-testid="generate-btn" onClick={generate}>生成总结</button>
          </div>
          <div className="note" data-testid="submit-msg">{message}</div>
        </div>

        <div className="card">
          <h2>任务进度</h2>
          <div className="kv">
            <span className="key">job_id</span><span data-testid="job-id">{job?.job_id || '—'}</span>
            <span className="key">phase</span><span data-testid="job-phase">{job ? <span className={phaseClass}>{job.phase}</span> : '—'}</span>
            <span className="key">map_done / map_total</span>
            <span data-testid="job-progress">{job ? `${job.map_done} / ${job.map_total}` : '—'}</span>
            <span className="key">failed_segments</span><span data-testid="job-failed">{job?.failed_segments?.join(', ') || '无'}</span>
            <span className="key">error_code</span><span data-testid="job-error">{job?.error_code || '无'}</span>
            <span className="key">reduce 调用</span><span data-testid="job-reduce">{job ? `${job.reduce_calls}（局部 ${job.local_summaries}）` : '—'}</span>
          </div>
          <div className="row" style={{ marginTop: 14 }}>
            <button className="secondary" data-testid="retry-btn" disabled={!job || job.phase !== 'failed'} onClick={retry}>重跑失败段</button>
          </div>
          <div className="note">
            管线参数：并发上限 {meta?.max_concurrency ?? '—'}，分层阈值 {meta?.hierarchical_threshold ?? '—'}，
            分组大小 {meta?.segment_group_size ?? '—'}，缓存 {meta?.cache_ttl_hours ?? '—'} 小时，复核级别 {meta?.review_level ?? '—'}。
          </div>
        </div>

        <div className="card">
          <h2> observability 指标</h2>
          <div className="kv">
            <span className="key">map 调用</span><span data-testid="metric-map-calls">{metrics?.map_calls?.length ?? 0}</span>
            <span className="key">reduce 调用</span><span data-testid="metric-reduce-calls">{metrics?.reduce_calls?.length ?? 0}</span>
            <span className="key">当前 / 峰值并发</span><span data-testid="metric-concurrency">{metrics ? `${metrics.concurrency.current} / ${metrics.concurrency.max}` : '—'}</span>
            <span className="key">缓存 hit / miss / size</span><span data-testid="metric-cache">{metrics ? `${metrics.cache.hits} / ${metrics.cache.misses} / ${metrics.cache.size}` : '—'}</span>
            <span className="key">外发调用</span><span data-testid="outbound-count">{outbound?.outbound_calls ?? '—'}</span>
          </div>
          <pre data-testid="metrics-view">{metrics ? JSON.stringify(metrics.mapCalls || metrics.map_calls, null, 2) : '—'}</pre>
        </div>

        <div className="card">
          <h2>复核队列（仅 L1，不外发）</h2>
          <div data-testid="review-queue">
            {queue.length === 0 && <div className="note">队列为空，先提交一次生成。</div>}
            {queue.map((draft) => (
              <div className="note" key={draft.draft_id} data-testid={`review-row-${draft.draft_id}`}>
                <strong>{draft.draft_id}</strong> · {draft.review_level} · {draft.status} · {draft.confidentiality}
                <div>speaker_legend: {JSON.stringify(draft.speaker_legend)}</div>
                <pre>{draft.body}</pre>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
