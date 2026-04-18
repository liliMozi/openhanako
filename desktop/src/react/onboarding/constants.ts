/**
 * constants.ts — Onboarding wizard constants
 */

export const AGENT_ID = 'hanako';
export const TOTAL_STEPS = 6;

export const LOCALES = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'ja',    label: '日本語' },
  { value: 'ko',    label: '한국어' },
  { value: 'en',    label: 'English' },
] as const;

export interface ProviderPreset {
  value: string;
  label: string;
  labelZh?: string;
  url: string;
  api: string;
  local?: boolean;
  custom?: boolean;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { value: 'ollama',      label: 'Ollama (Local)',       labelZh: 'Ollama (本地)',       url: 'http://localhost:11434/v1', api: 'openai-completions', local: true },
  { value: 'dashscope',   label: 'DashScope (Qwen)',     url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api: 'openai-completions' },
  { value: 'openai',      label: 'OpenAI',               url: 'https://api.openai.com/v1', api: 'openai-completions' },
  { value: 'deepseek',    label: 'DeepSeek',             url: 'https://api.deepseek.com/v1', api: 'openai-completions' },
  { value: 'volcengine',  label: 'Volcengine (Doubao)',   labelZh: 'Volcengine (豆包)',   url: 'https://ark.cn-beijing.volces.com/api/v3', api: 'openai-completions' },
  { value: 'moonshot',    label: 'Moonshot (Kimi)',      url: 'https://api.moonshot.cn/v1', api: 'openai-completions' },
  { value: 'zhipu',       label: 'Zhipu (GLM)',          url: 'https://open.bigmodel.cn/api/paas/v4', api: 'openai-completions' },
  { value: 'siliconflow', label: 'SiliconFlow',          url: 'https://api.siliconflow.cn/v1', api: 'openai-completions' },
  { value: 'groq',        label: 'Groq',                 url: 'https://api.groq.com/openai/v1', api: 'openai-completions' },
  { value: 'mistral',     label: 'Mistral',              url: 'https://api.mistral.ai/v1', api: 'openai-completions' },
  { value: 'minimax',     label: 'MiniMax',              url: 'https://api.minimaxi.com/anthropic', api: 'anthropic-messages' },
  { value: '_custom',     label: '',                     url: '',  api: 'openai-completions', custom: true },
];

export const OB_THEMES = [
  'warm-paper', 'midnight', 'auto', 'high-contrast', 'grass-aroma',
  'contemplation', 'absolutely', 'delve', 'deep-think',
] as const;

export function themeKey(id: string): string {
  return id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}
