import type { LocalSession } from '../../../shared/bridge';
import type { WindowsSandboxSetupMode } from '../../../protocol_schema/typescript/v2/WindowsSandboxSetupMode';

export const LOCAL_WINDOWS_SETUP_KEY = 'codex-plus-plus:local-windows-setup:v1';

export interface LocalSetupStateStore {
  read(key: string): Promise<{ value: unknown }>;
  write(key: string, value: unknown): Promise<{ success: boolean }>;
}

export interface LocalWindowsSetupState {
  version: 1;
  policy: 'local-byok';
  readiness: 'ready';
  status: 'completed';
  /** Application readiness is not a claim that the Windows sandbox was provisioned. */
  sandboxProvisioned: false;
  requestedMode: WindowsSandboxSetupMode | null;
  completedAtMs: number;
}

function requireLocalSession(session: LocalSession): void {
  if (session.mode !== 'byok' || session.account.type !== 'apiKey' || session.requiresOpenaiAuth !== false) {
    throw new Error('Windows setup policy is available only to the local BYOK workspace');
  }
}

function savedState(value: unknown): value is LocalWindowsSetupState {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<LocalWindowsSetupState>;
  return record.version === 1 && record.policy === 'local-byok' && record.readiness === 'ready'
    && record.status === 'completed' && record.sandboxProvisioned === false
    && (record.requestedMode === null || record.requestedMode === 'elevated' || record.requestedMode === 'unelevated')
    && typeof record.completedAtMs === 'number' && Number.isFinite(record.completedAtMs);
}

/** Persist only the authorized local-app policy; never install helpers or change OS security. */
export async function completeLocalWindowsSetup(
  state: LocalSetupStateStore,
  session: LocalSession,
  mode?: WindowsSandboxSetupMode,
): Promise<void> {
  requireLocalSession(session);
  if (mode !== undefined && mode !== 'elevated' && mode !== 'unelevated') {
    throw new TypeError('Windows sandbox setup mode must be elevated or unelevated');
  }
  const { value } = await state.read(LOCAL_WINDOWS_SETUP_KEY);
  if (savedState(value) && (mode === undefined || mode === value.requestedMode)) return;
  const next: LocalWindowsSetupState = {
    version: 1,
    policy: 'local-byok',
    readiness: 'ready',
    status: 'completed',
    sandboxProvisioned: false,
    requestedMode: mode ?? null,
    completedAtMs: Date.now(),
  };
  if (!(await state.write(LOCAL_WINDOWS_SETUP_KEY, next)).success) {
    throw new Error('The local Windows setup policy could not be saved');
  }
}

export async function readLocalWindowsReadiness(
  state: LocalSetupStateStore,
  session: LocalSession,
): Promise<{ status: 'ready' }> {
  await completeLocalWindowsSetup(state, session);
  return { status: 'ready' };
}
