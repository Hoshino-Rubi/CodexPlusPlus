'use strict';

// Verified against the vendors' model documentation on 2026-11-18.
// Anthropic models require an OpenAI-compatible gateway in this desktop.
const DEFAULT_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const CATALOG_REVISION = 20261118;
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const model = (id, label, contextWindow, supportsImageInput = true, reasoningEfforts = DEFAULT_REASONING_EFFORTS) =>
  ({ id, label, contextWindow, supportsImageInput, reasoningEfforts: [...reasoningEfforts] });

const PRESET_PROVIDERS = [
  { id: 'openai-custom', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', wireApi: 'responses', defaultModel: 'gpt-6.2-sol', models: [
    model('gpt-6.2-astra', 'GPT-6.2 Astra', 1050000, true, ['low', 'medium', 'high', 'xhigh', 'max']),
    model('gpt-6.2-sol', 'GPT-6.2 Sol', 1050000, true, ['low', 'medium', 'high', 'xhigh', 'max']),
    model('gpt-6.1-terra', 'GPT-6.1 Terra', 1050000, true, ['none', 'low', 'medium', 'high', 'xhigh', 'max']),
    model('gpt-6-luna', 'GPT-6 Luna', 1050000, true, ['none', 'low', 'medium', 'high', 'xhigh', 'max']),
    model('gpt-5.4', 'GPT-5.4', 1050000, true, ['none', 'low', 'medium', 'high', 'xhigh']),
    model('gpt-5.4-mini', 'GPT-5.4 mini', 400000, true, ['none', 'low', 'medium', 'high', 'xhigh']),
  ] },
  { id: 'deepseek', name: 'DeepSeek', kind: 'deepseek', baseUrl: 'https://api.deepseek.com', wireApi: 'chat', defaultModel: 'deepseek-flash', models: [
    model('deepseek-flash', 'DeepSeek V4.1 Flash', 1000000, true, ['none', 'low', 'medium', 'high', 'xhigh']),
    model('deepseek-v4-pro', 'DeepSeek V4 Pro', 1000000, false, ['none', 'low', 'medium', 'high', 'xhigh']),
  ] },
  { id: 'gemini', name: 'Gemini', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', wireApi: 'chat', defaultModel: 'gemini-4-carbon', models: [
    model('gemini-4-carbon', 'Gemini 4 Carbon', 1048576),
    model('gemini-4-argon', 'Gemini 4 Argon', 1048576),
    model('gemini-4-hydrogen', 'Gemini 4 Hydrogen', 1048576),
    model('gemini-2.5-pro', 'Gemini 2.5 Pro', 1048576),
    model('gemini-2.5-flash', 'Gemini 2.5 Flash', 1048576),
  ] },
  { id: 'anthropic', name: 'Anthropic（OpenAI 兼容网关）', kind: 'custom', baseUrl: 'http://127.0.0.1:4000/v1', wireApi: 'chat', defaultModel: 'claude-sonnet-5-5', models: [
    model('claude-opus-5-5', 'Claude Opus 5.5', 1000000, true, ['low', 'medium', 'high', 'xhigh', 'max']),
    model('claude-sonnet-5-5', 'Claude Sonnet 5.5', 1000000, true, ['low', 'medium', 'high', 'xhigh', 'max']),
    model('claude-haiku-5-5', 'Claude Haiku 5.5', 1000000, true, ['low', 'medium', 'high']),
    model('claude-sonnet-4-6', 'Claude Sonnet 4.6', 1000000, true, ['low', 'medium', 'high']),
  ] },
];

function presetModel(provider, id) {
  const preset = PRESET_PROVIDERS.find(entry => entry.id === provider.id)
    ?? PRESET_PROVIDERS.find(entry => provider.kind !== 'custom' && entry.kind === provider.kind);
  return preset?.models.find(entry => entry.id === id);
}

function modelMetadata(model) {
  const reasoningEfforts = model.reasoningEfforts ?? DEFAULT_REASONING_EFFORTS;
  return { contextWindow: model.contextWindow ?? 200000,
    inputModalities: model.supportsImageInput === false ? ['text'] : ['text', 'image'],
    supportedReasoningEfforts: reasoningEfforts.map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })),
    defaultReasoningEffort: reasoningEfforts.includes('medium') ? 'medium' : reasoningEfforts[0] ?? 'none' };
}

module.exports = { CATALOG_REVISION, PRESET_PROVIDERS, DEFAULT_REASONING_EFFORTS, REASONING_EFFORTS, presetModel, modelMetadata };
