'use strict';

const { app, WebContentsView, session } = require('electron');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const { mkdirSync, existsSync, readFileSync } = require('node:fs');

const LOCAL_METHODS = new Set(['newTab', 'switchTab', 'closeTab', 'listTabs', 'goBack', 'goForward', 'reload',
  'getPageState', 'waitForPageState', 'getUserHistory', 'configureDownload', 'listDownloads', 'waitForDownload',
  'setDialogPolicy', 'getDialogs', 'handleDialog', 'setInputFiles', 'printToPDF']);

// Runs in the managed page, above its own content, not in the app renderer:
// a WebContentsView is composited above the renderer's DOM overlays.
function installAgentCursor(cursorImage) {
  if (globalThis.__codexAgentPointer) return;
  let depth = 0;
  let latest = { x: 24, y: 24, visible: false, action: 'idle' };
  let host;
  let pulse;
  const render = () => {
    if (!document.documentElement) return;
    if (!host?.isConnected) {
      host = document.createElement('div');
      host.id = '__codex-agent-cursor';
      host.setAttribute('data-codex-agent-cursor', 'true');
      host.setAttribute('data-browser-sidebar-cursor-overlay-host', 'true');
      host.setAttribute('data-testid', 'browser-agent-cursor-overlay');
      host.setAttribute('aria-label', 'Agent virtual cursor');
      host.style.cssText = 'all:initial!important;position:fixed!important;left:0!important;top:0!important;width:28px!important;height:34px!important;pointer-events:none!important;z-index:2147483647!important;contain:layout style!important;';
      const shadow = host.attachShadow({ mode: 'open' });
      const cursor = document.createElement('img');
      cursor.src = cursorImage;
      cursor.width = 23;
      cursor.height = 24;
      cursor.alt = '';
      cursor.setAttribute('data-testid', 'browser-agent-cursor');
      cursor.style.cssText = 'display:block;width:23px;height:24px;filter:drop-shadow(0 1px 2px #00000066)';
      shadow.appendChild(cursor);
      document.documentElement.appendChild(host);
    }
    host.style.setProperty('transform', `translate(${latest.x}px, ${latest.y}px)`, 'important');
    host.style.setProperty('display', latest.visible ? 'block' : 'none', 'important');
    host.dataset.action = latest.action;
    host.dataset.x = String(latest.x);
    host.dataset.y = String(latest.y);
  };
  const update = (value, broadcast = true) => {
    latest = { ...latest, ...value };
    render();
    if (host && /click|pressed/.test(latest.action)) {
      clearTimeout(pulse);
      host.style.setProperty('filter', 'drop-shadow(0 0 4px #3b82f6)', 'important');
      pulse = setTimeout(() => host?.style.removeProperty('filter'), 300);
    }
    if (broadcast && typeof globalThis.__codexBrowserCursor === 'function') {
      globalThis.__codexBrowserCursor(JSON.stringify(latest));
    }
  };
  const pointAt = (element, action) => {
    if (!depth || !(element instanceof Element)) return;
    const rect = element.getBoundingClientRect();
    if (rect.width || rect.height) update({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, visible: true, action });
  };
  const wrap = (prototype, name, action) => {
    const original = prototype[name];
    if (typeof original !== 'function') return;
    Object.defineProperty(prototype, name, { configurable: true, writable: true, value: function (...args) {
      pointAt(this, action);
      return Reflect.apply(original, this, args);
    } });
  };
  wrap(HTMLElement.prototype, 'click', 'click');
  wrap(HTMLElement.prototype, 'focus', 'input');
  const dispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (event) {
    if (depth && /^(click|dblclick|pointerdown|mousedown|input|change|wheel)$/.test(event.type)) pointAt(this, event.type === 'wheel' ? 'scroll' : event.type);
    return Reflect.apply(dispatch, this, [event]);
  };
  document.addEventListener('scroll', () => { if (depth) update({ action: 'scroll' }); }, true);
  globalThis.__codexAgentPointer = { update, begin: () => { depth++; }, end: () => { depth = Math.max(0, depth - 1); }, pointAt };
  document.addEventListener('DOMContentLoaded', render, { once: true });
  render();
}

// Keep the shipped cursor pixels byte-identical, instead of drawing a substitute.
function cursorSource() {
  for (const base of [path.join(require('./resource-paths').resourcePaths().frontend, 'original', 'assets'), path.join(app.getAppPath(), 'frontend', 'public', 'original', 'assets')]) {
    try {
      const source = readFileSync(path.join(base, 'cursor-chat-db7bf9b375c0.js'), 'utf8');
      const image = source.match(/Pe=`(data:image\/png;base64,[^`]+)`/u)?.[1];
      if (image) return `(${installAgentCursor.toString()})(${JSON.stringify(image)})`;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('The bundled original browser cursor image is missing');
}

/** Native Browser Use pipe. BrowserLib retains its original CDP and DOM code. */
class BrowserHost {
  constructor(options = {}) {
    this.pipe = process.platform === 'win32' ? `\\\\.\\pipe\\codex-browser-use-${randomUUID()}` : require('node:path').join(require('node:os').tmpdir(), `codex-browser-use-${randomUUID()}.sock`);
    this.tabs = new Map();
    this.clients = new Set();
    this.nextId = 1;
    this.activeTabs = new Map();
    this.downloads = new Map();
    this.downloadItems = new Map();
    this.history = [];
    this.sessionNames = new Map();
    this.storageRoot = path.join(app.getPath('userData'), 'backend-home', 'browser');
    this.persistence = Promise.resolve();
    this.stopping = false;
    this.onState = options.onState;
    this.onCursor = options.onCursor;
    this.viewState = { visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 } };
    this.summary = '浏览器已就绪';
    this.action = 'idle';
    this.stateRevision = 0;
  }

  attachWindow(mainWindow, options = {}) {
    if (this.mainWindow === mainWindow) {
      if (options.onState) this.onState = options.onState;
      if (options.onCursor) this.onCursor = options.onCursor;
      return this.getState();
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.removeListener('resize', this.onHostResize);
      this.mainWindow.removeListener('closed', this.onHostClosed);
      for (const tab of this.tabs.values()) this.mainWindow.contentView.removeChildView(tab.view);
    }
    this.mainWindow = mainWindow;
    if (options.onState) this.onState = options.onState;
    if (options.onCursor) this.onCursor = options.onCursor;
    this.onHostResize = () => this.layoutViews();
    this.onHostClosed = () => { this.mainWindow = undefined; this.viewState.visible = false; this.layoutViews(); this.emitState(); };
    if (mainWindow && !mainWindow.isDestroyed()) {
      for (const tab of this.tabs.values()) mainWindow.contentView.addChildView(tab.view);
      mainWindow.on('resize', this.onHostResize);
      mainWindow.once('closed', this.onHostClosed);
    }
    this.layoutViews();
    this.emitState();
    return this.getState();
  }

  getState() {
    const tabs = [...this.tabs.values()].filter(tab => !tab.contents.isDestroyed());
    const active = this.selectedTabId === undefined ? undefined : this.tabs.get(this.selectedTabId);
    return { available: true, revision: this.stateRevision, visible: Boolean(active && !active.contents.isDestroyed() && active.view.getVisible()),
      expanded: this.viewState.visible, bounds: active?.view.getBounds() ?? { ...this.viewState.bounds },
      requestedBounds: { ...this.viewState.bounds }, activeTabId: active?.id ?? null,
      sessionId: active?.owner ?? this.viewState.sessionId ?? null, summary: this.summary, action: this.action,
      tabs: tabs.map(tab => ({ ...this.pageState(tab), nativeVisible: tab.view.getVisible() })), cursor: active?.cursor ? { ...active.cursor } : null };
  }

  emitState() {
    this.stateRevision++;
    const state = this.getState();
    try { this.onState?.(state); } catch (error) { require('./runtime-debug').runtimeDebug('BROWSER_STATE', error); }
    return state;
  }

  setViewState(value = {}) {
    value = { ...value, tabId: value.tabId ?? value.browserTabId, sessionId: value.sessionId ?? value.conversationId };
    if (value.presented === false) value.visible = false;
    if (value.bounds !== undefined) {
      const bounds = value.bounds;
      if (!bounds || ['x', 'y', 'width', 'height'].some(key => !Number.isFinite(bounds[key]))
        || bounds.width < 0 || bounds.height < 0 || bounds.width > 16384 || bounds.height > 16384) throw new Error('Invalid embedded browser bounds');
      this.viewState.bounds = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Math.round(bounds[key])]));
    }
    if (value.visible !== undefined) this.viewState.visible = Boolean(value.visible);
    if (value.sessionId !== undefined) this.viewState.sessionId = value.sessionId;
    if (value.tabId !== undefined) {
      const tab = this.getTab(value.tabId, { session_id: value.sessionId });
      this.selectedTabId = tab.id;
      this.activeTabs.set(tab.owner, tab.id);
    } else if (value.sessionId !== undefined) {
      const id = this.activeTabs.get(value.sessionId);
      this.selectedTabId = id;
    }
    this.layoutViews();
    return this.emitState();
  }

  layoutViews() {
    const host = this.mainWindow;
    const hostSize = host && !host.isDestroyed() ? host.getContentSize() : [0, 0];
    const requested = this.viewState.bounds;
    const x = Math.max(0, Math.min(hostSize[0], requested.x));
    const y = Math.max(0, Math.min(hostSize[1], requested.y));
    const bounds = { x, y, width: Math.max(0, Math.min(requested.width, hostSize[0] - x)),
      height: Math.max(0, Math.min(requested.height, hostSize[1] - y)) };
    for (const tab of this.tabs.values()) {
      if (tab.contents.isDestroyed()) continue;
      const visible = Boolean(host && !host.isDestroyed() && this.viewState.visible && this.selectedTabId === tab.id
        && (this.viewState.sessionId === undefined || this.viewState.sessionId === tab.owner) && bounds.width > 0 && bounds.height > 0);
      tab.visible = visible;
      // A child view composites above every renderer overlay. Moving it offscreen
      // alone does not end its native visibility when a route or panel unmounts.
      if (!visible) tab.view.setVisible(false);
      if (visible) {
        tab.view.setBounds(bounds);
        tab.view.setVisible(true);
      }
    }
  }

  recordAction(tab, action, summary) {
    this.action = action;
    this.summary = summary;
    if (tab) {
      tab.action = action;
      tab.summary = summary;
    }
    this.emitState();
  }

  updateCursor(tab, value, inject = true) {
    const previous = tab.cursor ?? { x: 24, y: 24, visible: true };
    const x = Number.isFinite(value.x) ? value.x : previous.x;
    const y = Number.isFinite(value.y) ? value.y : previous.y;
    tab.cursor = { ...previous, tabId: tab.id, browserTabId: String(tab.id), conversationId: tab.owner,
      sessionConversationId: tab.owner, x, y, visible: value.visible !== false, animateMovement: true,
      moveSequence: (previous.moveSequence ?? 0) + 1, action: String(value.action ?? 'move'), updatedAt: Date.now() };
    if (inject && !tab.contents.isDestroyed()) {
      void tab.contents.debugger.sendCommand('Runtime.evaluate', {
        expression: `globalThis.__codexAgentPointer?.update(${JSON.stringify(tab.cursor)}, false)`,
      }).catch(() => {});
    }
    try { this.onCursor?.({ ...tab.cursor }); } catch (error) { require('./runtime-debug').runtimeDebug('BROWSER_CURSOR', error); }
    this.emitState();
  }

  closeTab(tab) {
    if (tab.contents.isDestroyed()) return;
    if (this.mainWindow && !this.mainWindow.isDestroyed()) this.mainWindow.contentView.removeChildView(tab.view);
    tab.contents.close({ waitForBeforeUnload: false });
  }

  async start() {
    await fs.mkdir(path.join(this.storageRoot, 'downloads'), { recursive: true });
    try {
      const saved = JSON.parse(await fs.readFile(path.join(this.storageRoot, 'state.json'), 'utf8'));
      this.history = Array.isArray(saved.history) ? saved.history.slice(-5000) : [];
      for (const record of saved.downloads ?? []) {
        if (record.state === 'progressing') record.state = 'interrupted';
        if (record.state === 'interrupted' && !record.completedAt) {
          record.completedAt = new Date().toISOString();
          record.canResume = false;
          record.paused = false;
        }
        this.downloads.set(record.id, record);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.browserSession = session.fromPartition('persist:codex-plus-plus-browser');
    this.browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.beforeRequest = (details, callback) => {
      const current = [...this.tabs.values()].find(tab => !tab.contents.isDestroyed() && tab.contents.id === details.webContentsId);
      try { callback({ cancel: Boolean(current && !this.requestAllowed(current, details.url)) }); }
      catch { callback({ cancel: true }); }
    };
    this.browserSession.webRequest.onBeforeRequest(this.beforeRequest);
    this.onDownload = (event, item, contents) => {
      try { this.captureDownload(event, item, contents); }
      catch (error) {
        event.preventDefault();
        require('./runtime-debug').runtimeDebug('BROWSER_DOWNLOAD_ERROR', error);
      }
    };
    this.browserSession.on('will-download', this.onDownload);
    this.server = net.createServer(socket => {
      this.clients.add(socket);
      let pending = Buffer.alloc(0);
      socket.on('error', () => {});
      socket.on('close', () => this.clients.delete(socket));
      socket.on('data', chunk => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 4) {
          const size = pending.readUInt32LE(0);
          if (size > 32 * 1024 * 1024) { socket.destroy(); return; }
          if (pending.length < size + 4) break;
          const frame = pending.subarray(4, size + 4);
          pending = pending.subarray(size + 4);
          let request;
          try { request = JSON.parse(frame.toString('utf8')); }
          catch { socket.destroy(); return; }
          this.dispatch(request.method, request.params ?? {}, socket).then(
            result => { if (request.id !== undefined) this.send(socket, { jsonrpc: '2.0', id: request.id, result: result ?? null }); },
            error => { if (request.id !== undefined) this.send(socket, { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error.message } }); },
          );
        }
      });
    });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.pipe, resolve); });
  }

  send(socket, message) {
    if (socket.destroyed) return;
    const body = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    socket.write(Buffer.concat([header, body]));
  }

  info(tab) {
    return { id: tab.id, providerTabId: String(tab.id), sessionId: tab.owner, sessionControlled: true,
      active: this.activeTabs.get(tab.owner) === tab.id, title: tab.contents.getTitle(), url: tab.contents.getURL() };
  }

  persist() {
    this.persistence = this.persistence.catch(() => {}).then(async () => {
      const filename = path.join(this.storageRoot, 'state.json');
      await fs.writeFile(`${filename}.tmp`, JSON.stringify({ history: this.history.slice(-5000), downloads: [...this.downloads.values()].slice(-1000) }));
      await fs.rename(`${filename}.tmp`, filename);
    });
    this.persistence.catch(error => require('./runtime-debug').runtimeDebug('BROWSER_PERSIST', error));
    return this.persistence;
  }

  notify(tab, method, params) {
    for (const client of tab.subscribers) this.send(client, { jsonrpc: '2.0', method, params });
  }

  outputPath(candidate, fallback) {
    if (candidate !== undefined && (typeof candidate !== 'string' || !path.isAbsolute(candidate) || candidate.includes('\0'))) {
      throw new Error('Browser output path must be absolute');
    }
    return candidate === undefined ? path.join(this.storageRoot, 'downloads', fallback) : path.resolve(candidate);
  }

  downloadUrlMatches(url, sourceUrl, expected) {
    if (!expected || expected === url) return true;
    if (!url.startsWith('blob:') || expected.startsWith('blob:')) return false;
    try {
      const source = new URL(sourceUrl);
      const requested = new URL(expected);
      return ['http:', 'https:'].includes(requested.protocol) && requested.origin === source.origin;
    } catch { return false; }
  }

  captureDownload(event, item, contents, completion = {}) {
    // Suppress native Save As immediately, before policy checks or logging.
    // The default directory already exists when the session listener is installed.
    item.setSavePath(path.join(this.storageRoot, 'downloads', `${randomUUID()}-download`));
    item.once('done', (_event, state) => {
      completion.state = state;
      completion.finish?.(state);
    });
    const tab = [...this.tabs.values()].find(current => !current.contents.isDestroyed() && current.contents === contents);
    if (process.env.CODEX_DEBUG_HOST === '1') require('./runtime-debug').runtimeDebug('BROWSER_DOWNLOAD', {
      tabId: tab?.id, url: item.getURL(), sourceUrl: contents?.getURL(), blobOrigin: tab?.blobOrigin,
    });
    if (!tab) { event.preventDefault(); return; }
    const url = item.getURL();
    const sourceUrl = contents.getURL();
    // A Blob download is owned by its managed source WebContents. Optional
    // client authorization metadata is not a prerequisite for tracking it.
    if (!this.requestAllowed(tab, url) || (url.startsWith('blob:') && !this.requestAllowed(tab, sourceUrl))) {
      event.preventDefault(); return;
    }
    const id = randomUUID();
    const filename = path.basename(item.getFilename()).replace(/[<>:"/\\|?*\x00-\x1f]/gu, '_') || 'download';
    const config = tab.downloadConfig;
    const specified = config && this.downloadUrlMatches(url, sourceUrl, config.url);
    let savePath = this.outputPath(specified ? config.savePath : undefined, `${id}-${filename}`);
    if (specified && config.directory) savePath = path.join(this.outputPath(config.directory), filename);
    // Never silently overwrite an existing user file, even for an explicit destination.
    if (existsSync(savePath)) savePath = path.join(path.dirname(savePath), `${id}-${path.basename(savePath)}`);
    try { mkdirSync(path.dirname(savePath), { recursive: true }); item.setSavePath(savePath); }
    catch { event.preventDefault(); return; }
    if (specified) delete tab.downloadConfig;
    const record = { id, filename, url, sourceUrl, tabId: tab.id, session_id: tab.owner, state: 'progressing',
      receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes(), savePath, startedAt: new Date().toISOString() };
    this.downloads.set(id, record);
    this.downloadItems.set(id, item);
    const update = status => {
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
      record.savePath = item.getSavePath();
      this.notify(tab, 'onDownloadChange', { ...record, filename: record.savePath, status });
      this.recordAction(tab, 'download', `${status === 'complete' ? '下载完成' : '下载文件'}：${record.filename}`);
    };
    completion.finish = state => {
      if (record.completedAt) return;
      record.state = state === 'completed' ? 'completed' : 'interrupted';
      record.completedAt = new Date().toISOString();
      update(state === 'completed' ? 'complete' : state === 'cancelled' ? 'canceled' : 'failed');
      this.downloadItems.delete(id);
      void this.persist();
    };
    item.on('updated', (_event, state) => {
      if (record.completedAt) return;
      record.state = state;
      record.canResume = item.canResume();
      record.paused = item.isPaused();
      update('in_progress');
      // updated(interrupted) is resumable, unlike done(interrupted).
      // Retry a transient interruption once; terminal failures still surface.
      if (state === 'interrupted' && record.canResume && !record.resumeAttempted && !this.stopping) {
        record.resumeAttempted = true;
        setImmediate(() => { if (this.downloadItems.has(id) && !this.stopping) item.resume(); });
      }
    });
    update('started');
    // Tiny Blob payloads can already be complete by the time tracking is ready.
    if (completion.state) completion.finish(completion.state);
    else if (item.getState() === 'completed') completion.finish('completed');
    else void this.persist();
  }

  pageState(tab) {
    const contents = tab.contents;
    return { ...this.info(tab), loading: contents.isLoading(), canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward() };
  }

  async waitUntil(read, matches, timeoutMs = 30000) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 600000) throw new Error('Invalid browser wait timeout');
    const deadline = Date.now() + timeoutMs;
    do {
      if (this.stopping) throw new Error('Browser host is stopping');
      const value = await read();
      if (matches(value)) return value;
      if (Date.now() >= deadline) throw new Error(`Browser wait timed out after ${timeoutMs}ms`);
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (true);
  }

  async navigateHistory(tab, direction) {
    this.recordAction(tab, direction, direction === 'back' ? '返回上一页' : direction === 'forward' ? '前往下一页' : '重新载入页面');
    const history = tab.contents.navigationHistory;
    if (direction === 'back' && history.canGoBack()) history.goBack();
    else if (direction === 'forward' && history.canGoForward()) history.goForward();
    else if (direction === 'reload') tab.contents.reload();
    else return this.pageState(tab);
    return this.waitUntil(() => this.pageState(tab), state => !state.loading);
  }

  activate(tab) {
    this.activeTabs.set(tab.owner, tab.id);
    this.selectedTabId = tab.id;
    this.layoutViews();
    this.recordAction(tab, 'switchTab', `查看标签页：${tab.contents.getTitle() || tab.contents.getURL() || '新标签页'}`);
    return this.info(tab);
  }

  async installPromptPolicy(tab) {
    const debuggerApi = tab.contents.debugger;
    if (tab.promptScript) await debuggerApi.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: tab.promptScript });
    const source = `(() => {
      const policy = ${JSON.stringify(tab.dialogPolicy)};
      window.prompt = (message = '', defaultValue = '') => {
        const action = policy.prompt ?? policy.action;
        const result = action === 'dismiss' ? null : policy.promptText;
        window.__codexBrowserPrompt(JSON.stringify({message:String(message),defaultPrompt:String(defaultValue),result,action}));
        return result;
      };
    })()`;
    const { identifier } = await debuggerApi.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source });
    tab.promptScript = identifier;
    await debuggerApi.sendCommand('Runtime.evaluate', { expression: source });
  }

  async createTab(params, socket, opener) {
    if (params.url && !this.requestAllowed(opener ?? {}, params.url)) throw new Error('Popup URL is blocked by browser network policy');
    const view = new WebContentsView({
      webPreferences: { session: this.browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } });
    const contents = view.webContents;
    view.setBounds({ x: 0, y: 0, width: 1200, height: 800 });
    view.setVisible(false);
    if (this.mainWindow && !this.mainWindow.isDestroyed()) this.mainWindow.contentView.addChildView(view);
    const tab = { id: this.nextId++, owner: params.session_id, view, contents, visible: false,
      subscribers: new Set(socket ? [socket] : opener?.subscribers ?? []),
      expressions: new Map(), targets: new Map(), dialogs: [], dialogPolicy: { action: 'accept', promptText: '' }, networkPolicy: opener?.networkPolicy };
    this.tabs.set(tab.id, tab);
    this.activeTabs.set(tab.owner, tab.id);
    this.selectedTabId = tab.id;
    this.layoutViews();
    this.recordAction(tab, 'newTab', `打开浏览器：${params.url || '新标签页'}`);
    contents.on('focus', () => { this.activeTabs.set(tab.owner, tab.id); this.selectedTabId = tab.id; });
    contents.setWindowOpenHandler(details => {
      void this.createTab({ session_id: tab.owner, url: details.url }, undefined, tab)
        .catch(error => this.notify(tab, 'onBrowserError', { tabId: tab.id, message: error.message }));
      return { action: 'deny' };
    });
    contents.on('will-prevent-unload', event => {
      const policy = tab.dialogPolicy.beforeunload ?? tab.dialogPolicy.action;
      if (policy !== 'dismiss') event.preventDefault();
    });
    const recordVisit = (_event, url, isMainFrame = true) => {
      if (!isMainFrame || !/^https?:/u.test(url)) return;
      const entry = { url, title: contents.getTitle(), dateVisited: new Date().toISOString(), session_id: tab.owner, tabId: tab.id };
      this.history.push(entry);
      this.history = this.history.slice(-5000);
      void this.persist();
    };
    contents.on('did-navigate', recordVisit);
    contents.on('did-navigate-in-page', recordVisit);
    contents.on('did-stop-loading', () => this.emitState());
    contents.on('did-start-navigation', (_event, url, _inPlace, mainFrame) => {
      if (mainFrame) this.recordAction(tab, 'navigate', `正在打开：${url}`);
    });
    contents.on('did-finish-load', () => {
      if (tab.cursor) this.updateCursor(tab, tab.cursor);
      this.recordAction(tab, 'loaded', `已打开：${contents.getTitle() || contents.getURL()}`);
    });
    contents.on('did-fail-load', (_event, code, description, url, mainFrame) => {
      if (mainFrame && code !== -3) this.recordAction(tab, 'error', `页面载入失败：${description} (${url})`);
    });
    contents.on('page-title-updated', (_event, title) => {
      const last = this.history.findLast(entry => entry.tabId === tab.id && entry.session_id === tab.owner);
      if (last) { last.title = title; void this.persist(); }
      this.emitState();
    });
    contents.once('destroyed', () => {
      this.tabs.delete(tab.id);
      if (this.activeTabs.get(tab.owner) === tab.id) {
        const next = [...this.tabs.values()].findLast(current => current.owner === tab.owner);
        if (next) this.activate(next); else this.activeTabs.delete(tab.owner);
      }
      if (this.selectedTabId === tab.id) {
        const next = [...this.tabs.values()].findLast(current => current.owner === tab.owner) ?? [...this.tabs.values()].at(-1);
        this.selectedTabId = next?.id;
      }
      this.layoutViews();
      this.recordAction(tab, 'closeTab', '已关闭浏览器标签页');
      this.notify(tab, 'onTabClosed', { tabId: tab.id });
    });
    // Chromium creates its initial renderer on the first navigation. Sending
    // Page.enable before that point can leave the debugger command pending.
    await contents.loadURL('about:blank');
    await this.attach(tab);
    await contents.debugger.sendCommand('Page.enable');
    await contents.debugger.sendCommand('Runtime.enable');
    await contents.debugger.sendCommand('Runtime.addBinding', { name: '__codexBrowserPrompt' });
    await contents.debugger.sendCommand('Runtime.addBinding', { name: '__codexBrowserCursor' });
    const pointerSource = cursorSource();
    await contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: pointerSource });
    await contents.debugger.sendCommand('Runtime.evaluate', { expression: pointerSource });
    await this.installPromptPolicy(tab);
    if (params.url && params.url !== 'about:blank') await contents.loadURL(params.url);
    this.notify(tab, 'onTabCreated', { tab: this.info(tab) });
    return this.info(tab);
  }

  getTab(id, params) {
    const tab = this.tabs.get(Number(id));
    if (!tab || tab.contents.isDestroyed()) throw new Error(`Browser tab is closed: ${id}`);
    if (params.session_id && tab.owner !== params.session_id) throw new Error('Browser tab belongs to a different session');
    return tab;
  }

  async attach(tab) {
    const debuggerApi = tab.contents.debugger;
    if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
    if (tab.listenersInstalled) return;
    tab.listenersInstalled = true;
    tab.subscribed = true;
    debuggerApi.on('message', (_event, method, params, sessionId) => {
      if (method === 'Runtime.bindingCalled' && params.name === '__codexBrowserCursor') {
        try {
          const value = JSON.parse(params.payload);
          this.updateCursor(tab, value, false);
          const action = String(value.action ?? 'move');
          this.recordAction(tab, action, `${/click|down/.test(action) ? '点击' : /input|change/.test(action) ? '输入' : action === 'scroll' ? '滚动' : '移动光标'}：(${Math.round(tab.cursor.x)}, ${Math.round(tab.cursor.y)})`);
        } catch {}
      }
      if (method === 'Runtime.bindingCalled' && params.name === '__codexBrowserPrompt') {
        try {
          const value = JSON.parse(params.payload);
          tab.dialogs.push({ id: randomUUID(), type: 'prompt', message: String(value.message), defaultPrompt: String(value.defaultPrompt),
            url: tab.contents.getURL(), openedAt: new Date().toISOString(), handled: true,
            action: value.action, userInput: value.result, result: value.result !== null });
          tab.dialogs = tab.dialogs.slice(-100);
        } catch {}
      }
      if (method === 'Page.javascriptDialogOpening' && !sessionId) {
        const record = { id: randomUUID(), type: params.type, message: params.message, url: params.url,
          defaultPrompt: params.defaultPrompt, openedAt: new Date().toISOString(), handled: false };
        tab.dialogs.push(record);
        tab.dialogs = tab.dialogs.slice(-100);
        tab.pendingDialog = record;
        const action = tab.dialogPolicy[params.type] ?? tab.dialogPolicy.action;
        if (action !== 'manual') {
          // Electron can emit the closed event reentrantly from sendCommand.
          // Deliver opening to BrowserLib first, or it retains a phantom dialog.
          setImmediate(() => {
            if (tab.contents.isDestroyed() || tab.pendingDialog !== record) return;
            void debuggerApi.sendCommand('Page.handleJavaScriptDialog', { accept: action === 'accept', promptText: tab.dialogPolicy.promptText })
              .then(() => { record.handled = true; record.action = action; }, error => { record.error = error.message; });
          });
        }
      }
      if (method === 'Page.javascriptDialogClosed' && !sessionId) {
        if (tab.pendingDialog) { tab.pendingDialog.handled = true; tab.pendingDialog.result = params.result; tab.pendingDialog.userInput = params.userInput; }
        delete tab.pendingDialog;
      }
      if (method === 'Target.attachedToTarget') tab.targets.set(params.targetInfo.targetId, params.targetInfo);
      if (method === 'Target.targetInfoChanged') tab.targets.set(params.targetInfo.targetId, params.targetInfo);
      if (method === 'Target.detachedFromTarget' && params.targetId) tab.targets.delete(params.targetId);
      for (const socket of tab.subscribers) this.send(socket, {
        jsonrpc: '2.0', method: 'onCDPEvent', params: {
          source: { tabId: tab.id, ...(sessionId ? { sessionId } : {}) }, method, params,
        },
      });
    });
    debuggerApi.on('detach', () => {
      tab.subscribed = false;
      tab.targets.clear();
      for (const client of tab.subscribers) this.send(client, { jsonrpc: '2.0', method: 'onCDPDetach', params: { tabId: tab.id } });
    });
  }

  setNetworkPolicy(tab, policy) {
    for (const constraint of policy?.constraints ?? []) {
      if (!['domains', 'origins'].includes(constraint.kind) || !['allowlist', 'denylist'].includes(constraint.mode)
        || !Array.isArray(constraint.patterns) || constraint.patterns.some(pattern => typeof pattern !== 'string')) throw new Error('Unsupported browser network policy');
    }
    tab.networkPolicy = policy;
  }

  requestAllowed(tab, address) {
    const url = new URL(address);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return true;
    const glob = (pattern, value) => {
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
      return new RegExp(`^${escaped}$`, 'iu').test(value);
    };
    return (tab.networkPolicy?.constraints ?? []).every(rule => {
      const value = rule.kind === 'domains' ? url.hostname : url.origin;
      const matches = rule.patterns.some(pattern => glob(pattern.replace(/\/$/u, ''), value)
        || (rule.kind === 'domains' && pattern.startsWith('*.') && value === pattern.slice(2)));
      return rule.mode === 'denylist' ? !matches : matches;
    });
  }

  async executeCdp(tab, method, suppliedParams, sessionId) {
    const contents = tab.contents;
    const debuggerApi = contents.debugger;
    // Chromium cannot hit-test a clipped child view. Present the embedded panel
    // before the agent measures or interacts with it, and wait for real layout.
    // This never creates a window; a user can still fold the panel afterwards.
    if (!sessionId && !tab.visible && (method === 'Page.navigate' || method === 'Runtime.evaluate'
      || method === 'Runtime.callFunctionOn' || method.startsWith('Input.')
      || ['DOM.getBoxModel', 'DOM.getContentQuads', 'DOM.getNodeForLocation'].includes(method))) {
      if (this.mainWindow && !this.mainWindow.isDestroyed() && this.mainWindow.isMinimized()) {
        this.mainWindow.restore();
        this.mainWindow.show();
      }
      this.setViewState({ visible: true, tabId: tab.id, sessionId: tab.owner });
      await this.waitUntil(async () => {
        if (!tab.visible) return false;
        const metrics = await debuggerApi.sendCommand('Runtime.evaluate', {
          expression: 'innerWidth > 0 && innerHeight > 0', returnByValue: true,
        });
        return metrics.result?.value === true;
      }, Boolean, 5000);
    }
    const commandParams = { ...suppliedParams };
    const isRuntime = method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn';
    const context = commandParams.contextId === undefined ? {} : { contextId: commandParams.contextId };
    let evaluatedScope = false;
    if (method === 'Input.dispatchMouseEvent') {
      const action = commandParams.type === 'mouseWheel' ? 'scroll'
        : commandParams.type === 'mousePressed' || commandParams.type === 'mouseReleased' ? 'click' : 'move';
      this.updateCursor(tab, { x: commandParams.x, y: commandParams.y, action });
      this.recordAction(tab, action, `${action === 'click' ? '点击' : action === 'scroll' ? '滚动页面' : '移动光标'}：(${Math.round(tab.cursor.x)}, ${Math.round(tab.cursor.y)})`);
    } else if (method === 'Input.dispatchTouchEvent' && commandParams.touchPoints?.length) {
      const point = commandParams.touchPoints[0];
      this.updateCursor(tab, { x: point.x, y: point.y, action: 'click' });
      this.recordAction(tab, 'click', `触控：(${Math.round(point.x)}, ${Math.round(point.y)})`);
    } else if (method === 'Input.insertText' || method === 'Input.dispatchKeyEvent') {
      this.recordAction(tab, 'input', method === 'Input.insertText' ? '正在输入文本' : `按键：${String(commandParams.key ?? commandParams.code ?? commandParams.type)}`);
      // Do not publish entered text: it can contain credentials or private data.
      try {
        const point = await debuggerApi.sendCommand('Runtime.evaluate', { expression: '(() => { const e=document.activeElement; if(!e||e===document.body)return null;const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}; })()', returnByValue: true }, sessionId);
        if (point.result?.value) this.updateCursor(tab, { ...point.result.value, action: 'input' });
      } catch {}
    } else if (method === 'Page.navigate') {
      if (!this.requestAllowed(tab, commandParams.url)) throw new Error('Navigation URL is blocked by browser network policy');
      this.recordAction(tab, 'navigate', `正在打开：${commandParams.url}`);
    } else if (method === 'DOM.scrollIntoViewIfNeeded') {
      this.recordAction(tab, 'scroll', '滚动至目标元素');
    }
    if (method === 'Runtime.callFunctionOn' && typeof commandParams.functionDeclaration === 'string') {
      const original = commandParams.functionDeclaration;
      // The wrapper executes in the target object's own frame/world, preserving
      // this, arguments, return type, exceptions and promise completion.
      commandParams.functionDeclaration = `function(...__codexArgs) {
        const __codexPointer = globalThis.__codexAgentPointer;
        __codexPointer?.begin();
        try {
          const __codexResult = (
            ${original}
          ).apply(this, __codexArgs);
          if (__codexResult && typeof __codexResult.then === 'function') return __codexResult.then(
            value => { __codexPointer?.end(); return value; },
            error => { __codexPointer?.end(); throw error; }
          );
          __codexPointer?.end();
          return __codexResult;
        } catch (error) { __codexPointer?.end(); throw error; }
      }`;
    } else if (method === 'Runtime.evaluate') {
      try {
        await debuggerApi.sendCommand('Runtime.evaluate', { ...context, expression: 'globalThis.__codexAgentPointer?.begin()' }, sessionId);
        evaluatedScope = true;
      } catch {}
    }
    try {
      const result = await debuggerApi.sendCommand(method, commandParams, sessionId);
      if (isRuntime && /(?:\.click\s*\(|dispatchEvent|scroll(?:By|To|IntoView)|\.focus\s*\()/u.test(String(suppliedParams.expression ?? suppliedParams.functionDeclaration ?? ''))) {
        this.emitState();
      }
      return result;
    } finally {
      if (evaluatedScope && !contents.isDestroyed()) {
        try { await debuggerApi.sendCommand('Runtime.evaluate', { ...context, expression: 'globalThis.__codexAgentPointer?.end()' }, sessionId); } catch {}
      }
    }
  }

  async dispatch(method, params, socket) {
    if (process.env.CODEX_DEBUG_HOST === '1') require('./runtime-debug').runtimeDebug('BROWSER_NATIVE', { method, ...(params.method ? { cdp: params.method } : {}) });
    if (method === 'ping') return 'pong';
    if (method === 'getInfo') return {
      name: 'Codex++ in-app browser', version: '1.0.0', type: 'iab', discoveryScope: 'session',
      blobDownloadsSupported: true, sessionTabForegroundEnabled: true,
      capabilities: { browser: [{ id: 'visibility' }, { id: 'viewport' }], tab: [{ id: 'cdp' }] },
      apiSupportOverrides: { 'Tab.ax': false, 'Browser.history': true, 'Browser.user': true },
      metadata: { codexSessionId: params.session_id },
    };
    if (method === 'getTabs' || method === 'getUserTabs' || method === 'listTabs') return [...this.tabs.values()]
      .filter(tab => !tab.contents.isDestroyed() && (!params.session_id || tab.owner === params.session_id)).map(tab => this.info(tab));
    if (method === 'createTab' || method === 'newTab') return this.createTab(params, socket);
    if (method === 'getUserHistory') {
      const from = params.from ? Date.parse(params.from) : -Infinity;
      const to = params.to ? Date.parse(params.to) : Infinity;
      if (Number.isNaN(from) || Number.isNaN(to) || (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1))) throw new Error('Invalid history query');
      const queries = params.queries ?? [];
      if (!Array.isArray(queries) || queries.some(query => typeof query !== 'string')) throw new Error('Invalid history queries');
      return this.history.filter(entry => (!params.session_id || entry.session_id === params.session_id)
        && Date.parse(entry.dateVisited) >= from && Date.parse(entry.dateVisited) <= to
        && (!queries.length || queries.some(query => `${entry.url} ${entry.title}`.toLowerCase().includes(query.toLowerCase()))))
        .slice().reverse().slice(0, Math.min(params.limit ?? 100, 5000)).map(({ url, title, dateVisited }) => ({ url, title, dateVisited }));
    }
    if (method === 'listDownloads' || method === 'waitForDownload') {
      const read = () => [...this.downloads.values()].filter(record => (!params.session_id || record.session_id === params.session_id)
        && (params.tabId === undefined || record.tabId === Number(params.tabId)) && (!params.id || record.id === params.id)
        && this.downloadUrlMatches(record.url, record.sourceUrl, params.url)
        && (!params.since || record.startedAt >= params.since)).map(record => ({ ...record }));
      if (method === 'listDownloads') return read();
      const result = await this.waitUntil(read, records => records.some(record => record.completedAt), params.timeoutMs);
      const record = result.find(record => record.completedAt);
      if (record.state !== 'completed') throw new Error(`Download interrupted: ${record.id}`);
      await fs.access(record.savePath);
      await this.persistence;
      return record;
    }
    if (method === 'turnEnded') {
      for (const tab of [...this.tabs.values()]) if (tab.owner === params.session_id && !tab.marked) this.closeTab(tab);
      return {};
    }
    if (method === 'nameSession') { this.sessionNames.set(params.session_id, String(params.name)); return {}; }
    if (method === 'browserAuthNewTargetProtection') throw new Error('Browser authentication target protection is not supported by this local browser');
    if (method === 'executeUnhandledCommand' && /^browser_(visibility|viewport)_/u.test(params.type)) {
      const tabs = [...this.tabs.values()].filter(tab => tab.owner === params.session_id);
      if (params.type === 'browser_visibility_get') return { visible: tabs.some(tab => tab.visible) };
      if (params.type === 'browser_visibility_set') {
        if (params.visible && tabs.length) this.activate(tabs.find(tab => tab.id === this.activeTabs.get(params.session_id)) ?? tabs.at(-1));
        this.setViewState({ visible: params.visible, sessionId: params.session_id });
        return {};
      }
      if (params.type === 'browser_viewport_set' || params.type === 'browser_viewport_reset') {
        const width = params.type === 'browser_viewport_reset' ? 1200 : params.width;
        const height = params.type === 'browser_viewport_reset' ? 800 : params.height;
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384) throw new Error('Invalid browser viewport');
        for (const tab of tabs) tab.viewport = { width, height };
        this.layoutViews();
        this.recordAction(tabs.at(-1), 'viewport', `浏览器视口：${width} × ${height}`);
        return {};
      }
    }
    if (method === 'getTabContext' && params.tabId === undefined && params.tab_id === undefined) params = { ...params, tabId: this.activeTabs.get(params.session_id) };
    const tab = this.getTab(params.tabId ?? params.tab_id ?? params.target?.tabId, params);
    const contents = tab.contents;
    if (socket) tab.subscribers.add(socket);
    if (method === 'attach') { this.setNetworkPolicy(tab, params.networkPolicy); await this.attach(tab); return {}; }
    if (method === 'detach') { tab.subscribers.delete(socket); return {}; }
    if (method === 'switchTab') return this.activate(tab);
    if (method === 'closeTab') { this.closeTab(tab); return {}; }
    if (method === 'getPageState') return this.pageState(tab);
    if (method === 'waitForPageState') return this.waitUntil(() => this.pageState(tab), state =>
      (params.url === undefined || state.url === params.url) && (params.title === undefined || state.title === params.title)
      && (params.loading === undefined || state.loading === params.loading), params.timeoutMs);
    if (method === 'goBack' || method === 'goForward' || method === 'reload') return this.navigateHistory(tab, method === 'goBack' ? 'back' : method === 'goForward' ? 'forward' : 'reload');
    if (method === 'configureDownload') {
      if (params.savePath !== undefined) this.outputPath(params.savePath);
      if (params.directory !== undefined) this.outputPath(params.directory);
      if (params.savePath && params.directory) throw new Error('Specify savePath or directory, not both');
      tab.downloadConfig = { savePath: params.savePath, directory: params.directory, url: params.url };
      return {};
    }
    if (method === 'allowDownload') {
      if (!this.requestAllowed(tab, params.url)) throw new Error('Download URL is blocked by browser network policy');
      if (params.savePath !== undefined) { this.outputPath(params.savePath); tab.downloadConfig = { savePath: params.savePath, url: params.url }; }
      return {};
    }
    if (method === 'setBlobDownloadOrigin') {
      if (process.env.CODEX_DEBUG_HOST === '1') require('./runtime-debug').runtimeDebug('BROWSER_BLOB_POLICY', { origin: params.origin, url: params.url });
      if (params.origin === null) delete tab.blobOrigin;
      else {
        if (new URL(contents.getURL()).origin !== params.origin) throw new Error('Blob download origin must match the current page');
        tab.blobOrigin = { origin: params.origin, url: params.url };
      }
      return {};
    }
    if (method === 'setDialogPolicy') {
      const policy = params.policy;
      if (!policy || typeof policy !== 'object' || Object.keys(policy).some(key => !['action', 'alert', 'confirm', 'prompt', 'beforeunload', 'promptText'].includes(key))
        || Object.entries(policy).some(([key, value]) => key === 'promptText' ? typeof value !== 'string' : !['accept', 'dismiss', 'manual'].includes(value))) throw new Error('Invalid browser dialog policy');
      const updated = { ...tab.dialogPolicy, ...policy };
      if ((updated.prompt ?? updated.action) === 'manual') throw new Error('Electron prompts require a preset accept/dismiss response; set prompt explicitly when other dialogs are manual');
      tab.dialogPolicy = updated;
      await this.installPromptPolicy(tab);
      return { ...tab.dialogPolicy };
    }
    if (method === 'getDialogs') return tab.dialogs.map(record => ({ ...record }));
    if (method === 'handleDialog') {
      if (!tab.pendingDialog || (params.id && tab.pendingDialog.id !== params.id)) throw new Error('No matching pending JavaScript dialog');
      return contents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: params.accept !== false, promptText: params.promptText ?? '' });
    }
    if (method === 'setInputFiles') {
      if (!Array.isArray(params.filePaths) || params.filePaths.some(filename => typeof filename !== 'string' || !path.isAbsolute(filename))) throw new Error('filePaths must contain absolute local paths');
      for (const filename of params.filePaths) if (!(await fs.stat(filename)).isFile()) throw new Error('Upload path must be a file');
      await this.attach(tab);
      const { root } = await contents.debugger.sendCommand('DOM.getDocument');
      const { nodeId } = await contents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: params.selector ?? 'input[type=file]' });
      if (!nodeId) throw new Error('File input was not found');
      await contents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: params.filePaths });
      this.recordAction(tab, 'input', `选择文件：${params.filePaths.map(filename => path.basename(filename)).join('、')}`);
      return {};
    }
    if (method === 'printToPDF') {
      const filename = this.outputPath(params.savePath, `${randomUUID()}.pdf`);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      const pdf = await contents.printToPDF(params.options ?? {});
      await fs.writeFile(filename, pdf, { flag: 'wx' });
      this.recordAction(tab, 'printToPDF', '已将页面另存为 PDF');
      return { path: filename, bytes: pdf.length };
    }
    if (method === 'getCommittedTabUrl') return contents.getURL();
    if (method === 'getTabContext') {
      const text = await contents.executeJavaScript('document.body?.innerText ?? ""');
      return { ...this.info(tab), tabId: tab.id, text: text.slice(0, 100000), truncated: text.length > 100000 };
    }
    if (method === 'executeTabRead') {
      if (params.expectedUrl && params.expectedUrl !== contents.getURL()) throw new Error('The selected tab changed while being read');
      if (!['page', 'selection'].includes(params.read?.kind)) throw new Error(`Browser tab read kind is not supported: ${params.read?.kind}`);
      const text = await contents.executeJavaScript(params.read.kind === 'selection' ? 'window.getSelection()?.toString() ?? ""' : 'document.body?.innerText ?? ""');
      return { url: contents.getURL(), title: contents.getTitle(), text: text.slice(0, 100000), truncated: text.length > 100000 };
    }
    if (method === 'claimUserTab') return this.info(tab);
    if (method === 'markTab' || method === 'followSessionTab') {
      if (method === 'markTab') tab.marked = params.status;
      this.activate(tab); return {};
    }
    if (method === 'attachBrowserUseNetworkPolicy') { this.setNetworkPolicy(tab, params.policy); return {}; }
    if (method === 'detachBrowserUseNetworkPolicy') { delete tab.networkPolicy; return {}; }
    if (method === 'attachTarget') { await this.attach(tab); return contents.debugger.sendCommand('Target.attachToTarget', { targetId: params.targetId, flatten: true }); }
    if (method === 'detachTarget') return contents.debugger.sendCommand('Target.detachFromTarget', { targetId: params.targetId });
    if (method === 'executeCdp' || method === 'executeCdpWithCachedExpression') {
      await this.attach(tab);
      const commandParams = { ...params.commandParams };
      if (method === 'executeCdpWithCachedExpression') {
        if (commandParams.expression) tab.expressions.set(params.expressionCacheKey, commandParams.expression);
        else if (tab.expressions.has(params.expressionCacheKey)) commandParams.expression = tab.expressions.get(params.expressionCacheKey);
        else return { kind: 'cache-miss' };
      }
      if (params.method === 'Browser.close' || params.method === 'Page.close') { this.closeTab(tab); return {}; }
      const targetInfo = current => ({ attached: true, canAccessOpener: false, tabId: current.id,
        targetId: `browser-use-iab-tab:${current.id}`, title: current.contents.getTitle(), type: 'page', url: current.contents.getURL() });
      if (params.method === 'Target.getTargetInfo' && (!commandParams.targetId || commandParams.targetId === `browser-use-iab-tab:${tab.id}`)) return { targetInfo: targetInfo(tab) };
      if (params.method === 'Target.getTargets') {
        // OOPIFs have real Chromium target IDs. Omitting them breaks sandboxed
        // visualization frames and any page with a cross-origin iframe.
        return { targetInfos: [targetInfo(tab), ...tab.targets.values()] };
      }
      if (params.method === 'Target.closeTarget') { this.closeTab(tab); return { success: true }; }
      if (params.method === 'Page.reload') { this.recordAction(tab, 'reload', '重新载入页面'); contents.reload(); return {}; }
      // Page events must remain enabled for automatic dialog handling even when a client detaches.
      if (params.method === 'Page.disable') return {};
      const result = await this.executeCdp(tab, params.method, commandParams, params.target?.sessionId);
      return method === 'executeCdpWithCachedExpression' ? { kind: 'executed', result } : result;
    }
    if (method === 'executeUnhandledCommand') {
      if (/close.*tab|tab.*close/iu.test(params.type)) { this.closeTab(tab); return {}; }
    }
    if (method === 'moveMouse') {
      if (!Number.isFinite(params.x) || !Number.isFinite(params.y)) throw new Error('Invalid browser cursor coordinates');
      this.updateCursor(tab, { x: params.x, y: params.y, action: 'move' });
      this.recordAction(tab, 'move', `移动光标：(${Math.round(params.x)}, ${Math.round(params.y)})`);
      contents.sendInputEvent({ type: 'mouseMove', x: Math.round(params.x), y: Math.round(params.y) });
      return {};
    }
    throw new Error(`Browser host method is not implemented: ${method}`);
  }

  async stop() {
    this.stopping = true;
    this.browserSession?.removeListener('will-download', this.onDownload);
    this.browserSession?.webRequest.onBeforeRequest(null);
    for (const item of this.downloadItems.values()) item.cancel();
    for (const tab of [...this.tabs.values()]) {
      if (tab.contents.isDestroyed()) continue;
      if (this.mainWindow && !this.mainWindow.isDestroyed()) this.mainWindow.contentView.removeChildView(tab.view);
      tab.contents.close({ waitForBeforeUnload: false });
    }
    for (const socket of this.clients) socket.destroy();
    if (this.server) await new Promise(resolve => this.server.close(resolve));
    await this.persist();
  }
}

module.exports = { BrowserHost, LOCAL_METHODS };
