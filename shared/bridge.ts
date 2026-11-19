import type { ClientRequest } from '../protocol_schema/typescript/ClientRequest';
import type { ServerNotification } from '../protocol_schema/typescript/ServerNotification';
import type { ServerRequest } from '../protocol_schema/typescript/ServerRequest';

export type ProviderKind = 'openai' | 'deepseek' | 'gemini' | 'custom';
export type WireApi = 'responses' | 'chat';
export interface ProviderModel {
  id: string;
  label?: string;
  contextWindow?: number;
  supportsImageInput?: boolean;
  reasoningEfforts?: string[];
}
export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  wireApi: WireApi;
  models: ProviderModel[];
  defaultModel: string;
  envKey?: string;
  hasApiKey?: boolean;
}
export interface ProviderRegistry {
  version: 1;
  activeProviderId: string;
  providers: ProviderConfig[];
}
export interface ProviderRegistryWrite extends Omit<ProviderRegistry, 'providers'> {
  providers: (ProviderConfig & { apiKey?: string; clearApiKey?: boolean })[];
}
export interface LocalSession {
  mode: 'byok';
  ready: boolean;
  providerId: string;
  account: { type: 'apiKey' };
  requiresOpenaiAuth: false;
}
export interface RpcError { code: number; message: string; data?: unknown }
export interface RpcNotification { method: string; params?: unknown }
export type RpcEvent = ServerNotification | ServerRequest | RpcNotification;
export interface BackendStatus {
  appServerVersion?: string | null;
  state: 'starting' | 'ready' | 'stopped' | 'error';
  message?: string;
}
export type PreferenceScope = 'applicationState' | 'persistedAtoms' | 'settings';
export interface AppPreferences {
  version: 1;
  /** OS locale; settings.localeOverride remains a separate explicit user choice. */
  locale: string;
  applicationState: Record<string, unknown>;
  persistedAtoms: Record<string, unknown>;
  settings: Record<string, unknown>;
}
export interface DiscoveredShell {
  id: 'powershell' | 'commandPrompt' | 'gitBash' | 'wsl';
  executable: string;
  args: string[];
}
export interface DiscoveredEditor {
  id: string;
  label: string;
  executable: string;
}
export interface DesktopHostDiscovery {
  platform: string;
  osRelease: string;
  osVersion: string;
  homeDirectory: string;
  codexHome: string;
  workspacesRoot: string | null;
  worktreesSegment: string | null;
  shells: DiscoveredShell[];
  editors: DiscoveredEditor[];
  wslDistributions: string[];
}
export interface OpenHostTarget {
  target: string;
  path: string;
  line?: number;
  column?: number;
}
export interface BrowserBounds { x: number; y: number; width: number; height: number }
export interface BrowserCursor {
  x: number;
  y: number;
  visible?: boolean;
  tabId?: number | string;
  action?: string;
  state?: string;
  [key: string]: unknown;
}
export interface BrowserTab {
  id: number | string;
  title: string;
  url: string;
  active?: boolean;
  sessionId?: string;
  [key: string]: unknown;
}
export interface BrowserState {
  available: boolean;
  visible: boolean;
  bounds: BrowserBounds;
  tabs: BrowserTab[];
  activeTabId: number | string | null;
  summary: string;
  action: string;
  cursor: BrowserCursor | null;
  [key: string]: unknown;
}
export interface BrowserViewState {
  visible: boolean;
  bounds?: BrowserBounds;
  tabId?: number | string;
  sessionId?: string;
}
export interface DesktopBridge {
  /** Resolve a local image path to a restricted, session-scoped image URL. */
  resolveLocalImage(input: string): Promise<string>;
  readLocalImage(input: string): Promise<{ contentsBase64: string; mimeType: string }>;
  getBrowserState(): Promise<BrowserState>;
  setBrowserView(input: BrowserViewState): Promise<BrowserState>;
  browserCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onBrowserState(listener: (state: BrowserState) => void): () => void;
  onBrowserCursor(listener: (cursor: BrowserCursor) => void): () => void;
  writeClipboardText(text: string): Promise<void>;
  readClipboardText(): Promise<string>;
  gitRequest<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  request<T = unknown>(method: ClientRequest['method'], params?: unknown): Promise<T>;
  respond(id: string | number, result?: unknown, error?: RpcError): Promise<void>;
  onEvent(listener: (event: RpcEvent) => void): () => void;
  onStatus(listener: (status: BackendStatus) => void): () => void;
  getStatus(): Promise<BackendStatus>;
  getSession(): Promise<LocalSession>;
  readProviders(): Promise<ProviderRegistry>;
  fetchProviderModels(input: { providerId: string; baseUrl: string; apiKey?: string }): Promise<ProviderModel[]>;
  writeProviders(registry: ProviderRegistryWrite): Promise<ProviderRegistry>;
  selectModel(providerId: string, model: string): Promise<ProviderRegistry>;
  chooseWorkspace(): Promise<string | null>;
  createLocalProject(input: { name: string; sources?: string[]; parentDir?: string }): Promise<{ rootPaths: string[] }>;
  readPreferences(): Promise<AppPreferences>;
  writePreference(scope: PreferenceScope, key: string, value: unknown): Promise<AppPreferences>;
  onPreferences(listener: (preferences: AppPreferences) => void): () => void;
  discoverHost(): Promise<DesktopHostDiscovery>;
  openHostTarget(target: OpenHostTarget): Promise<void>;
}
declare global { interface Window { codex: DesktopBridge } }
