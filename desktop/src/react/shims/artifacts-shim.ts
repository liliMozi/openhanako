/**
 * artifacts-shim.ts — Artifact 预览 / 卡片 / 浏览器截图
 *
 * 从 bridge.ts 提取（Phase 6D）。
 */

import { useStore } from '../stores';
import type { Artifact } from '../types';
import { SVG_ICONS } from '../utils/icons';
import { escapeHtml } from '../utils/format';

/* eslint-disable @typescript-eslint/no-explicit-any */

let _artifactCounter = 0;

export function openPreview(artifact: Artifact): void {
  const s = useStore.getState();
  const arts = [...s.artifacts];
  const idx = arts.findIndex(a => a.id === artifact.id);
  if (idx >= 0) arts[idx] = artifact;
  else arts.push(artifact);
  s.setArtifacts(arts);
  s.setCurrentArtifactId(artifact.id);
  s.setPreviewOpen(true);
  const mods = (window as any).HanaModules as Record<string, any> | undefined;
  const sidebarMod = mods?.sidebar as { updateLayout?: () => void } | undefined;
  sidebarMod?.updateLayout?.();
}

export function closePreview(): void {
  const s = useStore.getState();
  s.setPreviewOpen(false);
  s.setCurrentArtifactId(null);
  const mods = (window as any).HanaModules as Record<string, any> | undefined;
  const sidebarMod = mods?.sidebar as { updateLayout?: () => void } | undefined;
  sidebarMod?.updateLayout?.();
}

function handleArtifact(data: Record<string, unknown>): void {
  const id = (data.artifactId as string) || `artifact-${++_artifactCounter}`;
  const artifact: Artifact = {
    id,
    type: data.artifactType as string,
    title: data.title as string,
    content: data.content as string,
    language: data.language as string | undefined,
  };
  const s = useStore.getState();
  const arts = [...s.artifacts];
  const idx = arts.findIndex(a => a.id === id);
  if (idx >= 0) arts[idx] = artifact;
  else arts.push(artifact);
  s.setArtifacts(arts);

  appendArtifactCard(artifact);
}

function appendArtifactCard(artifact: Artifact): void {
  const legacyState = window.__hanaState;
  const el = legacyState?.currentAssistantEl as HTMLElement | undefined;
  if (!el) return;

  const ARTIFACT_ICONS: Record<string, string> = { html: SVG_ICONS.globe, code: SVG_ICONS.code, markdown: SVG_ICONS.text };
  const icon = ARTIFACT_ICONS[artifact.type] || SVG_ICONS.file;
  const card = document.createElement('div');
  card.className = 'artifact-card';
  card.addEventListener('click', () => openPreview(artifact));
  card.innerHTML = `
    <span class="artifact-card-icon">${icon}</span>
    <div class="artifact-card-info">
      <div class="artifact-card-title">${escapeHtml(artifact.title)}</div>
      <div class="artifact-card-type">${artifact.type}${artifact.language ? ` · ${artifact.language}` : ''}</div>
    </div>
  `;
  el.appendChild(card);
}

function appendBrowserScreenshot(base64: string, mimeType: string): void {
  const legacyState = window.__hanaState;
  const el = legacyState?.currentAssistantEl as HTMLElement | undefined;
  if (!el) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'browser-screenshot';
  const img = document.createElement('img');
  img.src = `data:${mimeType};base64,${base64}`;
  img.alt = '浏览器截图';
  img.addEventListener('click', () => {
    const artId = `browser-ss-${Date.now()}`;
    const artifact: Artifact = {
      id: artId,
      type: 'image',
      title: '浏览器截图',
      content: base64,
      ext: mimeType === 'image/jpeg' ? 'jpg' : 'png',
    };
    const s = useStore.getState();
    const arts = [...s.artifacts];
    if (!arts.find(a => a.id === artifact.id)) arts.push(artifact);
    s.setArtifacts(arts);
    openPreview(artifact);
  });
  wrapper.appendChild(img);
  el.appendChild(wrapper);
}

export function setupArtifactsShim(modules: Record<string, unknown>): void {
  modules.artifacts = {
    handleArtifact,
    appendArtifactCard,
    renderBrowserCard: () => { /* React BrowserCard 读 store 自动更新 */ },
    appendBrowserScreenshot,
    openPreview,
    closePreview,
    initArtifacts: () => { /* 不再需要 ctx 注入 */ },
  };

  // 编辑器窗口 dock 回来时，重新在主窗口打开预览
  window.platform?.onEditorDockFile?.((data: any) => {
    const s = useStore.getState();
    const existing = s.artifacts.find(a => a.filePath === data.filePath);
    if (existing) {
      openPreview(existing);
    } else {
      // 从文件重新读取内容
      window.platform?.readFile(data.filePath).then((content: string | null) => {
        if (content == null) return;
        const artifact: Artifact = {
          id: `file-${data.filePath}`,
          type: data.type,
          title: data.title,
          content,
          filePath: data.filePath,
          language: data.language,
        };
        openPreview(artifact);
      });
    }
    useStore.getState().setEditorDetached(false);
  });

  // 编辑器窗口关闭/隐藏时，同步状态
  window.platform?.onEditorDetached?.((detached: boolean) => {
    useStore.getState().setEditorDetached(detached);
  });
}
