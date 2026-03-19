/**
 * sidebar-shim.ts — sidebar.js 的 bridge shim
 *
 * 包含：session 加载/切换/新建/归档、布局管理、宽度拖拽、浮动预览卡片。
 * bridge.ts 在 React mount 后调用 setupSidebarShim，覆盖 react-init.js 的 no-op 版本。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── ctx 闭包 ──

let ctx: Record<string, any> | null = null;
function state(): Record<string, any> { return ctx!.state; }

// ── 模块内部状态 ──

let _switchVersion = 0;
let _floatCard: HTMLElement | null = null;
let _floatTimer: ReturnType<typeof setTimeout> | null = null;
let _floatEnterTimer: ReturnType<typeof setTimeout> | null = null;

// ══════════════════════════════════════════════════════
// Session 列表
// ══════════════════════════════════════════════════════

async function loadSessions(): Promise<void> {
  try {
    const res = await ctx!.hanaFetch('/api/sessions');
    const data = await res.json();
    state().sessions = data || [];

    if (state().sessions.length > 0 && !state().currentSessionPath && !state().pendingNewSession) {
      state().currentSessionPath = state().sessions[0].path;
    }

    renderSessionList();
  } catch { /* ignore */ }
}

// renderSessionList: React SessionList 通过 Zustand sessions 状态驱动渲染
function renderSessionList(): void {
  // no-op — React 响应式渲染
}

// ══════════════════════════════════════════════════════
// Session 切换
// ══════════════════════════════════════════════════════

async function switchSession(path: string): Promise<void> {
  if (path === state().currentSessionPath) return;

  const { isActivityVisible, hideActivityPanel, closeActivityDetail, isAutomationVisible, hideAutomationPanel } = (window as any).HanaModules.activity;
  if (isActivityVisible()) { closeActivityDetail(); hideActivityPanel(); }
  if (isAutomationVisible()) hideAutomationPanel();

  const myVersion = ++_switchVersion;

  try {
    const res = await ctx!.hanaFetch('/api/sessions/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (myVersion !== _switchVersion) return;
    if (data.error) {
      console.error('[session] switch failed:', data.error);
      return;
    }

    // React 路径：streaming 事件通过 StreamBuffer 按 sessionPath 路由，无需 lock
    state().currentSessionPath = path;
    state().pendingNewSession = false;
    state().selectedFolder = null;
    state().selectedAgentId = null;
    state().memoryEnabled = data.memoryEnabled !== false;

    state().isStreaming = !!data.isStreaming;
    // 同步 streamingSessions：切入的 session 可能正在 streaming
    if (data.isStreaming && path) {
      const list: string[] = state().streamingSessions || [];
      if (!list.includes(path)) state().streamingSessions = [...list, path];
    }

    if (data.agentId && data.agentId !== state().currentAgentId) {
      const ag = state().agents.find((a: any) => a.id === data.agentId);
      state().sessionAgent = {
        name: data.agentName || ag?.name || data.agentId,
        yuan: ag?.yuan,
        avatarUrl: ctx!.hanaUrl(`/api/agents/${data.agentId}/avatar?t=${Date.now()}`),
      };
    } else {
      state().sessionAgent = null;
    }

    state().browserRunning = !!data.browserRunning;
    state().browserUrl = data.browserUrl || null;
    if (!data.browserRunning) state().browserThumbnail = null;
    const { renderBrowserCard } = (window as any).HanaModules.artifacts;
    renderBrowserCard();

    ctx!.updateFolderButton();

    // 数据驱动：检查 store 中是否已有该 session 的消息数据
    const store = (window as any).__zustandStore;
    const hasData = !!store?.getState()?.chatSessions?.[path];
    if (!hasData) {
      await ctx!.loadMessages();
    }
    ctx!.loadDeskFiles('');
    renderSessionList();

    // 切换会话后刷新 context ring
    state().contextTokens = null;
    state().contextWindow = null;
    state().contextPercent = null;
    if (state().ws?.readyState === WebSocket.OPEN) {
      state().ws.send(JSON.stringify({ type: 'context_usage' }));
    }
  } catch (err) {
    console.error('[session] switch failed:', err);
  }
}

async function createNewSession(): Promise<void> {
  const { isActivityVisible, hideActivityPanel, closeActivityDetail } = (window as any).HanaModules.activity;
  if (isActivityVisible()) { closeActivityDetail(); hideActivityPanel(); }

  state().isStreaming = false;

  state().welcomeVisible = true;
  state().currentSessionPath = null;
  state().selectedFolder = state().homeFolder || null;
  state().selectedAgentId = null;
  state().sessionAgent = null;
  state().pendingNewSession = true;
  state().browserRunning = false;

  // 重置 context ring
  state().contextTokens = null;
  state().contextWindow = null;
  state().contextPercent = null;
  state().browserUrl = null;
  state().browserThumbnail = null;
  const { renderBrowserCard } = (window as any).HanaModules.artifacts;
  renderBrowserCard();
  ctx!.updateFolderButton();
  ctx!.loadDeskFiles('', state().selectedFolder || state().homeFolder);
  renderSessionList();
  ctx!.renderWelcomeAgentSelector();
  (document.getElementById('inputBox') as HTMLElement | null)?.focus();
}

async function ensureSession(): Promise<boolean> {
  if (!state().pendingNewSession) return true;

  try {
    const body: Record<string, any> = { memoryEnabled: state().memoryEnabled };
    if (state().selectedFolder) {
      body.cwd = state().selectedFolder;
    }
    if (state().selectedAgentId && state().selectedAgentId !== state().currentAgentId) {
      body.agentId = state().selectedAgentId;
    }
    const res = await ctx!.hanaFetch('/api/sessions/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) {
      console.error('[session] create failed:', data.error);
      return false;
    }

    state().pendingNewSession = false;
    const justSelected = state().selectedFolder;
    state().selectedFolder = null;

    if (data.agentId) {
      const switched = data.agentId !== state().currentAgentId;
      state().currentAgentId = data.agentId;
      if (data.agentName) state().agentName = data.agentName;
      if (switched) {
        const ag = state().agents.find((a: any) => a.id === data.agentId);
        if (ag?.yuan) state().agentYuan = ag.yuan;
        state().agentAvatarUrl = null;
        (window as any).i18n.defaultName = state().agentName;
        ctx!.loadAvatars();
      }
    }
    state().selectedAgentId = null;
    if (data.path) {
      state().currentSessionPath = data.path;
      // 初始化空 session，ChatArea 自动渲染
      (window as any).__zustandStore?.getState()?.initSession?.(data.path, [], false);
    }
    await loadSessions();
    ctx!.updateFolderButton();

    if (justSelected) {
      state().cwdHistory = state().cwdHistory.filter((p: string) => p !== justSelected);
      state().cwdHistory.unshift(justSelected);
      if (state().cwdHistory.length > 10) state().cwdHistory.length = 10;
    }

    ctx!.loadDeskFiles('');

    return true;
  } catch (err) {
    console.error('[session] create failed:', err);
    return false;
  }
}

async function archiveSession(path: string): Promise<void> {
  try {
    const res = await ctx!.hanaFetch('/api/sessions/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (data.error) {
      console.error('[session] archive failed:', data.error);
      _showSidebarToast((window as any).t('session.archiveFailed'));
      return;
    }

    if (path === state().currentSessionPath) {
      state().currentSessionPath = null;
      ctx!.clearChat();
    }

    await loadSessions();

    if (state().sessions.length === 0) {
      await createNewSession();
    } else if (!state().currentSessionPath) {
      await switchSession(state().sessions[0].path);
    }
  } catch (err) {
    console.error('[session] archive failed:', err);
    _showSidebarToast((window as any).t('session.archiveFailed'));
  }
}

function _showSidebarToast(text: string, duration = 3000): void {
  const el = document.createElement('div');
  el.className = 'sidebar-toast';
  el.textContent = text;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, duration);
}

// ══════════════════════════════════════════════════════
// 统一空间管理系统
// ══════════════════════════════════════════════════════

const CHAT_MIN_WIDTH = 400;

function getSidebarWidth(): number {
  return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width')) || 240;
}
function getJianWidth(): number {
  return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--jian-sidebar-width')) || 260;
}
function getPreviewWidth(): number {
  return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--preview-panel-width')) || 580;
}

function toggleSidebar(forceOpen?: boolean): void {
  state().sidebarOpen = forceOpen !== undefined ? forceOpen : !state().sidebarOpen;
  const tab = state().currentTab || 'chat';
  localStorage.setItem(`hana-sidebar-${tab}`, state().sidebarOpen ? 'open' : 'closed');
  if (forceOpen === undefined) {
    state().sidebarAutoCollapsed = false;
  }
  if (state().sidebarOpen) hideFloatCard();
  applySidebarState();
  updateTbToggleState();
}

function applySidebarState(): void {
  const sidebar = ctx!.$('#sidebar');
  if (state().sidebarOpen) {
    sidebar?.classList.remove('collapsed');
  } else {
    sidebar?.classList.add('collapsed');
  }
}

function updateTbToggleState(): void {
  const tbToggleLeft = ctx!.$('#tbToggleLeft');
  const tbToggleRight = ctx!.$('#tbToggleRight');
  tbToggleLeft?.classList.toggle('active', state().sidebarOpen);
  tbToggleRight?.classList.toggle('active', state().jianOpen);
  if (tbToggleRight) {
    tbToggleRight.title = state().currentTab === 'channels'
      ? (window as any).t('channel.info') : ((window as any).t('sidebar.jian') || '书桌');
  }
}

function updateLayout(): void {
  const w = window.innerWidth;
  const leftW = state().sidebarOpen ? getSidebarWidth() : 0;
  const rightW = state().jianOpen ? getJianWidth() : 0;
  const previewW = state().previewOpen ? getPreviewWidth() : 0;
  const contentW = w - leftW - rightW - previewW;

  if (contentW < CHAT_MIN_WIDTH) {
    if (state().jianOpen) {
      state().jianOpen = false;
      state().jianAutoCollapsed = true;
      const jianSidebar = ctx!.$('#jianSidebar');
      jianSidebar?.classList.add('collapsed');
      updateTbToggleState();
      const newContentW = w - (state().sidebarOpen ? getSidebarWidth() : 0) - previewW;
      if (newContentW < CHAT_MIN_WIDTH && state().sidebarOpen) {
        state().sidebarOpen = false;
        state().sidebarAutoCollapsed = true;
        applySidebarState();
        updateTbToggleState();
      }
    } else if (state().sidebarOpen) {
      state().sidebarOpen = false;
      state().sidebarAutoCollapsed = true;
      applySidebarState();
      updateTbToggleState();
    }
  } else {
    if (state().sidebarAutoCollapsed) {
      const neededForLeft = getSidebarWidth();
      if (w - rightW - previewW - neededForLeft >= CHAT_MIN_WIDTH) {
        const tab = state().currentTab || 'chat';
        const savedLeft = localStorage.getItem(`hana-sidebar-${tab}`);
        if (savedLeft !== 'closed') {
          state().sidebarOpen = true;
          state().sidebarAutoCollapsed = false;
          applySidebarState();
          updateTbToggleState();
        }
      }
    }
    if (state().jianAutoCollapsed) {
      const leftW2 = state().sidebarOpen ? getSidebarWidth() : 0;
      const neededForRight = getJianWidth();
      if (w - leftW2 - previewW - neededForRight >= CHAT_MIN_WIDTH) {
        const tab2 = state().currentTab || 'chat';
        const savedRight = localStorage.getItem(`hana-jian-${tab2}`);
        if (savedRight !== 'closed') {
          state().jianOpen = true;
          state().jianAutoCollapsed = false;
          const jianSidebar = ctx!.$('#jianSidebar');
          jianSidebar?.classList.remove('collapsed');
          updateTbToggleState();
        }
      }
    }
  }
}

function initSidebar(): void {
  const legacy = localStorage.getItem('hana-sidebar');
  if (legacy && !localStorage.getItem('hana-sidebar-chat')) {
    localStorage.setItem('hana-sidebar-chat', legacy);
  }
  const savedOpen = localStorage.getItem('hana-sidebar-chat');
  state().sidebarOpen = savedOpen !== 'closed';
  state().sidebarAutoCollapsed = false;
  state().jianAutoCollapsed = false;

  applySidebarState();
  updateTbToggleState();

  ctx!.$('#newSessionBtn')?.addEventListener('click', createNewSession);
  ctx!.$('#folderSelectBtn')?.addEventListener('click', () => {
    const { selectFolder } = (window as any).HanaModules.desk;
    selectFolder();
  });
  ctx!.$('#sidebarCollapseBtn')?.addEventListener('click', () => toggleSidebar());
  ctx!.$('#tbToggleLeft')?.addEventListener('click', () => toggleSidebar());
  ctx!.$('#tbToggleRight')?.addEventListener('click', () => {
    const { toggleJianSidebar } = (window as any).HanaModules.desk;
    toggleJianSidebar();
  });

  initFloatingPreview();

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      updateLayout();
      resizeTimer = null;
    }, 50);
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      toggleSidebar();
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      createNewSession();
    }
    if (e.key === 'Escape' && state().previewOpen) {
      const { closePreview } = (window as any).HanaModules.artifacts;
      closePreview();
    }
  });

  ctx!.$('#previewCloseBtn')?.addEventListener('click', () => {
    const { closePreview } = (window as any).HanaModules.artifacts;
    closePreview();
  });
  ctx!.$('#previewCopyBtn')?.addEventListener('click', () => {
    const artifact = state().artifacts.find((a: any) => a.id === state().currentArtifactId);
    if (artifact) {
      navigator.clipboard.writeText(artifact.content).then(() => {
        const btn = ctx!.$('#previewCopyBtn');
        btn.title = '已复制';
        setTimeout(() => { btn.title = '复制'; }, 1500);
      });
    }
  });
}

function initSidebarResize(): void {
  const root = document.documentElement;
  const sidebarEl = ctx!.$('#sidebar');
  const jianSidebarEl = ctx!.$('#jianSidebar');
  const leftHandle = ctx!.$('#sidebarResizeHandle');
  const rightHandle = ctx!.$('#jianResizeHandle');
  const previewPanel = ctx!.$('#previewPanel');

  const LEFT_MIN = 180, LEFT_MAX = 400;
  const RIGHT_MIN = 200, RIGHT_MAX = 600;

  const leftInner = sidebarEl?.querySelector('.sidebar-inner') as HTMLElement | null;
  const rightInner = jianSidebarEl?.querySelector('.jian-sidebar-inner') as HTMLElement | null;

  function applySidebarWidth(w: number): void {
    const px = w + 'px';
    root.style.setProperty('--sidebar-width', px);
    if (leftInner) { leftInner.style.width = px; leftInner.style.minWidth = px; }
  }

  function applyJianWidth(w: number): void {
    const px = w + 'px';
    root.style.setProperty('--jian-sidebar-width', px);
    if (rightInner) { rightInner.style.width = px; rightInner.style.minWidth = px; }
    updateJianColumns(w);
  }

  const savedLeft = localStorage.getItem('hana-sidebar-width');
  const savedRight = localStorage.getItem('hana-jian-width');
  if (savedLeft) applySidebarWidth(Number(savedLeft));
  if (savedRight) applyJianWidth(Number(savedRight));

  function updateJianColumns(w: number): void {
    const cols = w > 520 ? 3 : w > 350 ? 2 : 1;
    root.style.setProperty('--jian-columns', String(cols));
  }

  function setupHandle(
    handle: HTMLElement | null,
    getSidebar: () => HTMLElement | null,
    getWidth: () => number,
    setWidth: (w: number) => void,
    min: number,
    max: number,
    storageKey: string,
    isRight: boolean,
  ): void {
    if (!handle) return;

    handle.addEventListener('mousemove', (e: MouseEvent) => {
      const rect = handle.getBoundingClientRect();
      handle.style.setProperty('--handle-y', (e.clientY - rect.top) + 'px');
    });
    handle.addEventListener('mouseleave', () => {
      handle.style.setProperty('--handle-y', '-999px');
    });

    handle.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();
      const sidebarTarget = getSidebar();
      if (!sidebarTarget || sidebarTarget.classList.contains('collapsed')) return;

      const startX = e.clientX;
      const startW = getWidth();
      handle.classList.add('active');
      document.body.classList.add('resizing');

      function onMove(e: MouseEvent): void {
        const delta = isRight ? startX - e.clientX : e.clientX - startX;
        const w = Math.max(min, Math.min(max, startW + delta));
        setWidth(w);
        const rect = handle!.getBoundingClientRect();
        handle!.style.setProperty('--handle-y', (e.clientY - rect.top) + 'px');
      }

      function onUp(): void {
        handle!.classList.remove('active');
        document.body.classList.remove('resizing');
        handle!.style.setProperty('--handle-y', '-999px');
        const w = getWidth();
        localStorage.setItem(storageKey, String(w));
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  setupHandle(
    leftHandle,
    () => sidebarEl,
    () => sidebarEl?.offsetWidth || 240,
    (w) => applySidebarWidth(w),
    LEFT_MIN, LEFT_MAX, 'hana-sidebar-width', false,
  );

  setupHandle(
    rightHandle,
    () => jianSidebarEl,
    () => jianSidebarEl?.offsetWidth || 260,
    (w) => applyJianWidth(w),
    RIGHT_MIN, RIGHT_MAX, 'hana-jian-width', true,
  );

  const previewHandle = ctx!.$('#previewResizeHandle');
  const PREVIEW_MIN = 320, PREVIEW_MAX = 800;
  const previewInner = previewPanel?.querySelector('.preview-panel-inner') as HTMLElement | null;

  function applyPreviewWidth(w: number): void {
    const px = w + 'px';
    document.documentElement.style.setProperty('--preview-panel-width', px);
    if (previewInner) { previewInner.style.width = px; previewInner.style.minWidth = px; }
  }

  const savedPreview = localStorage.getItem('hana-preview-width');
  if (savedPreview) applyPreviewWidth(Number(savedPreview));

  setupHandle(
    previewHandle,
    () => previewPanel,
    () => previewPanel?.offsetWidth || 580,
    (w) => applyPreviewWidth(w),
    PREVIEW_MIN, PREVIEW_MAX, 'hana-preview-width', true,
  );
}

// ══════════════════════════════════════════════════════
// 浮动卡片预览
// ══════════════════════════════════════════════════════

function initFloatingPreview(): void {
  const tbLeft = ctx!.$('#tbToggleLeft');
  const tbRight = ctx!.$('#tbToggleRight');

  setupFloat(tbLeft, 'left', () => !state().sidebarOpen, buildSessionList);
  setupFloat(tbRight, 'right', () => !state().jianOpen, buildDeskList);
}

function setupFloat(
  trigger: HTMLElement | null,
  side: string,
  isCollapsed: () => boolean,
  buildContent: (card: HTMLElement) => void,
): void {
  if (!trigger) return;

  trigger.addEventListener('mouseenter', () => {
    if (!isCollapsed()) return;
    if (_floatTimer) clearTimeout(_floatTimer);
    if (_floatEnterTimer) clearTimeout(_floatEnterTimer);
    _floatEnterTimer = setTimeout(() => {
      if (!isCollapsed()) return;
      showFloatCard(trigger, side, buildContent);
    }, 500);
  });

  trigger.addEventListener('mouseleave', () => {
    if (_floatEnterTimer) clearTimeout(_floatEnterTimer);
    _floatTimer = setTimeout(hideFloatCard, 200);
  });
}

function showFloatCard(
  trigger: HTMLElement,
  side: string,
  buildContent: (card: HTMLElement) => void,
): void {
  hideFloatCard();
  const card = document.createElement('div');
  card.className = 'float-card float-card-' + side;
  buildContent(card);
  document.body.appendChild(card);

  const rect = trigger.getBoundingClientRect();
  card.style.top = (rect.bottom + 6) + 'px';
  if (side === 'left') {
    card.style.left = rect.left + 'px';
  } else {
    card.style.right = (window.innerWidth - rect.right) + 'px';
  }

  card.addEventListener('mouseenter', () => { if (_floatTimer) clearTimeout(_floatTimer); });
  card.addEventListener('mouseleave', hideFloatCard);
  _floatCard = card;

  requestAnimationFrame(() => card.classList.add('visible'));
}

function hideFloatCard(): void {
  if (_floatEnterTimer) clearTimeout(_floatEnterTimer);
  if (_floatTimer) clearTimeout(_floatTimer);
  if (_floatCard) {
    _floatCard.remove();
    _floatCard = null;
  }
}

function buildSessionList(card: HTMLElement): void {
  const sessions = state().sessions || [];
  if (sessions.length === 0) {
    card.innerHTML = `<div class="float-card-empty">暂无对话</div>`;
    return;
  }
  const list = document.createElement('div');
  list.className = 'float-card-list';
  for (const s of sessions.slice(0, 12)) {
    const item = document.createElement('div');
    item.className = 'float-card-item';
    if (s.path === state().currentSessionPath) item.classList.add('active');

    const avatar = document.createElement('img') as HTMLImageElement;
    avatar.className = 'float-card-avatar';
    avatar.draggable = false;
    if (s.agentId) {
      avatar.src = ctx!.hanaUrl(`/api/agents/${s.agentId}/avatar?t=${Date.now()}`);
      avatar.onerror = () => { avatar.onerror = null; const a = state().agents.find((x: any) => x.id === s.agentId); avatar.src = ctx!.yuanFallbackAvatar(a?.yuan); };
    } else {
      avatar.src = ctx!.yuanFallbackAvatar(state().agentYuan);
    }
    item.appendChild(avatar);

    const text = document.createElement('span');
    text.className = 'float-card-item-text';
    text.textContent = s.title || '新对话';
    item.appendChild(text);

    item.addEventListener('click', () => {
      hideFloatCard();
      switchSession(s.path);
    });
    list.appendChild(item);
  }
  card.appendChild(list);

  const bar = document.createElement('div');
  bar.className = 'float-card-bar';

  const newBtn = document.createElement('div');
  newBtn.className = 'float-card-bar-btn';
  newBtn.textContent = '+ ' + (window as any).t('sidebar.newChat');
  newBtn.addEventListener('click', () => {
    hideFloatCard();
    createNewSession();
  });
  bar.appendChild(newBtn);

  const divider = document.createElement('span');
  divider.className = 'float-card-bar-divider';
  bar.appendChild(divider);

  const settingsBtn = document.createElement('div');
  settingsBtn.className = 'float-card-bar-btn float-card-bar-icon';
  settingsBtn.title = (window as any).t('settings.title');
  settingsBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;
  settingsBtn.addEventListener('click', () => {
    hideFloatCard();
    (window as any).platform?.openSettings();
  });
  bar.appendChild(settingsBtn);

  card.appendChild(bar);
}

function buildDeskList(card: HTMLElement): void {
  const files = state().deskFiles || [];
  if (files.length === 0) {
    card.innerHTML = `<div class="float-card-empty">书桌为空</div>`;
  } else {
    const list = document.createElement('div');
    list.className = 'float-card-list';
    for (const f of files.slice(0, 12)) {
      const item = document.createElement('div');
      item.className = 'float-card-item';
      if (f.isDir) item.classList.add('is-dir');
      item.textContent = f.isDir ? `${f.name}/` : f.name;
      list.appendChild(item);
    }
    card.appendChild(list);
  }

  const jianWrap = document.createElement('div');
  jianWrap.className = 'float-card-jian';
  const jianLabel = document.createElement('div');
  jianLabel.className = 'float-card-jian-label';
  jianLabel.textContent = '笺';
  jianWrap.appendChild(jianLabel);

  const textarea = document.createElement('textarea');
  textarea.className = 'float-card-jian-input';
  textarea.placeholder = '写点什么…';
  textarea.spellcheck = false;
  textarea.value = state().deskJianContent || '';

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  textarea.addEventListener('input', () => {
    state().deskJianContent = textarea.value;
    const mainTextarea = ctx!.$('#jianEditorInput');
    if (mainTextarea) mainTextarea.value = textarea.value;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const { saveJianContent } = (window as any).HanaModules.desk;
      if (saveJianContent) saveJianContent();
    }, 800);
  });

  jianWrap.appendChild(textarea);
  card.appendChild(jianWrap);
}

function initSidebarModule(injected: Record<string, any>): void {
  ctx = injected;
}

// ══════════════════════════════════════════════════════
// 导出
// ══════════════════════════════════════════════════════

export function setupSidebarShim(modules: Record<string, unknown>): void {
  modules.sidebar = {
    loadSessions, renderSessionList, switchSession,
    createNewSession, ensureSession, archiveSession,
    toggleSidebar, updateTbToggleState, updateLayout,
    initSidebar, initSidebarResize,
    initSidebarModule,
    dismissFloat: hideFloatCard,
  };
}
