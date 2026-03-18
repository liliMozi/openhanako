/**
 * Settings 共享工具函数
 */
import { useSettingsStore } from './store';
import { hanaFetch } from './api';
import knownModels from '../../../../lib/known-models.json';

const platform = (window as any).platform;

export function t(key: string, params?: Record<string, any>): any {
  return (window as any).t?.(key, params) ?? key;
}

export function escapeHtml(str: string): string {
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
    if ((p.models || []).includes(modelId)) return name;
  }
  return null;
}

function lookupReferenceModelMeta(modelId: string): any {
  if (!modelId) return null;
  const dict = knownModels as Record<string, any>;

  if (dict[modelId]) {
    return { ...dict[modelId], _source: 'reference' };
  }

  const lowerId = modelId.toLowerCase();
  const candidates = Object.entries(dict)
    .filter(([key]) => key !== '_comment' && lowerId.startsWith(key.toLowerCase()))
    .sort((a, b) => b[0].length - a[0].length);

  if (candidates.length === 0) return null;
  return { ...candidates[0][1], _source: 'reference' };
}

export function lookupModelMeta(modelId: string): any {
  const { settingsConfig } = useSettingsStore.getState();
  if (!modelId) return null;
  const reference = lookupReferenceModelMeta(modelId);
  const override = settingsConfig?.models?.overrides?.[modelId];
  if (!reference && !override) return null;
  return {
    ...(reference || {}),
    ...(override || {}),
    _source: override ? 'override' : reference?._source || null,
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

let _saveFavTimer: ReturnType<typeof setTimeout> | null = null;
export function autoSaveModels() {
  if (_saveFavTimer) clearTimeout(_saveFavTimer);
  _saveFavTimer = setTimeout(async () => {
    const store = useSettingsStore.getState();
    try {
      await hanaFetch('/api/favorites', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorites: [...store.pendingFavorites] }),
      });
      store.showToast(t('settings.autoSaved'), 'success');
      platform?.settingsChanged?.('models-changed');
    } catch (err: any) {
      store.showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    }
  }, 300);
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
  { value: 'volcengine', label: 'Volcengine (豆包)', url: 'https://ark.cn-beijing.volces.com/api/v3', api: 'openai-completions' },
  { value: 'moonshot', label: 'Moonshot (Kimi)', url: 'https://api.moonshot.cn/v1', api: 'openai-completions' },
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
  { value: 'openai-codex-responses', label: 'OpenAI Codex Responses' },
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
