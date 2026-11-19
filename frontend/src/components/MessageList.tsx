import { useState } from 'react';
import type { ChatMessage } from '../types';

export interface MessageListProps {
  messages: ChatMessage[];
  busy: boolean;
}

// TODO(stub): 原始 od markdown token 渲染器与本轮消息的 bC 操作栏未在允许读取的 bundle 范围内完整恢复，
// 这里仅使用源 bundle 中观察到的 formatted-text 外层类名渲染既有文本，不伪造 markdown、附件、引用或操作栏内容。

// 来源：app-shared-624e1c099f95.js 的 k3（20x20 chevron），逐字节保留 path/viewBox/width/height。
const activityChevronClassName =
  'icon-2xs shrink-0 text-text/60 opacity-0 group-focus-visible/activity-header:opacity-100 group-focus-visible/activity-header:text-default group-has-[:focus-visible]/activity-header:opacity-100 group-has-[:focus-visible]/activity-header:text-default transition-transform duration-relaxed [@media(hover:hover)]:group-[:hover:not(:has([data-agent-activity-file-link]:hover))]/activity-header:opacity-100';

// 来源：agent-activity-item-row-4e87dc89e455.js 的 S（header）与 m（chevron）。
const activityHeaderClassName =
  'group/activity-header relative inline-flex min-w-0 max-w-full self-start items-center gap-1 p-0 text-start';
const activityToggleButtonClassName =
  'absolute inset-0 cursor-interaction rounded-md bg-transparent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 focus-visible:outline-none focus-visible:ring-inset';
const activityHeaderContentClassName =
  'shrink truncate text-size-chat pointer-events-none relative [&_a]:pointer-events-auto [&_button]:pointer-events-auto';
const activityHeaderInlineClassName = 'inline-flex min-w-0 gap-1.5 items-center';
const activityChevronSlotClassName = 'pointer-events-none relative flex';

function ActivityChevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={[activityChevronClassName, expanded ? 'rotate-90 opacity-100' : null].filter(Boolean).join(' ')}
    >
      <path
        d="M7.52925 3.7793C7.75652 3.55203 8.10803 3.52383 8.36616 3.69434L8.47065 3.7793L14.2207 9.5293C14.4804 9.789 14.4804 10.211 14.2207 10.4707L8.47065 16.2207C8.21095 16.4804 7.78895 16.4804 7.52925 16.2207C7.26955 15.961 7.26955 15.539 7.52925 15.2793L12.8085 10L7.52925 4.7207L7.44429 4.61621C7.27378 4.35808 7.30198 4.00657 7.52925 3.7793Z"
        fill="currentColor"
      />
    </svg>
  );
}

function UserItem({ message }: { message: ChatMessage }) {
  return (
    <div className="group/user-message flex w-full flex-col gap-1 items-end">
      <div className="bg-user-message text-user-message min-w-0 max-w-(--user-chat-width) overflow-hidden break-words px-(--thread-content-margin) [&_.contain-inline-size]:[contain:initial] _bubble_168sz_1 rounded-2xl py-2.5 relative text-start">
        <div className="text-size-chat whitespace-pre-wrap">
          <div className="[&_ol]:!ps-6 [&_ul]:!ps-6 rich-text-user-turn [&>p]:!m-0 [&>p+p]:!mt-5">
            {message.text}
          </div>
        </div>
      </div>
    </div>
  );
}

// 来源：subagent-activity-chip-group-3c945b5e2db4.js 的 dC，根容器与 speaker 无障碍标题。
function AssistantItem({ message }: { message: ChatMessage }) {
  return (
    <div className="group flex min-w-0 flex-col">
      <h4
        className="sr-only m-0 select-none print:not-sr-only print:mt-4 print:mb-2 print:text-xs print:leading-normal print:font-bold"
        data-conversation-role="assistant"
        tabIndex={-1}
      >
        ChatGPT said:
      </h4>
      <div className="[&>*:last-child]:mb-0 [&>ol:first-child]:mt-0 [&>ul:first-child]:mt-0">
        <div className="text-size-chat whitespace-pre-wrap">{message.text}</div>
      </div>
    </div>
  );
}

// 来源：subagent-activity-chip-group-3c945b5e2db4.js 的 gO 与 agent-activity-item-row-4e87dc89e455.js 的 a/s。
function ReasoningItem({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const label = message.status === 'streaming' ? 'Thinking' : 'Thought';
  return (
    <div className="flex min-w-0 flex-col">
      <div className={activityHeaderClassName}>
        <button
          type="button"
          className={activityToggleButtonClassName}
          aria-label={label}
          aria-expanded={expanded}
          onClick={() => setExpanded(value => !value)}
        />
        <span className={activityHeaderContentClassName}>
          <span className={activityHeaderInlineClassName}>
            <span className="text-text/60 flex min-w-0 max-w-full items-center truncate shrink group-hover/activity-header:text-default">
              {label}
            </span>
            <span className={activityChevronSlotClassName}>
              <ActivityChevron expanded={expanded} />
            </span>
          </span>
        </span>
      </div>
      {expanded && (
        <div className="-ms-2 ps-2" style={{ overflow: 'hidden' }}>
          <div className="flex flex-col gap-2 pt-2 pb-1">
            <div className="text-text/60 [&_*]:text-text/50 break-words text-size-chat [&_*]:text-size-chat">
              {message.text}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// 来源：mcp-tool-item-content-4b7514602138.js 的卡片容器、滚动区与 pre，以及工具摘要类名。
function ToolItem({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const label = message.status ?? 'Tool output';
  return (
    <div className="flex w-full min-w-0 flex-col gap-2 self-start">
      <div className={activityHeaderClassName}>
        <button
          type="button"
          className={activityToggleButtonClassName}
          aria-label={label}
          aria-expanded={expanded}
          onClick={() => setExpanded(value => !value)}
        />
        <span className={activityHeaderContentClassName}>
          <span className={activityHeaderInlineClassName}>
            <span className="min-w-0 shrink truncate text-size-chat text-text-tertiary/90 group-hover/activity-header:text-default">
              {label}
            </span>
            <span className={activityChevronSlotClassName}>
              <ActivityChevron expanded={expanded} />
            </span>
          </span>
        </span>
      </div>
      {expanded && (
        <div className="relative overflow-clip rounded-lg border border-strong bg-secondary-soft-alpha contain-inline-size">
          <div className="max-h-48 overflow-y-auto p-2">
            <pre className="[&_*]:text-text/50 text-codex-description/80 m-0 whitespace-pre-wrap break-words font-sans text-size-chat leading-relaxed extension:leading-normal">
              {message.text}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

export default function MessageList({ messages, busy }: MessageListProps) {
  return (
    <div className="relative mx-auto flex w-full max-w-3xl flex-1 shrink-0 flex-col gap-4 px-toolbar pt-4 pb-8 text-default">
      <section className="flex flex-col gap-4">
        {messages.map(message => (
          <div key={message.id} className="flex flex-col">
            {message.role === 'user' && <UserItem message={message} />}
            {message.role === 'assistant' && <AssistantItem message={message} />}
            {message.role === 'reasoning' && <ReasoningItem message={message} />}
            {message.role === 'tool' && <ToolItem message={message} />}
          </div>
        ))}
      </section>
      {busy && (
        <div className="loading-shimmer-pure-text text-size-chat text-secondary select-none" role="status">
          Thinking
        </div>
      )}
    </div>
  );
}
