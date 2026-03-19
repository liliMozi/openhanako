/**
 * chat-render-shim.ts — 消息渲染系统
 *
 * 消息组管理、用户/助手消息 DOM、思考块、工具调用折叠组。
 * 纯命令式 DOM 操作，流式传输高频调用，保持命令式。
 * 从 bridge.ts 提取（Phase 6D）。
 */

import { useStore } from '../stores';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface ChatRenderCtx {
  state: Record<string, unknown>;
  messagesEl: HTMLElement;
  md: { render: (src: string) => string };
  scrollToBottom: () => void;
  getToolLabel: (name: string, phase: string) => string;
  yuanFallbackAvatar: (yuan: string) => string;
}

let crCtx: ChatRenderCtx | null = null;
function crState(): Record<string, unknown> { return crCtx!.state; }

let thinkingEl: HTMLDetailsElement | null = null;

interface ToolItem { name: string; done: boolean; success: boolean }
interface ToolGroup {
  el: HTMLElement; summaryEl: HTMLElement; titleEl: HTMLElement;
  dotsEl: HTMLElement | null; contentEl: HTMLElement;
  items: ToolItem[]; collapsed?: boolean; arrowEl?: HTMLElement;
}

// ── 消息组 ──

function ensureGroup(role: string): HTMLElement {
  const messagesEl = crCtx!.messagesEl;
  if (crState().lastRole === role && (messagesEl.lastElementChild as HTMLElement)?.classList.contains(role)) {
    return messagesEl.lastElementChild as HTMLElement;
  }
  const group = document.createElement('div');
  group.className = `message-group ${role}`;

  const avatarRow = document.createElement('div');
  avatarRow.className = 'avatar-row';

  if (role === 'assistant') {
    const sa = crState().sessionAgent as { name?: string; avatarUrl?: string; yuan?: string } | null;
    const displayName = sa?.name || (crState().agentName as string);
    const displayAvatar = sa?.avatarUrl
      || (sa ? crCtx!.yuanFallbackAvatar(sa.yuan || '') : null)
      || (crState().agentAvatarUrl as string)
      || crCtx!.yuanFallbackAvatar(crState().agentYuan as string);

    const avatar = document.createElement('img');
    avatar.className = 'avatar hana-avatar';
    avatar.src = displayAvatar;
    avatar.alt = displayName;
    avatar.draggable = false;
    avatarRow.appendChild(avatar);

    const name = document.createElement('span');
    name.className = 'avatar-name';
    name.textContent = displayName;
    avatarRow.appendChild(name);
  } else {
    if (crState().userAvatarUrl) {
      const avatar = document.createElement('img');
      avatar.className = 'avatar user-avatar-img';
      avatar.src = crState().userAvatarUrl as string;
      avatar.draggable = false;
      avatarRow.appendChild(avatar);
    } else {
      const avatar = document.createElement('div');
      avatar.className = 'avatar user-avatar';
      avatar.textContent = '\u{1F467}\u{1F3FB}';
      avatarRow.appendChild(avatar);
    }
    const name = document.createElement('span');
    name.className = 'avatar-name';
    name.textContent = (crState().userName as string) || 'User';
    avatarRow.appendChild(name);
  }

  group.appendChild(avatarRow);
  messagesEl.appendChild(group);
  crState().lastRole = role;
  return group;
}

// ── 用户消息 ──

function addUserMessage(text: string, files?: Array<{ isDirectory?: boolean; name: string; path: string; base64Data?: string; mimeType?: string }> | null, deskContext?: { dir: string; fileCount: number } | null): void {
  const icons = (window.HanaModules as Record<string, unknown>).icons as { SVG_ICONS: Record<string, string> };
  const utils = (window.HanaModules as Record<string, unknown>).utils as { escapeHtml: (s: string) => string; isImageFile: (n: string) => boolean };
  const t = (window as any).t as ((key: string, vars?: Record<string, unknown>) => string) | undefined;

  useStore.getState().setWelcomeVisible(false);
  const group = ensureGroup('user');

  const bubble = document.createElement('div');
  bubble.className = 'message user';

  const hasAttachments = (files && files.length > 0) || deskContext;
  if (hasAttachments) {
    const grid = document.createElement('div');
    grid.className = 'user-attachments';

    if (deskContext) {
      const card = document.createElement('div');
      card.className = 'attach-card attach-file attach-desk';
      const dirName = deskContext.dir.split('/').filter(Boolean).pop() || deskContext.dir;
      const countLabel = deskContext.fileCount > 0 ? `书桌 · ${deskContext.fileCount} 个文件` : '书桌目录';
      card.innerHTML = `
        <span class="attach-file-icon">${icons.SVG_ICONS.folder}</span>
        <span class="attach-file-info">
          <span class="attach-file-name">${utils.escapeHtml(dirName)}</span>
          <span class="attach-file-ext">${utils.escapeHtml(countLabel)}</span>
        </span>
      `;
      grid.appendChild(card);
    }

    for (const f of (files || [])) {
      if (!f.isDirectory && utils.isImageFile(f.name)) {
        const card = document.createElement('div');
        card.className = 'attach-card attach-image';
        const img = document.createElement('img');
        img.src = f.base64Data
          ? `data:${f.mimeType || 'image/png'};base64,${f.base64Data}`
          : `file://${f.path}`;
        img.alt = f.name;
        img.loading = 'lazy';
        card.appendChild(img);
        // 点击预览图片
        card.addEventListener('click', () => {
          const fc = (window.HanaModules as Record<string, unknown>).fileCards as Record<string, unknown>;
          const readFn = fc.readFileForPreview as (path: string, ext: string) => Promise<string | null>;
          const fExt = (f.name.split('.').pop() || '').toLowerCase();
          readFn(f.path, fExt).then(content => {
            if (content == null) {
              (window as any).platform?.openFile?.(f.path);
              return;
            }
            const artifact = { id: `file-${f.path}`, type: 'image', title: f.name, content, filePath: f.path, ext: fExt };
            const artMod = (window.HanaModules as Record<string, unknown>).artifacts as { openPreview: (a: any) => void };
            artMod.openPreview(artifact);
          });
        });
        grid.appendChild(card);
      } else {
        const card = document.createElement('div');
        card.className = 'attach-card attach-file';
        const attachIcon = f.isDirectory ? icons.SVG_ICONS.folder : icons.SVG_ICONS.file;
        const ext = f.isDirectory ? (t?.('attach.folder') || '文件夹') : (f.name.split('.').pop() || 'file').toUpperCase();
        card.innerHTML = `
          <span class="attach-file-icon">${attachIcon}</span>
          <span class="attach-file-info">
            <span class="attach-file-name">${utils.escapeHtml(f.name)}</span>
            <span class="attach-file-ext">${utils.escapeHtml(ext)}</span>
          </span>
        `;
        // 点击预览文件
        if (f.path) {
          card.addEventListener('click', () => {
            const fc = (window.HanaModules as Record<string, unknown>).fileCards as Record<string, unknown>;
            const previewExts = fc.PREVIEWABLE_EXTS as Record<string, string>;
            const readFn = fc.readFileForPreview as (path: string, ext: string) => Promise<string | null>;
            const fExt = (f.name.split('.').pop() || '').toLowerCase();
            const canPreview = fExt in previewExts;

            if (f.isDirectory) {
              // 文件夹：在访达中打开
              (window as any).platform?.showInFinder?.(f.path);
              return;
            }

            if (canPreview) {
              readFn(f.path, fExt).then(content => {
                if (content == null) {
                  (window as any).platform?.openFile?.(f.path);
                  return;
                }
                const previewType = previewExts[fExt];
                const artifact = {
                  id: `file-${f.path}`, type: previewType, title: f.name,
                  content, filePath: f.path, ext: fExt,
                  language: previewType === 'code' ? fExt : undefined,
                };
                const artMod = (window.HanaModules as Record<string, unknown>).artifacts as { openPreview: (a: any) => void };
                artMod.openPreview(artifact);
              });
            } else {
              // 不可预览 → file-info 卡片
              const artifact = { id: `file-${f.path}`, type: 'file-info', title: f.name, content: '', filePath: f.path, ext: fExt };
              const artMod = (window.HanaModules as Record<string, unknown>).artifacts as { openPreview: (a: any) => void };
              artMod.openPreview(artifact);
            }
          });
        }
        grid.appendChild(card);
      }
    }
    bubble.appendChild(grid);
  }

  if (text) {
    const textEl = document.createElement('div');
    textEl.className = 'user-text md-content';
    textEl.innerHTML = crCtx!.md.render(text);
    bubble.appendChild(textEl);
  }

  group.appendChild(bubble);
  crCtx!.scrollToBottom();
}

// ── Bridge 外部平台用户消息（显示外部用户名） ──

function addBridgeUserMessage(text: string, senderName: string): void {
  useStore.getState().setWelcomeVisible(false);

  const messagesEl = crCtx!.messagesEl;

  // 总是新建消息组（bridge 用户名可能不同，且不和 owner 消息复用）
  const group = document.createElement('div');
  group.className = 'message-group bridge-user';

  const avatarRow = document.createElement('div');
  avatarRow.className = 'avatar-row';

  const avatar = document.createElement('div');
  avatar.className = 'avatar user-avatar bridge-user-avatar';
  avatar.textContent = '\u{1F4AC}';
  avatarRow.appendChild(avatar);

  const name = document.createElement('span');
  name.className = 'avatar-name';
  name.textContent = senderName || '用户';
  avatarRow.appendChild(name);

  group.appendChild(avatarRow);
  messagesEl.appendChild(group);
  crState().lastRole = 'bridge-user';

  const bubble = document.createElement('div');
  bubble.className = 'message user bridge-user-msg';

  if (text) {
    const textEl = document.createElement('div');
    textEl.className = 'user-text md-content';
    textEl.innerHTML = crCtx!.md.render(text);
    bubble.appendChild(textEl);
  }

  group.appendChild(bubble);
  crCtx!.scrollToBottom();
}

// ── Bridge Owner 消息（桌面端用户在 bridge 模式下发的消息） ──

function addOwnerBridgeMessage(text: string): void {
  useStore.getState().setWelcomeVisible(false);

  const messagesEl = crCtx!.messagesEl;

  // 新建消息组，带 owner 标识
  const group = document.createElement('div');
  group.className = 'message-group bridge-owner';

  const avatarRow = document.createElement('div');
  avatarRow.className = 'avatar-row';

  // 使用桌面用户的头像
  if (crState().userAvatarUrl) {
    const avatar = document.createElement('img');
    avatar.className = 'avatar user-avatar-img';
    avatar.src = crState().userAvatarUrl as string;
    avatar.draggable = false;
    avatarRow.appendChild(avatar);
  } else {
    const avatar = document.createElement('div');
    avatar.className = 'avatar user-avatar';
    avatar.textContent = '\u{1F467}\u{1F3FB}';
    avatarRow.appendChild(avatar);
  }
  const name = document.createElement('span');
  name.className = 'avatar-name';
  name.textContent = (crState().userName as string) || 'Owner';
  avatarRow.appendChild(name);

  group.appendChild(avatarRow);
  messagesEl.appendChild(group);
  crState().lastRole = 'bridge-owner';

  const bubble = document.createElement('div');
  bubble.className = 'message user bridge-owner-msg';

  if (text) {
    const textEl = document.createElement('div');
    textEl.className = 'user-text md-content';
    textEl.innerHTML = crCtx!.md.render(text);
    bubble.appendChild(textEl);
  }

  group.appendChild(bubble);
  crCtx!.scrollToBottom();
}

// ── 助手消息 ──

function ensureAssistantMessage(): void {
  if (!crState().currentAssistantEl) {
    useStore.getState().setWelcomeVisible(false);
    crState().currentGroup = ensureGroup('assistant');
    crState().currentAssistantEl = document.createElement('div');
    (crState().currentAssistantEl as HTMLElement).className = 'message assistant';
    (crState().currentGroup as HTMLElement).appendChild(crState().currentAssistantEl as HTMLElement);
  }
}

function ensureTextEl(): void {
  if (crState().inMood) return;
  const curText = crState().currentTextEl as HTMLElement | null;
  if (!curText || curText.nextSibling) {
    crState().currentTextBuffer = '';
    crState().currentTextEl = document.createElement('div');
    (crState().currentTextEl as HTMLElement).className = 'md-content';
    (crState().currentAssistantEl as HTMLElement).appendChild(crState().currentTextEl as HTMLElement);
  }
}

// ── 工具组 ──

function collapseToolGroup(group: ToolGroup): void {
  const count = group.items.length;
  const allFailed = group.items.every(i => !i.success);
  const agentName = (crState().agentName as string) || 'Hanako';
  const t = (window as any).t as ((key: string, vars?: Record<string, unknown>) => string) | undefined;

  if (allFailed) {
    group.titleEl.textContent = t?.('toolGroup.failed', { n: count }) || `${count} 个操作失败`;
  } else {
    group.titleEl.textContent = t?.('toolGroup.success', { name: agentName, n: count }) || `${agentName} 使用了 ${count} 个工具`;
  }

  if (group.dotsEl) { group.dotsEl.remove(); group.dotsEl = null; }
  group.collapsed = true;

  if (count <= 1) { group.el.classList.add('single'); return; }

  group.contentEl.classList.add('collapsed');
  group.summaryEl.classList.add('clickable');

  if (!group.arrowEl) {
    const arrow = document.createElement('span');
    arrow.className = 'tool-group-arrow';
    arrow.textContent = '\u25b8';
    group.summaryEl.insertBefore(arrow, group.titleEl);
    group.arrowEl = arrow;
    group.summaryEl.addEventListener('click', () => {
      const isCollapsed = group.contentEl.classList.toggle('collapsed');
      arrow.textContent = isCollapsed ? '\u25b8' : '\u25be';
    });
  } else {
    group.arrowEl.textContent = '\u25b8';
  }
}

function crFinishAssistantTurn(): void {
  crHideThinking();
  crCleanupXing();
  const group = crState().currentToolGroup as ToolGroup | null;
  if (group && !group.collapsed) {
    const allDone = group.items.every(i => i.done);
    if (allDone) collapseToolGroup(group);
  }
  crState().currentTextEl = null;
  crState().currentTextBuffer = '';
  crState().currentMoodEl = null;
  crState().currentMoodWrapper = null;
  crState().inMood = false;
}

function crFinishAssistantMessage(): void {
  crHideThinking();
  crCleanupXing();
  crSealToolGroup();
  crState().currentToolGroup = null;
  crState().currentGroup = null;
  crState().currentAssistantEl = null;
  crState().currentTextEl = null;
  crState().currentTextBuffer = '';
  crState().currentMoodEl = null;
  crState().currentMoodWrapper = null;
  crState().inMood = false;
}

/** 断开当前 assistant 消息组，但不封存工具组（供 steer 用） */
function crBreakAssistantGroup(): void {
  const s = crState();
  s.currentGroup = null;
  s.currentAssistantEl = null;
  s.currentTextEl = null;
  s.currentTextBuffer = '';
  s.currentMoodEl = null;
  s.currentMoodWrapper = null;
  s.inMood = false;
}

// ── 思考块 ──

function crShowThinking(): void {
  if (thinkingEl) return;
  const block = document.createElement('details') as HTMLDetailsElement;
  block.className = 'thinking-block';
  const summary = document.createElement('summary');
  summary.className = 'thinking-block-summary';
  summary.innerHTML = '<span class="thinking-block-arrow">\u203a</span> 思考中<span class="thinking-dots"><span></span><span></span><span></span></span>';
  block.appendChild(summary);
  const body = document.createElement('div');
  body.className = 'thinking-block-body';
  block.appendChild(body);
  block.addEventListener('toggle', () => {
    const arrow = summary.querySelector('.thinking-block-arrow');
    if (arrow) arrow.classList.toggle('open', block.open);
  });
  thinkingEl = block;
  (crState().currentAssistantEl as HTMLElement).appendChild(thinkingEl);
  crCtx!.scrollToBottom();
}

function crHideThinking(): void {
  if (!thinkingEl) return;
  thinkingEl.remove();
  thinkingEl = null;
}

function crSealThinking(content: string): void {
  if (!thinkingEl) return;
  const summary = thinkingEl.querySelector('.thinking-block-summary');
  if (summary) summary.innerHTML = '<span class="thinking-block-arrow">\u203a</span> 思考完成';
  const body = thinkingEl.querySelector('.thinking-block-body');
  if (content.trim()) {
    if (body) body.textContent = content;
  } else {
    thinkingEl.remove();
  }
  thinkingEl = null;
}

// ── 工具指示器 ──

function extractToolDetail(name: string, args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  switch (name) {
    case 'read':
    case 'write':
    case 'edit':
    case 'edit-diff':
      return truncatePath((args.file_path || args.path || '') as string);
    case 'bash':
      return truncateHead((args.command || '') as string, 40);
    case 'glob':
    case 'find':
      return (args.pattern || '') as string;
    case 'grep':
      return truncateHead((args.pattern || '') as string, 30) +
        (args.path ? ` in ${truncatePath(args.path as string)}` : '');
    case 'ls':
      return truncatePath((args.path || '') as string);
    case 'web_fetch':
      return extractHostname((args.url || '') as string);
    case 'web_search':
      return truncateHead((args.query || '') as string, 40);
    case 'browser':
      return extractHostname((args.url || '') as string);
    case 'search_memory':
      return truncateHead((args.query || '') as string, 40);
    default:
      return '';
  }
}

function truncatePath(p: string): string {
  if (!p || p.length <= 35) return p;
  return '…' + p.slice(-34);
}

function extractHostname(u: string): string {
  if (!u) return '';
  try { return new URL(u).hostname; } catch { return u; }
}

function truncateHead(s: string, max: number): string {
  if (!s || s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function createToolIndicatorEl(name: string, args?: Record<string, unknown>): HTMLElement {
  const el = document.createElement('div');
  el.className = 'tool-indicator';
  el.dataset.tool = name;
  el.dataset.done = 'false';
  const desc = document.createElement('span');
  desc.className = 'tool-desc';
  desc.textContent = crCtx!.getToolLabel(name, 'running');
  const detail = extractToolDetail(name, args);
  if (detail) {
    const detailEl = document.createElement('span');
    detailEl.className = 'tool-detail';
    detailEl.textContent = detail;
    el.appendChild(desc);
    el.appendChild(detailEl);
  } else {
    const toolTag = document.createElement('span');
    toolTag.className = 'tool-tag';
    toolTag.textContent = name;
    el.appendChild(desc);
    el.appendChild(toolTag);
  }
  const dots = document.createElement('span');
  dots.className = 'tool-dots';
  dots.innerHTML = '<span></span><span></span><span></span>';
  el.appendChild(dots);
  return el;
}

function crAddToolToGroup(name: string, args?: Record<string, unknown>): void {
  const group = crState().currentToolGroup as ToolGroup | null;
  const assistantEl = crState().currentAssistantEl as HTMLElement;

  // 连续工具归同组；中间插入了其他内容（思考/文字/MOOD）则开新组
  const canAppend = group && !group.collapsed
    && assistantEl && group.el === assistantEl.lastElementChild;

  if (canAppend) {
    const toolEl = createToolIndicatorEl(name, args);
    group.contentEl.appendChild(toolEl);
    group.items.push({ name, done: false, success: false });
    group.titleEl.textContent = crCtx!.getToolLabel(name, 'running');
  } else {
    // 折叠旧组
    if (group && !group.collapsed) collapseToolGroup(group);

    const wrapper = document.createElement('div');
    wrapper.className = 'tool-group';
    const summaryRow = document.createElement('div');
    summaryRow.className = 'tool-group-summary';
    const summaryText = document.createElement('span');
    summaryText.className = 'tool-group-title';
    summaryText.textContent = crCtx!.getToolLabel(name, 'running');
    const dots = document.createElement('span');
    dots.className = 'tool-dots';
    dots.innerHTML = '<span></span><span></span><span></span>';
    summaryRow.appendChild(summaryText);
    summaryRow.appendChild(dots);
    wrapper.appendChild(summaryRow);
    const content = document.createElement('div');
    content.className = 'tool-group-content';
    wrapper.appendChild(content);
    const toolEl = createToolIndicatorEl(name, args);
    content.appendChild(toolEl);
    assistantEl.appendChild(wrapper);
    crState().currentToolGroup = {
      el: wrapper, summaryEl: summaryRow, titleEl: summaryText,
      dotsEl: dots, contentEl: content,
      items: [{ name, done: false, success: false }],
    };
  }
  crCtx!.scrollToBottom();
}

function crUpdateToolInGroup(name: string, success: boolean): void {
  const group = crState().currentToolGroup as ToolGroup | null;
  if (!group) return;
  const indicators = group.contentEl.querySelectorAll(`.tool-indicator[data-tool="${name}"][data-done="false"]`);
  const el = indicators[0] as HTMLElement | undefined;
  if (el) {
    el.dataset.done = 'true';
    const desc = el.querySelector('.tool-desc');
    if (desc) desc.textContent = crCtx!.getToolLabel(name, success ? 'done' : 'failed');
    const dots = el.querySelector('.tool-dots');
    if (dots) dots.remove();
    const statusEl = document.createElement('span');
    statusEl.className = 'tool-status ' + (success ? 'done' : 'failed');
    statusEl.textContent = success ? '\u2713' : '\u2717';
    el.appendChild(statusEl);
  }
  const item = group.items.find(i => i.name === name && !i.done);
  if (item) { item.done = true; item.success = success; }
}

function crSealToolGroup(): void {
  const group = crState().currentToolGroup as ToolGroup | null;
  if (!group || group.collapsed) return;
  const allDone = group.items.every(i => i.done);
  if (allDone) collapseToolGroup(group);
}

// ── 历史工具组（session 切换后重建） ──

function crRenderHistoryToolGroup(
  toolCalls: Array<{name: string; args?: Record<string, unknown>}>,
  container: HTMLElement,
): void {
  const count = toolCalls.length;
  const agentName = (crState().agentName as string) || 'Hanako';
  const t = (window as any).t as ((key: string, vars?: Record<string, unknown>) => string) | undefined;

  const wrapper = document.createElement('div');
  wrapper.className = 'tool-group';

  const summaryRow = document.createElement('div');
  summaryRow.className = 'tool-group-summary';

  const title = document.createElement('span');
  title.className = 'tool-group-title';

  const content = document.createElement('div');
  content.className = 'tool-group-content';

  for (const tc of toolCalls) {
    const el = document.createElement('div');
    el.className = 'tool-indicator';
    el.dataset.tool = tc.name;
    el.dataset.done = 'true';

    const desc = document.createElement('span');
    desc.className = 'tool-desc';
    desc.textContent = crCtx!.getToolLabel(tc.name, 'done');

    const detail = extractToolDetail(tc.name, tc.args);
    if (detail) {
      const detailEl = document.createElement('span');
      detailEl.className = 'tool-detail';
      detailEl.textContent = detail;
      el.appendChild(desc);
      el.appendChild(detailEl);
    } else {
      const tag = document.createElement('span');
      tag.className = 'tool-tag';
      tag.textContent = tc.name;
      el.appendChild(desc);
      el.appendChild(tag);
    }

    const statusEl = document.createElement('span');
    statusEl.className = 'tool-status done';
    statusEl.textContent = '\u2713';
    el.appendChild(statusEl);

    content.appendChild(el);
  }

  if (count <= 1) {
    title.textContent = crCtx!.getToolLabel(toolCalls[0].name, 'done');
    wrapper.classList.add('single');
    summaryRow.appendChild(title);
  } else {
    title.textContent = t?.('toolGroup.success', { name: agentName, n: count })
      || `${agentName} 使用了 ${count} 个工具`;
    content.classList.add('collapsed');
    summaryRow.classList.add('clickable');

    const arrow = document.createElement('span');
    arrow.className = 'tool-group-arrow';
    arrow.textContent = '\u25b8';
    summaryRow.appendChild(arrow);
    summaryRow.appendChild(title);

    summaryRow.addEventListener('click', () => {
      const isCollapsed = content.classList.toggle('collapsed');
      arrow.textContent = isCollapsed ? '\u25b8' : '\u25be';
    });
  }

  wrapper.appendChild(summaryRow);
  wrapper.appendChild(content);
  container.appendChild(wrapper);
}

// ── Compaction 提示 ──

let _compactionEl: HTMLElement | null = null;

function crShowCompaction(): void {
  if (_compactionEl) return;
  const yuan = (crState().agentYuan as string) || 'hanako';
  const el = document.createElement('div');
  el.className = 'compaction-notice';
  el.dataset.yuan = yuan;

  // SVG: minimize/compress icon (feather style)
  el.innerHTML = `<svg class="compaction-notice-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg><span class="compaction-notice-text">正在压缩上下文，以得到更持久的会话，稍候片刻</span><span class="compaction-notice-dots"><span></span><span></span><span></span></span>`;

  crCtx!.messagesEl.appendChild(el);
  _compactionEl = el;
  crCtx!.scrollToBottom();
}

function crHideCompaction(): void {
  if (!_compactionEl) return;
  _compactionEl.classList.add('fade-out');
  const el = _compactionEl;
  _compactionEl = null;
  setTimeout(() => el.remove(), 300);
}

// ── Xing 反省卡片 ──

function crShowXingLoading(title: string): void {
  const card = document.createElement('div');
  card.className = 'xing-card loading';

  const titleEl = document.createElement('div');
  titleEl.className = 'xing-card-title';
  titleEl.textContent = title || '反省';
  card.appendChild(titleEl);

  const statusEl = document.createElement('div');
  statusEl.className = 'xing-card-status';
  const agentName = (crState().agentName as string) || 'Hanako';
  statusEl.textContent = `${agentName} 总结中`;
  const dots = document.createElement('span');
  dots.className = 'thinking-dots';
  dots.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
  statusEl.appendChild(dots);
  card.appendChild(statusEl);

  (crState().currentAssistantEl as HTMLElement).appendChild(card);
  crState().xingCardEl = card;
}

function crSealXingCard(title: string | null, markdownContent: string): void {
  const existingCard = crState().xingCardEl as HTMLElement | null;

  const card = document.createElement('div');
  card.className = 'xing-card';

  const titleEl = document.createElement('div');
  titleEl.className = 'xing-card-title';
  titleEl.textContent = title || '反省';
  card.appendChild(titleEl);

  const hr = document.createElement('hr');
  hr.className = 'xing-card-divider';
  card.appendChild(hr);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'xing-card-body md-content';
  bodyEl.innerHTML = crCtx!.md.render(markdownContent.trim());
  card.appendChild(bodyEl);

  // inject copy buttons for code blocks inside the card
  const injectCopyButtons = (window as any).HanaModules?.utils?.injectCopyButtons;
  if (injectCopyButtons) injectCopyButtons(bodyEl);

  const copyBtn = document.createElement('button');
  copyBtn.className = 'xing-card-copy';
  copyBtn.textContent = '复制';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(markdownContent.trim()).then(() => {
      copyBtn.textContent = '已复制';
      setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
    });
  });
  card.appendChild(copyBtn);

  if (existingCard && existingCard.parentNode) {
    existingCard.parentNode.replaceChild(card, existingCard);
  } else {
    (crState().currentAssistantEl as HTMLElement).appendChild(card);
  }
  crState().xingCardEl = null;
}

function crCleanupXing(): void {
  if (crState().inXing && crState().xingCardEl) {
    const buf = (crState()._xingBuf as string) || '';
    crSealXingCard(crState().xingTitle as string, buf);
  }
  crState().inXing = false;
  crState().xingTitle = null;
  crState().xingCardEl = null;
  crState()._xingBuf = '';
}

// ── Setup ──

export function setupChatRenderShim(modules: Record<string, unknown>): void {
  modules.chatRender = {
    ensureGroup,
    addUserMessage,
    addBridgeUserMessage,
    addOwnerBridgeMessage,
    ensureAssistantMessage,
    ensureTextEl,
    finishAssistantTurn: crFinishAssistantTurn,
    finishAssistantMessage: crFinishAssistantMessage,
    breakAssistantGroup: crBreakAssistantGroup,
    showThinking: crShowThinking,
    hideThinking: crHideThinking,
    sealThinking: crSealThinking,
    addToolToGroup: crAddToolToGroup,
    updateToolInGroup: crUpdateToolInGroup,
    sealToolGroup: crSealToolGroup,
    renderHistoryToolGroup: crRenderHistoryToolGroup,
    showXingLoading: crShowXingLoading,
    sealXingCard: crSealXingCard,
    showCompaction: crShowCompaction,
    hideCompaction: crHideCompaction,
    initChatRender: (injected: ChatRenderCtx) => { crCtx = injected; },
  };
}
