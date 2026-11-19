'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const SCOPES = new Set(['applicationState', 'persistedAtoms', 'settings']);
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const CREDENTIAL_KEYS = new Set(['apikey', 'accesstoken', 'refreshtoken', 'idtoken', 'password', 'authorization', 'privatekey', 'secret', 'credentials', 'token']);
const MAX_BYTES = 4 * 1024 * 1024;

function invalid(message) {
  const error = new Error(`应用偏好无效：${message}`);
  error.code = 'INVALID_APP_PREFERENCE';
  return error;
}

function validateKey(key) {
  if (typeof key !== 'string' || !key || key.length > 512 || /[\u0000-\u001f\u007f]/u.test(key) || RESERVED_KEYS.has(key)) {
    throw invalid('键必须是安全的非空文本');
  }
  if (CREDENTIAL_KEYS.has(key.replace(/[-_\s]/gu, '').toLowerCase())) throw invalid('凭证必须由专用 Provider 存储管理');
}

function jsonValue(value, depth = 0, ancestors = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (depth >= 32 || typeof value !== 'object' || value === null || ancestors.has(value)) throw invalid('值必须是深度有限、无循环的 JSON');
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw invalid('值只能包含普通 JSON 对象');
  const keys = Reflect.ownKeys(value);
  if (keys.length > 10000 || keys.some(key => typeof key !== 'string')) throw invalid('对象键数量或类型不受支持');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (keys.some(key => key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key)) || value.length > 10000) throw invalid('数组格式不受支持');
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalid('数组不能包含空位或访问器');
        result.push(jsonValue(descriptor.value, depth + 1, ancestors));
      }
      return result;
    }
    const result = Object.create(null);
    for (const key of keys) {
      validateKey(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid('对象不能包含访问器或隐藏属性');
      result[key] = jsonValue(descriptor.value, depth + 1, ancestors);
    }
    return result;
  } finally { ancestors.delete(value); }
}

function emptyState() {
  return { version: 1, applicationState: Object.create(null), persistedAtoms: Object.create(null), settings: Object.create(null) };
}

class PreferencesStore {
  constructor(userData, getLocale) {
    this.filename = path.join(userData, 'app-preferences.json');
    this.getLocale = getLocale;
    this.state = null;
    this.pending = Promise.resolve();
  }

  enqueue(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }

  async load() {
    if (this.state) return;
    let contents;
    let handle;
    try {
      handle = await fs.open(this.filename, 'r');
      if ((await handle.stat()).size > MAX_BYTES) throw invalid('app-preferences.json 超过 4 MiB');
      contents = await handle.readFile('utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = emptyState();
      return;
    } finally { if (handle) await handle.close(); }
    let parsed;
    try { parsed = jsonValue(JSON.parse(contents)); } catch (error) {
      throw invalid(`app-preferences.json 无法读取；原文件已保留（${error.code || 'JSON_PARSE_ERROR'}）`);
    }
    if (parsed.version !== 1 || Object.keys(parsed).some(key => key !== 'version' && !SCOPES.has(key))) throw invalid('app-preferences.json 版本或字段不受支持；原文件已保留');
    for (const scope of SCOPES) {
      if (!parsed[scope] || typeof parsed[scope] !== 'object' || Array.isArray(parsed[scope])) throw invalid(`${scope} 必须是 JSON 对象；原文件已保留`);
    }
    this.state = parsed;
  }

  snapshot() {
    const locale = this.getLocale();
    return JSON.parse(JSON.stringify({ ...this.state, locale: typeof locale === 'string' && locale ? locale : 'en-US' }));
  }

  read() {
    return this.enqueue(async () => {
      await this.load();
      return this.snapshot();
    });
  }

  write(scope, key, value) {
    return this.enqueue(async () => {
      if (!SCOPES.has(scope)) throw invalid('未知的偏好作用域');
      validateKey(key);
      const validated = value === undefined ? undefined : jsonValue(value);
      await this.load();
      const next = jsonValue(this.state);
      if (validated === undefined) delete next[scope][key];
      else next[scope][key] = validated;
      const contents = `${JSON.stringify(next, null, 2)}\n`;
      if (Buffer.byteLength(contents, 'utf8') > MAX_BYTES) throw invalid('应用偏好超过 4 MiB');
      await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      let handle;
      try {
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(temporary, this.filename);
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        await fs.unlink(temporary).catch(() => {});
        throw error;
      }
      this.state = next;
      return this.snapshot();
    });
  }

  flush() { return this.pending; }
}

module.exports = { PreferencesStore };
