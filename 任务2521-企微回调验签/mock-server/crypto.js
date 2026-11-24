/**
 * 验签与加解密核心：仅使用 Node 内置 crypto，不引入任何第三方加解密依赖。
 *
 * - 签名：token / timestamp / nonce / 密文 四值按字典序拼接后做 SHA1。
 * - 密钥：EncodingAESKey 追加一个 "=" 后 Base64 解码，得到 32 字节 AES key；IV 为 key 前 16 字节。
 * - 加密：AES-256-CBC，PKCS#7 填充块长 32 字节。
 * - 明文封包：16 字节随机前缀 + 4 字节大端长度 + 消息体 + receiveid。
 */
import crypto from 'node:crypto';

const BLOCK_SIZE = 32;
const RANDOM_BYTES = 16;
const HEX_40 = /^[0-9a-f]{40}$/i;

/** 由 EncodingAESKey 派生 32 字节 AES key。密钥只由调用方从环境变量传入。 */
export function deriveAesKey(encodingAesKey) {
  if (typeof encodingAesKey !== 'string' || !encodingAesKey) {
    throw new Error('MISSING_ENCODING_AES_KEY');
  }
  const key = Buffer.from(`${encodingAesKey}=`, 'base64');
  if (key.length !== 32) throw new Error('INVALID_ENCODING_AES_KEY');
  return key;
}

/** 按官方文档计算签名：四值字典序拼接后 SHA1，返回 40 位十六进制字符串。 */
export function computeSignature({ token, timestamp, nonce, ciphertext }) {
  const parts = [String(token), String(timestamp), String(nonce), String(ciphertext)];
  const joined = parts.slice().sort().join('');
  return crypto.createHash('sha1').update(joined, 'utf8').digest('hex');
}

/** 恒定时间比较签名，签名不符时立即拒绝，不做任何解密。 */
export function verifySignature({ token, timestamp, nonce, ciphertext, msgSignature }) {
  if (typeof msgSignature !== 'string' || !HEX_40.test(msgSignature)) {
    return { ok: false, reason: 'INVALID_SIGNATURE_FORMAT' };
  }
  const expected = computeSignature({ token, timestamp, nonce, ciphertext });
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(msgSignature.toLowerCase(), 'utf8');
  const same = a.length === b.length && crypto.timingSafeEqual(a, b);
  return same ? { ok: true, reason: null } : { ok: false, reason: 'SIGNATURE_MISMATCH' };
}

/** 时间戳窗口校验：与服务器时间偏差超过 maxAgeSec 秒即拒绝。 */
export function checkTimestamp(timestamp, nowMs = Date.now(), maxAgeSec = 300) {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return { ok: false, delta: null, reason: 'INVALID_TIMESTAMP' };
  const delta = Math.abs(Math.floor(nowMs / 1000) - Math.floor(seconds));
  return delta <= maxAgeSec
    ? { ok: true, delta, reason: null }
    : { ok: false, delta, reason: 'TIMESTAMP_OUT_OF_WINDOW' };
}

/** PKCS#7 填充/去填充，块长固定 32 字节（与官方回调约定一致）。 */
export function pkcs7Pad(buf, blockSize = BLOCK_SIZE) {
  const pad = blockSize - (buf.length % blockSize);
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}

export function pkcs7Unpad(buf, blockSize = BLOCK_SIZE) {
  if (!buf.length || buf.length % blockSize !== 0) throw new Error('INVALID_PADDING_LENGTH');
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > blockSize || pad > buf.length) throw new Error('INVALID_PADDING_VALUE');
  const tail = buf.subarray(buf.length - pad);
  if (tail.some((byte) => byte !== pad)) throw new Error('INVALID_PADDING_BYTES');
  return buf.subarray(0, buf.length - pad);
}

/** 封包：16 字节随机串 + 4 字节大端消息长度 + 消息体 + receiveid。 */
export function packMessage(text, receiveid = '', randomPrefix = null) {
  const random = randomPrefix ? Buffer.from(randomPrefix) : crypto.randomBytes(RANDOM_BYTES);
  if (random.length !== RANDOM_BYTES) throw new Error('INVALID_RANDOM_PREFIX');
  const body = Buffer.from(String(text), 'utf8');
  const rid = Buffer.from(String(receiveid ?? ''), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  return Buffer.concat([random, length, body, rid]);
}

/** 解包：校验长度字段并返回消息体、receiveid 与随机前缀。 */
export function unpackMessage(packed) {
  if (!Buffer.isBuffer(packed) || packed.length < 20) throw new Error('INVALID_PLAINTEXT_LENGTH');
  const length = packed.readUInt32BE(16);
  if (length > packed.length - 20) throw new Error('INVALID_MESSAGE_LENGTH');
  return {
    random: packed.subarray(0, 16),
    message: packed.subarray(20, 20 + length).toString('utf8'),
    receiveid: packed.subarray(20 + length).toString('utf8'),
  };
}

/** AES-256-CBC 加密，返回 Base64 密文。 */
export function encryptMessage({ text, receiveid = '', encodingAesKey, randomPrefix = null }) {
  const key = deriveAesKey(encodingAesKey);
  const packed = pkcs7Pad(packMessage(text, receiveid, randomPrefix));
  const cipher = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false); // 填充已按 32 字节块手动完成
  return Buffer.concat([cipher.update(packed), cipher.final()]).toString('base64');
}

/** AES-256-CBC 解密、去填充、解包，并校验 receiveid（传入 expectedReceiveid 时）。 */
export function decryptMessage({ ciphertext, encodingAesKey, expectedReceiveid = null }) {
  const key = deriveAesKey(encodingAesKey);
  const raw = Buffer.from(String(ciphertext || ''), 'base64');
  if (!raw.length || raw.length % BLOCK_SIZE !== 0) throw new Error('INVALID_CIPHERTEXT_LENGTH');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  decipher.setAutoPadding(false); // 与加密端一致，由本模块自行去填充
  const packed = pkcs7Unpad(Buffer.concat([decipher.update(raw), decipher.final()]));
  const result = unpackMessage(packed);
  if (expectedReceiveid !== null && result.receiveid !== String(expectedReceiveid)) {
    throw new Error('RECEIVEID_MISMATCH');
  }
  return result;
}

/**
 * 轻量 XML 解析：只处理回调消息体中的扁平标签，支持 CDATA 与实体转义。
 * 不引入 xml2js 等新依赖。
 */
export function parseXml(xml) {
  const out = {};
  if (typeof xml !== 'string') return out;
  const decode = (value) => String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .trim();
  // 先去掉最外层 <xml> 包裹，否则外层匹配会吞掉全部字段。
  const inner = xml.replace(/^\s*<xml\b[^>]*>/i, '').replace(/<\/xml>\s*$/i, '');
  const re = /<(?!\/)([A-Za-z_][\w-]*)\b[^>]*>([\s\S]*?)<\/\1>/g;
  let match;
  while ((match = re.exec(inner)) !== null) out[match[1]] = decode(match[2]);
  return out;
}

/** 从外层回调 XML 或 JSON 包装中取出 Encrypt 字段，不改动其 Base64 内容。 */
export function extractEncryptedField(body) {
  if (!body) return null;
  if (typeof body === 'object') {
    return typeof body.Encrypt === 'string' ? body.Encrypt : null;
  }
  const text = String(body);
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed.Encrypt === 'string' ? parsed.Encrypt : null;
    } catch { return null; }
  }
  const cdata = /<Encrypt>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/Encrypt>/.exec(text);
  if (cdata) return cdata[1];
  const plain = /<Encrypt>\s*([^<\s]+)\s*<\/Encrypt>/.exec(text);
  return plain ? plain[1] : null;
}
