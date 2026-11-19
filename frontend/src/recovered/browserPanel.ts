import type { BrowserBounds, BrowserCursor, BrowserState, BrowserTab, DesktopBridge } from '../../../shared/bridge';
import { postRecoveredHostMessage } from './viewTransport';

export interface RecoveredBrowserViewRequest {
  browserTabId?: string;
  conversationId?: string;
  bounds?: BrowserBounds | null;
  visible?: boolean;
  presented?: boolean;
  viewportScale?: number;
  mountGeneration?: number;
  hostKind?: string;
}

/** Adapt the shipped right-panel UI to a native child view. This creates no UI. */
export async function installEmbeddedBrowserPanel(bridge: DesktopBridge) {
  let state = await bridge.getBrowserState();
  let disposed = false;
  let frame = 0;
  let sentGeometry = '';
  let conversationId = '';
  let ownerRoute = '';
  let presentedTabs: Set<string> | undefined;
  let visibleTabId: string | undefined;
  const observedViewports = new Set<HTMLElement>();
  const aliases = new Map<string, number>();
  const nativeAliases = new Map<number, string>();
  const conversationAliases = new Map<string, string>();
  const opened = new Set<number>();
  const snapshots = new Map<number, string>();
  const requests = new Map<string, RecoveredBrowserViewRequest>();
  const pendingTabs = new Map<string, Promise<BrowserTab>>();
  const report = (error: unknown) => { if (!disposed) console.error('[LOCAL_BROWSER_HOST]', error); };
  const nativeOwner = (tab: BrowserTab) => tab.sessionId || conversationId || 'local-browser';
  const owner = (tab: BrowserTab) => conversationAliases.get(nativeOwner(tab)) ?? nativeOwner(tab);
  const rendererId = (tab: BrowserTab) => nativeAliases.get(Number(tab.id)) ?? String(tab.id);
  const findTab = (id?: string) => state.tabs.find(tab => String(tab.id) === id || Number(tab.id) === aliases.get(id ?? ''));

  function publishCursor(cursor: BrowserCursor) {
    const tab = state.tabs.find(tab => String(tab.id) === String(cursor.tabId ?? state.activeTabId));
    if (tab) postRecoveredHostMessage({ ...cursor, type: 'browser-sidebar-browser-use-cursor-state',
      conversationId: owner(tab), browserTabId: rendererId(tab), sessionConversationId: owner(tab),
      animateMovement: true, visible: cursor.visible !== false });
  }

  function publishState() {
    for (const tab of state.tabs) {
      const browserTabId = rendererId(tab);
      const thread = owner(tab);
      const snapshot = { url: tab.url, committedUrl: tab.url, title: tab.title, tabType: 'web',
        isLoading: tab.loading === true, canGoBack: tab.canGoBack === true, canGoForward: tab.canGoForward === true,
        interactionMode: 'browse', zoomPercent: 100, isDetached: false, isAudioMuted: false, isAudible: false,
        isCapturingCamera: false, isCapturingMicrophone: false, isCapturingUserMedia: false,
        isWaitingForResponse: false, comments: [], siteToolsAvailability: {} };
      const signature = JSON.stringify([thread, browserTabId, snapshot, tab.action]);
      if (snapshots.get(Number(tab.id)) !== signature) {
        snapshots.set(Number(tab.id), signature);
        postRecoveredHostMessage({ type: 'browser-sidebar-state', conversationId: thread, browserTabId, snapshot });
        postRecoveredHostMessage({ type: 'browser-sidebar-browser-use-state', conversationId: thread, browserTabId,
          isActive: state.action !== 'idle' });
      }
      if (!opened.has(Number(tab.id))) {
        opened.add(Number(tab.id));
        postRecoveredHostMessage({ type: 'toggle-browser-panel', conversationId: thread, browserTabId,
          open: true, source: 'browser_use', initiator: 'browser_use', presentationIntent: 'split' });
      }
    }
    if (state.cursor) publishCursor(state.cursor);
  }

  function scheduleLayout() {
    if (!disposed && !frame) frame = window.requestAnimationFrame(layout);
  }

  function sendView(value: Parameters<DesktopBridge['setBrowserView']>[0]) {
    const signature = JSON.stringify(value);
    if (signature === sentGeometry) return;
    sentGeometry = signature;
    // Send hides immediately. A queued geometry update must never resurrect an
    // unmounted native view while a preceding bridge request is still pending.
    void bridge.setBrowserView(value).catch(error => {
      if (sentGeometry === signature) sentGeometry = '';
      report(error);
    });
  }

  function hideView() {
    visibleTabId = undefined;
    sendView({ visible: false });
  }

  function blockedRoute(route: string) {
    return /(?:^|\/)(?:settings|plugins|plugin|pull-requests?|pullrequests?|scheduled|automations)(?:\/|[?#]|$)/iu.test(route);
  }

  function isVisible(element: HTMLElement) {
    if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    for (let current: HTMLElement | null = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) < 0.5) return false;
    }
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.pointerEvents !== 'none' && rect.width > 0 && rect.height > 0;
  }

  function layout() {
    frame = 0;
    if (disposed) return;
    if (document.hidden || blockedRoute(ownerRoute)) { hideView(); return; }
    // Original chrome owns visibility and positioning, including tab switches,
    // collapse animation, scrolling and attachment/output-content selection.
    const candidates = [...document.querySelectorAll<HTMLElement>('[data-browser-sidebar-webview]')];
    for (const element of observedViewports) {
      if (!element.isConnected) { resize.unobserve(element); observedViewports.delete(element); }
    }
    for (const element of candidates) {
      if (!observedViewports.has(element)) { resize.observe(element); observedViewports.add(element); }
    }
    const viewport = candidates.find(element => {
      const webview = element.querySelector('webview');
      const id = webview?.getAttribute('data-browser-sidebar-browser-tab-id') ?? undefined;
      const tab = findTab(id);
      const request = id ? requests.get(id) : undefined;
      return isVisible(element) && !!tab && (!request || (request.visible !== false && request.presented !== false))
        && (!presentedTabs || (id !== undefined && presentedTabs.has(id)))
        && (!conversationId || owner(tab) === conversationId || nativeOwner(tab) === conversationId);
    });
    const id = viewport?.querySelector('webview')?.getAttribute('data-browser-sidebar-browser-tab-id') ?? undefined;
    const tab = findTab(id);
    const rect = viewport?.getBoundingClientRect();
    const request = id ? requests.get(id) : undefined;
    // The recovered host reports the inner page viewport, below both chrome
    // rows. Intersect it with the mounted element rather than its panel frame.
    const left = Math.max(0, rect?.left ?? 0, request?.bounds?.x ?? 0);
    let top = Math.max(0, rect?.top ?? 0, request?.bounds?.y ?? 0);
    const right = Math.min(window.innerWidth, rect?.right ?? 0,
      request?.bounds ? request.bounds.x + request.bounds.width : window.innerWidth);
    const bottom = Math.min(window.innerHeight, rect?.bottom ?? 0,
      request?.bounds ? request.bounds.y + request.bounds.height : window.innerHeight);
    const panel = [...document.querySelectorAll<HTMLElement>('[data-app-shell-focus-area="right-panel"], [data-app-shell-focus-area="bottom-panel"]')]
      .find(element => !element.hasAttribute('data-browser-sidebar-webview') && isVisible(element)
        && rect && element.getBoundingClientRect().left <= rect.left + 1 && element.getBoundingClientRect().right >= rect.right - 1);
    if (panel) {
      const content = panel.querySelector<HTMLElement>('[data-app-shell-pane-content-viewport]');
      if (content && isVisible(content)) top = Math.max(top, content.getBoundingClientRect().top);
      for (const chrome of panel.querySelectorAll<HTMLElement>('[role="tablist"], [role="toolbar"], input')) {
        if (!isVisible(chrome)) continue;
        let row = chrome;
        // Address inputs sit inside the navigation row's padding. Reserve that
        // entire row, including its lower border, instead of only the input.
        while (row.parentElement && row.parentElement !== panel) {
          const parentRect = row.parentElement.getBoundingClientRect();
          if (parentRect.height > 80 || parentRect.bottom >= bottom) break;
          row = row.parentElement;
        }
        const chromeRect = row.getBoundingClientRect();
        if (chromeRect.top < top && chromeRect.bottom < bottom) top = Math.max(top, chromeRect.bottom + 1);
      }
    }
    const contentTop = Math.ceil(top) + 1;
    const bounds = rect ? { x: Math.ceil(left), y: contentTop, width: Math.max(0, Math.floor(right) - Math.ceil(left)),
      height: Math.max(0, Math.floor(bottom) - contentTop) } : undefined;
    const visible = !!tab && !!bounds && bounds.width > 0 && bounds.height > 0;
    const value = { visible, ...(visible ? { bounds, tabId: tab.id, sessionId: nativeOwner(tab) } : {}) };
    visibleTabId = visible ? id : undefined;
    sendView(value);
  }

  function rememberRequest(request: RecoveredBrowserViewRequest) {
    if (!request.browserTabId) return;
    const previous = requests.get(request.browserTabId);
    if ((request.mountGeneration ?? 0) < (previous?.mountGeneration ?? 0)) return;
    requests.set(request.browserTabId, request);
    if ((request.visible === false || request.presented === false || (request.bounds && (request.bounds.width <= 0 || request.bounds.height <= 0)))
      && request.browserTabId === visibleTabId) hideView();
  }

  async function ensureTab(request: RecoveredBrowserViewRequest, url?: string): Promise<BrowserTab> {
    const existing = findTab(request.browserTabId);
    if (existing) return existing;
    const key = request.browserTabId ?? `new:${request.conversationId ?? conversationId}`;
    const pending = pendingTabs.get(key);
    if (pending) return pending;
    const creation = (async () => {
      const result = await bridge.browserCommand('newTab', { sessionId: (request.conversationId ?? conversationId) || 'local-browser', url: url ?? 'about:blank' }) as BrowserTab;
      if (request.browserTabId) {
        aliases.set(request.browserTabId, Number(result.id)); nativeAliases.set(Number(result.id), request.browserTabId);
      }
      state = await bridge.getBrowserState(); publishState(); scheduleLayout();
      return result;
    })().finally(() => pendingTabs.delete(key));
    pendingTabs.set(key, creation);
    return creation;
  }

  async function handleCommand(message: Record<string, unknown>) {
    const command = message.command as Record<string, unknown> | undefined;
    if (!command || typeof command.type !== 'string') return;
    const request = { browserTabId: typeof message.browserTabId === 'string' ? message.browserTabId : undefined,
      conversationId: typeof message.conversationId === 'string' ? message.conversationId : conversationId };
    const kind = command.type;
    if (kind === 'navigate') {
      const existed = findTab(request.browserTabId);
      const tab = await ensureTab(request, String(command.url));
      if (existed) await bridge.browserCommand('navigate', { tabId: tab.id, url: command.url });
    } else {
      const tab = findTab(request.browserTabId);
      if (!tab) return;
      const methods: Record<string, string> = { 'go-back': 'goBack', 'go-forward': 'goForward', reload: 'reload', 'close-tab': 'closeTab' };
      if (methods[kind]) await bridge.browserCommand(methods[kind], { tabId: tab.id });
    }
    scheduleLayout();
  }

  const onView = (event: Event) => {
    const message = (event as CustomEvent<Record<string, unknown>>).detail;
    if (!message) return;
    if (message.type === 'ready') {
      snapshots.clear(); opened.clear(); publishState(); scheduleLayout();
    }
    if (message.type === 'browser-use-session-route-capture' && !conversationId && typeof message.conversationId === 'string') conversationId = message.conversationId;
    if (message.type === 'browser-sidebar-owner-sync' && typeof message.conversationId === 'string') {
      if (conversationId !== message.conversationId) hideView();
      conversationId = message.conversationId;
      if (typeof message.ownerRoutePath === 'string') ownerRoute = message.ownerRoutePath;
      if (Array.isArray(message.presentedBrowserTabIds)) presentedTabs = new Set(message.presentedBrowserTabIds.filter((id): id is string => typeof id === 'string'));
      if (typeof message.sessionConversationId === 'string') conversationAliases.set(message.sessionConversationId, message.conversationId);
      if (blockedRoute(ownerRoute) || presentedTabs?.size === 0) hideView();
      publishState(); scheduleLayout();
    }
    if (message.type === 'browser-sidebar-command') void handleCommand(message).catch(report);
    if (message.type === 'browser-sidebar-sync' && message.payload && typeof message.payload === 'object') {
      const request = message.payload as RecoveredBrowserViewRequest;
      rememberRequest(request);
      postRecoveredHostMessage({ type: 'browser-sidebar-webview-attached', ...request });
      scheduleLayout();
    }
  };
  const stopState = bridge.onBrowserState(next => { state = next; publishState(); scheduleLayout(); });
  const stopCursor = bridge.onBrowserCursor(publishCursor);
  const resize = new ResizeObserver(layout);
  resize.observe(document.documentElement);
  const mutations = new MutationObserver(layout);
  mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'inert', 'hidden'] });
  window.addEventListener('codex-message-from-view', onView);
  window.addEventListener('resize', scheduleLayout);
  window.addEventListener('scroll', scheduleLayout, true);
  const onVisibility = () => { if (document.hidden) hideView(); else scheduleLayout(); };
  const onPageHide = () => hideView();
  const onNavigate = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const link = target?.closest<HTMLAnchorElement>('a[href]');
    const route = link?.getAttribute('href');
    if (route && !/^(?:https?:|mailto:|#)/iu.test(route)) {
      ownerRoute = route; presentedTabs = undefined; hideView(); scheduleLayout();
    } else {
      const action = target?.closest<HTMLElement>('button, [role="menuitem"]');
      const label = action?.textContent?.trim() || action?.getAttribute('aria-label') || '';
      if (/^(?:Settings|設定|设置|外掛程式|插件|Plugins|Pull Requests?|已排程|Scheduled|Automations)$/iu.test(label)) {
        // Only owner-sync knows which memory route committed. An action may be
        // unavailable or cancelled; inventing /settings here permanently hides
        // the view when the conversation never actually leaves its route.
        hideView(); scheduleLayout();
      }
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('click', onNavigate, true);
  publishState(); scheduleLayout();
  return {
    state: () => state,
    async syncView(request: RecoveredBrowserViewRequest) {
      rememberRequest(request);
      if (request.visible && request.presented !== false) await ensureTab(request);
      scheduleLayout();
    },
    dispose() {
      disposed = true; stopState(); stopCursor(); resize.disconnect(); mutations.disconnect();
      window.cancelAnimationFrame(frame);
      window.removeEventListener('codex-message-from-view', onView);
      window.removeEventListener('resize', scheduleLayout);
      window.removeEventListener('scroll', scheduleLayout, true);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('click', onNavigate, true);
      void bridge.setBrowserView({ visible: false }).catch(() => {});
    },
  };
}
