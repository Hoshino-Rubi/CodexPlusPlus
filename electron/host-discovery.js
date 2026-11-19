'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');

const PROBE_TIMEOUT_MS = 3000;
const MAX_PROBE_BYTES = 256 * 1024;

function capabilityError(message) {
  const error = new Error(message);
  error.code = 'HOST_CAPABILITY_UNAVAILABLE';
  return error;
}

async function isFile(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) return false;
  try { return (await fs.stat(filename)).isFile(); } catch { return false; }
}

async function firstFile(candidates) {
  for (const candidate of new Set(candidates.filter(Boolean))) if (await isFile(candidate)) return candidate;
  return null;
}

function searchPath(name) {
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory.replace(/^"|"$/gu, ''), name));
}

function probe(executable, args) {
  return new Promise(resolve => {
    execFile(executable, args, {
      shell: false, windowsHide: true, timeout: PROBE_TIMEOUT_MS,
      maxBuffer: MAX_PROBE_BYTES, encoding: 'buffer',
    }, (error, stdout) => resolve(error ? null : stdout));
  });
}

function decodeWindowsOutput(buffer) {
  if (!Buffer.isBuffer(buffer)) return '';
  const utf16 = buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || buffer.subarray(0, 128).includes(0));
  return buffer.toString(utf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/u, '');
}

async function gitInstallRoots(systemDirectory) {
  const commands = [
    probe(path.join(systemDirectory, 'reg.exe'), ['query', 'HKLM\\SOFTWARE\\GitForWindows', '/v', 'InstallPath', '/reg:64']),
    probe(path.join(systemDirectory, 'reg.exe'), ['query', 'HKLM\\SOFTWARE\\GitForWindows', '/v', 'InstallPath', '/reg:32']),
    probe(path.join(systemDirectory, 'where.exe'), ['git.exe']),
  ];
  const results = await Promise.allSettled(commands);
  const roots = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status !== 'fulfilled' || result.value === null) continue;
    const contents = decodeWindowsOutput(result.value);
    if (index < 2) {
      const install = contents.match(/\bInstallPath\s+REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/iu)?.[1]?.trim();
      if (install && path.isAbsolute(install) && !install.includes('%')) roots.push(install);
    } else {
      for (const filename of contents.split(/\r?\n/u).map(value => value.trim()).filter(Boolean)) {
        if (!path.isAbsolute(filename) || path.basename(filename).toLowerCase() !== 'git.exe') continue;
        roots.push(path.dirname(filename), path.dirname(path.dirname(filename)));
      }
    }
  }
  return roots;
}

async function windowsDiscovery() {
  const windowsRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const systemDirectory = path.join(windowsRoot, 'System32');
  const programRoots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  const localPrograms = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : path.join(os.homedir(), 'AppData', 'Local', 'Programs');
  const roots = await gitInstallRoots(systemDirectory);
  roots.push(...programRoots.map(directory => path.join(directory, 'Git')), path.join(localPrograms, 'Git'));
  const shells = [];
  const powershell = await firstFile([
    ...programRoots.map(directory => path.join(directory, 'PowerShell', '7', 'pwsh.exe')),
    ...searchPath('pwsh.exe'), path.join(systemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ...searchPath('powershell.exe'),
  ]);
  if (powershell) shells.push({ id: 'powershell', executable: powershell, args: [] });
  const commandPrompt = await firstFile([process.env.COMSPEC, path.join(systemDirectory, 'cmd.exe')]);
  if (commandPrompt) shells.push({ id: 'commandPrompt', executable: commandPrompt, args: [] });
  const gitBash = await firstFile([
    ...roots.map(directory => path.join(directory, 'bin', 'bash.exe')),
    ...roots.map(directory => path.join(directory, 'usr', 'bin', 'bash.exe')),
    ...searchPath('git-bash.exe'), ...roots.map(directory => path.join(directory, 'git-bash.exe')),
  ]);
  if (gitBash) shells.push({ id: 'gitBash', executable: gitBash, args: path.basename(gitBash).toLowerCase() === 'bash.exe' ? ['--login', '-i'] : [] });
  const wsl = await firstFile([path.join(systemDirectory, 'wsl.exe'), ...searchPath('wsl.exe')]);
  let wslDistributions = [];
  if (wsl) {
    const output = decodeWindowsOutput(await probe(wsl, ['-l', '-q']));
    wslDistributions = [...new Set(output.split(/\r?\n/u).map(value => value.trim()).filter(value => value && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)))];
    if (wslDistributions.length) shells.push({ id: 'wsl', executable: wsl, args: [] });
  }
  const editors = [];
  const definitions = [
    { id: 'vscode', label: 'VS Code', install: 'Microsoft VS Code', executable: 'Code.exe', command: 'code.cmd' },
    { id: 'cursor', label: 'Cursor', install: 'Cursor', executable: 'Cursor.exe', command: 'cursor.cmd' },
    { id: 'windsurf', label: 'Windsurf', install: 'Windsurf', executable: 'Windsurf.exe', command: 'windsurf.cmd' },
  ];
  for (const definition of definitions) {
    const executable = await firstFile([
      path.join(localPrograms, definition.install, definition.executable),
      ...programRoots.map(directory => path.join(directory, definition.install, definition.executable)),
      ...searchPath(definition.executable),
      ...searchPath(definition.command).map(filename => path.join(path.dirname(filename), '..', definition.executable)),
    ]);
    if (executable) editors.push({ id: definition.id, label: definition.label, executable });
  }
  const explorer = await firstFile([path.join(windowsRoot, 'explorer.exe'), ...searchPath('explorer.exe')]);
  if (explorer) editors.push({ id: 'fileManager', label: 'File Explorer', executable: explorer });
  return { shells, editors, wslDistributions };
}

class HostDiscovery {
  constructor({ codexHome, shell }) {
    this.codexHome = codexHome;
    this.shell = shell;
    this.cached = null;
    this.cachedAt = 0;
  }

  discover() {
    if (!this.cached || Date.now() - this.cachedAt > 30000) {
      this.cachedAt = Date.now();
      this.cached = (async () => ({
        platform: process.platform, osRelease: os.release(), osVersion: os.version(),
        homeDirectory: os.homedir(), codexHome: this.codexHome,
        // A workspace is chosen explicitly by the renderer; there is no fabricated default directory.
        workspacesRoot: null, worktreesSegment: path.join(this.codexHome, 'worktrees'),
        ...(process.platform === 'win32' ? await windowsDiscovery() : { shells: [], editors: [], wslDistributions: [] }),
      }))().catch(error => { this.cached = null; throw error; });
    }
    return this.cached;
  }

  async openTarget(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw capabilityError('打开目标需要对象参数');
    const { target, path: filename, line, column } = request;
    if (typeof target !== 'string' || typeof filename !== 'string' || !path.isAbsolute(filename) || /[\u0000-\u001f\u007f]/u.test(filename)) throw capabilityError('打开目标需要已知目标及完整本地路径');
    for (const value of [line, column]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 1000000000)) throw capabilityError('行列位置必须是正整数');
    const metadata = await fs.stat(filename);
    if (!metadata.isFile() && !metadata.isDirectory()) throw capabilityError('只支持打开普通文件或目录');
    if (target === 'systemDefault') {
      const message = await this.shell.openPath(filename);
      if (message) throw capabilityError(message);
      return;
    }
    const info = await this.discover();
    const editor = info.editors.find(entry => entry.id === target);
    if (!editor || !await isFile(editor.executable)) throw capabilityError(`打开目标不可用：${target}`);
    if (target === 'fileManager') {
      if (metadata.isFile()) this.shell.showItemInFolder(filename);
      else {
        const message = await this.shell.openPath(filename);
        if (message) throw capabilityError(message);
      }
      return;
    }
    const args = metadata.isFile() && line !== undefined
      ? ['--reuse-window', '--goto', `${filename}:${line}:${column ?? 1}`]
      : ['--reuse-window', '--', filename];
    // Desktop editors keep their process alive; acknowledge the native spawn, not an artificial process exit.
    await new Promise((resolve, reject) => {
      const child = spawn(editor.executable, args, { shell: false, detached: true, stdio: 'ignore', windowsHide: false });
      const timer = setTimeout(() => { child.kill(); reject(capabilityError('编辑器启动超时')); }, PROBE_TIMEOUT_MS);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('spawn', () => { clearTimeout(timer); child.unref(); resolve(); });
    });
  }
}

module.exports = { HostDiscovery };
