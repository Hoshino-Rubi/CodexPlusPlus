import { installHostServices } from './hostServices';
import { prepareLocalPolicy, installLocalCapabilityGates, installLocalPluginCreation, installLocalSurfaceLabels, installLocalVoicePreferences } from './localPolicy';
import { initializeRecoveredPersistence, installViewTransport, recoveredApplicationState } from './viewTransport';
import { installLocalProviderUi } from '../original/localProviderUi';

function showBootstrapError(error: unknown): void {
  console.error('[FATAL_RENDERER]', error instanceof Error ? error.stack ?? error.message : String(error));
  const root = document.getElementById('root');
  if (!root) return;
  const message = document.createElement('p');
  message.setAttribute('role', 'alert');
  message.className = 'text-default';
  message.textContent = error instanceof Error ? error.message : String(error);
  root.replaceChildren(message);
}

/** Load the original React root after its real local transports are installed. */
export async function bootRecoveredWorkspace(): Promise<void> {
  const cleanup: Array<() => void> = [];
  let disposed = false;
  const retain = (release: () => void) => {
    if (disposed) release();
    else cleanup.push(release);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('pagehide', dispose);
    for (const release of cleanup.reverse()) {
      try { release(); } catch { /* Continue releasing independent transports. */ }
    }
    cleanup.length = 0;
  };
  window.addEventListener('pagehide', dispose, { once: true });
  try {
    if (!window.codex) throw new Error('Local desktop bridge is unavailable.');
    retain(await initializeRecoveredPersistence(window.codex));
    if (disposed) return;
    retain(installViewTransport(window.codex));
    const policy = await prepareLocalPolicy(window.codex);
    retain(policy.dispose);
    if (disposed) return;
    retain(await installHostServices(window.codex, {
      applicationState: recoveredApplicationState,
    }));
    if (disposed) return;
    retain(await installLocalProviderUi(window.codex));
    if (disposed) return;
    retain(await installLocalCapabilityGates());
    retain(installLocalPluginCreation());
    retain(installLocalSurfaceLabels());
    retain(installLocalVoicePreferences());
    if (disposed) return;
    const entry = new URL('./original/assets/app-main-199d78c65544.js', document.baseURI).href;
    await import(/* @vite-ignore */ entry);
  } catch (error) {
    dispose();
    showBootstrapError(error);
  }
}
