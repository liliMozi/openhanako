/**
 * message-parser.ts — 消息解析工具函数
 *
 * 从 app-messages-shim.ts 和 chat-render-shim.ts 提取，
 * 供 React 组件和 history-builder 共用。
 */

// ── Mood 解析 ──

const TAG_TO_YUAN: Record<string, string> = { mood: 'hanako', pulse: 'butter', reflect: 'ming' };
const YUAN_LABELS: Record<string, string> = { hanako: '✿ MOOD', butter: '❊ PULSE', ming: '◈ REFLECT' };

export function moodLabel(yuan: string): string {
  return YUAN_LABELS[yuan] || YUAN_LABELS.hanako;
}

export function cleanMoodText(raw: string): string {
  return raw
    .replace(/^```\w*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

export function parseMoodFromContent(content: string): { mood: string | null; yuan: string | null; text: string } {
  if (!content) return { mood: null, yuan: null, text: '' };
  const moodRe = /<(mood|pulse|reflect)>([\s\S]*?)<\/(?:mood|pulse|reflect)>/;
  const match = content.match(moodRe);
  if (!match) return { mood: null, yuan: null, text: content };
  const yuan = TAG_TO_YUAN[match[1]] || 'hanako';
  const mood = cleanMoodText(match[2].trim());
  const text = content.replace(moodRe, '').replace(/^\n+/, '').trim();
  return { mood, yuan, text };
}

// ── 用户附件解析 ──

export interface ParsedAttachments {
  text: string;
  files: Array<{ path: string; name: string; isDirectory: boolean }>;
  deskContext: { dir: string; fileCount: number } | null;
  quotedText: string | null;
}

export function parseUserAttachments(content: string): ParsedAttachments {
  if (!content) return { text: '', files: [], deskContext: null, quotedText: null };
  const lines = content.split('\n');
  const textLines: string[] = [];
  const files: Array<{ path: string; name: string; isDirectory: boolean }> = [];
  const attachRe = /^\[(附件|目录|参考文档)\]\s+(.+)$/;
  let deskContext: { dir: string; fileCount: number } | null = null;
  let quotedText: string | null = null;
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

    const quoteMatch = line.match(/^\[引用片段\]\s+(.+)$/);
    if (quoteMatch) {
      const raw = quoteMatch[1];
      const titleMatch = raw.match(/^(.+?)（第\d/);
      quotedText = titleMatch ? titleMatch[1].trim() : raw.trim();
      continue;
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
  return { text, files, deskContext, quotedText };
}

// ── 工具详情提取 ──

export function truncatePath(p: string): string {
  if (!p || p.length <= 35) return p;
  return '…' + p.slice(-34);
}

export function extractHostname(u: string): string {
  if (!u) return '';
  try { return new URL(u).hostname; } catch { return u; }
}

export function truncateHead(s: string, max: number): string {
  if (!s || s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export interface ToolDetail {
  text: string;
  /** 文件路径或 URL，存在时 ToolIndicator 渲染为可点击链接 */
  href?: string;
  /** 'file' 用 openFile，'url' 用 openExternal */
  hrefType?: 'file' | 'url';
}

export function extractToolDetail(name: string, args: Record<string, unknown> | undefined): ToolDetail {
  if (!args) return { text: '' };
  switch (name) {
    case 'read':
    case 'write':
    case 'edit':
    case 'edit-diff': {
      const p = (args.file_path || args.path || '') as string;
      return { text: truncatePath(p), href: p || undefined, hrefType: 'file' };
    }
    case 'bash':
      return { text: truncateHead((args.command || '') as string, 40) };
    case 'glob':
    case 'find':
      return { text: (args.pattern || '') as string };
    case 'grep':
      return { text: truncateHead((args.pattern || '') as string, 30) +
        (args.path ? ` in ${truncatePath(args.path as string)}` : '') };
    case 'ls': {
      const p = (args.path || '') as string;
      return { text: truncatePath(p), href: p || undefined, hrefType: 'file' };
    }
    case 'web_fetch': {
      const url = (args.url || '') as string;
      return { text: extractHostname(url), href: url || undefined, hrefType: 'url' };
    }
    case 'web_search':
      return { text: truncateHead((args.query || '') as string, 40) };
    case 'browser': {
      const url = (args.url || '') as string;
      return { text: extractHostname(url), href: url || undefined, hrefType: 'url' };
    }
    case 'search_memory':
      return { text: truncateHead((args.query || '') as string, 40) };
    case 'subagent':
      return { text: truncateHead((args.task || '') as string, 30) };
    case 'wait':
      return { text: `${args.seconds || '?'}s` };
    case 'dm':
      return { text: (args.to || '') as string };
    case 'channel':
      return { text: (args.channel || args.name || '') as string };
    case 'cron':
      return { text: truncateHead((args.label || args.prompt || '') as string, 30) };
    case 'notify':
      return { text: truncateHead((args.title || '') as string, 30) };
    case 'artifact':
      return { text: truncateHead((args.title || '') as string, 30) };
    case 'install_skill':
      return { text: (args.skill_name || '') as string };
    case 'update_settings':
      return { text: (args.key || args.setting || '') as string };
    default: {
      // 插件工具：取第一个有意义的字符串参数作详情
      const first = Object.values(args).find(v => typeof v === 'string' && v.length > 0);
      return { text: first ? truncateHead(first as string, 30) : '' };
    }
  }
}

// ── Card 解析 ──

export interface ParsedCard {
  type: string;
  pluginId: string;
  route: string;
  title?: string;
  description: string;
}

export function parseCardFromContent(text: string | null | undefined): { cards: ParsedCard[]; text: string } {
  if (!text) return { cards: [], text: '' };
  const cards: ParsedCard[] = [];
  const fullRe = /<card((?:\s+[\w-]+="[^"]*")*)\s*>([\s\S]*?)<\/card>/g;
  let match;
  while ((match = fullRe.exec(text)) !== null) {
    const attrStr = match[1];
    const body = match[2].trim();
    const attrs: Record<string, string> = {};
    const attrRe = /([\w-]+)="([^"]*)"/g;
    let am;
    while ((am = attrRe.exec(attrStr)) !== null) {
      attrs[am[1]] = am[2];
    }
    cards.push({
      type: attrs.type || 'iframe',
      pluginId: attrs.plugin || '',
      route: attrs.route || '',
      title: attrs.title || undefined,
      description: body,
    });
  }

  const stripRe = /<card(?:\s+[\w-]+="[^"]*")*\s*>[\s\S]*?<\/card>/g;
  const remaining = text.replace(stripRe, '').replace(/^\n+/, '').trim();
  return { cards, text: remaining };
}
