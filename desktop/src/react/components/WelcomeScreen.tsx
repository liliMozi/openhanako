/**
 * WelcomeScreen — 欢迎页 React 组件
 *
 * Phase 6C: 替代 app-agents-shim.ts 中的 renderWelcomeAgentSelector / updateWelcomeForAgent
 * 以及 bridge.ts desk shim 中的 folder picker / memory toggle。
 * 通过 portal 渲染到 #welcome，从 Zustand 状态驱动。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../stores';
import { hanaUrl, hanaFetch } from '../hooks/use-hana-fetch';
import { useI18n } from '../hooks/use-i18n';
import { loadModels } from '../utils/ui-helpers';
import { loadDeskFiles } from '../stores/desk-actions';
import { clearChat } from '../stores/agent-actions';
import type { Agent } from '../types';
import { yuanFallbackAvatar } from '../utils/agent-helpers';
import styles from './Welcome.module.css';

/* eslint-disable @typescript-eslint/no-explicit-any -- store setState 回调 (s: any) */

// ── 稳定头像时间戳（避免每次渲染生成新 URL） ──
let _avatarTs = Date.now();
export function refreshAvatarTs() { _avatarTs = Date.now(); }

// ── 主组件 ──

export function WelcomeScreen() {
  return <WelcomeInner />;
}

// ── Yuan helpers ──

function randomWelcome(agentName: string, yuan: string): string {
  const t = window.t ?? ((p: string) => p);
  const yuanMsgs = t(`yuan.welcome.${yuan}`);
  const msgs = Array.isArray(yuanMsgs) ? yuanMsgs : t('welcome.messages');
  if (!Array.isArray(msgs) || msgs.length === 0) return '';
  const raw = msgs[Math.floor(Math.random() * msgs.length)];
  return raw.replaceAll('{name}', agentName);
}

// ── 内部组件 ──

function WelcomeInner() {
  const { t } = useI18n();
  const welcomeVisible = useStore(s => s.welcomeVisible);
  const agents = useStore(s => s.agents);
  const agentName = useStore(s => s.agentName);
  const agentAvatarUrl = useStore(s => s.agentAvatarUrl);
  const agentYuan = useStore(s => s.agentYuan);
  const currentAgentId = useStore(s => s.currentAgentId);
  const selectedAgentId = useStore(s => s.selectedAgentId);
  const memoryEnabled = useStore(s => s.memoryEnabled);
  const selectedFolder = useStore(s => s.selectedFolder);
  const cwdHistory = useStore(s => s.cwdHistory);
  const pendingNewSession = useStore(s => s.pendingNewSession);

  // Determine the displayed agent
  const displayAgent = useMemo(() => {
    const sel = selectedAgentId || currentAgentId;
    return agents.find(a => a.id === sel) || null;
  }, [agents, selectedAgentId, currentAgentId]);

  const displayName = displayAgent?.name || agentName;
  const displayYuan = displayAgent?.yuan || agentYuan;

  // Greeting text — regenerate when agent changes or welcome becomes visible
  const [greeting, setGreeting] = useState('');
  const prevAgentRef = useRef<string | null>(null);

  useEffect(() => {
    const agentKey = displayAgent?.id || currentAgentId;
    if (welcomeVisible && (prevAgentRef.current !== agentKey || !greeting)) {
      setGreeting(randomWelcome(displayName, displayYuan));
      prevAgentRef.current = agentKey ?? null;
    }
  }, [welcomeVisible, displayAgent?.id, currentAgentId, displayName, displayYuan, greeting]);

  // Re-randomize greeting when welcome becomes visible again
  useEffect(() => {
    if (welcomeVisible) {
      setGreeting(randomWelcome(displayName, displayYuan));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在 welcomeVisible 切换时重新随机，不跟踪 displayName/displayYuan 变化
  }, [welcomeVisible]);

  if (!welcomeVisible) return null;

  return (
    <div className={styles.welcome}>
      <WelcomeAvatar
        agentId={displayAgent?.id || null}
        hasAvatar={displayAgent?.hasAvatar ?? false}
        agentAvatarUrl={agentAvatarUrl}
        yuan={displayYuan}
        name={displayName}
      />
      <p className={styles.welcomeText}>{greeting}</p>
      {agents.length >= 2 && (
        <AgentChips
          agents={agents}
          selectedId={selectedAgentId || currentAgentId}
        />
      )}
      <FolderPicker
        selectedFolder={selectedFolder}
        cwdHistory={cwdHistory}
        pendingNewSession={pendingNewSession}
      />
      <MemoryToggle enabled={memoryEnabled} t={t} />
    </div>
  );
}

// ── Welcome Avatar ──

function WelcomeAvatar({ agentId, hasAvatar, agentAvatarUrl, yuan, name }: {
  agentId: string | null;
  hasAvatar: boolean;
  agentAvatarUrl: string | null;
  yuan: string;
  name: string;
}) {
  const [src, setSrc] = useState(() => {
    if (agentId && hasAvatar) return hanaUrl(`/api/agents/${agentId}/avatar?t=${_avatarTs}`);
    return yuanFallbackAvatar(yuan);
  });

  useEffect(() => {
    if (agentId && hasAvatar) {
      setSrc(hanaUrl(`/api/agents/${agentId}/avatar?t=${_avatarTs}`));
    } else {
      setSrc(yuanFallbackAvatar(yuan));
    }
  }, [agentId, hasAvatar, yuan]);

  const handleError = useCallback(() => {
    setSrc(yuanFallbackAvatar(yuan));
  }, [yuan]);

  const handleClick = useCallback(() => {
    window.platform?.openSettings?.('agent');
  }, []);

  return (
    <img
      className={styles.welcomeAvatar}
      src={src}
      alt={name}
      draggable={false}
      onClick={handleClick}
      onError={handleError}
    />
  );
}

// ── Agent Chips ──

function AgentChips({ agents, selectedId }: {
  agents: Agent[];
  selectedId: string | null;
}) {
  const handleClick = useCallback((agentId: string) => {
    useStore.setState({ selectedAgentId: agentId });
    // 切换到该 agent 的 chat model
    const agent = agents.find(a => a.id === agentId) as any;
    if (agent?.chatModel?.id) {
      hanaFetch('/api/models/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: agent.chatModel.id, provider: agent.chatModel.provider }),
      }).then(() => loadModels()).catch(() => {});
    }
  }, [agents]);

  return (
    <div className={styles.welcomeAgentSelector}>
      {agents.map(agent => (
        <AgentChip
          key={agent.id}
          agent={agent}
          isSelected={agent.id === selectedId}
          onClick={handleClick}
        />
      ))}
    </div>
  );
}

function AgentChip({ agent, isSelected, onClick }: {
  agent: Agent;
  isSelected: boolean;
  onClick: (id: string) => void;
}) {
  const [src, setSrc] = useState(() =>
    agent.hasAvatar ? hanaUrl(`/api/agents/${agent.id}/avatar?t=${_avatarTs}`) : yuanFallbackAvatar(agent.yuan),
  );

  const handleError = useCallback(() => {
    setSrc(yuanFallbackAvatar(agent.yuan));
  }, [agent.yuan]);

  const handleClick = useCallback(() => {
    onClick(agent.id);
  }, [agent.id, onClick]);

  return (
    <button
      className={`${styles.welcomeAgentChip}${isSelected ? ` ${styles.welcomeAgentChipSelected}` : ''}`}
      onClick={handleClick}
    >
      <img
        className={styles.welcomeAgentChipAvatar}
        src={src}
        draggable={false}
        onError={handleError}
      />
      <span>{agent.name}</span>
    </button>
  );
}

// ── Folder Picker ──

function FolderPicker({ selectedFolder, cwdHistory, pendingNewSession }: {
  selectedFolder: string | null;
  cwdHistory: string[];
  pendingNewSession: boolean;
}) {
  const { t } = useI18n();
  const [showHistory, setShowHistory] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!showHistory) return;
    const close = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setShowHistory(false);
      }
    };
    const timer = setTimeout(() => document.addEventListener('click', close, true), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', close, true);
    };
  }, [showHistory]);

  const handleBrowse = useCallback(async () => {
    setShowHistory(false);
    const folder = await window.platform?.selectFolder?.();
    if (!folder) return;
    applyFolderAction(folder, pendingNewSession);
  }, [pendingNewSession]);

  const handleButtonClick = useCallback(() => {
    if (cwdHistory.length > 0) {
      setShowHistory(prev => !prev);
    } else {
      handleBrowse();
    }
  }, [cwdHistory.length, handleBrowse]);

  const handleSelectHistory = useCallback((folder: string) => {
    setShowHistory(false);
    applyFolderAction(folder, pendingNewSession);
  }, [pendingNewSession]);

  const folderName = selectedFolder ? selectedFolder.split('/').pop() || selectedFolder : null;
  const label = folderName
    ? `${t('input.workspace')}${folderName}`
    : t('input.selectWorkspace');

  return (
    <div
      className={`${styles.folderSelectWrap}${showHistory ? ` ${styles.folderSelectWrapShowHistory}` : ''}`}
      ref={wrapRef}
    >
      <button
        className={`${styles.folderSelectBtn}${selectedFolder ? ` ${styles.folderSelectBtnHasFolder}` : ''}`}
        onClick={handleButtonClick}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
        </svg>
        <span>{label}</span>
        <svg className={styles.folderSwapIcon} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="17 1 21 5 17 9"></polyline>
          <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
          <polyline points="7 23 3 19 7 15"></polyline>
          <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
        </svg>
      </button>
      {showHistory && (
        <FolderHistory
          cwdHistory={cwdHistory}
          selectedFolder={selectedFolder}
          onSelect={handleSelectHistory}
          onBrowse={handleBrowse}
        />
      )}
    </div>
  );
}

function FolderHistory({ cwdHistory, selectedFolder, onSelect, onBrowse }: {
  cwdHistory: string[];
  selectedFolder: string | null;
  onSelect: (folder: string) => void;
  onBrowse: () => void;
}) {
  return (
    <div className={styles.folderHistory}>
      {cwdHistory.map(p => {
        const name = p.split('/').pop() || p;
        const isActive = p === selectedFolder;
        return (
          <div
            key={p}
            className={`${styles.folderHistoryItem}${isActive ? ` ${styles.folderHistoryItemActive}` : ''}`}
            title={p}
            onClick={(e) => { e.stopPropagation(); onSelect(p); }}
          >
            <span className={styles.folderHistoryItemIcon}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
              </svg>
            </span>
            <span className={styles.folderHistoryItemName}>{name}</span>
          </div>
        );
      })}
      <div className={styles.folderHistoryDivider} />
      <div className={styles.folderHistoryBrowse} onClick={(e) => { e.stopPropagation(); onBrowse(); }}>
        <span className={styles.folderHistoryItemIcon}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            <line x1="12" y1="11" x2="12" y2="17"></line>
            <line x1="9" y1="14" x2="15" y2="14"></line>
          </svg>
        </span>
        <span>{(window.t ?? ((p: string) => p))('input.selectFolder')}...</span>
      </div>
    </div>
  );
}

/** Apply folder selection — core logic preserved from bridge.ts desk shim */
function applyFolderAction(folder: string, pendingNewSession: boolean): void {
  useStore.setState({ selectedFolder: folder });

  if (!pendingNewSession) {
    useStore.setState({
      currentSessionPath: null,
      pendingNewSession: true,
    });
    clearChat();
    useStore.getState().requestInputFocus();
  }

  // Load desk files for the new folder
  loadDeskFiles('', folder);
}

// ── Memory Toggle ──

function MemoryToggle({ enabled, t }: {
  enabled: boolean;
  t: (key: string) => string;
}) {
  const handleClick = useCallback(() => {
    useStore.setState((s: any) => ({ memoryEnabled: !s.memoryEnabled }));
  }, []);

  return (
    <button
      className={`${styles.memoryToggleBtn}${enabled ? ` ${styles.memoryToggleBtnActive}` : ''}`}
      onClick={handleClick}
    >
      <svg className={styles.memoryToggleIcon} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2 L22 12 L12 22 L2 12 Z" />
      </svg>
      <span>{t(enabled ? 'welcome.memoryOn' : 'welcome.memoryOff')}</span>
    </button>
  );
}
