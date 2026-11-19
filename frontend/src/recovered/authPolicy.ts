import type { LocalSession } from '../../../shared/bridge';

export interface LocalByokWorkspacePolicy {
  readonly mode: 'byok';
  readonly defaultRoute: '/';
  readonly skipOnboarding: true;
  readonly history: 'memory';
}

/** Readiness still belongs to the real provider configuration; this only selects the local workspace. */
export function localWorkspacePolicyForSession(
  session: Pick<LocalSession, 'mode' | 'account' | 'requiresOpenaiAuth'>,
): Readonly<LocalByokWorkspacePolicy> {
  if (session.mode !== 'byok' || session.account.type !== 'apiKey' || session.requiresOpenaiAuth !== false) {
    throw new Error('原工作区初始化需要本地 BYOK 会话');
  }
  return Object.freeze({ mode: 'byok', defaultRoute: '/', skipOnboarding: true, history: 'memory' });
}

export function isLocalByokWorkspacePolicy(value: unknown): value is LocalByokWorkspacePolicy {
  if (typeof value !== 'object' || value === null) return false;
  const policy = value as Record<string, unknown>;
  return policy.mode === 'byok' && policy.defaultRoute === '/' &&
    policy.skipOnboarding === true && policy.history === 'memory';
}

export function requireLocalByokWorkspacePolicy(value: unknown): LocalByokWorkspacePolicy {
  if (!isLocalByokWorkspacePolicy(value)) throw new Error('Local BYOK workspace policy was not initialized');
  return value;
}
