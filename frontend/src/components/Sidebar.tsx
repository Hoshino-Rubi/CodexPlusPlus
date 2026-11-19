import { useLayoutEffect, useRef } from 'react';
import type { ThreadSummary } from '../types';

export interface SidebarProps {
  threads: ThreadSummary[];
  activeThreadId: string | null;
  workspace: string;
  onSelect: (id: string) => void;
  onNewThread: () => void;
  onSettings: () => void;
  onChooseWorkspace: () => void;
}

interface SidebarIconProps {
  className?: string;
}

const sidebarRowClassName = [
  'sidebar-item relative shrink-0 items-center overflow-hidden text-start text-sm',
  'disabled:cursor-default disabled:opacity-50 aria-disabled:cursor-default aria-disabled:opacity-50',
  'cursor-interaction min-h-[var(--height-token-row)] flex w-full',
  'gap-2 px-[var(--padding-row-cell-x,var(--padding-row-x))] py-row-y',
  'hover:bg-primary-ghost-hover data-[state=open]:bg-primary-ghost-hover',
].join(' ');

const folderRowClassName = [
  'sidebar-item sidebar-row-focus group/folder-row flex h-[var(--height-token-row)] items-center justify-between overflow-hidden text-sm text-default',
  'hover:bg-primary-ghost-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring electron:opacity-75',
].join(' ');

const sidebarScrollClassName = [
  'relative isolate mb-[var(--sidebar-footer-height)] flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto',
  'scroll-pb-[var(--padding-row-x)] pt-(--sidebar-scroll-content-top-padding) pb-row-x',
  '[--radius-token-row:10px] [contain:layout_paint] browser:gap-5',
].join(' ');

const navigationHeaderClassName =
  '@container/navigation-header ms-2 flex h-[var(--sidebar-navigation-header-height,calc(var(--spacing)*8))] items-center pe-1 browser:ms-2.5 browser:h-9';

function ChevronDownIcon({ className }: SidebarIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path
        d="M10.2954 6.54537C10.5003 6.3404 10.8325 6.34051 11.0376 6.54537C11.2426 6.7504 11.2426 7.08253 11.0376 7.28756L8.60689 9.71822C8.27169 10.0534 7.72823 10.0534 7.39303 9.71822L4.96236 7.28756C4.75734 7.08253 4.75734 6.7504 4.96236 6.54537C5.16739 6.34035 5.49952 6.34035 5.70455 6.54537L7.99947 8.84029L10.2954 6.54537Z"
        fill="currentColor"
      />
    </svg>
  );
}

function getWorkspaceLabel(workspace: string): string {
  const trimmed = workspace.replace(/[\\/]+$/, '');
  if (trimmed.length === 0) {
    return workspace.length > 0 ? workspace : 'Choose workspace';
  }
  const segments = trimmed.split(/[\\/]/);
  const last = segments[segments.length - 1];
  return last.length > 0 ? last : trimmed;
}

export default function Sidebar({
  threads,
  activeThreadId,
  workspace,
  onSelect,
  onNewThread,
  onSettings,
  onChooseWorkspace,
}: SidebarProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const footerRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const footer = footerRef.current;
    if (root == null || footer == null) {
      return undefined;
    }
    const applyFooterHeight = () => {
      root.style.setProperty('--sidebar-footer-height', `${footer.getBoundingClientRect().height}px`);
    };
    applyFooterHeight();
    const observer = new ResizeObserver(applyFooterHeight);
    observer.observe(footer);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--sidebar-footer-height');
    };
  }, []);

  const workspaceLabel = getWorkspaceLabel(workspace);

  return (
    <div
      ref={rootRef}
      id="app-shell-sidebar"
      data-app-shell-sidebar="true"
      className="w-token-sidebar relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden sidebar-navigation"
    >
      <div className={navigationHeaderClassName}>
        <button
          type="button"
          onClick={onChooseWorkspace}
          aria-label={`Choose workspace: ${workspace}`}
          title={workspace}
          className={`${folderRowClassName} min-w-0 flex-1`}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5 whitespace-nowrap">
            <span className="relative sidebar-item-icon shrink-0">
              <FolderIcon className="icon-xs" />
            </span>
            <span className="text-fade-truncate pe-1">{workspaceLabel}</span>
          </span>
          <span className="relative sidebar-item-icon shrink-0">
            <ChevronDownIcon />
          </span>
        </button>
        <button
          type="button"
          onClick={onNewThread}
          aria-label="New chat"
          title="New chat"
          className="sidebar-icon-button sidebar-hover-icon-button-tint shrink-0"
        >
          <SquareAndPencilIcon className="icon-xs" />
        </button>
      </div>

      <div className={sidebarScrollClassName} data-app-action-sidebar-scroll="">
        {threads.length === 0 ? (
          <div className="text-codex-description opacity-50 px-8 py-1 text-base">No chats</div>
        ) : (
          threads.map((thread) => {
            const isActive = thread.id === activeThreadId;
            const title = thread.title.length > 0 ? thread.title : 'Untitled chat';
            return (
              <button
                key={thread.id}
                type="button"
                onClick={() => onSelect(thread.id)}
                aria-current={isActive ? 'page' : undefined}
                title={title}
                className={`${sidebarRowClassName} sidebar-row-focus${isActive ? ' bg-primary-ghost-hover' : ''}`}
                data-app-action-sidebar-thread-row=""
                data-app-action-sidebar-thread-id={thread.id}
                data-app-action-sidebar-thread-host-id=""
                data-app-action-sidebar-thread-kind="local"
                data-app-action-sidebar-thread-active={String(isActive)}
                data-app-action-sidebar-thread-selected={String(isActive)}
                data-app-action-sidebar-thread-pinned="false"
                data-app-action-sidebar-thread-title={title}
              >
                <span className="text-fade-truncate pe-1">{title}</span>
              </button>
            );
          })
        )}
      </div>

      <div ref={footerRef} className="absolute inset-x-0 bottom-0 min-h-0 min-w-0 overflow-visible">
        <div className="flex flex-col gap-4 px-row-x pb-row-x">
          <button
            type="button"
            onClick={onSettings}
            aria-label="Settings"
            className={`${sidebarRowClassName} sidebar-row-focus`}
          >
            <span className="relative sidebar-item-icon shrink-0">
              <GearIcon className="icon-xs" />
            </span>
            <span className="text-fade-truncate pe-1">Settings</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function SquareAndPencilIcon({ className }: SidebarIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path
        d="M6.33325 1.80763C6.62314 1.80763 6.85855 2.04315 6.85864 2.33302C6.85864 2.62297 6.6232 2.85841 6.33325 2.85841H4.66626C3.66786 2.85859 2.85891 3.66765 2.85864 4.66603V11.333C2.85864 12.3316 3.66769 13.1414 4.66626 13.1416H11.3333C12.332 13.1416 13.1418 12.3317 13.1418 11.333V9.66603C13.1421 9.37642 13.3766 9.14179 13.6663 9.14161C13.956 9.14161 14.1914 9.37631 14.1917 9.66603V11.333C14.1917 12.9116 12.9119 14.1914 11.3333 14.1914H4.66626C3.0878 14.1912 1.80786 12.9115 1.80786 11.333V4.66603C1.80813 3.08775 3.08796 1.80781 4.66626 1.80763H6.33325Z"
        fill="currentColor"
      />
      <path
        d="M10.842 2.32228C11.6259 1.55049 12.8863 1.55435 13.6643 2.33204C14.4442 3.11205 14.4469 4.37706 13.6702 5.16017L9.41626 9.4463C9.05652 9.80879 8.59956 10.0601 8.10083 10.1699L6.19263 10.5899C5.7111 10.6958 5.28165 10.2666 5.38794 9.78517L5.80884 7.88185C5.9196 7.38036 6.17342 6.92096 6.53931 6.56056L10.842 2.32228ZM12.9221 3.07521C12.552 2.7051 11.9524 2.70322 11.5793 3.07033L7.27563 7.30861C7.05429 7.52663 6.90125 7.80504 6.83423 8.10841L6.54028 9.43849L7.87524 9.14454C8.17687 9.07807 8.45355 8.92625 8.67114 8.70704L12.9241 4.41993C13.2934 4.04741 13.2928 3.44631 12.9221 3.07521Z"
        fill-rule="evenodd"
        clip-rule="evenodd"
        fill="currentColor"
      />
    </svg>
  );
}

function GearIcon({ className }: SidebarIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path
        d="M8.00062 5.2793C9.50689 5.2793 10.7289 6.50063 10.7291 8.00684C10.7289 9.51311 9.50693 10.7354 8.00062 10.7354C6.49463 10.735 5.27328 9.51288 5.27308 8.00684C5.27335 6.50086 6.49467 5.27967 8.00062 5.2793ZM8.00062 6.33008C7.07457 6.33045 6.32413 7.08076 6.32386 8.00684C6.32406 8.93298 7.07453 9.68421 8.00062 9.68458C8.92703 9.68458 9.67816 8.93321 9.67836 8.00684C9.67809 7.08053 8.92699 6.33008 8.00062 6.33008Z"
        fill-rule="evenodd"
        clip-rule="evenodd"
        fill="currentColor"
      />
      <path
        d="M8.59633 1.24024C9.07592 1.24041 9.51987 1.49643 9.75941 1.91309C9.97218 2.28352 10.2906 2.83779 10.5465 3.28223C10.5982 3.37176 10.694 3.42675 10.7985 3.42676L12.3795 3.42774C12.8587 3.42793 13.3021 3.68368 13.5416 4.09864L14.1295 5.11719C14.3672 5.52926 14.3684 6.03653 14.1334 6.4502L13.2536 8.00098L14.1334 9.54786C14.3685 9.96173 14.3675 10.4706 14.1295 10.8828L13.5416 11.9014C13.302 12.3162 12.8586 12.5721 12.3795 12.5723L10.7975 12.5713C10.6934 12.5715 10.5981 12.6276 10.5465 12.7168C10.2906 13.1614 9.97118 13.7156 9.75844 14.0859C9.51881 14.5027 9.07511 14.7588 8.59535 14.7588C8.17471 14.7588 7.8383 14.7578 7.40492 14.7578C6.92515 14.7578 6.48146 14.5027 6.24183 14.0859C6.02905 13.7155 5.70972 13.1614 5.45375 12.7168C5.40213 12.6273 5.3062 12.5713 5.20179 12.5713H3.62172C3.14243 12.5713 2.69927 12.3155 2.45961 11.9004L1.87172 10.8818C1.63401 10.4698 1.63199 9.96251 1.86683 9.54883L2.74769 7.99903L1.86683 6.4502C1.63181 6.03636 1.63375 5.52838 1.87172 5.11622L2.45961 4.09864C2.69922 3.68389 3.14176 3.42795 3.62074 3.42774H5.20179C5.30622 3.42774 5.4021 3.37172 5.45375 3.28223C5.70967 2.83774 6.0281 2.28351 6.24086 1.91309C6.48037 1.49635 6.92432 1.24044 7.40394 1.24024C7.83772 1.24023 8.1753 1.24023 8.59633 1.24024ZM7.40492 2.29004C7.2999 2.29005 7.20281 2.34636 7.15101 2.43653C6.93819 2.80705 6.62008 3.3617 6.3639 3.80665C6.12441 4.22231 5.6814 4.47732 5.20277 4.47754H3.62172C3.51764 4.47754 3.42093 4.533 3.36879 4.62305L2.7809 5.64161C2.72924 5.73111 2.72899 5.84174 2.77992 5.93165L3.80629 7.73926C3.84008 7.79878 3.86295 7.86417 3.87172 7.93165L3.87562 7.99903C3.87565 8.06763 3.86231 8.13613 3.83656 8.19922L3.80629 8.25977L2.77894 10.0674C2.72805 10.1573 2.72924 10.2679 2.7809 10.3574L3.36879 11.376C3.42092 11.4661 3.51761 11.5215 3.62172 11.5215H5.20179C5.68071 11.5215 6.12432 11.7765 6.3639 12.1924C6.62013 12.6374 6.93914 13.1919 7.15199 13.5625C7.20372 13.6524 7.29923 13.7088 7.40394 13.709C7.83771 13.709 8.17531 13.708 8.59633 13.708C8.70115 13.7078 8.79754 13.6525 8.84926 13.5625C9.06202 13.1921 9.38023 12.6382 9.63636 12.1934C9.87592 11.7773 10.3195 11.5215 10.7985 11.5215H12.3795C12.4834 11.5213 12.5794 11.4658 12.6315 11.376L13.2194 10.3574C13.271 10.2679 13.2714 10.1573 13.2203 10.0674L12.193 8.25977C12.1481 8.18049 12.1256 8.09011 12.1256 7.99903C12.1257 7.9079 12.149 7.81751 12.194 7.73829L13.2203 5.93165C13.2712 5.84187 13.2708 5.73203 13.2194 5.64258L12.6315 4.62403C12.5794 4.53379 12.4828 4.47754 12.3786 4.47754L10.7985 4.47852C10.3197 4.47852 9.87697 4.22238 9.63734 3.80665C9.38106 3.36152 9.0621 2.80612 8.84926 2.43555C8.79741 2.3456 8.70021 2.29005 8.59535 2.29004C8.17471 2.29004 7.8383 2.29004 7.40492 2.29004Z"
        fill-rule="evenodd"
        clip-rule="evenodd"
        fill="currentColor"
      />
    </svg>
  );
}

function FolderIcon({ className }: SidebarIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path
        d="M5.55957 2.14136C6.06503 2.14136 6.55801 2.30207 6.9668 2.59937L7.81836 3.21851C8.04765 3.38523 8.32392 3.47534 8.60742 3.47534H11.9668C13.2877 3.47534 14.3584 4.54606 14.3584 5.86694V11.4666C14.3584 12.7874 13.2877 13.8582 11.9668 13.8582H4.0332C2.71253 13.8579 1.6416 12.7873 1.6416 11.4666V4.53296C1.64185 3.21244 2.71268 2.1416 4.0332 2.14136H5.55957ZM2.69238 7.85913V11.4666C2.69238 12.2074 3.29243 12.8081 4.0332 12.8083H11.9668C12.7078 12.8083 13.3086 12.2075 13.3086 11.4666V7.85913H2.69238ZM4.0332 3.19214C3.29258 3.19238 2.69263 3.79234 2.69238 4.53296V6.80835H13.3086V5.86694C13.3086 5.12596 12.7078 4.52515 11.9668 4.52515H8.60742C8.10196 4.52515 7.60898 4.36541 7.2002 4.06812L6.34863 3.448C6.11941 3.28145 5.84292 3.19214 5.55957 3.19214H4.0332Z"
        fill-rule="evenodd"
        clip-rule="evenodd"
        fill="currentColor"
      />
    </svg>
  );
}
