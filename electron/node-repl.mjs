import readline from 'node:readline';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const kernels = new Map();
const processSession = randomUUID();
function kernelFor(id) {
  let kernel = kernels.get(id);
  if (!kernel) {
    const worker = new Worker(new URL('./repl-kernel.mjs', import.meta.url), {
      workerData: { sessionId: id }, stdout: true, stderr: true,
    });
    // Only framed MCP messages may reach stdout, even when evaluated code logs.
    worker.stdout.resume();
    worker.stderr.resume();
    kernel = { worker, sequence: 0, pending: new Map() };
    worker.on('message', message => {
      const pending = kernel.pending.get(message.id);
      if (pending) { clearTimeout(pending.timer); kernel.pending.delete(message.id); pending.resolve(message.result); }
    });
    const fail = error => {
      kernels.delete(id);
      for (const pending of kernel.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      kernel.pending.clear();
    };
    worker.on('error', fail);
    worker.on('exit', () => fail(new Error('Node runtime stopped')));
    kernels.set(id, kernel);
  }
  return kernel;
}
const tools = [
  { name: 'js', description: 'Run JavaScript in a persistent local Node session. Supports top-level await, imports, nodeRepl.write, nodeRepl.emitImage and trusted browser/computer RPC. Use absolute file paths. Read the selected plugin SKILL.md first.',
    inputSchema: { type: 'object', properties: { code: { type: 'string' }, title: { type: 'string' }, timeout_ms: { type: 'number' } }, required: ['code'] } },
  { name: 'js_reset', description: 'Reset this local JavaScript session and close its kernel.', inputSchema: { type: 'object', properties: {} } },
  { name: 'turn_ended', description: 'Finish per-turn browser and computer cleanup.', inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, turn_id: { type: 'string' } } } },
  { name: 'load_workspace_dependencies', description: 'Return the local Node and Python runtime paths used by the artifact plugins.', inputSchema: { type: 'object', properties: {} } },
];

async function dispatch(message) {
  if (message.method === 'initialize') return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'codex-plus-plus-node-repl', version: '1.0.0' } };
  if (message.method === 'ping') return {};
  if (message.method === 'tools/list') return { tools };
  if (message.method !== 'tools/call') throw new Error(`Unknown MCP method: ${message.method}`);
  const { name, arguments: args = {}, _meta = {} } = message.params;
  let metadata = _meta['x-codex-turn-metadata'] ?? {};
  if (typeof metadata === 'string') { try { metadata = JSON.parse(metadata); } catch { metadata = {}; } }
  const sessionId = metadata.session_id ?? args.session_id ?? processSession;
  if (name === 'js_reset') {
    await kernels.get(sessionId)?.worker.terminate();
    kernels.delete(sessionId);
    return { content: [{ type: 'text', text: 'JavaScript session reset.' }] };
  }
  if (name === 'load_workspace_dependencies') return { content: [{ type: 'text', text: JSON.stringify({
    node: process.execPath, python: process.env.PYTHON ?? 'python', nodeModules: process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ?? fileURLToPath(new URL('../node_modules', import.meta.url)),
    CODEX_HOME: process.env.CODEX_HOME, libreOffice: process.env.CODEX_LIBREOFFICE_PATH ?? null,
    bin: process.env.RUNTIME_BIN_DIR ?? null,
    artifactBackend: process.env.CODEX_LOCAL_OFFICE_RENDERER ? 'Native Python libraries and LibreOffice/PDFium' : '@oai/artifact-tool and native Python libraries',
    environment: Object.fromEntries(['PYTHONUTF8', 'PYTHONPATH', 'CODEX_LOCAL_PDFIUM', 'CODEX_LOCAL_OFFICE_RENDERER', 'RUNTIME_NODE', 'RUNTIME_BIN_DIR', 'CODEX_LIBREOFFICE_PATH', 'CODEX_PRIMARY_RUNTIME_NODE_MODULES', 'CODEX_HOME'].filter(key => process.env[key]).map(key => [key, process.env[key]])),
  }) }] };
  if (name !== 'js' && name !== 'turn_ended') throw new Error(`Unknown tool: ${name}`);
  if (name === 'js' && (typeof args.code !== 'string' || args.code.length > 2_000_000)) throw new Error('code must be a string under 2 MB');
  const kernel = kernelFor(sessionId);
  if (kernel.pending.size) throw new Error('JavaScript session is busy; wait for completion or call js_reset');
  const id = ++kernel.sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      kernel.pending.delete(id);
      kernel.worker.terminate();
      reject(new Error('JavaScript timed out; kernel was stopped and must be reinitialized'));
    }, Math.min(Math.max(args.timeout_ms ?? 120000, 1000), 600000));
    kernel.pending.set(id, { resolve, reject, timer });
    kernel.worker.postMessage({ id, type: name, code: args.code, metadata: { ...metadata, session_id: sessionId, turn_id: metadata.turn_id ?? args.turn_id ?? randomUUID() } });
  });
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  void (async () => {
    let message;
    try {
      message = JSON.parse(line);
      if (message.id === undefined) return;
      const result = await dispatch(message);
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
    } catch (error) {
      if (message?.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id,
        ...(message.method === 'tools/call' ? { result: { isError: true, content: [{ type: 'text', text: error.message }] } } : { error: { code: -32603, message: error.message } }) })}\n`);
    }
  })();
});
lines.on('close', async () => { for (const kernel of kernels.values()) await kernel.worker.terminate(); });
