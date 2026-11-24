import React, { useEffect, useState } from 'react';

const API = '/api/sales';
const ROLES = [
  { id: 'actor-director', label: '总监（本部全部）' },
  { id: 'actor-manager-a', label: '会员经理甲（本部）' },
  { id: 'actor-manager-b', label: '会员经理乙（本部）' },
  { id: 'actor-consultant-1', label: '签约顾问甲' },
  { id: 'actor-consultant-2', label: '签约顾问乙' },
];
const STATES = [
  { id: '', label: '全部状态' },
  { id: 'pending_claim', label: '待领取' },
  { id: 'returned_for_info', label: '退回补充中' },
  { id: 'claimed', label: '已领取' },
];
const PACKAGE_FIELDS = [
  { key: 'enterprise_name', label: '会员企业全称' },
  { key: 'contact_name', label: '联系人姓名' },
  { key: 'contact_phone', label: '联系人电话' },
  { key: 'planned_onboarding_date', label: '计划入驻日期' },
  { key: 'contract_no', label: '合同号' },
];

async function api(path, options = {}) {
  const res = await fetch(API + path, options);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const error = new Error(data?.message || 'request failed');
    error.code = data?.code;
    error.status = res.status;
    error.detail = data;
    throw error;
  }
  return data;
}
const post = (path, body) => api(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
});
const patch = (path, body) => api(path, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
});

function Badge({ status }) {
  return <span className={'badge status-' + status}>{status}</span>;
}

export default function App() {
  const [actor, setActor] = useState('actor-manager-a');
  const [statusFilter, setStatusFilter] = useState('');
  const [list, setList] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [packageForm, setPackageForm] = useState({});
  const [reason, setReason] = useState('');
  const [targetManager, setTargetManager] = useState('actor-manager-b');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [outbox, setOutbox] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [crmRecords, setCrmRecords] = useState([]);

  const query = (base) => `${base}?actor=${encodeURIComponent(actor)}`;

  const refresh = async () => {
    const [listData, outboxData, notesData, crmData] = await Promise.all([
      api(query('/handovers') + (statusFilter ? `&status=${statusFilter}` : '')),
      api('/outbox'),
      api('/notifications'),
      api('/crm-records'),
    ]);
    setList(listData.handovers);
    setOutbox(outboxData.rows);
    setNotifications(notesData.notifications);
    setCrmRecords(crmData.records);
  };

  useEffect(() => {
    setSelectedId(null);
    setDetail(null);
    setMessage('');
    setError('');
    refresh().catch((e) => setError(e.message));
  }, [actor, statusFilter]);

  const openDetail = async (id) => {
    setSelectedId(id);
    setMessage('');
    setError('');
    try {
      const data = await api(query(`/handovers/${id}`));
      setDetail(data);
      setPackageForm({ ...data.package });
    } catch (e) {
      setError(e.message);
    }
  };

  const run = async (action, extra = {}) => {
    if (!detail) return;
    setMessage('');
    setError('');
    try {
      let data;
      if (action === 'package') {
        data = await patch(`/handovers/${detail.id}/package`, { actor, package: packageForm });
        setMessage(`package: missing=${data.missing_fields.join(',') || '无'}${data.auto_returned_to_pending_claim ? ' · 已自动回到 pending_claim' : ''}`);
      } else {
        data = await post(`/handovers/${detail.id}/${action}`, { actor, ...extra });
        if (action === 'claim') {
          setMessage(`claim: ${data.from} → ${data.to} · claimed_by=${data.claimed_by} · crm=${data.crm_sync_status}`);
        } else if (action === 'assign') {
          setMessage(`assign: 已指定 ${data.assigned_manager_id} · claim_completed=${data.claim_completed}`);
        } else if (action === 'return') {
          setMessage(`return: ${data.from} → ${data.to} · 已通知签约顾问`);
        }
      }
      await refresh();
      setDetail((old) => ({ ...old, ...data.handover }));
    } catch (e) {
      setError(`${e.code || e.status}: ${e.message}`);
      if (e.detail?.missing_fields) setError((s) => `${s} · missing=${e.detail.missing_fields.join(',')}`);
    }
  };

  const isManager = actor.startsWith('actor-manager');
  const isConsultant = actor.startsWith('actor-consultant');
  const isDirector = actor === 'actor-director';

  return (
    <div className="app">
      <header>
        <h1>会员经理交接与 CRM 同步</h1>
        <p className="tiny">全部人员、企业与合同号均为虚构示例数据 · 内存数据层 · CRM 为本地 stub</p>
      </header>

      <div className="toolbar panel">
        <label>当前身份
          <select data-testid="actor-select" value={actor} onChange={(e) => setActor(e.target.value)}>
            {ROLES.map((role) => <option key={role.id} value={role.id}>{role.label}</option>)}
          </select>
        </label>
        <label>状态过滤
          <select data-testid="status-filter" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            {STATES.map((state) => <option key={state.id} value={state.id}>{state.label}</option>)}
          </select>
        </label>
        <button className="ghost sm" data-testid="refresh" onClick={() => refresh().catch((e) => setError(e.message))}>刷新</button>
      </div>

      {message && <div className="notice" data-testid="action-msg">{message}</div>}
      {error && <div className="error" data-testid="action-error">{error}</div>}

      <div className="grid">
        <section className="panel" data-testid="list-panel">
          <h2>可见交接单 <span className="tiny">共 {list.length} 条</span></h2>
          <table data-testid="handover-list">
            <thead><tr><th>编号</th><th>合同外部引用</th><th>状态</th><th>缺失项</th><th>CRM</th><th /></tr></thead>
            <tbody>
              {list.map((item) => (
                <tr key={item.id} data-testid={`handover-row-${item.id}`}>
                  <td className="mono tiny">{item.id}</td>
                  <td className="tiny">{item.contract_id}</td>
                  <td><Badge status={item.status} /></td>
                  <td className="tiny">{item.missing_fields.length ? item.missing_fields.join(', ') : '无'}</td>
                  <td className="tiny">{item.crm_sync_status}</td>
                  <td><button className="sm" data-testid={`handover-open-${item.id}`} onClick={() => openDetail(item.id)}>详情</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="panel" data-testid="detail-panel">
          <h2>交接详情</h2>
          {!detail ? <p className="tiny">请选择左侧的一条交接单。</p> : (
            <div data-testid="detail-content">
              <p className="tiny">编号 <code data-testid="detail-id">{detail.id}</code> · 合同外部引用 {detail.contract_id} · 版本 {detail.version}</p>
              <p className="tiny">签约顾问 {detail.signing_consultant_id} · 指定经理 {detail.assigned_manager_id || '未指定'} · 状态 <Badge status={detail.status} /></p>
              {detail.return_reason && <div className="notice">退回原因：{detail.return_reason}</div>}
              <div className={'box ' + (detail.missing_fields.length ? 'warn' : 'ok')} data-testid="missing-fields">
                缺失项：{detail.missing_fields.length ? detail.missing_labels.join('、') : '无，可领取'}
              </div>

              {isConsultant && (
                <div className="form-block">
                  <h3>签约顾问补充材料</h3>
                  {PACKAGE_FIELDS.map((field) => (
                    <label className="field-row" key={field.key}>{field.label}
                      <input data-testid={`package-${field.key}`} value={packageForm[field.key] || ''}
                        onChange={(e) => setPackageForm((v) => ({ ...v, [field.key]: e.target.value }))} />
                    </label>
                  ))}
                  <button className="sm" data-testid="action-package" onClick={() => run('package')}>补充并重算缺失项</button>
                </div>
              )}

              {isDirector && (
                <div className="form-block">
                  <h3>总监指定目标会员经理</h3>
                  <label className="field-row">目标经理
                    <select data-testid="assign-target" value={targetManager} onChange={(e) => setTargetManager(e.target.value)}>
                      <option value="actor-manager-a">会员经理甲</option>
                      <option value="actor-manager-b">会员经理乙</option>
                    </select>
                  </label>
                  <button className="sm" data-testid="action-assign" onClick={() => run('assign', { manager_id: targetManager })}>指定经理（尚未完成领取）</button>
                </div>
              )}

              {isManager && (
                <div className="form-block">
                  <h3>会员经理操作</h3>
                  <button className="sm primary" data-testid="action-claim" onClick={() => run('claim')}>领取交接</button>
                  <label className="field-row">退回原因（至少 10 字符）
                    <input data-testid="return-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：联系人电话无法接通，请补充有效号码" />
                  </label>
                  <button className="sm" data-testid="action-return" onClick={() => run('return', { reason })}>退回补充并通知顾问</button>
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      <div className="grid">
        <section className="panel" data-testid="outbox-panel">
          <h2>CRM Outbox <span className="tiny">合同号作外部引用 · 幂等</span></h2>
          <table>
            <thead><tr><th>ID</th><th>外部引用</th><th>状态</th><th>尝试</th><th>下次时间</th></tr></thead>
            <tbody>
              {outbox.map((row) => (
                <tr key={row.id} data-testid={`outbox-row-${row.id}`}>
                  <td className="mono tiny">{row.id}</td>
                  <td className="tiny">{row.external_ref}</td>
                  <td className="tiny">{row.status}</td>
                  <td className="tiny">{row.attempts}/{row.max_attempts}</td>
                  <td className="tiny">{row.last_error || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="panel" data-testid="notification-panel">
          <h2>通知记录</h2>
          <ul className="tiny">
            {notifications.length === 0 && <li>暂无通知</li>}
            {notifications.map((note) => <li key={note.id} data-testid={`notification-${note.id}`}>{note.type} → {note.recipient_id}：{note.message}</li>)}
          </ul>
          <h2>CRM stub 记录</h2>
          <ul className="tiny">
            {crmRecords.length === 0 && <li>暂无同步记录</li>}
            {crmRecords.map((record) => <li key={record.external_ref} data-testid={`crm-record-${record.external_ref}`}>{record.external_ref} · 同步 {record.sync_count} 次 · {record.enterprise?.name}</li>)}
          </ul>
        </section>
      </div>
    </div>
  );
}
