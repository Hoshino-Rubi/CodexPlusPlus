import type { ClientRequest } from '../../../protocol_schema/typescript/ClientRequest';
import type { AppPreferences, DesktopBridge, LocalSession, PreferenceScope, RpcEvent } from '../../../shared/bridge';
import { localAgentModeKey, localPermissionSelectionKey, localPermissionUpdate, readLocalPermissionMode, requestedLocalPermissionMode, saveLocalPermissionMode, withLocalPermissions, type LocalPermissionMode } from './localPermissions';
import { completeLocalWindowsSetup, readLocalWindowsReadiness } from './localSetup';
import type { LocalThreadConfiguration, LocalThreadConfigurationRequest } from './hostTypes';

type JsonObject = Record<string, unknown>;
type RequestId = string | number;
type ViewError = { code: string | number; message: string; data?: unknown };
type HostMessage = JsonObject & { type: string };

export interface RecoveredStore {
  snapshot(): JsonObject;
  read(key: string): unknown;
  write(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  subscribe(listener: (state: JsonObject) => void): () => void;
}

export interface ApplicationStateAdapter {
  read(key: string): Promise<{ value: unknown }>;
  write(key: string, value: unknown): Promise<{ success: boolean }>;
}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Keep structured skill/mention inputs intact. The shipped static Markdown
// lexer retains angle brackets in Windows link destinations; normalize only
// references backed by a structured skill, at the presentation boundary.
function presentSkillReferences(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(presentSkillReferences);
  if (!object(value)) return value;
  if (value.type === 'userMessage' && Array.isArray(value.content)) {
    const skills = value.content.filter(item => object(item) && item.type === 'skill');
    const normalize = (path: string) => path.replaceAll('\\', '/').toLowerCase();
    return { ...value, content: value.content.map(item => {
      if (!object(item) || item.type !== 'text' || typeof item.text !== 'string') return item;
      const text = item.text.replace(/\[\$([^\]]+)\]\((?:<([^>]+)>|([^\s)]+))\)/gu, (link, name: string, anglePath: string, barePath: string) => {
        const target = (anglePath ?? barePath).replaceAll('\\\\', '\\');
        const skill = skills.find(skill => skill.name === name && typeof skill.path === 'string' && normalize(skill.path) === normalize(target));
        if (!skill || typeof skill.path !== 'string') return link;
        const destination = encodeURI(skill.path.replaceAll('\\', '/')).replace(/[()]/gu, character => character === '(' ? '%28' : '%29');
        return `[$${name}](${destination})`;
      });
      return text === item.text ? item : { ...item, text };
    }) };
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, presentSkillReferences(entry)]));
}

export function sanitizeMcpConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeMcpConfig);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]): [string, unknown][] => {
    if (/^(?:mcp_servers|mcpServers)\.codex_app(?:\.|$)/u.test(key)) return [];
    if (key !== 'mcp_servers' && key !== 'mcpServers') return [[key, sanitizeMcpConfig(child)]];
    return [[key, Object.fromEntries(Object.entries(object(child) ? child : {}).flatMap(([name, entry]): [string, unknown][] => {
      if (name === 'codex_app' || !object(entry)
        || ![entry.command, entry.url].some((field) => typeof field === 'string' && field.trim())) return [];
      const { transport, ...config } = entry;
      return [[name, sanitizeMcpConfig(config)]];
    }))]];
  }));
}

function own(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requestId(value: unknown): value is RequestId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
}

function idKey(value: RequestId): string {
  return `${typeof value}:${value}`;
}

function failure(code: string | number, message: string): Error & { code: string | number } {
  return Object.assign(new Error(message), { code });
}

function viewError(error: unknown): ViewError {
  const value = object(error) ? error : {};
  return {
    code: typeof value.code === 'string' || typeof value.code === 'number' ? value.code : -32603,
    message: typeof value.message === 'string' ? value.message : String(error),
    ...(value.data === undefined ? {} : { data: value.data }),
  };
}

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => equal(value, right[index]));
  }
  if (!object(left) || !object(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => own(right, key) && equal(left[key], right[key]));
}

let preferencesBridge: DesktopBridge | undefined;
let preferences: AppPreferences | undefined;
let persistenceQueue: Promise<unknown> = Promise.resolve();
const preferenceListeners = new Set<(state: AppPreferences) => void>();

function jsonCopy<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

export function getRecoveredPreferences(): AppPreferences {
  if (!preferences) throw failure('PERSISTENCE_NOT_READY', '本地偏好尚未从桌面 JSON 存储加载');
  return jsonCopy(preferences);
}

function acceptPreferences(value: AppPreferences): void {
  if (value.version !== 1 || !object(value.applicationState) || !object(value.persistedAtoms) || !object(value.settings)) {
    throw failure('INVALID_LOCAL_STATE', '桌面偏好快照无效');
  }
  const changed = !equal(preferences, value);
  preferences = jsonCopy(value);
  if (changed) for (const listener of preferenceListeners) listener(getRecoveredPreferences());
}

export function subscribeRecoveredPreferences(listener: (state: AppPreferences) => void): () => void {
  preferenceListeners.add(listener);
  return () => { preferenceListeners.delete(listener); };
}

export function writeRecoveredPreference(scope: PreferenceScope, key: string, value: unknown): Promise<void> {
  if (typeof key !== 'string' || key.length === 0) return Promise.reject(failure('INVALID_LOCAL_STATE', '本地偏好 key 无效'));
  const bridge = preferencesBridge;
  if (!bridge || !preferences) return Promise.reject(failure('PERSISTENCE_NOT_READY', '本地偏好尚未从桌面 JSON 存储加载'));
  let copied: unknown;
  try {
    copied = jsonCopy(value);
    if (value !== undefined && copied === undefined) throw new TypeError('Preference must be JSON serializable');
  } catch (error) { return Promise.reject(error); }
  const pending = persistenceQueue.then(async () => { acceptPreferences(await bridge.writePreference(scope, key, copied)); });
  persistenceQueue = pending.catch(() => {});
  return pending;
}

/** Hydrate before importing any recovered bundle. Legacy browser snapshots remain available for recovery. */
export async function initializeRecoveredPersistence(bridge: DesktopBridge = window.codex): Promise<() => void> {
  if (preferencesBridge) throw failure('PERSISTENCE_ALREADY_INSTALLED', '本地偏好存储已经初始化');
  preferencesBridge = bridge;
  let revision = 0;
  const stop = bridge.onPreferences((snapshot) => { revision += 1; acceptPreferences(snapshot); });
  try {
    const beforeRead = revision;
    const snapshot = await bridge.readPreferences();
    if (revision === beforeRead) acceptPreferences(snapshot);
    const migrationKey = 'codex-plus-plus:legacy-browser-migration:v1';
    if (getRecoveredPreferences().applicationState[migrationKey] === true) {
      return () => { stop(); preferencesBridge = undefined; preferences = undefined; };
    }
    const legacy: Array<[PreferenceScope, string, unknown]> = [];
    const readLegacy = (key: string): unknown => {
      try {
        const serialized = window.localStorage.getItem(key);
        return serialized === null ? undefined : JSON.parse(serialized) as unknown;
      } catch { return undefined; }
    };
    for (const [scope, key] of [
      ['persistedAtoms', 'codex-plus-plus:recovered:state:v1'],
      ['applicationState', 'codex-plus-plus:recovered:application-state:v1'],
    ] as const) {
      const saved = readLegacy(key);
      if (object(saved)) for (const [name, value] of Object.entries(saved)) legacy.push([scope, name, value]);
    }
    const prefix = 'codex-plus-plus:recovered:application-state:v1:';
    try {
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (!key?.startsWith(prefix)) continue;
        try {
          const name = decodeURIComponent(key.slice(prefix.length));
          const value = readLegacy(key);
          if (name && value !== undefined) legacy.push(['applicationState', name, value]);
        } catch { /* Preserve malformed legacy keys without changing the native snapshot. */ }
      }
    } catch { /* The native store remains usable when browser storage is disabled. */ }
    for (const [scope, key, value] of legacy) {
      if (!own(getRecoveredPreferences()[scope], key)) await writeRecoveredPreference(scope, key, value);
    }
    await writeRecoveredPreference('applicationState', migrationKey, true);
    return () => { stop(); preferencesBridge = undefined; preferences = undefined; };
  } catch (error) {
    stop(); preferencesBridge = undefined; preferences = undefined;
    throw error;
  }
}

/** Synchronous reads use the hydrated native snapshot; writes resolve only after the JSON file is saved. */
export function createRecoveredStore(scope: PreferenceScope = 'persistedAtoms'): RecoveredStore {
  return {
    snapshot: () => getRecoveredPreferences()[scope],
    read: (key) => getRecoveredPreferences()[scope][key],
    write: (key, value) => writeRecoveredPreference(scope, key, value),
    remove: (key) => writeRecoveredPreference(scope, key, undefined),
    subscribe(listener) {
      let previous = getRecoveredPreferences()[scope];
      return subscribeRecoveredPreferences((state) => {
        if (!equal(previous, state[scope])) { previous = state[scope]; listener(jsonCopy(previous)); }
      });
    },
  };
}

export const recoveredPersistedState = createRecoveredStore();
const applicationStateStore = createRecoveredStore('applicationState');
export const recoveredApplicationState: ApplicationStateAdapter = {
  async read(key) { return { value: applicationStateStore.read(key) }; },
  async write(key, value) {
    await applicationStateStore.write(key, value);
    return { success: true };
  },
};

const threadConfigurationKey = 'local-thread-configurations';
const reasoningEfforts = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);

/** Shared by the host service and actual outgoing requests; no backend configuration stub. */
export async function readLocalThreadConfiguration(
  request: LocalThreadConfigurationRequest = {}, bridge: DesktopBridge = window.codex,
  state: ApplicationStateAdapter = recoveredApplicationState, persisted: RecoveredStore = recoveredPersistedState,
): Promise<LocalThreadConfiguration> {
  if (request.hostId != null && request.hostId !== 'local') throw failure('UNSUPPORTED_HOST', '线程配置仅支持本地执行主机');
  const registry = await bridge.readProviders();
  const provider = registry.providers.find(entry => entry.id === registry.activeProviderId);
  if (!provider || !provider.models.some(model => model.id === provider.defaultModel)) throw failure('PROVIDER_REQUIRED', '请先配置本地 Provider 和模型');
  const stored = (await state.read(threadConfigurationKey)).value;
  const records = object(stored) ? stored : {};
  const defaults = object(records.default) ? records.default : {};
  const id = request.threadId ?? request.conversationId;
  const saved = id && object(records[id]) ? { ...defaults, ...records[id] } : defaults;
  // Global model defaults come from the registry. Only a concrete thread owns
  // a sticky provider/model; legacy default records must not override the picker.
  let selection: JsonObject = id && object(records[id]) ? records[id] : {};
  if (id && !object(records[id]) && !id.startsWith('new-chat-')) {
    try {
      const result = await bridge.request('thread/read', { threadId: id, includeTurns: false });
      if (object(result) && object(result.thread)) selection = result.thread;
    } catch (error) {
      if (!/no rollout found|thread not found|invalid thread id/iu.test(viewError(error).message)) throw error;
    }
  }
  const selectedProvider = registry.providers.find(entry => entry.id === selection.modelProvider
    && entry.models.some(model => model.id === selection.model)) ?? provider;
  const selectedModel = selectedProvider.models.some(model => model.id === selection.model)
    ? String(selection.model) : selectedProvider.defaultModel;
  const permissions = withLocalPermissions('turn/start', {}, readLocalPermissionMode(persisted));
  const customPolicy = saved.sandboxPolicy != null && requestedLocalPermissionMode(saved) === undefined;
  const root = (await state.read('active-workspace-root')).value;
  return {
    model: selectedModel, modelProvider: selectedProvider.id,
    reasoningEffort: typeof saved.reasoningEffort === 'string' && reasoningEfforts.has(saved.reasoningEffort) ? saved.reasoningEffort : 'medium',
    approvalPolicy: customPolicy ? saved.approvalPolicy ?? permissions.approvalPolicy : permissions.approvalPolicy,
    sandboxPolicy: customPolicy ? saved.sandboxPolicy : permissions.sandboxPolicy,
    cwd: request.cwd ?? (typeof saved.cwd === 'string' ? saved.cwd : typeof root === 'string' ? root : null),
  };
}

export async function writeLocalThreadConfiguration(
  request: LocalThreadConfigurationRequest, bridge: DesktopBridge = window.codex,
  state: ApplicationStateAdapter = recoveredApplicationState, persisted: RecoveredStore = recoveredPersistedState,
): Promise<LocalThreadConfiguration> {
  const current = await readLocalThreadConfiguration(request, bridge, state, persisted);
  if (request.reasoningEffort != null && !reasoningEfforts.has(request.reasoningEffort)) throw failure('INVALID_EFFORT', '推理强度无效');
  const token = typeof request.model === 'string' ? decodeLocalModel(request.model) : null;
  const model = token?.model ?? request.model ?? current.model;
  const providerId = token?.providerId ?? request.modelProvider ?? current.modelProvider;
  const registry = await bridge.readProviders();
  if (!registry.providers.some(provider => provider.id === providerId && provider.models.some(entry => entry.id === model))) throw failure('INVALID_MODEL', '模型不在本地 Provider 配置中');
  const requestedMode = requestedLocalPermissionMode(request as JsonObject);
  if (request.approvalPolicy != null && !['untrusted', 'on-failure', 'on-request', 'never'].includes(String(request.approvalPolicy))) throw failure('INVALID_APPROVAL_POLICY', '审批策略无效');
  if (request.sandboxPolicy != null && (!object(request.sandboxPolicy)
    || !['readOnly', 'workspaceWrite', 'dangerFullAccess', 'externalSandbox'].includes(String(request.sandboxPolicy.type)))) throw failure('INVALID_SANDBOX_POLICY', '沙箱策略无效');
  if (request.sandbox != null && !['read-only', 'workspace-write', 'danger-full-access'].includes(String(request.sandbox))) throw failure('INVALID_SANDBOX_POLICY', '沙箱模式无效');
  const permissions = requestedMode === undefined ? {} : withLocalPermissions('turn/start', {}, requestedMode);
  const next = {
    ...current, model, modelProvider: providerId,
    reasoningEffort: request.reasoningEffort ?? current.reasoningEffort,
    approvalPolicy: request.approvalPolicy ?? permissions.approvalPolicy ?? current.approvalPolicy,
    sandboxPolicy: request.sandboxPolicy ?? (request.sandbox === 'read-only' ? { type: 'readOnly' } : permissions.sandboxPolicy) ?? current.sandboxPolicy,
  };
  const saved = (await state.read(threadConfigurationKey)).value;
  const key = request.threadId ?? request.conversationId ?? 'default';
  if (key === 'default' && (providerId !== current.modelProvider || model !== current.model)) await bridge.selectModel(providerId, model);
  if (requestedMode !== undefined) await saveLocalPermissionMode(persisted, requestedMode);
  if (!(await state.write(threadConfigurationKey, { ...(object(saved) ? saved : {}), [key]: next })).success) throw failure('PERSISTENCE_FAILED', '线程配置未保存');
  return next;
}

// Port of app-initial's Jht: record updates are conditional merges, not replacement values.
function applyRecordUpdate(previous: unknown, update: JsonObject): JsonObject {
  if (!object(update.entries)) throw failure('INVALID_LOCAL_STATE', 'persisted atom recordUpdate.entries 无效');
  const state: JsonObject = object(previous) ? { ...previous } : {};
  const field = typeof update.timestampField === 'string' ? update.timestampField : undefined;
  const timestamp = (value: unknown) => field && object(value) && typeof value[field] === 'number' ? value[field] as number : 0;
  for (const [key, entry] of Object.entries(update.entries)) {
    if (object(entry) && entry.expectedValue !== undefined && !equal(state[key], entry.expectedValue)) continue;
    if (entry === null || (object(entry) && own(entry, 'delete'))) { delete state[key]; continue; }
    if (!object(entry)) throw failure('INVALID_LOCAL_STATE', 'persisted atom record entry 无效');
    if ((entry.createOnly === true && own(state, key)) || (field && timestamp(state[key]) > timestamp(entry.value))) continue;
    if (entry.updateOnly === true) { if (!own(state, key)) continue; }
    else delete state[key];
    Object.defineProperty(state, key, { value: entry.value, enumerable: true, configurable: true, writable: true });
  }
  if (typeof update.minNumericValue === 'number') {
    for (const [key, value] of Object.entries(state)) if (typeof value === 'number' && value < update.minNumericValue) delete state[key];
  }
  if (typeof update.maxEntries === 'number') {
    const keys = Object.keys(state);
    if (field) keys.sort((left, right) => timestamp(state[left]) - timestamp(state[right]));
    for (const key of keys.slice(0, Math.max(0, keys.length - update.maxEntries))) delete state[key];
  }
  if (typeof update.maxBytes === 'number') {
    let size = 2;
    for (const [key, value] of Object.entries(state).reverse()) {
      const bytes = new TextEncoder().encode(JSON.stringify({ [key]: value })).byteLength - 2;
      const next = size + bytes + Number(size > 2 && bytes > 0);
      if (next > update.maxBytes) delete state[key];
      else size = next;
    }
  }
  return state;
}

export function encodeLocalModel(providerId: string, model: string): string {
  return `codex-local:${encodeURIComponent(providerId)}:${encodeURIComponent(model)}`;
}

export function decodeLocalModel(value: string): { providerId: string; model: string } | null {
  const match = /^codex-local:([^:]+):([^:]+)$/u.exec(value);
  if (!match) return null;
  try {
    const providerId = decodeURIComponent(match[1]);
    return { providerId: providerId === 'openai' ? 'openai-custom' : providerId, model: decodeURIComponent(match[2]) };
  }
  catch { throw failure('INVALID_MODEL', '本地模型标识编码无效'); }
}

export async function resolveLocalModel(value: string, bridge: DesktopBridge = window.codex) {
  const model = decodeLocalModel(value);
  if (!model) throw failure('INVALID_MODEL', '请选择本地 Provider 中配置的模型');
  const registry = await bridge.readProviders();
  const provider = registry.providers.find((candidate) => candidate.id === model.providerId);
  if (!provider?.models.some((candidate) => candidate.id === model.model)) throw failure('INVALID_MODEL', '模型已不在本地 Provider 配置中');
  return { ...model, provider, registry };
}

/** Source dispatcher accepts same-window postMessage, including the opaque file: origin. */
export function postRecoveredHostMessage(message: HostMessage): void {
  window.postMessage(message, window.location.origin === 'null' ? '*' : window.location.origin);
}

export interface ViewTransportOptions {
  persistedState?: RecoveredStore;
  applicationState?: ApplicationStateAdapter;
  onError?: (error: ViewError, context: string) => void;
}

type ThreadState = { provider: string; model: string | null; busy: boolean; revision: number };
type ModelSelection = { providerId: string; model: string };
type ReverseRequest = { officialId: RequestId; rendererId: string; method: string; threadId?: string; responding: boolean; finished: boolean };
const rendererRequestMethods = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request',
]);

/** Install before importing app-main. Deliberately does not implement sendMessageFromView. */
export function installViewTransport(bridge: DesktopBridge = window.codex, options: ViewTransportOptions = {}): () => void {
  const persisted = options.persistedState ?? recoveredPersistedState;
  const appState = options.applicationState ?? recoveredApplicationState;
  const forward = new Map<string, object>();
  const reverse = new Map<string, ReverseRequest>();
  const official = new Map<string, ReverseRequest>();
  const threads = new Map<string, ThreadState>();
  const appliedPermissionModes = new Map<string, LocalPermissionMode>();
  const locks = new Map<string, Promise<unknown>>();
  const queuedEvents: HostMessage[] = [];
  const installationId = crypto.randomUUID();
  let sequence = 0;
  let disposed = false;
  let rendererReady = false;
  let statusRevision = 0;
  let status: Awaited<ReturnType<DesktopBridge['getStatus']>> | undefined;
  let persistedSnapshot = persisted.snapshot();
  let applyingPersistedKey: string | undefined;
  let persistedUpdateQueue: Promise<unknown> = Promise.resolve();
  let permissionRevision = 0;
  let pendingPermissionSelection: { mode: LocalPermissionMode; previous: JsonObject } | undefined;
  let choosingWorkspace = false;
  let miniPanel: HTMLElement | undefined;
  const closeMini = async () => {
    miniPanel?.remove(); miniPanel = undefined;
    await appState.write('local-mini-open', false);
  };
  const openMini = async () => {
    if (miniPanel) { miniPanel.focus(); return; }
    const panel = document.createElement('section');
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Mini'); panel.tabIndex = -1;
    panel.dataset.localMini = 'true';
    panel.className = 'rounded-xl border border-token-border-default bg-token-main-surface-primary text-token-text-primary shadow-lg';
    Object.assign(panel.style, { position: 'fixed', right: '24px', bottom: '24px', zIndex: '100', padding: '16px',
      width: '240px', backgroundColor: 'var(--color-surface)', color: 'var(--color-text-primary)' });
    const title = document.createElement('h2'); title.textContent = 'Mini'; title.className = 'text-sm font-semibold';
    const description = document.createElement('p'); description.className = 'text-sm text-secondary';
    description.textContent = 'Mini 已喚醒 · 本地寵物';
    const status = document.createElement('p'); status.className = 'text-sm text-secondary';
    status.textContent = `進行中的對話：${[...threads.values()].filter(thread => thread.busy).length}`;
    const mascot = document.querySelector<HTMLElement>('[data-avatar-mascot]')?.cloneNode(true);
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '讓 Mini 休息';
    close.className = 'rounded-lg px-3 py-2 text-sm'; close.onclick = () => { void closeMini().catch(error => report(error, 'mini:close')); };
    panel.append(title, ...(mascot ? [mascot] : []), description, status, close);
    document.body.append(panel); miniPanel = panel; panel.focus();
    await appState.write('local-mini-open', true);
  };
  const emit = (message: HostMessage) => { if (!disposed) postRecoveredHostMessage(message); };
  const report = (error: unknown, context: string) => {
    const normalized = viewError(error);
    options.onError?.(normalized, context);
    window.dispatchEvent(new CustomEvent('codex-recovered-transport-error', { detail: { error: normalized, context } }));
  };
  const permissionsSaved = () => window.dispatchEvent(new CustomEvent('codex-recovered-permissions-saved'));
  const publishPermissions = () => {
    const state = persisted.snapshot();
    for (const key of [localAgentModeKey, localPermissionSelectionKey]) {
      emit({ type: 'persisted-atom-updated', key, value: state[key], deleted: !own(state, key) });
    }
  };
  const restorePermissions = async (previous: JsonObject) => {
    for (const key of [localAgentModeKey, localPermissionSelectionKey]) {
      if (!equal(persisted.read(key), previous[key])) {
        try { await persisted.write(key, previous[key]); }
        catch (error) { report(error, 'permissions:rollback'); }
      }
    }
    publishPermissions();
  };
  const localSession = async (): Promise<LocalSession> => {
    const session = await bridge.getSession();
    if (session.mode !== 'byok' || session.requiresOpenaiAuth !== false || session.account.type !== 'apiKey') {
      throw failure('BYOK_REQUIRED', '原工作区只接受本地 BYOK 会话');
    }
    return session;
  };
  const assertRawModels = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(assertRawModels); return; }
    if (!object(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      if ((key === 'model' || key === 'modelProvider' || key === 'model_provider') && typeof entry === 'string' && entry.startsWith('codex-local:')) {
        throw failure('UNSUPPORTED_MODEL_TOKEN', '当前 RPC 的模型字段未经过本地 Provider 适配，已拒绝发送');
      }
      assertRawModels(entry);
    }
    if (typeof value.keyPath === 'string' && /(?:^|\.)model$/u.test(value.keyPath) && typeof value.value === 'string' && value.value.startsWith('codex-local:')) {
      throw failure('UNSUPPORTED_MODEL_TOKEN', '官方配置必须保存原始模型名，请通过本地 Provider 选择器保存模型');
    }
  };
  const rpc = async (method: ClientRequest['method'], params: JsonObject): Promise<unknown> => {
    await persistedUpdateQueue;
    const permissionMode = requestedLocalPermissionMode(params);
    const permissionChange = method === 'thread/settings/update' && permissionMode !== undefined;
    const previousMode = typeof params.threadId === 'string' ? appliedPermissionModes.get(params.threadId) : undefined;
    const previousPermissions = persisted.snapshot();
    const selectionRevision = permissionRevision;
    const request = withLocalPermissions(method, params, permissionMode ?? readLocalPermissionMode(persisted));
    const requestedMode = requestedLocalPermissionMode(request);
    const pendingSelection = pendingPermissionSelection?.mode === requestedMode ? pendingPermissionSelection : undefined;
    const permissionRequest = requestedMode !== undefined
      && (method === 'thread/start' || method === 'thread/resume' || method === 'thread/fork' || method === 'turn/start' || permissionChange);
    assertRawModels(request);
    try {
      if (permissionMode !== undefined && (method === 'thread/start' || method === 'thread/resume' || method === 'thread/fork' || method === 'turn/start' || permissionChange)) {
        await localSession();
        await saveLocalPermissionMode(persisted, permissionMode);
      }
      const result = await bridge.request(method, sanitizeMcpConfig(request));
      // Resume can rejoin an already-loaded thread and ignore overrides. Prefer its actual effective policy.
      const appliedMode = object(result) && object(result.sandbox) ? requestedLocalPermissionMode({
        approvalPolicy: result.approvalPolicy, sandboxPolicy: result.sandbox,
        permissions: object(result.activePermissionProfile) ? result.activePermissionProfile.id : undefined,
      }) : requestedMode;
      const threadId = object(result) && object(result.thread) && typeof result.thread.id === 'string' ? result.thread.id : params.threadId;
      if (appliedMode !== undefined && typeof threadId === 'string') appliedPermissionModes.set(threadId, appliedMode);
      if (permissionRequest) {
        if (appliedMode === requestedMode) {
          if (permissionRevision === selectionRevision) pendingPermissionSelection = undefined;
          permissionsSaved();
        }
      }
      return presentSkillReferences(result);
    } catch (error) {
      if (permissionRequest) {
        if (permissionRevision === selectionRevision) {
          if (permissionChange && !pendingSelection && previousMode !== undefined) {
            try { await saveLocalPermissionMode(persisted, previousMode); }
            catch (rollbackError) { report(rollbackError, 'permissions:rollback'); }
            publishPermissions();
          } else await restorePermissions(pendingSelection?.previous ?? previousPermissions);
          pendingPermissionSelection = undefined;
        }
        report(error, `permissions:${method}`);
      }
      throw error;
    }
  };
  const queueEvent = (message: HostMessage) => rendererReady ? emit(message) : queuedEvents.push(message);
  const publishStatus = () => {
    if (!rendererReady || !status) return;
    emit({ type: 'codex-app-server-connection-changed', hostId: 'local', transport: 'stdio',
      state: status.state === 'ready' ? 'connected' : status.state === 'starting' ? 'connecting' : status.state === 'error' ? 'error' : 'disconnected',
      errorMessage: status.message ?? null });
    // Undefined means initialization is still pending to the renderer queue. Null explicitly
    // reports a completed handshake with an unknown version, without inventing capabilities.
    if (status.state === 'ready') emit({ type: 'codex-app-server-initialized', hostId: 'local', appServerVersion: status.appServerVersion ?? null, installedCodexVersion: null, isSnapshot: true, transport: 'stdio' });
    window.dispatchEvent(new CustomEvent('codex-recovered-backend-status', { detail: status }));
  };
  const saveThread = (thread: JsonObject, revision: number, fallback?: JsonObject) => {
    if (typeof thread.id !== 'string') return;
    const current = threads.get(thread.id);
    const snapshotBusy = object(thread.status) && thread.status.type === 'active'
      || (Array.isArray(thread.turns) && thread.turns.some((turn) => object(turn) && turn.status === 'inProgress'));
    const newer = current && current.revision > revision;
    threads.set(thread.id, { provider: newer && current.provider ? current.provider : typeof fallback?.modelProvider === 'string' ? fallback.modelProvider : String(thread.modelProvider ?? current?.provider ?? ''),
      model: newer && current.model !== null ? current.model : typeof fallback?.model === 'string' ? fallback.model : typeof thread.model === 'string' ? thread.model : current?.model ?? null,
      busy: current && current.revision > revision ? current.busy : Boolean(snapshotBusy), revision: current?.revision ?? revision });
  };
  const decorateModel = (provider: string, model: string) => model.startsWith('codex-local:') ? model : encodeLocalModel(provider, model);
  const decorateSettings = (settings: unknown, fallbackProvider?: string): unknown => {
    if (!object(settings)) return settings;
    const provider = typeof settings.modelProvider === 'string' ? settings.modelProvider : fallbackProvider;
    if (!provider) return settings;
    const value = { ...settings };
    if (typeof value.model === 'string') value.model = decorateModel(provider, value.model);
    if (object(value.collaborationMode) && object(value.collaborationMode.settings) && typeof value.collaborationMode.settings.model === 'string') {
      value.collaborationMode = { ...value.collaborationMode, settings: { ...value.collaborationMode.settings, model: decorateModel(provider, value.collaborationMode.settings.model) } };
    }
    return value;
  };
  const decorateThread = (thread: unknown): unknown => decorateSettings(thread);
  const decorate = (result: unknown): unknown => {
    if (!object(result)) return result;
    const value = decorateSettings(result) as JsonObject;
    if (object(value.thread)) value.thread = decorateThread(value.thread);
    if (Array.isArray(value.data)) value.data = value.data.map((entry) => object(entry) && own(entry, 'modelProvider') ? decorateThread(entry) : entry);
    if (object(value.threadSettings)) value.threadSettings = decorateSettings(value.threadSettings);
    return value;
  };
  const selectedFor = async (params: JsonObject): Promise<ModelSelection> => {
    const registry = await bridge.readProviders();
    const id = typeof params.threadId === 'string' ? params.threadId : undefined;
    const configuration = await readLocalThreadConfiguration(id ? { threadId: id } : {}, bridge, appState, persisted);
    const mode = object(params.collaborationMode) && object(params.collaborationMode.settings) ? params.collaborationMode.settings : {};
    const config = object(params.config) ? params.config : {};
    const requested = mode.model ?? params.model ?? config.model;
    const token = typeof requested === 'string' ? decodeLocalModel(requested) : null;
    const explicitProvider = token?.providerId ?? params.modelProvider ?? config.model_provider;
    const fallbackProvider = configuration.modelProvider;
    let model = token?.model ?? (typeof requested === 'string' ? requested : configuration.model);
    // Accept the public alias only when its configured upstream model exists.
    if (model === 'deepseek-4.1-flash-1017' && registry.providers.some(provider => provider.id === (explicitProvider ?? 'deepseek')
      && provider.models.some(entry => entry.id === 'deepseek-v4.1-flash-1017'))) model = 'deepseek-v4.1-flash-1017';
    const candidates = registry.providers.filter(provider => provider.models.some(entry => entry.id === model));
    const provider = explicitProvider != null ? candidates.find(provider => provider.id === explicitProvider)
      : candidates.find(provider => provider.id === fallbackProvider) ?? candidates.find(provider => provider.id === registry.activeProviderId) ?? candidates[0];
    if (!provider) throw failure('INVALID_MODEL', '所选模型不在对应的本地 Provider 配置中');
    return { providerId: provider.id, model };
  };
  const withSelection = (params: JsonObject, selection: ModelSelection, provider: boolean): JsonObject => {
    const value: JsonObject = { ...params, model: selection.model, modelProvider: selection.providerId };
    if (provider) {
      value.modelProvider = selection.providerId;
      if (object(value.config)) value.config = { ...value.config, model_provider: selection.providerId, model: selection.model };
    } else {
      if (params.config != null) throw failure(-32602, '此 RPC 不支持 config 覆盖');
      delete value.config;
    }
    if (object(value.collaborationMode) && object(value.collaborationMode.settings)) {
      value.collaborationMode = { ...value.collaborationMode, settings: { ...value.collaborationMode.settings, model: selection.model } };
    }
    return value;
  };
  const resume = async (params: JsonObject, selection: ModelSelection): Promise<JsonObject> => {
    const id = String(params.threadId ?? '');
    const request = withSelection(params, selection, true);
    const load = async () => {
      const revision = threads.get(id)?.revision ?? 0;
      const result = await rpc('thread/resume', request);
      if (!object(result) || !object(result.thread)) throw failure('INVALID_RESPONSE', 'thread/resume 未返回有效任务');
      saveThread(result.thread, revision, result);
      return result;
    };
    let result = await load();
    // turn/start can change a model within the loaded provider without unloading.
    const matches = () => result.modelProvider === selection.providerId;
    if (!matches()) {
      const thread = result.thread as JsonObject;
      if (threads.get(id)?.busy || !object(thread.status) || thread.status.type !== 'idle') {
        throw failure('ACTIVE_PROVIDER_MISMATCH', '任务仍在运行，当前加载的 Provider/模型与所选配置不同；请等待结束后重新打开任务');
      }
      // Official unsubscribe detaches only this connection. Rust will not shut down an active turn.
      await rpc('thread/unsubscribe', { threadId: typeof thread.id === 'string' ? thread.id : id });
      result = await load();
      if (!matches()) throw failure('PROVIDER_MISMATCH', '任务仍由其他订阅或运行会话使用，无法切换到所选 Provider/模型；已拒绝发送');
    }
    return result;
  };
  const verifyLiveProvider = async (id: string, selection: ModelSelection, modelMustMatch: boolean) => {
    const revision = threads.get(id)?.revision ?? 0;
    // Reading metadata never resumes, unsubscribes, interrupts, or replaces an active turn.
    const result = await rpc('thread/read', { threadId: id, includeTurns: false });
    if (!object(result) || !object(result.thread)) throw failure('INVALID_RESPONSE', '无法核对运行任务的 Provider');
    saveThread(result.thread, revision);
    const current = threads.get(id);
    if (!current || current.provider !== selection.providerId || (modelMustMatch && current.model !== selection.model)) {
      throw failure('ACTIVE_PROVIDER_MISMATCH', '运行任务的 Provider/模型与所选配置不同，已拒绝修改或追加输入');
    }
  };
  const catalog = async (params: JsonObject) => {
    const registry = await bridge.readProviders();
    const data = registry.providers.flatMap((provider) => provider.models.map((model) => ({
      id: encodeLocalModel(provider.id, model.id), model: encodeLocalModel(provider.id, model.id),
      displayName: `${provider.name} · ${model.label ?? model.id}`, description: provider.baseUrl,
      upgrade: null, upgradeInfo: null, availabilityNux: null, modelSpecialty: null, hidden: false,
      supportedReasoningEfforts: (model.reasoningEfforts ?? ['minimal', 'low', 'medium', 'high', 'xhigh']).map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })),
      defaultReasoningEffort: model.reasoningEfforts?.includes('medium') !== false ? 'medium' : model.reasoningEfforts[0] ?? 'none',
      contextWindow: model.contextWindow ?? 200000,
      inputModalities: model.supportsImageInput === false ? ['text'] : ['text', 'image'], supportsPersonality: false,
      multiAgentVersion: null, additionalSpeedTiers: [], serviceTiers: [], defaultServiceTier: null, availableAccessPrograms: null,
      isDefault: provider.id === registry.activeProviderId && model.id === provider.defaultModel,
    })));
    const offset = params.cursor == null ? 0 : Number(String(params.cursor).replace(/^codex-local-page:/u, ''));
    if (!Number.isSafeInteger(offset) || offset < 0) throw failure('INVALID_CURSOR', '本地模型分页游标无效');
    const limit = typeof params.limit === 'number' && params.limit > 0 ? Math.floor(params.limit) : data.length || 1;
    return { data: data.slice(offset, offset + limit), nextCursor: offset + limit < data.length ? `codex-local-page:${offset + limit}` : null };
  };
  const dispatchRequest = async (method: string, params: JsonObject): Promise<unknown> => {
    if (method === 'windowsSandbox/readiness') return readLocalWindowsReadiness(appState, await localSession());
    if (method === 'windowsSandbox/setupStart') {
      if (params.mode !== 'elevated' && params.mode !== 'unelevated') throw failure(-32602, 'Windows setup mode 无效');
      await completeLocalWindowsSetup(appState, await localSession(), params.mode);
      return { started: true };
    }
    if (method === 'account/read') { const session = await localSession(); return { account: session.account, requiresOpenaiAuth: false }; }
    if (method === 'getAuthStatus') { await localSession(); return { authMethod: 'apikey', authToken: null, requiresOpenaiAuth: false }; }
    if (method === 'model/list') return catalog(params);
    if (method === 'initialize') throw failure('INVALID_METHOD', '后端初始化由桌面主进程管理');
    if (method === 'thread/resume') {
      const snapshot = await rpc('thread/read', { threadId: params.threadId, includeTurns: false });
      const thread = object(snapshot) && object(snapshot.thread) ? snapshot.thread : undefined;
      // Inspecting a routed subagent must retain its session's provider and model.
      const selection = thread && typeof thread.parentThreadId === 'string'
        && typeof thread.modelProvider === 'string' && typeof thread.model === 'string'
        ? { providerId: thread.modelProvider, model: thread.model } : await selectedFor(params);
      return decorate(await resume(params, selection));
    }
    if (method === 'thread/start') {
      const selection = await selectedFor(params);
      const configuration = await readLocalThreadConfiguration(params, bridge, appState, persisted);
      const saved = await appState.read('active-workspace-root');
      const cwd = typeof params.cwd === 'string' && params.cwd ? params.cwd : saved.value;
      if (typeof cwd !== 'string' || !absolutePath(cwd)) throw failure('WORKSPACE_REQUIRED', '请先选择实际工作区目录');
      const start = withSelection({ ...params, cwd }, selection, true);
      if (start.permissions == null && start.sandbox == null && start.sandboxPolicy == null && object(configuration.sandboxPolicy)) {
        const modes: Record<string, string> = { workspaceWrite: 'workspace-write', dangerFullAccess: 'danger-full-access', readOnly: 'read-only' };
        const sandbox = modes[String(configuration.sandboxPolicy.type)];
        if (sandbox) start.sandbox = sandbox;
        start.approvalPolicy ??= configuration.approvalPolicy;
      }
      // Generated ThreadStartParams has no top-level effort: configure the thread default.
      start.config = { model_reasoning_effort: configuration.reasoningEffort,
        ...(object(start.config) ? start.config : {}),
        ...(params.reasoningEffort == null ? {} : { model_reasoning_effort: params.reasoningEffort }) };
      delete start.reasoningEffort;
      const result = await rpc('thread/start', start);
      if (!object(result) || result.modelProvider !== selection.providerId || result.model !== selection.model) throw failure('PROVIDER_MISMATCH', '新任务实际使用的 Provider/模型与所选配置不同，已拒绝继续发送');
      if (object(result.thread)) {
        saveThread(result.thread, 0, result);
        if (typeof result.thread.id === 'string') await writeLocalThreadConfiguration({ threadId: result.thread.id,
          model: encodeLocalModel(selection.providerId, selection.model) }, bridge, appState, persisted);
      }
      return decorate(result);
    }
    if (method === 'thread/fork') {
      if (params.experimentalPredictionMode === true) {
        // TODO(stub): prediction forks inherit a loaded parent's private effective config and forbid ordinary model/provider overrides.
        throw failure('UNSUPPORTED_PREDICTION_FORK', '本地 Provider 尚不支持预测 fork 的继承配置路径；普通任务 fork 可用');
      }
      const selection = await selectedFor(params);
      const result = await rpc('thread/fork', withSelection(params, selection, true));
      if (!object(result) || result.modelProvider !== selection.providerId || result.model !== selection.model) {
        throw failure('PROVIDER_MISMATCH', '派生任务实际使用的 Provider/模型与所选配置不同，已拒绝继续发送');
      }
      if (object(result.thread)) {
        saveThread(result.thread, 0, result);
        const id = result.thread.id;
        if (typeof id === 'string') await writeLocalThreadConfiguration({ threadId: id,
          model: encodeLocalModel(selection.providerId, selection.model) }, bridge, appState, persisted);
        const sourceId = params.threadId;
        const cwd = typeof result.cwd === 'string' ? result.cwd : result.thread.cwd;
        if (typeof id === 'string' && typeof sourceId === 'string' && id !== sourceId) {
          const state = getRecoveredPreferences().applicationState;
          const assignments = object(state['thread-project-assignments']) ? { ...state['thread-project-assignments'] } : {};
          const sourceAssignment = assignments[sourceId];
          if (object(sourceAssignment)) assignments[id] = jsonCopy(sourceAssignment);
          const projectlessIds = Array.isArray(state['projectless-thread-ids']) ? state['projectless-thread-ids'].filter(value => typeof value === 'string') : [];
          const projectless = projectlessIds.includes(sourceId);
          const updates: [string, unknown][] = [
            ['thread-project-assignments', assignments],
            ['projectless-thread-ids', projectless ? [...new Set([...projectlessIds, id])] : projectlessIds],
          ];
          if (typeof cwd === 'string' && absolutePath(cwd)) {
            const hints = object(state['thread-workspace-root-hints']) ? state['thread-workspace-root-hints'] : {};
            updates.push(['thread-workspace-root-hints', { ...hints, [id]: cwd }]);
          }
          const projectIds = object(state['thread-start-project-ids']) ? state['thread-start-project-ids'] : {};
          if (typeof params.projectId === 'string' || typeof projectIds[sourceId] === 'string') {
            updates.push(['thread-start-project-ids', { ...projectIds, [id]: params.projectId ?? projectIds[sourceId] }]);
          }
          for (const [key, value] of updates) {
            if (!(await appState.write(key, value)).success) throw failure('PERSISTENCE_FAILED', `分叉对话绑定未保存：${key}`);
          }
          queueEvent({ type: 'thread-project-memberships-updated', memberships: { [id]: { assignment: sourceAssignment ?? null, projectless } } });
        }
      }
      return decorate(result);
    }
    if (method === 'turn/start') {
      const id = String(params.threadId ?? '');
      if (threads.get(id)?.busy) throw failure('ACTIVE_TURN', '该任务已有正在运行的回合，请先停止或等待完成');
      const selection = await selectedFor(params);
      await resume({ threadId: id, excludeTurns: true }, selection);
      if (threads.get(id)?.busy) throw failure('ACTIVE_TURN', '后台已有回合正在运行，已拒绝启动重复回合');
      const revision = threads.get(id)?.revision ?? 0;
      const start = withSelection(params, selection, false);
      const configuration = await readLocalThreadConfiguration(params, bridge, appState, persisted);
      if (start.permissions == null && start.sandbox == null && start.sandboxPolicy == null) {
        start.sandboxPolicy = configuration.sandboxPolicy;
        start.approvalPolicy ??= configuration.approvalPolicy;
      }
      // TurnStartParams uses effort; accept the renderer alias without forwarding an unknown field.
      if (start.effort == null) start.effort = params.reasoningEffort ?? configuration.reasoningEffort;
      delete start.reasoningEffort;
      const result = await rpc('turn/start', start);
      const current = threads.get(id);
      if (current && current.revision === revision) current.busy = object(result) && object(result.turn) && result.turn.status === 'inProgress';
      return result;
    }
    if (method === 'thread/settings/update' && (typeof params.model === 'string' || object(params.collaborationMode))) {
      const id = String(params.threadId ?? '');
      if (threads.get(id)?.busy) throw failure('ACTIVE_TURN', '任务正在运行，请等待结束后修改后续回合的模型设置');
      const selection = await selectedFor(params);
      await resume({ threadId: id, excludeTurns: true }, selection);
      if (threads.get(id)?.busy) throw failure('ACTIVE_TURN', '后台已有运行回合，已拒绝切换后续回合模型');
      return rpc('thread/settings/update', withSelection(params, selection, false));
    }
    if (method === 'turn/settings/update' && typeof params.model === 'string') {
      if (params.collaborationMode != null) throw failure(-32602, '运行回合设置不支持 collaborationMode 覆盖');
      const selection = await selectedFor(params);
      await verifyLiveProvider(String(params.threadId ?? ''), selection, false);
      return rpc('turn/settings/update', withSelection(params, selection, false));
    }
    if (method === 'turn/steer') {
      if (params.model != null || params.modelProvider != null || params.collaborationMode != null || params.config != null) {
        throw failure(-32602, 'turn/steer 不支持模型、Provider 或 collaborationMode 覆盖');
      }
      await verifyLiveProvider(String(params.threadId ?? ''), await selectedFor({ threadId: params.threadId }), false);
      return rpc('turn/steer', params);
    }
    const revision = typeof params.threadId === 'string' ? threads.get(params.threadId)?.revision ?? 0 : 0;
    const result = await rpc(method as ClientRequest['method'], params);
    if (object(result) && object(result.thread)) saveThread(result.thread, revision);
    if (['plugin/list', 'plugin/installed'].includes(method) && object(result) && Array.isArray(result.marketplaces)) {
      // The shipped public catalog recognizes the legacy built-in marketplace
      // name only. Adapt that classifier key, never the canonical plugin IDs,
      // display name, install path or config.toml persistence identity.
      return { ...result, marketplaces: result.marketplaces.map(marketplace =>
        object(marketplace) && marketplace.name === 'openai-api-curated'
          ? { ...marketplace, name: 'openai-curated', interface: { displayName: 'openai-api-curated' } }
          : marketplace) };
    }
    return decorate(result);
  };
  const runRequest = async (message: JsonObject) => {
    if (!object(message.request) || !requestId(message.request.id) || typeof message.request.method !== 'string') throw failure(-32600, '无效的 renderer MCP 请求');
    const request = message.request;
    const id = request.id as RequestId;
    const key = idKey(id);
    if (forward.has(key)) return;
    const token = {};
    forward.set(key, token);
    const method = request.method as string;
    try {
      if (message.hostId != null && message.hostId !== 'local') throw failure('UNSUPPORTED_HOST', '当前仅支持本地执行主机');
      const params = object(request.params) ? request.params : {};
      const threadId = typeof params.threadId === 'string' ? params.threadId : null;
      const prior = threadId ? locks.get(threadId) : undefined;
      const execute = () => dispatchRequest(method, params);
      const serialized = threadId && (method === 'thread/resume' || method === 'thread/fork' || method === 'turn/start' || method === 'thread/settings/update' || method === 'turn/settings/update' || method === 'turn/steer');
      const pending = serialized ? (prior ?? Promise.resolve()).catch(() => undefined).then(execute) : execute();
      if (serialized && threadId) locks.set(threadId, pending);
      let result: unknown;
      try { result = await pending; }
      finally { if (threadId && locks.get(threadId) === pending) locks.delete(threadId); }
      // Original onResult dispatch tests result truthiness; never leave such requests pending.
      if (!result) throw failure('INVALID_RESPONSE', `${method} 返回原渲染器不支持的空响应`);
      if (forward.get(key) === token) {
        emit({ type: 'mcp-response', hostId: 'local', requestMethod: method, message: { id, result },
          ...(request.trace == null ? {} : { trace: request.trace, receivedAtMs: Date.now() }) });
        if (method === 'windowsSandbox/setupStart') {
          // The shipped setup session subscribes after its started response. Post completion in the next task.
          window.setTimeout(() => queueEvent({ type: 'mcp-notification', hostId: 'local', method: 'windowsSandbox/setupCompleted',
            params: { mode: params.mode, success: true, error: null } }), 0);
        }
      }
    } catch (error) {
      emit({ type: 'mcp-response', hostId: message.hostId ?? 'local', requestMethod: method, message: { id, error: viewError(error) },
        ...(request.trace == null ? {} : { trace: request.trace, receivedAtMs: Date.now() }) });
    } finally { if (forward.get(key) === token) forward.delete(key); }
  };
  const removeReverse = (entry: ReverseRequest) => { reverse.delete(entry.rendererId); official.delete(idKey(entry.officialId)); };
  const respond = async (message: JsonObject) => {
    if (!object(message.response) || !requestId(message.response.id)) throw failure(-32600, '无效的 renderer MCP 响应');
    const response = message.response;
    const entry = reverse.get(String(response.id));
    if (!entry || entry.responding || entry.finished) return;
    if (message.hostId != null && message.hostId !== 'local') throw failure('UNSUPPORTED_HOST', '审批响应的执行主机无效');
    entry.responding = true;
    try {
      if (own(response, 'error')) {
        if (!object(response.error) || typeof response.error.code !== 'number' || typeof response.error.message !== 'string') throw failure(-32600, '审批错误必须包含数字 code 和 message');
        await bridge.respond(entry.officialId, undefined, { code: response.error.code, message: response.error.message,
          ...(response.error.data === undefined ? {} : { data: response.error.data }) });
      } else if (own(response, 'result')) await bridge.respond(entry.officialId, response.result);
      else throw failure(-32600, '审批响应缺少 result/error');
      entry.finished = true;
    } finally { entry.responding = false; }
  };
  const onBackendEvent = (event: RpcEvent) => {
    const raw = event as unknown as JsonObject;
    if (typeof raw.method !== 'string') return;
    const params = object(raw.params) ? raw.params : {};
    if (requestId(raw.id)) {
      if (official.has(idKey(raw.id))) return;
      if (raw.method === 'currentTime/read') { void bridge.respond(raw.id, { currentTimeAt: Math.floor(Date.now() / 1000) }).catch((error) => report(error, 'currentTime/read')); return; }
      if (!rendererRequestMethods.has(raw.method)) {
        void bridge.respond(raw.id, undefined, { code: -32601, message: `本地工作区不支持反向请求：${raw.method}` }).catch((error) => report(error, raw.method as string));
        return;
      }
      if (typeof params.threadId !== 'string') {
        void bridge.respond(raw.id, undefined, { code: -32602, message: '反向请求缺少 threadId' }).catch((error) => report(error, raw.method as string));
        return;
      }
      const entry: ReverseRequest = { officialId: raw.id, rendererId: `codex++:server:${installationId}:${++sequence}`,
        method: raw.method, threadId: params.threadId, responding: false, finished: false };
      reverse.set(entry.rendererId, entry); official.set(idKey(raw.id), entry);
      queueEvent({ type: 'mcp-request', hostId: 'local', request: { ...raw, id: entry.rendererId } });
      return;
    }
    const id = typeof params.threadId === 'string' ? params.threadId : undefined;
    let notificationParams = raw.params;
    if (raw.method === 'thread/started' && object(params.thread)) {
      saveThread(params.thread, threads.get(String(params.thread.id))?.revision ?? 0);
      notificationParams = { ...params, thread: decorateThread(params.thread) };
    }
    if (raw.method === 'thread/settings/updated' && id && object(params.threadSettings)) {
      const settings = params.threadSettings;
      const permissionMode = requestedLocalPermissionMode(settings);
      if (permissionMode !== undefined) appliedPermissionModes.set(id, permissionMode);
      const current = threads.get(id) ?? { provider: '', model: null, busy: false, revision: 0 };
      current.revision += 1;
      if (typeof settings.modelProvider === 'string') current.provider = settings.modelProvider;
      if (typeof settings.model === 'string') current.model = settings.model;
      threads.set(id, current);
      notificationParams = { ...params, threadSettings: decorateSettings(settings, current.provider) };
    }
    if (raw.method === 'model/rerouted' && id && threads.get(id)?.provider) {
      const provider = threads.get(id)!.provider;
      notificationParams = { ...params,
        ...(typeof params.fromModel === 'string' ? { fromModel: decorateModel(provider, params.fromModel) } : {}),
        ...(typeof params.toModel === 'string' ? { toModel: decorateModel(provider, params.toModel) } : {}) };
    }
    if (id && (raw.method === 'thread/status/changed' || raw.method === 'turn/started' || raw.method === 'turn/completed')) {
      const current = threads.get(id) ?? { provider: '', model: null, busy: false, revision: 0 };
      current.revision += 1;
      current.busy = raw.method === 'turn/started' || (raw.method === 'thread/status/changed' && object(params.status) && params.status.type === 'active');
      threads.set(id, current);
    }
    if (raw.method === 'serverRequest/resolved' && requestId(params.requestId)) {
      const entry = official.get(idKey(params.requestId));
      if (entry) { queueEvent({ type: 'mcp-notification', hostId: 'local', method: raw.method, params: { ...params, requestId: entry.rendererId } }); removeReverse(entry); return; }
    }
    if (raw.method === 'codex/serverRequestTimedOut' && requestId(params.id)) {
      const entry = official.get(idKey(params.id));
      if (entry) {
        if (entry.threadId) queueEvent({ type: 'mcp-notification', hostId: 'local', method: 'serverRequest/resolved', params: { threadId: entry.threadId, requestId: entry.rendererId } });
        removeReverse(entry);
      }
      report(failure('SERVER_REQUEST_TIMED_OUT', '后端审批请求已超时'), raw.method);
      return;
    }
    queueEvent({ type: 'mcp-notification', hostId: 'local', method: raw.method,
      ...(notificationParams === undefined ? {} : { params: presentSkillReferences(notificationParams) }) });
  };
  const workspace = async (message: JsonObject) => {
    if (choosingWorkspace) throw failure('WORKSPACE_DIALOG_OPEN', '工作区选择窗口已打开');
    choosingWorkspace = true;
    try {
      const root = typeof message.root === 'string' ? message.root : await bridge.chooseWorkspace();
      if (!root) { emit({ type: 'workspace-root-option-add-canceled' }); return; }
      if (!absolutePath(root)) throw failure('INVALID_WORKSPACE', '工作区必须是实际的绝对目录路径');
      if (message.type === 'electron-pick-workspace-root-option') { emit({ type: 'workspace-root-option-picked', root }); return; }
      const saved = await appState.read('local-workspace-roots');
      const roots = Array.isArray(saved.value) ? saved.value.filter((value): value is string => typeof value === 'string') : [];
      if (!(await appState.write('local-workspace-roots', [...new Set([...roots, root])])).success) throw failure('PERSISTENCE_FAILED', '工作区目录列表未保存');
      if (!(await appState.write('active-workspace-root', root)).success) throw failure('PERSISTENCE_FAILED', '当前工作区未保存');
      emit({ type: 'workspace-root-options-updated' });
      emit({ type: 'workspace-root-option-added', root });
    } finally { choosingWorkspace = false; }
  };
  const onView = (event: Event) => {
    const custom = event as CustomEvent<unknown> & { __codexForwardedViaBridge?: boolean };
    if (disposed || custom.__codexForwardedViaBridge || !object(custom.detail) || typeof custom.detail.type !== 'string') return;
    const message = custom.detail;
    const handle = async () => {
      switch (message.type) {
        case 'avatar-overlay-open': await openMini(); break;
        case 'avatar-overlay-close': await closeMini(); break;
        case 'mcp-request': await runRequest(message); break;
        case 'mcp-response': await respond(message); break;
        case 'persisted-atom-sync-request':
          emit({ type: 'persisted-atom-sync', state: persisted.snapshot(), canWritePrimaryWindowTabPersistence: true }); break;
        case 'persisted-atom-update': {
          const pending = persistedUpdateQueue.then(async () => {
            if (typeof message.key !== 'string') throw failure('INVALID_LOCAL_STATE', 'persisted atom key 无效');
            const key = message.key;
            const permissionKey = key === localAgentModeKey || key === localPermissionSelectionKey;
            const previousPermissions = permissionKey ? persisted.snapshot() : undefined;
            const previousMode = permissionKey ? readLocalPermissionMode(persisted) : undefined;
            let value = message.deleted === true ? undefined : message.value;
            if (object(message.recordUpdate)) {
              const previous = persisted.read(key) ?? (typeof message.recordUpdate.legacyStorageKey === 'string' ? persisted.read(message.recordUpdate.legacyStorageKey) : undefined);
              value = applyRecordUpdate(previous, message.recordUpdate);
            }
            const permissionMode = localPermissionUpdate(key, value);
            const changesSelection = permissionMode !== undefined && permissionMode !== previousMode;
            if (changesSelection) permissionRevision += 1;
            applyingPersistedKey = key;
            try {
              await persisted.write(key, value);
              if (permissionMode !== undefined) {
                await saveLocalPermissionMode(persisted, permissionMode);
                if (changesSelection && previousPermissions) {
                  pendingPermissionSelection = { mode: permissionMode, previous: previousPermissions };
                }
                permissionsSaved();
              }
            } catch (error) {
              if (previousPermissions) {
                await restorePermissions(previousPermissions);
                report(error, 'permissions:persistence');
              }
              throw error;
            } finally { applyingPersistedKey = undefined; }
            persistedSnapshot = persisted.snapshot();
            emit({ type: 'persisted-atom-updated', key, value, deleted: value === undefined,
              ...(typeof message.savedCustomSectionOperationId === 'string' ? { savedCustomSectionOperationId: message.savedCustomSectionOperationId } : {}) });
          });
          persistedUpdateQueue = pending.catch(() => {});
          await pending;
          break;
        }
        case 'electron-add-new-workspace-root-option':
        case 'electron-pick-workspace-root-option': await workspace(message); break;
        case 'electron-window-focus-request': emit({ type: 'electron-window-focus-changed', isFocused: document.hasFocus(), occurredAtMs: Date.now() }); break;
        case 'ready':
          rendererReady = true; publishStatus();
          for (const pending of queuedEvents.splice(0)) emit(pending);
          break;
        case 'mcp-request-abandon':
          // The bridge has no cancellation RPC for a queued request. Keep its ID until its real outcome.
          break;
        case 'log-message':
        case 'electron-set-window-mode':
          // Renderer logging and onboarding window chrome do not alter the local workspace host.
          break;
      }
    };
    void handle().catch((error) => report(error, String(message.type)));
  };
  window.addEventListener('codex-message-from-view', onView);
  const stopEvents = bridge.onEvent(onBackendEvent);
  const stopStatus = bridge.onStatus((next) => {
    statusRevision += 1; status = next;
    if (next.state !== 'ready' && next.state !== 'starting') {
      for (const entry of reverse.values()) {
        if (entry.threadId) queueEvent({ type: 'mcp-notification', hostId: 'local', method: 'serverRequest/resolved', params: { threadId: entry.threadId, requestId: entry.rendererId } });
      }
      reverse.clear(); official.clear(); threads.clear(); appliedPermissionModes.clear();
    }
    publishStatus();
  });
  const revision = statusRevision;
  void bridge.getStatus().then((next) => { if (!disposed && statusRevision === revision) { status = next; publishStatus(); } }).catch((error) => report(error, 'getStatus'));
  const stopPersistence = persisted.subscribe((state) => {
    for (const key of new Set([...Object.keys(persistedSnapshot), ...Object.keys(state)])) {
      if (key !== applyingPersistedKey && !equal(persistedSnapshot[key], state[key])) {
        emit({ type: 'persisted-atom-updated', key, value: state[key], deleted: !own(state, key) });
      }
    }
    persistedSnapshot = state;
  });
  // Host project operations persist outside the original query client. Notify its existing
  // global-state handler so creation refreshes the sidebar and selects the saved project.
  let applicationStateSnapshot = getRecoveredPreferences().applicationState;
  const stopApplicationState = subscribeRecoveredPreferences((state) => {
    const next = state.applicationState;
    const keys = [...new Set([...Object.keys(applicationStateSnapshot), ...Object.keys(next)])]
      .filter(key => !equal(applicationStateSnapshot[key], next[key]));
    applicationStateSnapshot = next;
    if (keys.length) queueEvent({ type: 'global-state-updated', keys });
  });
  const onFocus = () => emit({ type: 'electron-window-focus-changed', isFocused: document.hasFocus(), occurredAtMs: Date.now() });
  window.addEventListener('focus', onFocus); window.addEventListener('blur', onFocus);
  return () => {
    if (disposed) return;
    disposed = true; stopEvents(); stopStatus(); stopPersistence(); stopApplicationState();
    miniPanel?.remove(); miniPanel = undefined;
    window.removeEventListener('codex-message-from-view', onView);
    window.removeEventListener('focus', onFocus); window.removeEventListener('blur', onFocus);
    for (const entry of reverse.values()) if (!entry.finished && !entry.responding) {
      void bridge.respond(entry.officialId, undefined, { code: -32000, message: '本地工作区已关闭' }).catch((error) => report(error, entry.method));
    }
    reverse.clear(); official.clear(); forward.clear(); appliedPermissionModes.clear(); queuedEvents.length = 0;
  };
}

function absolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path) || /^\\\\[^\\]+\\[^\\]+/u.test(path);
}
