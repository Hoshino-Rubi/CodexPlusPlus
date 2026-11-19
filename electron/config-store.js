'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const toml = require('smol-toml');
const { PluginCatalog } = require('./plugin-catalog');
const { runtimePaths } = require('./runtime-paths');
const { resourcePaths } = require('./resource-paths');
const { CATALOG_REVISION, PRESET_PROVIDERS, DEFAULT_REASONING_EFFORTS, REASONING_EFFORTS, presetModel, modelMetadata } = require('./model-catalog');

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const RESERVED_IDS = new Set(['__proto__', 'prototype', 'constructor', 'openai']);
const KINDS = new Set(['openai', 'deepseek', 'gemini', 'custom']);

function sanitizeMcpConfig(value) {
  if (Array.isArray(value)) return value.map(sanitizeMcpConfig);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    if (/^(?:mcp_servers|mcpServers)\.codex_app(?:\.|$)/u.test(key)) return [];
    if (key !== 'mcp_servers' && key !== 'mcpServers') return [[key, sanitizeMcpConfig(child)]];
    const servers = child && typeof child === 'object' && !Array.isArray(child) ? child : {};
    return [[key, Object.fromEntries(Object.entries(servers).flatMap(([name, entry]) => {
      if (name === 'codex_app' || !entry || typeof entry !== 'object' || Array.isArray(entry)
        || ![entry.command, entry.url].some((field) => typeof field === 'string' && field.trim())) return [];
      const { transport, ...config } = entry;
      return [[name, sanitizeMcpConfig(config)]];
    }))]];
  }));
}

function invalid(message) {
  const error = new Error(`Provider 配置无效：${message}`);
  error.code = 'INVALID_PROVIDER_CONFIG';
  return error;
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label} 必须是对象`);
  return value;
}

function text(value, label, maximum = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalid(`${label} 必须是非空文本，且不包含控制字符`);
  }
  return value.trim();
}

function modelId(value, label) {
  const model = text(value, label);
  if (/\s/u.test(model)) throw invalid(`${label} 不能包含空白字符`);
  return model;
}

function endpoint(value, label) {
  let url;
  try { url = new URL(text(value, label, 2048)); } catch { throw invalid(`${label} 必须是完整 URL`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw invalid(`${label} 必须使用 HTTP 或 HTTPS`);
  if (url.username || url.password || url.search || url.hash) throw invalid(`${label} 不能包含账号、密码、查询串或片段`);
  return url.href.replace(/\/+$/u, '');
}

function validateRegistry(input, previous = null) {
  record(input, 'registry');
  if (input.version !== 1) throw invalid('version 必须为 1');
  if (!Array.isArray(input.providers) || input.providers.length < 1 || input.providers.length > 32) {
    throw invalid('providers 必须包含 1 至 32 个 Provider');
  }
  const previousById = new Map((previous?.providers || []).map((provider) => [provider.id, provider]));
  const ids = new Set();
  const providers = input.providers.map((raw, index) => {
    const provider = record(raw, `providers[${index}]`);
    const id = text(provider.id, `providers[${index}].id`, 64);
    if (!ID_PATTERN.test(id) || RESERVED_IDS.has(id)) throw invalid(`providers[${index}].id 格式不受支持`);
    if (ids.has(id)) throw invalid(`Provider id 重复：${id}`);
    ids.add(id);
    if (!KINDS.has(provider.kind)) throw invalid(`${id}.kind 不受支持`);
    if (!['responses', 'chat'].includes(provider.wireApi)) throw invalid(`${id}.wireApi 必须为 responses 或 chat`);
    if (['deepseek', 'gemini'].includes(provider.kind) && provider.wireApi !== 'chat') {
      throw invalid(`${id} 必须使用 Chat Completions 协议`);
    }
    if (!Array.isArray(provider.models) || provider.models.length < 1 || provider.models.length > 256) {
      throw invalid(`${id}.models 必须包含 1 至 256 个模型`);
    }
    const modelIds = new Set();
    const models = provider.models.map((rawModel, modelIndex) => {
      const model = record(rawModel, `${id}.models[${modelIndex}]`);
      const modelValue = modelId(model.id, `${id}.models[${modelIndex}].id`);
      if (modelIds.has(modelValue)) throw invalid(`${id} 的模型 id 重复`);
      modelIds.add(modelValue);
      const preset = presetModel(provider, modelValue);
      const contextWindow = model.contextWindow ?? model.context_window ?? preset?.contextWindow ?? 200000;
      if (!Number.isSafeInteger(contextWindow) || contextWindow < 1 || contextWindow > 100000000) throw invalid(`${id} 的上下文窗口必须是 1 至 100000000 的整数`);
      if (model.input_modalities !== undefined && (!Array.isArray(model.input_modalities)
        || model.input_modalities.some(modality => !['text', 'image'].includes(modality)))) throw invalid(`${id} 的输入模态无效`);
      const supportsImageInput = model.supportsImageInput ?? (model.input_modalities === undefined ? preset?.supportsImageInput ?? true : model.input_modalities.includes('image'));
      if (typeof supportsImageInput !== 'boolean') throw invalid(`${id} 的图像输入开关必须为布尔值`);
      const reasoningEfforts = model.reasoningEfforts ?? preset?.reasoningEfforts ?? DEFAULT_REASONING_EFFORTS;
      if (!Array.isArray(reasoningEfforts) || reasoningEfforts.length < 1 || reasoningEfforts.length > REASONING_EFFORTS.size
        || reasoningEfforts.some(effort => !REASONING_EFFORTS.has(effort)) || new Set(reasoningEfforts).size !== reasoningEfforts.length) throw invalid(`${id} 的推理档位无效`);
      return { id: modelValue, ...(model.label === undefined ? {} : { label: text(model.label, `${id} 的模型名称`) }),
        contextWindow, supportsImageInput, reasoningEfforts: [...reasoningEfforts] };
    });
    const defaultModel = modelId(provider.defaultModel, `${id}.defaultModel`);
    if (!modelIds.has(defaultModel)) throw invalid(`${id}.defaultModel 必须位于 models 中`);
    let envKey;
    if (provider.envKey !== undefined && provider.envKey !== '') {
      envKey = text(provider.envKey, `${id}.envKey`, 128);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(envKey)) throw invalid(`${id}.envKey 必须是环境变量名`);
    }
    if (provider.clearApiKey !== undefined && typeof provider.clearApiKey !== 'boolean') throw invalid(`${id}.clearApiKey 必须为布尔值`);
    if (provider.apiKey !== undefined && typeof provider.apiKey !== 'string') throw invalid(`${id}.apiKey 必须为文本`);
    if (provider.apiKey && (provider.apiKey.length > 16384 || /[\r\n\u0000]/u.test(provider.apiKey))) {
      throw invalid(`${id}.apiKey 长度超限或包含换行`);
    }
    if (provider.clearApiKey && provider.apiKey?.trim()) throw invalid(`${id} 不能同时清除并设置 API Key`);
    const apiKey = provider.clearApiKey ? undefined : (provider.apiKey?.trim() || previousById.get(id)?.apiKey);
    return {
      id, name: text(provider.name, `${id}.name`), kind: provider.kind,
      baseUrl: endpoint(provider.baseUrl, `${id}.baseUrl`), wireApi: provider.wireApi,
      models, defaultModel, ...(envKey ? { envKey } : {}), ...(apiKey ? { apiKey } : {}),
    };
  });
  if (typeof input.activeProviderId !== 'string' || !ids.has(input.activeProviderId)) throw invalid('activeProviderId 必须指向已有 Provider');
  return { version: 1, catalogRevision: CATALOG_REVISION, activeProviderId: input.activeProviderId, providers };
}

function defaults() {
  return validateRegistry({
    version: 1,
    activeProviderId: 'openai-custom',
    providers: structuredClone(PRESET_PROVIDERS),
  });
}

// Use the same rename for both files, including profile references. A real
// openai-custom entry always keeps its identity; legacy conflicts get a free id.
function migrateConfiguration(registry, config) {
  registry = structuredClone(registry);
  config = structuredClone(config);
  // Upgrade once, preserving endpoints, credentials, existing models and explicit
  // per-model overrides. Subsequent deletions must stay deleted after restart.
  if (registry.catalogRevision !== CATALOG_REVISION && Array.isArray(registry.providers)) {
    for (const preset of PRESET_PROVIDERS) {
      const provider = registry.providers.find(entry => entry.id === preset.id);
      if (!provider) { registry.providers.push(structuredClone(preset)); continue; }
      if (!Array.isArray(provider.models)) continue;
      const ids = new Set(provider.models.map(model => model.id));
      for (const model of preset.models) if (!ids.has(model.id)) provider.models.push(structuredClone(model));
    }
    registry.catalogRevision = CATALOG_REVISION;
  }
  const tables = config.model_providers === undefined ? {} : record(config.model_providers, 'model_providers');
  const ids = new Set([...Object.keys(tables), ...(registry.providers || []).map((provider) => provider.id)]);
  let replacement = 'openai-custom';
  if (ids.has('openai') && ids.has(replacement)) {
    replacement = 'openai-legacy';
    let suffix = 2;
    while (ids.has(replacement)) replacement = `openai-legacy-${suffix++}`;
  }
  if (Array.isArray(registry.providers)) {
    for (const provider of registry.providers) if (provider.id === 'openai') provider.id = replacement;
  }
  if (registry.activeProviderId === 'openai') registry.activeProviderId = replacement;
  function renameReferences(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'model_provider' && child === 'openai') value[key] = replacement;
      else renameReferences(child);
    }
  }
  renameReferences(config);
  if (Object.hasOwn(tables, 'openai')) {
    config.model_providers = Object.fromEntries(Object.entries(tables).map(([id, provider]) => [id === 'openai' ? replacement : id, provider]));
  }
  return { registry, config };
}

function registryFromConfig(config) {
  const initial = defaults();
  const tables = config.model_providers === undefined ? {} : record(config.model_providers, 'model_providers');
  const activeId = typeof config.model_provider === 'string' ? config.model_provider : initial.activeProviderId;
  const ids = Object.keys(tables);
  if (!ids.includes(activeId)) ids.push(activeId);
  // With no provider configuration, keep the normal initial provider catalog.
  if (!Object.keys(tables).length && config.model_provider === undefined) {
    if (typeof config.model === 'string') {
      initial.providers[0].models = [{ id: config.model }];
      initial.providers[0].defaultModel = config.model;
    }
    return initial;
  }
  const providers = ids.map((id) => {
    const table = record(tables[id] || {}, `model_providers.${id}`);
    const kind = id === 'openai' || id === 'openai-custom' ? 'openai' : ['deepseek', 'gemini'].includes(id) ? id : 'custom';
    const template = initial.providers.find((provider) => provider.kind === kind);
    const model = id === activeId && typeof config.model === 'string' ? config.model : template?.defaultModel || config.model;
    if (!model || (!table.base_url && !template)) throw invalid('现有 TOML Provider 缺少 base_url 或可用 model；原配置已保留');
    return {
      id, name: table.name || template?.name || id, kind,
      baseUrl: table.base_url || template?.baseUrl, wireApi: table.wire_api || template?.wireApi || 'responses',
      models: [{ id: model }], defaultModel: model,
      ...(table.env_key ? { envKey: table.env_key } : {}),
      ...(table.experimental_bearer_token ? { apiKey: table.experimental_bearer_token } : {}),
    };
  });
  return { version: 1, activeProviderId: activeId, providers };
}

function restoreTomlCredentials(registry, config) {
  for (const provider of registry.providers || []) {
    const table = config.model_providers?.[provider.id];
    if (!table || typeof table !== 'object') continue;
    if (!provider.apiKey && table.experimental_bearer_token) provider.apiKey = table.experimental_bearer_token;
    if (!provider.envKey && table.env_key) provider.envKey = table.env_key;
  }
  return registry;
}

function renderConfig(registry, config) {
  const active = registry.providers.find((provider) => provider.id === registry.activeProviderId);
  config.model_provider = active.id;
  config.model = active.defaultModel;
  // BYOK agents use plaintext messages across providers; collaboration is an encrypted reserved namespace.
  const multiAgent = config.features?.multi_agent_v2;
  const agentOptions = multiAgent && typeof multiAgent === 'object'
    ? { ...multiAgent } : typeof multiAgent === 'boolean' ? { enabled: multiAgent } : {};
  if (!agentOptions.tool_namespace || agentOptions.tool_namespace === 'collaboration') agentOptions.tool_namespace = 'agents';
  config.features = { ...(config.features || {}), multi_agent_v2: agentOptions };
  const tables = { ...(config.model_providers || {}) };
  for (const provider of registry.providers) {
    const existing = { ...(tables[provider.id] || {}) };
    delete existing.experimental_bearer_token;
    delete existing.env_key;
    tables[provider.id] = {
      ...existing, name: provider.name, base_url: provider.baseUrl, wire_api: provider.wireApi, requires_openai_auth: false,
      ...(provider.envKey ? { env_key: provider.envKey } : {}),
      ...(provider.apiKey ? { experimental_bearer_token: provider.apiKey } : {}),
    };
  }
  config.model_providers = tables;
  return toml.stringify(sanitizeMcpConfig(config));
}

async function readLimited(filename) {
  const handle = await fs.open(filename, 'r');
  try {
    if ((await handle.stat()).size > MAX_CONFIG_BYTES) throw invalid(`${path.basename(filename)} 超过 2 MiB`);
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

async function atomicWrite(filename, contents, backup = true) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    if (backup) {
      try { await fs.copyFile(filename, `${filename}.bak`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await fs.rename(temporary, filename);
    await fs.chmod(filename, 0o600);
  } finally {
    if (handle) await handle.close();
    await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

class ConfigStore {
  constructor(userData) {
    this.home = path.join(userData, 'backend-home');
    this.registryPath = path.join(this.home, 'providers.json');
    this.configPath = path.join(this.home, 'config.toml');
    this.modelsCachePath = path.join(this.home, 'models_cache.json');
    this.providerModelsPath = path.join(this.home, 'provider-models.json');
    this.transactionPath = path.join(this.home, 'configuration-transaction.json');
    this.plugins = new PluginCatalog(this.home);
    this.registry = null;
    this.initialization = null;
    this.queue = Promise.resolve();
  }

  initialize() {
    if (!this.initialization) this.initialization = this.load();
    return this.initialization;
  }

  async skillInterfaces(response) {
    const assetRoot = path.join(resourcePaths().frontend, 'original');
    const allowed = filename => [this.home, assetRoot].some(root => {
      const relative = path.relative(root, filename);
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
    const image = async (source, base) => {
      if (typeof source !== 'string' || !source) return null;
      if (/^data:image\/(?:svg\+xml|png|jpeg|webp|gif|avif);base64,/iu.test(source)) return source;
      const filename = path.resolve(base, source);
      if (!allowed(filename)) return null;
      try {
        const actual = await fs.realpath(filename);
        if (!allowed(actual)) return null;
        const mime = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' }[path.extname(actual).toLowerCase()];
        if (!mime || (await fs.stat(actual)).size > MAX_CONFIG_BYTES) return null;
        return `data:${mime};base64,${(await fs.readFile(actual)).toString('base64')}`;
      } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; return null; }
    };
    const config = await this.readConfig();
    const summaries = new Map();
    return { ...response, data: await Promise.all((response?.data ?? []).map(async group => ({
      ...group, skills: await Promise.all((group.skills ?? []).map(async skill => {
        const base = path.dirname(skill.path);
        let metadata = {};
        if (allowed(path.resolve(base))) {
          try {
            const yaml = await fs.readFile(path.join(base, 'agents', 'openai.yaml'), 'utf8');
            const section = yaml.match(/^interface:\s*\r?\n((?:[ \t].*\r?\n?|\s*\r?\n)*)/mu)?.[1] ?? '';
            for (const [camel, snake] of [['displayName', 'display_name'], ['shortDescription', 'short_description'], ['iconSmall', 'icon_small'], ['iconLarge', 'icon_large'], ['brandColor', 'brand_color'], ['defaultPrompt', 'default_prompt']]) {
              const raw = section.match(new RegExp(`^  ${snake}:\\s*(.+)$`, 'mu'))?.[1]?.trim();
              if (raw) metadata[camel] = raw.startsWith('"') ? JSON.parse(raw) : raw.replace(/^'(.*)'$/u, '$1');
            }
          } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
        }
        let plugin;
        for (const entry of this.plugins.entries.values()) {
          const relative = path.relative(this.plugins.cachePath(entry), skill.path);
          if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
          if (!summaries.has(entry.id)) summaries.set(entry.id, this.plugins.summary(entry, config));
          plugin = await summaries.get(entry.id);
          break;
        }
        const ui = { ...metadata, ...skill.interface };
        const fallback = plugin?.interface?.composerIcon ?? plugin?.interface?.logo;
        const publisher = path.join(assetRoot, 'assets', 'openai_logo_regular-ceb75a1754fa.svg');
        const small = await image(ui.iconSmall, base) ?? await image(ui.iconLarge, base)
          ?? await image(fallback, base) ?? await image(publisher, base);
        const large = await image(ui.iconLarge, base) ?? small;
        return { ...skill, interface: { ...ui,
          displayName: ui.displayName || skill.name.split(':').pop().replace(/(^|[-_ ])(\w)/gu, (_, space, letter) => `${space ? ' ' : ''}${letter.toUpperCase()}`),
          shortDescription: ui.shortDescription || skill.shortDescription || skill.description,
          iconSmall: small, iconLarge: large, iconSmallUrl: null, iconLargeUrl: null,
        } };
      })),
    }))) };
  }

  async load() {
    await fs.mkdir(this.home, { recursive: true, mode: 0o700 });
    await this.recoverTransaction();
    const config = await this.readConfig();
    let migrated;
    let serialized;
    try { serialized = await readLimited(this.registryPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (serialized !== undefined) {
      try {
        migrated = migrateConfiguration(JSON.parse(serialized), config);
        migrated.registry = validateRegistry(restoreTomlCredentials(migrated.registry, migrated.config));
      } catch {
        try {
          migrated = migrateConfiguration(JSON.parse(await readLimited(`${this.registryPath}.bak`)), config);
          migrated.registry = validateRegistry(restoreTomlCredentials(migrated.registry, migrated.config));
        } catch {
          throw invalid('providers.json 已损坏，且没有有效备份；原始文件已保留');
        }
        await fs.copyFile(this.registryPath, `${this.registryPath}.corrupt-${Date.now()}`);
      }
    } else {
      migrated = migrateConfiguration(registryFromConfig(config), config);
      migrated.registry = validateRegistry(restoreTomlCredentials(migrated.registry, migrated.config));
    }
    await this.plugins.initialize(migrated.config);
    // The native backend exposes this persistent Node runtime as MCP tools.
    // Connection credentials remain per-process environment values, never TOML.
    migrated.config.mcp_servers ??= {};
    migrated.config.mcp_servers.node_repl = {
      command: runtimePaths().node,
      args: [path.join(resourcePaths().runtime, 'node-repl.mjs')],
      startup_timeout_sec: 120, tool_timeout_sec: 600,
      env_vars: ['CODEX_HOME', 'CODEX_LOCAL_HOST_URL', 'CODEX_LOCAL_HOST_TOKEN', 'BROWSER_USE_AVAILABLE_BACKENDS',
        'BROWSER_USE_BACKEND_PATHS', 'NODE_REPL_TRUSTED_SERVICES', 'NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS',
        'PYTHON', 'PYTHONUTF8', 'PYTHONPATH', 'CODEX_LOCAL_PDFIUM', 'CODEX_LOCAL_OFFICE_RENDERER', 'RUNTIME_NODE', 'RUNTIME_BIN_DIR', 'CODEX_LIBREOFFICE_PATH', 'CODEX_PRIMARY_RUNTIME_NODE_MODULES'],
    };
    await this.commit(migrated.registry, migrated.config);
  }

  async recoverTransaction() {
    let contents;
    try { contents = await readLimited(this.transactionPath); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    let transaction;
    try {
      transaction = JSON.parse(contents);
      if (transaction.version !== 1 || typeof transaction.config !== 'string') throw invalid('transaction 格式错误');
      const migrated = migrateConfiguration(transaction.registry, toml.parse(transaction.config));
      transaction.registry = validateRegistry(restoreTomlCredentials(migrated.registry, migrated.config));
      migrated.config.model_catalog_json = this.modelsCachePath;
      transaction.config = renderConfig(transaction.registry, migrated.config);
    } catch { throw invalid('未完成的配置事务已损坏；事务文件已保留，请恢复配置备份'); }
    await this.writeModelCatalog(transaction.registry);
    await atomicWrite(this.registryPath, `${JSON.stringify(transaction.registry, null, 2)}\n`, false);
    await atomicWrite(this.configPath, transaction.config, false);
    await fs.unlink(this.transactionPath);
  }

  async readConfig() {
    let config = {};
    try { config = toml.parse(await readLimited(this.configPath)); } catch (error) {
      if (error.code !== 'ENOENT') throw invalid('backend-home/config.toml 无法解析；请修复该隔离配置，原文件已保留');
    }
    return config;
  }

  async commit(registry, sourceConfig) {
    registry = validateRegistry(registry);
    const migrated = migrateConfiguration(registry, sourceConfig === undefined ? await this.readConfig() : sourceConfig);
    // Official names are managed by the backend, which rejects arbitrary
    // configured sources for them. Installed packages use its standard cache;
    // these desktop catalog copies must not suppress their enabled plugin IDs.
    for (const group of this.plugins.groups) {
      const entry = migrated.config.marketplaces?.[group.name];
      if (entry?.source_type === 'local' && path.resolve(entry.source) === path.resolve(group.path)) {
        delete migrated.config.marketplaces[group.name];
      }
    }
    migrated.config.model_catalog_json = this.modelsCachePath;
    const config = renderConfig(registry, migrated.config);
    const transaction = `${JSON.stringify({ version: 1, registry, config }, null, 2)}\n`;
    if (Buffer.byteLength(transaction, 'utf8') > MAX_CONFIG_BYTES) throw invalid('配置总大小超过 2 MiB');
    await atomicWrite(this.transactionPath, transaction, false);
    await this.writeModelCatalog(registry);
    await atomicWrite(this.registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    await atomicWrite(this.configPath, config);
    await fs.unlink(this.transactionPath);
    this.registry = registry;
  }

  async writeModelCatalog(registry) {
    const source = resourcePaths().models;
    const builtin = JSON.parse(await fs.readFile(path.join(source, 'models.json'), 'utf8'));
    const instructions = await fs.readFile(path.join(source, 'prompt.md'), 'utf8');
    const models = new Map(builtin.models.map(model => [model.slug, model]));
    const mapping = Object.create(null);
    const configured = new Set();
    // A duplicate slug belongs to the selected provider, then the first configured provider.
    const providers = [...registry.providers].sort((a, b) => Number(b.id === registry.activeProviderId) - Number(a.id === registry.activeProviderId));
    for (const provider of providers) for (const model of provider.models) {
      if (!Object.hasOwn(mapping, model.id)) mapping[model.id] = provider.id;
      if (configured.has(model.id)) continue;
      configured.add(model.id);
      const metadata = modelMetadata(model);
      const existing = models.get(model.id);
      models.set(model.id, { ...(existing ?? {
        slug: model.id, display_name: model.label || model.id, description: `${provider.name} · local BYOK`,
        shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 100,
        model_messages: { instructions_template: instructions }, include_apps_usage_instructions: false,
        supports_reasoning_summary_parameter: false, default_reasoning_summary: 'none',
        support_verbosity: false, truncation_policy: { mode: 'tokens', limit: 10000 },
        experimental_supported_tools: [], supports_search_tool: false, tool_mode: 'direct', multi_agent_version: 'v1',
      }),
        display_name: model.label || existing?.display_name || model.id,
        default_reasoning_level: metadata.defaultReasoningEffort,
        supported_reasoning_levels: metadata.supportedReasoningEfforts.map(({ reasoningEffort, description }) => ({ effort: reasoningEffort, description })),
        context_window: metadata.contextWindow, max_context_window: metadata.contextWindow,
        input_modalities: metadata.inputModalities,
      });
    }
    await atomicWrite(this.modelsCachePath, `${JSON.stringify({ models: [...models.values()] })}\n`, false);
    await atomicWrite(this.providerModelsPath, `${JSON.stringify(mapping, null, 2)}\n`, false);
  }

  async readProviders() {
    await this.initialize();
    return {
      version: 1, activeProviderId: this.registry.activeProviderId,
      providers: this.registry.providers.map(({ apiKey, ...provider }) => ({
        ...structuredClone(provider), hasApiKey: Boolean(apiKey || (provider.envKey && process.env[provider.envKey]?.trim())),
      })),
    };
  }

  async getSession() {
    const registry = await this.readProviders();
    const active = registry.providers.find((provider) => provider.id === registry.activeProviderId);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(active.baseUrl).hostname);
    return { mode: 'byok', ready: active.hasApiKey || (active.kind === 'custom' && local), providerId: active.id, account: { type: 'apiKey' }, requiresOpenaiAuth: false };
  }

  writeProviders(input) {
    const operation = this.queue.then(async () => {
      await this.initialize();
      await this.commit(validateRegistry(input, this.registry));
      return this.readProviders();
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  selectModel(providerId, model) {
    const operation = this.queue.then(async () => {
      await this.initialize();
      const registry = structuredClone(this.registry);
      const provider = registry.providers.find((entry) => entry.id === providerId);
      if (!provider || !provider.models.some((entry) => entry.id === model)) throw invalid('所选 Provider 或模型不存在');
      if (registry.activeProviderId === providerId && provider.defaultModel === model) return this.readProviders();
      registry.activeProviderId = providerId;
      provider.defaultModel = model;
      await this.commit(validateRegistry(registry));
      return this.readProviders();
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async localPluginMarketplaces(params = {}, installedOnly = false) {
    await this.initialize();
    await this.queue;
    return this.plugins.marketplaces(await this.readConfig(), { installedOnly,
      installSuggestionPluginNames: params.installSuggestionPluginNames });
  }

  async localPlugin(params) {
    await this.initialize();
    await this.queue;
    const config = await this.readConfig();
    const plugin = await this.plugins.find(params, config);
    if (plugin) return plugin;
    // Original recommendation hooks retain the native managed marketplace path
    // or remote alias. Resolve those official identities to the vendored package.
    const requestedPath = typeof params.marketplacePath === 'string' ? path.resolve(params.marketplacePath) : '';
    const managedPaths = [path.join(this.home, '.tmp', 'plugins'), path.join(this.home, '.tmp', 'bundled-marketplaces')];
    if (['openai-curated', 'openai-curated-remote', 'openai-api-curated', 'openai-bundled', 'openai-primary-runtime'].includes(params.remoteMarketplaceName)
      || this.plugins.groups.some(group => requestedPath && path.resolve(group.path) === requestedPath)
      || (requestedPath && managedPaths.some(root => !path.relative(root, requestedPath).startsWith('..') && !path.isAbsolute(path.relative(root, requestedPath))))) {
      return this.plugins.find({ pluginName: params.pluginName ?? params.pluginId }, config);
    }
    if (params.remoteMarketplaceName === 'chatgpt-workspace') {
      const appId = (params.pluginName ?? params.pluginId ?? '').replace(/^plugin_/u, '');
      for (const entry of this.plugins.entries.values()) {
        if (!entry.packageRoot) continue;
        const filename = path.join(entry.packageRoot, typeof entry.metadata.apps === 'string' ? entry.metadata.apps : '.app.json');
        let apps;
        try { apps = JSON.parse(await fs.readFile(filename, 'utf8')).apps; }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (Object.values(apps ?? {}).some(app => app.id === appId)) return this.plugins.summary(entry, config);
      }
    }
    return null;
  }

  changeLocalPlugin(params, install) {
    const operation = this.queue.then(async () => {
      await this.initialize();
      const config = await this.readConfig();
      const plugin = await this.plugins.find(params, config);
      if (!plugin) throw new Error('Plugin is not present in the local catalog');
      let installation;
      if (install) installation = await this.plugins.install(plugin, config);
      else {
        await this.plugins.uninstall(plugin, config);
        // A disabled bundled plugin stays disabled across initialization.
        if (this.plugins.entries.get(plugin.id)?.core) config.plugins[plugin.id] = { enabled: false };
      }
      await this.commit(this.registry, config);
      return install ? installation : {};
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  backendEnvironment() {
    const environment = {};
    const allowed = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
    for (const name of allowed) if (process.env[name] !== undefined) environment[name] = process.env[name];
    for (const provider of this.registry.providers) {
      if (provider.envKey && !provider.apiKey && process.env[provider.envKey] !== undefined) environment[provider.envKey] = process.env[provider.envKey];
    }
    environment.CODEX_HOME = this.home;
    environment.CODEX_MODEL_CATALOG_PATH = this.modelsCachePath;
    Object.assign(environment, this.runtimeEnvironment ?? {});
    const runtime = runtimePaths();
    environment.PYTHON = runtime.python;
    environment.PYTHONUTF8 = '1';
    environment.CODEX_PRIMARY_RUNTIME_NODE_MODULES = runtime.nodeModules;
    environment.CODEX_LIBREOFFICE_PATH = runtime.libreOffice;
    environment.RUNTIME_NODE = runtime.node;
    if (runtime.bin) environment.RUNTIME_BIN_DIR = runtime.bin;
    environment.PYTHONPATH = path.join(resourcePaths().runtime, 'runtime');
    environment.CODEX_LOCAL_PDFIUM = runtime.poppler ? '0' : '1';
    if (!runtime.artifactTool) environment.CODEX_LOCAL_OFFICE_RENDERER = path.join(resourcePaths().runtime, 'runtime/render-office.py');
    for (const name of this.plugins.environmentKeys) if (process.env[name] !== undefined && environment[name] === undefined) environment[name] = process.env[name];
    const pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path') || 'PATH';
    environment[pathKey] = [runtime.node, environment.PYTHON, environment.CODEX_LIBREOFFICE_PATH].filter(path.isAbsolute).map(filename => path.dirname(filename))
      .concat([runtime.poppler, environment[pathKey]]).filter(Boolean).join(path.delimiter);
    environment.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = '1';
    return environment;
  }
}

module.exports = { ConfigStore, sanitizeMcpConfig };
