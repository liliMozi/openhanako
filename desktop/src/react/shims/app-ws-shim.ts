/**
 * app-ws-shim.ts — WebSocket 连接 / 消息分发 / 流恢复
 *
 * 从 app.js 提取（Phase 4），ctx 注入模式。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

declare function t(key: string, vars?: Record<string, string>): any;

interface AppWsCtx {
  state: Record<string, any>;
  chatArea: HTMLElement;
  md: { render: (src: string) => string };
  scrollToBottom: () => void;
  setStatus: (text: string, connected: boolean) => void;
  showError: (message: string) => void;
  injectCopyButtons: (el: HTMLElement) => void;
  escapeHtml: (s: string) => string;
  platform: Record<string, any>;
  _cr: () => Record<string, any>;
  _fc: () => Record<string, any>;
  _ar: () => Record<string, any>;
  _sb: () => Record<string, any>;
  _ch: () => Record<string, any>;
  _dk: () => Record<string, any>;
  _msg: () => Record<string, any>;
  _ag: () => Record<string, any>;
}

let ctx: AppWsCtx;

// ── WS 重连状态 ──
let _wsRetryDelay = 1000;
const WS_RETRY_MAX = 30000;
let _wsRetryTimer: ReturnType<typeof setTimeout> | null = null;
let _wsResumeVersion = 0;

// ── 流恢复状态 ──
let _streamResumeRebuildVersion = 0;
let _streamResumeRebuildingFor: string | null = null;

// ── Session 流元数据 ──

function getSessionStreamMeta(sessionPath?: string): { streamId: string | null; lastSeq: number } | null {
  const path = sessionPath || ctx.state.currentSessionPath;
  if (!path) return null;
  if (!ctx.state.sessionStreams[path]) {
    ctx.state.sessionStreams[path] = { streamId: null, lastSeq: 0 };
  }
  return ctx.state.sessionStreams[path];
}

function isStreamScopedMessage(msg: any): boolean {
  return !!(msg && msg.sessionPath && (msg.streamId || Number.isFinite(msg.seq)));
}

function updateSessionStreamMeta(meta: any = {}): void {
  const sessionPath = meta.sessionPath || ctx.state.currentSessionPath;
  if (!sessionPath) return;

  const entry = getSessionStreamMeta(sessionPath);
  if (!entry) return;

  if (meta.streamId) {
    if (entry.streamId && entry.streamId !== meta.streamId) {
      entry.lastSeq = 0;
    }
    entry.streamId = meta.streamId;
  }

  if (Number.isFinite(meta.seq)) {
    entry.lastSeq = Math.max(entry.lastSeq || 0, meta.seq);
  }
}

function requestStreamResume(sessionPath?: string, opts: any = {}): void {
  const { state } = ctx;
  const path = sessionPath || state.currentSessionPath;
  if (!path || state.ws?.readyState !== WebSocket.OPEN) return;
  const meta = getSessionStreamMeta(path) || { streamId: null, lastSeq: 0 };
  const fromStart = !!opts.fromStart;
  const streamId = opts.streamId !== undefined ? opts.streamId : (meta.streamId || null);
  const sinceSeq = Number.isFinite(opts.sinceSeq)
    ? Math.max(0, Math.floor(opts.sinceSeq))
    : (fromStart ? 0 : (meta.lastSeq || 0));
  state.ws.send(JSON.stringify({
    type: 'resume_stream',
    sessionPath: path,
    streamId,
    sinceSeq,
  }));
}

// ── Session 可见性 + 流状态 ──

function ensureCurrentSessionVisible(): void {
  const { state } = ctx;
  const sessionPath = state.currentSessionPath;
  if (!sessionPath || state.pendingNewSession) return;
  if (state.sessions.some((s: any) => s.path === sessionPath)) return;

  state.sessions = [{
    path: sessionPath,
    title: null,
    firstMessage: '',
    modified: new Date().toISOString(),
    messageCount: 0,
    agentId: state.currentAgentId || null,
    agentName: state.agentName || null,
    _optimistic: true,
  }, ...state.sessions];
}

function hasOptimisticCurrentSession(): boolean {
  const { state } = ctx;
  const sessionPath = state.currentSessionPath;
  if (!sessionPath) return false;
  return !!state.sessions.find((s: any) => s.path === sessionPath && s._optimistic);
}

function applyStreamingStatus(isStreaming: boolean): void {
  const { state } = ctx;
  state.isStreaming = !!isStreaming;
  if (state.isStreaming) {
    ensureCurrentSessionVisible();
  } else {
    ctx._cr().finishAssistantMessage();
    if (hasOptimisticCurrentSession()) {
      ctx._sb().loadSessions().catch(() => {});
    }
  }
}

// ── 流恢复 / 重建 ──

async function rebuildCurrentSessionFromResume(msg: any): Promise<void> {
  const { state } = ctx;
  const sessionPath = msg.sessionPath || state.currentSessionPath;
  if (!sessionPath || sessionPath !== state.currentSessionPath) return;

  const myVersion = ++_streamResumeRebuildVersion;
  _streamResumeRebuildingFor = sessionPath;
  try {
    ctx._ag().clearChat();
    await ctx._msg().loadMessages();

    if (myVersion !== _streamResumeRebuildVersion) return;
    if (state.currentSessionPath !== sessionPath) return;

    const meta = getSessionStreamMeta(sessionPath);
    if (meta) {
      meta.streamId = msg.streamId || null;
      meta.lastSeq = 0;
    }

    for (const entry of msg.events || []) {
      handleServerMessage({
        ...entry.event,
        sessionPath,
        streamId: msg.streamId || null,
        seq: entry.seq,
        __fromReplay: true,
      });
    }

    applyStreamingStatus(msg.isStreaming);

    if (state.currentSessionPath === sessionPath && state.ws?.readyState === WebSocket.OPEN && msg.isStreaming) {
      requestStreamResume(sessionPath);
    }
  } finally {
    if (myVersion === _streamResumeRebuildVersion && _streamResumeRebuildingFor === sessionPath) {
      _streamResumeRebuildingFor = null;
    }
  }
}

function replayStreamResume(msg: any): void {
  const { state } = ctx;
  const sessionPath = msg.sessionPath || state.currentSessionPath;
  if (!sessionPath || sessionPath !== state.currentSessionPath) return;

  if (msg.reset || msg.truncated) {
    rebuildCurrentSessionFromResume(msg).catch((err) => {
      console.error('[stream] rebuild failed:', err);
      _streamResumeRebuildingFor = null;
    });
    return;
  }

  const meta = getSessionStreamMeta(sessionPath);
  if (meta && msg.streamId) {
    if (msg.reset) meta.lastSeq = 0;
    if (meta.streamId && meta.streamId !== msg.streamId) {
      meta.lastSeq = 0;
    }
    meta.streamId = msg.streamId;
  }

  for (const entry of msg.events || []) {
    handleServerMessage({
      ...entry.event,
      sessionPath,
      streamId: msg.streamId || null,
      seq: entry.seq,
      __fromReplay: true,
    });
  }

  applyStreamingStatus(msg.isStreaming);
}

// ── WebSocket 连接 ──

function connectWS(): void {
  const { state } = ctx;
  if (_wsRetryTimer) { clearTimeout(_wsRetryTimer); _wsRetryTimer = null; }
  if (state.ws) {
    try { state.ws.onclose = null; state.ws.close(); } catch { /* silent */ }
  }

  const tokenParam = state.serverToken ? `?token=${state.serverToken}` : '';
  const url = `ws://127.0.0.1:${state.serverPort}/ws${tokenParam}`;
  state.ws = new WebSocket(url);

  state.ws.onopen = () => {
    state.connected = true;
    _wsRetryDelay = 1000;
    ctx.setStatus(t('status.connected'), true);

    if (state.currentSessionPath && state.isStreaming) {
      const myVersion = ++_wsResumeVersion;
      const targetPath = state.currentSessionPath;
      Promise.resolve().then(async () => {
        if (myVersion !== _wsResumeVersion) return;
        if (state.currentSessionPath !== targetPath) return;
        requestStreamResume(targetPath);
      }).catch((err) => {
        console.error('[ws] reconnect resume failed:', err);
      });
    }
  };

  state.ws.onmessage = (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch (err) {
      console.error('[ws] message parse error:', err);
    }
  };

  state.ws.onclose = () => {
    state.connected = false;
    ctx.setStatus(t('status.disconnected'), false);
    _wsRetryTimer = setTimeout(connectWS, _wsRetryDelay);
    _wsRetryDelay = Math.min(_wsRetryDelay * 2, WS_RETRY_MAX);
  };

  state.ws.onerror = () => {};
}

// ── 消息分发（大 switch） ──

function handleServerMessage(msg: any): void {
  const { state, md, scrollToBottom, showError, injectCopyButtons } = ctx;
  const _cr = ctx._cr;
  const _fc = ctx._fc;
  const _ar = ctx._ar;
  const _sb = ctx._sb;
  const _ch = ctx._ch;
  const _dk = ctx._dk;
  const _msg = ctx._msg;

  if (_streamResumeRebuildingFor && msg.type === 'status' && state.currentSessionPath === _streamResumeRebuildingFor) {
    return;
  }

  if (
    _streamResumeRebuildingFor &&
    isStreamScopedMessage(msg) &&
    msg.sessionPath === _streamResumeRebuildingFor &&
    !msg.__fromReplay &&
    msg.type !== 'stream_resume'
  ) {
    return;
  }

  if (msg.type !== 'stream_resume' && isStreamScopedMessage(msg)) {
    updateSessionStreamMeta(msg);
  }

  switch (msg.type) {
    case 'stream_resume':
      replayStreamResume(msg);
      break;

    case 'text_delta':
      _cr().ensureAssistantMessage();
      _cr().hideThinking();
      _cr().sealToolGroup();
      _cr().ensureTextEl();
      state.currentTextBuffer += msg.delta;
      {
        const displayText = state.currentTextBuffer.replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/g, '');
        state.currentTextEl.innerHTML = md.render(displayText);
        injectCopyButtons(state.currentTextEl);
      }
      scrollToBottom();
      break;

    case 'xing_start': {
      _cr().ensureAssistantMessage();
      _cr().hideThinking();
      _cr().sealToolGroup();
      state.inXing = true;
      state.xingTitle = msg.title || '反省';
      state.currentTextEl = null;
      state._xingBuf = '';
      _cr().showXingLoading(state.xingTitle);
      scrollToBottom();
      break;
    }

    case 'xing_text':
      state._xingBuf = (state._xingBuf || '') + (msg.delta || '');
      break;

    case 'xing_end':
      _cr().sealXingCard(state.xingTitle, state._xingBuf || '');
      state.inXing = false;
      state.xingTitle = null;
      state.xingCardEl = null;
      state._xingBuf = '';
      scrollToBottom();
      break;

    case 'mood_start': {
      _cr().ensureAssistantMessage();
      _cr().hideThinking();
      _cr().sealToolGroup();
      state.inMood = true;
      const yuan = state.agentYuan || 'hanako';
      state.currentMoodWrapper = document.createElement('details');
      state.currentMoodWrapper.className = 'mood-wrapper';
      state.currentMoodWrapper.dataset.yuan = yuan;
      const summary = document.createElement('summary');
      summary.className = 'mood-summary';
      summary.innerHTML = `<span class="mood-arrow">›</span> ${_msg().moodLabel(yuan)}`;
      state.currentMoodWrapper.appendChild(summary);
      state.currentMoodEl = document.createElement('div');
      state.currentMoodEl.className = 'mood-block';
      state.currentMoodWrapper.appendChild(state.currentMoodEl);
      const wrapper = state.currentMoodWrapper;
      wrapper.addEventListener('toggle', () => {
        const arrow = summary.querySelector('.mood-arrow');
        if (arrow) arrow.classList.toggle('open', wrapper.open);
      });
      state.currentAssistantEl.appendChild(state.currentMoodWrapper);
      break;
    }

    case 'mood_text':
      if (state.currentMoodEl) {
        state.currentMoodEl.textContent += msg.delta;
        scrollToBottom();
      }
      break;

    case 'mood_end':
      state.inMood = false;
      if (state.currentMoodEl) {
        state.currentMoodEl.textContent = _msg().cleanMoodText(state.currentMoodEl.textContent);
      }
      state.currentMoodEl = null;
      state.currentMoodWrapper = null;
      break;

    case 'thinking_start':
      _cr().ensureAssistantMessage();
      state._thinkingBuf = '';
      _cr().showThinking();
      break;

    case 'thinking_delta':
      if (msg.delta) state._thinkingBuf = (state._thinkingBuf || '') + msg.delta;
      break;

    case 'thinking_end':
      _cr().sealThinking(state._thinkingBuf || '');
      state._thinkingBuf = undefined;
      break;

    case 'tool_start':
      _cr().ensureAssistantMessage();
      _cr().hideThinking();
      _cr().addToolToGroup(msg.name, msg.args);
      break;

    case 'tool_end':
      _cr().updateToolInGroup(msg.name, msg.success);
      if (msg.name === 'todo' && msg.details?.todos) {
        state.sessionTodos = msg.details.todos;
      }
      break;

    case 'turn_end':
      // 安全兜底：如果 thinking 块未被 seal，先保留内容再结束
      if (state._thinkingBuf != null) {
        _cr().sealThinking(state._thinkingBuf || '');
        state._thinkingBuf = undefined;
      }
      _cr().finishAssistantTurn();
      _sb().loadSessions();
      // 每轮结束后刷新 token 用量
      if (state.ws?.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'context_usage' }));
      }
      break;

    case 'session_title':
      if (msg.title) {
        state.sessions = state.sessions.map((s: any) =>
          s.path === msg.path ? { ...s, title: msg.title } : s,
        );
      }
      break;

    case 'desk_changed':
      _dk().loadDeskFiles();
      break;

    case 'file_output':
      _cr().ensureAssistantMessage();
      _fc().appendFileCard(msg.filePath, msg.label, msg.ext);
      scrollToBottom();
      break;

    case 'skill_activated':
      _cr().ensureAssistantMessage();
      _fc().appendSkillCard(msg.skillName, msg.skillFilePath);
      scrollToBottom();
      break;

    case 'artifact':
      if (state.currentTab !== 'chat') break;
      _cr().ensureAssistantMessage();
      _ar().handleArtifact(msg);
      scrollToBottom();
      break;

    case 'browser_screenshot':
      if (state.currentTab !== 'chat') break;
      _cr().ensureAssistantMessage();
      _ar().appendBrowserScreenshot(msg.base64, msg.mimeType);
      scrollToBottom();
      break;

    case 'browser_status':
      state.browserRunning = !!msg.running;
      state.browserUrl = msg.url || null;
      if (msg.thumbnail) state.browserThumbnail = msg.thumbnail;
      if (!msg.running) state.browserThumbnail = null;
      _ar().renderBrowserCard();
      if (ctx.platform?.updateBrowserViewer) {
        ctx.platform.updateBrowserViewer({
          running: state.browserRunning,
          url: state.browserUrl,
          thumbnail: state.browserThumbnail,
        });
      }
      break;

    case 'browser_bg_status': {
      const bar = document.getElementById('browserBgBar');
      if (bar) bar.classList.toggle('hidden', !msg.running);
      break;
    }

    case 'cron_confirmation': {
      _cr().ensureAssistantMessage();
      const jd = msg.jobData;
      if (!jd || !state.currentAssistantEl) break;
      _msg().appendCronConfirmCard(jd);
      scrollToBottom();
      break;
    }

    case 'activity_update':
      if (msg.activity) {
        state.activities = [msg.activity, ...state.activities.slice(0, 499)];
      }
      break;

    case 'notification':
      if ((window as any).hana?.showNotification) {
        (window as any).hana.showNotification(msg.title, msg.body);
      }
      break;

    case 'bridge_status':
      (window as any).__hanaBridgeLoadStatus?.();
      break;

    case 'bridge_message':
      if (msg.message) {
        (window as any).__hanaBridgeOnMessage?.(msg.message);

        // 刷新侧边栏 session 列表（新 bridge session 可能刚创建）
        _sb().loadSessions().catch(() => {});

        // 如果当前处于 bridge 接管模式且消息属于当前 session，在主聊天区域追加气泡
        const bridgeState = (window as any).__hanaGetState?.()?.bridgeSession;
        if (bridgeState && msg.message.sessionKey === bridgeState.sessionKey) {
          const _crBridge = () => (window as any).HanaModules.chatRender;
          const mdInst = (window as any).__hanaState?.md;
          if (msg.message.direction === 'in') {
            // 用户消息（来自外部平台）— 显示飞书用户名而非桌面用户
            let displayText = msg.message.text || '';
            const pfx = displayText.match(/^\[.+?\]\s*.+?:\s*/);
            if (pfx) displayText = displayText.slice(pfx[0].length);
            const senderName = msg.message.sender || '用户';
            _crBridge().addBridgeUserMessage(displayText, senderName);
          } else if (msg.message.direction === 'owner_echo') {
            // 桌面端用户自己的消息回显（已在本地渲染，跳过）
          } else {
            // 助手回复（direction === 'out'）
            const cleaned = (msg.message.text || '')
              .replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/g, '')
              .replace(/```(?:mood|pulse|reflect)[\s\S]*?```\n*/gi, '')
              .replace(/<(?:mood|pulse|reflect)>[\s\S]*?<\/(?:mood|pulse|reflect)>\s*/g, '');
            const group = _crBridge().ensureGroup('assistant');
            const bubble = document.createElement('div');
            bubble.className = 'message assistant';
            const textEl = document.createElement('div');
            textEl.className = 'md-content';
            textEl.innerHTML = mdInst ? mdInst.render(cleaned) : cleaned;
            bubble.appendChild(textEl);
            group.appendChild(bubble);
            _crBridge().finishAssistantMessage();
          }
          // 自动滚到底
          const messagesEl = document.getElementById('messages');
          if (messagesEl) {
            setTimeout(() => { messagesEl.scrollTop = messagesEl.scrollHeight; }, 0);
          }
        }
      }
      break;

    case 'plan_mode':
      window.dispatchEvent(new CustomEvent('hana-plan-mode', { detail: { enabled: !!msg.enabled } }));
      break;

    case 'channel_new_message':
      if (msg.channelName && state.currentChannel === msg.channelName) {
        _ch().openChannel(msg.channelName);
      } else if (msg.channelName) {
        _ch().loadChannels();
      }
      break;

    case 'dm_new_message': {
      const dmId = `dm:${msg.from}`;
      if (state.currentChannel === dmId) {
        _ch().openChannel(dmId, true);
      } else {
        _ch().loadChannels();
      }
      break;
    }

    case 'compaction_start':
      state._compacting = true;
      _cr().showCompaction();
      break;

    case 'compaction_end':
      state._compacting = false;
      _cr().hideCompaction();
      // 更新 token 用量
      if (msg.tokens != null && msg.contextWindow != null) {
        state.contextTokens = msg.tokens;
        state.contextWindow = msg.contextWindow;
        state.contextPercent = msg.percent;
      }
      break;

    case 'context_usage':
      if (msg.tokens != null && msg.contextWindow != null) {
        state.contextTokens = msg.tokens;
        state.contextWindow = msg.contextWindow;
        state.contextPercent = msg.percent;
      }
      break;

    case 'error':
      showError(msg.message);
      break;

    case 'status':
      applyStreamingStatus(msg.isStreaming);
      break;
  }
}

// ── Setup ──

export function setupAppWsShim(modules: Record<string, unknown>): void {
  modules.appWs = {
    connectWS,
    handleServerMessage,
    requestStreamResume,
    applyStreamingStatus,
    initAppWs: (injected: AppWsCtx) => { ctx = injected; },
  };
}
