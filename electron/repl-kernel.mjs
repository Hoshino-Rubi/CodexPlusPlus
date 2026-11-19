import { parentPort, workerData } from 'node:worker_threads';
import repl from 'node:repl';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { inspect } from 'node:util';
import { parse, stringify } from 'smol-toml';
import debug from './runtime-debug.js';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

if (process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES) registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (!/^(?:@[^/]+\/)?[a-zA-Z0-9_-]/u.test(specifier) || specifier.includes(':')) throw error;
      return nextResolve(specifier, { ...context, parentURL: pathToFileURL(path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, '..', 'codex-runtime.mjs')).href });
    }
  },
});

let content = [];
const afterHooks = new Set();
const endHooks = new Set();
const configRoot = path.join(process.env.CODEX_HOME, 'browser');
const configPath = value => {
  const target = path.resolve(configRoot, value);
  const relative = path.relative(configRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Browser config path escapes its root');
  return target;
};
const pushText = text => content.push({ type: 'text', text: String(text) });
const rpc = async (service, request) => {
  if (service === 'browser' && request.method !== 'native') {
    if (process.env.CODEX_DEBUG_HOST === '1') debug.runtimeDebug('NODE_BROWSER', { method: request.method, command: request.params?.type, phase: 'start' });
    const { handleRpc } = await import(new URL('./resources/plugins/openai-bundled/plugins/browser/scripts/browser-service.mjs', import.meta.url));
    try { return await handleRpc(request); }
    finally { if (process.env.CODEX_DEBUG_HOST === '1') debug.runtimeDebug('NODE_BROWSER', { method: request.method, command: request.params?.type, phase: 'end' }); }
  }
  if (service === 'artifact_session') throw new Error('Live artifact sessions are unavailable in this local host. Run artifact-tool file imports in a standalone primary-runtime Node script (without nodeRepl); file authoring, rendering and export are supported.');
  if (service !== 'computer' && !(service === 'browser' && request.method === 'native')) throw new Error(`Unknown trusted service: ${service}`);
  const forwarded = service === 'browser' ? { method: request.params?.method,
    params: { ...request.params?.params, session_id: nodeRepl.requestMeta['x-codex-turn-metadata']?.session_id } } : request;
  const response = await fetch(process.env.CODEX_LOCAL_HOST_URL, {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${process.env.CODEX_LOCAL_HOST_TOKEN}` },
    body: JSON.stringify({ service, ...forwarded }),
  });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(body.error ?? `Local host HTTP ${response.status}`);
  return body.result;
};
globalThis.nodeRepl = {
  env: { ...process.env }, cwd: process.cwd(), requestMeta: {},
  fetch: (input, options) => fetch(input, options),
  config: {
    read: async () => ({ config: parse(await fs.readFile(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8')), layers: [] }),
    readRequirements: async () => ({ requirements: null }),
    readToml: async filename => { try { return parse(await fs.readFile(configPath(filename), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; } },
    writeToml: async (filename, value) => { const target = configPath(filename); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, stringify(value)); },
  },
  rpc,
  write: pushText,
  emitContentItem: item => { if (item?.type) content.push(item); else pushText(typeof item === 'string' ? item : JSON.stringify(item)); },
  emitImage: async input => {
    let data;
    let mimeType = 'image/png';
    if (typeof input === 'string' && input.startsWith('data:')) { const match = input.match(/^data:([^;]+);base64,([\s\S]+)$/u); if (!match) throw new Error('Invalid image data URL'); [, mimeType, data] = match; }
    else if (input instanceof Uint8Array) data = Buffer.from(input).toString('base64');
    else if (input?.bytes) { data = Buffer.from(input.bytes).toString('base64'); mimeType = input.mimeType ?? mimeType; }
    else if (input?.data) { data = input.data; mimeType = input.mimeType ?? mimeType; }
    else throw new Error('Unsupported image representation');
    content.push({ type: 'image', data, mimeType });
  },
  setResponseMeta() {},
  createElicitation: async request => {
    // Local development page access is part of this desktop's browser contract.
    // Other approvals must be decided by the host, never fabricated as a denial.
    const response = await fetch(process.env.CODEX_LOCAL_HOST_URL, {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${process.env.CODEX_LOCAL_HOST_TOKEN}` },
      body: JSON.stringify({ service: 'approval', method: 'browser', params: request }),
    });
    const value = await response.json();
    if (value.error) throw new Error(value.error);
    return value.result;
  },
  addAfterSubmittedCodeHook: hook => { afterHooks.add(hook); return () => afterHooks.delete(hook); },
  addTurnEndedHandler: hook => { endHooks.add(hook); return () => endHooks.delete(hook); },
  nativePipe: {
    createConnection: pipe => new Promise((resolve, reject) => {
      if (pipe !== process.env.BROWSER_USE_BACKEND_PATHS) { reject(new Error('Unknown native browser pipe')); return; }
      const socket = net.createConnection(pipe);
      socket.once('connect', () => { socket.removeListener('error', reject); resolve(socket); });
      socket.once('error', reject);
    }),
  },
};
globalThis.console = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug', 'dir'].map(method => [method, (...args) => pushText(args.map(value => typeof value === 'string' ? value : inspect(value)).join(' '))]));
const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
const server = repl.start({ prompt: '', input: new PassThrough(), output, terminal: false, useGlobal: true, ignoreUndefined: true });
parentPort.on('message', async message => {
  content = [];
  nodeRepl.requestMeta = { 'x-codex-turn-metadata': message.metadata };
  try {
    if (message.type === 'turn_ended') {
      for (const hook of endHooks) await (typeof hook === 'function' ? hook(message.metadata) : hook.run(message.metadata));
    } else {
      const result = await new Promise((resolve, reject) => {
        // Node's REPL routes runtime and top-level-await failures to its domain
        // instead of the eval callback. Surface them as a tool error promptly.
        const onError = error => { server._domain.removeListener('error', onError); reject(error); };
        server._domain.prependListener('error', onError);
        server.eval(`${message.code}\n`, server.context, path.join(process.cwd(), 'local-node-repl.mjs'), (error, value) => {
          server._domain.removeListener('error', onError);
          if (error) reject(error); else resolve(value);
        });
      });
      if (result !== undefined) pushText(typeof result === 'string' ? result : inspect(result, { depth: 6, maxArrayLength: 100 }));
      for (const hook of afterHooks) await (typeof hook === 'function' ? hook() : hook.run());
    }
    parentPort.postMessage({ id: message.id, result: { content: content.length ? content : [{ type: 'text', text: 'Done.' }] } });
  } catch (error) {
    content.push({ type: 'text', text: error.stack ?? error.message });
    parentPort.postMessage({ id: message.id, result: { isError: true, content } });
  }
});
