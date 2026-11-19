import type { DesktopBridge, LocalSession } from '../../../shared/bridge';
import { getRecoveredPreferences, recoveredApplicationState, recoveredPersistedState, writeRecoveredPreference } from './viewTransport';
import { readLocalWindowsReadiness } from './localSetup';
import { readLocalPullRequests } from './hostServices';
import type { LocalPullRequestFilter } from './hostTypes';

export interface LocalWorkspacePolicy {
  readonly mode: 'byok';
  readonly defaultRoute: '/';
  readonly skipOnboarding: true;
  readonly history: 'memory';
  readonly systemLocale: string;
  /** Local application policy only; it does not assert OS sandbox provisioning. */
  readonly localExecutionReadiness: 'ready';
}

type Theme = 'dark' | 'light';
type SynchronousBridge = {
  getPreloadStartedAtMs?: () => number;
  getSystemThemeVariant?: () => Theme;
  subscribeToSystemThemeVariant?: (listener: () => void) => () => void;
};
type LocalWindow = Window & {
  __codexLocalPolicy?: LocalWorkspacePolicy;
  codexWindowType?: string;
  electronBridge?: SynchronousBridge;
};

let audioQueryClient: { invalidateQueries(options: { queryKey: string[] }): Promise<unknown> } | undefined;
let pullRequestQueryClient: typeof audioQueryClient;
let pullRequestFilter: LocalPullRequestFilter = 'all';
let pullRequestSearch = '';
let pullRequestsEmpty: boolean | null = null;
let pullRequestIcon: (() => { body: string; canvas: { viewBox: string } } | undefined) | undefined;

function refreshLocalPullRequests() {
  void pullRequestQueryClient?.invalidateQueries({ queryKey: ['local-pull-requests'] });
}

/** Apply only the desktop capabilities owned by this local host, before SDK clients are constructed. */
export async function installLocalCapabilityGates(): Promise<() => void> {
  const asset = new URL('./original/assets/app-initial-b0cd131b9dba.js', document.baseURI).href;
  const bundle = await import(/* @vite-ignore */ asset);
  const { StatsigClient } = bundle.P3n();
  const prototype = StatsigClient.prototype;
  const original = prototype._getFeatureGateImpl;
  const localGates = new Map<string, boolean>([
    ['1506311413', true], ['410065390', true], ['410262010', true],
    // The desktop keeps its standard single sidebar. PR has its own page layout.
    ['3085093835', false],
    // Show the original local voice configuration cards, including the voice picker.
    ['2380644311', true], ['1697652030', false],
  ]);
  function readGate(this: unknown, name: string, options: unknown) {
    const result = original.call(this, name, options);
    return localGates.has(name)
      ? { ...result, value: localGates.get(name), details: { ...result.details, reason: 'LocalOverride' } }
      : result;
  }
  prototype._getFeatureGateImpl = readGate;
  // These selectors otherwise reject apiKey solely because it is not a ChatGPT login.
  // Configuration is local; the host still owns permission checks and actual audio execution.
  bundle.N4n();
  bundle._Xt();
  const sharedAsset = new URL('./original/assets/app-shared-624e1c099f95.js', document.baseURI).href;
  const shared = await import(/* @vite-ignore */ sharedAsset);
  pullRequestIcon = () => shared.UQ;
  const capability = bundle.M4n;
  const pullRequests = bundle.gXt;
  const pullRequestAccess = bundle.bXt;
  const familyResolver = Object.getOwnPropertySymbols(capability)
    .find(symbol => symbol.description === 'maitai.resolveFamilyMemberInternal');
  if (!familyResolver) throw new Error('The recovered capability family resolver is unavailable');
  const originalCapabilityResolve = capability[familyResolver];
  // BYOK has a local marketplace, not the hosted remote-plugin replacement.
  // Otherwise the shipped query drops all local openai-curated entries after
  // flattening the catalog, even though plugin/list returned them successfully.
  bundle.cNn();
  const remotePlugins = bundle.lNn;
  const originalRemotePluginsResolve = remotePlugins[familyResolver];
  const localPluginMode = shared.QCt(shared.uct, () => false);
  const resolveRemotePlugins = localPluginMode[familyResolver].bind(localPluginMode);
  remotePlugins[familyResolver] = resolveRemotePlugins;
  const originalPullRequestsResolve = pullRequests.resolve;
  const originalPullRequestAccessResolve = pullRequestAccess.resolve;
  const localAudioSettings = new Set(['dictation', 'dictation.composer', 'dictation.global', 'voice', 'voice.realtime']);
  // The local native child view owns this capability; a hosted account is not required.
  if (typeof window.codex.getBrowserState === 'function' && typeof window.codex.setBrowserView === 'function') {
    localAudioSettings.add('browser.in-app');
  }
  const localAudio = shared.QCt(shared.uct, (_request: unknown, context: { queryClient: typeof audioQueryClient }) => {
    audioQueryClient = context.queryClient;
    return { isLoading: false, isError: false, isCapable: true };
  });
  const localPullRequests = shared.nwt(shared.uct, () => true);
  const localPullRequestAccess = shared.nwt(shared.uct, () => ({ status: 'allowed' }));
  // Never enable the global rail/tab workbench just to mount the PR list.
  bundle.Yxn();
  const contextualSidebar = bundle.Zxn;
  const originalContextualSidebarResolve = contextualSidebar.resolve;
  const localContextualSidebar = shared.nwt(shared.uct, () => false);
  const resolveContextualSidebar = localContextualSidebar.resolve.bind(localContextualSidebar);
  contextualSidebar.resolve = resolveContextualSidebar;
  // The atom graph can resolve its gate before the Statsig override is read.
  // Override the actual workbench selector as well as its gate, so the native
  // layout resolver deterministically takes the legacy desktop/header branch.
  bundle.dKt();
  const workbench = bundle.hKt;
  const originalWorkbenchResolve = workbench.resolve;
  const localWorkbench = shared.nwt(shared.uct, () => false);
  const resolveWorkbench = localWorkbench.resolve.bind(localWorkbench);
  workbench.resolve = resolveWorkbench;
  // UnifiedTabStrip has a separate scope-derived presentation selector. Keep
  // the original thread Header and its panel actions, not the multi-tab portal.
  bundle.vGt();
  const threadTabs = bundle.xGt;
  const originalThreadTabsResolve = threadTabs.resolve;
  const localThreadTabs = shared.nwt(shared.uct, () => false);
  const resolveThreadTabs = localThreadTabs.resolve.bind(localThreadTabs);
  threadTabs.resolve = resolveThreadTabs;
  // Cloud onboarding is not a prerequisite for a local gh-backed PR workspace.
  bundle.VXt();
  const setup = bundle.LXt;
  const originalSetupResolve = setup.resolve;
  const localSetup = shared.nwt(shared.uct, () => ({ status: 'ready', providers: [] }));
  const resolveSetup = localSetup.resolve.bind(localSetup);
  setup.resolve = resolveSetup;
  const primary = await import(/* @vite-ignore */ new URL('./original/assets/app-primary-8eba40dc50b2.js', document.baseURI).href);
  primary.q6();
  const originalScopeResolve = primary.w5.resolve;
  const localScope = shared.nwt(shared.uct, () => 'local-github-cli');
  const resolveScope = localScope.resolve.bind(localScope);
  primary.w5.resolve = resolveScope;
  const localPrQuery = shared.YCt(shared.uct, (context: { queryClient: typeof pullRequestQueryClient }) => {
    pullRequestQueryClient = context.queryClient;
    return { queryKey: ['local-pull-requests'],
      queryFn: async () => {
        const result = await readLocalPullRequests(pullRequestFilter, pullRequestSearch);
        pullRequestsEmpty = result.items.length === 0;
        window.dispatchEvent(new Event('codex-local-pr-updated'));
        return result;
      },
      staleTime: 0, refetchOnMount: 'always', retry: false };
  });
  const localSnapshot = shared.QCt(shared.uct, (_hostId: string, { get }: { get(query: unknown): { data?: Awaited<ReturnType<typeof readLocalPullRequests>>; isPending: boolean } }) => {
    const result = get(localPrQuery);
    const account = result.data?.account ?? null;
    return { scopeKey: 'local-github-cli', provider: 'github', hostname: 'github.com', account,
      providerAccountKey: account ? JSON.stringify([account.hostId, account.hostname, account.login]) : null,
      sections: ['waiting_for_review', 'needs_my_review', 'needs_my_teams_review', 'approved', 'drafts', 'merged'].map((id, index) => ({
        id, loading: result.isPending, failed: false, hasMore: false,
        items: index === 0 ? (result.data?.items ?? []).map(item => ({
          url: item.url, title: item.title, updatedAt: item.updatedAt, authorLogin: item.author?.login,
          authorName: item.author?.name, authorAvatarUrl: item.author?.avatarUrl,
          status: item.isDraft ? 'draft' : item.reviewDecision === 'APPROVED' ? 'approved' : 'review_required',
        })) : [],
      })), savedItems: [] };
  });
  const snapshotFamily = Object.getOwnPropertySymbols(primary.G6)
    .find(symbol => symbol.description === 'maitai.resolveFamilyMemberInternal');
  if (!snapshotFamily) throw new Error('The recovered PR snapshot family is unavailable');
  const originalSnapshotResolve = primary.G6[snapshotFamily];
  const resolveSnapshot = localSnapshot[snapshotFamily].bind(localSnapshot);
  primary.G6[snapshotFamily] = resolveSnapshot;
  function resolveCapability(this: unknown, ...args: unknown[]) {
    const request = args[2] as { name?: string } | undefined;
    if (request?.name && localAudioSettings.has(request.name)) {
      return localAudio[familyResolver!](...args);
    }
    return originalCapabilityResolve.apply(this, args);
  }
  const resolvePullRequests = localPullRequests.resolve.bind(localPullRequests);
  const resolvePullRequestAccess = localPullRequestAccess.resolve.bind(localPullRequestAccess);
  bundle.u6n();
  bundle.dH();
  const voiceSettings = bundle.fH;
  const accountSettings = bundle.c6n;
  const originalVoiceSettingsResolve = voiceSettings.resolve;
  const originalAccountSettingsResolve = accountSettings.resolve;
  const localVoiceQuery = shared.YCt(shared.uct, () => ({
    queryKey: ['chatgpt-settings-voices', 'local-byok'],
    queryFn: async () => {
      const selected = getRecoveredPreferences().applicationState['local-voice-name'];
      const voices = [
        { slug: 'sol', name: 'Sol', description: '明亮、自然的聲音' },
        { slug: 'arbor', name: 'Arbor', description: '溫暖、沉穩的聲音' },
        { slug: 'spruce', name: 'Spruce', description: '清晰、直接的聲音' },
      ].map(voice => ({ ...voice, accent: '', orbTreatment: 'advanced-blue', previewUrl: null }));
      return { effectiveVoiceSlug: voices.find(voice => voice.slug === selected)?.slug ?? 'sol', voices };
    },
    staleTime: 0,
    refetchOnMount: 'always',
  }));
  const localVoiceSettings = shared.nwt(shared.uct, ({ get }: { get(query: unknown): { data: unknown; error: unknown; refetch: unknown } }) => {
    const result = get(localVoiceQuery);
    return { data: result.data, error: result.error, refetch: result.refetch };
  });
  // Only voice preferences are supplied here: identity, subscriptions and remote permissions stay absent.
  const localAccountSettings = shared.YCt(shared.uct, () => ({
    queryKey: ['chatgpt-user-settings', 'local-byok'],
    queryFn: async () => ({
      voiceMainLanguage: getRecoveredPreferences().applicationState['local-voice-language'] ?? 'auto',
      voiceName: getRecoveredPreferences().applicationState['local-voice-name'] ?? 'sol',
    }),
    staleTime: 0,
    refetchOnMount: 'always',
  }));
  const resolveVoiceSettings = localVoiceSettings.resolve.bind(localVoiceSettings);
  const resolveAccountSettings = localAccountSettings.resolve.bind(localAccountSettings);
  capability[familyResolver] = resolveCapability;
  pullRequests.resolve = resolvePullRequests;
  pullRequestAccess.resolve = resolvePullRequestAccess;
  voiceSettings.resolve = resolveVoiceSettings;
  accountSettings.resolve = resolveAccountSettings;
  return () => {
    if (prototype._getFeatureGateImpl === readGate) prototype._getFeatureGateImpl = original;
    if (capability[familyResolver] === resolveCapability) capability[familyResolver] = originalCapabilityResolve;
    if (remotePlugins[familyResolver] === resolveRemotePlugins) remotePlugins[familyResolver] = originalRemotePluginsResolve;
    if (pullRequests.resolve === resolvePullRequests) pullRequests.resolve = originalPullRequestsResolve;
    if (pullRequestAccess.resolve === resolvePullRequestAccess) pullRequestAccess.resolve = originalPullRequestAccessResolve;
    if (setup.resolve === resolveSetup) setup.resolve = originalSetupResolve;
    if (contextualSidebar.resolve === resolveContextualSidebar) contextualSidebar.resolve = originalContextualSidebarResolve;
    if (workbench.resolve === resolveWorkbench) workbench.resolve = originalWorkbenchResolve;
    if (threadTabs.resolve === resolveThreadTabs) threadTabs.resolve = originalThreadTabsResolve;
    if (primary.w5.resolve === resolveScope) primary.w5.resolve = originalScopeResolve;
    if (primary.G6[snapshotFamily] === resolveSnapshot) primary.G6[snapshotFamily] = originalSnapshotResolve;
    if (voiceSettings.resolve === resolveVoiceSettings) voiceSettings.resolve = originalVoiceSettingsResolve;
    if (accountSettings.resolve === resolveAccountSettings) accountSettings.resolve = originalAccountSettingsResolve;
    audioQueryClient = undefined;
    pullRequestQueryClient = undefined;
    pullRequestIcon = undefined;
  };
}

/** Save through the local host because the recovered hosted mutation requires a ChatGPT account ID. */
export function installLocalVoicePreferences(): () => void {
  let saving = false;
  const onClick = (event: MouseEvent) => {
    const radio = event.target instanceof HTMLInputElement && event.target.type === 'radio' ? event.target : null;
    const voiceDialog = radio?.closest<HTMLElement>('[role="dialog"]');
    if (radio && voiceDialog && /選擇聲音|Choose a voice/u.test(voiceDialog.innerText + (voiceDialog.querySelector('legend')?.textContent ?? '')) && ['sol', 'arbor', 'spruce'].includes(radio.value)) {
      // Native radio selection still runs; the hosted handler would play a missing preview URL.
      event.stopImmediatePropagation();
      radio.title = '本地聲音偏好；此服務未提供試聽音訊';
      return;
    }
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
    if (!button || !/^(完成|Done)$/u.test(button.innerText.trim())) return;
    const dialog = button.closest<HTMLElement>('[role="dialog"]');
    const selected = dialog?.querySelector<HTMLInputElement>('input[type="radio"]:checked')
      ?? dialog?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
    if (!dialog || !selected || !/選擇聲音|Choose a voice/u.test(dialog.innerText + (dialog.querySelector('legend')?.textContent ?? ''))) return;
    const name = selected instanceof HTMLInputElement ? selected.value
      : selected.getAttribute('aria-label')?.split(/[：:]/u)[0]?.trim();
    if (!name) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (saving) return;
    saving = true;
    button.disabled = true;
    void (async () => {
      try {
        await writeRecoveredPreference('applicationState', 'local-voice-name', name.toLowerCase());
        await Promise.all([
          audioQueryClient?.invalidateQueries({ queryKey: ['chatgpt-settings-voices'] }),
          audioQueryClient?.invalidateQueries({ queryKey: ['chatgpt-user-settings'] }),
        ]);
        [...dialog.querySelectorAll<HTMLButtonElement>('button')]
          .find(candidate => /^(取消|Cancel)$/u.test(candidate.innerText.trim()))?.click();
      } catch (error) {
        const alert = document.createElement('p');
        alert.setAttribute('role', 'alert');
        alert.className = 'text-sm text-danger';
        alert.textContent = error instanceof Error ? error.message : String(error);
        dialog.appendChild(alert);
      } finally { saving = false; button.disabled = false; }
    })();
  };
  window.addEventListener('click', onClick, true);
  return () => window.removeEventListener('click', onClick, true);
}

/** Keep the original navigation and controls while making the local host's scope explicit. */
export function installLocalSurfaceLabels(): () => void {
  let shortcut: HTMLButtonElement | null = null;
  let openPullRequests = false;
  const renamed = new Map<Node, string>();
  const onClick = (event: MouseEvent) => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    const filter = button?.dataset.localPrFilter as LocalPullRequestFilter | undefined;
    if (filter && ['all', 'reviewing', 'mine'].includes(filter)) {
      pullRequestFilter = filter;
      refreshLocalPullRequests();
      scan();
      return;
    }
    if (button === shortcut) {
      openPullRequests = true;
      // Radix can mount the menu on pointerdown, before this click listener runs.
      window.setTimeout(scan, 0);
    }
  };
  const scan = () => {
    const agentHeading = document.querySelector<HTMLElement>('[data-mention-section-id="agents"] > div:first-child');
    if (agentHeading?.textContent === '智慧體') agentHeading.textContent = '代理程式';
    const rail = document.querySelector('nav.group\\/sidebar-rail');
    if (rail) {
      const buttons = [...rail.querySelectorAll<HTMLButtonElement>('button')];
      const home = buttons.find(button => /^(首頁|Home|新對話)$/u.test(button.innerText.trim()));
      const pullRequests = buttons.find(button => /^(程式碼審查|Code Review|Pull Request)$/u.test(button.innerText.trim()));
      for (const [button, label] of [[home, '新對話'], [pullRequests, 'Pull Request']] as const) {
        if (!button) continue;
        const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.textContent?.trim() === button.innerText.trim() && node.textContent?.trim() !== label) {
            if (!renamed.has(node)) renamed.set(node, node.textContent ?? '');
            node.textContent = label;
            break;
          }
        }
        button.setAttribute('aria-label', label);
      }
      const homeGroup = home?.parentElement;
      const prGroup = pullRequests?.parentElement;
      if (homeGroup && prGroup && homeGroup !== prGroup && homeGroup.parentElement === prGroup.parentElement
        && homeGroup.nextElementSibling !== prGroup) homeGroup.after(prGroup);
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')) {
      const text = button.innerText.trim();
      if (!/^(探索|Explore|Pull Request)$/u.test(text)) continue;
      const list = button.closest('[data-appearance="plain"]');
      if (!list?.classList.contains('group/nav-list')) continue;
      shortcut = button;
      const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent?.trim() === text && text !== 'Pull Request') {
          if (!renamed.has(node)) renamed.set(node, node.textContent ?? text);
          node.textContent = 'Pull Request';
          break;
        }
      }
      button.setAttribute('aria-label', 'Pull Request');
      // Keep the original SVG node owned by React; replace only its asset body.
      const asset = pullRequestIcon?.();
      const svg = button.querySelector('svg');
      if (asset && svg && svg.dataset.localPrIcon !== 'original') {
        svg.setAttribute('viewBox', asset.canvas.viewBox);
        svg.innerHTML = asset.body;
        svg.dataset.localPrIcon = 'original';
      }
      // New chat is in the preceding nav group. Move within this group only,
      // retaining React's original parent/child ownership for unmounts.
      if (button.parentElement?.firstElementChild !== button) button.parentElement?.prepend(button);
    }
    if (openPullRequests) {
      const destination = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find(item => /^(Code Review|程式碼審查|程式碼檢閱|代码审查)$/u.test(item.innerText.trim()));
      if (destination) {
        openPullRequests = false;
        destination.click();
      }
    }
    const pluginTabs = document.querySelector<HTMLElement>('[role="tablist"][aria-label="外掛程式目錄"]');
    if (pluginTabs && !document.getElementById('local-plugin-marketplace')) {
      const source = document.createElement('span');
      source.id = 'local-plugin-marketplace';
      source.className = 'ml-auto text-xs text-secondary';
      source.textContent = 'openai-api-curated';
      pluginTabs.parentElement?.appendChild(source);
    }
    // Keep the native card action and its installation hooks. Its original
    // icon-only presentation hid the localized label from the visible page.
    for (const button of document.querySelectorAll<HTMLButtonElement>('button[aria-label^="安裝 "]')) {
      if (button.querySelector('[data-local-install-label]')) continue;
      const label = document.createElement('span');
      label.dataset.localInstallLabel = 'true';
      label.textContent = '安裝';
      button.classList.remove('aspect-square', '!px-0');
      button.classList.add('px-2');
      button.appendChild(label);
    }
    const search = document.querySelector<HTMLInputElement>('input#code-review-sidebar-search');
    if (search) {
      search.placeholder = '搜尋提取要求';
      search.setAttribute('aria-label', '搜尋提取要求');
      if (search.value !== pullRequestSearch) search.value = pullRequestSearch;
      const wrapper = search.closest('.mb-2') ?? search.parentElement;
      if (wrapper && !document.getElementById('local-pr-filters')) {
        const filters = document.createElement('div');
        filters.id = 'local-pr-filters';
        filters.className = 'flex items-center gap-1 px-row-x';
        filters.setAttribute('role', 'tablist');
        filters.setAttribute('aria-label', '本地 Pull Request 篩選');
        for (const [value, label] of [['all', '全部'], ['reviewing', '審查中'], ['mine', '由我建立']]) {
          const tab = document.createElement('button');
          tab.type = 'button';
          tab.className = 'cursor-interaction rounded-md px-2 py-1 text-xs text-secondary';
          tab.dataset.localPrFilter = value;
          tab.setAttribute('role', 'tab');
          tab.textContent = label;
          filters.appendChild(tab);
        }
        wrapper.before(filters);
      }
      let empty = document.getElementById('local-pr-empty');
      if (wrapper && pullRequestsEmpty && !empty) {
        empty = document.createElement('p');
        empty.id = 'local-pr-empty';
        empty.setAttribute('role', 'status');
        empty.className = 'px-row-x text-sm text-secondary';
        empty.textContent = '找不到 Pull Request';
        wrapper.after(empty);
      } else if (!pullRequestsEmpty) empty?.remove();
      for (const tab of document.querySelectorAll<HTMLElement>('[data-local-pr-filter]')) {
        const selected = tab.dataset.localPrFilter === pullRequestFilter;
        tab.setAttribute('aria-selected', String(selected));
        tab.style.fontWeight = selected ? '600' : '400';
      }
      // Localized missing strings in this shipped bundle, scoped to the PR view.
      const translations = new Map([
        ['Select a pull request', '選取 Pull Request 以查看'],
        ['Choose one from the sidebar to review its changes', '從左側選取 Pull Request 以檢視變更'],
        ['No pull requests', '找不到 Pull Request'], ['沒有提取要求', '找不到 Pull Request'],
      ]);
      for (const element of document.querySelectorAll<HTMLElement>('h1, h2, h3, p, span, div.leading-6')) {
        if (element.children.length !== 0) continue;
        const translated = translations.get(element.textContent?.trim() ?? '');
        if (translated) element.textContent = translated;
      }
    }
    const headings = [...document.querySelectorAll<HTMLElement>('h1, h2, h3, legend')];
    const voiceHeading = headings.find(heading => /^(聲音|声音|Voice)$/u.test(heading.innerText.trim()));
    if (voiceHeading && document.body.innerText.includes('聽寫') && !document.getElementById('local-voice-scope')) {
      const note = document.createElement('p');
      note.id = 'local-voice-scope';
      note.className = 'text-sm text-secondary';
      note.textContent = '偏好設定僅儲存在本機；使用音訊功能需要相容服務連線與裝置權限。';
      voiceHeading.insertAdjacentElement('afterend', note);
    }
  };
  const observer = new MutationObserver(scan);
  observer.observe(document.body, { childList: true, subtree: true });
  const onSearch = (event: Event) => {
    if (!(event.target instanceof HTMLInputElement) || event.target.id !== 'code-review-sidebar-search') return;
    // Keep the original search control, but use the local repository query
    // instead of the private hosted /wham search component.
    event.stopImmediatePropagation();
    pullRequestSearch = event.target.value;
    refreshLocalPullRequests();
  };
  const onSearchKey = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement && event.target.id === 'code-review-sidebar-search' && event.key === 'Enter') {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  window.addEventListener('input', onSearch, true);
  window.addEventListener('keydown', onSearchKey, true);
  window.addEventListener('codex-local-pr-updated', scan);
  window.addEventListener('click', onClick, true);
  scan();
  return () => {
    observer.disconnect();
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('input', onSearch, true);
    window.removeEventListener('keydown', onSearchKey, true);
    window.removeEventListener('codex-local-pr-updated', scan);
    document.getElementById('local-pr-filters')?.remove();
    document.getElementById('local-pr-empty')?.remove();
    document.getElementById('local-voice-scope')?.remove();
    document.getElementById('local-plugin-marketplace')?.remove();
    for (const [node, text] of renamed) if (node.textContent === 'Pull Request') node.textContent = text;
    shortcut?.removeAttribute('aria-label');
  };
}

/** The hosted creator is unavailable to BYOK. Start an unsent local creation task instead. */
export function installLocalPluginCreation(): () => void {
  const items = new WeakSet<HTMLElement>();
  let disposed = false;
  const findButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.innerText === label || button.getAttribute('aria-label') === label);
  const waitFor = async <T>(read: () => T | null | undefined): Promise<T> => {
    for (let attempt = 0; attempt < 100 && !disposed; attempt++) {
      const value = read();
      if (value) return value;
      await new Promise(resolve => window.setTimeout(resolve, 30));
    }
    throw new Error('Local plugin creation could not open the task composer');
  };
  const createDraft = async (prompt: string) => {
    (findButton('返回應用程式') ?? findButton('Back to app'))?.click();
    const newTask = await waitFor(() => findButton('新對話') ?? findButton('New chat'));
    newTask.click();
    const editor = await waitFor(() => document.querySelector<HTMLElement>('[contenteditable="true"]'));
    editor.focus();
    // ProseMirror consumes the input event and preserves this as an editable, unsent draft.
    if (!document.execCommand('insertText', false, prompt)) {
      throw new Error('Local plugin creation could not populate the task draft');
    }
  };
  const create = () => createDraft('Help me create a local Codex plugin in the current workspace. Ask what it should do first. Use a .codex-plugin/plugin.json manifest and local skills or tools as needed; do not require a ChatGPT account or publish anything.');
  const scan = () => {
    if (!findButton('返回應用程式') && !findButton('Back to app')) return;
    for (const item of document.querySelectorAll<HTMLElement>('[role="menuitem"]')) {
      if (!/^(建立外掛程式|Create plugin)$/u.test(item.innerText.trim())) continue;
      items.add(item);
      if (item.getAttribute('aria-disabled') !== 'false') item.setAttribute('aria-disabled', 'false');
      if (item.hasAttribute('data-disabled')) item.removeAttribute('data-disabled');
      if (item.style.pointerEvents !== 'auto') item.style.pointerEvents = 'auto';
      item.title = 'Create a local plugin with your configured model';
    }
  };
  const onClick = (event: MouseEvent) => {
    const petButton = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
    if (petButton && /^(建立你的專屬寵物|Create your own pet)$/u.test(petButton.getAttribute('aria-label') ?? '')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void createDraft('Help me create a custom local Codex pet. Ask what it should look like first. Use the local custom pet manifest and sprite sheet format, and save the completed pet through the local custom-pet host service. Do not download or enable hosted skills automatically.').catch(error => console.error('[LOCAL_PET_CREATOR]', error));
      return;
    }
    const item = event.target instanceof Element ? event.target.closest<HTMLElement>('[role="menuitem"]') : null;
    if (!item || !items.has(item)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void create().catch(error => console.error('[LOCAL_PLUGIN_CREATOR]', error));
  };
  const observer = new MutationObserver(scan);
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('click', onClick, true);
  return () => { disposed = true; observer.disconnect(); window.removeEventListener('click', onClick, true); };
}

/**
 * Run before importing the recovered ESM graph: app-initial FK snapshots this meta once.
 * The original Router is fC -> cCt/y4e -> c0e (memory history), including under file:.
 * Never history.pushState('/') or replace the Electron loadFile URL with a disk-root URL.
 */
export async function prepareLocalPolicy(bridge: DesktopBridge = window.codex): Promise<{ session: LocalSession; dispose: () => void }> {
  const [session, preferences] = await Promise.all([bridge.getSession(), bridge.readPreferences()]);
  if (session.mode !== 'byok' || session.account.type !== 'apiKey' || session.requiresOpenaiAuth !== false) {
    throw new Error('原工作区初始化需要本地 BYOK 会话');
  }
  const target = window as LocalWindow;
  const priorPolicy = target.__codexLocalPolicy;
  const priorWindowType = target.codexWindowType;
  // The shipped settings service owns localeOverride. Keep auto-detection separate from that explicit choice.
  if (navigator.platform.startsWith('Win')) await readLocalWindowsReadiness(recoveredApplicationState, session);
  // Persist before exposing the original atom graph, so a failed JSON write cannot reject unobserved.
  await recoveredPersistedState.write('home-composer-mode-v1', 'work');
  const policy: LocalWorkspacePolicy = Object.freeze({ mode: 'byok', defaultRoute: '/', skipOnboarding: true, history: 'memory', systemLocale: preferences.locale, localExecutionReadiness: 'ready' });
  target.__codexLocalPolicy = policy;
  target.codexWindowType = 'electron';

  const existingMeta = document.querySelector<HTMLMetaElement>('meta[name="initial-route"]');
  const initialRoute = existingMeta ?? document.createElement('meta');
  const previousRoute = existingMeta?.content;
  initialRoute.name = 'initial-route';
  initialRoute.content = '/';
  if (!existingMeta) document.head.appendChild(initialRoute);

  const previousBridge = target.electronBridge;
  const synchronousBridge: SynchronousBridge = { ...previousBridge };
  const addedKeys: (keyof SynchronousBridge)[] = [];
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  if (!synchronousBridge.getPreloadStartedAtMs) {
    synchronousBridge.getPreloadStartedAtMs = () => performance.timeOrigin;
    addedKeys.push('getPreloadStartedAtMs');
  }
  if (!synchronousBridge.getSystemThemeVariant) {
    synchronousBridge.getSystemThemeVariant = () => media.matches ? 'dark' : 'light';
    addedKeys.push('getSystemThemeVariant');
  }
  if (!synchronousBridge.subscribeToSystemThemeVariant) {
    synchronousBridge.subscribeToSystemThemeVariant = (listener) => {
      media.addEventListener('change', listener);
      return () => media.removeEventListener('change', listener);
    };
    addedKeys.push('subscribeToSystemThemeVariant');
  }
  // No sendMessageFromView: the original dispatcher already emits our CustomEvent once.
  target.electronBridge = synchronousBridge;

  const platform = navigator.platform.toLowerCase();
  const os = platform.includes('win') ? 'win32' : platform.includes('mac') ? 'darwin' : 'linux';
  document.documentElement.dataset.codexWindowType = 'electron';
  document.documentElement.dataset.windowType = 'electron';
  document.documentElement.dataset.codexOs = os;

  return {
    session,
    dispose() {
      if (target.codexWindowType === 'electron') {
        if (priorWindowType === undefined) delete target.codexWindowType;
        else target.codexWindowType = priorWindowType;
      }
      if (target.__codexLocalPolicy === policy) {
        if (priorPolicy) target.__codexLocalPolicy = priorPolicy;
        else delete target.__codexLocalPolicy;
      }
      if (existingMeta && previousRoute !== undefined) initialRoute.content = previousRoute;
      else initialRoute.remove();
      if (target.electronBridge === synchronousBridge) {
        if (previousBridge) target.electronBridge = previousBridge;
        else delete target.electronBridge;
      } else if (target.electronBridge) {
        for (const key of addedKeys) {
          if (target.electronBridge[key] === synchronousBridge[key]) delete target.electronBridge[key];
        }
      }
    },
  };
}
