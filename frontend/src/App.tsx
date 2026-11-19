import { useLayoutEffect, useRef, useState } from 'react';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import Composer from './components/Composer';
import MessageList from './components/MessageList';
import SettingsDialog from './components/SettingsDialog';
import ModelPicker from './components/ModelPicker';
import ApprovalDialog from './components/ApprovalDialog';
import { useWorkspace } from './useWorkspace';

export default function App() {
  const app = useWorkspace();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const transcriptScroll = useRef<HTMLDivElement>(null);
  const followTranscript = useRef(true);
  const transcriptThread = useRef<string | null>(app.activeThreadId);
  const activeThread = app.threads.find(thread => thread.id === app.activeThreadId);
  const statusLabel = app.status.state === 'ready'
    ? app.loading ? '正在读取工作区' : app.busy ? '正在运行' : app.session?.ready ? '本地 BYOK 已就绪' : '请配置 Provider'
    : app.status.state === 'starting' ? '正在连接本地后端' : app.status.state === 'stopped' ? '本地后端已停止' : '本地后端不可用';

  useLayoutEffect(() => {
    if (transcriptThread.current !== app.activeThreadId) {
      transcriptThread.current = app.activeThreadId;
      followTranscript.current = true;
    }
    const scroll = transcriptScroll.current;
    if (scroll && followTranscript.current) {
      scroll.scrollTo({ top: Math.max(0, scroll.scrollHeight - scroll.clientHeight), behavior: 'instant' });
    }
  }, [app.activeThreadId, app.messages, app.busy, app.loading]);

  // Original class strings are retained from app-primary-8eba40dc50b2.js
  // and thread-app-shell-chrome-cad943bedea5.js. No login route is mounted.
  // TODO(stub): The original shell's router, resizable panels, tab controller,
  // and platform titlebar dependencies have not been reconstructed; this is
  // the functional workspace assembly, not a verified pixel-identical shell.
  return (
    <div className="isolate flex h-full min-h-0 flex-col [contain:layout_paint]">
      <div className="flex h-full min-w-0 flex-1 items-center">
        {sidebarOpen && (
          <Sidebar
            threads={app.threads}
            activeThreadId={app.activeThreadId}
            workspace={app.workspace}
            onSelect={id => { void app.selectThread(id); }}
            onNewThread={() => { void app.createThread(); }}
            onSettings={() => setSettingsOpen(true)}
            onChooseWorkspace={() => { void app.chooseWorkspace(); }}
          />
        )}
        <main className="relative isolate flex h-full min-h-0 min-w-0 flex-1 flex-col">
          <TopBar
            title={activeThread?.title ?? 'Codex++'}
            status={statusLabel}
            onToggleSidebar={() => setSidebarOpen(open => !open)}
          />
          <div className="flex shrink-0 items-center gap-2 text-codex-description">
            <button type="button" onClick={() => { void app.chooseWorkspace(); }}>
              {app.workspace || '选择工作区'}
            </button>
            <button type="button" onClick={() => setSettingsOpen(true)}>设置</button>
          </div>
          {app.status.message && <p role="status">{app.status.message}</p>}
          {app.error && (
            <div role="alert">
              <p>{app.error}</p>
              <button type="button" onClick={app.clearError}>关闭提示</button>
            </div>
          )}
          <div className="relative min-h-0 flex-1 overflow-hidden" aria-busy={app.loading}>
            {/* app-primary-8eba40dc50b2.js: zmn (export ER), default presentation;
                the original controller considers a distance of <=24px at bottom. */}
            <div
              ref={transcriptScroll}
              role="region"
              aria-label="Conversation"
              tabIndex={0}
              className="thread-scroll-container overflow-x-hidden overflow-y-auto overscroll-y-contain browser:overscroll-y-auto group-has-[[data-expanded-composer]]/thread-scroll-layout:overflow-y-hidden [overflow-anchor:none] [scroll-padding-bottom:var(--thread-scroll-padding-bottom,0px)] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset h-full electron:[scrollbar-gutter:stable_both-edges] [&:has([data-thread-scroll-footer='true']:focus-within)]:[scroll-padding-bottom:0px] flex flex-col pt-(--thread-content-top-inset) [--thread-sticky-header-top:calc(var(--spacing)*8)] browser:[--thread-sticky-header-top:var(--thread-content-top-inset,0px)]"
              onScroll={event => {
                const scroll = event.currentTarget;
                followTranscript.current = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 24;
              }}
            >
              <MessageList messages={app.messages} busy={app.busy || app.loading} />
            </div>
          </div>
          <Composer
            busy={app.busy}
            disabled={app.status.state !== 'ready' || app.loading || !app.session?.ready}
            onSend={text => { void app.send(text); }}
            onStop={() => { void app.stop(); }}
          >
            <ModelPicker
              registry={app.registry}
              disabled={app.busy || app.loading}
              onSelect={(providerId, model) => { void app.selectModel(providerId, model); }}
            />
          </Composer>
        </main>
      </div>
      <SettingsDialog
        open={settingsOpen}
        registry={app.registry}
        onClose={() => setSettingsOpen(false)}
        onSave={app.saveProviders}
      />
      <ApprovalDialog
        request={app.approval}
        onRespond={(id, approved) => { void app.respondApproval(id, approved); }}
      />
    </div>
  );
}
