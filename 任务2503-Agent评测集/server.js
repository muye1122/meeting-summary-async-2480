/**
 * One-command HTTP service for the evaluation target and its report.
 *
 * Pure Node.js (no framework). Starts with: node server.js
 *   - API prefix /api/v1
 *   - inline HTML dashboard at /
 *   - Markdown report at /api/v1/report
 *
 * All data is synthetic and fictional. Nothing is sent outside the process.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createAgentRuntime, listTools } from './mock-server/agent.js';
import { runEvaluation } from './eval/run.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3001);
const API = '/api/v1';
const SET_PATH = path.join(__dirname, 'data', 'eval-set.jsonl');

const runtime = createAgentRuntime();
const entries = fs.readFileSync(SET_PATH, 'utf8')
  .split(/\r?\n/)
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));
const byId = new Map(entries.map((e) => [e.id, e]));

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const ok = (res, data, type) => send(res, 200, data, type);
const fail = (res, code, message) => send(res, code, { code: message, message });

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('payload too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('invalid JSON body');
  }
}

const DASHBOARD = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Agent Evaluation Dashboard</title>
<style>
body{font-family:system-ui,sans-serif;max-width:960px;margin:32px auto;padding:0 20px;color:#1b1f24}
h1{font-size:22px} .card{border:1px solid #d9dee5;border-radius:8px;padding:16px;margin:14px 0}
button{background:#1d4ed8;color:#fff;border:0;border-radius:6px;padding:8px 14px;cursor:pointer}
select{padding:7px} pre{white-space:pre-wrap;word-break:break-all;background:#f6f8fa;padding:12px;border-radius:6px}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #d9dee5;padding:6px 8px;text-align:left}
.small{font-size:13px;color:#57606a}
</style></head><body>
<h1>Agent Runtime Evaluation</h1>
<p class="small">Synthetic fictional data only. Generated text stays in the human review queue; no outbound channel exists.</p>
<div class="card">
  <label>Choose an evaluation entry: </label>
  <select id="entry"></select>
  <button id="run">Run entry</button>
  <button id="eval">Run all 65 + metrics</button>
  <p>Outbound calls: <b id="outbound">0</b> &nbsp; Review drafts: <b id="drafts">0</b></p>
</div>
<div class="card"><h2>Latest run trace</h2><pre id="trace">Select an entry and click Run.</pre></div>
<div class="card"><h2>Summary</h2><pre id="summary">Run all 65 to see the five metrics.</pre></div>
<script>
const API='/api/v1';
fetch(API+'/entries').then(r=>r.json()).then(d=>{
  const sel=document.getElementById('entry');
  for(const e of d.entries){const o=document.createElement('option');o.value=e.id;o.textContent=e.id+' | '+e.category+' | '+e.title;sel.appendChild(o);}
});
function refreshCounters(){
  Promise.all([fetch(API+'/observability/outbound').then(r=>r.json()),fetch(API+'/review-queue').then(r=>r.json())])
    .then(([o,q])=>{document.getElementById('outbound').textContent=o.outbound_calls;document.getElementById('drafts').textContent=q.rows.length;});
}
document.getElementById('run').onclick=async()=>{
  const id=document.getElementById('entry').value;
  const r=await fetch(API+'/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({entry_id:id})});
  const t=await r.json();
  document.getElementById('trace').textContent=JSON.stringify(t,null,2);
  refreshCounters();
};
document.getElementById('eval').onclick=async()=>{
  const r=await fetch(API+'/eval/run',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  const d=await r.json();
  document.getElementById('summary').textContent=JSON.stringify(d.metrics,null,2)+'\\ngate='+d.gate;
  refreshCounters();
};
refreshCounters();
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (req.method === 'GET' && p === '/') return ok(res, DASHBOARD, 'text/html; charset=utf-8');

    if (req.method === 'GET' && p === `${API}/health`) {
      return ok(res, {
        ok: true,
        service: 'agent-evaluation-suite',
        entries: entries.length,
        tools: listTools().length,
        model_mode: (process.env.MODEL_MODE || 'mock').toLowerCase(),
        ts: Date.now(),
      });
    }

    if (req.method === 'GET' && p === `${API}/tools`) {
      return ok(res, {
        tools: listTools(),
        note: 'Only these four tools are registered. No outbound tool exists. Amount queries use a separate business API bridge or a refusal.',
      });
    }

    if (req.method === 'GET' && p === `${API}/entries`) {
      return ok(res, {
        total: entries.length,
        entries: entries.map(({ id, category, title, input }) => ({ id, category, title, input })),
      });
    }

    const entryMatch = p.match(/^\/api\/v1\/entries\/([^/]+)$/);
    if (req.method === 'GET' && entryMatch) {
      const entry = byId.get(decodeURIComponent(entryMatch[1]));
      return entry ? ok(res, entry) : fail(res, 404, 'ENTRY_NOT_FOUND');
    }

    if (req.method === 'GET' && p === `${API}/business/quote`) {
      return ok(res, runtime.businessQuote);
    }

    if (req.method === 'POST' && p === `${API}/runs`) {
      const body = await readBody(req);
      const entry = body.entry_id ? byId.get(body.entry_id) : (body.entry || body);
      if (!entry) return fail(res, 404, 'ENTRY_NOT_FOUND');
      const trace = await runtime.run(entry, {
        org_id: entry.context?.org_id,
        site_id: entry.context?.site_id,
      });
      return ok(res, trace);
    }

    if (req.method === 'POST' && p === `${API}/reset`) {
      return ok(res, runtime.reset());
    }

    if (req.method === 'GET' && p === `${API}/review-queue`) {
      return ok(res, { table: 'review_queue', rows: runtime.reviewQueue });
    }

    if (req.method === 'GET' && p === `${API}/observability/outbound`) {
      return ok(res, {
        outbound_calls: runtime.outboundCalls,
        note: 'No outbound channel is registered; this counter never increments.',
      });
    }

    if (req.method === 'POST' && p === `${API}/eval/run`) {
      const body = await readBody(req);
      const { data } = await runEvaluation({ mode: body.mode || process.env.MODEL_MODE || 'mock' });
      return ok(res, data);
    }

    if (req.method === 'GET' && p === `${API}/report`) {
      const reportPath = path.join(__dirname, 'eval', 'mock-report.md');
      if (!fs.existsSync(reportPath)) return fail(res, 404, 'REPORT_NOT_FOUND');
      return ok(res, fs.readFileSync(reportPath, 'utf8'), 'text/markdown; charset=utf-8');
    }

    return fail(res, 404, 'NOT_FOUND');
  } catch (err) {
    return fail(res, 400, err.message || 'BAD_REQUEST');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[agent-eval-suite] dashboard http://0.0.0.0:${PORT}  api ${API}  entries=${entries.length}`);
});
