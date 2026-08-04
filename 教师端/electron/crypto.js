/*!
 * crypto.js - AES-256-GCM 加密模块
 * ------------------------------------------------------------------
 * 用于加密存储用户配置的 API Key，防止明文泄露。
 * 加密密钥存储在 data/.key 文件中（首次运行自动生成）。
 * 密文格式：enc:<base64(iv + authTag + ciphertext)>
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

let _key = null;
let _keyPath = '';

/**
 * 获取或生成加密密钥
 * @param {string} dataRoot - 数据根目录路径
 * @returns {Buffer} 32字节密钥
 */
function getKey(dataRoot) {
  if (_key) return _key;
  _keyPath = path.join(dataRoot, '.key');
  try {
    const raw = fs.readFileSync(_keyPath);
    _key = Buffer.from(raw.toString().trim(), 'base64');
    if (_key.length !== 32) throw new Error('key length mismatch');
  } catch (e) {
    // 首次运行：生成随机密钥
    _key = crypto.randomBytes(32);
    try {
      fs.mkdirSync(path.dirname(_keyPath), { recursive: true });
      fs.writeFileSync(_keyPath, _key.toString('base64'), { encoding: 'utf-8', mode: 0o600 });
    } catch (e2) { /* 写入失败则仅内存使用 */ }
  }
  return _key;
}

/**
 * 加密文本
 * @param {string} text - 明文
 * @param {string} dataRoot - 数据根目录
 * @returns {string} 密文（enc:前缀 + base64）
 */
function encrypt(text, dataRoot) {
  if (!text) return text;
  try {
    const key = getKey(dataRoot);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return 'enc:' + Buffer.concat([iv, tag, encrypted]).toString('base64');
  } catch (e) {
    // 加密失败返回原文（不阻断流程）
    return String(text);
  }
}

/**
 * 解密文本
 * @param {string} data - 密文（enc:前缀）
 * @param {string} dataRoot - 数据根目录
 * @returns {string|null} 明文，失败返回 null
 */
function decrypt(data, dataRoot) {
  if (!data || typeof data !== 'string') return data;
  if (!data.startsWith('enc:')) return data; // 非加密数据，原样返回
  try {
    const key = getKey(dataRoot);
    const buf = Buffer.from(data.slice(4), 'base64');
    const iv = buf.slice(0, IV_LENGTH);
    const tag = buf.slice(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = buf.slice(IV_LENGTH + TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch (e) {
    return null; // 解密失败
  }
}

module.exports = { encrypt, decrypt, getKey };
