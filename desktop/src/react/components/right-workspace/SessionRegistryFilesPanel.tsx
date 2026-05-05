import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { useStore } from '../../stores';
import { selectSessionFiles } from '../../stores/selectors/file-refs';
import type { FileRef } from '../../types/file-ref';
import type { ContextMenuItem } from '../ContextMenu';
import { ContextMenu } from '../ContextMenu';
import { openFilePreview } from '../../utils/file-preview';
import { extOfName, isMediaKind } from '../../utils/file-kind';
import { openMediaViewerForRef } from '../../utils/open-media-viewer';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import styles from './RightWorkspacePanel.module.css';

const EMPTY_FILES: readonly FileRef[] = Object.freeze([]);
const SESSION_FILE_SORT_KEY = 'hana-session-file-sort';
const RUBBER_BAND_MIN = 4;

type SessionFileSortMode = 'time-desc' | 'name-asc' | 'name-desc' | 'type-asc';

type BridgePlatform = 'feishu' | 'telegram' | 'whatsapp' | 'qq' | 'wechat';

interface BridgeSessionSummary {
  sessionKey: string;
  chatId: string;
  displayName?: string;
}

interface BridgeSendTarget {
  agentId: string;
  agentName: string;
  platform: BridgePlatform;
  platformLabel: string;
  sessionKey: string;
  chatId: string;
  displayName?: string;
}

type MenuState =
  | { type: 'sort'; items: ContextMenuItem[]; position: { x: number; y: number } }
  | { type: 'file'; file: FileRef; position: { x: number; y: number } };

const BRIDGE_PLATFORMS: BridgePlatform[] = ['feishu', 'telegram', 'whatsapp', 'qq', 'wechat'];

const BRIDGE_PLATFORM_LABEL_KEYS: Record<BridgePlatform, string> = {
  feishu: 'settings.bridge.feishu',
  telegram: 'settings.bridge.telegram',
  whatsapp: 'settings.bridge.whatsapp',
  qq: 'settings.bridge.qq',
  wechat: 'settings.bridge.wechat',
};

const BRIDGE_PLATFORM_FALLBACK_LABELS: Record<BridgePlatform, string> = {
  feishu: 'Feishu',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  qq: 'QQ',
  wechat: 'WeChat',
};

function tr(key: string, vars?: Record<string, string | number>): string {
  return (window.t ?? ((path: string) => path))(key, vars);
}

function statusLabel(file: FileRef): string {
  if (file.status === 'expired') return tr('rightWorkspace.sessionFiles.status.expired');
  return tr('rightWorkspace.sessionFiles.status.available');
}

function sourceLabel(file: FileRef): string {
  return file.source;
}

function formatKind(file: FileRef): string {
  return (file.ext || file.kind || 'file').toUpperCase();
}

function isExpired(file: FileRef): boolean {
  return file.status === 'expired';
}

function canPreviewFile(file: FileRef): boolean {
  return !isExpired(file) && (!!file.path || (isMediaKind(file.kind) && !!file.inlineData));
}

function canUseFilePath(file: FileRef): boolean {
  return !isExpired(file) && !!file.path;
}

function canCopyFilePath(file: FileRef): boolean {
  return !!file.path;
}

function bridgePlatformLabel(platform: BridgePlatform): string {
  const key = BRIDGE_PLATFORM_LABEL_KEYS[platform];
  const label = tr(key);
  return label === key ? BRIDGE_PLATFORM_FALLBACK_LABELS[platform] : label;
}

function bridgeTargetLabel(target: BridgeSendTarget): string {
  const base = `${target.agentName || target.agentId}：${target.platformLabel}`;
  return target.displayName ? `${base} · ${target.displayName}` : base;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'unknown error');
}

function actionLabel(key: string, file: FileRef): string {
  return `${tr(key)} ${file.name}`;
}

function sortLabel(mode: SessionFileSortMode): string {
  const labelKeys: Record<SessionFileSortMode, string> = {
    'time-desc': 'rightWorkspace.sessionFiles.sort.timeDesc',
    'name-asc': 'rightWorkspace.sessionFiles.sort.nameAsc',
    'name-desc': 'rightWorkspace.sessionFiles.sort.nameDesc',
    'type-asc': 'rightWorkspace.sessionFiles.sort.typeAsc',
  };
  return tr(labelKeys[mode]);
}

function isSessionFileSortMode(value: string | null): value is SessionFileSortMode {
  return value === 'time-desc' || value === 'name-asc' || value === 'name-desc' || value === 'type-asc';
}

function getInitialSortMode(): SessionFileSortMode {
  try {
    const saved = window.localStorage?.getItem(SESSION_FILE_SORT_KEY) ?? null;
    return isSessionFileSortMode(saved) ? saved : 'time-desc';
  } catch {
    return 'time-desc';
  }
}

function sortSessionFiles(files: readonly FileRef[], mode: SessionFileSortMode): FileRef[] {
  const sorted = [...files];
  const byName = (a: FileRef, b: FileRef) => a.name.localeCompare(b.name, 'zh');
  sorted.sort((a, b) => {
    switch (mode) {
      case 'name-asc':
        return byName(a, b);
      case 'name-desc':
        return byName(b, a);
      case 'type-asc': {
        const extCompare = formatKind(a).localeCompare(formatKind(b), 'zh');
        return extCompare || byName(a, b);
      }
      case 'time-desc':
      default:
        return (b.timestamp ?? 0) - (a.timestamp ?? 0) || byName(a, b);
    }
  });
  return sorted;
}

function pathBackedFiles(files: readonly FileRef[], opts: { requireAvailable?: boolean } = {}): FileRef[] {
  return files.filter(file => !!file.path && (!opts.requireAvailable || !isExpired(file)));
}

function copyPaths(files: readonly FileRef[]): void {
  const paths = pathBackedFiles(files).map(file => file.path);
  if (paths.length === 0) return;
  navigator.clipboard?.writeText?.(paths.join('\n')).catch(() => {});
}

function previewFile(file: FileRef, sessionPath: string | null): void {
  if (!canPreviewFile(file)) return;
  if (isMediaKind(file.kind)) {
    openMediaViewerForRef(file, { origin: 'session', sessionPath: sessionPath ?? undefined });
    return;
  }
  if (!file.path) return;
  const ext = file.ext || extOfName(file.name) || '';
  void openFilePreview(file.path, file.name, ext, {
    origin: 'session',
    sessionPath: sessionPath ?? undefined,
    messageId: file.sessionMessageId,
    blockIdx: file.sessionBlockIdx,
  });
}

function openFile(file: FileRef): void {
  if (!canUseFilePath(file)) return;
  window.platform?.openFile?.(file.path);
}

function revealFile(file: FileRef): void {
  if (!canUseFilePath(file)) return;
  window.platform?.showInFinder?.(file.path);
}

function SortIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="7" y1="12" x2="17" y2="12" />
      <line x1="10" y1="18" x2="14" y2="18" />
    </svg>
  );
}

function FileKindIcon({ file }: { file: FileRef }) {
  if (file.kind === 'image' || file.kind === 'svg') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </svg>
    );
  }
  if (file.kind === 'video') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <polygon points="10 9 15 12 10 15 10 9" />
      </svg>
    );
  }
  if (file.kind === 'code') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function ActionIcon({ type }: { type: 'preview' | 'open' | 'reveal' | 'copy' }) {
  if (type === 'preview') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
        <circle cx="12" cy="12" r="2.5" />
      </svg>
    );
  }
  if (type === 'open') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </svg>
    );
  }
  if (type === 'reveal') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 6h7l2 2h9v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <circle cx="12" cy="14" r="2.5" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function SessionFileRow({
  file,
  sessionPath,
  selected,
  onSelect,
  onContextMenu,
  onDragStart,
}: {
  file: FileRef;
  sessionPath: string | null;
  selected: boolean;
  onSelect: (file: FileRef, meta: { multi: boolean; shift: boolean }) => void;
  onContextMenu: (event: React.MouseEvent, file: FileRef) => void;
  onDragStart: (event: React.DragEvent, file: FileRef) => void;
}) {
  const canPreview = canPreviewFile(file);
  const canUsePath = canUseFilePath(file);
  const canCopyPath = canCopyFilePath(file);

  const stopAction = (event: React.MouseEvent, action: () => void) => {
    event.stopPropagation();
    action();
  };

  const handleClick = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest('[data-session-file-action]')) return;
    onSelect(file, { multi: event.metaKey || event.ctrlKey, shift: event.shiftKey });
  };

  const handleDoubleClick = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest('[data-session-file-action]')) return;
    previewFile(file, sessionPath);
  };

  return (
    <article
      className={`${styles.fileRow}${selected ? ` ${styles.fileRowSelected}` : ''}`}
      data-testid="session-file-row"
      data-session-file-row=""
      data-file-id={file.id}
      data-selected={selected ? 'true' : 'false'}
      role="listitem"
      draggable={canUsePath}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={(event) => onContextMenu(event, file)}
      onDragStart={(event) => onDragStart(event, file)}
    >
      <div className={styles.fileIcon} aria-hidden="true">
        <FileKindIcon file={file} />
      </div>
      <div className={styles.fileMain}>
        <div className={styles.fileName} data-testid="session-file-name" title={file.name}>{file.name}</div>
        <div className={styles.fileMeta}>
          <span>{sourceLabel(file)}</span>
          <span>{formatKind(file)}</span>
          <span>{statusLabel(file)}</span>
        </div>
      </div>
      <div className={styles.fileActions}>
        <button
          type="button"
          className={styles.fileAction}
          data-session-file-action=""
          aria-label={actionLabel('rightWorkspace.sessionFiles.actions.preview', file)}
          title={actionLabel('rightWorkspace.sessionFiles.actions.preview', file)}
          disabled={!canPreview}
          onClick={(event) => stopAction(event, () => previewFile(file, sessionPath))}
        >
          <ActionIcon type="preview" />
        </button>
        <button
          type="button"
          className={styles.fileAction}
          data-session-file-action=""
          aria-label={actionLabel('rightWorkspace.sessionFiles.actions.open', file)}
          title={actionLabel('rightWorkspace.sessionFiles.actions.open', file)}
          disabled={!canUsePath}
          onClick={(event) => stopAction(event, () => openFile(file))}
        >
          <ActionIcon type="open" />
        </button>
        <button
          type="button"
          className={styles.fileAction}
          data-session-file-action=""
          aria-label={actionLabel('rightWorkspace.sessionFiles.actions.reveal', file)}
          title={actionLabel('rightWorkspace.sessionFiles.actions.reveal', file)}
          disabled={!canUsePath}
          onClick={(event) => stopAction(event, () => revealFile(file))}
        >
          <ActionIcon type="reveal" />
        </button>
        <button
          type="button"
          className={styles.fileAction}
          data-session-file-action=""
          aria-label={actionLabel('rightWorkspace.sessionFiles.actions.copyPath', file)}
          title={actionLabel('rightWorkspace.sessionFiles.actions.copyPath', file)}
          disabled={!canCopyPath}
          onClick={(event) => stopAction(event, () => copyPaths([file]))}
        >
          <ActionIcon type="copy" />
        </button>
      </div>
    </article>
  );
}

export function SessionRegistryFilesPanel() {
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const agents = useStore(s => s.agents);
  const currentAgentId = useStore(s => s.currentAgentId);
  const agentName = useStore(s => s.agentName);
  const files = useStore(s => (
    s.currentSessionPath ? selectSessionFiles(s, s.currentSessionPath) : EMPTY_FILES
  ));
  const [sortMode, setSortMode] = useState<SessionFileSortMode>(getInitialSortMode);
  const sortedFiles = useMemo(() => sortSessionFiles(files, sortMode), [files, sortMode]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const lastSelectedRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [bridgeTargets, setBridgeTargets] = useState<BridgeSendTarget[]>([]);
  const [bridgeTargetsLoaded, setBridgeTargetsLoaded] = useState(false);
  const [bridgeTargetsLoading, setBridgeTargetsLoading] = useState(false);
  const [bridgeTargetsError, setBridgeTargetsError] = useState<string | null>(null);
  const [rubberBandRect, setRubberBandRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const rubberBandRef = useRef<{ startX: number; startY: number } | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const bridgeLoadSeqRef = useRef(0);

  const bridgeAgents = useMemo(() => {
    if (agents.length > 0) return agents.map(agent => ({ id: agent.id, name: agent.name || agent.id }));
    if (!currentAgentId) return [];
    return [{ id: currentAgentId, name: agentName || currentAgentId }];
  }, [agentName, agents, currentAgentId]);

  useEffect(() => {
    setSelectedIds(new Set());
    lastSelectedRef.current = null;
  }, [currentSessionPath]);

  useEffect(() => {
    bridgeLoadSeqRef.current += 1;
    setBridgeTargets([]);
    setBridgeTargetsLoaded(false);
    setBridgeTargetsLoading(false);
    setBridgeTargetsError(null);
  }, [bridgeAgents]);

  useEffect(() => {
    const liveIds = new Set(sortedFiles.map(file => file.id));
    setSelectedIds(prev => {
      const next = new Set([...prev].filter(id => liveIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
    if (lastSelectedRef.current && !liveIds.has(lastSelectedRef.current)) {
      lastSelectedRef.current = null;
    }
  }, [sortedFiles]);

  useEffect(() => () => cleanupRef.current?.(), []);

  const selectedFiles = useMemo(
    () => sortedFiles.filter(file => selectedIds.has(file.id)),
    [sortedFiles, selectedIds],
  );

  const loadBridgeTargets = useCallback(async (force = false) => {
    if (bridgeTargetsLoading || (bridgeTargetsLoaded && !force)) return;
    const seq = ++bridgeLoadSeqRef.current;
    setBridgeTargetsLoading(true);
    setBridgeTargetsError(null);
    if (force) {
      setBridgeTargets([]);
      setBridgeTargetsLoaded(false);
    }
    try {
      const targets: BridgeSendTarget[] = [];
      await Promise.all(bridgeAgents.map(async agent => {
        await Promise.all(BRIDGE_PLATFORMS.map(async platform => {
          const res = await hanaFetch(`/api/bridge/sessions?platform=${encodeURIComponent(platform)}&agentId=${encodeURIComponent(agent.id)}`);
          const data = await res.json().catch(() => ({ sessions: [] }));
          const sessions = Array.isArray(data.sessions) ? data.sessions as BridgeSessionSummary[] : [];
          for (const session of sessions) {
            if (!session?.chatId) continue;
            targets.push({
              agentId: agent.id,
              agentName: agent.name,
              platform,
              platformLabel: bridgePlatformLabel(platform),
              sessionKey: session.sessionKey,
              chatId: session.chatId,
              displayName: session.displayName,
            });
          }
        }));
      }));
      if (bridgeLoadSeqRef.current !== seq) return;
      setBridgeTargets(targets);
      setBridgeTargetsLoaded(true);
    } catch (err) {
      if (bridgeLoadSeqRef.current !== seq) return;
      const message = errorMessage(err);
      setBridgeTargets([]);
      setBridgeTargetsLoaded(true);
      setBridgeTargetsError(message);
      useStore.getState().addToast(tr('rightWorkspace.sessionFiles.bridgeLoadFailed', { error: message }), 'error');
    } finally {
      if (bridgeLoadSeqRef.current === seq) {
        setBridgeTargetsLoading(false);
      }
    }
  }, [bridgeAgents, bridgeTargetsLoaded, bridgeTargetsLoading]);

  const sendFilesToBridge = useCallback(async (filesToSend: FileRef[], target: BridgeSendTarget) => {
    const sendableFiles = pathBackedFiles(filesToSend, { requireAvailable: true });
    if (sendableFiles.length === 0) return;
    const targetLabel = bridgeTargetLabel(target);
    try {
      for (const file of sendableFiles) {
        const res = await hanaFetch(`/api/bridge/send-media?agentId=${encodeURIComponent(target.agentId)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            platform: target.platform,
            chatId: target.chatId,
            filePath: file.path,
            label: file.name,
            sessionPath: currentSessionPath ?? undefined,
          }),
        });
        const data = await res.json().catch(() => null);
        if (data && data.ok === false) {
          throw new Error(data.error || 'bridge media send failed');
        }
      }
      useStore.getState().addToast(
        tr('rightWorkspace.sessionFiles.sendSuccess', { target: targetLabel, n: sendableFiles.length }),
        'success',
      );
    } catch (err) {
      useStore.getState().addToast(
        tr('rightWorkspace.sessionFiles.sendFailed', { target: targetLabel, error: errorMessage(err) }),
        'error',
      );
    }
  }, [currentSessionPath]);

  const selectFile = useCallback((file: FileRef, meta: { multi: boolean; shift: boolean }) => {
    listRef.current?.focus();
    setSelectedIds(prev => {
      if (meta.shift && lastSelectedRef.current) {
        const from = sortedFiles.findIndex(item => item.id === lastSelectedRef.current);
        const to = sortedFiles.findIndex(item => item.id === file.id);
        if (from >= 0 && to >= 0) {
          const next = new Set(prev);
          const start = Math.min(from, to);
          const end = Math.max(from, to);
          for (let i = start; i <= end; i++) next.add(sortedFiles[i].id);
          return next;
        }
      }
      if (meta.multi) {
        const next = new Set(prev);
        if (next.has(file.id)) next.delete(file.id);
        else next.add(file.id);
        lastSelectedRef.current = file.id;
        return next;
      }
      lastSelectedRef.current = file.id;
      return new Set([file.id]);
    });
  }, [sortedFiles]);

  const filesForAction = useCallback((file: FileRef): FileRef[] => {
    if (selectedIdsRef.current.has(file.id)) {
      const selected = sortedFiles.filter(item => selectedIdsRef.current.has(item.id));
      return selected.length > 0 ? selected : [file];
    }
    return [file];
  }, [sortedFiles]);

  const handleSortClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const modes: SessionFileSortMode[] = ['time-desc', 'name-asc', 'name-desc', 'type-asc'];
    setMenu({
      type: 'sort',
      position: { x: rect.left, y: rect.bottom + 4 },
      items: modes.map(mode => ({
        label: sortLabel(mode),
        action: () => {
          setSortMode(mode);
          try {
            window.localStorage?.setItem(SESSION_FILE_SORT_KEY, mode);
          } catch {
            // localStorage can be unavailable in tests or privacy modes.
          }
        },
      })),
    });
  }, []);

  const handleFileContextMenu = useCallback((event: React.MouseEvent, file: FileRef) => {
    event.preventDefault();
    event.stopPropagation();
    listRef.current?.focus();
    if (!selectedIdsRef.current.has(file.id)) {
      setSelectedIds(new Set([file.id]));
      lastSelectedRef.current = file.id;
    }
    setMenu({
      type: 'file',
      position: { x: event.clientX, y: event.clientY },
      file,
    });
    void loadBridgeTargets(true);
  }, [loadBridgeTargets]);

  const buildFileMenuItems = useCallback((file: FileRef): ContextMenuItem[] => {
    const actionFiles = filesForAction(file);
    const pathFiles = pathBackedFiles(actionFiles);
    const sendableFiles = pathBackedFiles(actionFiles, { requireAvailable: true });
    const sendTargetItems: ContextMenuItem[] = bridgeTargetsLoading && !bridgeTargetsLoaded
      ? [{ label: tr('rightWorkspace.sessionFiles.actions.sendToBridgeLoading'), disabled: true }]
      : bridgeTargetsError
        ? [{ label: tr('rightWorkspace.sessionFiles.actions.sendToBridgeLoadFailed'), disabled: true }]
        : bridgeTargets.length > 0
          ? bridgeTargets.map(target => ({
            label: bridgeTargetLabel(target),
            action: () => sendFilesToBridge(sendableFiles, target),
          }))
          : [{ label: tr('rightWorkspace.sessionFiles.actions.sendToBridgeEmpty'), disabled: true }];

    return [
      { label: tr('rightWorkspace.sessionFiles.actions.preview'), disabled: !canPreviewFile(file), action: () => previewFile(file, currentSessionPath) },
      { label: tr('rightWorkspace.sessionFiles.actions.open'), disabled: !canUseFilePath(file), action: () => openFile(file) },
      { label: tr('rightWorkspace.sessionFiles.actions.reveal'), disabled: !canUseFilePath(file), action: () => revealFile(file) },
      {
        label: pathFiles.length > 1
          ? tr('rightWorkspace.sessionFiles.actions.copySelectedPaths', { n: pathFiles.length })
          : tr('rightWorkspace.sessionFiles.actions.copyPath'),
        disabled: pathFiles.length === 0,
        action: () => copyPaths(pathFiles),
      },
      { divider: true },
      {
        label: tr('rightWorkspace.sessionFiles.actions.sendToBridge'),
        disabled: sendableFiles.length === 0,
        children: sendTargetItems,
      },
    ];
  }, [
    bridgeTargets,
    bridgeTargetsError,
    bridgeTargetsLoaded,
    bridgeTargetsLoading,
    currentSessionPath,
    filesForAction,
    sendFilesToBridge,
  ]);

  const handleDragStart = useCallback((event: React.DragEvent, file: FileRef) => {
    const dragFiles = selectedIdsRef.current.has(file.id) ? filesForAction(file) : [file];
    const paths = pathBackedFiles(dragFiles, { requireAvailable: true }).map(item => item.path);
    if (paths.length === 0) return;
    event.preventDefault();
    window.platform?.startDrag?.(paths.length === 1 ? paths[0] : paths);
  }, [filesForAction]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
      const pathFiles = pathBackedFiles(selectedFiles);
      if (pathFiles.length === 0) return;
      event.preventDefault();
      copyPaths(pathFiles);
    }
  }, [selectedFiles]);

  const handleMouseDown = useCallback((event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest('[data-session-file-row]')) return;
    if (event.button !== 0) return;

    const additive = event.metaKey || event.ctrlKey || event.shiftKey;
    const baseSelection = additive ? new Set(selectedIdsRef.current) : new Set<string>();
    if (!additive) {
      setSelectedIds(new Set());
      lastSelectedRef.current = null;
    }

    const startX = event.clientX;
    const startY = event.clientY;
    rubberBandRef.current = { startX, startY };
    let active = false;

    const handleMove = (moveEvent: MouseEvent) => {
      const start = rubberBandRef.current;
      if (!start) return;
      if (!active) {
        if (Math.abs(moveEvent.clientX - start.startX) < RUBBER_BAND_MIN
          && Math.abs(moveEvent.clientY - start.startY) < RUBBER_BAND_MIN) return;
        active = true;
      }

      const x = Math.min(start.startX, moveEvent.clientX);
      const y = Math.min(start.startY, moveEvent.clientY);
      const w = Math.abs(moveEvent.clientX - start.startX);
      const h = Math.abs(moveEvent.clientY - start.startY);
      setRubberBandRect({ x, y, w, h });

      if (!listRef.current) return;
      const bandRect = { left: x, top: y, right: x + w, bottom: y + h };
      const hit = new Set<string>(baseSelection);
      listRef.current.querySelectorAll('[data-session-file-row]').forEach(element => {
        const rect = element.getBoundingClientRect();
        if (rect.right > bandRect.left && rect.left < bandRect.right
          && rect.bottom > bandRect.top && rect.top < bandRect.bottom) {
          const id = (element as HTMLElement).dataset.fileId;
          if (id) hit.add(id);
        }
      });
      setSelectedIds(hit);
    };

    const handleUp = () => {
      rubberBandRef.current = null;
      setRubberBandRect(null);
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      cleanupRef.current = null;
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    cleanupRef.current = handleUp;
  }, []);

  const suppressImport = useCallback((event: React.ClipboardEvent | React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return (
    <section className={styles.sessionFilesPanel} aria-label={tr('rightWorkspace.tabs.sessionFiles')}>
      {sortedFiles.length === 0 ? (
        <div className={styles.emptyState}>{tr('rightWorkspace.sessionFiles.empty')}</div>
      ) : (
        <>
          <div className={styles.sessionFilesToolbar}>
            <button
              type="button"
              className={styles.sessionFilesSortButton}
              aria-label={tr('rightWorkspace.sessionFiles.sort.label')}
              title={tr('rightWorkspace.sessionFiles.sort.label')}
              onClick={handleSortClick}
            >
              <SortIcon />
              <span>{sortLabel(sortMode)}</span>
            </button>
          </div>
          <div
            className={styles.fileList}
            ref={listRef}
            role="list"
            aria-label={tr('rightWorkspace.sessionFiles.list')}
            tabIndex={0}
            onKeyDown={handleKeyDown}
            onMouseDown={handleMouseDown}
            onPaste={suppressImport}
            onDrop={suppressImport}
          >
            {sortedFiles.map(file => (
              <SessionFileRow
                key={file.id}
                file={file}
                sessionPath={currentSessionPath}
                selected={selectedIds.has(file.id)}
                onSelect={selectFile}
                onContextMenu={handleFileContextMenu}
                onDragStart={handleDragStart}
              />
            ))}
            {rubberBandRect && (
              <div
                className={styles.fileRubberBand}
                style={{
                  left: rubberBandRect.x,
                  top: rubberBandRect.y,
                  width: rubberBandRect.w,
                  height: rubberBandRect.h,
                }}
              />
            )}
          </div>
        </>
      )}
      {menu && (
        <ContextMenu
          items={menu.type === 'file' ? buildFileMenuItems(menu.file) : menu.items}
          position={menu.position}
          onClose={() => setMenu(null)}
        />
      )}
    </section>
  );
}
