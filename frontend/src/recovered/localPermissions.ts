import type { SandboxPolicy } from '../../../protocol_schema/typescript/v2/SandboxPolicy';

type JsonObject = Record<string, unknown>;
export type LocalPermissionMode = 'auto' | 'full-access';
export const localAgentModeKey = 'agent-mode-by-host-id';
export const localPermissionSelectionKey = 'permission-selection-by-host-id:local';

export interface LocalPermissionStore {
  read(key: string): unknown;
  write(key: string, value: unknown): Promise<void>;
}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mode(value: unknown): LocalPermissionMode | undefined {
  if (value === 'full-access') return value;
  if (value === 'auto' || value === 'granular') return 'auto';
  return undefined;
}

/** These are the shipped composer's own persisted atoms, not a parallel UI-only preference. */
export function localPermissionUpdate(key: string, value: unknown): LocalPermissionMode | undefined {
  if (key === localAgentModeKey && object(value)) return mode(value.local);
  if (key === localPermissionSelectionKey && object(value) && value.kind === 'agent-mode') return mode(value.agentMode);
  return undefined;
}

export function readLocalPermissionMode(store: LocalPermissionStore): LocalPermissionMode {
  return localPermissionUpdate(localAgentModeKey, store.read(localAgentModeKey))
    ?? localPermissionUpdate(localPermissionSelectionKey, store.read(localPermissionSelectionKey)) ?? 'auto';
}

/** Resolve only after both original atoms have been committed to app-preferences.json. */
export async function saveLocalPermissionMode(store: LocalPermissionStore, selected: LocalPermissionMode): Promise<void> {
  const previous = store.read(localAgentModeKey);
  const selection = store.read(localPermissionSelectionKey);
  try {
    if (!object(previous) || previous.local !== selected) {
      await store.write(localAgentModeKey, { ...(object(previous) ? previous : {}), local: selected });
    }
    if (!object(selection) || selection.kind !== 'agent-mode' || selection.agentMode !== selected) {
      await store.write(localPermissionSelectionKey, { kind: 'agent-mode', agentMode: selected });
    }
  } catch (error) {
    const failures: unknown[] = [error];
    for (const [key, value] of [[localAgentModeKey, previous], [localPermissionSelectionKey, selection]] as const) {
      try { await store.write(key, value); }
      catch (rollbackError) { failures.push(rollbackError); }
    }
    if (failures.length > 1) throw new AggregateError(failures, '本地权限保存失败，且部分原权限状态未能恢复');
    throw error;
  }
}

export function requestedLocalPermissionMode(params: JsonObject): LocalPermissionMode | undefined {
  if (typeof params.permissions === 'string' && params.permissions !== ':workspace' && params.permissions !== ':danger-full-access') return undefined;
  if (params.sandbox != null && params.sandbox !== 'workspace-write' && params.sandbox !== 'danger-full-access') return undefined;
  if (params.sandboxPolicy != null && (!object(params.sandboxPolicy)
    || params.sandboxPolicy.type !== 'workspaceWrite' && params.sandboxPolicy.type !== 'dangerFullAccess')) return undefined;
  if (params.permissions === ':danger-full-access' || params.sandbox === 'danger-full-access'
    || object(params.sandboxPolicy) && params.sandboxPolicy.type === 'dangerFullAccess') return 'full-access';
  if (params.permissions === ':workspace' || params.sandbox === 'workspace-write'
    || object(params.sandboxPolicy) && params.sandboxPolicy.type === 'workspaceWrite' && params.approvalPolicy === 'on-request') return 'auto';
  return undefined;
}

/** Thread creation takes SandboxMode; turns/settings take SandboxPolicy. Never combine a named profile with either. */
export function withLocalPermissions(method: string, params: JsonObject, selected: LocalPermissionMode): JsonObject {
  const thread = method === 'thread/start' || method === 'thread/resume' || method === 'thread/fork';
  const turn = method === 'turn/start';
  const settings = method === 'thread/settings/update' && requestedLocalPermissionMode(params) !== undefined;
  if (!thread && !turn && !settings) return params;
  if (typeof params.permissions === 'string' && params.permissions !== ':workspace' && params.permissions !== ':danger-full-access') return params;
  // Custom read-only/external policies remain explicit choices; only the two local presets are normalized.
  if (requestedLocalPermissionMode(params) === undefined && (params.sandbox != null || params.sandboxPolicy != null)) return params;
  const result: JsonObject = { ...params, approvalPolicy: selected === 'full-access' ? 'never' : 'on-request', approvalsReviewer: 'user' };
  delete result.permissions;
  if (thread) {
    result.sandbox = selected === 'full-access' ? 'danger-full-access' : 'workspace-write';
    delete result.sandboxPolicy;
  } else {
    const previous = object(params.sandboxPolicy) && params.sandboxPolicy.type === 'workspaceWrite' ? params.sandboxPolicy : {};
    const roots = Array.isArray(previous.writableRoots) ? previous.writableRoots.filter((entry): entry is string => typeof entry === 'string') : [];
    const sandboxPolicy: SandboxPolicy = selected === 'full-access' ? { type: 'dangerFullAccess' } : {
      type: 'workspaceWrite', writableRoots: roots, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false,
    };
    result.sandboxPolicy = sandboxPolicy;
    delete result.sandbox;
  }
  return result;
}
