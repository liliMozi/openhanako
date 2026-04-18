/**
 * Settings 共享工具函数
 */
import { useSettingsStore } from './store';
import { hanaFetch } from './api';
import knownModels from '../../../../lib/known-models.json';

const platform = window.platform;

export function t(key: string, params?: Record<string, any>): any {
  return window.t?.(key, params) ?? key;
}

export function escapeHtml(str: string): string {
  // eslint-disable-next-line no-restricted-syntax -- escapeHtml utility, not React rendering
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function formatContext(n: number): string {
  if (!n) return '';
  if (n >= 1000000) {
    const m = n / 1000000;
    return (Number.isInteger(m) ? m : +m.toFixed(1)) + 'M';
  }
  const k = n / 1024;
  if (Number.isInteger(k)) return k + 'K';
  return Math.round(n / 1000) + 'K';
}

export function resolveProviderForModel(modelId: string): string | null {
  const config = useSettingsStore.getState().settingsConfig;
  if (!modelId || !config) return null;
  const providers = config.providers || {};
  for (const [name, p] of Object.entries(providers) as [string, any][]) {
    if ((p.models || []).some((m: any) => (typeof m === 'object' ? m.id : m) === modelId)) return name;
  }
  return null;
}

function lookupReferenceModelMeta(modelId: string): any {
  if (!modelId) return null;
  const dict = knownModels as Record<string, any>;
  const bare = modelId.includes('/') ? modelId.split('/').pop()! : null;

  // 二级查找：遍历所有 provider，精确匹配 modelId 或 bare name
  for (const [key, val] of Object.entries(dict)) {
    if (key === '_comment' || typeof val !== 'object' || val === null) continue;
    if (val[modelId]) return { ...val[modelId], _source: 'reference' };
    if (bare && val[bare]) return { ...val[bare], _source: 'reference' };
  }

  return null;
}

export function lookupModelMeta(modelId: string): any {
  if (!modelId) return null;
  const reference = lookupReferenceModelMeta(modelId);

  // 从 provider summaries 提取用户在 added-models.yaml 中设置的模型元数据
  const { providersSummary, settingsConfig } = useSettingsStore.getState();
  let userEntry: Record<string, any> | null = null;
  if (providersSummary) {
    for (const summary of Object.values(providersSummary)) {
      const found = (summary.models || []).find(
        (m: any) => typeof m === 'object' && m?.id === modelId,
      );
      if (found) { userEntry = found as unknown as Record<string, any>; break; }
    }
  }

  // 兼容旧数据：仍然读 config.models.overrides 的 displayName
  const legacyOverride = settingsConfig?.models?.overrides?.[modelId];

  if (!reference && !userEntry && !legacyOverride) return null;
  return {
    ...(reference || {}),
    ...(userEntry || {}),
    ...(legacyOverride?.displayName ? { displayName: legacyOverride.displayName } : {}),
  };
}

/** 通用 per-agent 自动保存 */
export async function autoSaveConfig(
  partial: Record<string, any>,
  opts: { silent?: boolean; refreshModels?: boolean } = {},
) {
  const store = useSettingsStore.getState();
  try {
    const agentId = store.getSettingsAgentId();
    const res = await hanaFetch(`/api/agents/${agentId}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (!opts.silent) store.showToast(t('settings.autoSaved'), 'success');
    // 刷新 config 快照，保留 _identity / _ishiki / _userProfile
    const cfgRes = await hanaFetch(`/api/agents/${agentId}/config`);
    const newConfig = await cfgRes.json();
    const prev = useSettingsStore.getState().settingsConfig || {};
    for (const k of ['_identity', '_ishiki', '_userProfile']) {
      if (k in prev && !(k in newConfig)) newConfig[k] = (prev as any)[k];
    }
    useSettingsStore.setState({ settingsConfig: newConfig });
    if (opts.refreshModels) platform?.settingsChanged?.('models-changed');
  } catch (err: any) {
    store.showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
  }
}

/** 全局模型自动保存 */
export async function autoSaveGlobalModels(
  partial: Record<string, any>,
  opts: { silent?: boolean } = {},
) {
  const store = useSettingsStore.getState();
  try {
    const res = await hanaFetch('/api/preferences/models', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (!opts.silent) store.showToast(t('settings.autoSaved'), 'success');
    const refreshRes = await hanaFetch('/api/preferences/models');
    const newGlobal = await refreshRes.json();
    useSettingsStore.setState({ globalModelsConfig: newGlobal });
  } catch (err: any) {
    store.showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
  }
}

let _savePinsTimer: ReturnType<typeof setTimeout> | null = null;
export function savePins() {
  if (_savePinsTimer) clearTimeout(_savePinsTimer);
  _savePinsTimer = setTimeout(async () => {
    const store = useSettingsStore.getState();
    try {
      const agentId = store.getSettingsAgentId();
      const res = await hanaFetch(`/api/agents/${agentId}/pinned`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pins: store.currentPins }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      store.showToast(t('settings.autoSaved'), 'success');
    } catch (err: any) {
      store.showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    }
  }, 300);
}

export const PROVIDER_PRESETS = [
  { value: 'ollama', label: 'Ollama (Local)', url: 'http://localhost:11434/v1', api: 'openai-completions', local: true },
  { value: 'dashscope', label: 'DashScope (Qwen)', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api: 'openai-completions' },
  { value: 'openai', label: 'OpenAI', url: 'https://api.openai.com/v1', api: 'openai-completions' },
  { value: 'deepseek', label: 'DeepSeek', url: 'https://api.deepseek.com/v1', api: 'openai-completions' },
  { value: 'volcengine', label: (window.i18n?.locale?.startsWith?.('zh') ? 'Volcengine (豆包)' : 'Volcengine (Doubao)'), url: 'https://ark.cn-beijing.volces.com/api/v3', api: 'openai-completions' },
  { value: 'moonshot', label: 'Moonshot (Kimi)', url: 'https://api.moonshot.cn/v1', api: 'openai-completions' },
  { value: 'kimi-coding', label: 'Kimi Coding Plan', url: 'https://api.kimi.com/coding/', api: 'anthropic-messages' },
  { value: 'zhipu', label: 'Zhipu (GLM)', url: 'https://open.bigmodel.cn/api/paas/v4', api: 'openai-completions' },
  { value: 'siliconflow', label: 'SiliconFlow', url: 'https://api.siliconflow.cn/v1', api: 'openai-completions' },
  { value: 'groq', label: 'Groq', url: 'https://api.groq.com/openai/v1', api: 'openai-completions' },
  { value: 'mistral', label: 'Mistral', url: 'https://api.mistral.ai/v1', api: 'openai-completions' },
  { value: 'minimax', label: 'MiniMax', url: 'https://api.minimaxi.com/anthropic', api: 'anthropic-messages' },
  { value: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/api/v1', api: 'openai-completions' },
  { value: 'mimo', label: 'Xiaomi (MiMo)', url: 'https://api.xiaomimimo.com/v1', api: 'openai-completions' },
];

export const API_FORMAT_OPTIONS = [
  { value: 'openai-completions', label: 'OpenAI Compatible' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'openai-codex-responses', label: 'ChatGPT Codex (Plus/Pro)' },
];

export const CONTEXT_PRESETS = [
  { label: '64K', value: 65536 },
  { label: '128K', value: 131072 },
  { label: '200K', value: 200000 },
  { label: '256K', value: 262144 },
  { label: '1M', value: 1048576 },
];

export const OUTPUT_PRESETS = [
  { label: '8K', value: 8192 },
  { label: '16K', value: 16384 },
  { label: '32K', value: 32768 },
  { label: '64K', value: 65536 },
];

export const VALID_THEMES = ['warm-paper', 'midnight', 'auto', 'high-contrast', 'grass-aroma', 'contemplation', 'absolutely', 'delve', 'deep-think'];
