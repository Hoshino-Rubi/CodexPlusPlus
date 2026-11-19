import type { DesktopBridge, ProviderConfig, ProviderKind, ProviderModel, ProviderRegistry, ProviderRegistryWrite, WireApi } from '../../../shared/bridge';
import type { Model } from '../../../protocol_schema/typescript/v2/Model';
import { getRecoveredPreferences, writeLocalThreadConfiguration } from '../recovered/viewTransport';

// These elements and hooks belong to the shipped React runtime. Never import npm React here.
type Node = unknown;
type Props = Record<string, unknown>;
type Component = unknown;
interface OriginalReact {
  Fragment: Component;
  createElement(type: Component, props?: Props | null, ...children: Node[]): Node;
  cloneElement(element: unknown, props?: Props | null, ...children: Node[]): Node;
  useState<T>(initial: T | (() => T)): [T, (value: T | ((current: T) => T)) => void];
  useRef<T>(initial: T): { current: T };
  useEffect(effect: () => void | (() => void), dependencies: unknown[]): void;
  useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, snapshot: () => T, serverSnapshot?: () => T): T;
}
interface Parts {
  View: Component; Select: Component; Field: Component; Dialog: Component;
  DialogBody: Component; DialogSection: Component; DialogTitle: Component;
  DialogActions: Component; Button: Component; Card: Component; Row: Component;
  PortalProvider: Component;
}
interface Snapshot {
  registry: ProviderRegistry | null;
  busy: boolean;
  error: string | null;
  selectionError: string | null;
  permissionsError: string | null;
}
interface CatalogData {
  models: Model[];
  defaultModel: Model | null;
  hasModelSupportingMaxReasoningEffort: boolean;
  hasModelSupportingUltraReasoningEffort: boolean;
}
interface CatalogQuery extends Props { data?: CatalogData; refetch?: (...args: unknown[]) => unknown }
type Setter = (...args: unknown[]) => unknown;
interface ComposerSettings extends Props {
  modelSettings: Props & { model?: string; isLoading?: boolean };
  selectComposerModelAndReasoningEffort?: Setter;
  setDefaultModelAndReasoningEffort?: Setter;
  setModelAndReasoningEffort?: Setter;
  setModelAndReasoningEffortForNextTurn?: Setter;
}
export interface LocalProviderUi {
  ComposerPicker: Component;
  renderSettings(parts: Parts): Node;
  useComposerSettings<T extends ComposerSettings>(settings: T, context: { hostId?: string; conversationId?: string | null }): T;
  useCatalog<T extends CatalogQuery>(query: T, context?: { hostId?: string }): T;
  renderSelectionFooter(footer: Node): Node;
  selectModel(token: string): Promise<ProviderRegistry>;
  refreshProviders(): Promise<ProviderRegistry>;
}
declare global { interface Window { __codexLocalProviderUi: LocalProviderUi } }

export function encodeLocalProviderModel(providerId: string, model: string): string {
  return `codex-local:${encodeURIComponent(providerId)}:${encodeURIComponent(model)}`;
}

function decodeModel(token: string): { providerId: string; model: string } | null {
  const match = /^codex-local:([^:]+):([^:]+)$/.exec(token);
  if (!match) return null;
  try { return { providerId: decodeURIComponent(match[1]), model: decodeURIComponent(match[2]) }; }
  catch { return null; }
}

let installation: Promise<() => void> | undefined;
let installationGeneration = 0;

/** Install before booting app-main, so its original hooks can call the adapter synchronously. */
export function installLocalProviderUi(bridge: DesktopBridge = window.codex): Promise<() => void> {
  if (installation) return installation;
  const generation = ++installationGeneration;
  const release = () => {
    if (generation === installationGeneration) {
      installation = undefined;
      installationGeneration += 1;
    }
  };
  const pending = install(bridge, release).catch(error => { release(); throw error; });
  installation = pending;
  return pending;
}

async function install(bridge: DesktopBridge, release: () => void): Promise<() => void> {
  let disposed = false;
  let adapter: LocalProviderUi | undefined;
  let unsubscribeStatus: (() => void) | undefined;
  let onProvidersChanged: ((event: Event) => void) | undefined;
  let onPermissionError: ((event: Event) => void) | undefined;
  let onPermissionsSaved: (() => void) | undefined;
  let state: Snapshot = { registry: null, busy: false, error: null, selectionError: null, permissionsError: null };
  let revision = 0;
  let refresh: Promise<ProviderRegistry> | undefined;
  const listeners = new Set<() => void>();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    revision += 1;
    unsubscribeStatus?.();
    if (onProvidersChanged) window.removeEventListener('codex:providers-changed', onProvidersChanged);
    if (onPermissionError) window.removeEventListener('codex-recovered-transport-error', onPermissionError);
    if (onPermissionsSaved) window.removeEventListener('codex-recovered-permissions-saved', onPermissionsSaved);
    window.removeEventListener('pagehide', dispose);
    listeners.clear();
    if (adapter && window.__codexLocalProviderUi === adapter) Reflect.deleteProperty(window, '__codexLocalProviderUi');
    release();
  };
  // Cover pagehide while the original runtime import or initial registry read is still pending.
  window.addEventListener('pagehide', dispose, { once: true });
  const moduleUrl = new URL('./original/assets/app-shared-624e1c099f95.js', document.baseURI);
  let shared: { OHt(): OriginalReact };
  try { shared = await import(/* @vite-ignore */ moduleUrl.href) as { OHt(): OriginalReact }; }
  catch (error) { dispose(); throw error; }
  if (disposed) return dispose;
  let React: OriginalReact;
  try { React = shared.OHt(); }
  catch (error) { dispose(); throw error; }
  const h = React.createElement.bind(React);
  const snapshot = () => state;
  const subscribe = (listener: () => void) => { if (!disposed) listeners.add(listener); return () => { listeners.delete(listener); }; };
  const publish = (patch: Partial<Snapshot>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const publishRegistry = (registry: ProviderRegistry) => {
    if (disposed) return;
    revision += 1;
    publish({ registry });
    // Publish before dispatch; our own listener recognizes this exact object and does not echo it.
    if (!disposed) window.dispatchEvent(new CustomEvent('codex:providers-changed', { detail: registry }));
  };
  const useState = () => React.useSyncExternalStore(subscribe, snapshot, snapshot);
  const message = (error: unknown) => error instanceof Error ? error.message : '无法保存 Provider 配置。';
  const clearError = () => { if (state.error) publish({ error: null }); };
  const defaultEfforts = ['minimal', 'low', 'medium', 'high', 'xhigh'];
  const modelEfforts = (model?: ProviderModel) => model?.reasoningEfforts ?? defaultEfforts;
  const modelDraft = (model: ProviderModel): ProviderModel => ({ ...model,
    contextWindow: model.contextWindow ?? 200000, supportsImageInput: model.supportsImageInput ?? true,
    reasoningEfforts: [...modelEfforts(model)],
  });

  async function refreshProviders(): Promise<ProviderRegistry> {
    if (disposed) throw new Error('Provider 界面已卸载。');
    if (refresh) return refresh;
    const startedAt = revision;
    refresh = bridge.readProviders().then(registry => {
      if (!disposed && startedAt === revision && !state.busy) publishRegistry(registry);
      return registry;
    }).catch(error => {
      if (!disposed && startedAt === revision && !state.busy) publish({ error: message(error) });
      throw error;
    }).finally(() => { refresh = undefined; });
    return refresh;
  }

  async function mutate(operation: () => Promise<ProviderRegistry>, selection = false): Promise<ProviderRegistry> {
    if (disposed) throw new Error('Provider 界面已卸载。');
    if (state.busy) throw new Error('Provider 配置正在保存，请稍后重试。');
    const startedAt = ++revision;
    publish({ busy: true, error: null, ...(selection ? { selectionError: null } : {}) });
    try {
      const registry = await operation();
      if (!disposed && startedAt === revision) publishRegistry(registry);
      return registry;
    } catch (error) {
      if (disposed) throw error;
      let failure = error;
      publish({ error: message(error), ...(selection ? { selectionError: message(error) } : {}) });
      const recoveryAt = ++revision;
      try {
        // A failed save can follow a successful disk write. Read back once, never repeat the mutation.
        // Bypass a pre-mutation refresh promise, whose result may describe the old registry.
        const registry = await bridge.readProviders();
        if (!disposed && recoveryAt === revision) publishRegistry(registry);
      } catch (readError) {
        failure = new Error(`${message(error)}；读取实际保存的 Provider 配置也失败：${message(readError)}`, { cause: error });
      }
      if (!disposed) publish({ error: message(failure), ...(selection ? { selectionError: message(failure) } : {}) });
      throw failure;
    } finally {
      publish({ busy: false });
    }
  }

  function requireRegistry(): ProviderRegistry {
    if (!state.registry) throw new Error('Provider 配置尚未载入。');
    return state.registry;
  }

  async function selectModel(token: string): Promise<ProviderRegistry> {
    const decoded = decodeModel(token);
    if (!decoded) throw new Error('模型选择缺少 Provider 标识。');
    const provider = requireRegistry().providers.find(item => item.id === decoded.providerId);
    if (!provider?.models.some(item => item.id === decoded.model)) throw new Error('模型已从 Provider 配置移除，请重新选择。');
    const registry = requireRegistry();
    if (registry.activeProviderId === provider.id && provider.defaultModel === decoded.model) return registry;
    return mutate(() => bridge.selectModel(provider.id, decoded.model), true);
  }

  function errorNode(text: string | null): Node {
    return text ? h('p', { role: 'alert', className: 'text-danger' }, text) : null;
  }

  function SelectionFooter({ footer }: { footer: Node }): Node {
    const saved = useState();
    return h(React.Fragment, null, footer, errorNode(saved.selectionError), errorNode(saved.permissionsError));
  }

  function renderSelectionFooter(footer: Node): Node {
    return footer == null && !state.selectionError && !state.permissionsError ? null : h(SelectionFooter, { footer });
  }

  function ComposerPicker({ View, Menu, Submenu, Item, Message, ModelLabel, SpeedMenu, effortLabels, ...props }: Props): Node {
    const saved = useState();
    if (typeof props.model !== 'string' || !decodeModel(props.model)) return h(View, props);
    const models = saved.registry?.providers.flatMap(provider => provider.models.map(model => ({
      model: encodeLocalProviderModel(provider.id, model.id), displayName: `${provider.name} · ${model.label ?? model.id}`,
      contextWindow: model.contextWindow ?? 200000,
      description: provider.name, defaultReasoningEffort: modelEfforts(model).includes('medium') ? 'medium' : modelEfforts(model)[0] ?? 'none',
      supportedReasoningEfforts: modelEfforts(model).map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })),
    }))) ?? [];
    const selected = models.find(model => model.model === props.model);
    const contextWindow = selected?.contextWindow ?? 200000;
    const contextLabel = contextWindow >= 1000000 ? `${Number((contextWindow / 1000000).toFixed(2))}M` : `${Number((contextWindow / 1000).toFixed(2))}k`;
    const efforts = selected?.supportedReasoningEfforts.map(item => item.reasoningEffort) ?? defaultEfforts;
    const effort = typeof props.reasoningEffort === 'string' && efforts.includes(props.reasoningEffort) ? props.reasoningEffort : selected?.defaultReasoningEffort ?? 'medium';
    const labels = effortLabels as Record<string, Props>;
    const effortLabel = (value: string) => labels[value] ? h(Message, labels[value]) : value;
    const label = (id: string, defaultMessage: string) => h(Message, { id, defaultMessage });
    const disabled = props.disabled === true || saved.busy;
    const complete = () => {
      (props.onOpenChange as Setter | undefined)?.(false);
      (props.onSelectComplete as Setter | undefined)?.();
    };
    const choose = (model: string, reasoningEffort: string) => {
      if (disabled || (props.onBeforeSelectModel as Setter | undefined)?.(model) === false) return;
      if (typeof props.onSelectModel !== 'function') return;
      (props.onSelectModel as Setter)(model, reasoningEffort);
      (props.onSelectModelOption as Setter | undefined)?.();
      complete();
    };
    // Retain the shipped trigger, tooltip, focus handling and dropdown/submenu primitives.
    // Replace only the trigger's visible label; explicit whitespace prevents model/effort concatenation.
    const originalTrigger = props.triggerButton as { props?: { children?: { props?: Props } } } | undefined;
    const button = originalTrigger?.props?.children;
    const trigger = button?.props ? React.cloneElement(originalTrigger, null,
      React.cloneElement(button, { disabled, 'data-local-model-trigger': true,
        'data-local-model-context-window': contextWindow, title: `${selected?.displayName ?? props.model} · 上下文上限 ${contextWindow} tokens` },
        h('span', { 'data-local-model-label': true }, selected?.displayName ?? props.model, ' ', effortLabel(effort)),
        h('span', { 'data-local-model-context': true, 'aria-label': `上下文上限 ${contextWindow} tokens`,
          style: { flexShrink: 0, fontSize: '12px' } }, contextLabel))) : props.triggerButton;
    const tiers = Array.isArray(props.serviceTierOptions) ? props.serviceTierOptions : [];
    const menu = h(Menu, {
      align: props.align, contentRef: props.contentRef, disabled, open: props.open,
      onOpenChange: props.onOpenChange, onCloseAutoFocus: props.onCloseAutoFocus,
      onEscapeKeyDown: props.onEscapeKeyDown, triggerButton: trigger,
    },
    h(Submenu, { label: label('chatgptConversations.composer.modelSlashCommand.title', 'Model'),
      value: selected?.displayName, disabled },
    ...models.map(model => h(Item, { key: model.model, role: 'menuitemradio',
      'aria-checked': model.model === props.model,
      onSelect: () => choose(model.model, model.supportedReasoningEfforts.some(item => item.reasoningEffort === effort) ? effort : model.defaultReasoningEffort),
    }, h(ModelLabel, { model: model.model, displayName: model.displayName, stripGptPrefix: false })))),
    h(Submenu, { label: label('composer.reasoningEffort.label', '推理強度'), value: effortLabel(effort),
      disabled: disabled || props.reasoningEffortDisabled === true },
    ...efforts.map(value => h(Item, {
      key: value, role: 'menuitemradio', 'aria-checked': value === effort,
      onSelect: () => choose(String(props.model), value),
    }, effortLabel(value)))),
    tiers.length > 0 ? h(SpeedMenu, {
      selectedServiceTier: props.selectedServiceTier, serviceTierOptions: tiers,
      serviceTierOptionsLoading: props.serviceTierOptionsLoading,
      onSelectServiceTier: props.onSelectServiceTier, onSelectComplete: complete,
      disabled: disabled || typeof props.onSelectServiceTier !== 'function',
    }) : h(Submenu, { label: label('settings.agent.speed.label', 'Speed'), disabled },
      h(Item, { role: 'menuitemradio', 'aria-checked': true, onSelect: complete },
        label('composer.intelligencePicker.standardMode.label', '標準'))),
    h(Item, { disabled, onSelect: () => {
      if (typeof props.onSelectDefault === 'function') (props.onSelectDefault as Setter)();
      else if (selected) choose(selected.model, 'medium');
      (props.onSelectServiceTier as Setter | undefined)?.(null);
      complete();
    } }, label('composer.modelPicker.resetToDefault', 'Reset to default')),
    props.menuFooter);
    return h(React.Fragment, null, menu, h(SelectionFooter, { footer: null }));
  }

  function useComposerSettings<T extends ComposerSettings>(original: T, context: { hostId?: string; conversationId?: string | null }): T {
    const saved = useState();
    if (context.hostId && context.hostId !== 'local') return original;
    const provider = saved.registry?.providers.find(item => item.id === saved.registry?.activeProviderId);
    const records = getRecoveredPreferences().applicationState['local-thread-configurations'] as Record<string, { model?: string; modelProvider?: string }> | undefined;
    const thread = context.conversationId ? records?.[context.conversationId] : undefined;
    const originalModel = original.modelSettings.model;
    const token = originalModel ? decodeModel(originalModel) : null;
    const model = thread?.model && thread.modelProvider ? encodeLocalProviderModel(thread.modelProvider, thread.model)
      : context.conversationId && token ? originalModel
        : provider ? encodeLocalProviderModel(provider.id, provider.defaultModel) : originalModel;
    const wrap = (setter: Setter | undefined): Setter | undefined => setter && (async (...args: unknown[]) => {
      const selected = String(args[0]);
      const decoded = decodeModel(selected);
      if (!decoded) {
        publish({ selectionError: '模型选择缺少 Provider 标识，请重新打开模型菜单。' });
        return false;
      }
      try {
        await selectModel(selected);
        if (disposed) return false;
        if (context.conversationId) {
          await writeLocalThreadConfiguration({ threadId: context.conversationId, model: selected });
          publish({ selectionError: null });
        }
        // Thread configuration retains provider identity. Native config writes
        // made by the original setter must only receive the raw model name.
        const applied = await setter(decoded.model, ...args.slice(1));
        if (applied === false) publish({ selectionError: '模型已保存，但当前会话设置未应用，请重试。' });
        return applied;
      } catch (error) {
        publish({ selectionError: message(error) });
        return false;
      }
    });
    return {
      ...original,
      modelSettings: { ...original.modelSettings, model, isLoading: !provider || saved.busy },
      selectComposerModelAndReasoningEffort: wrap(original.selectComposerModelAndReasoningEffort),
      setDefaultModelAndReasoningEffort: wrap(original.setDefaultModelAndReasoningEffort),
      setModelAndReasoningEffort: wrap(original.setModelAndReasoningEffort),
      setModelAndReasoningEffortForNextTurn: wrap(original.setModelAndReasoningEffortForNextTurn),
    } as T;
  }

  function useCatalog<T extends CatalogQuery>(query: T, context?: { hostId?: string }): T {
    const saved = useState();
    if (context?.hostId && context.hostId !== 'local') return query;
    if (!saved.registry) return { ...query, status: saved.error ? 'error' : 'pending', isLoading: !saved.error };
    const models = saved.registry.providers.flatMap(provider => provider.models.map(item => {
      const token = encodeLocalProviderModel(provider.id, item.id);
      const native = query.data?.models.find(candidate => candidate.model === token);
      const model: Model = {
        id: token, model: token, displayName: `${provider.name} · ${item.label ?? item.id}`,
        description: provider.name, upgrade: null, upgradeInfo: null, availabilityNux: null,
        modelSpecialty: null, hidden: false,
        supportsPersonality: false,
        multiAgentVersion: null, additionalSpeedTiers: [], serviceTiers: [],
        defaultServiceTier: null, availableAccessPrograms: null,
        ...native,
        inputModalities: item.supportsImageInput === false ? ['text'] : ['text', 'image'],
        supportedReasoningEfforts: modelEfforts(item).map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })),
        defaultReasoningEffort: modelEfforts(item).includes('medium') ? 'medium' : modelEfforts(item)[0] ?? 'none',
        isDefault: provider.id === saved.registry?.activeProviderId && item.id === provider.defaultModel,
      };
      return model;
    }));
    return {
      ...query, status: 'success', isLoading: false, isPending: false, isError: false,
      isFetching: saved.busy,
      data: {
        models, defaultModel: models.find(item => item.isDefault) ?? null,
        hasModelSupportingMaxReasoningEffort: models.some(item => item.supportedReasoningEfforts.some(effort => effort.reasoningEffort === 'max')),
        hasModelSupportingUltraReasoningEffort: models.some(item => item.supportedReasoningEfforts.some(effort => effort.reasoningEffort === 'ultra')),
      },
      refetch: async (...args: unknown[]) => {
        await refreshProviders();
        return query.refetch?.(...args);
      },
    } as T;
  }

  type Draft = {
    id: string; name: string; kind: ProviderKind; baseUrl: string; wireApi: WireApi;
    models: ProviderModel[]; defaultModel: string; apiKey: string; clearApiKey: boolean;
  };
  const makeDraft = (provider?: ProviderConfig): Draft => ({
    id: provider?.id ?? `provider-${crypto.randomUUID().slice(0, 8)}`, name: provider?.name ?? '', kind: provider?.kind ?? 'custom',
    baseUrl: provider?.baseUrl ?? '', wireApi: provider?.wireApi ?? 'responses',
    models: provider?.models.map(modelDraft) ?? [],
    defaultModel: provider?.defaultModel ?? '', apiKey: '', clearApiKey: false,
  });
  function ProviderEditor({ parts: p, provider, close, inline = false }: { parts: Parts; provider?: ProviderConfig; close(): void; inline?: boolean }): Node {
    const saved = useState();
    const [draft, setDraft] = React.useState(() => makeDraft(provider));
    const [localError, setLocalError] = React.useState<string | null>(null);
    const [confirmDelete, setConfirmDelete] = React.useState(false);
    const [portal, setPortal] = React.useState<HTMLElement | null>(null);
    const [probingModels, setProbingModels] = React.useState(false);
    const [probeError, setProbeError] = React.useState<string | null>(null);
    const [showApiKey, setShowApiKey] = React.useState(true);
    const probe = React.useRef({ generation: 0, active: true });
    React.useEffect(() => {
      probe.current.active = true;
      return () => { probe.current.active = false; probe.current.generation += 1; };
    }, []);
    const change = (patch: Partial<Draft>) => {
      if (['id', 'baseUrl', 'apiKey', 'clearApiKey'].some(key => key in patch)) {
        probe.current.generation += 1;
        setProbingModels(false);
        setProbeError(null);
      }
      setDraft(current => ({ ...current, ...patch })); setLocalError(null); clearError();
    };
    async function fetchModels(): Promise<void> {
      const generation = ++probe.current.generation;
      setProbingModels(true);
      setProbeError(null);
      try {
        const discovered = await bridge.fetchProviderModels({
          providerId: draft.id.trim(), baseUrl: draft.baseUrl.trim(),
          apiKey: draft.apiKey,
        });
        if (disposed || !probe.current.active || generation !== probe.current.generation) return;
        setDraft(current => {
          const merged = new Map(current.models.map(model => [model.id, model]));
          for (const model of discovered) if (!merged.has(model.id)) merged.set(model.id, modelDraft(model));
          const models = [...merged.values()];
          return { ...current, models,
            defaultModel: current.defaultModel || models[0]?.id || '' };
        });
      } catch (error) {
        if (!disposed && probe.current.active && generation === probe.current.generation) setProbeError(error instanceof Error ? error.message : '无法探测模型。');
      } finally {
        if (!disposed && probe.current.active && generation === probe.current.generation) setProbingModels(false);
      }
    }
    const models = draft.models.map(model => ({ ...model, id: model.id.trim(), label: model.label?.trim() || undefined }));
    const active = provider?.id === saved.registry?.activeProviderId;
    const cannotDelete = active || (saved.registry?.providers.length ?? 0) < 2;
    const field = (label: string, key: 'name' | 'baseUrl' | 'apiKey', extra: Props = {}) => h(p.Field, {
      label, value: draft[key], disabled: saved.busy, required: key !== 'apiKey',
      onChange: (value: string) => change({ [key]: value }), ...extra,
    });
    const row = (label: string, control: Node) => h(p.Card, { variant: 'form', contentOverflow: 'visible' }, h(p.Row, { label, control }));
    const updateModel = (index: number, patch: Partial<ProviderModel>) => {
      const previous = draft.models[index];
      const models = draft.models.map((model, at) => at === index ? { ...model, ...patch } : model);
      change({ models, ...(patch.id !== undefined && previous.id === draft.defaultModel ? { defaultModel: patch.id } : {}) });
    };
    const modelRows = draft.models.map((model, index) => h('section', {
      key: index, 'data-provider-model': model.id,
      className: 'flex min-w-0 flex-col gap-4',
      style: { border: '1px solid var(--color-border)', borderRadius: '12px', padding: '16px' },
    }, h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
      h('span', { className: 'min-w-0 flex-1 text-sm font-medium', style: { overflowWrap: 'anywhere' } }, model.label || model.id || '新模型'),
      h(p.Button, { type: 'button', color: 'secondary', size: 'dialogAction', disabled: saved.busy,
        'aria-label': `删除模型 ${model.label || model.id || index + 1}`,
        onClick: () => {
          const models = draft.models.filter((_, at) => at !== index);
          change({ models, defaultModel: model.id === draft.defaultModel ? models[0]?.id ?? '' : draft.defaultModel });
        } }, '删除模型')),
      h(p.Field, { label: '模型 ID / Slug', value: model.id, disabled: saved.busy,
        onChange: (id: string) => updateModel(index, { id }) }),
      h(p.Field, { label: '显示名称', value: model.label ?? '', disabled: saved.busy, required: false,
        onChange: (label: string) => updateModel(index, { label }) }),
      h(p.Field, { label: '上下文窗口', type: 'number', min: 1, step: 1, value: String(model.contextWindow ?? 200000), disabled: saved.busy,
        onChange: (value: string) => updateModel(index, { contextWindow: Number(value) }) }),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' }, 'aria-label': '上下文窗口快捷档位' },
        ...[128000, 200000, 256000, 1000000].map(value => h(p.Button, { key: value, type: 'button', color: 'secondary', size: 'dialogAction', disabled: saved.busy,
          'aria-pressed': model.contextWindow === value, onClick: () => updateModel(index, { contextWindow: value }) }, String(value)))),
      h('label', { className: 'flex items-center gap-2 text-sm' },
        h('input', { type: 'checkbox', checked: model.supportsImageInput !== false, disabled: saved.busy,
          onChange: (event: Event) => updateModel(index, { supportsImageInput: (event.target as HTMLInputElement).checked }) }), '支持图像输入'),
      h('fieldset', { className: 'min-w-0', disabled: saved.busy }, h('legend', { className: 'text-sm font-medium' }, '推理强度档位'),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '12px', marginTop: '8px' } },
          ...['none', ...defaultEfforts, 'max', 'ultra'].map(effort => h('label', { key: effort, className: 'flex items-center gap-2 text-sm' },
            h('input', { type: 'checkbox', checked: modelEfforts(model).includes(effort),
              onChange: (event: Event) => updateModel(index, { reasoningEfforts: (event.target as HTMLInputElement).checked
                ? [...modelEfforts(model), effort] : modelEfforts(model).filter(value => value !== effort) }) }), effort))))));
    async function save(): Promise<void> {
      const registry = requireRegistry();
      const id = draft.id.trim();
      try {
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id) || ['__proto__', 'prototype', 'constructor'].includes(id)) throw new Error('Provider ID 必须以字母开头，且只包含字母、数字、下划线和连字符。');
        if (id === 'openai') throw new Error('openai 是后端保留的 Provider ID，请使用 openai-custom。');
        if (!provider && registry.providers.some(item => item.id === id)) throw new Error('Provider ID 已存在。');
        if (!draft.name.trim()) throw new Error('请输入 Provider 名称。');
        const url = new URL(draft.baseUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Base URL 必须为 HTTP(S) 地址，且不包含账号、查询串或片段。');
        if (models.length < 1 || models.length > 256 || models.some(item => /\s/.test(item.id)) || new Set(models.map(item => item.id)).size !== models.length) throw new Error('请填写 1 至 256 个不重复且不含空白的模型 ID。');
        if (models.some(item => !item.id || !Number.isSafeInteger(item.contextWindow) || (item.contextWindow ?? 0) <= 0)) throw new Error('每个模型都需要模型 ID 与大于零的整数上下文窗口。');
        if (!models.some(item => item.id === draft.defaultModel)) throw new Error('请选择模型列表中的默认模型。');
        const next: ProviderRegistryWrite['providers'][number] = {
          id, name: draft.name.trim(), kind: draft.kind, baseUrl: url.href,
          wireApi: ['deepseek', 'gemini'].includes(draft.kind) ? 'chat' : draft.wireApi,
          models, defaultModel: draft.defaultModel,
          ...(provider?.envKey ? { envKey: provider.envKey } : {}),
          ...(draft.apiKey.trim() ? { apiKey: draft.apiKey } : {}),
          ...(draft.clearApiKey && !draft.apiKey.trim() ? { clearApiKey: true } : {}),
        };
        const providers = provider ? registry.providers.map(item => item.id === provider.id ? next : item) : [...registry.providers, next];
        await mutate(() => bridge.writeProviders({ ...registry, providers }));
        if (!disposed) close();
      } catch (error) { if (!disposed) setLocalError(message(error)); }
    }
    async function remove(): Promise<void> {
      if (!provider || cannotDelete) return;
      const registry = requireRegistry();
      try {
        await mutate(() => bridge.writeProviders({ ...registry, providers: registry.providers.filter(item => item.id !== provider.id) }));
        if (!disposed) close();
      } catch (error) { if (!disposed) setLocalError(message(error)); }
    }
    const cancelButton = h(p.Button, { type: 'button', color: 'secondary', radius: 'full', size: 'dialogAction', disabled: saved.busy, onClick: confirmDelete ? () => setConfirmDelete(false) : close }, '取消');
    const actions = confirmDelete
      ? [cancelButton, h(p.Button, { type: 'button', color: 'danger', radius: 'full', size: 'dialogAction', disabled: saved.busy || cannotDelete, onClick: () => { void remove(); } }, '删除')]
      : [provider ? h('div', { className: 'me-auto' }, h(p.Button, {
        type: 'button', color: 'danger', radius: 'full', size: 'dialogAction', disabled: saved.busy || cannotDelete,
        title: active ? '请先选择另一个默认 Provider。' : undefined, onClick: () => setConfirmDelete(true),
      }, '删除')) : null, cancelButton, h(p.Button, { type: 'submit', radius: 'full', size: 'dialogAction', loading: saved.busy, disabled: saved.busy }, '保存')];
    const body = confirmDelete
      ? h(p.DialogSection, { className: 'text-codex-description' }, '此操作将删除本地 Provider 配置。以后仍可重新添加。', errorNode(localError ?? saved.error))
      : h(p.DialogSection, { spacing: 'large' }, h('fieldset', { disabled: saved.busy, className: 'min-w-0' }, h('div', { className: 'flex min-w-0 flex-col gap-4' },
        errorNode(localError ?? saved.error), field('名称', 'name'),
        row('Provider 类型', h(p.Select, { value: draft.kind, disabled: saved.busy, options: [
          { value: 'openai', label: 'OpenAI' }, { value: 'deepseek', label: 'DeepSeek' },
          { value: 'gemini', label: 'Gemini' }, { value: 'custom', label: '自定义' },
        ], onChange: (kind: ProviderKind) => change({ kind, ...(['deepseek', 'gemini'].includes(kind) ? { wireApi: 'chat' as const } : {}) }) })),
        field('Base URL', 'baseUrl'),
        row('API 协议', h(p.Select, { value: draft.wireApi, disabled: saved.busy || ['deepseek', 'gemini'].includes(draft.kind), options: [
          { value: 'responses', label: 'Responses' }, { value: 'chat', label: 'Chat Completions' },
        ], onChange: (wireApi: WireApi) => change({ wireApi }) })),
        h('div', { style: { display: 'flex', alignItems: 'end', gap: '8px' } },
          h('div', { style: { flex: 1, minWidth: '0px' } }, field('API Key', 'apiKey', {
            type: showApiKey ? 'text' : 'password', autoComplete: 'off',
            placeholder: draft.clearApiKey ? '保存后清除本地密钥' : provider?.hasApiKey ? '已保存本地密钥（输入新密钥覆盖，留空保持不变）' : '输入 API Key',
            onChange: (apiKey: string) => change({ apiKey, clearApiKey: false }),
          })),
          h(p.Button, { type: 'button', color: 'secondary', size: 'dialogAction', disabled: saved.busy,
            'aria-label': showApiKey ? '隐藏 API Key' : '显示 API Key', 'aria-pressed': showApiKey,
            onClick: () => setShowApiKey(value => !value) }, h('img', {
              src: new URL(`./original/assets/${showApiKey ? 'eye_off-d20f17d902f4.svg' : 'eye-603639c70cc9.svg'}`, document.baseURI).href,
              width: 16, height: 16, alt: '',
            })),
          provider?.hasApiKey ? h(p.Button, { type: 'button', color: 'secondary', size: 'dialogAction', disabled: saved.busy,
            onClick: () => change({ apiKey: '', clearApiKey: true }) }, '清除') : null),
        h('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' } },
          h('span', { className: 'min-w-0 flex-1 text-sm font-medium' }, '模型配置'),
          h(p.Button, { type: 'button', color: 'secondary', radius: 'full', size: 'dialogAction', disabled: saved.busy || models.length >= 256,
            onClick: () => change({ models: [...draft.models, modelDraft({ id: '' })] }) }, '新增模型'),
          h(p.Button, { type: 'button', color: 'secondary', radius: 'full', size: 'dialogAction', loading: probingModels,
            disabled: saved.busy || probingModels || draft.clearApiKey || !draft.baseUrl.trim(), onClick: () => { void fetchModels(); } }, '探测模型')),
        errorNode(probeError),
        ...modelRows,
        row('默认模型', h(p.Select, { value: draft.defaultModel, disabled: saved.busy || models.length === 0, options: models.map(item => ({ value: item.id, label: item.label ?? item.id })), onChange: (defaultModel: string) => change({ defaultModel }) })),
      )));
    if (inline) return h('section', { 'data-provider-config': provider?.id, className: 'min-w-0', style: { marginTop: '16px' } },
      h('form', { className: 'group/settings min-w-0', 'data-density': 'form',
        onSubmit: (event: Event) => { event.preventDefault(); if (!saved.busy) void (confirmDelete ? remove() : save()); } },
        h(p.DialogSection, null, h('h3', { className: 'text-sm font-medium' }, confirmDelete ? `删除 ${provider?.name ?? ''}？` : `${provider?.name ?? ''} · 模型配置`)),
        body, h(p.DialogSection, { spacing: 'large' }, h(p.DialogActions, { expandSingleButton: false }, ...actions))));
    return h(p.PortalProvider, { radixPortalContainer: portal ?? undefined }, h(p.Dialog, {
      open: true, variant: 'form', size: 'wide', contentOverflow: 'visible',
      contentProps: { shouldStopPointerDownPropagation: false },
      onOpenChange: (open: boolean) => { if (!open && !saved.busy) close(); },
    }, h(p.DialogBody, {
      as: 'form', className: 'group/settings max-h-[min(var(--dialog-top-content-max-height),calc(85dvh/var(--codex-window-zoom)))] overflow-y-auto',
      style: { maxHeight: 'min(74vh, 640px)', overflowY: 'auto', paddingRight: '4px' },
      'data-density': 'form', onSubmit: (event: Event) => { event.preventDefault(); if (!saved.busy) void (confirmDelete ? remove() : save()); },
    }, h(p.DialogSection, null, h(p.DialogTitle, { className: 'text-form-title' }, confirmDelete ? `删除 ${provider?.name ?? ''}？` : provider ? `编辑 ${provider.name}` : '添加 Provider')),
    body, h(p.DialogSection, { spacing: 'large', style: { position: 'sticky', bottom: '0px', zIndex: 1, background: 'var(--color-surface)' } }, h(p.DialogActions, { expandSingleButton: false }, ...actions))),
    h('div', { ref: setPortal })));
  }

  function ProviderSettings({ parts }: { parts: Parts }): Node {
    const saved = useState();
    const [editor, setEditor] = React.useState<string | null>(null);
    if (!saved.registry) return h('p', { role: 'status' }, saved.error ?? '正在载入 Provider 配置…');
    const registry = saved.registry;
    const gateways = registry.providers.map(provider => ({
      id: provider.id, name: provider.name, type: 'custom', config: { base_url: provider.baseUrl }, managed: false, external: false,
    }));
    return h(parts.View, {
      gateways, selectedProvider: registry.activeProviderId, selectionManaged: false,
      busy: saved.busy, error: errorNode(saved.error), restartRequired: false,
      onSelect: (id: string) => {
        const provider = registry.providers.find(item => item.id === id);
        if (provider) {
          clearError();
          setEditor(current => current === id ? null : id);
          void selectModel(encodeLocalProviderModel(provider.id, provider.defaultModel)).catch(() => undefined);
        }
      },
      onAdd: () => { clearError(); setEditor(':new'); },
      onEdit: (provider: { id: string }) => { clearError(); setEditor(current => current === provider.id ? null : provider.id); },
      onTest: null,
      children: editor ? h(ProviderEditor, {
        key: editor, parts, provider: registry.providers.find(item => item.id === editor), inline: editor !== ':new', close: () => setEditor(null),
      }) : null,
    });
  }

  adapter = {
    ComposerPicker,
    renderSettings: parts => h(ProviderSettings, { parts }),
    useComposerSettings, useCatalog, renderSelectionFooter, selectModel, refreshProviders,
  };
  try {
    window.__codexLocalProviderUi = adapter;
    onProvidersChanged = (event: Event) => {
      if (disposed) return;
      const registry = (event as CustomEvent<ProviderRegistry>).detail;
      if (registry && registry !== state.registry) { revision += 1; publish({ registry }); }
    };
    window.addEventListener('codex:providers-changed', onProvidersChanged);
    onPermissionError = (event: Event) => {
      const detail = (event as CustomEvent<{ context?: unknown; error?: { message?: unknown } }>).detail;
      if (!disposed && typeof detail?.context === 'string' && detail.context.startsWith('permissions:') && typeof detail.error?.message === 'string') {
        publish({ permissionsError: detail.error.message });
      }
    };
    onPermissionsSaved = () => { if (state.permissionsError) publish({ permissionsError: null }); };
    window.addEventListener('codex-recovered-transport-error', onPermissionError);
    window.addEventListener('codex-recovered-permissions-saved', onPermissionsSaved);
    unsubscribeStatus = bridge.onStatus(status => {
      if (!disposed && status.state === 'ready' && !state.busy) void refreshProviders().catch(() => undefined);
    });
    await refreshProviders().catch(() => undefined);
    return dispose;
  } catch (error) { dispose(); throw error; }
}
