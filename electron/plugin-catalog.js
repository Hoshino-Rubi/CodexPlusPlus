'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);
const { runtimePaths } = require('./runtime-paths');
const { resourcePaths } = require('./resource-paths');
const { PUBLISHER_ICONS, PNG_EQUIVALENTS } = require('./plugin-icons');
const MANIFEST = '.codex-plugin/plugin.json';
const CORE = {
  'openai-bundled': ['browser', 'computer-use', 'visualize'],
  'openai-primary-runtime': ['documents', 'pdf', 'presentations', 'spreadsheets', 'template-creator'],
};
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const get = (value, camel, snake) => value?.[camel] ?? value?.[snake] ?? null;
function segment(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/u.test(value) || value === '.' || value === '..') {
    throw new Error('Invalid plugin path segment');
  }
  return value;
}
function inside(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('Plugin resource must be a relative path');
  const resolved = path.resolve(root, relative);
  const tail = path.relative(path.resolve(root), resolved);
  if (tail === '..' || tail.startsWith(`..${path.sep}`) || path.isAbsolute(tail)) throw new Error('Plugin resource escapes its package');
  return resolved;
}
async function exists(filename) {
  try { await fs.access(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function json(filename) { return JSON.parse(await fs.readFile(filename, 'utf8')); }
async function publishPackage(staging, destination) {
  // Windows scanners may briefly hold newly copied plugin files open. Keep the
  // atomic publish, but retry sharing violations instead of failing first boot.
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(staging, destination); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 100 * (2 ** attempt)));
    }
  }
}
async function manifest(root) {
  const filename = inside(root, MANIFEST);
  if (!(await exists(filename))) throw new Error(`Real plugin manifest is missing: ${filename}`);
  const value = await json(filename);
  segment(value.name);
  return value;
}
function versionOf(value) {
  const version = value.version == null ? createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16) : String(value.version);
  return segment(version);
}
async function packagePath(root, relative) {
  if (typeof relative !== 'string' || !relative) return null;
  const resolved = inside(root, relative);
  return await exists(resolved) ? resolved : null;
}
async function interfaceOf(value, root) {
  const ui = value || {};
  const result = {};
  for (const [camel, snake] of [
    ['displayName', 'display_name'], ['shortDescription', 'short_description'], ['longDescription', 'long_description'],
    ['developerName', 'developer_name'], ['category', 'category'], ['websiteUrl', 'website_url'],
    ['privacyPolicyUrl', 'privacy_policy_url'], ['termsOfServiceUrl', 'terms_of_service_url'], ['brandColor', 'brand_color'],
  ]) result[camel] = get(ui, camel, snake) ?? ui[camel.replace(/Url$/u, 'URL')] ?? null;
  result.capabilities = list(ui.capabilities).filter(item => typeof item === 'string');
  const prompts = get(ui, 'defaultPrompt', 'default_prompt');
  result.defaultPrompt = prompts == null ? null : list(prompts).filter(item => typeof item === 'string').slice(0, 3).map(item => item.slice(0, 128));
  const image = async candidates => {
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || !candidate) continue;
      if (/^data:image\/(?:svg\+xml|png|jpeg|webp|gif|avif);base64,/iu.test(candidate)) return candidate;
      if (root) {
        if (/^[a-z][a-z0-9+.-]*:/iu.test(candidate)) continue;
        const filename = await packagePath(root, candidate);
        if (filename) {
          const mime = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' }[path.extname(filename).toLowerCase()];
          if (mime) {
            const bytes = await fs.readFile(filename);
            const png = PNG_EQUIVALENTS[createHash('sha256').update(bytes).digest('hex')];
            return png ?? `data:${mime};base64,${bytes.toString('base64')}`;
          }
        }
      }
    }
    return null;
  };
  const light = [ui.logo, ui.logoUrl, ui.lightIcon, ui.light_icon, ui.icon, ui.iconUrl, ui.icon_url, ui.composerIcon, ui.composer_icon];
  const logo = await image(light);
  const dark = await image([ui.logoDark, ui.logo_dark, ui.logoUrlDark, ui.darkIcon, ui.dark_icon, ...light]);
  const composer = await image([ui.composerIcon, ui.composer_icon, ui.composerIconUrl, ...light]);
  // RNn in the original UI prefers the path-named fields over their Url twins.
  // Data URLs survive its local-path resolver unchanged; absolute Windows paths
  // instead become app://fs/@fs URLs, unavailable in this recovered host.
  const lightIcon = logo ?? composer;
  const darkIcon = dark ?? lightIcon;
  const composerIcon = composer ?? lightIcon;
  Object.assign(result, { icon: lightIcon, iconUrl: lightIcon, lightIcon, darkIcon,
    composerIcon, composerIconUrl: composerIcon,
    logo: lightIcon, logoUrl: lightIcon, logoDark: darkIcon, logoUrlDark: darkIcon,
    themeIcons: { light: lightIcon, dark: darkIcon } });
  result.screenshots = root ? (await Promise.all(list(ui.screenshots).map(item => packagePath(root, item)))).filter(Boolean) : [];
  result.screenshotUrls = [];
  return result;
}
async function skillFiles(root, declaration) {
  const result = [];
  async function walk(filename, depth) {
    if (depth > 12 || !(await exists(filename))) return;
    const stat = await fs.lstat(filename);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) { if (path.basename(filename) === 'SKILL.md') result.push(filename); return; }
    if (!stat.isDirectory()) return;
    for (const entry of await fs.readdir(filename, { withFileTypes: true })) {
      if (!entry.isSymbolicLink() && !['.git', 'node_modules'].includes(entry.name)) await walk(path.join(filename, entry.name), depth + 1);
    }
  }
  for (const item of list(declaration ?? './skills')) if (typeof item === 'string') await walk(inside(root, item), 0);
  return [...new Set(result)];
}
function yamlText(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.*)$`, 'mu'));
  if (!match) return '';
  const text = match[1].trim();
  if (text === '|' || text === '>') {
    const tail = frontmatter.slice(match.index + match[0].length);
    const lines = [];
    for (const line of tail.split(/\r?\n/u).slice(1)) {
      if (line && !/^\s/u.test(line)) break;
      lines.push(line.trim());
    }
    return lines.join(text === '>' ? ' ' : '\n').trim();
  }
  return text.replace(/^(['"])([\s\S]*)\1$/u, '$2');
}

class PluginCatalog {
  constructor(home) {
    this.home = path.resolve(home);
    this.root = path.join(this.home, 'plugins');
    this.resources = resourcePaths().plugins;
    this.entries = new Map();
    this.groups = [];
    this.ready = null;
    this.defaultsApplied = false;
    this.environmentKeys = new Set();
  }

  async initialize(config) {
    if (!this.ready) this.ready = this.loadSources();
    await this.ready;
    config.marketplaces ??= {};
    config.plugins ??= {};
    for (const group of this.groups) config.marketplaces[group.name] = { source_type: 'local', source: group.path };
    if (this.defaultsApplied) return config;
    for (const entry of this.entries.values()) {
      if ((!entry.core && !own(config.plugins, entry.id)) || config.plugins[entry.id]?.enabled === false) continue;
      await this.installEntry(entry);
      config.plugins[entry.id] = { enabled: true };
    }
    this.defaultsApplied = true;
    return config;
  }

  async loadSources() {
    await fs.mkdir(path.join(this.root, 'marketplaces'), { recursive: true });
    for (const [name, allowed] of Object.entries(CORE)) {
      const source = path.join(this.resources, name);
      if (!(await exists(source))) throw new Error(`Bundled plugin source is missing: ${name}`);
      const root = path.join(this.root, 'marketplaces', name);
      await fs.cp(source, root, { recursive: true, force: true });
      const marketplacePath = path.join(root, '.agents', 'plugins', 'marketplace.json');
      let market = await exists(marketplacePath) ? await json(marketplacePath) : null;
      if (!market) throw new Error(`Bundled marketplace manifest is missing: ${name}`);
      const selected = market.plugins.filter(item => allowed.includes(item.name));
      for (const pluginName of allowed) if (!selected.some(item => item.name === pluginName)) throw new Error(`Core plugin is absent from marketplace: ${pluginName}@${name}`);
      if (selected.length !== market.plugins.length) {
        await fs.copyFile(marketplacePath, path.join(path.dirname(marketplacePath), 'marketplace.original.json'));
        await fs.writeFile(marketplacePath, `${JSON.stringify({ ...market, plugins: selected }, null, 2)}\n`, 'utf8');
      }
      await this.addGroup(name, root, marketplacePath, market, selected, true);
    }
    const source = path.join(this.resources, 'openai-curated');
    const root = path.join(this.root, 'marketplaces', 'openai-api-curated');
    await fs.cp(source, root, { recursive: true, force: true });
    const apiPath = path.join(root, '.agents', 'plugins', 'api_marketplace.json');
    const fullPath = path.join(root, '.agents', 'plugins', 'marketplace.json');
    const api = await json(apiPath);
    const full = await json(fullPath);
    await this.addGroup('openai-api-curated', root, apiPath, api, api.plugins, false);
    const names = new Set(api.plugins.map(item => item.name));
    const extras = full.plugins.filter(item => !names.has(item.name));
    if (extras.length) {
      const extraRoot = path.join(this.root, 'marketplaces', 'openai-curated');
      await fs.cp(source, extraRoot, { recursive: true, force: true });
      const original = path.join(extraRoot, '.agents', 'plugins', 'marketplace.original.json');
      await fs.copyFile(path.join(extraRoot, '.agents', 'plugins', 'marketplace.json'), original);
      const derived = path.join(extraRoot, '.agents', 'plugins', 'marketplace.json');
      await fs.writeFile(derived, `${JSON.stringify({ ...full, plugins: extras }, null, 2)}\n`, 'utf8');
      await this.addGroup('openai-curated', extraRoot, derived, full, extras, false);
    }
  }

  async addGroup(name, root, marketplacePath, market, plugins, core) {
    segment(name);
    const group = { name, root, path: marketplacePath, interface: { displayName: market.interface?.displayName ?? market.interface?.display_name ?? name }, entries: [] };
    for (const declaration of plugins) {
      const pluginName = segment(declaration.name);
      const raw = declaration.source;
      const source = typeof raw === 'string' ? { source: 'local', path: raw } : raw;
      if (!source || typeof source !== 'object') throw new Error(`Missing real plugin source: ${pluginName}@${name}`);
      let packageRoot = null;
      let metadata = declaration;
      let protocolSource;
      const kind = source.source ?? source.type;
      if (kind === 'local') {
        packageRoot = inside(root, source.path);
        metadata = await manifest(packageRoot);
        protocolSource = { type: 'local', path: packageRoot };
      } else if (['url', 'git', 'git-subdir'].includes(kind)) {
        const url = source.url ?? source.repo;
        if (typeof url !== 'string' || !/^https:\/\//u.test(url)) throw new Error(`Unsupported plugin Git URL: ${pluginName}`);
        protocolSource = { type: 'git', url, path: source.path ?? null, refName: source.ref ?? source.refName ?? null, sha: source.sha ?? null };
      } else throw new Error(`Unsupported real plugin source kind: ${kind}`);
      const entry = { id: `${pluginName}@${name}`, name: pluginName, group, declaration, metadata, packageRoot, source: protocolSource, core };
      this.entries.set(entry.id, entry);
      group.entries.push(entry);
    }
    this.groups.push(group);
  }

  cachePath(entry) { return path.join(this.root, 'cache', entry.group.name, entry.name, versionOf(entry.metadata)); }

  async summary(entry, config) {
    const cache = this.cachePath(entry);
    const installed = own(config.plugins ?? {}, entry.id) && await exists(path.join(cache, MANIFEST));
    const metadata = installed ? await manifest(cache) : entry.downloadedMetadata ?? entry.metadata;
    await this.loadOriginalIcon(entry);
    const ui = await interfaceOf({ category: entry.declaration.category ?? null, ...(entry.declaration.interface || {}), ...(metadata.interface || {}), ...(entry.originalIcon ? { icon: entry.originalIcon } : {}) }, installed ? cache : entry.packageRoot);
    if (entry.name === 'browser' && entry.core) { ui.displayName = '瀏覽器'; ui.shortDescription = '使用瀏覽器開啟網頁、搜尋資訊並操作網站。'; }
    if (entry.name === 'computer-use' && entry.core) { ui.displayName = '電腦'; ui.shortDescription = '操作本機應用程式、視窗與桌面。'; }
    return {
      id: entry.id, name: entry.name, marketplaceName: entry.group.name, marketplacePath: entry.group.path, remotePluginId: null, version: metadata.version ?? null,
      localVersion: installed ? versionOf(entry.metadata) : null, shareContext: null, source: entry.source,
      installed, installedAt: null, enabled: installed && config.plugins[entry.id]?.enabled !== false,
      installPolicy: 'AVAILABLE', installPolicySource: null, mustShowInstallationInterstitial: false,
      authPolicy: entry.declaration.policy?.authentication ?? 'ON_USE', availability: 'AVAILABLE', disabledReason: null,
      eligiblePlanTypes: null, interface: ui, keywords: list(metadata.keywords ?? entry.declaration.keywords),
    };
  }

  async marketplaces(config, { installedOnly = false, installSuggestionPluginNames = [] } = {}) {
    await this.initialize(config);
    // List the bundled declarations offline. Git-backed packages are downloaded
    // by detail/install only, not while opening the market or composer menus.
    return Promise.all(this.groups.map(async group => {
      const plugins = await Promise.all(group.entries.map(entry => this.summary(entry, config)));
      return { name: group.name, path: group.path, interface: group.interface, plugins: installedOnly ? plugins.filter(plugin => plugin.installed || list(installSuggestionPluginNames).includes(plugin.name)) : plugins };
    }));
  }

  async loadOriginalIcon(entry) {
    // The eight packages lacking shipped icon metadata use retained publisher
    // artwork. Listing or mentioning a plugin must never fetch a favicon.
    entry.originalIcon ??= PUBLISHER_ICONS[entry.name]?.url;
  }

  async find(params, config) {
    await this.initialize(config);
    const requested = params.pluginId ?? params.pluginName;
    for (const entry of this.entries.values()) {
      if (entry.id !== requested && entry.name !== requested) continue;
      if (params.marketplacePath && path.resolve(params.marketplacePath) !== path.resolve(entry.group.path)) continue;
      if (params.remoteMarketplaceName && params.remoteMarketplaceName !== entry.group.name
        && !(params.remoteMarketplaceName === 'openai-curated' && entry.group.name === 'openai-api-curated')) continue;
      return this.summary(entry, config);
    }
    return null;
  }

  async installEntry(entry) {
    const cache = this.cachePath(entry);
    if (await exists(path.join(cache, MANIFEST))) {
      // Refresh bundled scripts as well as manifests after a desktop upgrade.
      if (entry.core && entry.packageRoot) await fs.cp(entry.packageRoot, cache, { recursive: true, force: true });
      await this.prepareLocalPackage(cache);
      return cache;
    }
    const source = await this.materialize(entry);
    const metadata = await manifest(source);
    if (metadata.name !== entry.name) throw new Error(`Plugin manifest identity mismatch: ${entry.id}`);
    await fs.mkdir(path.dirname(cache), { recursive: true });
    const staging = await fs.mkdtemp(path.join(path.dirname(cache), '.install-'));
    try {
      await fs.cp(source, staging, { recursive: true, force: true, filter: filename => path.basename(filename) !== '.git' });
      await this.prepareLocalPackage(staging);
      await publishPackage(staging, cache);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
    return cache;
  }

  async prepareLocalPackage(root) {
    const metadata = await manifest(root);
    let mcp = metadata.mcpServers ?? metadata.mcp_servers;
    if (typeof mcp === 'string') mcp = await json(inside(root, mcp));
    if (!mcp && await exists(path.join(root, '.mcp.json'))) mcp = await json(path.join(root, '.mcp.json'));
    const servers = mcp?.mcpServers ?? mcp?.mcp_servers ?? mcp ?? {};
    const variables = new Set(Object.values(servers).flatMap(server => Object.keys(server?.env ?? {})));
    for (const match of JSON.stringify(servers).matchAll(/\$\{(?:env:)?([A-Z][A-Z0-9_]*)\}/gu)) variables.add(match[1]);
    for (const name of variables) this.environmentKeys.add(name);
    const documentation = ['# Local plugin setup', '',
      'This directory contains the original plugin manifest, scripts, assets and service declarations.',
      `MCP servers: ${Object.keys(servers).join(', ') || 'none declared'}.`,
      metadata.apps ? 'Connected apps are declared by the original app manifest. Hosted connector IDs require a matching connection; installation alone does not authenticate them.' : 'No hosted app connections are declared.',
      variables.size ? `Required environment names: ${[...variables].sort().join(', ')}. Set these in the Electron launch environment. No credential values are bundled in the generated example.` : 'No environment variable placeholders are declared by this package.',
      'Read the original SKILL.md instructions and MCP/app declarations before invoking tools. Report missing authentication or unavailable services explicitly.', '',
    ].join('\n');
    await fs.writeFile(path.join(root, 'LOCAL_SETUP.md'), documentation);
    if (variables.size) await fs.writeFile(path.join(root, '.env.example'), [...variables].sort().map(name => `${name}=`).join('\n') + '\n');
    if (!(await skillFiles(root, metadata.skills)).length) {
      const relative = './skills/local-connection';
      await fs.mkdir(inside(root, relative), { recursive: true });
      await fs.writeFile(inside(root, `${relative}/SKILL.md`), `---\nname: ${metadata.name}-connection\ndescription: Read local setup and real service requirements for ${metadata.name}.\n---\n\n${documentation}`);
      metadata.skills = [...list(metadata.skills), relative];
      await fs.writeFile(inside(root, MANIFEST), `${JSON.stringify(metadata, null, 2)}\n`);
    }
    if (Object.values(CORE).flat().includes(metadata.name)) {
      const guidance = '\n\n## Local Windows runtime\n\nCall the node_repl load_workspace_dependencies tool for the actual primary Node, Python, package and binary paths. Use its returned environment. The JavaScript kernel resolves packages from the selected primary runtime. CODEX_HOME is the isolated backend-home directory; do not read another Codex profile.\n\nWhen @oai/artifact-tool is supplied, follow the original artifact APIs. Live artifact sessions are not provided by this host. Run file imports in a standalone primary-runtime Node script with a task-local node_modules junction to the returned package directory, rather than inside the browser/computer JavaScript kernel. If this machine has no primary artifact runtime, use the installed python-docx, openpyxl and python-pptx libraries for document, spreadsheet and presentation authoring. PDF creation and extraction use reportlab and pypdf. Always read saved artifacts back. Documents retain render_docx.py; presentations retain render_slides.py with a real LibreOffice/PDFium fallback when needed. Visualize and Template Creator retain their original script entry points. Browser and Computer Use run through the local node_repl service and original skill APIs.\n';
      for (const filename of await skillFiles(root, metadata.skills)) {
        const text = await fs.readFile(filename, 'utf8');
        const original = text.split('\n\n## Local Windows runtime')[0];
        await fs.writeFile(filename, original + guidance);
      }
      if (metadata.name === 'presentations' && !runtimePaths().artifactTool) {
        const renderer = inside(root, 'skills/presentations/container_tools/render_presentation.mjs');
        const upstream = renderer.replace(/\.mjs$/u, '.upstream.mjs');
        if (!(await exists(upstream))) await fs.copyFile(renderer, upstream);
        await fs.copyFile(path.join(resourcePaths().runtime, 'runtime/presentation-renderer.mjs'), renderer);
      }
    }
  }

  async materialize(entry) {
    if (entry.packageRoot) return entry.packageRoot;
    if (!entry.materializing) entry.materializing = (async () => {
      const staging = path.join(this.root, 'downloads');
      await fs.mkdir(staging, { recursive: true });
      const retained = path.join(staging, `${entry.name}-${versionOf(entry.metadata)}`);
      const retainedSource = entry.source.path ? inside(retained, entry.source.path) : retained;
      if (await exists(path.join(retainedSource, MANIFEST))) {
        const metadata = await manifest(retainedSource);
        if (metadata.name !== entry.name) throw new Error(`Plugin manifest identity mismatch: ${entry.id}`);
        entry.packageRoot = retainedSource;
        entry.downloadedMetadata = metadata;
        return retainedSource;
      }
      const temporary = await fs.mkdtemp(path.join(staging, `.download-${entry.name}-`));
      const destination = path.join(temporary, 'repository');
      const args = ['-c', 'core.longpaths=true', 'clone', '--quiet', '--depth', '1'];
      if (entry.source.path) args.push('--sparse');
      if (entry.source.refName) args.push('--branch', entry.source.refName);
      args.push('--', entry.source.url, destination);
      try {
        await runFile('git', args, { windowsHide: true, shell: false, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
        if (entry.source.path) await runFile('git', ['-c', 'core.longpaths=true', '-C', destination, 'sparse-checkout', 'set', '--', entry.source.path], { windowsHide: true, shell: false, timeout: 120000 });
        if (entry.source.sha) await runFile('git', ['-C', destination, 'checkout', '--detach', entry.source.sha], { windowsHide: true, shell: false, timeout: 120000 });
        const source = entry.source.path ? inside(destination, entry.source.path) : destination;
        const metadata = await manifest(source);
        if (metadata.name !== entry.name) throw new Error(`Plugin manifest identity mismatch: ${entry.id}`);
        await fs.rename(destination, retained);
        entry.packageRoot = retainedSource;
        // Keep cache identity tied to the catalog declaration for Git packages.
        entry.downloadedMetadata = metadata;
        return retainedSource;
      } finally { await fs.rm(temporary, { recursive: true, force: true }); }
    })().catch(error => { entry.materializing = null; throw error; });
    return entry.materializing;
  }

  async install(summary, config) {
    await this.initialize(config);
    const entry = this.entries.get(summary.id);
    if (!entry) throw new Error('Unknown plugin install target');
    await this.installEntry(entry);
    config.plugins[entry.id] = { enabled: true };
    const detail = await this.detail(await this.summary(entry, config));
    return { authPolicy: entry.declaration.policy?.authentication ?? 'ON_USE', appsNeedingAuth: detail.apps };
  }

  async uninstall(summary, config) {
    await this.initialize(config);
    if (!this.entries.has(summary.id)) throw new Error('Unknown plugin uninstall target');
    const entry = this.entries.get(summary.id);
    const target = path.dirname(this.cachePath(entry));
    const relative = path.relative(path.join(this.root, 'cache'), target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe plugin uninstall path');
    await fs.rm(target, { recursive: true, force: true });
    const installed = path.join(this.root, 'installed', summary.id);
    if (await exists(installed)) await fs.rm(installed, { recursive: true, force: true });
    delete config.plugins[summary.id];
    return {};
  }

  async detail(summary) {
    const entry = this.entries.get(summary.id);
    if (!entry) throw new Error('Unknown plugin detail target');
    const cache = this.cachePath(entry);
    const root = summary.installed && await exists(path.join(cache, MANIFEST)) ? cache : await this.materialize(entry);
    const metadata = await manifest(root);
    const skills = [];
    for (const filename of await skillFiles(root, metadata.skills)) {
      const text = await fs.readFile(filename, 'utf8');
      const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1] ?? '';
      skills.push({ name: yamlText(frontmatter, 'name') || path.basename(path.dirname(filename)), description: yamlText(frontmatter, 'description'), shortDescription: null, interface: null, path: filename, enabled: summary.enabled });
    }
    let mcp = metadata.mcpServers ?? metadata.mcp_servers;
    if (typeof mcp === 'string') mcp = await json(inside(root, mcp));
    if (!mcp && await exists(path.join(root, '.mcp.json'))) mcp = await json(path.join(root, '.mcp.json'));
    const mcpServers = Object.keys(mcp?.mcpServers ?? mcp?.mcp_servers ?? mcp ?? {});
    const hooks = [];
    const declarations = metadata.hooks ?? (await exists(path.join(root, 'hooks', 'hooks.json')) ? './hooks/hooks.json' : []);
    for (let declaration of list(declarations)) {
      if (typeof declaration === 'string') declaration = await json(inside(root, declaration));
      for (const [eventName, handlers] of Object.entries(declaration?.hooks ?? declaration ?? {})) {
        if (Array.isArray(handlers)) handlers.forEach((unused, index) => hooks.push({ key: `${eventName}:${index}`, eventName }));
      }
    }
    const onboarding = metadata.onboardingSkill ?? metadata.onboarding_skill;
    const onboardingPath = typeof onboarding === 'string' ? inside(root, onboarding) : null;
    let appConfig = metadata.apps;
    if (typeof appConfig === 'string') appConfig = await json(inside(root, appConfig));
    const apps = Object.entries(appConfig?.apps ?? {}).map(([name, app]) => ({
      id: app.id ?? name, name, description: null, installUrl: metadata.homepage ?? null, category: metadata.interface?.category ?? null,
    }));
    return { marketplaceName: entry.group.name, marketplacePath: entry.group.path, summary: {
      ...summary, interface: { ...summary.interface, ...await interfaceOf({ category: entry.declaration.category, ...metadata.interface, ...(entry.originalIcon ? { icon: entry.originalIcon } : {}) }, root), displayName: summary.interface?.displayName ?? metadata.interface?.displayName },
    }, shareUrl: null, description: metadata.description ?? summary.interface?.longDescription ?? null, skills, onboardingSkill: skills.find(skill => skill.path === onboardingPath || path.dirname(skill.path) === onboardingPath) ?? null, hooks, apps, appTemplates: [], mcpServers, scheduledTasks: metadata.scheduledTasks ?? null };
  }
}

module.exports = { PluginCatalog };
