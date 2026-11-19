'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { sanitizeMcpConfig } = require('./config-store');
const { modelMetadata } = require('./model-catalog');
const { resourcePaths } = require('./resource-paths');

const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;
const MAX_PENDING = 256;
const REQUEST_TIMEOUT = 120_000;
const SERVER_REQUEST_TIMEOUT = 10 * 60_000;

function rpcError(code, message, data) {
  const error = new Error(message);
  error.code = code;
  if (data !== undefined) error.data = data;
  return error;
}

function validId(id) {
  return (typeof id === 'string' && id.length > 0 && id.length <= 256) || (typeof id === 'number' && Number.isSafeInteger(id));
}

function idKey(id) { return `${typeof id}:${id}`; }

class AppServer extends EventEmitter {
  constructor({ store, root, version, preferences }) {
    super();
    this.store = store;
    this.root = root;
    this.version = version;
    this.preferences = preferences;
    this.threadSnapshots = new Map();
    this.skillMetadata = new Map();
    this.submittedMentions = new Map();
    this.localStartedThreads = new Set();
    this.archiveQueue = Promise.resolve();
    this.curatedChanges = new Set();
    this.child = null;
    this.status = { state: 'stopped' };
    this.startPromise = null;
    this.stopPromise = null;
    this.stopping = false;
    this.sequence = 0;
    this.pending = new Map();
    this.serverRequests = new Map();
    this.activeTurns = new Set();
    this.completedTurns = new Set();
    this.ephemeralRoutes = new Map();
    this.ephemeralForks = new Map();
    this.ephemeralConfigurations = new Map();
    this.ephemeralStartedTurns = new Set();
    this.ephemeralPublicIds = new Map();
    this.retiredEphemeralIds = new Set();
    this.ephemeralRouteQueue = Promise.resolve();
    this.heldThreadStarts = null;
    this.output = '';
    this.writeQueue = Promise.resolve();
    this.queuedBytes = 0;
  }

  setStatus(state, message) {
    this.status = { state, appServerVersion: this.appServerVersion ?? null, ...(message ? { message } : {}) };
    this.emit('status', { ...this.status });
  }

  getStatus() { return { ...this.status }; }

  isBusy() {
    return this.activeTurns.size > 0 || this.pending.size > 0 || this.serverRequests.size > 0 || this.queuedBytes > 0;
  }

  async executable() {
    const configured = process.env.CODEX_APP_SERVER_PATH;
    const bundled = resourcePaths().backend;
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const candidates = configured ? [configured] : bundled ? [bundled] : [
      path.join(this.root, 'backend_official', 'codex-rs', 'target', 'release', `codex-app-server${suffix}`),
      path.join(this.root, 'backend_official', 'codex-rs', 'target', 'release', `codex${suffix}`),
      path.join(this.root, 'backend_official', 'codex-rs', 'target', 'debug', `codex${suffix}`),
    ];
    for (const candidate of candidates) {
      if (!path.isAbsolute(candidate)) throw rpcError('INVALID_EXECUTABLE', 'CODEX_APP_SERVER_PATH 必须是编译后可执行文件的绝对路径');
      const resolved = path.resolve(candidate);
      if (path.basename(resolved).toLowerCase() === 'codex-original.exe') throw rpcError('INVALID_EXECUTABLE', '禁止使用 native/codex-original.exe；请编译修改后的 Rust 后端');
      try {
        if (!(await fs.stat(resolved)).isFile()) continue;
        const actual = await fs.realpath(resolved);
        if (path.basename(actual).toLowerCase() === 'codex-original.exe') throw rpcError('INVALID_EXECUTABLE', '禁止使用原版后端文件');
        if (process.platform === 'win32' && path.extname(actual).toLowerCase() !== '.exe') throw rpcError('INVALID_EXECUTABLE', 'Windows 后端必须是 .exe 文件');
        return actual;
      } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    }
    throw rpcError('BACKEND_NOT_BUILT', bundled ? '发行包缺少内置 codex-app-server.exe，请重新下载完整发行包' : '未找到已编译的 Rust 后端，可将 CODEX_APP_SERVER_PATH 指向其可执行文件');
  }

  start() {
    if (this.status.state === 'ready') return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async startInternal() {
    if (this.stopPromise) await this.stopPromise;
    if (this.child) await this.stop();
    this.stopping = false;
    this.setStatus('starting');
    try {
      await this.store.initialize();
      const executable = await this.executable();
      if (this.stopping) throw rpcError('BACKEND_STOPPED', '后端启动已取消');
      const standalone = /^(?:codex-app-server|app-server)(?:\.exe)?$/iu.test(path.basename(executable));
      const args = standalone ? ['--listen', 'stdio://'] : ['app-server', '--listen', 'stdio://'];
      const environment = this.store.backendEnvironment();
      const pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path') || 'PATH';
      const inheritedPath = environment[pathKey] || '';
      for (const key of Object.keys(environment)) if (key.toLowerCase() === 'path') delete environment[key];
      environment.PATH = [path.dirname(executable), inheritedPath].filter(Boolean).join(path.delimiter);
      const child = spawn(executable, args, {
        cwd: this.store.home, env: environment, shell: false, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      this.output = '';
      this.writeQueue = Promise.resolve();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { if (this.child === child) this.readChunk(chunk); });
      // Stderr can contain provider credentials. Drain it without logging or forwarding it.
      child.stderr.resume();
      child.stdin.on('error', () => { if (this.child === child && !this.stopping) this.fail('后端标准输入流已关闭'); });
      child.stdout.on('error', () => { if (this.child === child && !this.stopping) this.fail('后端标准输出流读取失败'); });
      child.on('error', () => { if (this.child === child) this.fail('无法启动后端进程；请检查可执行文件及访问权限'); });
      child.on('close', (code, signal) => {
        if (this.child !== child) return;
        const unexpected = !this.stopping;
        this.child = null;
        this.clearPending(rpcError('BACKEND_STOPPED', '后端进程已退出'));
        this.activeTurns.clear();
        this.completedTurns.clear();
        this.output = '';
        if (unexpected && this.status.state !== 'error') this.setStatus('error', `后端意外退出（code=${code ?? 'null'}, signal=${signal ?? 'none'}）`);
        else if (this.status.state !== 'error') this.setStatus('stopped');
      });
      const initialized = await this.requestInternal('initialize', {
        clientInfo: { name: 'codex_plusplus', title: 'Codex++', version: this.version },
        capabilities: { experimentalApi: true, requestAttestation: false, explicitGatewayOauth: true },
      }, 30_000);
      this.appServerVersion = typeof initialized?.userAgent === 'string'
        ? initialized.userAgent.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/u)?.[0] ?? null : null;
      await this.send({ method: 'initialized' });
      if (this.child !== child || this.stopping) throw rpcError('BACKEND_STOPPED', '后端在初始化期间已退出');
      this.setStatus('ready');
    } catch (error) {
      if (!this.stopping) this.fail(error.message || '后端初始化失败');
      throw error;
    }
  }

  async request(method, params) {
    const publicThreadId = params?.threadId;
    const routedId = this.ephemeralRoutes.get(publicThreadId);
    if (routedId) params = { ...params, threadId: routedId };
    const result = await this.requestRouted(method, params, publicThreadId);
    return this.publicThreadIds(this.restoreSkillInputs(result, params?.threadId));
  }

  skillInputs(input) {
    if (!Array.isArray(input)) return input;
    const result = [...input];
    const text = input.filter(item => item.type === 'text').map(item => item.text).join('\n');
    for (const skill of this.skillMetadata.values()) {
      // Only an explicit Markdown skill reference selects a skill. Ordinary
      // prose containing a similar name must not activate a tool implicitly.
      const references = [...text.matchAll(/\[\$([^\]]+)\]\((?:<([^>]+)>|([^\s)]+))\)/gu)];
      if (references.some(match => match[1].split('?')[0] === skill.name
        && path.normalize((match[2] ?? match[3]).replaceAll('\\\\', '\\')) === path.normalize(skill.path))
        && !result.some(item => item.type === 'skill' && item.name === skill.name && item.path === skill.path)) {
        result.push({ type: 'skill', name: skill.name, path: skill.path });
      }
    }
    return result;
  }

  restoreSkillInputs(value, threadId) {
    if (Array.isArray(value)) return value.map(entry => this.restoreSkillInputs(entry, threadId));
    if (!value || typeof value !== 'object') return value;
    const id = value.threadId ?? (Array.isArray(value.turns) ? value.id : threadId);
    if (value.type === 'userMessage' && Array.isArray(value.content)) {
      const content = this.skillInputs(value.content);
      const submitted = this.submittedMentions.get(`${id}:${value.clientId}`) ?? [];
      return { ...value, content: [...content, ...submitted.filter(item =>
        !content.some(existing => existing.type === item.type && existing.name === item.name && existing.path === item.path))] };
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, this.restoreSkillInputs(entry, id)]));
  }

  publicThreadIds(value, key) {
    if (typeof value === 'string' && ['id', 'threadId', 'sessionId', 'parentThreadId', 'forkedFromId', 'reviewThreadId'].includes(key)) {
      return this.ephemeralPublicIds.get(value) || value;
    }
    if (Array.isArray(value)) return value.map(entry => this.publicThreadIds(entry));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, this.publicThreadIds(entry, name)]));
  }

  async requestRouted(method, params, publicThreadId) {
    if (this.stopping) throw rpcError('BACKEND_STOPPING', '后端正在关闭');
    await this.start();
    if (['turn/start', 'turn/steer', 'thread/read', 'thread/turns/list'].includes(method) && !this.skillMetadata.size) {
      const listed = await this.store.skillInterfaces(await this.requestInternal('skills/list', { cwds: [this.root] }, REQUEST_TIMEOUT));
      for (const group of listed.data) for (const skill of group.skills) this.skillMetadata.set(skill.path, skill);
    }
    if (['turn/start', 'turn/steer'].includes(method) && Array.isArray(params?.input)) {
      params = { ...params, input: this.skillInputs(params.input) };
      if (params.clientUserMessageId) this.submittedMentions.set(`${params.threadId}:${params.clientUserMessageId}`,
        params.input.filter(item => item.type === 'skill' || item.type === 'mention'));
    }
    // Native list defaults to the process's startup provider. The desktop
    // sidebar must keep conversations from every provider visible after a switch.
    if (method === 'thread/list' && params?.modelProviders == null) params = { ...params, modelProviders: [] };
    if (method === 'thread/fork' && params?.ephemeral && !params.experimentalPredictionMode
      && !params.path && !params.lastTurnId && !params.beforeTurnId) {
      // Pin the side-chat boundary now. A later provider selection must not
      // inherit newer parent turns (especially an in-progress tool call).
      const page = await this.requestInternal('thread/turns/list', { threadId: params.threadId,
        limit: 1, sortDirection: 'desc', itemsView: 'summary' }, REQUEST_TIMEOUT);
      const last = page?.data?.[0];
      if (last) params = { ...params, ...(last.status === 'inProgress' ? { beforeTurnId: last.id } : { lastTurnId: last.id }) };
    }
    if (method === 'thread/resume' && params?.modelProvider) {
      const snapshot = this.threadSnapshots.get(params.threadId);
      if (snapshot?.ephemeral && snapshot.modelProvider === params.modelProvider) {
        const configuration = this.ephemeralConfigurations.get(params.threadId);
        if (configuration) {
          // Native resume requires a rollout even for an already-loaded ephemeral
          // fork. It is already attached to this stdio connection; inspect it live.
          const { thread } = await this.requestInternal('thread/read', { threadId: params.threadId, includeTurns: !params.excludeTurns }, REQUEST_TIMEOUT);
          return { ...configuration, thread, model: thread.model, modelProvider: thread.modelProvider };
        }
      }
      if (snapshot?.ephemeral && snapshot.modelProvider !== params.modelProvider) {
        // Ephemeral side chats have no rollout to unload/resume. Fork their live
        // history with the requested provider and keep the UI's logical id stable.
        const operation = this.ephemeralRouteQueue.then(async () => {
          const id = this.ephemeralRoutes.get(publicThreadId) || params.threadId;
          const { thread } = await this.requestInternal('thread/read', { threadId: id, includeTurns: false }, REQUEST_TIMEOUT);
          if (thread.status?.type === 'active') throw rpcError('ACTIVE_TURN', '侧边对话正在运行，请等待结束后切换其 Provider');
          const fork = this.ephemeralForks.get(id);
          if (!fork || this.ephemeralStartedTurns.has(id)) throw rpcError('EPHEMERAL_PROVIDER_CHANGE', '已有回复的临时侧边对话暂不支持跨 Provider 切换，请新建侧边对话；原对话已保留');
          this.heldThreadStarts = [];
          try {
            // Native fork reads persisted sources, not ephemeral sessions. Reuse
            // the original fork boundary before this side chat has any own turns.
            const result = await this.requestInternal('thread/fork', { ...fork, ...params, threadId: fork.threadId, ephemeral: true }, REQUEST_TIMEOUT);
            const replacement = result?.thread?.id;
            if (!replacement) throw rpcError('INVALID_RESPONSE', '侧边对话 Provider 切换未返回有效线程');
            this.ephemeralRoutes.set(publicThreadId, replacement);
            this.ephemeralPublicIds.set(replacement, publicThreadId);
            this.retiredEphemeralIds.add(id);
            this.localStartedThreads.delete(replacement);
            await this.requestInternal('thread/unsubscribe', { threadId: id }, REQUEST_TIMEOUT);
            return result;
          } finally {
            const notifications = this.heldThreadStarts;
            this.heldThreadStarts = null;
            for (const event of notifications) this.emit('event', this.publicThreadIds(event));
          }
        });
        this.ephemeralRouteQueue = operation.catch(() => {});
        return operation;
      }
    }
    if (['turn/start', 'thread/settings/update', 'turn/settings/update'].includes(method) && params?.modelProvider != null) {
      // These native RPCs only override the model. The renderer first resumes
      // the target thread with its provider; never silently ignore a mismatch.
      const { thread } = await this.requestInternal('thread/read', { threadId: params.threadId, includeTurns: false }, REQUEST_TIMEOUT);
      if (thread?.modelProvider !== params.modelProvider) throw rpcError('PROVIDER_MISMATCH', '线程 Provider 与请求不一致，请先按所选 Provider 恢复该线程');
      params = { ...params };
      delete params.modelProvider;
    }
    const timeout = ['command/exec', 'plugin/install', 'plugin/reconcile', 'environment/add'].includes(method) ? 10 * 60_000 : REQUEST_TIMEOUT;
    if (['thread/archive', 'thread/unarchive'].includes(method) && this.preferences) {
      const operation = this.archiveQueue.then(() => this.changeThreadArchive(method, params, timeout));
      this.archiveQueue = operation.catch(() => {});
      return operation;
    }
    let result;
    // The isolated desktop owns these actual local packages. Catalog and
    // installed inventory must share identities, paths and persistence.
    if (['plugin/list', 'plugin/installed'].includes(method)
      && (!params?.marketplaceKinds?.length || params.marketplaceKinds.includes('local'))) {
      const marketplaces = await this.store.localPluginMarketplaces(params, method === 'plugin/installed');
      const marketplaceLoadErrors = [...this.store.plugins.entries.values()]
        .filter(entry => entry.sourceError || entry.iconError)
        .map(entry => ({ marketplacePath: entry.group.path, message: `${entry.name}: ${(entry.sourceError || entry.iconError).slice(0, 800)}` }));
      return { marketplaces, marketplaceLoadErrors, featuredPluginIds: [] };
    }
    if (['plugin/install', 'plugin/read', 'plugin/uninstall'].includes(method)) {
      const plugin = await this.store.localPlugin(params ?? {});
      if (plugin) {
        if (method === 'plugin/read') return { plugin: await this.store.plugins.detail(plugin) };
        const result = await this.store.changeLocalPlugin({ pluginId: plugin.id, marketplacePath: plugin.marketplacePath }, method === 'plugin/install');
        this.curatedChanges.add(plugin.id);
        await this.requestInternal('config/batchWrite', { edits: [], reloadUserConfig: true }, timeout);
        await this.requestInternal('skills/list', { cwds: [this.root], forceReload: true }, timeout);
        await this.requestInternal('config/mcpServer/reload', undefined, timeout);
        return result;
      }
    }
    if (method === 'plugin/reconcile') {
      const changedPlugins = [];
      for (const id of this.curatedChanges) {
        const plugin = await this.store.localPlugin({ pluginId: id });
        const detail = plugin?.installed ? await this.store.plugins.detail(plugin) : null;
        changedPlugins.push({ id, hasMcps: Boolean(detail?.mcpServers.length), hasApps: Boolean(detail?.apps.length),
          hasHooks: Boolean(detail?.hooks.length), hasSkills: Boolean(detail?.skills.length) });
      }
      this.curatedChanges.clear();
      return { changedPlugins, failedRemotePluginIds: [], failedMaterializationRemotePluginIds: [] };
    }
    if (method === 'plugin/skill/read') {
      const summary = await this.store.localPlugin({ pluginName: params?.remotePluginId, remoteMarketplaceName: params?.remoteMarketplaceName });
      if (summary) {
        const detail = await this.store.plugins.detail(summary);
        const skill = detail.skills.find(skill => skill.name === params.skillName);
        return { contents: skill ? await fs.readFile(skill.path, 'utf8') : null };
      }
    }
    if (method === 'plugin/search' && !params?.cursor) {
      const query = (params?.searchTerm ?? '').toLowerCase().trim();
      const marketplaces = await this.store.localPluginMarketplaces({}, params?.scope === 'USER');
      const data = marketplaces.flatMap(marketplace => marketplace.plugins
        .filter(plugin => !query || `${plugin.interface?.displayName} ${plugin.name} ${plugin.interface?.shortDescription}`.toLowerCase().includes(query))
        .map(plugin => ({ marketplaceName: marketplace.name, marketplacePath: marketplace.path, plugin })));
      return { data, nextCursor: null };
    }
    try { result = await this.requestInternal(method, params, timeout); }
    catch (error) {
      if (['plugin/list', 'plugin/installed', 'plugin/reconcile', 'plugin/read', 'plugin/search'].includes(method) && /chatgpt.*auth|auth.*chatgpt|authentication required/iu.test(error.message)) {
        if (['plugin/list', 'plugin/installed'].includes(method)) result = { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] };
        else if (method === 'plugin/reconcile') result = { changedPlugins: [], failedRemotePluginIds: [], failedMaterializationRemotePluginIds: [] };
        else if (method === 'plugin/search') result = { data: [], nextCursor: null };
        else throw error;
      } else throw error;
    }
    if (method === 'skills/list') {
      const listed = await this.store.skillInterfaces(result);
      this.skillMetadata.clear();
      for (const group of listed.data) for (const skill of group.skills) this.skillMetadata.set(skill.path, skill);
      return listed;
    }
    if (method === 'model/list' && !params?.cursor) {
      const registry = await this.store.readProviders();
      const data = [...(result?.data ?? [])];
      const seen = new Set(data.map(model => model.model));
      const configured = new Set();
      const providers = [...registry.providers].sort((a, b) => Number(b.id === registry.activeProviderId) - Number(a.id === registry.activeProviderId));
      for (const provider of providers) for (const model of provider.models) {
        if (configured.has(model.id)) continue;
        configured.add(model.id);
        const metadata = modelMetadata(model);
        if (seen.has(model.id)) {
          const entry = data.find(entry => entry.model === model.id);
          Object.assign(entry, metadata, { displayName: model.label || entry.displayName });
          continue;
        }
        seen.add(model.id);
        data.push({ id: model.id, model: model.id, displayName: model.label || model.id,
          description: `${provider.name} · local BYOK`, hidden: false,
          ...metadata, supportsPersonality: false,
          supportsServiceTier: false, serviceTiers: [], additionalSpeedTiers: [], defaultServiceTier: null,
          availableAccessPrograms: null, upgrade: null, upgradeInfo: null, availabilityNux: null, multiAgentVersion: 'v1',
          isDefault: provider.id === registry.activeProviderId && model.id === provider.defaultModel,
        });
      }
      return { ...result, data };
    }
    if (method === 'thread/list' && this.preferences) return this.mergeLocalArchives(result, params);
    if (method === 'thread/delete' && this.preferences) {
      const state = (await this.preferences.read()).applicationState;
      await this.preferences.write('applicationState', 'archivedThreadIds', (state.archivedThreadIds ?? []).filter(id => id !== params?.threadId));
      const snapshots = { ...state.localArchivedThreadSnapshots };
      delete snapshots[params?.threadId];
      await this.preferences.write('applicationState', 'localArchivedThreadSnapshots', snapshots);
      this.threadSnapshots.delete(params?.threadId);
      this.localStartedThreads.delete(params?.threadId);
    }
    return result;
  }

  async changeThreadArchive(method, params, timeout) {
    const threadId = params?.threadId;
    if (typeof threadId !== 'string' || !threadId) throw rpcError(-32600, 'threadId is required');
    let thread = this.threadSnapshots.get(threadId);
    if (!thread) {
      try { thread = (await this.requestInternal('thread/read', { threadId, includeTurns: false }, timeout)).thread; }
      catch (error) { if (error.code !== -32600 && !/no rollout found/iu.test(error.message)) throw error; }
    }
    let result;
    let fallback = false;
    try { result = await this.requestInternal(method, params, timeout); }
    catch (error) {
      if (error.code !== -32600 && !/no rollout found/iu.test(error.message)) throw error;
      fallback = true;
      result = {};
    }
    const state = (await this.preferences.read()).applicationState;
    thread ??= state.localArchivedThreadSnapshots?.[threadId];
    const ids = new Set(state.archivedThreadIds ?? []);
    const snapshots = { ...state.localArchivedThreadSnapshots };
    if (thread) snapshots[threadId] = { ...thread, turns: [] };
    if (method === 'thread/archive') ids.add(threadId); else ids.delete(threadId);
    await this.preferences.write('applicationState', 'localArchivedThreadSnapshots', snapshots);
    await this.preferences.write('applicationState', 'archivedThreadIds', [...ids]);
    if (fallback) this.emit('event', { method: method === 'thread/archive' ? 'thread/archived' : 'thread/unarchived', params: { threadId } });
    if (fallback && method === 'thread/unarchive' && thread) return { thread };
    return result;
  }

  async mergeLocalArchives(result, params = {}) {
    await this.archiveQueue;
    const state = (await this.preferences.read()).applicationState;
    const ids = new Set(state.archivedThreadIds ?? []);
    const localSnapshots = { ...Object.fromEntries([...this.localStartedThreads].flatMap(id => {
      const thread = this.threadSnapshots.get(id);
      return thread && !thread.ephemeral ? [[id, thread]] : [];
    })), ...state.localArchivedThreadSnapshots };
    const data = (result?.data ?? []).filter(thread => Object.hasOwn(localSnapshots, thread.id)
      ? ids.has(thread.id) === (params.archived === true) : params.archived === true || !ids.has(thread.id));
    if (!params.cursor) {
      const seen = new Set(data.map(thread => thread.id));
      const roots = params.cwd == null ? null : Array.isArray(params.cwd) ? params.cwd : [params.cwd];
      for (const thread of Object.values(localSnapshots)) {
        if (seen.has(thread.id) || ids.has(thread.id) !== (params.archived === true)) continue;
        if (params.excludedThreadIds?.includes(thread.id) || (roots && !roots.includes(thread.cwd))) continue;
        if (Object.hasOwn(params, 'projectId') && params.projectId !== thread.projectId) continue;
        if (Object.hasOwn(params, 'sectionId') && params.sectionId !== (thread.section?.id ?? null)) continue;
        if (params.modelProviders?.length && !params.modelProviders.includes(thread.modelProvider)) continue;
        if (params.searchTerm && !(thread.name ?? thread.preview ?? '').toLowerCase().includes(params.searchTerm.toLowerCase())) continue;
        data.push(thread);
      }
      const key = params.sortKey === 'updated_at' ? 'updatedAt' : 'createdAt';
      data.sort((a, b) => (params.sortDirection === 'asc' ? 1 : -1) * ((a[key] ?? 0) - (b[key] ?? 0)));
    }
    return { ...result, data };
  }

  requestInternal(method, params, timeout) {
    if (!this.child || this.stopping) return Promise.reject(rpcError('BACKEND_UNAVAILABLE', '后端尚未连接'));
    if (this.pending.size >= MAX_PENDING) return Promise.reject(rpcError('BACKEND_BUSY', '在途请求数量超过限制，请等待已有请求完成'));
    const id = `desktop-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(idKey(id));
        reject(rpcError('RPC_TIMEOUT', `后端请求超时：${method}`));
        // A timed-out mutation may still execute. Close the transport rather than claim an idle session.
        this.fail(`请求超时，后端已停止以避免状态不确定：${method}`);
      }, timeout);
      this.pending.set(idKey(id), { resolve, reject, timer, method, params });
      this.send({ id, method, ...(params === undefined ? {} : { params }) }).catch((error) => {
        const pending = this.pending.get(idKey(id));
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(idKey(id));
        pending.reject(error);
      });
    });
  }

  send(message) {
    if (message.error) this.emit('rpc-error', { direction: 'outgoing', method: this.serverRequests.get(idKey(message.id))?.method,
      code: message.error.code, message: message.error.message });
    const child = this.child;
    if (!child || child.stdin.destroyed || this.stopping) return Promise.reject(rpcError('BACKEND_UNAVAILABLE', '后端连接已关闭'));
    let serialized;
    try {
      const outgoing = Object.hasOwn(message, 'params') ? { ...message, params: sanitizeMcpConfig(message.params) } : message;
      serialized = `${JSON.stringify(outgoing)}\n`;
    } catch { return Promise.reject(rpcError('INVALID_RPC', '请求无法序列化为 JSON')); }
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > MAX_MESSAGE_BYTES) return Promise.reject(rpcError('RPC_TOO_LARGE', '单条后端消息超过 32 MiB'));
    if (this.queuedBytes + bytes > MAX_QUEUED_BYTES) return Promise.reject(rpcError('BACKEND_BACKPRESSURE', '后端发送队列已满，请稍后重试'));
    this.queuedBytes += bytes;
    const write = this.writeQueue.then(() => new Promise((resolve, reject) => {
      if (this.child !== child || child.stdin.destroyed || this.stopping) { reject(rpcError('BACKEND_STOPPED', '后端已退出')); return; }
      // Serialize stream writes. The callback waits for the chunk to flush, respecting backpressure.
      child.stdin.write(serialized, 'utf8', (error) => {
        if (error) reject(rpcError('BACKEND_WRITE_FAILED', '向后端写入请求失败'));
        else resolve();
      });
    }));
    const settled = write.finally(() => { this.queuedBytes -= bytes; });
    this.writeQueue = settled.catch(() => {});
    return settled;
  }

  readChunk(chunk) {
    this.output += chunk;
    let newline;
    while ((newline = this.output.indexOf('\n')) >= 0) {
      const line = this.output.slice(0, newline).trim();
      this.output = this.output.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_MESSAGE_BYTES) { this.fail('后端消息超过 32 MiB'); return; }
      let message;
      try { message = JSON.parse(line); } catch { this.fail('后端输出不是有效的换行分隔 JSON-RPC'); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { this.fail('后端返回无效 JSON-RPC 消息'); return; }
      this.receive(message);
      if (this.status.state === 'error') return;
    }
    if (Buffer.byteLength(this.output, 'utf8') > MAX_MESSAGE_BYTES) this.fail('后端未完成的消息超过 32 MiB');
  }

  receive(message) {
    if (typeof message.method === 'string') {
      if (this.retiredEphemeralIds.has(message.params?.threadId)) return;
      if (!message.method || message.method.length > 256) { this.fail('后端返回无效方法名'); return; }
      if (Object.hasOwn(message, 'id')) {
        if (!validId(message.id) || this.serverRequests.has(idKey(message.id))) { this.fail('后端反向请求 ID 无效或重复'); return; }
        if (this.serverRequests.size >= MAX_PENDING) {
          this.send({ id: message.id, error: { code: -32000, message: 'Client approval queue is full' } }).catch(() => {});
          return;
        }
        const timer = setTimeout(() => {
          this.serverRequests.delete(idKey(message.id));
          this.send({ id: message.id, error: { code: -32001, message: 'Client response timed out' } }).catch(() => {});
          this.emit('event', { method: 'codex/serverRequestTimedOut', params: { id: message.id, method: message.method } });
        }, SERVER_REQUEST_TIMEOUT);
        this.serverRequests.set(idKey(message.id), { id: message.id, method: message.method, timer });
      } else {
        this.trackNotification(message);
      }
      if (message.method === 'thread/started' && this.heldThreadStarts) this.heldThreadStarts.push(message);
      else this.emit('event', this.publicThreadIds(this.restoreSkillInputs(message)));
      return;
    }
    if (!validId(message.id)) { this.fail('后端响应缺少有效 ID'); return; }
    const key = idKey(message.id);
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    clearTimeout(pending.timer);
    if (Object.hasOwn(message, 'error')) {
      this.emit('rpc-error', { direction: 'incoming', method: pending.method, code: message.error?.code, message: message.error?.message });
      if (!message.error || typeof message.error.message !== 'string' || !Number.isInteger(message.error.code)) {
        pending.reject(rpcError('INVALID_RPC', '后端返回了无效错误响应'));
        this.fail('后端 JSON-RPC 错误格式无效');
      } else pending.reject(rpcError(message.error.code, message.error.message, message.error.data));
    } else if (Object.hasOwn(message, 'result')) {
      this.trackResult(pending, message.result);
      pending.resolve(message.result);
    } else {
      pending.reject(rpcError('INVALID_RPC', '后端响应缺少 result 或 error'));
      this.fail('后端 JSON-RPC 响应格式无效');
    }
  }

  trackNotification({ method, params }) {
    if (params?.thread?.id) this.threadSnapshots.set(params.thread.id, { ...params.thread, turns: [] });
    if (method === 'thread/name/updated' && this.threadSnapshots.has(params?.threadId)) {
      this.threadSnapshots.set(params.threadId, { ...this.threadSnapshots.get(params.threadId), name: params.threadName ?? params.name });
    }
    const threadId = params?.threadId;
    const turnId = params?.turn?.id;
    if (method === 'serverRequest/resolved' && validId(params?.requestId)) {
      const pending = this.serverRequests.get(idKey(params.requestId));
      if (pending) clearTimeout(pending.timer);
      this.serverRequests.delete(idKey(params.requestId));
    }
    if (method === 'turn/started' && typeof threadId === 'string' && typeof turnId === 'string') this.activeTurns.add(`${threadId}:${turnId}`);
    if (method === 'turn/completed' && typeof threadId === 'string' && typeof turnId === 'string') {
      const key = `${threadId}:${turnId}`;
      this.activeTurns.delete(key);
      this.activeTurns.delete(`${threadId}:active`);
      this.completedTurns.add(key);
      if (this.completedTurns.size > 512) this.completedTurns.delete(this.completedTurns.values().next().value);
    }
    if (method === 'thread/status/changed' && typeof threadId === 'string') {
      if (params.status?.type === 'active') this.activeTurns.add(`${threadId}:active`);
      else for (const key of this.activeTurns) if (key.startsWith(`${threadId}:`)) this.activeTurns.delete(key);
    }
    if (['thread/closed', 'thread/archived'].includes(method) && typeof threadId === 'string') {
      for (const key of this.activeTurns) if (key.startsWith(`${threadId}:`)) this.activeTurns.delete(key);
    }
  }

  trackResult(pending, result) {
    if (result?.thread?.id) this.threadSnapshots.set(result.thread.id, { ...result.thread, turns: [] });
    if (pending.method === 'thread/fork' && result?.thread?.ephemeral) {
      this.ephemeralForks.set(result.thread.id, pending.params);
      this.ephemeralConfigurations.set(result.thread.id, result);
    }
    if (pending.method === 'turn/start' && result?.turn?.status === 'inProgress') this.ephemeralStartedTurns.add(pending.params?.threadId);
    if (['thread/start', 'thread/fork'].includes(pending.method) && result?.thread?.id) this.localStartedThreads.add(result.thread.id);
    if (pending.method === 'thread/list') for (const thread of result?.data ?? []) this.threadSnapshots.set(thread.id, { ...thread, turns: [] });
    if (['turn/start', 'review/start'].includes(pending.method) && result?.turn?.status === 'inProgress') {
      const threadId = result.reviewThreadId || pending.params?.threadId;
      const key = `${threadId}:${result.turn.id}`;
      if (typeof threadId === 'string' && !this.completedTurns.has(key)) this.activeTurns.add(key);
    }
    if (['thread/resume', 'thread/fork'].includes(pending.method) && result?.thread?.status?.type === 'active') {
      this.activeTurns.add(`${result.thread.id}:active`);
    }
  }

  async respond(id, result, error) {
    if (!validId(id)) throw rpcError('INVALID_RPC', '反向请求 ID 无效');
    const pending = this.serverRequests.get(idKey(id));
    if (!pending) throw rpcError('UNKNOWN_SERVER_REQUEST', '反向请求不存在、已回复或已超时');
    if (pending.replying) throw rpcError('SERVER_REQUEST_REPLYING', '该反向请求正在回复');
    if (error !== undefined && (!error || !Number.isInteger(error.code) || typeof error.message !== 'string' || error.message.length > 8192)) {
      throw rpcError('INVALID_RPC', '错误响应必须包含整数 code 和文本 message');
    }
    pending.replying = true;
    clearTimeout(pending.timer);
    try {
      await this.send({ id, ...(error === undefined ? { result: result === undefined ? null : result } : { error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } }) });
      this.serverRequests.delete(idKey(id));
    } catch (failure) {
      this.fail('反向请求回复发送失败，后端已停止以避免审批状态不确定');
      throw failure;
    }
  }

  clearPending(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const pending of this.serverRequests.values()) clearTimeout(pending.timer);
    this.serverRequests.clear();
  }

  fail(message) {
    this.setStatus('error', message);
    this.clearPending(rpcError('BACKEND_ERROR', message));
    this.activeTurns.clear();
    if (this.child && !this.child.killed) this.child.kill();
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal().finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }

  async stopInternal() {
    this.stopping = true;
    this.clearPending(rpcError('BACKEND_STOPPED', '后端已关闭；尚未完成的请求已取消'));
    this.activeTurns.clear();
    const child = this.child;
    if (!child) { this.setStatus('stopped'); return; }
    let shutdownFailure;
    await new Promise((resolve) => {
      let graceful;
      let forced;
      let deadline;
      let finished = false;
      const exited = () => finish(false);
      const finish = (timedOut) => {
        if (finished) return;
        finished = true;
        clearTimeout(graceful);
        clearTimeout(forced);
        clearTimeout(deadline);
        child.removeListener('close', exited);
        child.removeListener('exit', exited);
        const terminated = child.exitCode !== null || child.signalCode !== null;
        if (timedOut && !terminated) {
          shutdownFailure = rpcError('BACKEND_SHUTDOWN_FAILED', '后端在 7 秒关闭期限内未确认退出；强制终止失败，请检查系统中的后端进程');
          this.setStatus('error', shutdownFailure.message);
        } else {
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          if (this.child === child) this.child = null;
        }
        resolve();
      };
      const kill = (signal) => { try { child.kill(signal); } catch { /* The final deadline reports failure if termination remains unconfirmed. */ } };
      graceful = setTimeout(() => {
        kill();
        forced = setTimeout(() => { if (this.child === child) kill('SIGKILL'); }, 2000);
      }, 3000);
      deadline = setTimeout(() => finish(true), 7000);
      child.once('close', exited);
      child.once('exit', exited);
      try { child.stdin.end(); } catch { /* Continue to the bounded termination path. */ }
      if (child.exitCode !== null || child.signalCode !== null) finish(false);
    });
    if (shutdownFailure) throw shutdownFailure;
    this.setStatus('stopped');
  }

}

module.exports = { AppServer, rpcError };
