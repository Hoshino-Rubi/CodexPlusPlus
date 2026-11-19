import packageInfo from '../../../package.json';
import { parse as parseToml } from 'smol-toml';
import type { BackendStatus, DesktopBridge, PreferenceScope } from '../../../shared/bridge';
import type { FsGetMetadataResponse } from '../../../protocol_schema/typescript/v2/FsGetMetadataResponse';
import type { FsReadFileResponse } from '../../../protocol_schema/typescript/v2/FsReadFileResponse';
import type { CommandExecResponse } from '../../../protocol_schema/typescript/v2/CommandExecResponse';
import type { ProjectImportResponse } from '../../../protocol_schema/typescript/v2/ProjectImportResponse';
import { readLocalWindowsReadiness } from './localSetup';
import { localWorkspacePolicyForSession } from './authPolicy';
import { installEmbeddedBrowserPanel, type RecoveredBrowserViewRequest } from './browserPanel';
import type {
  HostServiceContext,
  HostServicesOptions,
  LocalConnectionState,
  LocalExecutionHost,
  LocalRemoteConnectionCatalog,
  RecoveredOpenPathRequest,
  RecoveredOpenTargetRequest,
  RecoveredRpcModule,
  RecoveredRendererRoot,
  RecoveredSettingDefinition,
  RpcCallback,
  RpcDisposable,
  WorkspacePathRequest,
  WorkspaceRootReadOptions,
  LocalThreadConfigurationRequest,
  LocalMcpConfig,
  LocalMcpConfigRequest,
  LocalMcpConfigWriteRequest,
  LocalMcpConfigResponse,
  LocalDeveloperInstructionsRequest,
  LocalDeveloperInstructionsResponse,
  LocalThreadMembership,
  LocalThreadMembershipRequest,
  LocalThreadMemberships,
  LocalProjectlessThreadUpdate,
  LocalThreadStartProjectRequest,
  LocalQueuedFollowUpsState,
  LocalQueuedSendLockRequest,
  LocalQueuedSendLockRelease,
  LocalPendingWorktree,
  LocalCustomPet,
  LocalDictationRecording,
  LocalManagedThreadArchive,
  LocalPullRequest,
  LocalPullRequestFilter,
} from './hostTypes';
import {
  getRecoveredPreferences,
  recoveredApplicationState,
  subscribeRecoveredPreferences,
  writeRecoveredPreference,
  readLocalThreadConfiguration,
  writeLocalThreadConfiguration,
  sanitizeMcpConfig,
} from './viewTransport';

const LOCAL_HOST: LocalExecutionHost = { id: 'local', display_name: 'Local', kind: 'local' };

/** Read only the selected local repository; no hosted account is fabricated. */
export async function readLocalPullRequests(filter: LocalPullRequestFilter, search: string, bridge: DesktopBridge = window.codex) {
  const cwd = getRecoveredPreferences().applicationState['active-workspace-root'];
  const [items, user] = await Promise.all([
    bridge.gitRequest<LocalPullRequest[]>('gh-pr-list', typeof cwd === 'string' ? { cwd } : {}),
    bridge.gitRequest<{ account: { hostId: string; hostname: string; login: string } | null }>('gh-current-user', {}),
  ]);
  const query = search.trim().toLowerCase();
  return { account: user.account, items: items.filter(item =>
    (filter !== 'mine' || (user.account !== null && item.author?.login === user.account.login))
    && (filter !== 'reviewing' || (!item.isDraft && item.reviewDecision !== 'APPROVED'))
    && (!query || `${item.title} ${item.number} ${item.author?.login ?? ''}`.toLowerCase().includes(query))) };
}

export class HostCapabilityUnavailableError extends Error {
  readonly code = 'HOST_CAPABILITY_UNAVAILABLE';

  constructor(capability: string) {
    super(`Local desktop capability is unavailable: ${capability}`);
    this.name = 'HostCapabilityUnavailableError';
  }
}

function requireLocalHost(hostId: unknown = 'local'): void {
  if (hostId !== 'local') throw new HostCapabilityUnavailableError(`execution host ${String(hostId)}`);
}

function requireKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0) throw new TypeError('Application state key must be a nonempty string');
}

function connectionState(status: BackendStatus): LocalConnectionState {
  const states = { ready: 'connected', starting: 'connecting', stopped: 'disconnected', error: 'error' } as const;
  return {
    state: states[status.state],
    progress: null,
    error: status.state === 'error' ? status.message ?? 'The local app-server is unavailable' : null,
    sshAuthenticationRetryAt: null,
  };
}

function release(value: unknown): void {
  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    const dispose = (value as RpcDisposable)[Symbol.dispose];
    if (typeof dispose === 'function') dispose.call(value);
  }
}

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function platformInfo(): { platform: 'win32' | 'darwin' | 'linux' | 'web'; osName: string | null } {
  const source = navigator.platform;
  if (source.startsWith('Win')) return { platform: 'win32', osName: 'Windows' };
  if (source.startsWith('Mac')) return { platform: 'darwin', osName: 'macOS' };
  if (/Linux|X11/iu.test(source)) return { platform: 'linux', osName: 'Linux' };
  return { platform: 'web', osName: null };
}

function absolutePath(request: WorkspacePathRequest): string {
  requireLocalHost(request.hostId);
  if (typeof request.path !== 'string' || !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(request.path)) {
    throw new TypeError('Workspace file operations require an explicit absolute path');
  }
  return request.path;
}

/** Install before importing the recovered renderer entry, and await completion. */
export async function installHostServices(
  bridge: DesktopBridge = window.codex,
  options: HostServicesOptions = {},
): Promise<() => void> {
  const context: HostServiceContext = {
    bridge,
    state: options.applicationState ?? recoveredApplicationState,
    status: { state: 'starting' },
  };
  if (platformInfo().platform === 'win32') {
    // The local-app ready policy is durable before any settings or composer host client connects.
    await readLocalWindowsReadiness(context.state, await bridge.getSession());
  }
  const connections = new Map<MessagePort, RecoveredRendererRoot | null>();
  const cleanupCallbacks = new Set<() => void>();
  let disposed = false;
  let rpc: RecoveredRpcModule | undefined;
  let hostRoot: object;

  function report(error: unknown): void {
    options.onError?.(errorValue(error));
  }

  function closeConnection(port: MessagePort): void {
    if (!connections.has(port)) return;
    const renderer = connections.get(port);
    connections.delete(port);
    try { release(renderer); } catch (error) { report(error); }
    try { port.postMessage(null); } catch { /* The peer may already have closed the port. */ }
    port.close();
  }

  function connect(port: MessagePort): void {
    if (disposed || !rpc) return;
    try {
      const renderer = rpc.vct(port, hostRoot);
      connections.set(port, renderer);
      renderer.onRpcBroken(() => closeConnection(port));
      options.onRendererConnected?.(renderer);
    } catch (error) {
      closeConnection(port);
      report(error);
    }
  }

  function onMessage(event: MessageEvent): void {
    if (disposed || event.source !== window) return;
    const origin = window.location.origin;
    // Chromium serializes a file document's postMessage origin as "null",
    // while location.origin is "file://". Still require this exact window and
    // a transferred MessagePort; remote frames cannot establish a host channel.
    const sameFileDocument = window.location.protocol === 'file:' && event.origin === 'null';
    if (origin && origin !== 'null' && event.origin !== origin && !sameFileDocument) return;
    const value: unknown = event.data;
    if (typeof value !== 'object' || value === null || !('type' in value) || value.type !== 'connect-app-host') return;
    const port = 'port' in value ? value.port : undefined;
    if (!(port instanceof MessagePort) || connections.has(port)) return;
    connections.set(port, null);
    if (rpc) connect(port);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('message', onMessage);
    window.removeEventListener('pagehide', dispose);
    for (const port of [...connections.keys()]) closeConnection(port);
    for (const cleanup of [...cleanupCallbacks]) {
      try { cleanup(); } catch (error) { report(error); }
    }
    cleanupCallbacks.clear();
  }

  window.addEventListener('message', onMessage);
  window.addEventListener('pagehide', dispose, { once: true });

  try {
    const assetUrl = new URL('./original/assets/app-shared-624e1c099f95.js', document.baseURI).href;
    const bundledRpc = await import(/* @vite-ignore */ assetUrl) as RecoveredRpcModule;
    if (disposed) return dispose;
    // These are live exports: hct/vct are assigned by _ct, so initialize before reading them.
    bundledRpc._ct();
    bundledRpc.Glt();
    const RpcTarget = bundledRpc.hct;
    if (typeof RpcTarget !== 'function' || typeof bundledRpc.vct !== 'function') {
      throw new Error('The recovered app-shared bundle does not export its MessagePort RPC runtime');
    }

    class Subscription extends RpcTarget {
      #cleanup: (() => void) | undefined;
      #dispose = () => this.unsubscribe();

      constructor(cleanup: () => void) {
        super();
        this.#cleanup = cleanup;
        cleanupCallbacks.add(this.#dispose);
      }

      unsubscribe(): void {
        const cleanup = this.#cleanup;
        this.#cleanup = undefined;
        if (cleanup) {
          cleanupCallbacks.delete(this.#dispose);
          cleanup();
        }
      }

      [Symbol.dispose](): void { this.unsubscribe(); }
    }

    // A new tab emits native state before newTab returns its ID. Defer these
    // events until the original renderer's manual tab ID has been associated,
    // otherwise a second numeric tab can steal focus from its address input.
    let creatingBrowserTabs = 0;
    let pendingBrowserState: Awaited<ReturnType<DesktopBridge['getBrowserState']>> | undefined;
    let browserStateListener: Parameters<DesktopBridge['onBrowserState']>[0] | undefined;
    const browserPanel = await installEmbeddedBrowserPanel({
      ...bridge,
      async browserCommand(method, params) {
        if (method !== 'newTab') return bridge.browserCommand(method, params);
        creatingBrowserTabs++;
        try { return await bridge.browserCommand(method, params); }
        finally {
          window.setTimeout(() => {
            creatingBrowserTabs--;
            if (!creatingBrowserTabs && pendingBrowserState && !disposed) {
              const next = pendingBrowserState; pendingBrowserState = undefined;
              browserStateListener?.(next);
            }
          }, 0);
        }
      },
      onBrowserState(listener) {
        browserStateListener = listener;
        return bridge.onBrowserState(next => {
          if (creatingBrowserTabs) pendingBrowserState = next;
          else listener(next);
        });
      },
    });
    cleanupCallbacks.add(() => browserPanel.dispose());

    class BrowserHost extends RpcTarget {
      #rendererInstanceId: string | undefined;
      #hosts = new Map<string, RecoveredBrowserViewRequest>();
      async registerWebviewHostSession(request: { rendererInstanceId: string }) {
        if (!request.rendererInstanceId) throw new TypeError('Browser renderer instance ID is required');
        this.#rendererInstanceId = request.rendererInstanceId;
        return true;
      }
      async registerWebviewHost(request: RecoveredBrowserViewRequest) {
        const key = request.browserTabId ?? request.conversationId;
        if (!key || !this.#rendererInstanceId) return false;
        this.#hosts.set(key, { ...request });
        return true;
      }
      syncView(request: RecoveredBrowserViewRequest) { return browserPanel.syncView(request); }
      async unregisterWebviewHost(request: RecoveredBrowserViewRequest) {
        const key = request.browserTabId ?? request.conversationId;
        if (key) this.#hosts.delete(key);
      }
      async registerSessionTabOpener(_opener: object) {
        // The original right-panel owns its tab layout; local tabs are announced
        // via browser-sidebar-state/toggle-browser-panel instead of window adoption.
        return new Subscription(() => {});
      }
      async prepareLocalWorkSessionRoute(_request: object): Promise<never> {
        throw new HostCapabilityUnavailableError('browserHost.prepareLocalWorkSessionRoute');
      }
      async cancelPendingLocalWorkSessionRoute(_request: object): Promise<never> {
        throw new HostCapabilityUnavailableError('browserHost.cancelPendingLocalWorkSessionRoute');
      }
      async deleteConversation(request: { conversationId?: string }): Promise<void> {
        if (!request.conversationId) throw new TypeError('Browser conversation ID is required');
        const state = await bridge.getBrowserState();
        for (const tab of state.tabs) if (tab.sessionId === request.conversationId) {
          await bridge.browserCommand('closeTab', { tabId: tab.id });
          this.#hosts.delete(String(tab.id));
        }
      }
      async subscribeFavicon(_request: object, _callback: RpcCallback<[string | null]>): Promise<never> {
        throw new HostCapabilityUnavailableError('browserHost.subscribeFavicon');
      }
      async subscribePermissionPrompts(_request: object, callback: RpcCallback<[unknown[]]>) {
        const listener = retainCallback(callback);
        await notify(listener, []);
        return new Subscription(() => release(listener));
      }
    }

    function retainCallback<Args extends unknown[]>(callback: RpcCallback<Args>): RpcCallback<Args> {
      if (typeof callback !== 'function') throw new TypeError('RPC subscription requires a callback');
      return callback.dup?.() ?? callback;
    }

    async function notify<Args extends unknown[]>(callback: RpcCallback<Args>, ...args: Args): Promise<void> {
      const pending = callback(...args);
      try { await pending; } finally { release(pending); }
    }

    class ExecutionHosts extends RpcTarget {
      async getDefaultHost(): Promise<LocalExecutionHost> { return { ...LOCAL_HOST }; }
    }

    class ExecutionPaths extends RpcTarget {
      async readCodexHome(hostId?: string): Promise<string> {
        requireLocalHost(hostId);
        return (await bridge.discoverHost()).codexHome;
      }
      async readHomePaths(hostId?: string) {
        requireLocalHost(hostId);
        const { codexHome, workspacesRoot, worktreesSegment } = await bridge.discoverHost();
        const configured = getRecoveredPreferences().applicationState['git-worktree-root'];
        return { codexHome, workspacesRoot, worktreesSegment: typeof configured === 'string' && configured.trim() ? configured.trim() : worktreesSegment };
      }
      async readHomeDirectory(hostId?: string): Promise<{ homeDirectory: string }> {
        requireLocalHost(hostId);
        return { homeDirectory: (await bridge.discoverHost()).homeDirectory };
      }
    }

    class Terminal extends RpcTarget {
      #listeners = new Map<RpcCallback<[unknown]>, Subscription>();
      async getAvailableShells() {
        try { return [...new Set((await bridge.discoverHost()).shells.map(({ id }) => id))]; }
        catch (error) { report(error); return []; }
      }
      async subscribe(callback: RpcCallback<[unknown]>) {
        const listener = retainCallback(callback);
        const subscription = new Subscription(() => { this.#listeners.delete(listener); release(listener); });
        this.#listeners.set(listener, subscription);
        return subscription;
      }
      unsubscribe(): void { for (const subscription of this.#listeners.values()) subscription.unsubscribe(); }
      async create(request: { sessionId: string; hostId?: string }) {
        requireLocalHost(request.hostId);
        // No PTY transport exists: expose a stopped session, never a pretend running shell.
        await Promise.all([...this.#listeners.keys()].map(listener => notify(listener, {
          type: 'exit', sessionId: request.sessionId, code: 1, signal: null, error: 'Local PTY transport is not configured',
        }).catch(report)));
      }
      async attach(_sessionId: string) { return null; }
      async attachExisting(_request: unknown) { return false; }
      async close(_sessionId: string): Promise<void> {}
      async getShellCwd(_sessionId: string) { return null; }
      async resize(_sessionId: string, _size: unknown): Promise<void> {}
      async transferSessionOwnership(_request: unknown): Promise<void> {}
      async runAction(_sessionId: string, _cwd: unknown, _command: unknown) { return { success: false, error: 'Local PTY transport is not configured' }; }
      async write(_sessionId: string, _data: string) { return { success: false, error: 'Local PTY transport is not configured' }; }
    }

    function settingDefinition(key: string): RecoveredSettingDefinition {
      requireKey(key);
      const definition = bundledRpc.Wlt(key);
      if (!definition) throw new Error(`Unknown setting: ${key}`);
      return definition;
    }

    function settingScope(definition: RecoveredSettingDefinition): PreferenceScope {
      switch (definition.hostStorage.kind) {
        case 'configuration': return 'settings';
        case 'global-state': return 'applicationState';
        case 'persisted-atom': return 'persistedAtoms';
      }
    }

    const settingKeys = new Set<string>();
    // The shipped registry exports its definition groups; use their actual schemas and defaults.
    for (const group of Object.values(bundledRpc)) {
      if (!group || typeof group !== 'object') continue;
      for (const value of [group, ...Object.values(group)]) {
        if (value && typeof value === 'object' && 'key' in value && typeof value.key === 'string' && bundledRpc.Wlt(value.key)) {
          settingKeys.add(value.key);
        }
      }
    }

    function readSetting(key: string): { configured: unknown; effective: unknown } {
      const definition = settingDefinition(key);
      const stored = getRecoveredPreferences()[settingScope(definition)][definition.hostStorage.key];
      const parsed = definition.schema.safeParse(stored);
      return { configured: stored, effective: stored !== undefined && parsed.success ? parsed.data : definition.default };
    }

    class ThreadConfiguration extends RpcTarget {
      #pending: Promise<unknown> = Promise.resolve();

      async readDeveloperInstructions(request: LocalDeveloperInstructionsRequest = {}): Promise<LocalDeveloperInstructionsResponse> {
        requireLocalHost(request.hostId ?? 'local');
        // Preserve caller instructions without advertising unavailable desktop tools.
        return { instructions: typeof request.baseInstructions === 'string' ? request.baseInstructions : '' };
      }

      #mcpKey(request: LocalMcpConfigRequest): string {
        requireLocalHost(request.hostId);
        if (request.cwd != null) absolutePath({ path: request.cwd });
        return `local-mcp-config:${request.cwd ?? 'default'}`;
      }

      #mcpConfig(value: unknown): LocalMcpConfig {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new TypeError('MCP config must be an object');
        }
        const config = value as Record<string, unknown>;
        const servers = config.mcpServers ?? {};
        if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
          throw new TypeError('MCP mcpServers must be an object');
        }
        return sanitizeMcpConfig({ ...config, mcpServers: { ...servers } }) as LocalMcpConfig;
      }

      readMcpConfig(request: LocalMcpConfigRequest = {}): Promise<LocalMcpConfigResponse> {
        const key = this.#mcpKey(request);
        return this.#pending.then(async () => {
          const saved = await context.state.read(key);
          const fallback = saved.value == null && request.cwd != null
            ? await context.state.read('local-mcp-config:default') : saved;
          return { config: this.#mcpConfig(fallback.value ?? { mcpServers: {} }) };
        });
      }

      writeMcpConfig(request: LocalMcpConfigWriteRequest): Promise<LocalMcpConfigResponse> {
        const key = this.#mcpKey(request);
        const config = this.#mcpConfig(request.config);
        const operation = this.#pending.then(async () => {
          if (!(await context.state.write(key, config)).success) throw new Error('Local MCP configuration was not saved');
          return { config };
        });
        this.#pending = operation.catch(() => {});
        return operation;
      }

      read(request: LocalThreadConfigurationRequest = {}) {
        return this.#pending.then(() => readLocalThreadConfiguration(request, bridge, context.state));
      }

      resolve(request: LocalThreadConfigurationRequest = {}) {
        return this.read(request);
      }

      write(request: LocalThreadConfigurationRequest) {
        const operation = this.#pending.then(() => writeLocalThreadConfiguration(request, bridge, context.state));
        this.#pending = operation.catch(() => {});
        return operation;
      }

      update(request: LocalThreadConfigurationRequest) {
        return this.write(request);
      }
    }

    class CommandKeybindings extends RpcTarget {
      async get() {
        const bindings = getRecoveredPreferences().applicationState['local-command-keybindings'];
        return { bindings: Array.isArray(bindings) ? bindings : [], keymapPath: null, supported: true };
      }
      async update(request: { commandId: string; update: { type: string; accelerator?: string; previousAccelerator?: string } }) {
        requireKey(request.commandId);
        const current = (await this.get()).bindings as { command: string; key: string | null }[];
        const { type, accelerator, previousAccelerator } = request.update;
        let bindings = current.filter(binding => binding.command !== request.commandId);
        const existing = current.filter(binding => binding.command === request.commandId);
        if (type === 'clear') bindings.push({ command: request.commandId, key: null });
        else if (type !== 'reset') {
          if (typeof accelerator !== 'string' || !accelerator.trim()) throw new TypeError('Invalid shortcut accelerator');
          const keys = type === 'set' ? [] : existing.filter(binding => type === 'replace' ? binding.key !== previousAccelerator : type === 'remove' ? binding.key !== accelerator : true);
          if (type !== 'remove') keys.push({ command: request.commandId, key: accelerator });
          bindings = [...bindings, ...keys];
        }
        await writeRecoveredPreference('applicationState', 'local-command-keybindings', bindings);
        return this.get();
      }
      async reset() {
        await writeRecoveredPreference('applicationState', 'local-command-keybindings', []);
        return this.get();
      }
    }

    class Settings extends RpcTarget {
      async read(key: string) { return readSetting(key); }
      async readAll() {
        const saved = getRecoveredPreferences();
        const keys = new Set([...settingKeys, ...Object.keys(saved.applicationState), ...Object.keys(saved.persistedAtoms), ...Object.keys(saved.settings)]);
        const values: Record<string, unknown> = {};
        const configuredValues: Record<string, unknown> = {};
        for (const key of keys) {
          if (!bundledRpc.Wlt(key)) continue;
          const result = readSetting(key);
          Object.defineProperty(values, key, { value: result.effective, enumerable: true });
          Object.defineProperty(configuredValues, key, { value: result.configured, enumerable: true });
        }
        return { values, configuredValues };
      }
      async write(key: string, value: unknown): Promise<void> {
        const definition = settingDefinition(key);
        const next = value === undefined ? undefined : definition.schema.parse(value);
        await writeRecoveredPreference(settingScope(definition), definition.hostStorage.key, next);
      }
      async subscribe(key: string, callback: RpcCallback<[{ configured: unknown; effective: unknown }]>): Promise<Subscription> {
        let previous = readSetting(key);
        const listener = retainCallback(callback);
        const stop = subscribeRecoveredPreferences(() => {
          const next = readSetting(key);
          if (JSON.stringify(previous) === JSON.stringify(next)) return;
          previous = next;
          void notify(listener, next).catch(error => { subscription.unsubscribe(); report(error); });
        });
        const subscription = new Subscription(() => { stop(); release(listener); });
        listener.onRpcBroken?.(() => subscription.unsubscribe());
        try { await notify(listener, previous); } catch (error) { subscription.unsubscribe(); throw error; }
        return subscription;
      }
    }

    const openTargetIcons: Record<string, string> = {
      vscode: 'vscode.png', cursor: 'cursor.png', windsurf: 'windsurf.png', fileManager: 'file-explorer.png',
    };
    function openPreferences(): { global?: string; perPath?: Record<string, string> } {
      return getRecoveredPreferences().applicationState['open-in-target-preferences'] as { global?: string; perPath?: Record<string, string> } ?? {};
    }

    class OpenIn extends RpcTarget {
      async getTargets(request: RecoveredOpenTargetRequest) {
        requireLocalHost(request.hostId);
        const { editors } = await bridge.discoverHost();
        const ids = editors.map(({ id }) => id);
        const saved = openPreferences();
        const configured = (request.cwd ? saved.perPath?.[request.cwd] : undefined) ?? saved.global;
        const preferredTarget = configured && ids.includes(configured) ? configured : ids[0] ?? null;
        return {
          preferredTarget,
          availableTargets: request.deferEnrichment && request.path == null ? [] : ids,
          mode: 'editor' as const,
          targets: editors.map(({ id, label }) => ({
            id, target: id, label,
            icon: new URL(`./original/apps/${openTargetIcons[id] ?? 'file-explorer.png'}`, document.baseURI).href,
            kind: id === 'fileManager' ? 'fileManager' : 'editor',
            available: true,
            ...(id === preferredTarget ? { default: true } : {}),
          })),
        };
      }
      async detectTarget(request: { target: string }): Promise<{ available: boolean }> {
        return { available: (await bridge.discoverHost()).editors.some(({ id }) => id === request.target) };
      }
      async setGlobalPreferredTarget(request: { target: string }): Promise<{ success: true }> {
        if (!(await this.detectTarget(request)).available) throw new HostCapabilityUnavailableError(`open target ${request.target}`);
        await writeRecoveredPreference('applicationState', 'open-in-target-preferences', { ...openPreferences(), global: request.target });
        return { success: true };
      }
      async open(request: RecoveredOpenPathRequest): Promise<{ success: boolean }> {
        requireLocalHost(request.hostId);
        if (request.appPath != null) throw new HostCapabilityUnavailableError('custom native application paths');
        const path = request.path.replace(/^([ab])[\\/]/u, '');
        const resolved = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(path)
          ? path : request.cwd ? childPath(request.cwd, path) : path;
        absolutePath({ path: resolved });
        const targets = await this.getTargets({ cwd: request.cwd ?? null, hostId: request.hostId });
        const target = request.target ?? targets.preferredTarget ?? 'systemDefault';
        await bridge.openHostTarget({ target, path: resolved, line: request.line, column: request.column });
        if (request.persistPreferredTargetPath) {
          const saved = openPreferences();
          await writeRecoveredPreference('applicationState', 'open-in-target-preferences', {
            ...saved, global: target, perPath: { ...saved.perPath, [request.persistPreferredTargetPath]: target },
          });
        }
        return { success: true };
      }
    }

    const catalogSnapshot: LocalRemoteConnectionCatalog = {
      ssh: [], wsl: [], remoteControl: [],
      remoteControlState: { available: false, accessRequired: false, authRequired: false, clientAuthorized: false },
      localRemoteControlClientId: null,
      localRemoteControlEnvironmentId: null,
      localRemoteControlInstallationId: null,
      localRemoteControlEnabled: false,
    };

    async function readCatalog(): Promise<LocalRemoteConnectionCatalog> {
      let wslDistributions: string[];
      try { ({ wslDistributions } = await bridge.discoverHost()); }
      catch (error) { report(error); wslDistributions = []; }
      return {
        ...catalogSnapshot,
        wsl: wslDistributions.map(distro => ({
          hostId: `remote-wsl:${encodeURIComponent(distro)}`,
          displayName: `WSL: ${distro}`,
          source: 'wsl' as const,
          distro,
          autoConnect: false as const,
        })),
      };
    }

    class RemoteCatalog extends RpcTarget {
      async subscribe(callback: RpcCallback<[LocalRemoteConnectionCatalog]>): Promise<Subscription> {
        const listener = retainCallback(callback);
        const subscription = new Subscription(() => release(listener));
        listener.onRpcBroken?.(() => subscription.unsubscribe());
        try { await notify(listener, await readCatalog()); } catch (error) {
          subscription.unsubscribe();
          throw error;
        }
        return subscription;
      }
    }

    class RemoteConnections extends RpcTarget {
      #catalog = new RemoteCatalog();

      get catalog(): RemoteCatalog { return this.#catalog; }
      async refreshRemoteWslConnections() {
        // Discovery advertises installed distributions without creating app-server connections.
        return { remoteWslConnections: (await readCatalog()).wsl };
      }
      async refreshRemoteControl(): Promise<{ remoteControlConnections: never[] }> {
        // This adapter has no configured remote transports; it does not scan system SSH/WSL state.
        return { remoteControlConnections: [] };
      }
      async getState(hostId: string): Promise<LocalConnectionState> {
        return hostId === 'local'
          ? connectionState(await bridge.getStatus())
          : { state: 'disconnected', progress: null, error: null, sshAuthenticationRetryAt: null };
      }
      async setRemoteControlEnabled(request: { enabled: boolean }): Promise<{ remoteControlConnections: never[] }> {
        if (request?.enabled !== false) throw new HostCapabilityUnavailableError('remote control enrollment and transport');
        return { remoteControlConnections: [] };
      }
      authorizeRemoteControl(): never { throw new HostCapabilityUnavailableError('remote control enrollment'); }
      renameRemoteControlEnvironment(_request: unknown): never { throw new HostCapabilityUnavailableError('remote control environments'); }
      deleteRemoteControlEnvironment(_request: unknown): never { throw new HostCapabilityUnavailableError('remote control environments'); }
      setAutoConnect(_request: { hostId: string; autoConnect: boolean }): never {
        throw new HostCapabilityUnavailableError('remote connection auto-connect');
      }
    }

    class ApplicationState extends RpcTarget {
      read(key: string): Promise<{ value: unknown }> {
        requireKey(key);
        return context.state.read(key);
      }
      write(key: string, value: unknown): Promise<{ success: boolean }> {
        requireKey(key);
        return context.state.write(key, value);
      }
    }

    class ExternalAgentImport extends RpcTarget {
      // TODO(stub): DesktopBridge has no native external-agent scanner/import coordinator.
      // Read-only settings queries expose the genuine empty local capability, never fake imported items.
      async detect(request: { hostId?: string } = {}) {
        requireLocalHost(request.hostId);
        return { items: [], unsupportedProjects: [] };
      }
      async readImportedConnectors(request: { hostId?: string } = {}) {
        requireLocalHost(request.hostId);
        return { connectors: [] };
      }
      async readStatus(hostId?: string) {
        requireLocalHost(hostId);
        return { importedSessionCount: 0, latestImportedAtMs: null };
      }
      import(): never { throw new HostCapabilityUnavailableError('external agent import coordinator'); }
    }

    class AppInfo extends RpcTarget {
      async get() {
        const platform = platformInfo();
        return {
          version: options.appInfo?.version ?? packageInfo.version,
          appName: options.appInfo?.appName ?? 'Codex++',
          buildNumber: options.appInfo?.buildNumber ?? null,
          buildFlavor: options.appInfo?.buildFlavor ?? null,
          osName: platform.osName,
          systemVersion: options.appInfo?.osVersion ?? null,
          appIconMedium: null,
          dockIconPreviews: null,
          preloadAttribution: null,
          chatGptDesktopAuthOrigin: undefined,
          chatGptApiBaseUrl: undefined,
        };
      }
      async getSystemInfo() {
        const host = await bridge.discoverHost().catch(error => { report(error); return null; });
        return {
          platform: host?.platform ?? platformInfo().platform,
          osVersion: options.appInfo?.osVersion ?? host?.osVersion ?? null,
          osRelease: options.appInfo?.osRelease ?? host?.osRelease ?? null,
          isSystemBackdropSupported: null,
          isVsCodeRunningInsideWsl: null,
          isCodexRunningInsideWsl: null,
          windowsAccountType: null,
        };
      }
      async getPackagingInfo(): Promise<{ isPackaged: boolean | null }> {
        return { isPackaged: options.appInfo?.isPackaged ?? null };
      }
      async getLocaleInfo(): Promise<{ ideLocale: string; systemLocale: string }> {
        const locale = getRecoveredPreferences().locale;
        return { ideLocale: locale, systemLocale: locale };
      }
      getThirdPartyNotices(): never { throw new HostCapabilityUnavailableError('packaged third-party notices'); }
    }

    class AppServerLifecycle extends RpcTarget {
      getThreadPrewarmPolicy(hostId: string): 'disabled' {
        requireLocalHost(hostId);
        return 'disabled';
      }
      restart(hostId: string): never {
        requireLocalHost(hostId);
        // TODO(stub): DesktopBridge has no explicit restart operation; do not mutate provider configuration to simulate one.
        throw new HostCapabilityUnavailableError('app-server restart');
      }
      async checkBedrockGovCloudRequirements(_hostId: string): Promise<{ status: 'unavailable' }> {
        return { status: 'unavailable' };
      }
    }

    type AccessChange = { type: 'identity' } | { type: 'query'; source: string; accountId?: string };
    let publishAccessIdentity = () => {};
    class AccessInputs extends RpcTarget {
      #listeners = new Map<RpcCallback<[AccessChange]>, Subscription>();

      constructor() {
        super();
        publishAccessIdentity = () => { void this.#publish({ type: 'identity' }).catch(report); };
      }

      async readAccountInfo(_force = false) {
        const session = await bridge.getSession();
        // A valid local identity opens configuration even before a provider key
        // exists. Session.ready still controls inference readiness separately.
        localWorkspacePolicyForSession(session);
        return {
          status: 'ready',
          data: { accountId: null, userId: null, authenticatedUserId: null, plan: null, email: null, computeResidency: null, hasChatGptToken: false },
        } as const;
      }
      async readLocalChatGptAuth() {
        const session = await bridge.getSession();
        localWorkspacePolicyForSession(session);
        return { status: 'ready', data: null } as const;
      }
      async readAccounts(_locale: string, _force = false) {
        return { status: 'unavailable', reason: 'unsupported-auth' } as const;
      }
      async readWorkspaceSettings(_request: unknown, _force = false) {
        return { status: 'unavailable', reason: 'unsupported-auth' } as const;
      }
      async publishChatGptRequestProfile(_profile: unknown): Promise<false> { return false; }
      async invalidate(source: string): Promise<void> {
        if (!['account-info', 'accounts-check', 'workspace-settings'].includes(source)) throw new TypeError('Unknown account input source');
        await this.#publish({ type: 'query', source });
      }
      async invalidateWorkspaceSettings(accountId: string): Promise<void> {
        await this.#publish({ type: 'query', source: 'workspace-settings', accountId });
      }
      async subscribe(callback: RpcCallback<[AccessChange]>): Promise<Subscription> {
        const listener = retainCallback(callback);
        const subscription = new Subscription(() => { this.#listeners.delete(listener); release(listener); });
        this.#listeners.set(listener, subscription);
        listener.onRpcBroken?.(() => subscription.unsubscribe());
        return subscription;
      }
      async #publish(change: AccessChange): Promise<void> {
        await Promise.all([...this.#listeners.keys()].map(listener => notify(listener, change).catch(error => {
          this.#listeners.get(listener)?.unsubscribe();
          report(error);
        })));
      }
    }

    class ThreadProjectAssignments extends RpcTarget {
      #pending: Promise<unknown> = Promise.resolve();
      #removed = new Set<string>();

      #enqueue<T>(run: () => Promise<T>): Promise<T> {
        const operation = this.#pending.then(run);
        this.#pending = operation.catch(() => {});
        return operation;
      }

      async getThreadStartProjectId(assignment: LocalThreadMembership['assignment'] & { threadId?: string }): Promise<string | null> {
        await this.#pending;
        if (assignment == null) return null;
        if (assignment.threadId != null) {
          const stored = (await context.state.read('thread-start-project-ids')).value;
          if (stored && typeof stored === 'object' && Object.hasOwn(stored, assignment.threadId)) {
            const id = (stored as Record<string, unknown>)[assignment.threadId];
            return typeof id === 'string' ? id : null;
          }
        }
        if (assignment.projectKind !== 'local') return null;
        const stored = (await context.state.read('local-projects')).value;
        const project = stored && typeof stored === 'object'
          ? (stored as Record<string, { name?: string; rootPaths?: string[] }>)[assignment.projectId] : undefined;
        if (!project?.rootPaths?.length) return null;
        try {
          const { project: imported } = await bridge.request<ProjectImportResponse>('project/import', {
            name: project.name ?? assignment.projectId,
            roots: project.rootPaths.map(path => ({ path: absolutePath({ path }) })),
            idempotencyKey: assignment.projectId,
          });
          requireKey(imported.id);
          return imported.id;
        } catch (error) {
          if ((error as { code?: unknown })?.code === -32601) return null;
          throw error;
        }
      }

      setThreadStartProjectId(request: LocalThreadStartProjectRequest) {
        return this.#enqueue(async () => {
          requireLocalHost(request.hostId);
          requireKey(request.threadId);
          if (request.projectId !== null) requireKey(request.projectId);
          const stored = (await context.state.read('thread-start-project-ids')).value;
          const ids = { ...(stored && typeof stored === 'object' ? stored : {}), [request.threadId]: request.projectId };
          if (!(await context.state.write('thread-start-project-ids', ids)).success) throw new Error('Thread start project ID was not saved');
        });
      }

      async #read(): Promise<LocalThreadMemberships> {
        const [assignments, projectless] = await Promise.all([
          context.state.read('thread-project-assignments'), context.state.read('projectless-thread-ids'),
        ]);
        const values = assignments.value;
        return {
          assignments: Object.fromEntries(Object.entries(typeof values === 'object' && values !== null && !Array.isArray(values) ? values : {})
            .filter((entry): entry is [string, NonNullable<LocalThreadMembership['assignment']>] => {
              const value = entry[1];
              return typeof value === 'object' && value !== null && typeof value.projectId === 'string'
                && (value.projectKind === 'local' || value.projectKind === 'remote');
            })),
          projectlessThreadIds: Array.isArray(projectless.value) ? projectless.value.filter((id): id is string => typeof id === 'string') : [],
        };
      }

      readMemberships(): Promise<LocalThreadMemberships> { return this.#pending.then(() => this.#read()); }

      #update(input: LocalThreadMembershipRequest[] | ((state: LocalThreadMemberships) => LocalThreadMembershipRequest[]), onlyUnassigned = false) {
        return this.#enqueue(async () => {
          const state = await this.#read();
          const updates = typeof input === 'function' ? input(state) : input;
          const ids = new Set(state.projectlessThreadIds);
          const previous = await this.#read();
          const undo = new Map<string, LocalThreadMembershipRequest>();
          for (const request of updates) {
            requireLocalHost(request.hostId);
            requireKey(request.threadId);
            if (onlyUnassigned && (Object.hasOwn(state.assignments, request.threadId) || ids.has(request.threadId))) continue;
            if (!undo.has(request.threadId)) undo.set(request.threadId, {
              threadId: request.threadId, assignment: state.assignments[request.threadId] ?? null, projectless: ids.has(request.threadId),
            });
            if (request.assignment !== undefined) {
              if (request.assignment === null) delete state.assignments[request.threadId];
              else {
                if (request.assignment.projectKind !== 'local' && request.assignment.projectKind !== 'remote') throw new TypeError('Invalid project kind');
                requireKey(request.assignment.projectId);
                Object.defineProperty(state.assignments, request.threadId, { value: request.assignment, enumerable: true, configurable: true, writable: true });
              }
            }
            if (request.projectless === true) ids.add(request.threadId);
            else if (request.projectless === false) ids.delete(request.threadId);
          }
          if (!(await context.state.write('thread-project-assignments', state.assignments)).success) throw new Error('Thread project assignments were not saved');
          try {
            if (!(await context.state.write('projectless-thread-ids', [...ids])).success) throw new Error('Projectless thread membership was not saved');
          } catch (error) {
            await context.state.write('thread-project-assignments', previous.assignments);
            throw error;
          }
          const memberships = Object.fromEntries([...undo.keys()].map(threadId => [threadId, {
            assignment: state.assignments[threadId] ?? null, projectless: ids.has(threadId),
          }]));
          window.dispatchEvent(new MessageEvent('message', { data: { type: 'thread-project-memberships-updated', memberships } }));
          return [...undo.values()];
        });
      }

      setAssignment(request: LocalThreadMembershipRequest) { return this.#update([{ threadId: request.threadId, hostId: request.hostId, assignment: request.assignment }]); }
      setProjectless(request: LocalThreadMembershipRequest) { return this.#update([{ threadId: request.threadId, hostId: request.hostId, projectless: request.projectless }]); }
      setMembership(request: LocalThreadMembershipRequest) { return this.#update([request]); }
      restoreMemberships(memberships: LocalThreadMembershipRequest[]) {
        return this.#update(memberships);
      }
      assignIfUnassigned(memberships: LocalThreadMembershipRequest[]) { return this.#update(memberships, true); }
      moveLocalProjectThreadsToProjectless(projectId: string) {
        requireKey(projectId);
        return this.#update(state => Object.entries(state.assignments).flatMap(([threadId, assignment]) =>
          assignment.projectKind === 'local' && assignment.projectId === projectId
            ? [{ threadId, assignment: null, projectless: true }] : []));
      }
      reset() {
        return this.#update(state => [...new Set([...Object.keys(state.assignments), ...state.projectlessThreadIds])]
          .map(threadId => ({ threadId, assignment: null, projectless: false })));
      }
      async flush(): Promise<void> { await this.#pending; }
      async updateProjectlessThread(request: LocalProjectlessThreadUpdate): Promise<void> {
        requireLocalHost(request.hostId);
        requireKey(request.threadId);
        if (this.#removed.has(request.threadId)) return;
        if (request.projectless !== undefined) await this.setProjectless(request);
        await this.#enqueue(async () => {
          const removed = request.projectless === false && request.outputDirectory == null;
          const keys: string[] = [];
          for (const [key, path] of [
            ['thread-projectless-output-directories', request.outputDirectory],
            ['thread-workspace-root-hints', removed ? null : request.workspaceRoot],
          ] as const) {
            if (path === undefined) continue;
            if (path !== null) absolutePath({ path });
            const stored = (await context.state.read(key)).value;
            const paths: Record<string, unknown> = { ...(stored && typeof stored === 'object' ? stored : {}) };
            if (path === null) delete paths[request.threadId];
            else Object.defineProperty(paths, request.threadId, { value: path, enumerable: true });
            if (!(await context.state.write(key, paths)).success) throw new Error(`Thread path hint was not saved: ${key}`);
            keys.push(key);
          }
          if (removed) this.#removed.add(request.threadId);
          if (request.projectless !== undefined) keys.push('projectless-thread-ids');
          if (keys.length) window.dispatchEvent(new MessageEvent('message', { data: { type: 'global-state-updated', keys } }));
        });
      }
    }

    class Projects extends RpcTarget {
      #pending: Promise<unknown> = Promise.resolve();

      createLocal(request: { name: string; sources?: string[]; parentDir?: string; appearance?: unknown; setActive?: boolean; initializeDefaultWorkspaceGitRepository?: boolean }) {
        const operation = this.#pending.then(async () => {
          const { rootPaths } = await bridge.createLocalProject(request);
          if (rootPaths.length === 0) throw new Error('Project creation returned no directory');
          const stored = await context.state.read('local-projects');
          const projects = typeof stored.value === 'object' && stored.value !== null && !Array.isArray(stored.value)
            ? stored.value as Record<string, unknown> : {};
          const projectId = crypto.randomUUID();
          const now = Date.now();
          const name = request.name.trim() || rootPaths[0].split(/[\\/]/u).filter(Boolean).at(-1) || 'Project';
          const save = async (key: string, value: unknown) => {
            if (!(await context.state.write(key, value)).success) throw new Error(`Project state was not saved: ${key}`);
          };
          const savedRoots = (await context.state.read('local-workspace-roots')).value;
          const roots = Array.isArray(savedRoots) ? savedRoots.filter((value): value is string => typeof value === 'string') : [];
          await save('local-workspace-roots', [...new Set([...roots, ...rootPaths])]);
          await save('electron-saved-workspace-roots', [...new Set([...roots, ...rootPaths])]);
          if (request.appearance != null) {
            const appearances = (await context.state.read('project-appearances')).value;
            await save('project-appearances', { ...(typeof appearances === 'object' && appearances !== null ? appearances : {}), [projectId]: request.appearance });
          }
          const order = (await context.state.read('project-order')).value;
          await save('project-order', [projectId, ...(Array.isArray(order) ? order : [])]);
          await save('local-projects', { ...projects, [projectId]: { id: projectId, name, rootPaths, createdAt: now, updatedAt: now } });
          if (request.setActive !== false) {
            await save('active-workspace-root', rootPaths[0]);
            await save('active-workspace-roots', rootPaths);
            await save('selected-project', { type: 'local', projectId });
          }
          return { projectId, rootPaths };
        });
        this.#pending = operation.catch(() => {});
        return operation;
      }
    }

    class WorkspaceRoots extends RpcTarget {
      #reads = new Map<string, AbortController>();
      #cancelAll = () => { for (const controller of this.#reads.values()) controller.abort(); };

      constructor() {
        super();
        cleanupCallbacks.add(this.#cancelAll);
      }

      async read(requestId: string, request: WorkspaceRootReadOptions = {}) {
        requireLocalHost(request.hostId);
        const controller = new AbortController();
        this.#reads.get(requestId)?.abort();
        this.#reads.set(requestId, controller);
        try {
          const [storedRoots, storedLabels] = await Promise.all([
            context.state.read('local-workspace-roots'),
            context.state.read('electron-workspace-root-labels'),
          ]);
          controller.signal.throwIfAborted();
          const roots = Array.isArray(storedRoots.value)
            ? [...new Set(storedRoots.value.filter((root): root is string => typeof root === 'string' && root.length > 0))]
            : [];
          const labels: Record<string, string> = {};
          if (typeof storedLabels.value === 'object' && storedLabels.value !== null) {
            for (const [root, label] of Object.entries(storedLabels.value)) {
              if (roots.includes(root) && typeof label === 'string') Object.defineProperty(labels, root, { value: label, enumerable: true });
            }
          }
          // TODO(stub): fs/* does not expose realpath, so canonicalPathByRoot is intentionally absent.
          return { roots, labels };
        } finally {
          if (this.#reads.get(requestId) === controller) this.#reads.delete(requestId);
        }
      }
      cancel(requestId: string): void { this.#reads.get(requestId)?.abort(); }
    }

    async function requireDirectory(path: string, signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted();
      const metadata = await bridge.request<FsGetMetadataResponse>('fs/getMetadata', { path });
      signal?.throwIfAborted();
      if (!metadata.isDirectory || metadata.isSymlink) throw new Error('The selected workspace must be a real directory');
    }

    function childPath(root: string, ...segments: string[]): string {
      const separator = /^[A-Za-z]:[\\/]|^\\\\/u.test(root) ? '\\' : '/';
      return `${root.replace(/[\\/]+$/u, '')}${separator}${segments.join(separator)}`;
    }

    let choosingRoot: Promise<string> | undefined;
    async function projectlessRoot(allowChoose: boolean, signal?: AbortSignal): Promise<string> {
      signal?.throwIfAborted();
      const [active, saved] = await Promise.all([
        context.state.read('active-workspace-root'),
        context.state.read('local-workspace-roots'),
      ]);
      signal?.throwIfAborted();
      const roots = Array.isArray(saved.value)
        ? saved.value.filter((root): root is string => typeof root === 'string' && root.length > 0)
        : [];
      const configured = typeof active.value === 'string' && active.value.length > 0 ? active.value : roots[0];
      if (configured !== undefined) {
        const root = absolutePath({ path: configured });
        await requireDirectory(root, signal);
        return root;
      }
      if (!allowChoose) throw new HostCapabilityUnavailableError('a selected local workspace folder');
      choosingRoot ??= (async () => {
        const selected = await bridge.chooseWorkspace();
        if (selected === null) throw new DOMException('Workspace selection was cancelled', 'AbortError');
        const root = absolutePath({ path: selected });
        await requireDirectory(root);
        const current = await context.state.read('local-workspace-roots');
        const existing = Array.isArray(current.value)
          ? current.value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
          : [];
        const rootWrite = await context.state.write('local-workspace-roots', [...new Set([...existing, root])]);
        if (!rootWrite.success) throw new Error('Failed to persist the selected workspace folder');
        const activeWrite = await context.state.write('active-workspace-root', root);
        if (!activeWrite.success) throw new Error('Failed to persist the active workspace folder');
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'workspace-root-options-updated' } }));
        return root;
      })().finally(() => { choosingRoot = undefined; });
      const root = await choosingRoot;
      signal?.throwIfAborted();
      return root;
    }

    type ProjectlessRequest = {
      hostId?: string;
      createSplitDirectories?: boolean;
      directoryName?: string | null;
      prompt?: string | null;
    };
    type ProjectlessPaths = { cwd: string; outputDirectory: string; workspaceRoot: string };

    class DirectoryOperation extends RpcTarget {
      #controller = new AbortController();
      #result: Promise<ProjectlessPaths>;
      #cancel = () => this.#controller.abort();

      constructor(run: (signal: AbortSignal) => Promise<ProjectlessPaths>) {
        super();
        cleanupCallbacks.add(this.#cancel);
        this.#result = Promise.resolve().then(() => run(this.#controller.signal))
          .finally(() => cleanupCallbacks.delete(this.#cancel));
        void this.#result.catch(() => {});
      }

      wait(): Promise<ProjectlessPaths> { return this.#result; }
      [Symbol.dispose](): void { this.#cancel(); }
    }

    class ProjectlessThreads extends RpcTarget {
      async readWorkspaceRoot(): Promise<{ workspaceRoot: string }> {
        return { workspaceRoot: await projectlessRoot(false) };
      }

      createPaths(request: ProjectlessRequest = {}): DirectoryOperation {
        requireLocalHost(request.hostId);
        if (request.createSplitDirectories != null && typeof request.createSplitDirectories !== 'boolean') {
          throw new TypeError('createSplitDirectories must be a boolean');
        }
        const name = request.directoryName ?? request.prompt;
        if (name != null && typeof name !== 'string') throw new TypeError('The task directory name must be a string');
        return new DirectoryOperation(async signal => {
          const workspaceRoot = await projectlessRoot(true, signal);
          const now = new Date();
          const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
          const dateRoot = childPath(workspaceRoot, date);
          await bridge.request('fs/createDirectory', { path: dateRoot, recursive: true });
          await requireDirectory(dateRoot, signal);
          const words = name?.toLowerCase().match(/[a-z0-9]+/gu);
          const slug = (words?.slice(0, request.directoryName == null ? 6 : undefined).join('-') || 'new-chat').slice(0, 80);
          const cwd = childPath(dateRoot, `${slug}-${crypto.randomUUID()}`);
          signal.throwIfAborted();
          // Exclusive mkdir creates a real task folder; no project id or thread id is synthesized here.
          await bridge.request('fs/createDirectory', { path: cwd, recursive: false });
          await requireDirectory(cwd, signal);
          const split = request.createSplitDirectories !== false;
          const outputDirectory = split ? childPath(cwd, 'outputs') : cwd;
          if (split) {
            for (const path of [outputDirectory, childPath(cwd, 'work')]) {
              signal.throwIfAborted();
              await bridge.request('fs/createDirectory', { path, recursive: false });
              await requireDirectory(path, signal);
            }
          }
          signal.throwIfAborted();
          // Cancellation leaves any directories already created intact, as in the original operation.
          return { cwd, outputDirectory, workspaceRoot };
        });
      }
    }

    function outputLine(output: string, label: string): string {
      const value = output.replace(/\r?\n$/u, '');
      if (!value || /[\r\n\0]/u.test(value)) throw new Error(`Git returned an invalid ${label}`);
      return value;
    }

    async function readGit(directory: string, args: string[]): Promise<CommandExecResponse> {
      return bridge.request<CommandExecResponse>('command/exec', {
        command: ['git', '-C', directory, ...args],
        cwd: directory,
        timeoutMs: 8_000,
        env: { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C' },
      });
    }

    class RepositoryOrigins extends RpcTarget {
      async read(request: { dirs?: string[]; hostId?: string } = {}, _source?: string) {
        requireLocalHost(request.hostId);
        const configured = request.dirs === undefined ? await context.state.read('local-workspace-roots') : undefined;
        const dirs: unknown = request.dirs ?? configured?.value ?? [];
        if (!Array.isArray(dirs) || dirs.length > 64 || dirs.some(dir => typeof dir !== 'string')) {
          throw new TypeError('Repository discovery requires at most 64 explicit workspace paths');
        }
        const origins: { dir: string; root: string; commonDir: string; originUrl: string | null }[] = [];
        for (const candidate of new Set(dirs as string[])) {
          try {
          const dir = absolutePath({ path: candidate });
          if (/[\r\n\0]/u.test(dir)) throw new TypeError('Repository paths must not contain line breaks or null bytes');
          // New folders are valid projects even without Git or an installed git executable.
          try { await bridge.request('fs/getMetadata', { path: childPath(dir, '.git') }); }
          catch (error) {
            if (/ENOENT|not found|does not exist|os error 2|cannot find/iu.test(errorValue(error).message)) continue;
            throw error;
          }
          const repository = await readGit(dir, ['rev-parse', '--show-toplevel']);
          if (repository.exitCode !== 0) {
            if (/not a git repository|must be run in a work tree/iu.test(repository.stderr)) continue;
            throw new Error(`Git repository discovery failed with exit code ${repository.exitCode}`);
          }
          const root = absolutePath({ path: outputLine(repository.stdout, 'repository root') });
          const common = await readGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
          if (common.exitCode !== 0) throw new Error(`Git common directory lookup failed with exit code ${common.exitCode}`);
          const commonDir = absolutePath({ path: outputLine(common.stdout, 'common directory') });
          const remote = await readGit(dir, ['config', '--local', '--get', 'remote.origin.url']);
          if (remote.exitCode !== 0 && remote.exitCode !== 1) {
            throw new Error(`Git origin lookup failed with exit code ${remote.exitCode}`);
          }
          const originUrl = remote.exitCode === 1 ? null : outputLine(remote.stdout, 'origin URL');
          origins.push({ dir, root, commonDir, originUrl });
          } catch (error) { report(error); }
        }
        // TODO(stub): DesktopBridge does not expose the host home directory; this consumer only reads origins.
        return { origins, homeDir: null };
      }
    }

    class DynamicToolCalls extends RpcTarget {
      #claims = new Set<string>();

      tryClaimExecution(request: { callId: string; hostId: string; threadId: string; turnId: string }): boolean {
        requireLocalHost(request.hostId);
        const key = JSON.stringify([request.hostId, request.threadId, request.turnId, request.callId]);
        if (this.#claims.has(key)) return false;
        this.#claims.add(key);
        if (this.#claims.size > 1024) {
          const oldest = this.#claims.values().next().value;
          if (oldest !== undefined) this.#claims.delete(oldest);
        }
        return true;
      }
    }

    class WorkspaceFiles extends RpcTarget {
      async readBinary(request: WorkspacePathRequest & { maxBytes?: number }) {
        requireLocalHost(request.hostId);
        let source = request.path;
        if (typeof source !== 'string' || !source) throw new TypeError('Image path is required');
        if (source.startsWith('app://fs/@fs/')) source = decodeURIComponent(source.slice('app://fs/@fs/'.length));
        const image = await bridge.readLocalImage(source);
        if (request.maxBytes != null && image.contentsBase64.length * 3 / 4 > request.maxBytes + 2) {
          throw new Error('Image exceeds the requested preview size limit');
        }
        return image;
      }
      async readText(request: WorkspacePathRequest): Promise<{ contents: string }> {
        const result = await bridge.request<FsReadFileResponse>('fs/readFile', { path: absolutePath(request) });
        const bytes = Uint8Array.from(atob(result.dataBase64), character => character.charCodeAt(0));
        return { contents: new TextDecoder().decode(bytes) };
      }
      async createDirectory(request: WorkspacePathRequest): Promise<void> {
        await bridge.request('fs/createDirectory', { path: absolutePath(request), recursive: true });
      }
      async getMetadata(request: WorkspacePathRequest & { includeCanonicalPath?: boolean }) {
        const metadata = await bridge.request<FsGetMetadataResponse>('fs/getMetadata', { path: absolutePath(request) });
        return metadata.isDirectory ? { kind: 'directory', canonicalPath: null } : metadata.isFile ? { kind: 'file', canonicalPath: null } : null;
      }
      async inspect(request: WorkspacePathRequest & { contentSampleByteLimit?: number; contentSampleMaxFileBytes?: number }) {
        const metadata = await bridge.request<FsGetMetadataResponse>('fs/getMetadata', { path: absolutePath(request) });
        return {
          createdAtMs: metadata.createdAtMs > 0 ? metadata.createdAtMs : null,
          isFile: metadata.isFile,
          mtimeMs: metadata.modifiedAtMs,
          sizeBytes: null,
          contentKind: null,
          contentSample: null,
        };
      }
      // TODO(stub): native temporary files, bounded samples, sizes, etags and save dialogs require additional bridge operations.
    }

    class RequestUserInputAutoResolution extends RpcTarget {
      #presented = new Set<string>();
      #activity = new Map<string, number>();
      #snoozed = new Set<string>();
      #key(request: { hostId?: string; conversationId: string }): string {
        requireLocalHost(request.hostId);
        requireKey(request.conversationId);
        return request.conversationId;
      }
      setConversationPresented(request: { hostId?: string; conversationId: string; presented: boolean }): void {
        const id = this.#key(request);
        if (request.presented) this.#presented.add(id);
        else this.#presented.delete(id);
      }
      recordConversationActivity(request: { hostId?: string; conversationId: string }): void {
        this.#activity.set(this.#key(request), Date.now());
      }
      snooze(request: { hostId?: string; conversationId: string; requestId: string }): void {
        this.#snoozed.add(JSON.stringify([this.#key(request), request.requestId]));
      }
    }

    class QueuedFollowUps extends RpcTarget {
      #pending: Promise<unknown> = Promise.resolve();
      async read(): Promise<{ state: LocalQueuedFollowUpsState }> {
        await this.#pending;
        const { value } = await context.state.read('queued-follow-ups');
        return { state: value && typeof value === 'object' && !Array.isArray(value)
          ? structuredClone(value as LocalQueuedFollowUpsState) : {} };
      }
      write(state: LocalQueuedFollowUpsState): Promise<void> {
        const snapshot = structuredClone(state);
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return Promise.reject(new TypeError('Queued follow-up state must be an object'));
        const operation = this.#pending.then(async () => {
          if (!(await context.state.write('queued-follow-ups', snapshot)).success) throw new Error('Queued follow-up state was not saved');
          window.postMessage({ type: 'global-state-updated', keys: ['queued-follow-ups'] }, '*');
        });
        this.#pending = operation.catch(() => {});
        return operation;
      }
    }

    class QueuedSendLocks extends RpcTarget {
      #tails = new Map<string, Promise<void>>();
      #entries = new Map<string, { messageId: string; released: boolean; unlock: () => void; result: Promise<{ acquired: boolean }> }>();
      #sent = new Set<string>();
      #closed = false;

      constructor() {
        super();
        cleanupCallbacks.add(() => {
          this.#closed = true;
          for (const entry of this.#entries.values()) { entry.released = true; entry.unlock(); }
          this.#entries.clear();
          this.#tails.clear();
          this.#sent.clear();
        });
      }
      #key(request: LocalQueuedSendLockRequest): string {
        requireKey(request.conversationId);
        requireKey(request.messageId);
        requireKey(request.lockId);
        return JSON.stringify([request.conversationId, request.lockId]);
      }
      acquire(request: LocalQueuedSendLockRequest): Promise<{ acquired: boolean }> {
        const key = this.#key(request);
        const existing = this.#entries.get(key);
        if (existing) return existing.messageId === request.messageId ? existing.result : Promise.resolve({ acquired: false });
        const messageKey = JSON.stringify([request.conversationId, request.messageId]);
        if (this.#closed || this.#sent.has(messageKey)) return Promise.resolve({ acquired: false });
        const previous = this.#tails.get(request.conversationId) ?? Promise.resolve();
        let unlock!: () => void;
        const gate = new Promise<void>(resolve => { unlock = resolve; });
        const tail = previous.then(() => gate);
        const entry = { messageId: request.messageId, released: false, unlock,
          result: Promise.resolve({ acquired: false }) };
        entry.result = previous.then(() => {
          const acquired = !this.#closed && !entry.released && !this.#sent.has(messageKey);
          if (!acquired) { entry.released = true; unlock(); }
          return { acquired };
        });
        this.#entries.set(key, entry);
        this.#tails.set(request.conversationId, tail);
        void tail.then(() => {
          if (this.#tails.get(request.conversationId) === tail) this.#tails.delete(request.conversationId);
          if (this.#entries.get(key) === entry) this.#entries.delete(key);
        });
        return entry.result;
      }
      async release(request: LocalQueuedSendLockRelease): Promise<void> {
        const key = this.#key(request);
        const entry = this.#entries.get(key);
        if (!entry || entry.messageId !== request.messageId || entry.released) return;
        entry.released = true;
        if (request.sent) {
          this.#sent.add(JSON.stringify([request.conversationId, request.messageId]));
          if (this.#sent.size > 4096) this.#sent.delete(this.#sent.values().next().value!);
        }
        entry.unlock();
      }
    }

    class CustomAvatars extends RpcTarget {
      #pending: Promise<unknown> = Promise.resolve();
      #read(): LocalCustomPet[] {
        const saved = getRecoveredPreferences().applicationState.customPets;
        return Array.isArray(saved) ? saved.filter((pet): pet is LocalCustomPet =>
          pet != null && typeof pet === 'object' && typeof pet.id === 'string'
          && typeof pet.displayName === 'string' && typeof pet.spritesheetDataUrl === 'string') : [];
      }
      async load() { await this.#pending; return { avatars: this.#read(), avatarDirectory: null }; }
      async listCustomPets() { return (await this.load()).avatars; }
      async loadAvatar(id: string) { return (await this.listCustomPets()).find(pet => pet.id === id) ?? null; }
      create(request: Partial<LocalCustomPet>): Promise<LocalCustomPet> {
        if (typeof request.displayName !== 'string' || !request.displayName.trim()) throw new TypeError('A pet display name is required');
        if (typeof request.spritesheetDataUrl !== 'string' || !/^data:image\/(?:png|webp|avif);base64,/u.test(request.spritesheetDataUrl)) {
          throw new TypeError('A custom pet requires a PNG, WebP, or AVIF spritesheet data URL');
        }
        const pet: LocalCustomPet = { id: request.id?.startsWith('custom:') ? request.id : `custom:${crypto.randomUUID()}`,
          displayName: request.displayName.trim(), description: request.description ?? '', spritesheetDataUrl: request.spritesheetDataUrl,
          spriteVersionNumber: request.spriteVersionNumber ?? 2, updatedAt: Date.now() };
        const operation = this.#pending.then(async () => {
          await writeRecoveredPreference('applicationState', 'customPets', [...this.#read().filter(item => item.id !== pet.id), pet]);
          return pet;
        });
        this.#pending = operation.catch(() => {});
        return operation;
      }
      createCustomPet(request: Partial<LocalCustomPet>) { return this.create(request); }
      delete(request: string | { id: string }): Promise<void> {
        const id = typeof request === 'string' ? request : request.id;
        requireKey(id);
        const operation = this.#pending.then(() => writeRecoveredPreference('applicationState', 'customPets', this.#read().filter(pet => pet.id !== id)));
        this.#pending = operation.catch(() => {});
        return operation;
      }
      deleteCustomPet(request: string | { id: string }) { return this.delete(request); }
    }

    class GlobalDictationHotkeys extends RpcTarget {
      async read() {
        const saved = getRecoveredPreferences().applicationState['local-dictation-hotkeys'] as Record<string, unknown> | undefined;
        return { supported: true, registered: false, configuredHotkey: typeof saved?.hold === 'string' ? saved.hold : null,
          configuredToggleHotkey: typeof saved?.toggle === 'string' ? saved.toggle : null };
      }
      async set(request: { kind: 'hold' | 'toggle'; hotkey: string | null }) {
        if (!['hold', 'toggle'].includes(request.kind) || (request.hotkey !== null && (typeof request.hotkey !== 'string' || !request.hotkey.trim()))) {
          throw new TypeError('Invalid dictation shortcut');
        }
        const state = await this.read();
        const opposite = request.kind === 'hold' ? state.configuredToggleHotkey : state.configuredHotkey;
        if (request.hotkey && request.hotkey === opposite) return { success: false, errorCode: 'shortcut-conflict', error: 'Choose a different shortcut', state };
        await writeRecoveredPreference('applicationState', 'local-dictation-hotkeys', {
          hold: request.kind === 'hold' ? request.hotkey : state.configuredHotkey,
          toggle: request.kind === 'toggle' ? request.hotkey : state.configuredToggleHotkey,
        });
        // This stores the user's choice; OS-wide key interception is not asserted here.
        return { success: true, state: await this.read() };
      }
    }

    class DictationHistory extends RpcTarget {
      #pending: Promise<unknown> = Promise.resolve();
      #read(): LocalDictationRecording[] {
        const saved = getRecoveredPreferences().applicationState['local-dictation-history'];
        return Array.isArray(saved) ? saved.filter((item): item is LocalDictationRecording =>
          item != null && typeof item === 'object' && typeof item.id === 'string'
          && typeof item.text === 'string' && typeof item.sizeBytes === 'number'
          && Array.isArray(item.chunks) && item.chunks.every((chunk: unknown) => typeof chunk === 'string')) : [];
      }
      #mutate(update: (items: LocalDictationRecording[]) => LocalDictationRecording[]) {
        const operation = this.#pending.then(() => writeRecoveredPreference('applicationState', 'local-dictation-history', update(this.#read()).slice(0, 20)));
        this.#pending = operation.catch(() => {});
        return operation;
      }
      async list() {
        await this.#pending;
        return { supported: true, items: this.#read().map(({ chunks: _chunks, ...item }) => item) };
      }
      appendChunk(request: Record<string, unknown> & { id: string; chunk: Uint8Array; sequence: number }) {
        requireKey(request.id);
        const bytes = Uint8Array.from(request.chunk);
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        const encoded = btoa(binary);
        return this.#mutate(items => {
          const current = items.find(item => item.id === request.id) ?? {
            id: request.id, text: '', createdAtMs: typeof request.createdAtMs === 'number' ? request.createdAtMs : Date.now(),
            sizeBytes: 0, mimeType: typeof request.mimeType === 'string' ? request.mimeType : 'audio/webm', status: 'recording' as const, chunks: [],
            ...Object.fromEntries(['dictationSessionId', 'dictationAttemptId', 'ownerAccountId', 'ownerUserId', 'language', 'productSurface', 'surface']
              .flatMap(key => typeof request[key] === 'string' ? [[key, request[key]]] : [])),
          };
          if (current.chunks[request.sequence] !== undefined) return items;
          if (!Number.isSafeInteger(request.sequence) || request.sequence !== current.chunks.length) {
            throw new RangeError('Dictation chunks must arrive in consecutive sequence order');
          }
          // Base64 needs 4/3 of the audio size; leave room below the preference store's 4 MiB JSON limit.
          if (current.sizeBytes + bytes.length > 1024 * 1024 || items.reduce((total, item) => total + item.sizeBytes, 0) + bytes.length > 2 * 1024 * 1024) {
            throw new RangeError('Local dictation history is limited to 1 MiB per recording and 2 MiB total; remove old recordings first');
          }
          const chunks = [...current.chunks]; chunks[request.sequence] = encoded;
          return [{ ...current, chunks, sizeBytes: current.sizeBytes + bytes.length }, ...items.filter(item => item.id !== request.id)];
        });
      }
      finalize(request: { id: string; cancelled?: boolean; durationMs?: number }) {
        return this.#mutate(items => items.map(item => item.id === request.id ? { ...item,
          status: request.cancelled ? 'cancelled' : 'completed', durationMs: request.durationMs ?? 0 } : item));
      }
      setTranscript(request: { id: string; text: string; transcription?: unknown }) {
        if (typeof request.text !== 'string') throw new TypeError('Dictation transcript must be text');
        return this.#mutate(items => items.map(item => item.id === request.id ? { ...item, text: request.text } : item));
      }
      delete(request: { id: string }) { return this.#mutate(items => items.filter(item => item.id !== request.id)); }
      async readAudio(request: { id: string }) {
        await this.#pending;
        const recording = this.#read().find(item => item.id === request.id);
        if (!recording) throw new Error('The dictation recording no longer exists');
        const audio = recording.chunks.flatMap(chunk => [...atob(chunk)].map(character => character.charCodeAt(0)));
        const { chunks: _chunks, ...metadata } = recording;
        return { ...metadata, audio: Uint8Array.from(audio) };
      }
      async download(request: { id: string }) {
        const recording = await this.readAudio(request);
        const url = URL.createObjectURL(new Blob([Uint8Array.from(recording.audio)], { type: recording.mimeType }));
        try {
          const anchor = document.createElement('a'); anchor.href = url; anchor.download = `dictation-${recording.createdAtMs}.webm`;
          anchor.click();
        } finally { window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
      }
    }

    class AudioSettings extends RpcTarget {
      async listMicrophones() {
        const devices = await navigator.mediaDevices?.enumerateDevices() ?? [];
        return devices.filter(device => device.kind === 'audioinput').map(({ deviceId, label, groupId }) => ({ deviceId, label, groupId }));
      }
      async readDictionary() { return readSetting('dictationDictionary').effective; }
      async writeDictionary(entries: string[]) { await new Settings().write('dictationDictionary', entries); return this.readDictionary(); }
      async readVoice() { return getRecoveredPreferences().applicationState['local-voice-name'] ?? 'sol'; }
      async writeVoice(voice: string) { requireKey(voice); await writeRecoveredPreference('applicationState', 'local-voice-name', voice); }
    }

    class HttpFetch extends RpcTarget {
      async fetch(requestId: string, request: { url?: string; method?: string } = {}) {
          let telemetry = false;
          let localPets = false;
        try {
            const url = new URL(request.url ?? '');
            if (url.protocol === 'https:' && url.hostname === 'chatgpt.com'
              && /^\/(?:backend-api\/)?settings\/account_user_setting\/?$/u.test(url.pathname)) {
              const feature = url.searchParams.get('feature');
              const preference = feature === 'voice_main_language' ? 'local-voice-language' : feature === 'voice_name' ? 'local-voice-name' : null;
              const method = (request.method ?? 'GET').toUpperCase();
              if (preference && ['GET', 'PATCH'].includes(method) && url.searchParams.getAll('feature').length === 1) {
                const respond = (value: unknown, status = 200) => ({ response: new Response(JSON.stringify(value), {
                  status, headers: { 'content-type': 'application/json' },
                }) });
                if (method === 'PATCH') {
                  const value = url.searchParams.get('value');
                  const valid = typeof value === 'string' && value.length <= 64
                    && (feature === 'voice_name' ? /^[a-z][a-z0-9_-]*$/u.test(value) : /^(?:auto|[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*)$/u.test(value));
                  if (!valid || url.searchParams.getAll('value').length !== 1) return respond({ error: 'Invalid local voice preference' }, 400);
                  try { await writeRecoveredPreference('applicationState', preference, value); }
                  catch { return respond({ error: 'Unable to save the local voice preference' }, 500); }
                }
                const value = getRecoveredPreferences().applicationState[preference] ?? (feature === 'voice_name' ? 'sol' : 'auto');
                return respond({ success: true, feature, value });
              }
            }
            if (url.protocol === 'https:' && url.hostname === 'chatgpt.com' && /\/(?:backend-api\/)?settings\/voices\/?$/u.test(url.pathname)) {
              const selected = getRecoveredPreferences().applicationState['local-voice-name'] ?? 'sol';
              return { response: new Response(JSON.stringify({ selected, voices: [
                { voice: 'sol', name: 'Sol', description: '明亮、自然的聲音', accent: '', preview_url: null },
                { voice: 'arbor', name: 'Arbor', description: '溫暖、沉穩的聲音', accent: '', preview_url: null },
                { voice: 'spruce', name: 'Spruce', description: '清晰、直接的聲音', accent: '', preview_url: null },
              ] }), { status: 200, headers: { 'content-type': 'application/json' } }) };
            }
            localPets = url.protocol === 'https:' && url.hostname === 'chatgpt.com' && /^\/(?:backend-api\/)?(?:wham\/)?pets\/?$/u.test(url.pathname);
          telemetry = url.protocol === 'https:' && (url.hostname === 'ab.chatgpt.com'
            || (url.hostname === 'chatgpt.com' && /^\/ces(?:\/|$)/u.test(url.pathname)));
        } catch { /* Unrecognized cloud requests retain the explicit BYOK denial. */ }
          if (localPets) return { response: new Response(JSON.stringify({ pets: [], cursor: null }), { status: 200, headers: { 'content-type': 'application/json' } }) };
          // The SDK's overlay poll validates response_mode before checking for
          // updates. Local BYOK has no hosted overlay, just as it has no updates.
          if (telemetry) return { response: new Response(JSON.stringify({ has_updates: false, response_mode: 'no_updates', time: Date.now(), success: true }), { status: 200,
          headers: { 'content-type': 'application/json' } }) };
        // BYOK inference uses app-server, never the original authenticated cloud HTTP transport.
        return { error: 'Cloud HTTP requests are disabled in local BYOK mode', status: 403,
          responseStatus: 403, errorCode: 'LOCAL_BYOK_ONLY', errorKind: 'http' };
      }
      async cancel(_requestId: string): Promise<void> {}
    }

    class LocalEnvironments extends RpcTarget {
      async read(request: { hostId?: string; configPath: string }) {
        requireLocalHost(request.hostId);
        const configPath = absolutePath({ path: request.configPath });
        try {
          const file = await bridge.request<FsReadFileResponse>('fs/readFile', { path: configPath });
          const config = parseToml(new TextDecoder().decode(Uint8Array.from(atob(file.dataBase64), value => value.charCodeAt(0))));
          return { environment: { type: 'success', configPath, config, name: typeof config.name === 'string' ? config.name : configPath.split(/[\\/]/u).at(-1) } };
        } catch (error) { return { environment: { type: 'error', configPath, error: errorValue(error).message } }; }
      }
      async list(request: { hostId?: string; workspaceRoot: string }) {
        requireLocalHost(request.hostId);
        const directory = childPath(absolutePath({ path: request.workspaceRoot }), '.codex/environments');
        try {
          const { entries } = await bridge.request<{ entries: { fileName: string }[] }>('fs/readDirectory', { path: directory });
          const environments = await Promise.all(entries.filter(entry => /\.toml$/iu.test(entry.fileName))
            .map(async entry => (await this.read({ hostId: request.hostId, configPath: childPath(directory, entry.fileName) })).environment));
          return { environments };
        } catch (error) {
          if (/ENOENT|not found|does not exist|os error [23]|cannot find/iu.test(errorValue(error).message)) return { environments: [] };
          throw error;
        }
      }
    }

    async function requestGit(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      if (method !== 'stable-metadata') return bridge.gitRequest(method, params);
      const host = params.hostConfig as { id?: string } | undefined;
      requireLocalHost(host?.id);
      const directory = absolutePath({ path: String(params.cwd ?? params.root ?? '') });
      const root = await readGit(directory, ['rev-parse', '--show-toplevel']);
      if (root.exitCode !== 0) {
        if (/not a git repository|must be run in a work tree/iu.test(root.stderr)) return null;
        throw new Error(root.stderr || 'Git repository discovery failed');
      }
      const [common, git, branch] = await Promise.all([
        readGit(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
        readGit(directory, ['rev-parse', '--absolute-git-dir']),
        readGit(directory, ['symbolic-ref', '--short', 'HEAD']),
      ]);
      if (common.exitCode !== 0 || git.exitCode !== 0) throw new Error(common.stderr || git.stderr || 'Git directory discovery failed');
      const commonDir = outputLine(common.stdout, 'common directory');
      const gitDir = outputLine(git.stdout, 'Git directory');
      return { root: outputLine(root.stdout, 'repository root'), commonDir, gitDir,
        isWorktree: commonDir !== gitDir, branch: branch.exitCode === 0 ? outputLine(branch.stdout, 'branch') : null };
    }

    class PendingWorktrees extends RpcTarget {
      #entries = new Map<string, LocalPendingWorktree>();
      #listeners = new Map<RpcCallback<[LocalPendingWorktree[]]>, Subscription>();
      #running = new Map<string, Promise<void>>();

      async #publish() {
        const entries = structuredClone([...this.#entries.values()]);
        await Promise.all([...this.#listeners.keys()].map(listener => notify(listener, entries).catch(error => {
          this.#listeners.get(listener)?.unsubscribe();
          report(error);
        })));
      }
      async subscribe(callback: RpcCallback<[LocalPendingWorktree[]]>) {
        const listener = retainCallback(callback);
        const subscription = new Subscription(() => { this.#listeners.delete(listener); release(listener); });
        this.#listeners.set(listener, subscription);
        listener.onRpcBroken?.(() => subscription.unsubscribe());
        await notify(listener, structuredClone([...this.#entries.values()]));
        return subscription;
      }
      async create(request: LocalPendingWorktree): Promise<void> {
        requireLocalHost(request.hostId);
        requireKey(request.id);
        requireKey(request.clientThreadId);
        absolutePath({ path: request.sourceWorkspaceRoot });
        if (this.#entries.has(request.id)) return;
        this.#entries.set(request.id, { ...request, createdAt: Date.now(), attempt: 1, phase: 'queued',
          labelEdited: false, worktreeOutputText: '', setupOutputText: '', errorMessage: null,
          worktreeWorkspaceRoot: null, worktreeGitRoot: null, needsAttention: false, isPinned: false, pinnedBeforeThreadId: null });
        await this.#publish();
        await this.#prepare(request.id);
      }
      #prepare(id: string): Promise<void> {
        const existing = this.#running.get(id);
        if (existing) return existing;
        const operation = (async () => {
          const entry = this.#entries.get(id);
          if (!entry) return;
          entry.phase = 'creating';
          await this.#publish();
          try {
            const result = await bridge.gitRequest<{ gitRoot: string; workspaceRoot: string }>('create-worktree', { sourceWorkspaceRoot: entry.sourceWorkspaceRoot });
            if (this.#entries.get(id) !== entry) return;
            entry.worktreeWorkspaceRoot = result.workspaceRoot;
            entry.worktreeGitRoot = result.gitRoot;
            entry.worktreeOutputText = `Created worktree at ${result.gitRoot}`;
            // Never pretend a selected environment setup script has executed.
            if (entry.localEnvironmentConfigPath) throw new Error('工作树已创建；此本地宿主尚未执行环境设置，请选择「不进行设置并继续」。');
            entry.phase = 'worktree-ready';
          } catch (error) {
            if (this.#entries.get(id) !== entry) return;
            entry.phase = 'failed';
            entry.errorMessage = errorValue(error).message;
            entry.needsAttention = true;
          }
          await this.#publish();
        })().finally(() => this.#running.delete(id));
        this.#running.set(id, operation);
        return operation;
      }
      async updateMetadata(request: { hostId?: string; id: string; updates: Record<string, unknown>[] }) {
        requireLocalHost(request.hostId);
        const entry = this.#entries.get(request.id);
        if (!entry) return;
        for (const update of request.updates) {
          switch (update.type) {
            case 'conversationStartResult': entry.conversationStartResult = update.result; break;
            case 'isPinned': entry.isPinned = update.isPinned; break;
            case 'pinnedBeforeThreadId': entry.pinnedBeforeThreadId = update.beforeThreadId; break;
            case 'label': entry.label = update.label; break;
            case 'labelEdited': entry.labelEdited = update.labelEdited; break;
            case 'needsAttention': entry.needsAttention = update.needsAttention; break;
          }
        }
        await this.#publish();
      }
      async dismiss(request: { id: string; hostId?: string }) {
        requireLocalHost(request.hostId);
        this.#entries.delete(request.id);
        await this.#publish();
      }
      async cancel(request: { id: string; hostId?: string; continueLocally?: boolean }) {
        requireLocalHost(request.hostId);
        const entry = this.#entries.get(request.id);
        if (entry && request.continueLocally) {
          await this.#running.get(request.id);
          entry.phase = 'worktree-ready'; entry.executionTarget = 'source-workspace';
          entry.worktreeWorkspaceRoot = entry.sourceWorkspaceRoot; entry.worktreeGitRoot = null;
          entry.errorMessage = null;
          await this.#publish();
        } else await this.dismiss(request);
      }
      async continueWithoutSetup(request: { id: string; hostId?: string }) {
        requireLocalHost(request.hostId);
        const entry = this.#entries.get(request.id);
        if (entry?.worktreeWorkspaceRoot) { entry.phase = 'worktree-ready'; entry.needsAttention = false; await this.#publish(); }
      }
      async retry(request: { id: string; hostId?: string }) {
        requireLocalHost(request.hostId);
        const entry = this.#entries.get(request.id);
        if (!entry || this.#running.has(request.id)) return;
        if (entry.worktreeWorkspaceRoot) return this.continueWithoutSetup(request);
        entry.attempt = (entry.attempt ?? 1) + 1; entry.errorMessage = null;
        await this.#prepare(request.id);
      }
    }
    class ManagedWorktrees extends RpcTarget {
      #pending = new PendingWorktrees();
      #archiveWrites: Promise<unknown> = Promise.resolve();
      get pending() { return this.#pending; }
      #archives(): LocalManagedThreadArchive[] {
        const saved = getRecoveredPreferences().applicationState['local-managed-thread-archives'];
        return Array.isArray(saved) ? saved.filter((item): item is LocalManagedThreadArchive =>
          item !== null && typeof item === 'object' && typeof item.hostId === 'string' && typeof item.threadId === 'string'
          && (item.root === null || typeof item.root === 'string') && typeof item.cleanupWorktree === 'boolean'
          && Array.isArray(item.pullRequestIdentityKeys) && item.pullRequestIdentityKeys.every((key: unknown) => typeof key === 'string')) : [];
      }
      async getPendingArchives(request: { hostId?: string; threadId: string }) {
        requireLocalHost(request.hostId);
        requireKey(request.threadId);
        await this.#archiveWrites;
        return this.#archives().filter(item => item.hostId === (request.hostId ?? 'local') && item.threadId === request.threadId
          && item.cleanupWorktree && item.root !== null);
      }
      registerThreadArchive(request: { hostId?: string; threadId: string; cwd?: string | null; cleanupWorktree?: boolean }): Promise<void> {
        requireLocalHost(request.hostId);
        requireKey(request.threadId);
        const hostId = request.hostId ?? 'local';
        const root = request.cwd == null ? null : absolutePath({ path: request.cwd });
        const entry: LocalManagedThreadArchive = { hostId, threadId: request.threadId, cwd: root, root,
          cleanupWorktree: request.cleanupWorktree === true, pullRequestIdentityKeys: [] };
        // Coordinate archive visibility only; cleanup never deletes or edits a worktree.
        const operation = this.#archiveWrites.then(() => writeRecoveredPreference('applicationState', 'local-managed-thread-archives',
          [...this.#archives().filter(item => item.hostId !== hostId || item.threadId !== request.threadId), entry]));
        this.#archiveWrites = operation.catch(() => {});
        return operation;
      }
      registerThreadUnarchive(request: { hostId?: string; threadId: string }): Promise<void> {
        requireLocalHost(request.hostId);
        requireKey(request.threadId);
        const operation = this.#archiveWrites.then(() => writeRecoveredPreference('applicationState', 'local-managed-thread-archives',
          this.#archives().filter(item => item.hostId !== (request.hostId ?? 'local') || item.threadId !== request.threadId)));
        this.#archiveWrites = operation.catch(() => {});
        return operation;
      }
      async setOwnerThread(request: { hostId?: string; worktree: string; conversationId: string }) {
        requireLocalHost(request.hostId);
        return bridge.gitRequest('set-worktree-owner-thread', { ...request, worktree: absolutePath({ path: request.worktree }) });
      }
    }

    // The original Git client uses capnweb over a dedicated MessagePort, not the view dispatcher.
    const desktopWindow = window as Window & { electronBridge?: Record<string, unknown> };
    const synchronousBridge = desktopWindow.electronBridge ?? {};
    const previousConnect = synchronousBridge.connectGitWorker;
    const connectGitWorker = async (requestId: string): Promise<boolean> => {
      requireKey(requestId);
      const channel = new MessageChannel();
      let remote: RecoveredRendererRoot & { receive(message: unknown): Promise<void> };
      const subscriptions = new Set<string | number>();
      class GitWorker extends RpcTarget {
        async send(message: { type: string; request?: { id: string | number; method: string; params?: Record<string, unknown> }; id?: string | number }) {
          if (message.type === 'worker-request-cancel') { if (message.id !== undefined) subscriptions.delete(message.id); return; }
          const request = message.request;
          if (message.type !== 'worker-request' || !request) return;
          if (request.method === 'subscribe-live-query') {
            const params = request.params ?? {};
            const query = params.query as { method: string; params: Record<string, unknown> };
            subscriptions.add(request.id);
            try {
              const result = await requestGit(query.method, { ...query.params, hostConfig: params.hostConfig });
              if (subscriptions.has(request.id)) await remote.receive({ type: 'worker-event', workerId: 'git', event: {
                type: 'git-live-query-updated', subscriptionId: params.subscriptionId, method: query.method,
                generation: 1, phase: 'complete', requiresRecovery: false, result,
              } });
            } catch (error) {
              await remote.receive({ type: 'worker-event', workerId: 'git', event: {
                type: 'git-live-query-failed', subscriptionId: params.subscriptionId, method: query.method,
                generation: 1, error: { message: errorValue(error).message },
              } });
            }
            return;
          }
          let result;
          try { result = { type: 'ok', value: await requestGit(request.method, request.params) }; }
          catch (error) { result = { type: 'error', error: { message: errorValue(error).message } }; }
          await remote.receive({ type: 'worker-response', workerId: 'git', response: { id: request.id, method: request.method, result } });
        }
      }
      remote = bundledRpc.vct(channel.port1, new GitWorker()) as typeof remote;
      const close = () => { subscriptions.clear(); release(remote); channel.port1.close(); cleanupCallbacks.delete(close); };
      cleanupCallbacks.add(close);
      remote.onRpcBroken(close);
      window.postMessage({ type: 'codex_desktop:git-worker-port', requestId }, '*', [channel.port2]);
      return true;
    };
    synchronousBridge.connectGitWorker = connectGitWorker;
    desktopWindow.electronBridge = synchronousBridge;
    cleanupCallbacks.add(() => {
      if (synchronousBridge.connectGitWorker === connectGitWorker) {
        if (previousConnect === undefined) delete synchronousBridge.connectGitWorker;
        else synchronousBridge.connectGitWorker = previousConnect;
      }
    });

    const accessInputs = new AccessInputs();
    const threadConfiguration = new ThreadConfiguration();
    const services = {
      browserHost: new BrowserHost(),
      clipboard: new (class extends RpcTarget {
        writeText(text: string) { return bridge.writeClipboardText(text); }
        readText() { return bridge.readClipboardText(); }
      })(),
      customAgents: new (class extends RpcTarget {
        async list(roots: string[] = []) {
          const response = await bridge.request('config/read', {
            includeLayers: false, ...(roots[0] ? { cwd: roots[0] } : {}),
          }) as { config: Record<string, unknown> };
          const configured = response.config.agents;
          // These three roles are compiled into the local backend's role.rs.
          const roles = new Map([
            ['default', { roleName: 'default', description: 'Default agent.', nicknameCandidates: [] as string[] }],
            ['explorer', { roleName: 'explorer', description: 'Use explorer for specific codebase questions.', nicknameCandidates: [] as string[] }],
            ['worker', { roleName: 'worker', description: 'Use for execution and production work.', nicknameCandidates: [] as string[] }],
          ]);
          if (configured && typeof configured === 'object') for (const [roleName, value] of Object.entries(configured)) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
            const role = value as Record<string, unknown>;
            if (typeof role.description !== 'string' && typeof role.config_file !== 'string') continue;
            roles.set(roleName, { roleName, description: typeof role.description === 'string' ? role.description : '',
              nicknameCandidates: Array.isArray(role.nickname_candidates) ? role.nickname_candidates.filter((item): item is string => typeof item === 'string') : [] });
          }
          return { agents: [...roles.values()] };
        }
      })(),
      github: new (class extends RpcTarget {
        request(method: string, params: Record<string, unknown> = {}, _source?: string, _onProgress?: unknown) {
          requireLocalHost(params.hostId ?? (params.account as { hostId?: string } | undefined)?.hostId);
          if (!['gh-cli-status', 'gh-current-user', 'gh-pr-list'].includes(method)) throw new HostCapabilityUnavailableError(`GitHub ${method}`);
          return bridge.gitRequest(method, params);
        }
      })(),
      executionHosts: new ExecutionHosts(),
      executionPaths: new ExecutionPaths(),
      terminal: new Terminal(),
      openIn: new OpenIn(),
      remoteConnections: new RemoteConnections(),
      applicationState: new ApplicationState(),
      externalAgentImport: new ExternalAgentImport(),
      settings: new Settings(),
      commandKeybindings: new CommandKeybindings(),
      threadConfiguration,
      threadProjectAssignments: new ThreadProjectAssignments(),
      appInfo: new AppInfo(),
      appServerLifecycle: new AppServerLifecycle(),
      accessInputs,
      accountInfo: accessInputs,
      workspaceRoots: new WorkspaceRoots(),
      projects: new Projects(),
      projectlessThreads: new ProjectlessThreads(),
      repositoryOrigins: new RepositoryOrigins(),
      workspaceFiles: new WorkspaceFiles(),
      dynamicToolCalls: new DynamicToolCalls(),
      requestUserInputAutoResolution: new RequestUserInputAutoResolution(),
      queuedFollowUps: new QueuedFollowUps(),
      queuedSendLocks: new QueuedSendLocks(),
      managedWorktrees: new ManagedWorktrees(),
      localEnvironments: new LocalEnvironments(),
      httpFetch: new HttpFetch(),
      customAvatars: new CustomAvatars(),
      globalDictationHotkeys: new GlobalDictationHotkeys(),
      dictationHistory: new DictationHistory(),
      audioSettings: new AudioSettings(),
    };
    // The original renderer explicitly chooses its own real manager when appServerManagers is absent.
    // Optional statsig/remote/cloud/native services remain absent, preserving original feature detection.
    class HostRoot extends RpcTarget {
      get services() { return services; }
      ping(): void {}
    }
    hostRoot = new HostRoot();

    const unsubscribeStatus = bridge.onStatus(status => {
      if (disposed) return;
      context.status = status;
      publishAccessIdentity();
    });
    cleanupCallbacks.add(unsubscribeStatus);
    context.status = await bridge.getStatus();
    if (disposed) return dispose;
    rpc = bundledRpc;
    for (const port of connections.keys()) connect(port);
    return dispose;
  } catch (error) {
    dispose();
    throw errorValue(error);
  }
}
