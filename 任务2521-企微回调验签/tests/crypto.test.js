import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveAesKey, computeSignature, verifySignature, checkTimestamp,
  pkcs7Pad, pkcs7Unpad, encryptMessage, decryptMessage, parseXml,
} from '../mock-server/crypto.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(fs.readFileSync(path.join(dirname, '..', 'data', 'test-vectors.json'), 'utf8'));
const { token, encodingAesKey, corpId } = vectors.config;

// 独立的参考实现：只用 node:crypto 按公开文档手算，不调用被测模块。
const refKey = (key) => {
  const bytes = Buffer.from(`${key}=`, 'base64');
  if (bytes.length !== 32) throw new Error('bad encoding key');
  return bytes;
};
const refPad = (buf) => {
  const pad = 32 - (buf.length % 32);
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
};
const refUnpad = (buf) => {
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 32 || pad > buf.length) throw new Error('bad padding');
  if (buf.subarray(buf.length - pad).some((b) => b !== pad)) throw new Error('bad padding');
  return buf.subarray(0, buf.length - pad);
};
function refEncrypt({ text, receiveid, randomHex }) {
  const key = refKey(encodingAesKey);
  const body = Buffer.from(text, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const packed = Buffer.concat([Buffer.from(randomHex, 'hex'), length, body, Buffer.from(receiveid, 'utf8')]);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(refPad(packed)), cipher.final()]).toString('base64');
}
function refDecrypt(ciphertext) {
  const key = refKey(encodingAesKey);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const packed = refUnpad(Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final(),
  ]));
  const length = packed.readUInt32BE(16);
  return {
    random: packed.subarray(0, 16).toString('hex'),
    message: packed.subarray(20, 20 + length).toString('utf8'),
    receiveid: packed.subarray(20 + length).toString('utf8'),
  };
}
const refSign = ({ timestamp, nonce, ciphertext }) => crypto.createHash('sha1')
  .update([token, String(timestamp), nonce, ciphertext].sort().join(''), 'utf8')
  .digest('hex');

test('自建向量：模块与独立参考实现的密文完全一致', () => {
  expect(deriveAesKey(encodingAesKey)).toHaveLength(32);
  expect(vectors.vectors).toHaveLength(5);
  for (const v of vectors.vectors) {
    const moduleCipher = encryptMessage({
      text: v.plaintext,
      receiveid: v.receiveid,
      encodingAesKey,
      randomPrefix: Buffer.from(v.random_prefix_hex, 'hex'),
    });
    const manualCipher = refEncrypt({
      text: v.plaintext, receiveid: v.receiveid, randomHex: v.random_prefix_hex,
    });
    expect(moduleCipher, `${v.name}: module ciphertext`).toBe(v.expected.ciphertext);
    expect(manualCipher, `${v.name}: hand-computed ciphertext`).toBe(v.expected.ciphertext);
  }
});

test('自建向量：解密结果与原文逐字一致，含 UTF-8 中文正文', () => {
  for (const v of vectors.vectors) {
    const opened = decryptMessage({
      ciphertext: v.expected.ciphertext, encodingAesKey, expectedReceiveid: v.receiveid || null,
    });
    expect(opened.message, `${v.name}: module plaintext`).toBe(v.plaintext);
    expect(opened.receiveid, `${v.name}: receiveid`).toBe(v.receiveid);
    expect(opened.random.toString('hex')).toBe(v.random_prefix_hex);

    const manual = refDecrypt(v.expected.ciphertext);
    expect(manual.message, `${v.name}: reference plaintext`).toBe(v.plaintext);
    expect(manual.receiveid).toBe(v.receiveid);
    expect(manual.random).toBe(v.random_prefix_hex);
  }
  expect(vectors.vectors.find((v) => v.name === 'change_contact_event').plaintext).toContain('虚构成员');
});

test('自建向量：签名等于按文档手算的排序拼接 SHA1', () => {
  for (const v of vectors.vectors) {
    const manual = refSign({ timestamp: v.timestamp, nonce: v.nonce, ciphertext: v.expected.ciphertext });
    expect(manual, `${v.name}: hand-computed signature`).toBe(v.expected.signature);
    expect(computeSignature({
      token, timestamp: v.timestamp, nonce: v.nonce, ciphertext: v.expected.ciphertext,
    }), `${v.name}: module signature`).toBe(v.expected.signature);
    expect(verifySignature({
      token, timestamp: v.timestamp, nonce: v.nonce,
      ciphertext: v.expected.ciphertext, msgSignature: v.expected.signature,
    }).ok).toBe(true);
  }
});

test('签名错误与 receiveid 不匹配都被拒绝', () => {
  const v = vectors.vectors[1];
  const bad = verifySignature({
    token, timestamp: v.timestamp, nonce: v.nonce,
    ciphertext: v.expected.ciphertext, msgSignature: '0'.repeat(40),
  });
  expect(bad.ok).toBe(false);
  expect(verifySignature({
    token, timestamp: v.timestamp, nonce: v.nonce,
    ciphertext: v.expected.ciphertext, msgSignature: 'not-a-signature',
  }).reason).toBe('INVALID_SIGNATURE_FORMAT');
  expect(() => decryptMessage({
    ciphertext: v.expected.ciphertext, encodingAesKey, expectedReceiveid: 'wwWrongCorp',
  })).toThrow('RECEIVEID_MISMATCH');
  expect(() => decryptMessage({ ciphertext: 'aGVsbG8=', encodingAesKey })).toThrow();
});

test('时间窗与 PKCS#7 使用 32 字节块', () => {
  const now = 1770000000 * 1000;
  expect(checkTimestamp('1770000000', now).ok).toBe(true);
  expect(checkTimestamp(String(1770000000 + 300), now).ok).toBe(true);
  expect(checkTimestamp(String(1770000000 + 301), now).reason).toBe('TIMESTAMP_OUT_OF_WINDOW');
  expect(checkTimestamp('1770000000', now - 301 * 1000).ok).toBe(false);
  expect(checkTimestamp('n/a', now).reason).toBe('INVALID_TIMESTAMP');

  for (const size of [0, 1, 15, 16, 31, 32, 64, 100]) {
    const raw = Buffer.alloc(size, 0x41);
    const padded = pkcs7Pad(raw);
    expect(padded.length % 32).toBe(0);
    expect(Buffer.from(pkcs7Unpad(padded)).equals(raw)).toBe(true);
  }
  expect(() => pkcs7Unpad(Buffer.alloc(33, 0x41))).toThrow();
});

test('XML 解析从 CDATA 中读出结构化事件字段', () => {
  const v = vectors.vectors.find((item) => item.name === 'change_contact_event');
  const fields = parseXml(v.plaintext);
  expect(fields.Event).toBe('change_contact');
  expect(fields.ChangeType).toBe('add_user');
  expect(fields.UserID).toBe('member-bob-002');
  expect(fields.Name).toBe('虚构成员');
  expect(fields.CreateTime).toBe('1770000001');
  expect(corpId).toBe('wwFictionalCorpDemo001');
});
