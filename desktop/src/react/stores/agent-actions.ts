/**
 * agent-actions.ts — Agent CRUD / 身份同步 / 头像
 *
 * 从 app-agents-shim.ts 迁移。直接操作 Zustand store，
 * 不依赖 ctx 注入。
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- API 响应 JSON + Record<string, any> patch 对象 */

import { useStore } from './index';
import { hanaFetch, hanaUrl } from '../hooks/use-hana-fetch';
import { closePreview, clearOwnerPreview } from './artifact-actions';
import { getPreviewOwner } from './artifact-slice';

declare function t(key: string, vars?: Record<string, string>): any;
declare const i18n: { defaultName: string };

// ── clearChat ──

export function clearChat(): void {
  const s = useStore.getState();

  const sessionPath = s.currentSessionPath;
  if (sessionPath) {
    s.clearSession?.(sessionPath);
  }

  // 清除当前 owner 的预览状态
  clearOwnerPreview(getPreviewOwner(s));

  useStore.setState({
    welcomeVisible: true,
    memoryEnabled: true,
    sessionTodos: [],
  });

  if (s.previewOpen) closePreview();
}

// ── Agent 身份同步 ──

export async function applyAgentIdentity(opts: any = {}): Promise<void> {
  const { agentName, agentId, userName, ui = {} } = opts;

  const patch: Record<string, any> = {};
  if (agentName !== undefined) patch.agentName = agentName;
  if (agentId !== undefined) patch.currentAgentId = agentId;
  if (userName !== undefined) patch.userName = userName;
  if (opts.yuan !== undefined) patch.agentYuan = opts.yuan;
  if (Object.keys(patch).length > 0) useStore.setState(patch);

  i18n.defaultName = patch.agentName ?? useStore.getState().agentName;

  const { avatars = true, agents = true } = ui;

  const tasks: Promise<any>[] = [];
  if (avatars) {
    tasks.push(
      hanaFetch('/api/health').then(r => r.json()).then(d => loadAvatars(d.avatars)).catch(() => loadAvatars()),
    );
  }
  if (agents) tasks.push(loadAgents());
  await Promise.all(tasks);
}

// ── Agent 加载 ──

export async function loadAgents(): Promise<void> {
  try {
    const res = await hanaFetch('/api/agents');
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const agents = data.agents || [];
    const s = useStore.getState();

    const patch: Record<string, any> = { agents };
    if (!s.currentAgentId) {
      const primary = agents.find((a: any) => a.isPrimary) || agents[0];
      if (primary) patch.currentAgentId = primary.id;
    }

    const currentId = patch.currentAgentId ?? s.currentAgentId;
    const currentAgent = agents.find((a: any) => a.id === currentId);
    if (currentAgent?.yuan) patch.agentYuan = currentAgent.yuan;
    if (currentAgent?.name) patch.agentName = currentAgent.name;

    useStore.setState(patch);
  } catch (err) {
    console.error('[agents] load failed:', err);
  }
}

// ── 头像 ──

export function loadAvatars(avatarsInfo?: Record<string, boolean>): void {
  const ts = Date.now();
  const patch: Record<string, any> = {};

  for (const role of ['agent', 'user'] as const) {
    const hasAvatar = avatarsInfo?.[role] ?? false;
    if (hasAvatar) {
      const url = hanaUrl(`/api/avatar/${role}?t=${ts}`);
      if (role === 'agent') patch.agentAvatarUrl = url;
      else patch.userAvatarUrl = url;
    } else {
      if (role === 'agent') patch.agentAvatarUrl = null;
      else patch.userAvatarUrl = null;
    }
  }

  useStore.setState(patch);
}
