/**
 * PreviewPanel — Artifact 预览/编辑面板
 *
 * 从 Zustand store 读取 artifacts / currentArtifactId / previewOpen 状态。
 * 可编辑类型（有 filePath 的 markdown/code/csv）使用 CodeMirror 编辑器。
 *
 * 架构原则：
 * - 文件系统是 source of truth，编辑器直接对接文件
 * - 文件型 artifact 的 content 不回写 store（避免双源）
 * - ArtifactEditor 不依赖 PreviewPanel，可脱离到独立窗口
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../stores';
import { renderMarkdown } from '../utils/markdown';
import { parseCSV, injectCopyButtons } from '../utils/format';
import { fileIconSvg } from '../utils/icons';
import { updateLayout } from './SidebarLayout';
import { ArtifactEditor } from './ArtifactEditor';
import type { Artifact } from '../types';

const EDITABLE_TYPES = new Set(['markdown', 'code', 'csv']);

function isEditable(artifact: Artifact | null): boolean {
  if (!artifact) return false;
  return !!artifact.filePath && EDITABLE_TYPES.has(artifact.type);
}

function getEditorMode(artifact: Artifact): 'markdown' | 'code' | 'text' {
  if (artifact.type === 'markdown') return 'markdown';
  return 'code';
}

export function PreviewPanel() {
  const previewOpen = useStore(s => s.previewOpen);
  const currentArtifactId = useStore(s => s.currentArtifactId);
  const artifacts = useStore(s => s.artifacts);
  const editorDetached = useStore(s => s.editorDetached);
  const setPreviewOpen = useStore(s => s.setPreviewOpen);
  const setCurrentArtifactId = useStore(s => s.setCurrentArtifactId);
  const setEditorDetached = useStore(s => s.setEditorDetached);

  const bodyRef = useRef<HTMLDivElement>(null);
  const artifact = artifacts.find(a => a.id === currentArtifactId) ?? null;
  const editable = isEditable(artifact);

  const closePreview = useCallback(() => {
    setPreviewOpen(false);
    setCurrentArtifactId(null);
    updateLayout();
  }, [setPreviewOpen, setCurrentArtifactId]);

  // 拆分到独立窗口
  const handleDetach = useCallback(() => {
    if (!artifact?.filePath) return;
    setEditorDetached(true);
    setPreviewOpen(false);
    // 通过 IPC 打开编辑器窗口
    window.platform?.openEditorWindow?.({
      filePath: artifact.filePath,
      title: artifact.title,
      type: artifact.type,
      language: artifact.language,
    });
  }, [artifact, setEditorDetached, setPreviewOpen]);

  // 非编辑模式：渲染 artifact 内容到 body（命令式 DOM）
  // 注意：editable 时也要清理上一次命令式插入的残留 DOM（iframe 等），
  // 但不能用 innerHTML='' 因为会破坏 React 管理的 ArtifactEditor。
  // 所以只移除非 React 的子节点。
  useEffect(() => {
    if (!previewOpen || !artifact || !bodyRef.current) return;
    const body = bodyRef.current;
    // 清理命令式插入的节点（保留 React 管理的 .artifact-editor）
    Array.from(body.children).forEach(child => {
      if (!child.classList.contains('artifact-editor')) {
        child.remove();
      }
    });
    if (editable) return;

    switch (artifact.type) {
      case 'html': {
        const iframe = document.createElement('iframe');
        iframe.sandbox.add('allow-scripts');
        iframe.srcdoc = artifact.content;
        body.appendChild(iframe);
        break;
      }
      case 'markdown': {
        const div = document.createElement('div');
        div.className = 'preview-markdown md-content';
        div.innerHTML = renderMarkdown(artifact.content);
        injectCopyButtons(div);
        body.appendChild(div);
        break;
      }
      case 'code': {
        const pre = document.createElement('pre');
        pre.className = 'preview-code';
        const code = document.createElement('code');
        code.textContent = artifact.content;
        if (artifact.language) code.className = `language-${artifact.language}`;
        pre.appendChild(code);
        body.appendChild(pre);
        break;
      }
      case 'docx': {
        const div = document.createElement('div');
        div.className = 'preview-docx md-content';
        div.innerHTML = artifact.content;
        body.appendChild(div);
        break;
      }
      case 'xlsx': {
        const div = document.createElement('div');
        div.className = 'preview-csv';
        div.innerHTML = artifact.content;
        body.appendChild(div);
        break;
      }
      case 'svg': {
        const img = document.createElement('img');
        img.className = 'preview-image';
        img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(artifact.content)))}`;
        img.alt = artifact.title;
        body.appendChild(img);
        break;
      }
      case 'image': {
        const img = document.createElement('img');
        img.className = 'preview-image';
        const ext = artifact.ext === 'jpg' ? 'jpeg' : (artifact.ext || 'png');
        img.src = `data:image/${ext};base64,${artifact.content}`;
        img.alt = artifact.title;
        body.appendChild(img);
        break;
      }
      case 'pdf': {
        const iframe = document.createElement('iframe');
        iframe.className = 'preview-pdf';
        iframe.src = `data:application/pdf;base64,${artifact.content}`;
        body.appendChild(iframe);
        break;
      }
      case 'csv': {
        const wrap = document.createElement('div');
        wrap.className = 'preview-csv';
        const table = document.createElement('table');
        const rows = parseCSV(artifact.content);
        if (rows.length > 0) {
          const thead = document.createElement('thead');
          const headerRow = document.createElement('tr');
          for (const cell of rows[0]) {
            const th = document.createElement('th');
            th.textContent = cell;
            headerRow.appendChild(th);
          }
          thead.appendChild(headerRow);
          table.appendChild(thead);
          const tbody = document.createElement('tbody');
          for (let i = 1; i < rows.length; i++) {
            const tr = document.createElement('tr');
            for (const cell of rows[i]) {
              const td = document.createElement('td');
              td.textContent = cell;
              tr.appendChild(td);
            }
            tbody.appendChild(tr);
          }
          table.appendChild(tbody);
        }
        wrap.appendChild(table);
        body.appendChild(wrap);
        break;
      }
      case 'file-info': {
        const wrap = document.createElement('div');
        wrap.className = 'preview-file-info';
        const iconEl = document.createElement('div');
        iconEl.className = 'preview-file-icon';
        iconEl.innerHTML = fileIconSvg(artifact.ext || '');
        const nameEl = document.createElement('div');
        nameEl.className = 'preview-file-name';
        nameEl.textContent = artifact.title;
        const extLabel = document.createElement('div');
        extLabel.className = 'preview-file-ext';
        const _t = window.t ?? ((p: string) => p);
        extLabel.textContent = (artifact.ext || '').toUpperCase() + ' ' + _t('desk.fileLabel');
        const openBtn = document.createElement('button');
        openBtn.className = 'preview-file-open-btn';
        openBtn.textContent = _t('desk.openWithDefault');
        openBtn.addEventListener('click', () => {
          if (artifact.filePath) window.platform?.openFile?.(artifact.filePath);
        });
        wrap.appendChild(iconEl);
        wrap.appendChild(nameEl);
        wrap.appendChild(extLabel);
        wrap.appendChild(openBtn);
        body.appendChild(wrap);
        break;
      }
      default: {
        const pre = document.createElement('pre');
        pre.className = 'preview-code';
        pre.textContent = artifact.content;
        body.appendChild(pre);
      }
    }
  }, [previewOpen, artifact, editable]);

  const [copyLabel, setCopyLabel] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); }, []);
  const handleCopy = useCallback(() => {
    if (!artifact) return;
    navigator.clipboard.writeText(artifact.content).then(() => {
      const _t = window.t ?? ((p: string) => p);
      setCopyLabel(_t('attach.copied'));
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopyLabel(null), 1500);
    });
  }, [artifact]);

  return (
    <div className={`preview-panel${previewOpen ? '' : ' collapsed'}`} id="previewPanel">
      <div className="resize-handle resize-handle-left" id="previewResizeHandle"></div>
      <div className="preview-panel-inner">
        <div className="preview-panel-header">
          <span className="preview-panel-title" id="previewTitle">
            {artifact?.title ?? ''}
          </span>
          <div className="preview-panel-actions">
            <button className="preview-panel-action-btn preview-panel-copy-btn" onClick={handleCopy}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              <span>{copyLabel ?? (window.t ?? ((p: string) => p))('attach.copy')}</span>
            </button>
            {editable && (
              <button className="preview-panel-action-btn" title="Open in window" onClick={handleDetach}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 3 21 3 21 9"></polyline>
                  <line x1="10" y1="14" x2="21" y2="3"></line>
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                </svg>
              </button>
            )}
            <button className="preview-panel-action-btn" title="Close" onClick={closePreview}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>
        <div className="preview-panel-body" id="previewBody" ref={bodyRef}>
          {previewOpen && artifact && editable && (
            <ArtifactEditor
              content={artifact.content}
              filePath={artifact.filePath}
              mode={getEditorMode(artifact)}
              language={artifact.language}
            />
          )}
        </div>
      </div>
    </div>
  );
}
