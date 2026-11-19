// Native Windows rendering adapter; the original proprietary renderer is retained.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
if (!process.env.CODEX_LOCAL_OFFICE_RENDERER) {
  await import('./render_presentation.upstream.mjs');
} else {
  const result = await promisify(execFile)(process.env.PYTHON ?? 'python',
    [process.env.CODEX_LOCAL_OFFICE_RENDERER, ...process.argv.slice(2)],
    { windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  process.stdout.write(result.stdout);
}
