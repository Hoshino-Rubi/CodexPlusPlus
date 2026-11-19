'use strict';

const { desktopCapturer } = require('electron');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { resourcePaths } = require('./resource-paths');

class ComputerHost {
  constructor() { this.observations = new Map(); }

  native(method, params) {
    return new Promise((resolve, reject) => {
      const child = execFile(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
        ['-NoProfile', '-NonInteractive', '-File', path.join(resourcePaths().runtime, 'windows-host.ps1')],
        { windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
        (error, stdout, stderr) => {
          if (error) { reject(new Error(`Windows host failed: ${stderr.trim() || error.message}`)); return; }
          try { const value = JSON.parse(stdout.trim()); if (value.error) reject(new Error(value.error)); else resolve(value.result); }
          catch { reject(new Error('Windows host returned an invalid response')); }
        });
      child.stdin.end(JSON.stringify({ method, params }));
    });
  }

  async dispatch(method, params = {}) {
    if (process.platform !== 'win32') throw new Error('Computer Use is available only on Windows');
    if (['list_windows', 'list_apps', 'get_window', 'launch_app'].includes(method)) return this.native(method, params);
    const window = await this.native('get_window', params.window ?? {});
    const observation = this.observations.get(window.id);
    if (params.screenshotId && observation?.screenshotId !== params.screenshotId) throw new Error('Screenshot is stale; observe the window again');
    if (params.element_index !== undefined && !observation?.hasText) throw new Error('Accessibility observation is missing; observe the window again');
    if (method !== 'get_window_state') {
      this.observations.delete(window.id);
      return this.native(method, { ...params, window });
    }
    let accessibility = null;
    if (params.include_text) accessibility = await this.native('accessibility', { window });
    const screenshots = [];
    let screenshotId;
    if (params.include_screenshot !== false) {
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1920, height: 1080 }, fetchWindowIcons: false });
      const source = sources.find(item => item.id.split(':')[1] === String(window.id));
      if (!source || source.thumbnail.isEmpty()) throw new Error('Selected window could not be captured');
      screenshotId = randomUUID();
      const size = source.thumbnail.getSize();
      screenshots.push({ id: screenshotId, url: source.thumbnail.toDataURL(), width: size.width, height: size.height, zIndex: 0 });
    }
    this.observations.set(window.id, { screenshotId, hasText: Boolean(accessibility) });
    return { window, accessibility, screenshots };
  }
}
module.exports = { ComputerHost };
