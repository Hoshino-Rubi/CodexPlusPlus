import {
  useEffect,
  useId,
  useState,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type {
  ProviderConfig,
  ProviderKind,
  ProviderModel,
  ProviderRegistry,
  ProviderRegistryWrite,
  WireApi,
} from '../../../shared/bridge';

// Recovered from the generated SettingsDialog patch in ui-SettingsDialog.log.
// Dialog/body classes: app-shared-624e1c099f95.js; settings form classes:
// settings-form-9aed74b17655.css and settings-group-21d1f27f2725.js.
// Close SVG paths: lucide-x-e857cba43c32afd2.js, copied without a library dependency.
// TODO(stub): The original shared dialog focus-scope primitive is not reconstructed.

const PROVIDER_LIMIT = 32;
const MODEL_LIMIT = 256;
const PROVIDER_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const RESERVED_PROVIDER_IDS = new Set<string>([
  'openai',
  'ollama',
  'lmstudio',
  'amazon-bedrock',
  'amazon-bedrock-runtime',
  '__proto__',
  'prototype',
  'constructor',
]);

const KIND_LABELS: Record<ProviderKind, string> = {
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  gemini: 'Gemini',
  custom: 'Gateway',
};

const KIND_DESCRIPTIONS: Record<ProviderKind, string> = {
  openai: 'OpenAI Responses and Chat Completions.',
  deepseek: 'DeepSeek Chat Completions with reasoning content.',
  gemini: 'Gemini through an OpenAI-compatible endpoint.',
  custom: 'Connect an OpenAI-compatible gateway.',
};

const DEFAULT_BASE_URLS: Record<ProviderKind, string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  custom: '',
};

const DEFAULT_WIRE_API: Record<ProviderKind, WireApi> = {
  openai: 'responses',
  deepseek: 'chat',
  gemini: 'chat',
  custom: 'responses',
};

const DEFAULT_MODELS: Record<ProviderKind, ProviderModel[]> = {
  openai: [{ id: 'gpt-5' }],
  deepseek: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
  gemini: [{ id: 'gemini-2.5-pro' }, { id: 'gemini-2.5-flash' }],
  custom: [],
};

const MESSAGES = {
  nameRequired: 'Enter a name.',
  nameInvalid: 'Enter a name without control characters.',
  urlRequired: 'Enter a base URL.',
  urlInvalid: 'Enter a valid base URL, such as https://example.com/v1.',
  urlScheme: 'Start the base URL with http:// or https://.',
  urlCredentials: 'Remove the username and password from the base URL.',
  urlFragment: 'Remove the fragment (the # and anything after it) from the base URL.',
  urlQuery: 'Remove the query string (the ? and anything after it) from the base URL.',
  envRequired: 'Enter the API key environment variable.',
  envInvalid:
    'Use letters, numbers, and underscores for the environment variable name. Start with a letter or underscore.',
  apiKeyInvalid: 'The API key is too long or contains a line break.',
  apiKeyConflict: 'Choose either a new API key or clear the saved key, not both.',
  wireApiChat: 'DeepSeek and Gemini use the Chat Completions protocol.',
  modelsRequired: 'Add at least one model.',
  modelsLimit: 'You can configure up to 256 models.',
  modelIdRequired: 'Enter a model ID.',
  modelIdWhitespace: 'Model IDs cannot contain spaces.',
  modelIdInvalid: 'Enter a valid model ID.',
  modelIdDuplicate: 'Model IDs must be unique.',
  modelLabelInvalid: 'Enter a model label without control characters.',
  defaultModelRequired: 'Choose a default model.',
  defaultModelMissing: 'Choose a default model from the model list.',
  providersRequired: 'Add at least one provider before saving.',
  providersLimit: 'You can configure up to 32 providers.',
  providerIdInvalid: 'One or more provider IDs are invalid.',
  providerIdDuplicate: 'Provider IDs must be unique.',
  activeRequired: 'Choose a default provider.',
  registryUnavailable: 'Provider settings are not available yet.',
  saveFallback: 'Could not save providers. Try again.',
};

const BUTTON_BASE_CLASS =
  'no-drag cursor-interaction items-center select-none disabled:cursor-default aria-disabled:cursor-default focus:outline-hidden disabled:opacity-40 aria-disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 whitespace-nowrap flex border gap-1 rounded-full';
const BUTTON_DIALOG_ACTION_CLASS = 'min-h-9 shrink-0 px-4 text-sm font-medium';
const BUTTON_PRIMARY_CLASS =
  'border-default bg-primary-solid not-disabled:not-aria-disabled:hover:bg-text/80 data-[state=open]:bg-text/80 text-primary-solid';
const BUTTON_SECONDARY_CLASS =
  'text-default bg-text/5 not-disabled:not-aria-disabled:hover:bg-text/10 data-[state=open]:bg-text/10 border-transparent';
const BUTTON_DANGER_CLASS =
  'bg-chart-red/10 not-disabled:not-aria-disabled:hover:bg-chart-red/20 text-chart-red border-transparent';

const CLOSE_BUTTON_CLASS =
  'no-drag cursor-interaction leading-none hover:bg-primary-ghost-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 text-tertiary hover:text-default flex items-center justify-center rounded-full size-8 absolute top-4 right-3.5';

const INPUT_BASE_CLASS =
  'min-w-0 border text-default outline-none placeholder:text-tertiary aria-invalid:border-text-danger aria-invalid:ring-2 aria-invalid:ring-text-danger/20 disabled:cursor-not-allowed disabled:text-secondary';
const INPUT_FORM_CLASS = `${INPUT_BASE_CLASS} h-12 rounded-2xl border-default bg-transparent px-5 text-form-body font-normal w-full`;
const INPUT_OUTLINED_CLASS = `${INPUT_BASE_CLASS} h-9.5 rounded-lg border-default bg-surface px-3 py-2 text-sm leading-5 w-full`;

const DIALOG_OVERLAY_CLASS =
  'codex-dialog-overlay inset-0 z-50 pointer-events-auto fixed _dimmedOverlay_1u8c7_2';
const DIALOG_OVERLAY_DEFAULT_CLASS =
  'codex-dialog-overlay inset-0 z-50 pointer-events-auto fixed bg-(--color-dialog-overlay)';
const DIALOG_SURFACE_CLASS =
  'codex-dialog z-50 outline-none fixed left-1/2 -translate-x-1/2 -translate-y-1/2 top-1/2 text-default rounded-form-dialog bg-surface-elevated-secondary shadow-form-dialog ring-[0.5px] ring-border max-w-[92vw] overflow-hidden';
const DIALOG_SURFACE_WIDE_CLASS = `${DIALOG_SURFACE_CLASS} w-150`;
const DIALOG_SURFACE_DEFAULT_CLASS =
  'codex-dialog z-50 outline-none fixed left-1/2 -translate-x-1/2 -translate-y-1/2 top-1/2 w-130 text-default rounded-3xl bg-surface-elevated-secondary/90 backdrop-blur-xl shadow-lg ring-[0.5px] ring-border max-w-[92vw] overflow-hidden';
const DIALOG_BODY_CLASS = 'flex flex-col text-base leading-normal tracking-normal gap-0 _body_rmnvu_2';
const DIALOG_BODY_SCROLL_CLASS = `${DIALOG_BODY_CLASS} group/settings [--dialog-top-content-max-height:calc(var(--spacing)*190)] max-h-[min(var(--dialog-top-content-max-height),calc(85dvh/var(--codex-window-zoom)))] overflow-y-auto`;
const DIALOG_FOOTER_CLASS = 'flex w-full flex-wrap items-center justify-end gap-3 _footer_rmnvu_2';
const DIALOG_SECTION_CLASS = 'flex w-full flex-col _section_rmnvu_2';
const DIALOG_LARGE_SECTION_CLASS = `${DIALOG_SECTION_CLASS} _largeSection_rmnvu_2`;

const GROUP_HEADER_CLASS =
  'flex justify-between group-data-[density=compact]/settings:min-h-0 group-data-[density=compact]/settings:pb-3 gap-4 pb-3 items-start';
const GROUP_TITLE_BLOCK_CLASS =
  'flex min-w-0 flex-1 flex-col gap-0.5 group-data-[density=compact]/settings:gap-0.75';
const GROUP_TITLE_CLASS = 'font-medium text-default text-lg';
const GROUP_SUBTITLE_CLASS = 'font-normal text-secondary text-balance text-sm leading-[18px]';
const GROUP_CONTENT_CLASS = 'flex flex-col gap-1.5';

const FIELD_CONTAINER_CLASS = 'flex min-w-0 flex-col gap-2 text-sm';
const FIELD_LABEL_CLASS = 'select-none';
const FIELD_HELP_CLASS = 'text-xs text-secondary';
const FIELD_ERROR_CLASS = 'text-sm text-danger';
const FORM_STACK_CLASS = 'flex min-w-0 flex-col gap-4';

const ROW_OUTER_CLASS =
  'group w-full items-center flex first:rounded-t-2xl last:rounded-b-2xl hover:bg-primary-ghost-hover focus-within:bg-primary-ghost-hover';
const ROW_BUTTON_CLASS =
  'min-w-0 flex-1 cursor-interaction items-center rounded-[inherit] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring disabled:cursor-default disabled:opacity-60 flex px-4 text-start py-3 gap-6';
const ROW_TRAILING_CLASS = 'flex shrink-0 items-center gap-1 pe-4';
const ROW_LABEL_CLASS =
  'min-w-0 break-words text-default group-data-[density=compact]/settings:leading-4.5 text-sm font-medium';
const ROW_DESCRIPTION_CLASS = 'min-w-0 text-xs leading-4 text-wrap break-words text-secondary';
const LIST_CLASS = 'divide-y _interactive_10sh1_1';

interface ProviderDraft {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  wireApi: WireApi;
  models: ProviderModel[];
  defaultModel: string;
  envKey: string;
  hasApiKey: boolean;
  apiKey: string;
  clearApiKey: boolean;
}

interface ModelRow extends ProviderModel {
  label: string;
}

interface ProviderFormState {
  mode: 'new' | 'edit';
  editId: string | null;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  wireApi: WireApi;
  models: ModelRow[];
  defaultModel: string;
  envKey: string;
  hasApiKey: boolean;
  pendingApiKey: string;
  apiKey: string;
  clearApiKey: boolean;
}

interface FormErrors {
  name?: string;
  baseUrl?: string;
  wireApi?: string;
  envKey?: string;
  apiKey?: string;
  models?: string;
  defaultModel?: string;
  modelRows?: Record<number, string>;
  summary?: string;
}

export interface SettingsDialogProps {
  open: boolean;
  registry: ProviderRegistry | null;
  onClose: () => void;
  onSave: (registry: ProviderRegistryWrite) => Promise<void>;
}

function cloneModels(models: ProviderModel[]): ProviderModel[] {
  return models.map((model) => ({
    ...model,
    reasoningEfforts: model.reasoningEfforts ? [...model.reasoningEfforts] : undefined,
    ...(model.label === undefined ? {} : { label: model.label }),
  }));
}

function defaultModelsForKind(kind: ProviderKind): ProviderModel[] {
  return DEFAULT_MODELS[kind].map((model) => ({ ...model }));
}

function modelsMatch(
  left: ReadonlyArray<{ id: string; label?: string }>,
  right: ReadonlyArray<{ id: string; label?: string }>,
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every(
    (model, index) =>
      model.id === right[index]?.id && (model.label ?? '') === (right[index]?.label ?? ''),
  );
}

function unwrapEnvKey(value: string): string {
  const trimmed = value.trim();
  const match = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/u.exec(trimmed);
  return match?.[1] ?? match?.[2] ?? trimmed;
}

function slugifyProviderId(name: string, existingIds: string[]): string {
  let slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'gateway';
  if (!/^[a-zA-Z]/u.test(slug)) {
    slug = `provider-${slug}`;
  }
  slug = slug.slice(0, 64).replace(/-+$/u, '');
  const reserved = new Set<string>([...RESERVED_PROVIDER_IDS, ...existingIds]);
  let candidate = slug;
  let suffix = 2;
  while (reserved.has(candidate)) {
    const tail = `-${suffix++}`;
    candidate = `${slug.slice(0, 64 - tail.length).replace(/-+$/u, '')}${tail}`;
  }
  return candidate;
}

function configToDraft(config: ProviderConfig): ProviderDraft {
  const models = cloneModels(config.models);
  const hasDefaultModel = models.some((model) => model.id === config.defaultModel);
  return {
    id: config.id,
    name: config.name,
    kind: config.kind,
    baseUrl: config.baseUrl,
    wireApi:
      config.kind === 'deepseek' || config.kind === 'gemini' ? 'chat' : config.wireApi,
    models,
    defaultModel: hasDefaultModel ? config.defaultModel : models[0]?.id ?? '',
    envKey: config.envKey ?? '',
    hasApiKey: config.hasApiKey === true,
    apiKey: '',
    clearApiKey: false,
  };
}

function buildDrafts(registry: ProviderRegistry | null): ProviderDraft[] {
  if (registry === null) {
    return [];
  }
  return registry.providers.map(configToDraft);
}

function resolveActiveProviderId(
  registry: ProviderRegistry | null,
  providers: ProviderDraft[],
): string {
  if (registry !== null && providers.some((provider) => provider.id === registry.activeProviderId)) {
    return registry.activeProviderId;
  }
  return providers[0]?.id ?? '';
}

function newProviderForm(): ProviderFormState {
  const kind: ProviderKind = 'openai';
  const models = defaultModelsForKind(kind).map((model) => ({
    ...model,
    label: model.label ?? '',
  }));
  return {
    mode: 'new',
    editId: null,
    name: KIND_LABELS[kind],
    kind,
    baseUrl: DEFAULT_BASE_URLS[kind],
    wireApi: DEFAULT_WIRE_API[kind],
    models,
    defaultModel: models[0]?.id ?? '',
    envKey: '',
    hasApiKey: false,
    pendingApiKey: '',
    apiKey: '',
    clearApiKey: false,
  };
}

function providerToForm(provider: ProviderDraft): ProviderFormState {
  return {
    mode: 'edit',
    editId: provider.id,
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    wireApi: provider.wireApi,
    models: provider.models.map((model) => ({
      ...model,
      label: model.label ?? '',
    })),
    defaultModel: provider.defaultModel,
    envKey: provider.envKey,
    hasApiKey: provider.hasApiKey,
    pendingApiKey: provider.apiKey,
    apiKey: '',
    clearApiKey: provider.clearApiKey,
  };
}

function validateProviderForm(form: ProviderFormState): FormErrors {
  const errors: FormErrors = {};
  const name = form.name.trim();
  if (!name) {
    errors.name = MESSAGES.nameRequired;
  } else if (name.length > 256 || CONTROL_CHARACTERS.test(name)) {
    errors.name = MESSAGES.nameInvalid;
  }

  const baseUrl = form.baseUrl.trim();
  if (!baseUrl) {
    errors.baseUrl = MESSAGES.urlRequired;
  } else if (baseUrl.length > 2048) {
    errors.baseUrl = MESSAGES.urlInvalid;
  } else {
    try {
      const parsed = new URL(baseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        errors.baseUrl = MESSAGES.urlScheme;
      } else if (parsed.username || parsed.password) {
        errors.baseUrl = MESSAGES.urlCredentials;
      } else if (parsed.hash) {
        errors.baseUrl = MESSAGES.urlFragment;
      } else if (parsed.search) {
        errors.baseUrl = MESSAGES.urlQuery;
      }
    } catch {
      errors.baseUrl = MESSAGES.urlInvalid;
    }
  }

  const normalizedEnvKey = unwrapEnvKey(form.envKey);
  const apiKey = form.apiKey.trim();
  if (form.envKey.trim()) {
    if (normalizedEnvKey.length > 128 || !ENV_KEY_PATTERN.test(normalizedEnvKey)) {
      errors.envKey = MESSAGES.envInvalid;
    }
  }

  if (apiKey.length > 16384 || /[\r\n\u0000]/u.test(apiKey)) {
    errors.apiKey = MESSAGES.apiKeyInvalid;
  }
  if (form.clearApiKey && apiKey.length > 0) {
    errors.apiKey = MESSAGES.apiKeyConflict;
  }

  if (
    (form.kind === 'deepseek' || form.kind === 'gemini') &&
    form.wireApi !== 'chat'
  ) {
    errors.wireApi = MESSAGES.wireApiChat;
  }

  const modelErrors: Record<number, string> = {};
  const modelIds = new Set<string>();
  if (form.models.length === 0) {
    errors.models = MESSAGES.modelsRequired;
  } else if (form.models.length > MODEL_LIMIT) {
    errors.models = MESSAGES.modelsLimit;
  }
  form.models.forEach((row, index) => {
    const id = row.id.trim();
    const label = row.label.trim();
    if (!id) {
      modelErrors[index] = MESSAGES.modelIdRequired;
      return;
    }
    if (/\s/u.test(id)) {
      modelErrors[index] = MESSAGES.modelIdWhitespace;
      return;
    }
    if (id.length > 256 || CONTROL_CHARACTERS.test(id)) {
      modelErrors[index] = MESSAGES.modelIdInvalid;
      return;
    }
    if (label.length > 256 || CONTROL_CHARACTERS.test(label)) {
      modelErrors[index] = MESSAGES.modelLabelInvalid;
      return;
    }
    if (modelIds.has(id)) {
      modelErrors[index] = MESSAGES.modelIdDuplicate;
      return;
    }
    modelIds.add(id);
  });
  if (Object.keys(modelErrors).length > 0) {
    errors.modelRows = modelErrors;
  }

  const defaultModel = form.defaultModel.trim();
  if (!defaultModel) {
    errors.defaultModel = MESSAGES.defaultModelRequired;
  } else if (!modelIds.has(defaultModel)) {
    errors.defaultModel = MESSAGES.defaultModelMissing;
  }

  return errors;
}

function hasFormErrors(errors: FormErrors): boolean {
  return Boolean(
    errors.name ||
      errors.baseUrl ||
      errors.wireApi ||
      errors.envKey ||
      errors.apiKey ||
      errors.models ||
      errors.defaultModel ||
      (errors.modelRows && Object.keys(errors.modelRows).length > 0),
  );
}

function formToDraft(
  form: ProviderFormState,
  existingProviders: ProviderDraft[],
): ProviderDraft {
  const models: ProviderModel[] = form.models.map((row) => {
    const id = row.id.trim();
    const label = row.label.trim();
    return { ...row, id, label: label || undefined };
  });
  const apiKey = form.clearApiKey ? '' : form.apiKey.trim() || form.pendingApiKey;
  return {
    id: form.editId ?? slugifyProviderId(form.name, existingProviders.map((provider) => provider.id)),
    name: form.name.trim(),
    kind: form.kind,
    baseUrl: form.baseUrl.trim(),
    wireApi: form.wireApi,
    models,
    defaultModel: form.defaultModel.trim(),
    envKey: unwrapEnvKey(form.envKey),
    hasApiKey: form.hasApiKey,
    apiKey,
    clearApiKey: form.clearApiKey,
  };
}

function toWriteProvider(
  provider: ProviderDraft,
): ProviderConfig & { apiKey?: string; clearApiKey?: boolean } {
  const models: ProviderModel[] = provider.models.map((model) => {
    const id = model.id.trim();
    const label = model.label?.trim() ?? '';
    return { ...model, id, label: label || undefined };
  });
  const envKey = unwrapEnvKey(provider.envKey);
  const base: ProviderConfig = {
    id: provider.id,
    name: provider.name.trim(),
    kind: provider.kind,
    baseUrl: provider.baseUrl.trim(),
    wireApi: provider.wireApi,
    models,
    defaultModel: provider.defaultModel.trim(),
    ...(envKey ? { envKey } : {}),
  };
  if (provider.clearApiKey) {
    return { ...base, clearApiKey: true };
  }
  const apiKey = provider.apiKey.trim();
  if (apiKey) {
    return { ...base, apiKey };
  }
  return base;
}

function CloseIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function ProviderIcon({ kind }: { kind: ProviderKind }) {
  if (kind === 'openai') {
    return (
      <img
        src="./original/assets/openai_logo_regular-ceb75a1754fa.svg"
        width={24}
        height={24}
        alt=""
      />
    );
  }
  return (
    <img
      src="./original/assets/settings_cog-c9e57e236393.svg"
      width={24}
      height={24}
      alt=""
    />
  );
}

function Field({
  label,
  htmlFor,
  help,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  help?: string;
  error?: string;
  children: ReactNode;
}) {
  const messageId = useId();
  return (
    <div className={FIELD_CONTAINER_CLASS}>
      <label htmlFor={htmlFor} className={FIELD_LABEL_CLASS}>
        {label}
      </label>
      {children}
      {help ? (
        <span id={`${messageId}-help`} className={FIELD_HELP_CLASS}>
          {help}
        </span>
      ) : null}
      {error ? (
        <p id={`${messageId}-error`} role="alert" className={FIELD_ERROR_CLASS}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ProviderEditor({
  form,
  errors,
  saving,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: ProviderFormState;
  errors: FormErrors;
  saving: boolean;
  onChange: (patch: Partial<ProviderFormState>) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const baseId = useId();
  const titleId = useId();
  const title = form.mode === 'new' ? 'Add provider or gateway' : `Edit ${form.name.trim() || 'provider'}`;
  const subtitle =
    form.mode === 'new'
      ? 'Configure the provider endpoint, authentication, and model catalog.'
      : 'Update the provider endpoint, authentication, and model catalog.';
  const modelIds = Array.from(
    new Set(form.models.map((row) => row.id.trim()).filter(Boolean)),
  );
  const canClear = form.hasApiKey || form.pendingApiKey.length > 0;
  const clearStatusClass = form.clearApiKey ? FIELD_ERROR_CLASS : FIELD_HELP_CLASS;

  const apiKeyStatus = form.clearApiKey
    ? form.hasApiKey
      ? 'The saved API key will be removed when you save.'
      : 'The pending API key will be discarded when you save.'
    : form.apiKey.trim()
      ? form.hasApiKey
        ? 'A new API key will replace the saved key when you save.'
        : 'A new API key is ready to save.'
      : form.pendingApiKey
        ? 'A new API key is ready to save.'
        : form.hasApiKey
          ? 'API key is saved. Leave blank to keep it.'
          : 'No API key is saved.';

  function handleKindChange(nextKind: ProviderKind) {
    const previousDefaults = defaultModelsForKind(form.kind);
    const nextDefaults = defaultModelsForKind(nextKind);
    const modelsAreDefault = modelsMatch(form.models, previousDefaults);
    const nextModels =
      (modelsAreDefault || form.models.length === 0) && nextDefaults.length > 0
        ? nextDefaults.map((model) => ({ ...model, label: model.label ?? '' }))
        : form.models;
    const name =
      !form.name.trim() || form.name.trim() === KIND_LABELS[form.kind]
        ? KIND_LABELS[nextKind]
        : form.name;
    const baseUrl =
      !form.baseUrl.trim() || form.baseUrl.trim() === DEFAULT_BASE_URLS[form.kind]
        ? DEFAULT_BASE_URLS[nextKind]
        : form.baseUrl;
    const wireApi =
      nextKind === 'deepseek' || nextKind === 'gemini' ? 'chat' : form.wireApi;
    const defaultModel = nextModels.some((row) => row.id.trim() === form.defaultModel)
      ? form.defaultModel
      : nextModels.find((row) => row.id.trim())?.id.trim() ?? '';
    onChange({
      kind: nextKind,
      name,
      baseUrl,
      wireApi,
      models: nextModels,
      defaultModel,
    });
  }

  function updateModel(index: number, patch: Partial<ModelRow>) {
    const current = form.models[index];
    if (current === undefined) {
      return;
    }
    const nextModels = form.models.map((row, rowIndex) =>
      rowIndex === index ? { ...row, ...patch } : row,
    );
    const previousId = current.id.trim();
    const nextId = patch.id === undefined ? previousId : patch.id.trim();
    const defaultModel =
      patch.id !== undefined && (form.defaultModel === '' || form.defaultModel === previousId)
        ? nextId
        : form.defaultModel;
    onChange({ models: nextModels, defaultModel });
  }

  function addModel() {
    if (form.models.length >= MODEL_LIMIT) {
      return;
    }
    onChange({ models: [...form.models, { id: '', label: '' }] });
  }

  function removeModel(index: number) {
    if (form.models.length <= 1) {
      return;
    }
    const removed = form.models[index];
    if (removed === undefined) {
      return;
    }
    const nextModels = form.models.filter((_, rowIndex) => rowIndex !== index);
    const removedId = removed.id.trim();
    const defaultModel =
      form.defaultModel === removedId
        ? nextModels.find((row) => row.id.trim())?.id.trim() ?? ''
        : form.defaultModel;
    onChange({ models: nextModels, defaultModel });
  }

  return createPortal(
    <div
      className={DIALOG_OVERLAY_CLASS}
      onMouseDown={(event: MouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget && !saving) {
          onCancel();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={DIALOG_SURFACE_WIDE_CLASS}
      >
        <button
          type="button"
          aria-label="Close dialog"
          className={CLOSE_BUTTON_CLASS}
          disabled={saving}
          onClick={onCancel}
        >
          <CloseIcon />
        </button>
        <form
          className={DIALOG_BODY_SCROLL_CLASS}
          data-density="form"
          aria-busy={saving}
          onSubmit={onSubmit}
        >
          <section className={DIALOG_SECTION_CLASS}>
            <div className={GROUP_HEADER_CLASS}>
              <div className={GROUP_TITLE_BLOCK_CLASS}>
                <h2 id={titleId} className="text-form-title">
                  <span className="flex items-center gap-2">
                    <ProviderIcon kind={form.kind} />
                    <span>{title}</span>
                  </span>
                </h2>
                <div className={GROUP_SUBTITLE_CLASS}>{subtitle}</div>
              </div>
            </div>
          </section>

          <section className={DIALOG_SECTION_CLASS}>
            <div className={FORM_STACK_CLASS}>
              <Field
                label="Model provider"
                htmlFor={`${baseId}-kind`}
                help={KIND_DESCRIPTIONS[form.kind]}
                error={errors.wireApi}
              >
                <select
                  id={`${baseId}-kind`}
                  className={INPUT_FORM_CLASS}
                  value={form.kind}
                  onChange={(event) => handleKindChange(event.target.value as ProviderKind)}
                >
                  <option value="openai">OpenAI</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="gemini">Gemini</option>
                  <option value="custom">Gateway</option>
                </select>
              </Field>

              <Field
                label="Name"
                htmlFor={`${baseId}-name`}
                error={errors.name}
              >
                <input
                  id={`${baseId}-name`}
                  className={INPUT_FORM_CLASS}
                  type="text"
                  value={form.name}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={errors.name ? true : undefined}
                  onChange={(event) => onChange({ name: event.target.value })}
                />
              </Field>

              <Field
                label="Base URL"
                htmlFor={`${baseId}-base-url`}
                help="Use the full endpoint without credentials, query parameters, or a fragment."
                error={errors.baseUrl}
              >
                <input
                  id={`${baseId}-base-url`}
                  className={INPUT_FORM_CLASS}
                  type="text"
                  value={form.baseUrl}
                  placeholder="https://gateway.example.com/v1"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={errors.baseUrl ? true : undefined}
                  onChange={(event) => onChange({ baseUrl: event.target.value })}
                />
              </Field>

              <Field
                label="Wire API"
                htmlFor={`${baseId}-wire-api`}
                help={
                  form.kind === 'deepseek' || form.kind === 'gemini'
                    ? 'This provider uses Chat Completions.'
                    : 'Choose Responses or Chat Completions.'
                }
                error={errors.wireApi}
              >
                <select
                  id={`${baseId}-wire-api`}
                  className={INPUT_FORM_CLASS}
                  value={form.wireApi}
                  aria-invalid={errors.wireApi ? true : undefined}
                  onChange={(event) => onChange({ wireApi: event.target.value as WireApi })}
                >
                  <option
                    value="responses"
                    disabled={form.kind === 'deepseek' || form.kind === 'gemini'}
                  >
                    Responses API
                  </option>
                  <option value="chat">Chat Completions</option>
                </select>
              </Field>

              <Field
                label="API key environment variable"
                htmlFor={`${baseId}-env-key`}
                help="Optional. Accepts NAME, $NAME, or ${NAME}."
                error={errors.envKey}
              >
                <input
                  id={`${baseId}-env-key`}
                  className={INPUT_FORM_CLASS}
                  type="text"
                  value={form.envKey}
                  placeholder="API_KEY"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={errors.envKey ? true : undefined}
                  onChange={(event) => onChange({ envKey: event.target.value })}
                />
              </Field>

              <Field
                label="API key"
                htmlFor={`${baseId}-api-key`}
                error={errors.apiKey}
              >
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <input
                        id={`${baseId}-api-key`}
                        className={INPUT_FORM_CLASS}
                        type="password"
                        value={form.apiKey}
                        placeholder={
                          form.hasApiKey && !form.clearApiKey
                            ? 'Leave blank to keep the saved key'
                            : 'Enter an API key'
                        }
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={errors.apiKey ? true : undefined}
                        onChange={(event) => {
                          const value = event.target.value;
                          onChange({
                            apiKey: value,
                            clearApiKey: value.trim() ? false : form.clearApiKey,
                          });
                        }}
                      />
                    </div>
                    {form.clearApiKey || canClear ? (
                      <button
                        type="button"
                        className={`${BUTTON_BASE_CLASS} ${BUTTON_DIALOG_ACTION_CLASS} ${form.clearApiKey ? BUTTON_SECONDARY_CLASS : BUTTON_DANGER_CLASS}`}
                        onClick={() =>
                          onChange(
                            form.clearApiKey
                              ? { clearApiKey: false }
                              : { clearApiKey: true, apiKey: '' },
                          )
                        }
                      >
                        {form.clearApiKey ? 'Undo clear' : 'Clear API key'}
                      </button>
                    ) : null}
                  </div>
                  <p className={clearStatusClass}>{apiKeyStatus}</p>
                </div>
              </Field>

              <div className="flex min-w-0 flex-col gap-4">
                <div className={GROUP_HEADER_CLASS}>
                  <div className={GROUP_TITLE_BLOCK_CLASS}>
                    <div className={GROUP_TITLE_CLASS}>Models</div>
                    <div className={GROUP_SUBTITLE_CLASS}>
                      Add the model IDs this provider exposes.
                    </div>
                  </div>
                </div>
                <div className={GROUP_CONTENT_CLASS}>
                  {errors.models ? (
                    <p role="alert" className={FIELD_ERROR_CLASS}>
                      {errors.models}
                    </p>
                  ) : null}
                  {form.models.map((row, index) => (
                    <div
                      key={index}
                      className="flex flex-col gap-2 rounded-lg border border-default p-3"
                    >
                      <div className="flex items-end gap-2">
                        <div className="min-w-0 flex-1">
                          <Field
                            label="Model ID"
                            htmlFor={`${baseId}-model-${index}-id`}
                          >
                            <input
                              id={`${baseId}-model-${index}-id`}
                              className={INPUT_OUTLINED_CLASS}
                              type="text"
                              value={row.id}
                              placeholder="model-id"
                              autoComplete="off"
                              spellCheck={false}
                              aria-invalid={errors.modelRows?.[index] ? true : undefined}
                              onChange={(event) =>
                                updateModel(index, { id: event.target.value })
                              }
                            />
                          </Field>
                        </div>
                        <div className="min-w-0 flex-1">
                          <Field
                            label="Label (optional)"
                            htmlFor={`${baseId}-model-${index}-label`}
                          >
                            <input
                              id={`${baseId}-model-${index}-label`}
                              className={INPUT_OUTLINED_CLASS}
                              type="text"
                              value={row.label}
                              placeholder="Display name"
                              autoComplete="off"
                              spellCheck={false}
                              onChange={(event) =>
                                updateModel(index, { label: event.target.value })
                              }
                            />
                          </Field>
                        </div>
                        <button
                          type="button"
                          className={`${BUTTON_BASE_CLASS} ${BUTTON_DIALOG_ACTION_CLASS} ${BUTTON_DANGER_CLASS}`}
                          disabled={form.models.length <= 1}
                          onClick={() => removeModel(index)}
                        >
                          Remove
                        </button>
                      </div>
                      {errors.modelRows?.[index] ? (
                        <p role="alert" className={FIELD_ERROR_CLASS}>
                          {errors.modelRows[index]}
                        </p>
                      ) : null}
                    </div>
                  ))}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className={`${BUTTON_BASE_CLASS} ${BUTTON_DIALOG_ACTION_CLASS} ${BUTTON_SECONDARY_CLASS}`}
                      disabled={form.models.length >= MODEL_LIMIT}
                      onClick={addModel}
                    >
                      Add model
                    </button>
                    {form.models.length >= MODEL_LIMIT ? (
                      <span className={FIELD_HELP_CLASS}>{MESSAGES.modelsLimit}</span>
                    ) : null}
                  </div>
                  <Field
                    label="Default model"
                    htmlFor={`${baseId}-default-model`}
                    help="Used for new chats."
                    error={errors.defaultModel}
                  >
                    <select
                      id={`${baseId}-default-model`}
                      className={INPUT_FORM_CLASS}
                      value={form.defaultModel}
                      disabled={modelIds.length === 0}
                      aria-invalid={errors.defaultModel ? true : undefined}
                      onChange={(event) => onChange({ defaultModel: event.target.value })}
                    >
                      <option value="" disabled>
                        Choose a default model
                      </option>
                      {form.defaultModel &&
                      !modelIds.includes(form.defaultModel) ? (
                        <option value={form.defaultModel}>
                          {form.defaultModel} (not in list)
                        </option>
                      ) : null}
                      {modelIds.map((modelId) => (
                        <option key={modelId} value={modelId}>
                          {modelId}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              </div>
            </div>
          </section>

          <section className={DIALOG_LARGE_SECTION_CLASS}>
            {errors.summary ? (
              <p role="alert" className={FIELD_ERROR_CLASS}>
                {errors.summary}
              </p>
            ) : null}
            <div className={DIALOG_FOOTER_CLASS}>
              <button
                type="button"
                className={`${BUTTON_BASE_CLASS} ${BUTTON_DIALOG_ACTION_CLASS} ${BUTTON_SECONDARY_CLASS}`}
                disabled={saving}
                onClick={onCancel}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={`${BUTTON_BASE_CLASS} ${BUTTON_DIALOG_ACTION_CLASS} ${BUTTON_PRIMARY_CLASS}`}
                disabled={saving}
              >
                {form.mode === 'new' ? 'Add provider' : 'Save changes'}
              </button>
            </div>
          </section>
        </form>
      </div>
    </div>,
    document.body,
  );
}

function DeleteProviderDialog({
  providerName,
  isActive,
  error,
  onCancel,
  onDelete,
}: {
  providerName: string;
  isActive: boolean;
  error: string | null;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  return createPortal(
    <div
      className={DIALOG_OVERLAY_DEFAULT_CLASS}
      onMouseDown={(event: MouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className={DIALOG_SURFACE_DEFAULT_CLASS}
      >
        <div className={DIALOG_BODY_CLASS}>
          <section className={DIALOG_SECTION_CLASS}>
            <h2 id={titleId} className="text-form-title">
              Delete {providerName}?
            </h2>
          </section>
          <section className={DIALOG_SECTION_CLASS}>
            <p id={descriptionId} className="text-codex-description">
              This removes its configuration from Codex. You can add it again later.
            </p>
          </section>
          {isActive || error ? (
            <section className={DIALOG_SECTION_CLASS}>
              {isActive ? (
                <p className="text-xs text-secondary">Choose another default provider first.</p>
              ) : null}
              {error ? (
                <p role="alert" className={FIELD_ERROR_CLASS}>
                  {error}
                </p>
              ) : null}
            </section>
          ) : null}
          <section className={DIALOG_LARGE_SECTION_CLASS}>
            <div className={DIALOG_FOOTER_CLASS}>
              <button
                type="button"
                className={`${BUTTON_BASE_CLASS} ${BUTTON_DIALOG_ACTION_CLASS} ${BUTTON_SECONDARY_CLASS}`}
                onClick={onCancel}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`${BUTTON_BASE_CLASS} ${BUTTON_DIALOG_ACTION_CLASS} ${BUTTON_DANGER_CLASS}`}
                disabled={isActive}
                onClick={onDelete}
              >
                Delete
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default function SettingsDialog({
  open,
  registry,
  onClose,
  onSave,
}: SettingsDialogProps) {
  const mainTitleId = useId();
  const mainDescriptionId = useId();
  const [providers, setProviders] = useState<ProviderDraft[]>([]);
  const [activeProviderId, setActiveProviderId] = useState('');
  const [form, setForm] = useState<ProviderFormState | null>(null);
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!open) {
      setProviders([]);
      setActiveProviderId('');
      setDirty(false);
      setForm(null);
      setFormErrors({});
      setDeleteTarget(null);
      setDeleteError(null);
      setSaveError(null);
      setSaving(false);
      return;
    }
    if (dirty) {
      return;
    }
    const nextProviders = buildDrafts(registry);
    setProviders(nextProviders);
    setActiveProviderId(resolveActiveProviderId(registry, nextProviders));
  }, [open, registry, dirty]);

  const editingProvider = form !== null;
  const deleteProvider =
    deleteTarget === null
      ? null
      : providers.find((provider) => provider.id === deleteTarget) ?? null;

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || saving) {
        return;
      }
      if (editingProvider) {
        setForm(null);
        setFormErrors({});
        return;
      }
      if (deleteTarget !== null) {
        setDeleteTarget(null);
        setDeleteError(null);
        return;
      }
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, saving, editingProvider, deleteTarget, onClose]);

  if (!open) {
    return null;
  }

  function handleChangeForm(patch: Partial<ProviderFormState>) {
    setForm((current) => (current === null ? null : { ...current, ...patch }));
    setFormErrors({});
  }

  function openNewProvider() {
    if (saving || registry === null || providers.length >= PROVIDER_LIMIT) {
      return;
    }
    setForm(newProviderForm());
    setFormErrors({});
    setDeleteTarget(null);
    setSaveError(null);
  }

  function openEditProvider(provider: ProviderDraft) {
    if (saving) {
      return;
    }
    setForm(providerToForm(provider));
    setFormErrors({});
    setDeleteTarget(null);
    setSaveError(null);
  }

  function handleProviderFormSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (form === null) {
      return;
    }
    const errors = validateProviderForm(form);
    if (hasFormErrors(errors)) {
      setFormErrors({
        ...errors,
        summary: 'Fix the highlighted fields before saving.',
      });
      return;
    }
    const draft = formToDraft(form, providers);
    if (form.mode === 'new') {
      const shouldActivate = activeProviderId === '' || providers.length === 0;
      setProviders((current) => [...current, draft]);
      if (shouldActivate) {
        setActiveProviderId(draft.id);
      }
    } else {
      setProviders((current) =>
        current.map((provider) => (provider.id === form.editId ? draft : provider)),
      );
    }
    setForm(null);
    setFormErrors({});
    setSaveError(null);
    setDirty(true);
  }

  function handleSetActive(providerId: string) {
    if (saving) {
      return;
    }
    setActiveProviderId(providerId);
    setSaveError(null);
    setDirty(true);
  }

  function handleOpenDelete(providerId: string) {
    if (saving) {
      return;
    }
    setForm(null);
    setFormErrors({});
    setDeleteTarget(providerId);
    setDeleteError(null);
    setSaveError(null);
  }

  function handleDeleteProvider() {
    if (saving || deleteTarget === null) {
      return;
    }
    if (deleteTarget === activeProviderId) {
      setDeleteError('Choose another default provider first.');
      return;
    }
    if (providers.length <= 1) {
      setDeleteError('At least one provider is required.');
      return;
    }
    setProviders((current) => current.filter((provider) => provider.id !== deleteTarget));
    setDeleteTarget(null);
    setDeleteError(null);
    setSaveError(null);
    setDirty(true);
  }

  async function handleMainSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || form !== null || deleteProvider !== null) {
      return;
    }
    if (registry === null) {
      setSaveError(MESSAGES.registryUnavailable);
      return;
    }
    if (providers.length === 0) {
      setSaveError(MESSAGES.providersRequired);
      return;
    }
    if (providers.length > PROVIDER_LIMIT) {
      setSaveError(MESSAGES.providersLimit);
      return;
    }
    const ids = new Set<string>();
    for (const provider of providers) {
      if (!PROVIDER_ID_PATTERN.test(provider.id)) {
        setSaveError(MESSAGES.providerIdInvalid);
        return;
      }
      if (ids.has(provider.id)) {
        setSaveError(MESSAGES.providerIdDuplicate);
        return;
      }
      ids.add(provider.id);
    }
    if (!ids.has(activeProviderId)) {
      setSaveError(MESSAGES.activeRequired);
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const write: ProviderRegistryWrite = {
        version: 1,
        activeProviderId,
        providers: providers.map(toWriteProvider),
      };
      await onSave(write);
      onClose();
    } catch (failure) {
      const message =
        failure instanceof Error && failure.message.trim()
          ? failure.message
          : MESSAGES.saveFallback;
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  }

  function handleMainOverlayMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget || saving) {
      return;
    }
    if (form !== null || deleteProvider !== null) {
      return;
    }
    onClose();
  }

  return (
    <>
      <div className={DIALOG_OVERLAY_CLASS} onMouseDown={handleMainOverlayMouseDown}>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={mainTitleId}
          aria-describedby={mainDescriptionId}
          className={DIALOG_SURFACE_WIDE_CLASS}
        >
          <button
            type="button"
            aria-label="Close dialog"
            className={CLOSE_BUTTON_CLASS}
            disabled={saving}
            onClick={onClose}
          >
            <CloseIcon />
          </button>
          <form
            className={DIALOG_BODY_SCROLL_CLASS}
            data-density="form"
            aria-busy={saving}
            onSubmit={(event) => {
              void handleMainSubmit(event);
            }}
          >
            <section className={DIALOG_SECTION_CLASS}>
              <div className={GROUP_HEADER_CLASS}>
                <div className={GROUP_TITLE_BLOCK_CLASS}>
                  <h2 id={mainTitleId} className="text-form-title">
                    Model Providers
                  </h2>
                  <div id={mainDescriptionId} className={GROUP_SUBTITLE_CLASS}>
                    Connect Codex++ to a model provider or gateway.
                  </div>
                </div>
              </div>
            </section>

            <section className={DIALOG_SECTION_CLASS}>
              <div className={GROUP_HEADER_CLASS}>
                <div className={GROUP_TITLE_BLOCK_CLASS}>
                  <h3 className={GROUP_TITLE_CLASS}>Providers and gateways</h3>
                  <div className={GROUP_SUBTITLE_CLASS}>
                    Choose the provider used for new chats.
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className={`${BUTTON_BASE_CLASS} ${BUTTON_DIALOG_ACTION_CLASS} ${BUTTON_SECONDARY_CLASS}`}
                    disabled={saving || registry === null || providers.length >= PROVIDER_LIMIT}
                    onClick={openNewProvider}
                  >
                    Add
                  </button>
                </div>
              </div>
              <div className={GROUP_CONTENT_CLASS}>
                {providers.length >= PROVIDER_LIMIT ? (
                  <p className={FIELD_HELP_CLASS}>{MESSAGES.providersLimit}</p>
                ) : null}
                {registry === null ? (
                  <p className="px-4 py-6 text-sm text-secondary">Loading providers…</p>
                ) : providers.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-secondary">
                    No providers are configured yet.
                  </p>
                ) : (
                  <div className={LIST_CLASS}>
                    {providers.map((provider) => (
                      <div key={provider.id} className={ROW_OUTER_CLASS}>
                        <button
                          type="button"
                          className={ROW_BUTTON_CLASS}
                          disabled={saving}
                          aria-label={`Edit ${provider.name}`}
                          onClick={() => openEditProvider(provider)}
                        >
                          <span className="flex shrink-0">
                            <ProviderIcon kind={provider.kind} />
                          </span>
                          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <div className={ROW_LABEL_CLASS}>{provider.name}</div>
                            <div className={ROW_DESCRIPTION_CLASS}>
                              {KIND_LABELS[provider.kind]} · {provider.baseUrl}
                            </div>
                          </div>
                        </button>
                        <div className={ROW_TRAILING_CLASS}>
                          {provider.id === activeProviderId ? (
                            <span className="text-xs leading-4 text-success">Default</span>
                          ) : (
                            <button
                              type="button"
                              className={`${BUTTON_BASE_CLASS} ${BUTTON_DIALOG_ACTION_CLASS} ${BUTTON_SECONDARY_CLASS}`}
                              disabled={saving}
                              onClick={() => handleSetActive(provider.id)}
                            >
                              Set default
                            </button>
                          )}
                          <button
                            type="button"
                            className={`${BUTTON_BASE_CLASS} ${BUTTON_DIALOG_ACTION_CLASS} ${BUTTON_DANGER_CLASS}`}
                            disabled={saving || provider.id === activeProviderId}
                            title={
                              provider.id === activeProviderId
                                ? 'Choose another default provider first.'
                                : undefined
                            }
                            onClick={() => handleOpenDelete(provider.id)}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            <section className={DIALOG_LARGE_SECTION_CLASS}>
              {saveError ? (
                <p role="alert" className={FIELD_ERROR_CLASS}>
                  {saveError}
                </p>
              ) : null}
              <div className={DIALOG_FOOTER_CLASS}>
                <button
                  type="button"
                  className={`${BUTTON_BASE_CLASS} ${BUTTON_DIALOG_ACTION_CLASS} ${BUTTON_SECONDARY_CLASS}`}
                  disabled={saving}
                  onClick={onClose}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className={`${BUTTON_BASE_CLASS} ${BUTTON_DIALOG_ACTION_CLASS} ${BUTTON_PRIMARY_CLASS}`}
                  disabled={
                    saving ||
                    registry === null ||
                    providers.length === 0 ||
                    form !== null ||
                    deleteProvider !== null
                  }
                  aria-busy={saving}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </section>
          </form>
        </div>
      </div>

      {form !== null && typeof document !== 'undefined'
        ? createPortal(
            <ProviderEditor
              form={form}
              errors={formErrors}
              saving={saving}
              onChange={handleChangeForm}
              onSubmit={handleProviderFormSubmit}
              onCancel={() => {
                setForm(null);
                setFormErrors({});
              }}
            />,
            document.body,
          )
        : null}

      {deleteProvider !== null && typeof document !== 'undefined'
        ? createPortal(
            <DeleteProviderDialog
              providerName={deleteProvider.name}
              isActive={deleteProvider.id === activeProviderId}
              error={deleteError}
              onCancel={() => {
                setDeleteTarget(null);
                setDeleteError(null);
              }}
              onDelete={handleDeleteProvider}
            />,
            document.body,
          )
        : null}
    </>
  );
}
