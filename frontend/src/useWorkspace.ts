import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackendStatus, DesktopBridge, LocalSession, ProviderRegistry, ProviderRegistryWrite, RpcEvent } from '../../shared/bridge';
import type { Thread } from '../../protocol_schema/typescript/v2/Thread';
import type { ThreadItem } from '../../protocol_schema/typescript/v2/ThreadItem';
import type { Turn } from '../../protocol_schema/typescript/v2/Turn';
import type { ThreadListResponse } from '../../protocol_schema/typescript/v2/ThreadListResponse';
import type { ThreadReadResponse } from '../../protocol_schema/typescript/v2/ThreadReadResponse';
import type { ThreadStartResponse } from '../../protocol_schema/typescript/v2/ThreadStartResponse';
import type { ThreadResumeResponse } from '../../protocol_schema/typescript/v2/ThreadResumeResponse';
import type { ThreadUnsubscribeResponse } from '../../protocol_schema/typescript/v2/ThreadUnsubscribeResponse';
import type { ThreadTurnsListResponse } from '../../protocol_schema/typescript/v2/ThreadTurnsListResponse';
import type { ThreadItemsListResponse } from '../../protocol_schema/typescript/v2/ThreadItemsListResponse';
import type { TurnStartResponse } from '../../protocol_schema/typescript/v2/TurnStartResponse';
import type { ApprovalRequest, ChatMessage, ThreadSummary } from './types';

interface ThreadCache {
  messages: ChatMessage[];
  activeTurnId: string | null;
  pending: boolean;
  runtimeStatus: Thread['status']['type'] | null;
  runtimeRevision: number;
  closedTurns: Set<string>;
  terminalItems: Set<string>;
  reasoning: Map<string, { summary: string[]; content: string[] }>;
  itemTurns: Map<string, string>;
}

const approvalMethods = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'execCommandApproval', 'applyPatchApproval',
]);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function savedWorkspace(): string {
  try { return localStorage.getItem('codex++.workspace') ?? ''; } catch { return ''; }
}

function summary(thread: Thread): ThreadSummary {
  return { id: thread.id, title: thread.name || thread.preview || thread.id, cwd: thread.cwd };
}

function hasRunningTurn(cache: ThreadCache): boolean {
  return cache.activeTurnId !== null || cache.runtimeStatus === 'active';
}

function selectionMismatch(response: ThreadResumeResponse, providerId: string, model: string): string | null {
  if (response.modelProvider === providerId && response.model === model) return null;
  return `已阻止发送：此线程实际使用 ${response.modelProvider}/${response.model}，当前选择为 ${providerId}/${model}。活跃回合或其他客户端订阅会阻止后端应用恢复覆盖。请等待回合结束并关闭其他客户端后重选此线程，或新建线程；未发送任何输入。`;
}

function messageFor(item: ThreadItem, completed: boolean): ChatMessage | null {
  const status = completed ? 'completed' : 'streaming';
  switch (item.type) {
    case 'userMessage': return {
      id: item.id, role: 'user', status: 'completed',
      text: item.content.map(input => {
        switch (input.type) {
          case 'text': return input.text;
          case 'localImage': case 'localAudio': return input.path;
          case 'image': return 'url' in input ? input.url : input.fileId;
          case 'audio': return input.url;
          case 'skill': case 'mention': return `${input.name} (${input.path})`;
        }
      }).join('\n'),
    };
    case 'agentMessage': return { id: item.id, role: 'assistant', text: item.text, status };
    case 'reasoning': return { id: item.id, role: 'reasoning', text: (item.summary.some(Boolean) ? item.summary : item.content).join('\n\n'), status };
    case 'plan': return { id: item.id, role: 'assistant', text: item.text, status };
    case 'commandExecution': return {
      id: item.id, role: 'tool', text: [item.command, item.aggregatedOutput, item.exitCode == null ? null : `Exit code: ${item.exitCode}`].filter(value => value != null).join('\n'),
      status: item.status === 'failed' || item.status === 'declined' ? 'failed' : item.status === 'inProgress' ? 'streaming' : 'completed',
    };
    case 'fileChange': return {
      id: item.id, role: 'tool', text: item.changes.map(change => `${change.path}\n${change.diff}`).join('\n\n'),
      status: item.status === 'failed' || item.status === 'declined' ? 'failed' : item.status === 'inProgress' ? 'streaming' : 'completed',
    };
    case 'mcpToolCall': return {
      id: item.id, role: 'tool', text: `${item.server}/${item.tool}\n${JSON.stringify(item.error ?? item.result ?? item.arguments, null, 2)}`,
      status: item.status === 'failed' ? 'failed' : item.status === 'inProgress' ? 'streaming' : 'completed',
    };
    case 'dynamicToolCall': return {
      id: item.id, role: 'tool', text: `${item.tool}\n${JSON.stringify(item.contentItems ?? item.arguments, null, 2)}`,
      status: item.success === false ? 'failed' : status,
    };
    case 'functionCallOutput': return { id: item.id, role: 'tool', text: `${item.name}\n${typeof item.output === 'string' ? item.output : JSON.stringify(item.output, null, 2)}`, status: 'completed' };
    case 'webSearch': return { id: item.id, role: 'tool', text: JSON.stringify(item, null, 2), status };
    case 'imageView': return { id: item.id, role: 'tool', text: item.path, status };
    case 'collabAgentToolCall': return { id: item.id, role: 'tool', text: `${item.tool}\n${item.prompt ?? ''}\n${JSON.stringify(item.agentsStates, null, 2)}`, status };
    case 'enteredReviewMode': case 'exitedReviewMode': return { id: item.id, role: 'tool', text: item.review, status };
    default: return null;
  }
}

function putMessage(cache: ThreadCache, message: ChatMessage): void {
  const index = cache.messages.findIndex(existing => existing.id === message.id);
  if (index < 0) cache.messages.push(message);
  else cache.messages[index] = message;
}

function putItem(cache: ThreadCache, item: ThreadItem, turnId: string, completed: boolean, history = false): void {
  if (history && cache.messages.some(message => message.id === item.id)) return;
  if (!completed && cache.terminalItems.has(item.id)) return;
  const message = messageFor(item, completed);
  if (message) putMessage(cache, message);
  cache.itemTurns.set(item.id, turnId);
  if (item.type === 'reasoning') cache.reasoning.set(item.id, { content: [...item.content], summary: [...item.summary] });
  if (completed) cache.terminalItems.add(item.id);
}

function putTurn(cache: ThreadCache, turn: Turn, history = false): void {
  const completed = turn.status !== 'inProgress';
  for (const item of turn.items) putItem(cache, item, turn.id, completed, history);
  if (completed) {
    cache.closedTurns.add(turn.id);
    if (cache.activeTurnId === turn.id || cache.activeTurnId === null) {
      cache.activeTurnId = null;
      if (!history) {
        cache.pending = false;
        cache.runtimeStatus = 'idle';
      }
    }
    for (const message of cache.messages) {
      if (cache.itemTurns.get(message.id) === turn.id && message.status === 'streaming') {
        message.status = turn.status === 'failed' ? 'failed' : 'completed';
      }
    }
  } else if (!cache.closedTurns.has(turn.id) && (!history || cache.runtimeStatus === 'active')) {
    cache.activeTurnId = turn.id;
    if (!history) {
      cache.pending = false;
      cache.runtimeStatus = 'active';
    }
  }
}

export function useWorkspace() {
  const bridge: DesktopBridge | undefined = window.codex;
  const [status, setStatus] = useState<BackendStatus>({ state: bridge ? 'starting' : 'error', message: bridge ? undefined : '桌面桥接不可用，请在 Electron 中打开此工作区。' });
  const [session, setSession] = useState<LocalSession | null>(null);
  const [registry, setRegistry] = useState<ProviderRegistry | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [workspace, setWorkspace] = useState(savedWorkspace);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const caches = useRef(new Map<string, ThreadCache>());
  const activeId = useRef<string | null>(null);
  const workspaceRef = useRef(workspace);
  const registryRef = useRef(registry);
  const statusRef = useRef(status);
  const selection = useRef(0);
  const listGeneration = useRef(0);
  const creating = useRef(false);
  const responding = useRef(new Set<string | number>());
  const alive = useRef(true);

  const cacheFor = useCallback((id: string): ThreadCache => {
    let cache = caches.current.get(id);
    if (!cache) {
      cache = { messages: [], activeTurnId: null, pending: false, runtimeStatus: null, runtimeRevision: 0, closedTurns: new Set(), terminalItems: new Set(), reasoning: new Map(), itemTurns: new Map() };
      caches.current.set(id, cache);
    }
    return cache;
  }, []);

  const publish = useCallback((id: string) => {
    if (!alive.current || activeId.current !== id) return;
    const cache = cacheFor(id);
    setMessages(cache.messages.map(message => ({ ...message })));
    setBusy(cache.pending || cache.activeTurnId !== null || cache.runtimeStatus === 'active');
  }, [cacheFor]);

  const activate = useCallback((id: string | null) => {
    activeId.current = id;
    setActiveThreadId(id);
    if (id) publish(id);
    else { setMessages([]); setBusy(false); }
  }, [publish]);

  const rememberThread = useCallback((thread: Thread) => {
    if (workspaceRef.current && thread.cwd !== workspaceRef.current) return;
    setThreads(previous => [summary(thread), ...previous.filter(entry => entry.id !== thread.id)]);
  }, []);

  const refreshThreads = useCallback(async () => {
    if (!bridge || statusRef.current.state !== 'ready') return;
    const generation = ++listGeneration.current;
    let cursor: string | null = null;
    const found = new Map<string, ThreadSummary>();
    const seen = new Set<string>();
    do {
      const page: ThreadListResponse = await bridge.request('thread/list', {
        limit: 100, cursor, sortKey: 'updated_at', sortDirection: 'desc',
        modelProviders: [], ...(workspaceRef.current ? { cwd: workspaceRef.current } : {}),
      });
      if (!alive.current || generation !== listGeneration.current) return;
      for (const thread of page.data) found.set(thread.id, summary(thread));
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('thread/list 返回了重复的分页游标。');
      if (cursor) seen.add(cursor);
    } while (cursor);
    setThreads([...found.values()]);
  }, [bridge]);

  const handleEvent = useCallback((event: RpcEvent) => {
    if (!alive.current || !bridge) return;
    if ('id' in event && (typeof event.id === 'string' || typeof event.id === 'number')) {
      const request: ApprovalRequest = { id: event.id, method: event.method, params: event.params };
      if (approvalMethods.has(event.method)) {
        setApprovals(previous => previous.some(entry => entry.id === request.id) ? previous : [...previous, request]);
      } else {
        void bridge.respond(event.id, undefined, { code: -32601, message: `Unsupported client request: ${event.method}` }).catch(failure => setError(errorText(failure)));
      }
      return;
    }
    // The bridge preserves the generated v2 notification envelope. Dispatching
    // the union first also prevents unrelated extension notifications being cast.
    const notification = event as RpcEvent & { params: Record<string, unknown> };
    const params = notification.params;
    if (!params || typeof params !== 'object') return;
    if (event.method === 'serverRequest/resolved') {
      setApprovals(previous => previous.filter(request => request.id !== params.requestId));
      return;
    }
    if (event.method === 'thread/started' && 'thread' in params) {
      rememberThread(params.thread as Thread);
      return;
    }
    const threadId = params.threadId;
    if (typeof threadId !== 'string') return;
    const cache = cacheFor(threadId);
    const turnId = typeof params.turnId === 'string' ? params.turnId : '';
    const itemId = typeof params.itemId === 'string' ? params.itemId : '';
    switch (event.method) {
      case 'thread/name/updated':
        if (typeof params.threadName === 'string') setThreads(previous => previous.map(thread => thread.id === threadId ? { ...thread, title: params.threadName as string } : thread));
        break;
      case 'turn/started': case 'turn/completed': {
        const turn = params.turn as Turn;
        cache.runtimeRevision++;
        putTurn(cache, turn);
        if (turn.error && activeId.current === threadId) setError(turn.error.message);
        if (event.method === 'turn/completed') void refreshThreads().catch(failure => setError(errorText(failure)));
        break;
      }
      case 'item/started': case 'item/completed':
        putItem(cache, params.item as ThreadItem, turnId, event.method === 'item/completed' || cache.closedTurns.has(turnId));
        break;
      case 'item/agentMessage/delta': case 'item/reasoning/textDelta': case 'item/reasoning/summaryTextDelta':
      case 'item/commandExecution/outputDelta': case 'item/fileChange/outputDelta': {
        if (!itemId || cache.terminalItems.has(itemId) || cache.closedTurns.has(turnId) || typeof params.delta !== 'string') break;
        cache.itemTurns.set(itemId, turnId);
        const existing = cache.messages.find(message => message.id === itemId);
        if (event.method.startsWith('item/reasoning/')) {
          const parts = cache.reasoning.get(itemId) ?? { content: [], summary: [] };
          const isSummary = event.method === 'item/reasoning/summaryTextDelta';
          const index = Number(isSummary ? params.summaryIndex : params.contentIndex) || 0;
          const values = isSummary ? parts.summary : parts.content;
          values[index] = (values[index] ?? '') + params.delta;
          cache.reasoning.set(itemId, parts);
          putMessage(cache, { id: itemId, role: 'reasoning', text: (parts.summary.some(Boolean) ? parts.summary : parts.content).join('\n\n'), status: 'streaming' });
        } else {
          putMessage(cache, { id: itemId, role: event.method === 'item/agentMessage/delta' ? 'assistant' : 'tool', text: (existing?.text ?? '') + params.delta, status: 'streaming' });
        }
        break;
      }
      case 'item/fileChange/patchUpdated': {
        if (cache.terminalItems.has(itemId)) break;
        const changes = params.changes as Extract<ThreadItem, { type: 'fileChange' }>['changes'];
        putItem(cache, { type: 'fileChange', id: itemId, changes, status: 'inProgress' }, turnId, false);
        break;
      }
      case 'thread/status/changed': {
        const threadStatus = params.status as Thread['status'];
        cache.runtimeRevision++;
        cache.runtimeStatus = threadStatus.type;
        if (threadStatus.type !== 'active') {
          cache.activeTurnId = null;
          if (threadStatus.type !== 'idle') cache.pending = false;
        }
        break;
      }
      case 'error': {
        const failure = params.error as { message?: string };
        if (activeId.current === threadId) setError(failure.message ?? '后端请求失败。');
        if (!params.willRetry) {
          cache.runtimeRevision++;
          if (turnId) cache.closedTurns.add(turnId);
          if (cache.activeTurnId === turnId || cache.activeTurnId === null) { cache.activeTurnId = null; cache.pending = false; cache.runtimeStatus = 'systemError'; }
        }
        break;
      }
    }
    publish(threadId);
  }, [bridge, cacheFor, publish, refreshThreads, rememberThread]);

  useEffect(() => {
    alive.current = true;
    if (!bridge) return;
    const offEvent = bridge.onEvent(handleEvent);
    const updateStatus = (next: BackendStatus) => {
      if (!alive.current) return;
      const wasReady = statusRef.current.state === 'ready';
      statusRef.current = next;
      setStatus(next);
      if (next.state === 'ready' && !wasReady) void refreshThreads().catch(failure => setError(errorText(failure)));
      if (next.state === 'error' || next.state === 'stopped') {
        for (const [id, cache] of caches.current) {
          if (cache.activeTurnId) cache.closedTurns.add(cache.activeTurnId);
          cache.pending = false;
          cache.activeTurnId = null;
          cache.runtimeRevision++;
          cache.runtimeStatus = 'notLoaded';
          for (const message of cache.messages) if (message.status === 'streaming') message.status = 'failed';
          publish(id);
        }
        setApprovals([]);
      }
    };
    const offStatus = bridge.onStatus(updateStatus);
    void bridge.getStatus().then(updateStatus).catch(failure => updateStatus({ state: 'error', message: errorText(failure) }));
    // Local BYOK initialization intentionally has no cloud account/login RPC.
    void bridge.readProviders().then(value => {
      if (alive.current) { registryRef.current = value; setRegistry(value); }
    }).catch(failure => { if (alive.current) setError(errorText(failure)); });
    void bridge.getSession().then(value => { if (alive.current) setSession(value); }).catch(failure => { if (alive.current) setError(errorText(failure)); });
    return () => { alive.current = false; offEvent(); offStatus(); selection.current++; listGeneration.current++; };
  }, [bridge, handleEvent, publish, refreshThreads]);

  const chooseWorkspace = useCallback(async (): Promise<string | null> => {
    if (!bridge) { setError('桌面桥接不可用。'); return null; }
    try {
      const chosen = await bridge.chooseWorkspace();
      if (!chosen) return null;
      selection.current++;
      workspaceRef.current = chosen;
      setWorkspace(chosen);
      try { localStorage.setItem('codex++.workspace', chosen); } catch { /* Workspace selection still works when storage is disabled. */ }
      activate(null);
      setLoading(false);
      setThreads([]);
      setError(null);
      await refreshThreads();
      return chosen;
    } catch (failure) { setError(errorText(failure)); return null; }
  }, [activate, bridge, refreshThreads]);

  const resumeSelected = useCallback(async (id: string, providerId: string, model: string): Promise<ThreadResumeResponse> => {
    if (!bridge) throw new Error('桌面桥接不可用。');
    const cache = cacheFor(id);
    const resume = async () => {
      const revision = cache.runtimeRevision;
      const response = await bridge.request<ThreadResumeResponse>('thread/resume', {
        threadId: id, modelProvider: providerId, model, excludeTurns: true,
      });
      if (revision === cache.runtimeRevision) {
        cache.runtimeStatus = response.thread.status.type;
        if (cache.runtimeStatus !== 'active') cache.activeTurnId = null;
      }
      publish(id);
      return response;
    };
    let response = await resume();
    if (response.modelProvider === providerId && response.model === model) return response;
    // Unsubscribe removes only this connection's subscription. It does not
    // interrupt a turn. The server alone decides whether an idle, unobserved
    // loaded thread can be shut down and rebuilt with the requested overrides.
    if (response.thread.status.type === 'idle' && cache.runtimeStatus === 'idle' && !cache.activeTurnId) {
      await bridge.request<ThreadUnsubscribeResponse>('thread/unsubscribe', { threadId: id });
      response = await resume();
    }
    return response;
  }, [bridge, cacheFor, publish]);

  const selectThread = useCallback(async (id: string) => {
    if (!bridge || statusRef.current.state !== 'ready' || creating.current) return;
    const generation = ++selection.current;
    activate(id);
    setLoading(true);
    setError(null);
    try {
      const value = registryRef.current ?? await bridge.readProviders();
      registryRef.current = value;
      setRegistry(value);
      const provider = value.providers.find(entry => entry.id === value.activeProviderId);
      if (!provider?.defaultModel) throw new Error('请先在设置中配置 Provider 和默认模型，再恢复线程。');
      const read = await bridge.request<ThreadReadResponse>('thread/read', { threadId: id, includeTurns: false });
      // A cold resume must carry both selections before this client subscribes.
      const resumed = await resumeSelected(id, provider.id, provider.defaultModel);
      if (generation !== selection.current || !alive.current) return;
      const mismatch = selectionMismatch(resumed, provider.id, provider.defaultModel);
      const thread = resumed.thread;
      const cache = cacheFor(id);
      const history: Turn[] = [];
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const page: ThreadTurnsListResponse = await bridge.request('thread/turns/list', { threadId: id, cursor, limit: 100, sortDirection: 'asc', itemsView: 'full' });
        if (generation !== selection.current || !alive.current) return;
        for (const turn of page.data) {
          if (turn.itemsView !== 'full') {
            const items: ThreadItem[] = [];
            let itemCursor: string | null = null;
            const itemCursors = new Set<string>();
            do {
              const itemPage: ThreadItemsListResponse = await bridge.request('thread/items/list', { threadId: id, turnId: turn.id, cursor: itemCursor, limit: 100, sortDirection: 'asc' });
              if (generation !== selection.current || !alive.current) return;
              items.push(...itemPage.data.map(entry => entry.item));
              itemCursor = itemPage.nextCursor;
              if (itemCursor && itemCursors.has(itemCursor)) throw new Error('thread/items/list 返回了重复的分页游标。');
              if (itemCursor) itemCursors.add(itemCursor);
            } while (itemCursor);
            history.push({ ...turn, items });
          } else history.push(turn);
        }
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error('thread/turns/list 返回了重复的分页游标。');
        if (cursor) seen.add(cursor);
      } while (cursor);
      // Put historical items before any notifications received during hydration.
      const live = [...cache.messages];
      for (const turn of history) putTurn(cache, turn, true);
      const order = [...new Set(history.flatMap(turn => turn.items.map(item => item.id)))];
      const byId = new Map(cache.messages.map(message => [message.id, message]));
      cache.messages = [...order.flatMap(itemId => byId.has(itemId) ? [byId.get(itemId)!] : []), ...live.filter(message => !order.includes(message.id))];
      const cwd = thread.cwd || read.thread.cwd;
      workspaceRef.current = cwd;
      setWorkspace(cwd);
      try { localStorage.setItem('codex++.workspace', cwd); } catch { /* Keep the runtime workspace when storage is disabled. */ }
      rememberThread(thread);
      if (mismatch) setError(mismatch);
      publish(id);
    } catch (failure) { if (generation === selection.current) setError(errorText(failure)); }
    finally { if (generation === selection.current) setLoading(false); }
  }, [activate, bridge, cacheFor, publish, rememberThread, resumeSelected]);

  const createThread = useCallback(async (): Promise<string | null> => {
    if (!bridge || statusRef.current.state !== 'ready' || creating.current) return null;
    creating.current = true;
    setLoading(true);
    setError(null);
    const generation = ++selection.current;
    try {
      const cwd = workspaceRef.current || await chooseWorkspace();
      if (!cwd) return null;
      const workspaceSelection = selection.current;
      const value = registryRef.current;
      const provider = value?.providers.find(entry => entry.id === value.activeProviderId);
      if (!provider?.defaultModel) throw new Error('请先在设置中配置 Provider 和默认模型。');
      const response = await bridge.request<ThreadStartResponse>('thread/start', {
        cwd, modelProvider: provider.id, model: provider.defaultModel, ephemeral: false,
      });
      const cache = cacheFor(response.thread.id);
      cache.runtimeStatus = response.thread.status.type;
      if (response.modelProvider !== provider.id || response.model !== provider.defaultModel) {
        throw new Error(`线程创建配置不匹配：实际为 ${response.modelProvider}/${response.model}，选择为 ${provider.id}/${provider.defaultModel}。未发送任何输入。`);
      }
      rememberThread(response.thread);
      // Choosing a directory is itself a selection change; the new thread owns it.
      if (generation === selection.current || workspaceSelection === selection.current) activate(response.thread.id);
      return response.thread.id;
    } catch (failure) { setError(errorText(failure)); return null; }
    finally { creating.current = false; setLoading(false); }
  }, [activate, bridge, cacheFor, chooseWorkspace, rememberThread]);

  const send = useCallback(async (text: string) => {
    if (!bridge || !text.trim() || statusRef.current.state !== 'ready' || creating.current) return;
    let id = activeId.current;
    if (!id) id = await createThread();
    if (!id) return;
    const cache = cacheFor(id);
    if (cache.pending || hasRunningTurn(cache)) return;
    const value = registryRef.current;
    const provider = value?.providers.find(entry => entry.id === value.activeProviderId);
    if (!provider?.defaultModel) { setError('请先选择 Provider 和模型。'); return; }
    cache.pending = true;
    publish(id);
    setError(null);
    try {
      // Loaded threads can ignore resume overrides. Verify the effective
      // response before turn/start, whose model field cannot select a provider.
      const resumed = await resumeSelected(id, provider.id, provider.defaultModel);
      const mismatch = selectionMismatch(resumed, provider.id, provider.defaultModel);
      if (mismatch) throw new Error(mismatch);
      if (resumed.thread.status.type === 'active' || hasRunningTurn(cache)) {
        throw new Error('此线程已有正在运行的回合（可能由其他客户端启动），本次输入未发送。请等待回合结束。');
      }
      const result = await bridge.request<TurnStartResponse>('turn/start', {
        threadId: id, model: provider.defaultModel,
        input: [{ type: 'text', text, text_elements: [] }],
        clientUserMessageId: crypto.randomUUID(),
      });
      // Completion may arrive before the response. A closed turn never reopens.
      if (!cache.closedTurns.has(result.turn.id)) putTurn(cache, result.turn);
      else cache.pending = false;
    } catch (failure) { cache.pending = false; setError(errorText(failure)); }
    finally { publish(id); }
  }, [bridge, cacheFor, createThread, publish, resumeSelected]);

  const stop = useCallback(async () => {
    const id = activeId.current;
    if (!bridge || !id) return;
    const turnId = cacheFor(id).activeTurnId;
    if (!turnId) return;
    try { await bridge.request('turn/interrupt', { threadId: id, turnId }); }
    catch (failure) { setError(errorText(failure)); }
  }, [bridge, cacheFor]);

  const saveProviders = useCallback(async (value: ProviderRegistryWrite) => {
    if (!bridge) throw new Error('桌面桥接不可用，无法保存本地配置。');
    try {
      const saved = await bridge.writeProviders(value);
      registryRef.current = saved;
      setRegistry(saved);
      setSession(await bridge.getSession());
      setError(null);
    } catch (failure) {
      // Saving can succeed before a missing backend prevents restart. Read the
      // persisted registry so the UI reflects the file even in this case.
      try {
        const saved = await bridge.readProviders();
        registryRef.current = saved;
        setRegistry(saved);
        setSession(await bridge.getSession());
      } catch { /* Preserve the original save/restart failure for the dialog. */ }
      throw failure;
    }
  }, [bridge]);

  const selectModel = useCallback(async (providerId: string, model: string) => {
    if (!bridge) return;
    try {
      const saved = await bridge.selectModel(providerId, model);
      registryRef.current = saved;
      setRegistry(saved);
      setSession(await bridge.getSession());
      setError(null);
    } catch (failure) {
      try {
        const saved = await bridge.readProviders();
        registryRef.current = saved;
        setRegistry(saved);
        setSession(await bridge.getSession());
      } catch { /* Preserve the original model selection error. */ }
      setError(errorText(failure));
    }
  }, [bridge]);

  const respondApproval = useCallback(async (id: string | number, approved: boolean) => {
    if (!bridge || responding.current.has(id)) return;
    const request = approvals.find(entry => entry.id === id);
    if (!request) return;
    responding.current.add(id);
    const legacy = request.method === 'execCommandApproval' || request.method === 'applyPatchApproval';
    try {
      await bridge.respond(id, { decision: legacy ? (approved ? 'approved' : { denied: { rejection: 'User declined the request.' } }) : (approved ? 'accept' : 'decline') });
      setApprovals(previous => previous.filter(entry => entry.id !== id));
    } catch (failure) { setError(errorText(failure)); }
    finally { responding.current.delete(id); }
  }, [approvals, bridge]);

  return {
    status, session, registry, threads, workspace, activeThreadId, messages, busy, loading, error,
    approval: approvals[0] ?? null,
    chooseWorkspace, selectThread, createThread, send, stop, saveProviders, selectModel, respondApproval,
    clearError: () => setError(null),
  };
}
