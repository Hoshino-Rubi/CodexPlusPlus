import { bootRecoveredWorkspace } from './recovered/boot';

// The shipped Markdown renderer uses app://fs/@fs/ for local references.
// Resolve only image elements through the desktop's image-only capability API;
// remote/data/blob assets and original bundled icons keep their original URLs.
function installLocalMessageImages(): void {
  const resolved = new Map<string, Promise<string>>();
  const sources = new WeakMap<HTMLImageElement, string>();
  function localSource(image: HTMLImageElement): string | null {
    const source = image.getAttribute('src')?.trim();
    if (!source || /^(?:https?:|data:|blob:)/iu.test(source)) return null;
    if (/^codex-asset:\/\/local\/[0-9a-f-]{36}$/iu.test(source)) return null;
    if (source.startsWith('app://fs/@fs/')) {
      try { return decodeURIComponent(source.slice('app://fs/@fs/'.length)); } catch { return null; }
    }
    if (/^(?:[A-Za-z]:[\\/]|file:|codex-asset:)/iu.test(source)) return source;
    if (/^(?:\.\/)?original\/|^assets\//u.test(source)) return null;
    if (!/^[a-z][a-z0-9+.-]*:/iu.test(source) && /\.(?:png|jpe?g|webp|gif|avif|bmp|ico)(?:[?#].*)?$/iu.test(source)) return source;
    return null;
  }
  function scanImage(image: HTMLImageElement): void {
    const source = localSource(image);
    if (!source || sources.get(image) === source) return;
    sources.set(image, source);
    let pending = resolved.get(source);
    if (!pending) {
      pending = window.codex.resolveLocalImage(source);
      resolved.set(source, pending);
      pending.catch(() => resolved.delete(source));
    }
    void pending.then(url => {
      if (sources.get(image) === source && image.isConnected) {
        image.removeAttribute('srcset');
        image.src = url;
        image.dataset.localImageResolved = 'true';
      }
    }).catch(error => console.warn('[LOCAL_MESSAGE_IMAGE]', error.message));
  }
  const scan = (node: Node) => {
    if (node instanceof HTMLImageElement) scanImage(node);
    if (node instanceof Element) for (const image of node.querySelectorAll('img')) scanImage(image);
  };
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') scan(record.target);
      else for (const node of record.addedNodes) scan(node);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'] });
  scan(document.body);
  window.addEventListener('pagehide', () => { observer.disconnect(); resolved.clear(); }, { once: true });
}

installLocalMessageImages();

// Reserve the original sidebar's trailing shortcut/action rail and truncate
// long titles inside its existing row rather than drawing beneath the badge.
const sidebarTitleStyle = document.createElement('style');
sidebarTitleStyle.textContent = `
  [data-app-action-sidebar-thread-row] [data-thread-title-trigger] { padding-right: 64px; overflow: hidden; }
  [data-app-action-sidebar-thread-row] [data-thread-title] { min-width: 0px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  [data-app-action-sidebar-thread-row] [data-marquee-content] { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  [data-app-action-sidebar-thread-row] [data-thread-title] > span > span { transform: none !important; max-width: 100%; }
`;
document.head.append(sidebarTitleStyle);

// The original composer contains fixed-size actions around a variable-length
// local model name. Let that name absorb width changes when the browser opens.
const composerLayoutStyle = document.createElement('style');
composerLayoutStyle.textContent = `
  [data-request-input-activity-root], ._ComposerLayoutRoot_1q7o3_2,
  ._ComposerLayoutBody_1q7o3_2, ._ComposerLayoutFooter_1q7o3_2,
  [data-local-composer-toolbar] { min-width: 0px; overflow-x: hidden; }
  [data-local-composer-toolbar] { max-width: 100%; }
  [data-local-composer-toolbar] > :not([data-local-model-container]) { flex-shrink: 0; }
  [data-local-model-container] { min-width: 0px !important; flex: 1 1 auto !important; overflow: hidden; }
  [data-local-model-trigger] { min-width: 0px !important; flex: 1 1 auto !important; max-width: 100%; overflow: hidden; }
  [data-local-model-label] { display: block; min-width: 0px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  ._ComposerLayoutFooter_1q7o3_2 button:not([data-local-model-trigger]),
  [data-local-composer-toolbar] [role="progressbar"] { flex-shrink: 0; }
`;
document.head.append(composerLayoutStyle);
function markComposerLayout(): void {
  for (const trigger of document.querySelectorAll<HTMLElement>('[data-local-model-trigger]')) {
    let toolbar = trigger.parentElement;
    while (toolbar && toolbar !== document.body) {
      const style = getComputedStyle(toolbar);
      if (style.display.includes('flex') && style.flexDirection === 'row' && toolbar.querySelectorAll('button').length >= 3) break;
      toolbar = toolbar.parentElement;
    }
    if (!toolbar || toolbar === document.body) continue;
    toolbar.setAttribute('data-local-composer-toolbar', 'true');
    for (let node: HTMLElement | null = trigger; node && node !== toolbar; node = node.parentElement) {
      node.setAttribute('data-local-model-container', 'true');
    }
  }
}
const composerLayoutObserver = new MutationObserver(markComposerLayout);
composerLayoutObserver.observe(document.body, { childList: true, subtree: true });
markComposerLayout();
window.addEventListener('pagehide', () => composerLayoutObserver.disconnect(), { once: true });

// The local desktop owns clipboard access, including when Chromium lacks focus.
if (window.codex?.writeClipboardText && navigator.clipboard) {
  Object.defineProperty(navigator.clipboard, 'writeText', {
    configurable: true,
    value: (text: string) => window.codex.writeClipboardText(text),
  });
  const richWrite = navigator.clipboard.write?.bind(navigator.clipboard);
  Object.defineProperty(navigator.clipboard, 'write', {
    configurable: true,
    value: async (items: ClipboardItem[]) => {
      const plain = items.find(item => item.types.includes('text/plain'));
      if (plain) return window.codex.writeClipboardText(await (await plain.getType('text/plain')).text());
      if (richWrite) return richWrite(items);
      throw new Error('Clipboard content has no text/plain representation');
    },
  });
}

window.addEventListener('error', event => {
  // Chromium delivers deferred ResizeObserver layout notifications as stackless ErrorEvents,
  // not thrown JavaScript exceptions. Keep them visible without mislabelling them as fatal.
  if (event.error == null && /^ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)\.?$/u.test(event.message)) {
    console.warn('[RENDERER_LAYOUT_WARNING]', event.message);
    return;
  }
  console.error('[FATAL_RENDERER]', event.error?.stack ?? event.message);
});
window.addEventListener('unhandledrejection', event => console.error('[FATAL_RENDERER]', event.reason?.stack ?? String(event.reason)));

void bootRecoveredWorkspace();
