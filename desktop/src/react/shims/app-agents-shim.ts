/**
 * app-agents-shim.ts — Agent 身份 / 头像 / 欢迎词 / clearChat
 *
 * 从 app.js 提取（Phase 4），ctx 注入模式。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

declare function t(key: string, vars?: Record<string, string>): any;
declare const i18n: { defaultName: string };

interface AppAgentsCtx {
  state: Record<string, any>;
  hanaFetch: (path: string, opts?: RequestInit) => Promise<Response>;
  hanaUrl: (path: string) => string;
  messagesEl: HTMLElement;
  renderTodoDisplay: () => void;
  resetScroll: () => void;
  _cr: () => Record<string, any>;
  _ar: () => Record<string, any>;
}

let ctx: AppAgentsCtx;

// ── Yuan 辅助 ──

function yuanFallbackAvatar(yuan: string): string {
  const types = t('yuan.types') || {};
  const entry = types[yuan || 'hanako'];
  return `assets/${entry?.avatar || 'Hanako.png'}`;
}

function randomWelcome(agentName?: string, yuan?: string): string {
  const name = agentName || ctx.state.agentName;
  const y = yuan || ctx.state.agentYuan;
  const yuanMsgs = t(`yuan.welcome.${y}`);
  const msgs = Array.isArray(yuanMsgs) ? yuanMsgs : t('welcome.messages');
  if (!Array.isArray(msgs) || msgs.length === 0) return '';
  const raw = msgs[Math.floor(Math.random() * msgs.length)];
  return raw.replaceAll('{name}', name);
}

function yuanPlaceholder(yuan?: string): string {
  const y = yuan || ctx.state.agentYuan;
  const yuanPh = t(`yuan.placeholder.${y}`);
  return (yuanPh && !yuanPh.startsWith('yuan.')) ? yuanPh : t('input.placeholder');
}

// ── 欢迎页 Agent 选择器（React WelcomeScreen 负责渲染） ──

function renderWelcomeAgentSelector(): void { /* React 负责 */ }

// ── clearChat ──

function clearChat(): void {
  const { state, messagesEl, renderTodoDisplay, resetScroll } = ctx;

  // 清 store 数据，DOM 由 React 管理
  const sessionPath = state.currentSessionPath;
  if (sessionPath) {
    (window as any).__zustandStore?.getState()?.clearSession?.(sessionPath);
  }

  state.welcomeVisible = true;
  state.memoryEnabled = true;
  state.sessionTodos = [];
  state.artifacts = [];
  if (state.previewOpen) ctx._ar().closePreview();
  renderTodoDisplay();
}

// ── Agent 身份同步 ──

async function applyAgentIdentity(opts: any = {}): Promise<void> {
  const { state } = ctx;
  const { agentName, agentId, userName, ui = {} } = opts;

  if (agentName !== undefined) state.agentName = agentName;
  if (agentId !== undefined) state.currentAgentId = agentId;
  if (userName !== undefined) state.userName = userName;
  if (opts.yuan !== undefined) state.agentYuan = opts.yuan;

  i18n.defaultName = state.agentName;

  const { avatars = true, agents = true } = ui;

  const tasks: Promise<void>[] = [];
  if (avatars) tasks.push(loadAvatars());
  if (agents) tasks.push(loadAgents());
  await Promise.all(tasks);

  // 刷新已渲染的助手头像
  const newAvatar = state.agentAvatarUrl || yuanFallbackAvatar(state.agentYuan);
  document.querySelectorAll<HTMLImageElement>('.hana-avatar').forEach(img => {
    img.src = newAvatar;
  });
}

// ── Agent 加载 ──

async function loadAgents(): Promise<void> {
  const { state, hanaFetch } = ctx;
  try {
    const res = await hanaFetch('/api/agents');
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    state.agents = data.agents || [];
    if (!state.currentAgentId) {
      const primary = state.agents.find((a: any) => a.isPrimary) || state.agents[0];
      if (primary) state.currentAgentId = primary.id;
    }
    const currentAgent = state.agents.find((a: any) => a.id === state.currentAgentId);
    if (currentAgent?.yuan) state.agentYuan = currentAgent.yuan;
    if (currentAgent?.name) state.agentName = currentAgent.name;
  } catch (err) {
    console.error('[agents] load failed:', err);
  }
}

// ── 头像 ──

async function loadAvatars(): Promise<void> {
  const { state, hanaFetch, hanaUrl } = ctx;
  const ts = Date.now();
  for (const role of ['agent', 'user']) {
    try {
      const res = await hanaFetch(`/api/avatar/${role}`, { method: 'HEAD' });
      if (res.ok) {
        const url = hanaUrl(`/api/avatar/${role}?t=${ts}`);
        if (role === 'agent') state.agentAvatarUrl = url;
        else state.userAvatarUrl = url;
      } else {
        // 当前 agent / user 没有自定义头像，清除 stale URL（防止切换 agent 后残留旧头像）
        if (role === 'agent') state.agentAvatarUrl = null;
        else state.userAvatarUrl = null;
      }
    } catch {
      if (role === 'agent') state.agentAvatarUrl = null;
      else state.userAvatarUrl = null;
    }
  }
  // Welcome avatar 由 React WelcomeScreen 响应 agentAvatarUrl 变化自动更新
}

// ── Setup ──

export function setupAppAgentsShim(modules: Record<string, unknown>): void {
  modules.appAgents = {
    yuanFallbackAvatar,
    randomWelcome,
    yuanPlaceholder,
    renderWelcomeAgentSelector,
    clearChat,
    applyAgentIdentity,
    loadAgents,
    loadAvatars,
    initAppAgents: (injected: AppAgentsCtx) => { ctx = injected; },
  };
}
