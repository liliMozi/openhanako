/**
 * MainContent.tsx — 主内容区域：拖拽处理 + 布局编排
 *
 * 从 App.tsx 提取。包含：
 * - handleDrop() 拖拽附件处理
 * - MainContent（原 MainContentDrag）组件
 * - DropText 子组件
 */

import { useState, useRef, useCallback } from 'react';
import { useStore } from './stores';
import { hanaFetch } from './hooks/use-hana-fetch';
import { toSlash, baseName } from './utils/format';
import { BrowserCard } from './components/BrowserCard';
import { ComputerUseOverlay } from './components/ComputerUseOverlay';

declare function t(key: string, vars?: Record<string, string | number>): string;

/* eslint-disable @typescript-eslint/no-explicit-any -- deskFiles item typing */

// ── 拖拽附件 drop handler（从 bridge.ts appInput shim 迁移） ──

async function installSkillFile(filePath: string): Promise<void> {
  try {
    const agentId = useStore.getState().currentAgentId || '';
    if (!agentId) {
      useStore.getState().addToast(
        t('settings.skills.installError') + ': no current agent',
        'error',
      );
      return;
    }
    const res = await hanaFetch(`/api/skills/install?agentId=${encodeURIComponent(agentId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    useStore.getState().addToast(
      t('settings.skills.installSuccess', { name: data.skill?.name || '' }),
      'success',
    );
  } catch (err) {
    useStore.getState().addToast(
      t('settings.skills.installError') + ': ' + (err instanceof Error ? err.message : String(err)),
      'error',
    );
  }
}

/**
 * attachFilesFromPaths — 将文件系统路径列表附加为聊天附件
 *
 * 拖拽和文件选择器共用此逻辑。nameMap 可选，用于保留拖拽时的原始文件名。
 */
export async function attachFilesFromPaths(
  srcPaths: string[],
  nameMap: Record<string, string> = {},
): Promise<void> {
  if (srcPaths.length === 0) return;
  if (useStore.getState().attachedFiles.length >= 9) return;

  // .skill 文件直接安装为用户技能，不当附件处理
  const skillPaths = srcPaths.filter(p => /\.skill$/i.test(p));
  if (skillPaths.length) {
    srcPaths = srcPaths.filter(p => !skillPaths.includes(p));
    for (const p of skillPaths) installSkillFile(p);
    if (srcPaths.length === 0) return;
  }

  // Desk 文件直接附加（保留原始路径，不走 upload）
  const s = useStore.getState();
  const deskBase = toSlash(s.deskBasePath ?? '').replace(/\/+$/, '');
  if (deskBase) {
    const prefix = deskBase + '/';
    const deskFileMap = new Map(s.deskFiles.map((f: any) => [f.name, f]));
    const isDeskPath = (p: string) => { const s = toSlash(p); return s === deskBase || s.startsWith(prefix); };
    const deskPaths = srcPaths.filter(isDeskPath);
    srcPaths = srcPaths.filter((p) => !isDeskPath(p));
    for (const p of deskPaths) {
      if (useStore.getState().attachedFiles.length >= 9) break;
      const name = baseName(p);
      const isRoot = toSlash(p) === deskBase;
      const knownFile = deskFileMap.get(name);
      useStore.getState().addAttachedFile({
        path: p,
        name,
        isDirectory: isRoot || (knownFile?.isDir ?? false),
      });
    }
  }
  if (srcPaths.length === 0) return;

  try {
    const res = await hanaFetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: srcPaths }),
    });
    const data = await res.json();
    const failed: string[] = [];
    for (const item of data.uploads || []) {
      if (item.dest) {
        useStore.getState().addAttachedFile({
          path: item.dest,
          name: item.name,
          isDirectory: item.isDirectory || false,
        });
      } else if (item.error) {
        failed.push(nameMap[item.src] || baseName(item.src));
      }
    }
    if (failed.length > 0) {
      useStore.getState().addToast(
        t('error.uploadPartialFail', { files: failed.join(', ') }),
        'error',
      );
    }
  } catch (err) {
    console.error('[upload]', err);
    useStore.getState().addToast(
      t('error.uploadFailed'),
      'error',
    );
  }
}

async function handleDrop(e: React.DragEvent): Promise<void> {
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;

  const nameMap: Record<string, string> = {};
  const srcPaths: string[] = [];
  for (const file of Array.from(files)) {
    const filePath = window.platform?.getFilePath?.(file);
    if (filePath) {
      srcPaths.push(filePath);
      nameMap[filePath] = file.name;
    }
  }
  await attachFilesFromPaths(srcPaths, nameMap);
}

// ── DropText ──

function DropText() {
  const agentName = useStore(s => s.agentName);
  return <span className="drop-text">{t('drop.hint', { name: agentName })}</span>;
}

// ── MainContent（拖拽区域 + children） ──

export function MainContent({ children }: { children: React.ReactNode }) {
  const [dragActive, setDragActive] = useState(false);
  const dragCounter = useRef(0);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    if (dragCounter.current === 1) setDragActive(true);
  }, []);
  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) setDragActive(false);
  }, []);
  const onDragOver = useCallback((e: React.DragEvent) => e.preventDefault(), []);
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setDragActive(false);
    handleDrop(e);
  }, []);

  return (
    <div
      className="main-content"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <BrowserCard />
      <ComputerUseOverlay />
      <div className={`drop-overlay${dragActive ? ' visible' : ''}`}>
        <div className="drop-overlay-inner">
          <span className="drop-icon">📎</span>
          <DropText />
        </div>
      </div>
      {children}
    </div>
  );
}
