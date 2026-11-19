'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, ...args) {
  const response = await ipcRenderer.invoke(channel, ...args);
  if (response?.ok === true) return response.value;
  const error = new Error(response?.error?.message || '桌面桥接调用失败');
  error.code = response?.error?.code;
  if (response?.error?.data !== undefined) error.data = response.error.data;
  throw error;
}

function subscribe(channel, listener) {
  if (typeof listener !== 'function') throw new TypeError('listener 必须是函数');
  const callback = (_event, value) => listener(value);
  ipcRenderer.on(channel, callback);
  let subscribed = true;
  return () => {
    if (subscribed) ipcRenderer.removeListener(channel, callback);
    subscribed = false;
  };
}

contextBridge.exposeInMainWorld('codex', Object.freeze({
  resolveLocalImage: (input) => invoke('codex:image:resolve-local', input),
  readLocalImage: (input) => invoke('codex:image:read-local', input),
  getBrowserState: () => invoke('codex:browser:state'),
  setBrowserView: (input) => invoke('codex:browser:view', input),
  browserCommand: (method, params) => invoke('codex:browser:command', method, params),
  onBrowserState: (listener) => subscribe('codex:browser:state', listener),
  onBrowserCursor: (listener) => subscribe('codex:browser:cursor', listener),
  writeClipboardText: text => invoke('codex:clipboard:write', text),
  readClipboardText: () => invoke('codex:clipboard:read'),
  gitRequest: (method, params) => invoke('codex:git:request', method, params),
  request: (method, params) => invoke('codex:request', method, params),
  respond: (id, result, error) => invoke('codex:respond', id, result, error),
  onEvent: (listener) => subscribe('codex:event', listener),
  onStatus: (listener) => subscribe('codex:status', listener),
  getStatus: () => invoke('codex:status:get'),
  getSession: () => invoke('codex:session:get'),
  readPreferences: () => invoke('codex:preferences:read'),
  writePreference: (scope, key, value) => invoke('codex:preferences:write', scope, key, value),
  onPreferences: (listener) => subscribe('codex:preferences', listener),
  discoverHost: () => invoke('codex:host:discover'),
  openHostTarget: (request) => invoke('codex:host:open-target', request),
  readProviders: () => invoke('codex:providers:read'),
  fetchProviderModels: (input) => invoke('codex:providers:fetchModels', input),
  writeProviders: (registry) => invoke('codex:providers:write', registry),
  selectModel: (providerId, model) => invoke('codex:model:select', providerId, model),
  chooseWorkspace: () => invoke('codex:workspace:choose'),
  createLocalProject: (input) => invoke('codex:projects:create-local', input),
}));
