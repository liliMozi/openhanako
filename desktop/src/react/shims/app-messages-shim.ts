/**
 * app-messages-shim.ts — 消息加载 / 解析 / Mood / Cron 确认卡片
 *
 * 从 app.js 提取（Phase 4），ctx 注入模式。
 */

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
  const { state, hanaFetch, md, scrollToBottom, renderTodoDisplay, injectCopyButtons } = ctx;
  const { SVG_ICONS } = (window as any).HanaModules.icons;
  const _cr = ctx._cr;
  const _fc = ctx._fc;
  const _ar = ctx._ar;

  try {
    const res = await hanaFetch('/api/sessions/messages');
    const data = await res.json();
    if (data.todos && data.todos.length > 0) {
      state.sessionTodos = data.todos;
      renderTodoDisplay();
    }

    if (data.messages && data.messages.length > 0) {
      state.welcomeVisible = false;

      const fileMap: Record<number, any[]> = {};
      const artMap: Record<number, any[]> = {};
      for (const fo of (data.fileOutputs || [])) {
        (fileMap[fo.afterIndex] ??= []).push(...fo.files);
      }
      for (const ar of (data.artifacts || [])) {
        (artMap[ar.afterIndex] ??= []).push(ar);
      }

      for (let i = 0; i < data.messages.length; i++) {
        const m = data.messages[i];
        if (m.role === 'user') {
          const { text: userText, files: userFiles, deskContext } = parseUserAttachments(m.content);
          _cr().addUserMessage(userText, userFiles.length ? userFiles : null, deskContext);
        } else if (m.role === 'assistant') {
          const group = _cr().ensureGroup('assistant');
          const bubble = document.createElement('div');
          bubble.className = 'message assistant';

          state.currentAssistantEl = bubble;
          const { mood, yuan: moodYuan, text: afterMood } = parseMoodFromContent(m.content);
          const { xingBlocks, text } = parseXingFromContent(afterMood);

          if (mood) {
            const y = moodYuan || state.agentYuan || 'hanako';
            const details = document.createElement('details');
            details.className = 'mood-wrapper';
            details.dataset.yuan = y;
            const summaryEl = document.createElement('summary');
            summaryEl.className = 'mood-summary';
            summaryEl.innerHTML = `<span class="mood-arrow">›</span> ${moodLabel(y)}`;
            details.appendChild(summaryEl);
            const moodBlock = document.createElement('div');
            moodBlock.className = 'mood-block';
            moodBlock.textContent = mood;
            details.appendChild(moodBlock);
            details.addEventListener('toggle', () => {
              const arrow = summaryEl.querySelector('.mood-arrow');
              if (arrow) arrow.classList.toggle('open', details.open);
            });
            bubble.appendChild(details);
          }

          if (m.thinking) {
            const block = document.createElement('details');
            block.className = 'thinking-block';
            const thinkSummary = document.createElement('summary');
            thinkSummary.className = 'thinking-block-summary';
            thinkSummary.innerHTML = '<span class="thinking-block-arrow">›</span> 思考完成';
            block.appendChild(thinkSummary);
            const body = document.createElement('div');
            body.className = 'thinking-block-body';
            body.textContent = m.thinking;
            block.appendChild(body);
            block.addEventListener('toggle', () => {
              const arrow = thinkSummary.querySelector('.thinking-block-arrow');
              if (arrow) arrow.classList.toggle('open', block.open);
            });
            bubble.appendChild(block);
          }

          for (const xb of xingBlocks) {
            _cr().sealXingCard(xb.title, xb.content);
          }

          if (m.toolCalls?.length) {
            _cr().renderHistoryToolGroup(m.toolCalls, bubble);
          }

          if (text) {
            const mdEl = document.createElement('div');
            mdEl.className = 'md-content';
            mdEl.innerHTML = md.render(text.replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/g, ''));
            injectCopyButtons(mdEl);
            bubble.appendChild(mdEl);
          }

          if (fileMap[i]) {
            for (const f of fileMap[i]) {
              _fc().appendFileCard(f.filePath, f.label, f.ext || '');
            }
          }

          if (artMap[i]) {
            for (const ar of artMap[i]) {
              const artifact = {
                id: ar.artifactId || `hist-${i}`,
                type: ar.artifactType,
                title: ar.title,
                content: ar.content,
                language: ar.language,
              };
              state.artifacts.push(artifact);
              _ar().appendArtifactCard(artifact);
            }
          }
          state.currentAssistantEl = null;

          group.appendChild(bubble);
        }
      }
      scrollToBottom();
    }
  } catch { /* silent */ }
}

// ── Bridge 消息加载 ──

async function loadBridgeMessages(sessionKey: string): Promise<void> {
  const { hanaFetch, md, scrollToBottom } = ctx;
  const _cr = ctx._cr;

  try {
    const res = await hanaFetch(`/api/bridge/sessions/${encodeURIComponent(sessionKey)}/messages`);
    const data = await res.json();
    console.log(data);
    if (data.messages && data.messages.length > 0) {
      for (const msg of data.messages) {
        if (msg.role === 'user') {
          let displayText = msg.content;
          let senderName = (msg as any).senderName || null;
          // 如果 API 返回了 senderName，直接从内容中剥离前缀
          if (senderName) {
            // 去掉 "[来自 xxx]" 前缀
            displayText = displayText.replace(/^\[来自\s+[^\]]+\]\s*/, '');
            // 去掉 "[MM-DD HH:mm]" 时间标签
            displayText = displayText.replace(/^\[\d{2}-\d{2}\s+\d{2}:\d{2}\]\s*/, '');
            // 去掉 "username: " 前缀
            const prefixMatch = displayText.match(/^(.+?):\s*/);
            if (prefixMatch) {
              displayText = displayText.slice(prefixMatch[0].length);
            }
            _cr().addBridgeUserMessage(displayText, senderName, msg.timestamp);
          } else {
            // 回退：从内容中解析
            displayText = displayText.replace(/^\[来自\s+[^\]]+\]\s*/, '');
            displayText = displayText.replace(/^\[\d{2}-\d{2}\s+\d{2}:\d{2}\]\s*/, '');
            const prefixMatch = displayText.match(/^(.+?):\s*/);
            if (prefixMatch) {
              senderName = prefixMatch[1];
              displayText = displayText.slice(prefixMatch[0].length);
              _cr().addBridgeUserMessage(displayText, senderName, msg.timestamp);
            } else {
              _cr().addBridgeUserMessage(displayText, '用户', msg.timestamp);
            }
          }
        } else if (msg.role === 'assistant') {
          // 去掉内部标签
          const cleaned = (msg.content || '')
            .replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/g, '')
            .replace(/```(?:mood|pulse|reflect)[\s\S]*?```\n*/gi, '')
            .replace(/<(?:mood|pulse|reflect)>[\s\S]*?<\/(?:mood|pulse|reflect)>\s*/g, '');
          const group = _cr().ensureGroup('assistant', msg.timestamp);
          const bubble = document.createElement('div');
          bubble.className = 'message assistant';
          const textEl = document.createElement('div');
          textEl.className = 'md-content';
          textEl.innerHTML = md.render(cleaned);
          bubble.appendChild(textEl);
          group.appendChild(bubble);
          _cr().finishAssistantMessage();
        }
      }
      scrollToBottom();
    }
  } catch (err) {
    console.error('[bridge] loadBridgeMessages failed:', err);
  }
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
    loadBridgeMessages,
    // ctx 注入
    initAppMessages: (injected: AppMessagesCtx) => { ctx = injected; },
  };
}
