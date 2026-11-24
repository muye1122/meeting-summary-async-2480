import React, { useCallback, useEffect, useState } from 'react';

/**
 * Demo-only UI for the quotation approval workflow. Every button calls the
 * same HTTP API that the automated tests call. All people, quotes and amounts
 * shown here are synthetic fictional records.
 */
const API = '/api/v1';

async function api(path, options = {}) {
  const init = { method: options.method || 'GET', headers: { 'Content-Type': 'application/json' } };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const response = await fetch(API + path, init);
  let data = {};
  try { data = await response.json(); } catch { /* non-json body */ }
  return { ok: response.ok, status: response.status, data };
}

export default function App() {
  const [meta, setMeta] = useState(null);
  const [quotes, setQuotes] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [events, setEvents] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [actor, setActor] = useState('u-rep-01');
  const [tab, setTab] = useState('todo');
  const [comment, setComment] = useState('');
  const [clock, setClock] = useState('');
  const [submitMsg, setSubmitMsg] = useState('');
  const [tabMsg, setTabMsg] = useState('');
  const [sweepMsg, setSweepMsg] = useState('');
  const [clockMsg, setClockMsg] = useState('');
  const [rowMsg, setRowMsg] = useState({});

  const load = useCallback(async () => {
    const [m, q, a, e, n] = await Promise.all([
      api('/meta'),
      api('/sales/quotes'),
      api(`/sales/approvals?tab=${tab}&actor_id=${encodeURIComponent(actor)}`),
      api('/events'),
      api('/notifications'),
    ]);
    if (m.ok) setMeta(m.data);
    if (q.ok) setQuotes(q.data.quotes);
    if (a.ok) {
      setApprovals(a.data.approvals);
      setTabMsg(`tab=${a.data.tab} · 操作人=${a.data.actor_id} · ${a.data.total} 条`);
    }
    if (e.ok) setEvents(e.data.events);
    if (n.ok) setNotifications(n.data.notifications);
  }, [tab, actor]);

  useEffect(() => { load(); }, [load]);

  async function submit(qid) {
    const r = await api(`/sales/quotes/${qid}/submit`, {
      method: 'POST',
      body: { submitted_by: actor, client_ip: '203.0.113.9' },
    });
    setSubmitMsg(r.ok
      ? `已提交 ${qid} → ${r.data.approval.id} · 状态 ${r.data.approval.status}`
      : `失败 ${r.data.code || r.status}`);
    await load();
  }

  async function decide(approval, action) {
    const r = await api(`/sales/approvals/${approval.id}/${action}`, {
      method: 'POST',
      body: { actor_id: actor, comment, client_ip: '203.0.113.9' },
    });
    const text = r.ok
      ? `${action} 成功 → 审批 ${r.data.approval.status} · 报价 ${r.data.quote.status}`
      : `失败 ${r.data.code || r.status}`;
    setRowMsg((prev) => ({ ...prev, [approval.id]: text }));
    await load();
  }

  async function applyNow() {
    const r = await api('/test/set-now', { method: 'POST', body: { now: clock || null } });
    setClockMsg(r.ok ? `当前注入时间：${r.data.now}` : `失败 ${r.status}`);
    await load();
  }

  async function sweep() {
    const r = await api('/approvals/reminder-sweep', { method: 'POST', body: {} });
    setSweepMsg(r.ok
      ? `扫描 ${r.data.scanned} · 审批人提醒 ${r.data.approver_reminders} · 会所经理通知 ${r.data.manager_reminders}`
      : `失败 ${r.status}`);
    await load();
  }

  async function resetAll() {
    await api('/test/reset', { method: 'POST', body: {} });
    setRowMsg({}); setSubmitMsg(''); setSweepMsg(''); setClockMsg(''); setClock('');
    await load();
  }

  const actors = meta?.actors || [];
  const routes = meta?.tier_routes || [];

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1 data-testid="app-title">报价审批流转 · 演示台</h1>
          <p className="sub">按 tier 路由审批步骤；rep 自动通过，supervisor 单步，site_manager 依次经主管与会所经理。数据全部为虚构示例。</p>
        </div>
        <div className="top-actions">
          <label className="form-grid" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#9db0cd' }}>当前操作人</span>
            <select data-testid="actor-select" value={actor} onChange={(e) => setActor(e.target.value)} style={{ width: 170 }}>
              {actors.map((a) => <option key={a.id} value={a.id}>{a.id} · {a.name}</option>)}
            </select>
          </label>
          <button data-testid="run-reminder" onClick={sweep}>运行超时提醒</button>
          <button data-testid="reset-btn" className="ghost" onClick={resetAll}>重置</button>
        </div>
      </header>

      <div className="notice">
        诚实边界：内存数据层，服务重启即清空；步骤记录 append-only（只追加不更新）；快照哈希来自 Node crypto 的确定性 SHA-256；
        超时通知为进程内 stub，不调用外部服务。时钟可通过下方输入框注入以便冻结时间验证。
      </div>

      <section className="panel">
        <h2>注入时钟 / 超时提醒</h2>
        <div className="form-grid">
          <label>ISO 时间（留空恢复真实时钟）
            <input data-testid="set-now" className="short" placeholder="2026-11-24T00:00:00.000Z" value={clock}
              onChange={(e) => setClock(e.target.value)} />
          </label>
          <button data-testid="set-now-btn" className="primary" onClick={applyNow}>设置时钟</button>
          <span className="hint" data-testid="clock-msg">{clockMsg}</span>
          <span className="hint" data-testid="reminder-result">{sweepMsg}</span>
        </div>
        <p className="hint">审批意见（approve 选填，reject 至少 10 字符）：
          <input data-testid="comment-input" className="short" value={comment}
            onChange={(e) => setComment(e.target.value)} placeholder="例如：请补充报价依据后重新提交" />
        </p>
      </section>

      <section className="panel">
        <h2>报价单 <span className="count">共 {quotes.length} 条</span></h2>
        <p className="result" data-testid="submit-msg">{submitMsg}</p>
        <div className="table-wrap">
          <table data-testid="quote-table">
            <thead>
              <tr><th>ID</th><th>层级</th><th>金额</th><th>状态</th><th>快照哈希</th><th>有效期至</th><th>操作</th></tr>
            </thead>
            <tbody>
              {quotes.map((q) => (
                <tr key={q.quote_id} data-testid={`quote-row-${q.quote_id}`}>
                  <td className="mono">{q.quote_id}</td>
                  <td className="mono">{q.tier}</td>
                  <td>{q.amount}</td>
                  <td data-testid={`quote-status-${q.quote_id}`}>
                    <span className={`badge ${q.status}`}>{q.status}</span>
                  </td>
                  <td className="mono">{String(q.snapshot_hash).slice(0, 12)}…</td>
                  <td className="mono">{q.valid_until || '—'}</td>
                  <td>
                    <button data-testid={`submit-${q.quote_id}`} onClick={() => submit(q.quote_id)}>提交审批</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>审批单</h2>
        <div className="tabs">
          <button data-testid="tab-todo" className={tab === 'todo' ? 'active' : 'ghost'} onClick={() => setTab('todo')}>待我处理 todo</button>
          <button data-testid="tab-mine" className={tab === 'mine' ? 'active' : 'ghost'} onClick={() => setTab('mine')}>我提交的 mine</button>
          <button data-testid="tab-done" className={tab === 'done' ? 'active' : 'ghost'} onClick={() => setTab('done')}>已处理 done</button>
        </div>
        <p className="hint" data-testid="tab-result">{tabMsg}</p>
        <div className="table-wrap">
          <table data-testid="approval-table">
            <thead>
              <tr>
                <th>ID</th><th>报价</th><th>层级</th><th>状态</th><th>当前步骤</th>
                <th>当前审批人</th><th>步骤轨迹（append-only）</th><th>操作</th><th>结果</th>
              </tr>
            </thead>
            <tbody>
              {approvals.map((a) => (
                <tr key={a.id} data-testid={`approval-row-${a.id}`}>
                  <td className="mono">{a.id}</td>
                  <td className="mono">{a.quote_id}#{a.revision}</td>
                  <td className="mono">{a.tier}</td>
                  <td data-testid={`approval-status-${a.id}`}><span className={`badge ${a.status}`}>{a.status}</span></td>
                  <td>{a.current_step ?? '—'}</td>
                  <td className="mono" data-testid={`current-approver-${a.id}`}>{a.current_approver_id || '—'}</td>
                  <td className="mono" data-testid={`steps-${a.id}`}>
                    {a.steps.map((s) => `#${s.step_no}:${s.action}`).join(' → ')}
                  </td>
                  <td className="ops">
                    {a.status === 'pending' && (
                      <React.Fragment>
                        <button data-testid={`approve-${a.id}`} onClick={() => decide(a, 'approve')}>批准</button>
                        <button data-testid={`reject-${a.id}`} onClick={() => decide(a, 'reject')}>驳回</button>
                      </React.Fragment>
                    )}
                    {a.status === 'pending' && a.submitted_by === actor && (
                      <button data-testid={`withdraw-${a.id}`} className="ghost" onClick={() => decide(a, 'withdraw')}>撤回</button>
                    )}
                  </td>
                  <td className="result-cell" data-testid={`row-msg-${a.id}`}>{rowMsg[a.id] || ''}</td>
                </tr>
              ))}
              {approvals.length === 0 && <tr><td colSpan="9" className="empty">当前筛选下暂无审批单</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <div className="two-col">
        <section className="panel">
          <h2>路由规则 <span className="count" data-testid="routes-count">{routes.length} 条</span></h2>
          <div className="table-wrap small">
            <table data-testid="route-table">
              <thead><tr><th>层级</th><th>权限上限</th><th>自动通过</th><th>步骤角色序列</th></tr></thead>
              <tbody>
                {routes.map((r) => (
                  <tr key={r.tier}>
                    <td className="mono">{r.tier}</td><td>{r.max_amount}</td>
                    <td>{r.auto_approve ? '是' : '否'}</td>
                    <td className="mono">{r.steps.join(' → ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <h2>领域事件 <span className="count" data-testid="events-count">{events.length} 条</span></h2>
          <div className="table-wrap small">
            <table data-testid="events-table">
              <thead><tr><th>ID</th><th>类型</th><th>报价</th><th>时间</th></tr></thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td className="mono">{e.id}</td><td className="mono">{e.type}</td>
                    <td className="mono">{e.quote_id}</td><td className="mono">{e.at}</td>
                  </tr>
                ))}
                {events.length === 0 && <tr><td colSpan="4" className="empty">暂无事件</td></tr>}
              </tbody>
            </table>
          </div>
          <h2 style={{ marginTop: 18 }}>超时通知（stub） <span className="count" data-testid="notifications-count">{notifications.length} 条</span></h2>
          <div className="table-wrap small">
            <table data-testid="notifications-table">
              <thead><tr><th>ID</th><th>级别</th><th>接收人</th><th>审批单</th><th>时长(h)</th></tr></thead>
              <tbody>
                {notifications.map((n) => (
                  <tr key={n.id}>
                    <td className="mono">{n.id}</td><td className="mono">{n.level}</td>
                    <td className="mono">{n.recipient_id} ({n.recipient_role})</td>
                    <td className="mono">{n.approval_id}</td><td>{n.age_hours}</td>
                  </tr>
                ))}
                {notifications.length === 0 && <tr><td colSpan="5" className="empty">暂无通知</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
