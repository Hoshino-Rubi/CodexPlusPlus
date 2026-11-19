'use strict';

const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, protocol, session, shell } = require('electron');
const fs = require('node:fs/promises');
const { mkdirSync } = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { ConfigStore } = require('./config-store');
const { AppServer, rpcError } = require('./app-server');
const { PreferencesStore } = require('./preferences-store');
const { HostDiscovery } = require('./host-discovery');
const { runtimeDebug } = require('./runtime-debug');
const { LocalRuntime } = require('./local-runtime');
const { resourcePaths } = require('./resource-paths');

// An explicit isolated profile is useful for portable deployments and cold-start QA.
const userDataOverride = app.commandLine.getSwitchValue('user-data-dir');
if (userDataOverride) {
  if (!path.isAbsolute(userDataOverride)) throw new Error('--user-data-dir must be absolute');
  mkdirSync(userDataOverride, { recursive: true });
  app.setPath('userData', userDataOverride);
}
process.env.CODEX_LOG_DIR = path.join(app.getPath('userData'), 'logs');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'codex-asset', privileges: { standard: true, secure: true } },
]);

process.on('uncaughtExceptionMonitor', error => runtimeDebug('MAIN_FATAL', error));
process.on('unhandledRejection', error => runtimeDebug('MAIN_REJECTION', error));

function internalProtocol(value) {
  try { return ['devtools:', 'chrome-devtools:', 'data:', 'blob:'].includes(new URL(value).protocol); }
  catch { return false; }
}

const { root, frontend: frontendRoot } = resourcePaths();
const indexPath = path.join(frontendRoot, 'index.html');
const indexUrl = 'app://workspace/index.html';
const frontendMime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
};
const MAX_IPC_BYTES = 32 * 1024 * 1024;
let window = null;
let backend = null;
let store = null;
let preferences = null;
let hostDiscovery = null;
let localRuntime = null;
let quitting = false;
let methods = new Set();
const providerModelRequests = new Map();
const localImageGrants = new Map();
const localImageUrls = new Map();
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif' };
const primaryInstance = app.requestSingleInstanceLock();

if (!primaryInstance) app.quit();
app.on('second-instance', () => {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
});

function trustedSender(event) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw rpcError('UNTRUSTED_SENDER', '仅主工作区可调用桌面接口');
  }
  try {
    const url = new URL(event.senderFrame.url);
    url.hash = '';
    url.search = '';
    if (url.href !== indexUrl) throw new Error('origin');
  } catch { throw rpcError('UNTRUSTED_SENDER', '桌面接口拒绝非本地工作区请求'); }
}

function validatePayload(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw rpcError('INVALID_RPC', '桌面请求必须能序列化为 JSON'); }
  if (serialized && Buffer.byteLength(serialized, 'utf8') > MAX_IPC_BYTES) throw rpcError('RPC_TOO_LARGE', '桌面请求超过 32 MiB');
}

function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      trustedSender(event);
      if (quitting) throw rpcError('APP_QUITTING', '应用正在关闭');
      validatePayload(args);
      return { ok: true, value: await callback(...args) };
    } catch (error) {
      runtimeDebug(channel, error);
      return { ok: false, error: {
        code: typeof error.code === 'string' || typeof error.code === 'number' ? error.code : 'DESKTOP_ERROR',
        message: error.message || '桌面操作失败',
        ...(error.data === undefined ? {} : { data: error.data }),
      } };
    }
  });
}

function send(channel, value) {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, value);
}

function withinDirectory(directory, resource) {
  const relative = path.relative(directory, resource);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertLocalImagePath(resource) {
  // Never turn the image bridge into an SMB request or a profile-file reader.
  if (!path.isAbsolute(resource) || /^(?:\\\\|\/\/)/u.test(resource)
    || withinDirectory(path.join(app.getPath('home'), '.codex'), resource)) {
    throw rpcError('INVALID_IMAGE_PATH', '图片来源必须是本地截图文件，且不能位于 Codex 配置目录');
  }
}

function matchesImageSignature(bytes, mime) {
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/webp') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (mime === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6));
  if (mime === 'image/bmp') return bytes.toString('ascii', 0, 2) === 'BM';
  if (mime === 'image/x-icon') return bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]));
  if (mime === 'image/avif') return bytes.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/u.test(bytes.toString('ascii', 8, 32));
  return false;
}

async function readLocalImage(resource, includeBytes = false) {
  assertLocalImagePath(resource);
  const canonical = await fs.realpath(resource);
  assertLocalImagePath(canonical);
  const mime = IMAGE_MIME[path.extname(canonical).toLowerCase()];
  if (!mime) throw rpcError('INVALID_IMAGE_TYPE', '仅允许常见位图图片文件');
  const file = await fs.open(canonical, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 8 || stat.size > MAX_IPC_BYTES) throw rpcError('INVALID_IMAGE_SIZE', '图片文件必须小于 32 MiB');
    const header = Buffer.alloc(Math.min(32, stat.size));
    await file.read(header, 0, header.length, 0);
    if (!matchesImageSignature(header, mime)) throw rpcError('INVALID_IMAGE_TYPE', '图片扩展名与实际内容不符');
    if (!includeBytes) return { resource: canonical, mime };
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw rpcError('INVALID_IMAGE_SIZE', '图片文件读取不完整');
      offset += result.bytesRead;
    }
    return { resource: canonical, mime, bytes };
  } finally { await file.close(); }
}

async function resolveLocalImage(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 32768 || /[\u0000-\u001f\u007f]/u.test(input)) {
    throw rpcError('INVALID_IMAGE_PATH', '图片路径必须是有效文本');
  }
  let resource = input.trim();
  if (/^codex-asset:/iu.test(resource)) {
    const url = new URL(resource);
    const grant = localImageGrants.get(url.pathname.slice(1));
    if (url.hostname === 'local' && grant && !url.search && !url.hash) return url.href;
    if (url.username || url.password || url.port) throw rpcError('INVALID_IMAGE_PATH', '本地图片 URL 无效');
    resource = url.searchParams.get('path') ?? decodeURIComponent(url.pathname);
    if (/^[a-z]$/iu.test(url.hostname)) resource = `${url.hostname}:${resource}`;
    else if (url.hostname && !['local', 'localhost', 'fs'].includes(url.hostname)) throw rpcError('INVALID_IMAGE_PATH', '本地图片 URL 主机无效');
    resource = resource.replace(/^\/@fs\//u, '').replace(/^\/([a-z]:[\\/])/iu, '$1');
  } else if (/^file:/iu.test(resource)) {
    const url = new URL(resource);
    if (url.hostname && url.hostname !== 'localhost') throw rpcError('INVALID_IMAGE_PATH', '不支持网络共享图片');
    url.hash = ''; url.search = '';
    resource = fileURLToPath(url);
  } else if (!/^[a-z]:[\\/]/iu.test(resource) && /^[a-z][a-z0-9+.-]*:/iu.test(resource)) {
    throw rpcError('INVALID_IMAGE_PATH', '此接口仅解析本地图片');
  }
  if (!path.isAbsolute(resource)) {
    const snapshot = await preferences.read();
    const workspace = snapshot.applicationState['active-workspace-root'];
    resource = path.resolve(typeof workspace === 'string' && path.isAbsolute(workspace) ? workspace : root, resource);
  }
  const image = await readLocalImage(path.normalize(resource));
  const existing = localImageUrls.get(image.resource);
  if (existing) return existing;
  if (localImageGrants.size >= 10000) throw rpcError('IMAGE_LIMIT', '本次运行加载的本地图片过多');
  const id = randomUUID();
  const url = `codex-asset://local/${id}`;
  localImageGrants.set(id, image);
  localImageUrls.set(image.resource, url);
  return url;
}

async function fetchProviderModels(input) {
  const invalid = () => rpcError('INVALID_PROVIDER_CONFIG', '模型列表请求参数无效');
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || typeof input.providerId !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(input.providerId)
    || typeof input.baseUrl !== 'string' || input.baseUrl.length > 2048
    || /[\u0000-\u001f\u007f]/u.test(input.baseUrl)
    || (input.apiKey !== undefined && typeof input.apiKey !== 'string')) throw invalid();
  let url;
  try { url = new URL(input.baseUrl.trim()); } catch { throw invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw invalid();
  const cleanPath = url.pathname.replace(/\/+$/u, '');
  const paths = /\/models$/u.test(cleanPath) ? [cleanPath]
    : /\/(?:v1|openai)$/u.test(cleanPath) ? [`${cleanPath}/models`]
      : [`${cleanPath}/v1/models`, `${cleanPath}/models`];
  // ConfigStore owns only this application's isolated backend-home registry.
  await store.initialize();
  const provider = store.registry.providers.find((entry) => entry.id === input.providerId);
  const apiKey = input.apiKey?.trim() || provider?.apiKey || '';
  if (apiKey.length > 16384 || /[\u0000-\u001f\u007f]/u.test(apiKey)) throw invalid();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const failures = [];
  try {
    for (const pathname of paths) {
      url.pathname = pathname;
      const endpoint = url.href;
      providerModelRequests.set(endpoint, (providerModelRequests.get(endpoint) || 0) + 1);
      try {
        const response = await net.fetch(endpoint, {
          method: 'GET', redirect: 'error', signal: controller.signal,
          headers: { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`HTTP ${response.status}`);
        }
        const result = await response.json();
        const models = Array.isArray(result) ? result : result?.data ?? result?.models;
        if (!Array.isArray(models)) throw new Error('响应不包含 data/models 模型数组');
        const ids = new Set();
        for (const model of models) {
          const value = typeof model === 'string' ? model : model?.id;
          if (typeof value !== 'string') continue;
          const id = value.trim();
          if (id && id.length <= 256 && !/[\s\u0000-\u001f\u007f]/u.test(id)) ids.add(id);
        }
        return Array.from(ids, (id) => ({ id }));
      } catch (error) {
        const reason = [error.message, error.cause?.message].filter(Boolean).join(': ') || String(error);
        failures.push(`${pathname}: ${apiKey ? reason.split(apiKey).join('[redacted]') : reason}`);
        if (controller.signal.aborted) break;
      } finally {
        const remaining = providerModelRequests.get(endpoint) - 1;
        if (remaining > 0) providerModelRequests.set(endpoint, remaining);
        else providerModelRequests.delete(endpoint);
      }
    }
    throw rpcError('PROVIDER_MODELS_FAILED', controller.signal.aborted
      ? `获取模型列表超时（10 秒）${failures.length ? `：${failures.join('；')}` : ''}`
      : `获取模型列表失败：${failures.join('；')}`);
  } finally { clearTimeout(timeout); }
}

async function createLocalProject(input) {
  if (!input || typeof input !== 'object' || typeof input.name !== 'string'
    || (input.sources !== undefined && (!Array.isArray(input.sources) || input.sources.length > 64))) {
    throw rpcError('INVALID_PROJECT', '项目名称或来源目录无效');
  }
  let roots = input.sources || [];
  if (roots.length === 0) {
    const name = input.name.trim();
    if (!name || name.length > 128 || /[<>:"/\\|?*\u0000-\u001f]/u.test(name)
      || /[. ]$/u.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) {
      throw rpcError('INVALID_PROJECT', '请输入有效的项目目录名称');
    }
    const saved = await preferences.read();
    const parent = input.parentDir ?? saved.applicationState['active-workspace-root'] ?? path.join(app.getPath('documents'), 'Codex Projects');
    if (typeof parent !== 'string' || !path.isAbsolute(parent)) throw rpcError('INVALID_PROJECT', '项目父目录必须是绝对路径');
    roots = [path.join(parent, name)];
  }
  const rootPaths = [];
  for (const candidate of roots) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || /[\u0000-\u001f]/u.test(candidate)) {
      throw rpcError('INVALID_PROJECT', '项目来源必须是绝对目录路径');
    }
    mkdirSync(candidate, { recursive: true });
    if (!(await fs.stat(candidate)).isDirectory()) throw rpcError('INVALID_PROJECT', '项目路径不是目录');
    rootPaths.push(await fs.realpath(candidate));
  }
  return { rootPaths: [...new Set(rootPaths)] };
}

const execFileAsync = promisify(execFile);
async function localGit(directory, args, optional = false) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || /[\0\r\n]/u.test(directory)) throw rpcError('INVALID_GIT_PATH', 'Git 需要绝对目录');
  try {
    const result = await execFileAsync('git', ['-C', directory, ...args], {
      windowsHide: true, shell: false, timeout: 20000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    });
    return args[0] === 'status' ? result.stdout : result.stdout.trim();
  } catch (error) {
    if (optional && typeof error.code === 'number') return null;
    throw rpcError('GIT_FAILED', (error.stderr || error.message || 'Git operation failed').trim());
  }
}

async function gitRequest(method, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw rpcError('INVALID_GIT_REQUEST', 'Git 参数无效');
  if (input.hostConfig?.id && input.hostConfig.id !== 'local') throw rpcError('INVALID_GIT_HOST', '仅支持本地 Git');
  if (method === 'availability') {
    try {
      await execFileAsync('git', ['--version'], { windowsHide: true, shell: false, timeout: 5000 });
      return { available: true };
    } catch { return { available: false }; }
  }
  const directory = input.root ?? input.cwd ?? input.sourceWorkspaceRoot ?? input.worktree;
  if (['gh-cli-status', 'gh-current-user', 'gh-pr-list'].includes(method)) {
    const localDirectory = directory ?? path.resolve(__dirname, '..');
    const hostname = input.hostname ?? input.account?.hostname ?? 'github.com';
    if (typeof hostname !== 'string' || !/^[a-z0-9.-]+$/iu.test(hostname)) throw rpcError('INVALID_GITHUB_HOST', 'GitHub hostname is invalid');
    const gh = async (args, cwd = localDirectory) => (await execFileAsync('gh', args, {
      cwd, windowsHide: true, shell: false, timeout: 15000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GH_HOST: hostname, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
    })).stdout;
    if (method === 'gh-cli-status') {
      try { await gh(['--version']); } catch { return { isInstalled: false, isAuthenticated: false }; }
      try { await gh(['auth', 'status', '--active', '--hostname', hostname]); return { isInstalled: true, isAuthenticated: true }; }
      catch { return { isInstalled: true, isAuthenticated: false }; }
    }
    if (method === 'gh-current-user') {
      try {
        const login = (await gh(['api', 'user', '--jq', '.login'])).trim();
        if (!login) return { account: null };
        return { account: { hostId: 'local', hostname, login } };
      } catch { return { account: null }; }
    }
    // Repository absence, missing CLI and missing authentication are ordinary
    // empty states. They must never make the PR sidebar disappear.
    try {
      const repository = await localGit(localDirectory, ['rev-parse', '--show-toplevel'], true);
      if (!repository) return [];
      const output = await gh(['pr', 'list', '--state', 'open', '--limit', '100', '--json',
        'number,title,url,updatedAt,author,isDraft,reviewDecision,reviewRequests,state,headRefName,baseRefName'], repository);
      const entries = JSON.parse(output);
      return Array.isArray(entries) ? entries : [];
    } catch { return []; }
  }
  if (method === 'create-worktree') {
    const repository = await localGit(directory, ['rev-parse', '--show-toplevel']);
    const base = path.join(store.home, 'worktrees');
    await fs.mkdir(base, { recursive: true });
    const identity = randomUUID();
    const target = path.join(base, identity);
    const head = await localGit(repository, ['rev-parse', '--verify', 'HEAD'], true);
    // An unborn repository has no HEAD to detach; use a unique unborn branch without committing user files.
    await localGit(repository, head
      ? ['worktree', 'add', '--detach', target, 'HEAD']
      : ['worktree', 'add', '--orphan', '-b', `codex/worktree-${identity}`, target]);
    const relative = path.relative(repository, directory);
    const workspaceRoot = path.join(target, relative);
    try {
      if (!(await fs.stat(workspaceRoot)).isDirectory()) throw new Error('missing workspace');
    } catch {
      await localGit(repository, ['worktree', 'remove', target]);
      throw rpcError('GIT_WORKSPACE_MISSING', '工作树中不存在源项目子目录');
    }
    const snapshot = await preferences.read();
    for (const key of ['local-workspace-roots', 'electron-saved-workspace-roots']) {
      const previous = snapshot.applicationState[key];
      await preferences.write('applicationState', key, [...new Set([...(Array.isArray(previous) ? previous : []), workspaceRoot])]);
    }
    const managed = snapshot.applicationState['local-managed-worktrees'] ?? {};
    await preferences.write('applicationState', 'local-managed-worktrees', { ...managed, [target]: { repository, workspaceRoot, createdAt: Date.now(), ownerThreadId: null } });
    send('codex:preferences', await preferences.read());
    return { worktreePath: target, worktreeRoot: target, gitRoot: target, workspaceRoot, path: target, branch: null };
  }
  if (method === 'set-worktree-owner-thread') {
    const snapshot = await preferences.read();
    const managed = snapshot.applicationState['local-managed-worktrees'] ?? {};
    const target = path.resolve(directory);
    if (!Object.hasOwn(managed, target)) throw rpcError('UNKNOWN_WORKTREE', '工作树不属于本应用管理范围');
    await preferences.write('applicationState', 'local-managed-worktrees', { ...managed, [target]: { ...managed[target], ownerThreadId: input.conversationId ?? input.threadId } });
    send('codex:preferences', await preferences.read());
    return { success: true };
  }
  if (['cancel-worktree-upstream-refresh', 'unsubscribe-live-query', 'retain-repo-watch', 'release-repo-watch'].includes(method)) return {};
  if (method === 'codex-worktrees' || method === 'list-worktrees') {
    const snapshot = await preferences.read();
    const worktrees = Object.entries(snapshot.applicationState['local-managed-worktrees'] ?? {}).map(([worktreePath, data]) => ({ ...data, path: worktreePath, worktreePath }));
    return { worktrees };
  }
  const root = await localGit(directory, ['rev-parse', '--show-toplevel'], true);
  if (method === 'current-branch') return { branch: root ? await localGit(directory, ['symbolic-ref', '--short', 'HEAD'], true) : null };
  if (method === 'default-branch' || method === 'base-branch') {
    const ref = root ? await localGit(directory, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], true) : null;
    return { branch: ref?.replace(/^origin\//u, '') ?? (root ? await localGit(directory, ['symbolic-ref', '--short', 'HEAD'], true) : null) };
  }
  if (['recent-branches', 'search-branches', 'branch-metadata'].includes(method)) {
    const rows = root ? await localGit(directory, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads/']) : '';
    const branches = rows.split(/\r?\n/u).filter(Boolean);
    return { branches, currentBranch: root ? await localGit(directory, ['symbolic-ref', '--short', 'HEAD'], true) : null };
  }
  if (method === 'config-value') {
    if (typeof input.key !== 'string' || !/^[a-z][a-z0-9.-]+$/iu.test(input.key) || /credential|password|token|secret|http\./iu.test(input.key)) return { value: null };
    return { value: root ? await localGit(directory, ['config', '--local', '--get', input.key], true) : null };
  }
  if (method === 'git-context') return { status: root ? 'complete' : 'not-a-repository', capturedAt: new Date().toISOString(), root, branch: root ? await localGit(directory, ['symbolic-ref', '--short', 'HEAD'], true) : null, remotes: [], remotesOmitted: 0, upstream: null };
  if (method === 'resolve-worktree-for-thread' || method === 'managed-worktree-state') return { worktree: null };
  if (method === 'status-summary') {
    const status = root ? await localGit(directory, ['status', '--porcelain=v1', '-z']) : '';
    const files = [];
    const records = (status ?? '').split('\0');
    for (let index = 0; index < records.length; index++) {
      const line = records[index];
      if (!line) continue;
      const file = { path: line.slice(3), indexStatus: line[0], workingTreeStatus: line[1], status: line.slice(0, 2) };
      if (/[RC]/u.test(file.status) && records[index + 1]) file.originalPath = records[++index];
      files.push(file);
    }
    return { isGitRepository: root !== null, branch: root ? await localGit(directory, ['symbolic-ref', '--short', 'HEAD'], true) : null,
      files, staged: files.filter(file => file.indexStatus !== ' ' && file.indexStatus !== '?'),
      unstaged: files.filter(file => file.workingTreeStatus !== ' ' && file.workingTreeStatus !== '?'), untracked: files.filter(file => file.status === '??') };
  }
  throw rpcError('UNSUPPORTED_GIT_OPERATION', `尚未接通 Git 操作：${method}`);
}

function registerIpc() {
  handle('codex:image:resolve-local', resolveLocalImage);
  handle('codex:image:read-local', async input => {
    const url = new URL(await resolveLocalImage(input));
    const grant = localImageGrants.get(url.pathname.slice(1));
    const image = await readLocalImage(grant.resource, true);
    return { contentsBase64: image.bytes.toString('base64'), mimeType: image.mime };
  });
  handle('codex:browser:state', () => localRuntime.browser.getState());
  handle('codex:browser:view', (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.visible !== 'boolean') {
      throw rpcError('INVALID_BROWSER_VIEW', 'Browser view state requires a visibility flag');
    }
    if (input.bounds && !['x', 'y', 'width', 'height'].every(key => Number.isFinite(input.bounds[key]))) {
      throw rpcError('INVALID_BROWSER_VIEW', 'Browser view bounds must be finite numbers');
    }
    return localRuntime.browser.setViewState(input);
  });
  handle('codex:browser:command', (method, params = {}) => {
    if (!['newTab', 'switchTab', 'closeTab', 'goBack', 'goForward', 'reload', 'navigate'].includes(method)
      || !params || typeof params !== 'object' || Array.isArray(params)) {
      throw rpcError('INVALID_BROWSER_COMMAND', 'Unsupported browser panel command');
    }
    const browser = localRuntime.browser;
    const current = browser.getState();
    const id = params.tabId ?? current.activeTabId;
    const tab = id == null ? undefined : browser.tabs.get(Number(id));
    if (method === 'navigate') {
      if (!tab || typeof params.url !== 'string') throw rpcError('INVALID_BROWSER_COMMAND', 'Navigation requires a tab and URL');
      const url = new URL(params.url);
      if (!['https:', 'http:', 'about:'].includes(url.protocol) || (url.protocol === 'about:' && url.href !== 'about:blank')) {
        throw rpcError('INVALID_BROWSER_COMMAND', 'Unsupported browser navigation scheme');
      }
      return browser.dispatch('executeCdp', { tabId: id, session_id: tab.owner, method: 'Page.navigate', commandParams: { url: url.href } });
    }
    return browser.dispatch(method, { ...params, ...(id == null ? {} : { tabId: id }),
      session_id: tab?.owner ?? params.sessionId ?? 'local-browser-panel' });
  });
  handle('codex:clipboard:write', text => {
    if (typeof text !== 'string') throw rpcError('INVALID_CLIPBOARD', 'Clipboard text must be a string');
    clipboard.writeText(text);
  });
  handle('codex:clipboard:read', () => clipboard.readText());
  handle('codex:git:request', gitRequest);
  handle('codex:request', async (method, params) => {
    if (typeof method !== 'string' || !methods.has(method)) throw rpcError('INVALID_METHOD', '未知的 app-server 请求方法');
    if (method === 'initialize') throw rpcError('INVALID_METHOD', '后端初始化由桌面主进程管理');
    if (/^account\/(?:login\/|logout$|gatewayOAuth\/|bedrock\/)/u.test(method)) {
      throw rpcError('BYOK_ONLY', '本应用使用本地 BYOK 配置；请在 Provider 设置中管理 API Key');
    }
    return backend.request(method, params);
  });
  handle('codex:respond', (id, result, error) => backend.respond(id, result, error));
  handle('codex:status:get', () => backend.getStatus());
  handle('codex:session:get', () => store.getSession());
  handle('codex:preferences:read', () => preferences.read());
  handle('codex:preferences:write', async (scope, key, value) => {
    const snapshot = await preferences.write(scope, key, value);
    send('codex:preferences', snapshot);
    return snapshot;
  });
  handle('codex:host:discover', () => hostDiscovery.discover());
  handle('codex:host:open-target', (request) => hostDiscovery.openTarget(request));
  handle('codex:providers:read', () => store.readProviders());
  handle('codex:providers:fetchModels', (input) => fetchProviderModels(input));
  // New/resumed threads read the persisted provider tables. Existing sessions keep
  // their effective configuration and must survive changes made in other tabs.
  handle('codex:providers:write', (registry) => store.writeProviders(registry));
  handle('codex:model:select', (providerId, model) => {
    if (typeof providerId !== 'string' || typeof model !== 'string') throw rpcError('INVALID_PROVIDER_CONFIG', 'Provider 与模型 ID 必须是文本');
    return store.selectModel(providerId, model);
  });
  handle('codex:workspace:choose', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择工作区', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    return fs.realpath(result.filePaths[0]);
  });
  handle('codex:projects:create-local', (input) => createLocalProject(input));
}

async function hardenSession() {
  const realFrontendRoot = await fs.realpath(frontendRoot);
  protocol.handle('codex-asset', async request => {
    try {
      const url = new URL(request.url);
      const grant = localImageGrants.get(url.pathname.slice(1));
      if (request.method !== 'GET' || url.hostname !== 'local' || url.search || url.hash || !grant) return new Response(null, { status: 403 });
      const image = await readLocalImage(grant.resource, true);
      return new Response(image.bytes, { headers: { 'content-type': image.mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" } });
    } catch { return new Response(null, { status: 404 }); }
  });
  protocol.handle('app', async request => {
    try {
      const url = new URL(request.url);
      if (url.hostname === 'workspace') {
        if (request.method !== 'GET' || url.host !== 'workspace' || url.username || url.password) return new Response(null, { status: 403 });
        const pathname = decodeURIComponent(url.pathname);
        if (/[\\:\0]/u.test(pathname)) return new Response(null, { status: 403 });
        const resource = await fs.realpath(path.resolve(realFrontendRoot, `.${pathname}`));
        const relative = path.relative(realFrontendRoot, resource);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return new Response(null, { status: 403 });
        return new Response(await fs.readFile(resource), { headers: {
          'content-type': frontendMime[path.extname(resource).toLowerCase()] ?? 'application/octet-stream',
          'x-content-type-options': 'nosniff',
        } });
      }
      if (request.method !== 'GET' || url.hostname !== 'fs' || !url.pathname.startsWith('/@fs/')) return new Response(null, { status: 403 });
      const resource = await fs.realpath(decodeURIComponent(url.pathname.slice('/@fs/'.length)));
      const pluginRoot = await fs.realpath(path.join(store.home, 'plugins'));
      const relative = path.relative(pluginRoot, resource);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return new Response(null, { status: 403 });
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon' }[path.extname(resource).toLowerCase()];
      if (!mime) return new Response(null, { status: 403 });
      return new Response(await fs.readFile(resource), { headers: { 'content-type': mime, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' } });
    } catch { return new Response(null, { status: 404 }); }
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on('will-download', (event) => event.preventDefault());
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {
      const url = new URL(details.url);
      if (url.protocol === 'file:') {
        const resource = fileURLToPath(url);
        const relative = path.relative(frontendRoot, resource);
        allowed = !relative.startsWith('..') && !path.isAbsolute(relative);
        if (!allowed && details.resourceType === 'image' && store) {
          const pluginRelative = path.relative(path.join(store.home, 'plugins'), resource);
          allowed = !pluginRelative.startsWith('..') && !path.isAbsolute(pluginRelative)
            && /\.(?:png|jpe?g|svg|webp|gif|ico)$/iu.test(resource);
        }
      } else if (url.protocol === 'codex-asset:') allowed = url.hostname === 'local' && details.resourceType === 'image'
        && details.webContentsId === window?.webContents.id && localImageGrants.has(url.pathname.slice(1));
      else if (url.protocol === 'app:') allowed = url.host === 'workspace'
        || (url.hostname === 'fs' && details.resourceType === 'image');
      else allowed = (url.protocol === 'https:' && details.resourceType === 'image') || internalProtocol(details.url)
        || (providerModelRequests.has(url.href) && !(details.webContentsId > 0));
    } catch { allowed = false; }
    callback({ cancel: !allowed });
  });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => internalProtocol(details.url) ? callback({}) : callback({
    responseHeaders: {
      ...details.responseHeaders,
      'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: file: https: app://fs codex-asset:; font-src 'self' data:; connect-src 'self' file: data: blob:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"],
    },
  }));
}

async function createWindow() {
  await fs.access(indexPath);
  window = new BrowserWindow({
    title: 'Codex++', width: 1440, height: 960, minWidth: 960, minHeight: 640,
    icon: path.join(__dirname, 'assets', 'codex.png'),
    backgroundColor: '#202020', show: false, autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  window.setMenu(null);
  window.setMenuBarVisibility(false);
  // The workspace and its managed browser never create a second BrowserWindow.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!internalProtocol(url)) event.preventDefault(); });
  window.webContents.on('will-redirect', (event, url) => { if (!internalProtocol(url)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('console-message', (event) => {
    const { level, message, lineNumber, sourceId } = event;
    const entry = { level, message, lineNumber, sourceId };
    if (entry.level === 'warning' || entry.level === 'error' || entry.level >= 2) runtimeDebug('RENDERER_CONSOLE', entry);
  });
  window.webContents.on('did-fail-load', (_event, code, description, url) => runtimeDebug('LOAD_FAILURE', { code, description, url }));
  window.webContents.on('render-process-gone', (_event, details) => { runtimeDebug('RENDERER_GONE', details); backend.stop().catch(() => {}); });
  window.once('ready-to-show', () => { if (window && !window.isDestroyed()) window.show(); });
  localRuntime.browser.attachWindow(window, {
    onState: (state) => send('codex:browser:state', state),
    onCursor: (cursor) => send('codex:browser:cursor', cursor),
  });
  window.on('closed', () => { window = null; });
  // The recovered renderer validates same-document postMessage origins. A file:
  // document serializes event.origin as "null", which drops app-server replies.
  await window.loadURL(`${indexUrl}#/`);
}

if (primaryInstance) app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  // Never load another installed Codex profile or its authentication storage.
  store = new ConfigStore(app.getPath('userData'));
  localRuntime = new LocalRuntime();
  store.runtimeEnvironment = await localRuntime.start();
  preferences = new PreferencesStore(app.getPath('userData'), () => app.getLocale());
  hostDiscovery = new HostDiscovery({ codexHome: store.home, shell });
  backend = new AppServer({ store, root, version: app.getVersion(), preferences });
  backend.on('rpc-error', error => runtimeDebug('BACKEND_RPC', error));
  backend.on('event', (event) => send('codex:event', event));
  backend.on('status', (status) => { if (status.state === 'error') runtimeDebug('BACKEND_STATUS', status); send('codex:status', status); });
  const schema = await fs.readFile(path.join(root, 'protocol_schema', 'typescript', 'ClientRequest.ts'), 'utf8');
  methods = new Set(Array.from(schema.matchAll(/"method":\s*"([^"]+)"/gu), (match) => match[1]));
  if (!methods.size) throw new Error('无法读取 app-server 方法契约');
  registerIpc();
  await hardenSession();
  await createWindow();
  backend.start().catch(() => {});
  app.on('activate', () => { if (!window) createWindow().catch((error) => dialog.showErrorBox('Codex++', error.message)); });
}).catch((error) => {
  dialog.showErrorBox('Codex++ 启动失败', error.code === 'ENOENT' ? '缺少前端构建或协议文件。请先构建前端，再启动桌面应用。' : error.message);
  app.quit();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  Promise.allSettled([backend?.stop(), preferences?.flush(), localRuntime?.stop()]).finally(() => app.quit());
});
