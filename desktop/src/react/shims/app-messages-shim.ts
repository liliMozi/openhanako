/**
 * app-messages-shim.ts — 消息加载 / 解析 / Mood / Cron 确认卡片
 *
 * 从 app.js 提取（Phase 4），ctx 注入模式。
 */

import { buildItemsFromHistory } from '../utils/history-builder';
import { useStore } from '../stores';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── i18n helper（全局注入） ──
declare function t(key: string, vars?: Record<string, string>): any;

interface AppMessagesCtx {
  state: Record<string, any>;
  hanaFetch: (path: string, opts?: RequestInit) => Promise<Response>;
  md: { render: (src: string) => string };
  scrollToBottom: () => void;
  renderTodoDisplay: () => void;
  escapeHtml: (s: string) => string;
  injectCopyButtons: (el: HTMLElement) => void;
  _cr: () => Record<string, any>;
  _fc: () => Record<string, any>;
  _ar: () => Record<string, any>;
}

let ctx: AppMessagesCtx;

// ── Mood 工具函数 ──

const TAG_TO_YUAN: Record<string, string> = { mood: 'hanako', pulse: 'butter', reflect: 'ming' };
const YUAN_LABELS: Record<string, string> = { hanako: '✿ MOOD', butter: '❊ PULSE', ming: '◈ REFLECT' };

function moodLabel(yuan: string): string {
  return YUAN_LABELS[yuan] || YUAN_LABELS.hanako;
}

function cleanMoodText(raw: string): string {
  return raw
    .replace(/^```\w*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

function parseMoodFromContent(content: string): { mood: string | null; yuan: string | null; text: string } {
  if (!content) return { mood: null, yuan: null, text: '' };
  const moodRe = /<(mood|pulse|reflect)>([\s\S]*?)<\/(?:mood|pulse|reflect)>/;
  const match = content.match(moodRe);
  if (!match) return { mood: null, yuan: null, text: content };
  const yuan = TAG_TO_YUAN[match[1]] || 'hanako';
  const mood = cleanMoodText(match[2].trim());
  const text = content.replace(moodRe, '').replace(/^\n+/, '').trim();
  return { mood, yuan, text };
}

// ── Xing 反省解析 ──

interface ParsedXing { title: string; content: string }

function parseXingFromContent(text: string): { xingBlocks: ParsedXing[]; text: string } {
  const xingRe = /<xing\s+title=["\u201C\u201D]([^"\u201C\u201D]*)["\u201C\u201D]>([\s\S]*?)<\/xing>/g;
  const blocks: ParsedXing[] = [];
  let match;
  while ((match = xingRe.exec(text)) !== null) {
    blocks.push({ title: match[1], content: match[2].trim() });
  }
  const remaining = text.replace(xingRe, '').replace(/^\n+/, '').trim();
  return { xingBlocks: blocks, text: remaining };
}

// ── Cron 确认卡片 ──

function getCronTypeLabel(type: string): string {
  const t = (window as any).t;
  const map: Record<string, string> = {
    at: t?.('cron.typeAt') ?? 'Once',
    every: t?.('cron.typeEvery') ?? 'Interval',
    cron: t?.('cron.typeCron') ?? 'Scheduled',
  };
  return map[type] || type;
}

function formatSchedule(type: string, schedule: string | number): string {
  const locale = (window as any).i18n?.locale === 'en' ? 'en-US' : 'zh-CN';
  if (type === 'at') return new Date(schedule).toLocaleString(locale, { hour12: false });
  if (type === 'every') {
    const ms = Number(schedule);
    if (ms >= 3600000) return `${Math.round(ms / 3600000)}h`;
    if (ms >= 60000) return `${Math.round(ms / 60000)}min`;
    return `${ms}ms`;
  }
  return String(schedule);
}

function appendCronConfirmCard(jobData: any): void {
  const { state, hanaFetch } = ctx;

  const card = document.createElement('div');
  card.className = 'cron-confirm-card';

  const title = document.createElement('div');
  title.className = 'cron-confirm-title';
  title.textContent = jobData.label || jobData.prompt.slice(0, 40);
  card.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'cron-confirm-meta';
  meta.textContent = `${getCronTypeLabel(jobData.type)}  ·  ${formatSchedule(jobData.type, jobData.schedule)}`;
  card.appendChild(meta);

  if (jobData.prompt && jobData.prompt.length > 0) {
    const prompt = document.createElement('div');
    prompt.className = 'cron-confirm-prompt';
    prompt.textContent = jobData.prompt.length > 60 ? jobData.prompt.slice(0, 60) + '…' : jobData.prompt;
    card.appendChild(prompt);
  }

  const actions = document.createElement('div');
  actions.className = 'cron-confirm-actions';

  const approveBtn = document.createElement('button');
  approveBtn.className = 'cron-confirm-btn approve';
  approveBtn.textContent = t('cron.confirm.approve');

  const rejectBtn = document.createElement('button');
  rejectBtn.className = 'cron-confirm-btn reject';
  rejectBtn.textContent = t('cron.confirm.reject');

  actions.appendChild(approveBtn);
  actions.appendChild(rejectBtn);
  card.appendChild(actions);

  approveBtn.addEventListener('click', async () => {
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    try {
      const res = await hanaFetch('/api/desk/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', ...jobData }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      actions.remove();
      const status = document.createElement('div');
      status.className = 'cron-confirm-status approved';
      status.textContent = t('cron.confirm.created');
      card.appendChild(status);
    } catch (err) {
      approveBtn.disabled = false;
      rejectBtn.disabled = false;
      console.error('[cron] confirm failed:', err);
    }
  });

  rejectBtn.addEventListener('click', () => {
    actions.remove();
    const status = document.createElement('div');
    status.className = 'cron-confirm-status rejected';
    status.textContent = t('cron.confirm.rejected');
    card.appendChild(status);
  });

  state.currentAssistantEl.appendChild(card);
}

// ── 用户附件解析 ──

interface ParsedAttachments {
  text: string;
  files: Array<{ path: string; name: string; isDirectory: boolean }>;
  deskContext: { dir: string; fileCount: number } | null;
}

function parseUserAttachments(content: string): ParsedAttachments {
  if (!content) return { text: '', files: [], deskContext: null };
  const lines = content.split('\n');
  const textLines: string[] = [];
  const files: Array<{ path: string; name: string; isDirectory: boolean }> = [];
  const attachRe = /^\[(附件|目录)\]\s+(.+)$/;
  let deskContext: { dir: string; fileCount: number } | null = null;
  let inDeskBlock = false;

  for (const line of lines) {
    const deskMatch = line.match(/^\[当前书桌目录\]\s+(.+)$/);
    if (deskMatch) {
      inDeskBlock = true;
      deskContext = { dir: deskMatch[1].trim(), fileCount: 0 };
      continue;
    }
    if (inDeskBlock) {
      if (line.startsWith('  ') || line.startsWith('...')) {
        if (line.startsWith('  ')) deskContext!.fileCount++;
        continue;
      }
      inDeskBlock = false;
    }

    const m = line.match(attachRe);
    if (m) {
      const isDir = m[1] === '目录';
      const p = m[2].trim();
      const name = p.split('/').pop() || p;
      files.push({ path: p, name, isDirectory: isDir });
    } else {
      textLines.push(line);
    }
  }
  const text = textLines.join('\n').replace(/\n+$/, '').trim();
  return { text, files, deskContext };
}

// ── 消息历史加载 ──

async function loadMessages(): Promise<void> {
  const { state, hanaFetch, renderTodoDisplay } = ctx;

  try {
    const res = await hanaFetch('/api/sessions/messages');
    const data = await res.json();
    if (data.todos && data.todos.length > 0) {
      state.sessionTodos = data.todos;
      renderTodoDisplay();
    }
    const items = buildItemsFromHistory(data);
    const sessionPath = state.currentSessionPath;
    if (sessionPath && items.length > 0) {
      useStore.getState().initSession(sessionPath, items, data.hasMore ?? false);
      state.welcomeVisible = false;
    } else if (sessionPath) {
      // 即使没有消息也初始化空 session，防止反复 fetch
      useStore.getState().initSession(sessionPath, [], false);
    }
  } catch (err) { console.error('[loadMessages] error:', err); }
}

// ── Setup ──

export function setupAppMessagesShim(modules: Record<string, unknown>): void {
  modules.appMessages = {
    // Mood 工具
    cleanMoodText,
    moodLabel,
    parseMoodFromContent,
    parseXingFromContent,
    // Cron
    appendCronConfirmCard,
    // 消息
    parseUserAttachments,
    loadMessages,
    // ctx 注入
    initAppMessages: (injected: AppMessagesCtx) => { ctx = injected; },
  };
}
