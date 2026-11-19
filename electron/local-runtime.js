'use strict';

const http = require('node:http');
const { dialog } = require('electron');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { BrowserHost, LOCAL_METHODS } = require('./browser-host');
const { ComputerHost } = require('./computer-host');
const { resourcePaths } = require('./resource-paths');

class LocalRuntime {
  constructor() {
    this.browser = new BrowserHost();
    this.computer = new ComputerHost();
    this.token = randomBytes(32).toString('hex');
  }
  async start() {
    await this.browser.start();
    this.server = http.createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      const expected = Buffer.from(`Bearer ${this.token}`);
      const actual = Buffer.from(request.headers.authorization ?? '');
      if (request.method !== 'POST' || request.url !== '/' || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        response.writeHead(403).end(JSON.stringify({ error: 'Local host authentication required' })); return;
      }
      try {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of request) { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) throw new Error('Local host request exceeds 32 MiB'); chunks.push(chunk); }
        const { service, method, params } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = await this.dispatch(service, { method, params });
        response.end(JSON.stringify({ result: result ?? null }));
      } catch (error) { response.writeHead(400).end(JSON.stringify({ error: error.message })); }
    });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    return {
      CODEX_LOCAL_HOST_URL: `http://127.0.0.1:${this.server.address().port}/`,
      CODEX_LOCAL_HOST_TOKEN: this.token,
      BROWSER_USE_AVAILABLE_BACKENDS: 'iab',
      BROWSER_USE_BACKEND_PATHS: this.browser.pipe,
      NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ browser: require('node:path').join(resourcePaths().plugins, 'openai-bundled/plugins/browser/scripts/browser-service.mjs') }),
      NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: '5000',
    };
  }
  async dispatch(service, request) {
    if (service === 'browser' && LOCAL_METHODS.has(request.method)) {
      if (typeof request.params?.session_id !== 'string' || !request.params.session_id) throw new Error('Browser session metadata is required');
      return this.browser.dispatch(request.method, request.params);
    }
    if (service === 'computer') return this.computer.dispatch(request.method, request.params);
    if (service === 'approval' && request.method === 'browser') {
      const input = request.params ?? {};
      if (input.meta?.codex_requires_user_input === true) {
        // Authentication/OTP flows require an actual human response, not an
        // inferred approval. Preserve the existing explicit confirmation path.
        const answer = await dialog.showMessageBox({ type: 'question', title: 'Codex++ Browser',
          message: String(input.message ?? 'Allow this browser operation?'), buttons: ['Cancel', 'Allow once'], defaultId: 0, cancelId: 0 });
        return { action: answer.response === 1 ? 'accept' : 'cancel', content: {} };
      }
      // This route is exclusively the bearer-authenticated bundled browser
      // service, not a general app-server approval or MCP elicitation handler.
      // The user already authorized in-app browser automation. Do not add a
      // second origin/upload/CDP confirmation on top of that authorization.
      // BrowserHost still enforces its network policy and native permissions.
      return { action: 'accept', content: {}, _meta: { source: 'authorized-in-app-browser' } };
    }
    throw new Error(`Unknown local runtime service: ${service}`);
  }
  async stop() {
    await this.browser.stop();
    if (this.server) { this.server.closeAllConnections(); await new Promise(resolve => this.server.close(resolve)); }
  }
}
module.exports = { LocalRuntime };
