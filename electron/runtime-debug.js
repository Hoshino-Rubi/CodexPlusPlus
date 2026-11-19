'use strict';

const fs = require('node:fs');
const path = require('node:path');

function runtimeDebug(source, value) {
  // Detailed traces may contain conversation or endpoint data; opt in explicitly.
  if (process.env.CODEX_DEBUG_HOST !== '1') return;
  const raw = value instanceof Error ? value.stack || value.message : typeof value === 'string' ? value : JSON.stringify(value);
  const safe = String(raw).replace(/Bearer\s+[^\s"'<>]+/giu, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization|cookie|set-cookie|experimental_bearer_token)["']?\s*[:=]\s*["']?)[^\r\n,"'}]+/giu, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+/gu, '[REDACTED]');
  const line = `${new Date().toISOString()} [${source}] ${safe}\n`;
  if (process.env.CODEX_LOG_DIR) {
    const logPath = path.join(process.env.CODEX_LOG_DIR, 'runtime-debug.log');
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      if (fs.existsSync(logPath) && fs.statSync(logPath).size > 2 * 1024 * 1024) fs.renameSync(logPath, `${logPath}.old`);
      fs.appendFileSync(logPath, line, { mode: 0o600 });
    } catch {}
  }
  process.stderr.write(line);
}

module.exports = { runtimeDebug };
