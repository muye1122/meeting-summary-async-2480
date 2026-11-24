/**
 * 企业消息回调接口演示服务。
 *
 * GET  /api/wecom/callback  地址验证：验签 + 时间窗 + 解密 echostr 并返回明文。
 * POST /api/wecom/callback  事件推送：验签 + 时间窗 + 解密 + receiveid 校验 + 事件去重入库。
 *
 * Token / EncodingAESKey / CorpID 只从环境变量读取；日志只记录固定安全字段，
 * 绝不输出消息明文、密文或密钥。事件表用内存 Map 模拟，SQL 见 migrations。
 */
import express from 'express';
import crypto from 'node:crypto';
import {
  computeSignature, verifySignature, checkTimestamp,
  encryptMessage, decryptMessage, parseXml, extractEncryptedField,
} from './crypto.js';

const TOKEN = process.env.WECOM_TOKEN;
const ENCODING_AES_KEY = process.env.WECOM_ENCODING_AES_KEY;
const CORP_ID = process.env.WECOM_CORP_ID;

if (!TOKEN || !ENCODING_AES_KEY || !CORP_ID) {
  console.error('[wecom-callback] missing WECOM_TOKEN / WECOM_ENCODING_AES_KEY / WECOM_CORP_ID; refusing to start');
  process.exit(1);
}

const PORT = Number(process.env.PORT || 3001);
const TIMESTAMP_WINDOW_SEC = 300;
const SUPPORTED_EVENTS = [
  'change_contact', 'add_external_contact', 'del_external_contact', 'edit_external_contact',
];
const SUPPORTED_SET = new Set(SUPPORTED_EVENTS);

const app = express();
app.use(express.json());
app.use(express.text({ type: ['text/xml', 'application/xml', 'text/plain'], limit: '1mb' }));

// ---------------------------------------------------------------- 事件表（内存模拟）
const eventRows = new Map();
let processedCount = 0;
const MAX_LOG_ENTRIES = 200;
const logBuffer = [];

/** 只记录白名单字段；任何消息体、密文、密钥都不会进入日志。 */
function log(level, code, meta = {}) {
  const safe = {
    at: new Date().toISOString(),
    level,
    code,
    ...(SUPPORTED_SET.has(meta.event_type) ? { event_type: meta.event_type } : {}),
    ...(meta.dedup_key ? { dedup_key: meta.dedup_key } : {}),
    ...(meta.row_status ? { row_status: meta.row_status } : {}),
    ...(meta.reason ? { reason: meta.reason } : {}),
    ...(meta.http_status !== undefined ? { http_status: meta.http_status } : {}),
    ...(meta.delta !== undefined ? { delta: meta.delta } : {}),
  };
  logBuffer.push(safe);
  if (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.shift();
  console.log(JSON.stringify(safe));
}

/** dedup_key = FromUserName + CreateTime + Event + ChangeType + 相关 UserID/ExternalUserID 的摘要。 */
function buildDedupKey(fields) {
  const source = [
    String(fields.FromUserName || ''),
    String(fields.CreateTime || ''),
    String(fields.Event || ''),
    String(fields.ChangeType || ''),
    String(fields.UserID || fields.NewUserID || ''),
    String(fields.ExternalUserID || ''),
  ].join('\u0001');
  return `evt_${crypto.createHash('sha256').update(source, 'utf8').digest('hex')}`;
}

/** 同一 dedup_key 只写入一次；重复推送不更新 processed_at，也不再次“处理”。 */
function insertOnce(row) {
  const existing = eventRows.get(row.dedup_key);
  if (existing) return { inserted: false, row: existing };
  const now = new Date().toISOString();
  const stored = { ...row, received_at: now, processed_at: now, status: 'processed' };
  eventRows.set(row.dedup_key, stored);
  processedCount += 1;
  return { inserted: true, row: stored };
}

function deny(res, status, code) {
  return res.status(status).json({ code, message: 'request rejected' });
}

/** 前置安全门禁：先签名，再时间窗，全部通过后才允许解密。 */
function guard(req, res, ciphertext) {
  const { msg_signature, timestamp, nonce } = req.query;
  const sig = verifySignature({
    token: TOKEN, timestamp, nonce, ciphertext, msgSignature: msg_signature,
  });
  if (!sig.ok) {
    log('warn', 'signature_rejected', { reason: sig.reason, http_status: 403 });
    deny(res, 403, 'FORBIDDEN');
    return false;
  }
  const time = checkTimestamp(timestamp, Date.now(), TIMESTAMP_WINDOW_SEC);
  if (!time.ok) {
    log('warn', 'timestamp_rejected', { reason: time.reason, http_status: 403, delta: time.delta });
    deny(res, 403, 'FORBIDDEN');
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- 回调接口
app.get('/api/wecom/callback', (req, res) => {
  const echostr = String(req.query.echostr || '');
  if (!echostr || !req.query.msg_signature || !req.query.timestamp || !req.query.nonce) {
    log('warn', 'url_check_missing_parameters', { http_status: 400 });
    return deny(res, 400, 'MISSING_PARAMETERS');
  }
  if (!guard(req, res, echostr)) return;

  try {
    const { message } = decryptMessage({ ciphertext: echostr, encodingAesKey: ENCODING_AES_KEY });
    log('info', 'url_check_ok', { http_status: 200 });
    return res.status(200).type('text/plain').send(message);
  } catch (error) {
    log('warn', 'url_decrypt_failed', { reason: error.message, http_status: 403 });
    return deny(res, 403, 'FORBIDDEN');
  }
});

app.post('/api/wecom/callback', (req, res) => {
  const ciphertext = extractEncryptedField(req.body);
  if (!ciphertext || !req.query.msg_signature || !req.query.timestamp || !req.query.nonce) {
    log('warn', 'event_missing_parameters', { http_status: 400 });
    return deny(res, 400, 'MISSING_PARAMETERS');
  }
  if (!guard(req, res, ciphertext)) return;

  let plainMessage;
  try {
    const decrypted = decryptMessage({
      ciphertext, encodingAesKey: ENCODING_AES_KEY, expectedReceiveid: CORP_ID,
    });
    plainMessage = decrypted.message;
  } catch (error) {
    const code = error.message === 'RECEIVEID_MISMATCH' ? 'receiveid_mismatch' : 'event_decrypt_failed';
    log('warn', code, { reason: error.message, http_status: 403 });
    return deny(res, 403, 'FORBIDDEN');
  }

  const fields = parseXml(plainMessage);
  const event = String(fields.Event || '');
  if (!SUPPORTED_SET.has(event)) {
    log('warn', 'event_unsupported', { event_type: 'unsupported', http_status: 200 });
    return res.json({ status: 'ignored', reason: 'unsupported_event' });
  }

  const dedupKey = buildDedupKey(fields);
  const outcome = insertOnce({
    dedup_key: dedupKey,
    event_type: event,
    payload_json: JSON.stringify({ ...fields, event_type: event }),
  });
  log('info', 'event_accepted', {
    event_type: event,
    dedup_key: dedupKey,
    row_status: outcome.inserted ? 'processed' : 'duplicate',
    http_status: 200,
  });
  return res.json({
    status: outcome.inserted ? 'processed' : 'duplicate',
    event_type: event,
    dedup_key: dedupKey,
  });
});

// ---------------------------------------------------------------- 元信息与健康检查
app.get('/api/wecom/health', (_req, res) => res.json({
  ok: true,
  service: 'wecom-callback-poc',
  clock: Math.floor(Date.now() / 1000),
  event_rows: eventRows.size,
  processed_count: processedCount,
}));

app.get('/api/wecom/meta', (_req, res) => res.json({
  supported_events: SUPPORTED_EVENTS,
  signature: 'sha1(sort(token,timestamp,nonce,ciphertext).join(""))',
  cipher: 'AES-256-CBC / 32-byte PKCS#7',
  timestamp_window_sec: TIMESTAMP_WINDOW_SEC,
  dedup_fields: ['FromUserName', 'CreateTime', 'Event', 'ChangeType', 'UserID', 'ExternalUserID'],
  config_source: 'environment variables only',
  demo_data: 'all fictional, no connection to any real messaging service',
}));

// ---------------------------------------------------------------- 演示与验收钩子
const hooksEnabled = () => process.env.NODE_ENV !== 'production' || process.env.ALLOW_TEST_HOOKS === '1';
function needHooks(res) {
  if (hooksEnabled()) return true;
  deny(res, 404, 'NOT_FOUND');
  return false;
}

function sampleEventXml(eventType, marker, createTime) {
  const common = `<ToUserName><![CDATA[wwFictionalReceiver]]></ToUserName>`
    + `<FromUserName><![CDATA[member-alice-001]]></FromUserName>`
    + `<CreateTime>${createTime}</CreateTime><MsgType><![CDATA[event]]></MsgType>`;
  if (eventType === 'change_contact') {
    return `<xml>${common}<Event><![CDATA[change_contact]]></Event>`
      + `<ChangeType><![CDATA[add_user]]></ChangeType>`
      + `<UserID><![CDATA[member-bob-002]]></UserID>`
      + `<Name><![CDATA[${marker || 'FictionalMember'}]]></Name></xml>`;
  }
  return `<xml>${common}<Event><![CDATA[${eventType}]]></Event>`
    + `<UserID><![CDATA[member-alice-001]]></UserID>`
    + `<ExternalUserID><![CDATA[external-forest-009]]></ExternalUserID>`
    + `<State><![CDATA[${marker || 'demo-state'}]]></State></xml>`;
}

/** 生成一份已签名、已加密、可重复投递的回调信封，供界面与验收使用。 */
app.post('/api/wecom/_test/make-callback', (req, res) => {
  if (!needHooks(res)) return;
  const eventType = SUPPORTED_SET.has(String(req.body?.event_type))
    ? String(req.body.event_type) : 'change_contact';
  const marker = String(req.body?.marker || '');
  const timestamp = String(req.body?.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = String(req.body?.nonce || crypto.randomBytes(6).toString('hex'));
  const innerXml = sampleEventXml(eventType, marker, timestamp);
  const receiveid = req.body?.receiveid === undefined ? CORP_ID : String(req.body.receiveid);
  const encrypt = encryptMessage({ text: innerXml, receiveid, encodingAesKey: ENCODING_AES_KEY });
  const msgSignature = computeSignature({ token: TOKEN, timestamp, nonce, ciphertext: encrypt });
  const body = `<xml><ToUserName><![CDATA[wwFictionalReceiver]]></ToUserName>`
    + `<Encrypt><![CDATA[${encrypt}]]></Encrypt><AgentID><![CDATA[1000002]]></AgentID></xml>`;
  return res.json({ query: { msg_signature: msgSignature, timestamp, nonce }, body, event_type: eventType });
});

/** 生成地址验证用的签名 echostr，返回明文由调用方通过真实回调接口取得。 */
app.post('/api/wecom/_test/make-url-check', (req, res) => {
  if (!needHooks(res)) return;
  const timestamp = String(req.body?.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = String(req.body?.nonce || crypto.randomBytes(6).toString('hex'));
  const echostr = encryptMessage({
    text: 'fictional-url-verification-echo', receiveid: '', encodingAesKey: ENCODING_AES_KEY,
  });
  const msgSignature = computeSignature({ token: TOKEN, timestamp, nonce, ciphertext: echostr });
  return res.json({ query: { msg_signature: msgSignature, timestamp, nonce, echostr } });
});

app.get('/api/wecom/_test/events', (_req, res) => {
  if (!needHooks(res)) return;
  res.json({ rows: Array.from(eventRows.values()), processed_count: processedCount });
});

app.get('/api/wecom/_test/logs', (_req, res) => {
  if (!needHooks(res)) return;
  res.json({ logs: logBuffer });
});

app.post('/api/wecom/_test/reset', (_req, res) => {
  if (!needHooks(res)) return;
  eventRows.clear();
  logBuffer.length = 0;
  processedCount = 0;
  res.json({ ok: true });
});

app.listen(PORT, '0.0.0.0', () => {
  log('info', 'service_started', { http_status: 200 });
  console.log(`[wecom-callback] listening on http://0.0.0.0:${PORT}`);
});
