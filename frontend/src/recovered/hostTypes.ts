/// <reference lib="esnext.disposable" />

import type { BackendStatus, DesktopBridge } from '../../../shared/bridge';

export interface RecoveredApplicationState {
  read(key: string): Promise<{ value: unknown }>;
  write(key: string, value: unknown): Promise<{ success: boolean }>;
}

export interface LocalExecutionHost {
  id: 'local';
  display_name: 'Local';
  kind: 'local';
}

export type LocalPullRequestFilter = 'all' | 'reviewing' | 'mine';

export interface LocalPullRequest {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  author: { login: string; name?: string; avatarUrl?: string };
  isDraft: boolean;
  reviewDecision: string;
}

export interface LocalConnectionState {
  state: 'connected' | 'connecting' | 'disconnected' | 'error';
  progress: null;
  error: string | null;
  sshAuthenticationRetryAt: null;
}

export interface LocalRemoteConnectionCatalog {
  ssh: never[];
  wsl: LocalDiscoveredWslConnection[];
  remoteControl: never[];
  remoteControlState: {
    available: false;
    accessRequired: false;
    authRequired: false;
    clientAuthorized: false;
  };
  localRemoteControlClientId: null;
  localRemoteControlEnvironmentId: null;
  localRemoteControlInstallationId: null;
  localRemoteControlEnabled: false;
}

export interface LocalDiscoveredWslConnection {
  hostId: string;
  displayName: string;
  source: 'wsl';
  distro: string;
  autoConnect: false;
}

export interface RpcDisposable {
  [Symbol.dispose]?: () => void;
}

export interface RpcSubscription extends RpcDisposable {
  unsubscribe(): void;
}

export type RpcCallback<Args extends unknown[]> = ((...args: Args) => unknown) & {
  dup?: () => RpcCallback<Args>;
  onRpcBroken?: (callback: (reason: unknown) => void) => void;
  [Symbol.dispose]?: () => void;
};

export interface RecoveredRendererRoot extends RpcDisposable {
  readonly services: unknown;
  ping(): Promise<void>;
  onRpcBroken(callback: (reason: unknown) => void): void;
}

export interface RecoveredRpcModule {
  readonly [exportName: string]: unknown;
  _ct(): void;
  /** Original setting registry initializer and definition lookup. */
  Glt(): void;
  Wlt(key: string): RecoveredSettingDefinition | undefined;
  hct: new () => object;
  vct(port: MessagePort, localMain: object): RecoveredRendererRoot;
}

export interface RecoveredSettingDefinition {
  key: string;
  default: unknown;
  hostStorage: { kind: 'configuration' | 'global-state' | 'persisted-atom'; key: string };
  schema: {
    parse(value: unknown): unknown;
    safeParse(value: unknown): { success: boolean; data?: unknown };
  };
}

export interface RecoveredOpenTargetRequest {
  hostId?: string;
  cwd: string | null;
  path?: string;
  deferEnrichment?: boolean;
  nativeBrowserDiscovery?: 'scan' | 'known';
}

export interface RecoveredOpenPathRequest {
  hostId?: string;
  path: string;
  target?: string;
  appPath?: string;
  cwd?: string | null;
  line?: number;
  column?: number;
  persistPreferredTargetPath?: string;
  conversationId?: string;
  openMode?: string;
}

export interface RecoveredAppInfoOverrides {
  version?: string;
  appName?: string;
  buildNumber?: string | number | null;
  buildFlavor?: string | null;
  isPackaged?: boolean;
  osVersion?: string | null;
  osRelease?: string | null;
}

export interface HostServicesOptions {
  applicationState?: RecoveredApplicationState;
  appInfo?: RecoveredAppInfoOverrides;
  onRendererConnected?: (renderer: RecoveredRendererRoot) => void;
  onError?: (error: Error) => void;
}

export interface HostServiceContext {
  bridge: DesktopBridge;
  state: RecoveredApplicationState;
  status: BackendStatus;
}

export interface WorkspaceRootReadOptions {
  hostId?: string;
  canonicalizeRoots?: string[];
}

export interface WorkspacePathRequest {
  hostId?: string;
  path: string;
}

export interface LocalThreadConfigurationRequest {
  hostId?: string;
  threadId?: string;
  conversationId?: string;
  cwd?: string | null;
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string | null;
  approvalPolicy?: unknown;
  sandboxPolicy?: unknown;
  sandbox?: unknown;
  permissions?: unknown;
}

export interface LocalThreadConfiguration {
  model: string;
  modelProvider: string;
  reasoningEffort: string;
  approvalPolicy: unknown;
  sandboxPolicy: unknown;
  cwd: string | null;
}

export interface LocalMcpConfig {
  mcpServers: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LocalMcpConfigRequest {
  hostId?: string;
  cwd?: string | null;
  context?: unknown;
}

export interface LocalMcpConfigWriteRequest extends LocalMcpConfigRequest {
  config: LocalMcpConfig;
}

export interface LocalMcpConfigResponse {
  config: LocalMcpConfig;
}

export interface LocalDeveloperInstructionsRequest {
  hostId?: string;
  cwd?: string | null;
  threadId?: string | null;
  baseInstructions?: string | null;
  hostedAutomationsEnabled?: boolean;
  includeProseDetailLevelInstructions?: boolean;
  sidebarSectionToolsEnabled?: boolean;
  threadToolsEnabled?: boolean;
  worktreeToolsEnabled?: boolean;
  instructionOverrides?: {
    desktopContextSection?: string | null;
    workspaceDependenciesSection?: string | null;
    worktreeInstructionsIncluded?: boolean;
  } | null;
}

export interface LocalDeveloperInstructionsResponse {
  instructions: string;
}

export interface LocalThreadMembership {
  assignment: { projectKind: 'local' | 'remote'; projectId: string; hostId?: string; projectOrigin?: 'chatgpt' } | null;
  projectless: boolean;
}

export interface LocalThreadMembershipRequest extends Partial<LocalThreadMembership> {
  threadId: string;
  hostId?: string;
}

export interface LocalThreadMemberships {
  assignments: Record<string, NonNullable<LocalThreadMembership['assignment']>>;
  projectlessThreadIds: string[];
}

export interface LocalProjectlessThreadUpdate {
  threadId: string;
  hostId?: string;
  projectless?: boolean;
  outputDirectory?: string | null;
  workspaceRoot?: string | null;
}

export interface LocalThreadStartProjectRequest {
  threadId: string;
  projectId: string | null;
  hostId?: string;
}

/** Original queuedFollowUps stores opaque per-thread queue records as a whole. */
export type LocalQueuedFollowUpsState = Record<string, unknown>;

export interface LocalQueuedSendLockRequest {
  conversationId: string;
  messageId: string;
  lockId: string;
}

export interface LocalQueuedSendLockRelease extends LocalQueuedSendLockRequest {
  sent: boolean;
}

export interface LocalPendingWorktree extends Record<string, unknown> {
  id: string;
  hostId: string;
  sourceWorkspaceRoot: string;
  clientThreadId: string;
  launchMode: 'fork-conversation' | 'start-conversation';
  localEnvironmentConfigPath?: string | null;
  phase?: 'queued' | 'creating' | 'worktree-ready' | 'failed';
  attempt?: number;
}

export interface LocalKeymapState {
  bindings: { command: string; key: string | null }[];
  keymapPath: string | null;
  supported: boolean;
}

/** Persisted custom-avatar manifest consumed by the shipped pet picker. */
export interface LocalCustomPet extends Record<string, unknown> {
  id: string;
  displayName: string;
  description: string;
  spritesheetDataUrl: string;
  spriteVersionNumber: number;
  updatedAt: number;
}

export interface LocalDictationRecording extends Record<string, unknown> {
  id: string;
  text: string;
  createdAtMs: number;
  sizeBytes: number;
  mimeType: string;
  status: 'recording' | 'completed' | 'cancelled' | 'interrupted';
  chunks: string[];
}

export interface LocalManagedThreadArchive {
  hostId: string;
  threadId: string;
  cwd: string | null;
  root: string | null;
  cleanupWorktree: boolean;
  pullRequestIdentityKeys: string[];
}
