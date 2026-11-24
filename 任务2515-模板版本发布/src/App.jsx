import React, { useEffect, useState } from 'react';

const API = '/api/sop';

async function api(path, options) {
  const res = await fetch(API + path, options);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const err = new Error(data?.message || 'request failed');
    err.code = data?.code;
    err.status = res.status;
    err.detail = data;
    throw err;
  }
  return data;
}
const send = (method, path, body) => api(path, {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
});
const post = (path, body) => send('POST', path, body);
const put = (path, body) => send('PUT', path, body);

function Badge({ status }) {
  return <span className={'badge status-' + status}>{status}</span>;
}

function TemplatePanel({ id, refreshKey, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [versions, setVersions] = useState([]);
  const [steps, setSteps] = useState([]);
  const [notes, setNotes] = useState('收紧第三步风控时限至 24 小时');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api(`/templates/${id}`), api(`/templates/${id}/versions`)])
      .then(([d, v]) => {
        setDetail(d.template);
        setVersions(v.versions);
        setSteps(d.template.draft.steps);
      })
      .catch((e) => setError(e.message));
  }, [id, refreshKey]);

  const run = async (label, fn) => {
    setMsg(''); setError('');
    try {
      const result = await fn();
      const diffText = result.diff_summary?.text || result.diff && `${result.diff.added.length}/${result.diff.removed.length}/${result.diff.modified.length}`;
      setMsg(`${label} · ${diffText ? diffText : ''}`.trim());
      onChanged();
    } catch (e) {
      setError(`${e.code || e.status}: ${e.message}`);
    }
  };

  const setHours = (stepId, value) => {
    setSteps((prev) => prev.map((s) => (s.id === stepId ? { ...s, time_limit_hours: Number(value) } : s)));
  };

  return (
    <div data-testid="template-detail">
      <div className="panel">
        <h2>{detail?.name || '模板详情'} <Badge status={detail?.status || 'draft'} /> <span className="tiny">当前版本 v{detail?.current_version ?? 0}</span></h2>
        <p className="tiny">{detail?.description}</p>
        <div className="tiny">模板编号 <code>{id}</code> · 发布版本个数 {versions.length} · 所有数据均为虚构示例</div>
        {msg && <div className="notice" data-testid="action-msg">{msg}</div>}
        {error && <div className="error" data-testid="action-error">{error}</div>}
      </div>

      <div className="panel">
        <h3>可编辑草稿步骤（草稿修改不影响已创建的实例）</h3>
        <table data-testid="draft-table">
          <thead><tr><th>步骤编号</th><th>标题</th><th>负责角色</th><th>时限（小时）</th></tr></thead>
          <tbody>
            {steps.map((s) => (
              <tr key={s.id} data-testid={'draft-row-' + s.id}>
                <td className="mono tiny">{s.id}</td>
                <td>{s.title}</td>
                <td className="tiny">{s.assignee_role}</td>
                <td>
                  <input className="sm-input" type="number" min="1" data-testid={'draft-hours-' + s.id}
                    value={s.time_limit_hours ?? ''}
                    onChange={(e) => setHours(s.id, e.target.value)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="field-row" style={{ marginTop: 14 }}>
          <label style={{ flex: 0, whiteSpace: 'nowrap' }}>发布说明 release_notes</label>
          <textarea data-testid="release-notes" rows="2" value={notes}
            placeholder="例如：收紧第三步风控时限至 24 小时"
            onChange={(e) => setNotes(e.target.value)} />
        </div>
        <div className="action-grid">
          <button data-testid="save-draft-btn" onClick={() => run('草稿已保存', () => put(`/templates/${id}/draft`, { steps }))}>保存草稿</button>
          <button className="primary" data-testid="publish-btn" onClick={() => run('发布成功', () => post(`/templates/${id}/publish`, { release_notes: notes }))}>发布新版本</button>
          <button data-testid="trigger-btn" onClick={() => run('实例已触发', () => post(`/templates/${id}/instances`, {}))}>触发新实例</button>
          <button className="danger" data-testid="disable-btn" onClick={() => run('模板已停用', () => post(`/templates/${id}/disable`, {}))}>停用模板</button>
        </div>
      </div>

      <div className="panel">
        <h3>已冻结的版本快照 <span className="tiny">仅新增，不修改</span></h3>
        <table data-testid="version-table">
          <thead><tr><th>版本</th><th>步骤数</th><th>第三步时限</th><th>发布说明</th><th>发布时间</th><th>摘要</th></tr></thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.version_no} data-testid={'version-row-' + v.version_no}>
                <td className="mono">v{v.version_no}</td>
                <td>{v.step_count}</td>
                <td>{v.steps.find((s) => s.id === 'step-3')?.time_limit_hours ?? '—'} 小时</td>
                <td className="tiny">{v.release_notes}</td>
                <td className="tiny">{v.published_at}</td>
                <td className="mono tiny">{String(v.snapshot_digest).slice(0, 12)}…</td>
              </tr>
            ))}
            {versions.length === 0 && <tr><td colSpan="6" className="tiny">尚未发布任何版本。先保存草稿，再填写发布说明并发布。</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function InstancesPanel({ refreshKey, onChanged }) {
  const [instances, setInstances] = useState([]);

  useEffect(() => {
    api('/instances').then((d) => setInstances(d.instances)).catch(() => {});
  }, [refreshKey]);

  const complete = async (id) => {
    try { await post(`/instances/${id}/complete`, {}); onChanged(); } catch { /* keep the row as-is */ }
  };

  return (
    <div className="panel">
      <h2>实例与版本快照 <span className="tiny">实例创建时深拷贝模板快照，之后任何发布/停用/草稿修改都不改变它</span></h2>
      <table data-testid="instance-list">
        <thead><tr><th>实例编号</th><th>模板</th><th>模板版本</th><th>快照第三步时限</th><th>快照摘要</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          {instances.map((i) => {
            const step3 = i.template_snapshot.find((s) => s.id === 'step-3');
            return (
              <tr key={i.id} data-testid={'instance-row-' + i.id}>
                <td className="mono tiny">{i.id}</td>
                <td className="tiny">{i.template_id}</td>
                <td>v{i.template_version}</td>
                <td>{step3?.time_limit_hours ?? '—'} 小时</td>
                <td className="mono tiny">{String(i.template_snapshot_digest).slice(0, 12)}…</td>
                <td><Badge status={i.status} /></td>
                <td>
                  <button className="sm" data-testid={'instance-complete-' + i.id}
                    disabled={i.status === 'completed'} onClick={() => complete(i.id)}>继续执行至完成</button>
                </td>
              </tr>
            );
          })}
          {instances.length === 0 && <tr><td colSpan="7" className="tiny">还没有实例。到「模板与版本」页签发布并触发一个实例。</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function AuditPanel({ refreshKey }) {
  const [records, setRecords] = useState([]);

  useEffect(() => {
    api('/audit').then((d) => setRecords(d.records)).catch(() => {});
  }, [refreshKey]);

  return (
    <div className="panel">
      <h2>审计日志 <span className="tiny">发布与停用均记录与前版本的 diff 摘要</span></h2>
      <div className="scroll" data-testid="audit-list">
        {records.map((a) => (
          <div key={a.id} className="history-item" data-testid={'audit-row-' + a.id}>
            <b>{a.category}</b> · {a.template_id} · v{a.from_version ?? '—'} → v{a.to_version ?? '—'} · {a.at}
            <div className="tiny">{a.diff_summary?.text}</div>
          </div>
        ))}
        {records.length === 0 && <div className="tiny">尚无审计记录。</div>}
      </div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState('templates');
  const [templates, setTemplates] = useState([]);
  const [selectedId, setSelectedId] = useState('tpl-intake-review');
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = () => setRefreshKey((k) => k + 1);

  useEffect(() => {
    api('/templates').then((d) => setTemplates(d.templates)).catch(() => {});
  }, [refreshKey]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">SOP</span>
          <div>
            <h1>SOP 模板版本发布、停用与实例版本隔离</h1>
            <p>完整性校验 · 版本冻结与快照 · 新实例取最新版本 · 审计 diff 摘要</p>
          </div>
        </div>
        <div className="meta">
          模板管理演示
          <div className="tiny">合成数据 · 无真实个人信息 · 演示环境</div>
        </div>
      </header>

      <nav className="tabs">
        {[['templates', '模板与版本'], ['instances', '实例与隔离'], ['audit', '审计日志']].map(([k, label]) => (
          <button key={k} data-testid={'tab-' + k} className={tab === k ? 'active' : ''}
            onClick={() => setTab(k)}>{label}</button>
        ))}
      </nav>

      <main>
        {tab === 'templates' && (
          <div>
            <div className="panel">
              <h2>模板清单 <span className="tiny">{templates.length} 个 · 均为虚构示例</span></h2>
              <table data-testid="template-list">
                <thead><tr><th>模板编号</th><th>名称</th><th>状态</th><th>当前版本</th><th>操作</th></tr></thead>
                <tbody>
                  {templates.map((t) => (
                    <tr key={t.id} data-testid={'template-row-' + t.id}>
                      <td className="mono tiny">{t.id}</td>
                      <td>{t.name}</td>
                      <td><Badge status={t.status} /></td>
                      <td>v{t.current_version}</td>
                      <td><button className="sm" data-testid={'template-open-' + t.id}
                        onClick={() => setSelectedId(t.id)}>管理版本</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TemplatePanel id={selectedId} refreshKey={refreshKey} onChanged={bump} />
          </div>
        )}
        {tab === 'instances' && <InstancesPanel refreshKey={refreshKey} onChanged={bump} />}
        {tab === 'audit' && <AuditPanel refreshKey={refreshKey} />}
      </main>

      <footer>演示级交付 · 内存数据层可替换为真实数据库 · 不提供把进行中实例迁移到新版本的能力</footer>
    </div>
  );
}
