/**
 * slash-commands.ts — 斜杠命令定义和执行逻辑
 *
 * 从 InputArea.tsx 提取，减少主组件体量。
 */

import { hanaFetch } from '../../hooks/use-hana-fetch';
import { getWebSocket } from '../../services/websocket';
import { useStore } from '../../stores';

// ── Xing Prompt ──

const isZh = window.i18n?.locale?.startsWith?.('zh') ?? true;

export const XING_PROMPT = isZh
  ? `回顾本次对话中我（用户）发送的消息，提取可复用的工作流程、偏好和纠正。

你必须先查阅 skill-creator 技能，按照其中 "Capture Intent" 和 "Write the SKILL.md" 部分的流程操作。
只做到创建并安装为止，不需要做 eval、benchmark 或 description optimization。

最终调用 install_skill 工具将技能安装为自学技能（skill_content + skill_name 模式）。`
  : `Review the messages I (the user) sent in this session and extract reusable workflows, preferences, and corrections.

You must first consult the skill-creator skill, following its "Capture Intent" and "Write the SKILL.md" sections.
Only go as far as creating and installing — do not run evals, benchmarks, or description optimization.

Use the install_skill tool to install the skill as a learned skill (skill_content + skill_name mode).`;

// ── Slash Command Interface ──

export interface SlashItem {
  name: string;
  label: string;
  description: string;
  busyLabel: string;
  icon: string;
  type: 'builtin' | 'skill';
  execute: () => Promise<void> | void;
}

export const MAX_SLASH_TRIGGER_LENGTH = 20;

export function getSlashMatches(text: string, commands: SlashItem[]): SlashItem[] {
  const normalized = text.trim();
  if (!normalized.startsWith('/') || normalized.length > MAX_SLASH_TRIGGER_LENGTH) return [];
  const query = normalized.slice(1).toLowerCase();
  return commands.filter(command => command.name.startsWith(query));
}

export function resolveSlashSubmitSelection({
  text,
  skills,
  commands,
  selectedIndex,
  dismissedText,
}: {
  text: string;
  skills: string[];
  commands: SlashItem[];
  selectedIndex: number;
  dismissedText: string | null;
}): SlashItem | null {
  if (skills.length > 0) return null;
  const matches = getSlashMatches(text, commands);
  if (matches.length === 0) return null;
  if (dismissedText === text.trim()) return null;
  return matches[selectedIndex] || matches[0] || null;
}

// ── Command Executors ──

export function executeDiary(
  t: (key: string) => string,
  showResult: (text: string, type: 'success' | 'error') => void,
  setBusy: (name: string | null) => void,
  setInput: (text: string) => void,
  setMenuOpen: (open: boolean) => void,
): () => Promise<void> {
  return async () => {
    setBusy('diary');
    setInput('');
    setMenuOpen(false);
    try {
      const res = await hanaFetch('/api/diary/write', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.error) {
        showResult(data.error || t('slash.diaryFailed'), 'error');
        return;
      }
      showResult(t('slash.diaryDone'), 'success');
    } catch {
      showResult(t('slash.diaryFailed'), 'error');
    }
  };
}

export function executeCompact(
  setBusy: (name: string | null) => void,
  setInput: (text: string) => void,
  setMenuOpen: (open: boolean) => void,
): () => Promise<void> {
  return async () => {
    setBusy('compact');
    setInput('');
    setMenuOpen(false);
    try {
      const ws = getWebSocket();
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'compact', sessionPath: useStore.getState().currentSessionPath }));
      }
    } finally {
      setTimeout(() => setBusy(null), 1500);
    }
  };
}

export function buildSlashCommands(
  t: (key: string) => string,
  executeDiaryFn: () => Promise<void>,
  executeXingFn: () => Promise<void>,
  executeCompactFn: () => Promise<void>,
): SlashItem[] {
  return [
    {
      name: 'diary',
      label: '/diary',
      description: t('slash.diary'),
      busyLabel: t('slash.diaryBusy'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
      type: 'builtin',
      execute: executeDiaryFn,
    },
    {
      name: 'xing',
      label: '/xing',
      description: t('slash.xing'),
      busyLabel: '',
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/></svg>',
      type: 'builtin',
      execute: executeXingFn,
    },
    {
      name: 'compact',
      label: '/compact',
      description: t('slash.compact'),
      busyLabel: t('slash.compactBusy'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
      type: 'builtin',
      execute: executeCompactFn,
    },
  ];
}
