export interface TopBarProps {
  title: string;
  status: string;
  onToggleSidebar: () => void;
}

export default function TopBar({ title, status, onToggleSidebar }: TopBarProps) {
  return (
    <header
      data-app-shell-main-titlebar="true"
      data-testid="app-shell-header-context-menu-surface"
      className="group/titlebar pointer-events-none top-[var(--app-shell-page-header-offset,0px)] flex h-[var(--app-shell-header-height,var(--height-toolbar))] min-w-0 flex-1 isolate self-start items-center gap-toolbar-action overflow-hidden [contain:layout_paint] [-webkit-app-region:initial] ps-2 pe-2 no-drag"
    >
      <button
        type="button"
        aria-label="Toggle sidebar"
        aria-controls="app-shell-sidebar"
        data-app-shell-sidebar-trigger="true"
        data-app-shell-focus-area="main"
        className="sidebar-icon-button sidebar-hover-icon-button-tint group/sidebar-trigger pointer-events-auto no-drag"
        onClick={onToggleSidebar}
      >
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
          className="shrink-0"
          aria-hidden="true"
          focusable="false"
        >
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="M9 3v18" />
        </svg>
      </button>
      <div className="pointer-events-none w-full min-w-0 flex-1">
        <span
          className="flex min-w-0 items-center gap-1"
          data-app-shell-titlebar-content="true"
        >
          <span className="min-w-0 flex-1 truncate text-default" title={title}>
            {title}
          </span>
          <span className="flex shrink-0 items-center gap-2 text-codex-description">
            {status}
          </span>
        </span>
      </div>
    </header>
  );
}
