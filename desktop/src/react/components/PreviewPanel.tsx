/**
 * PreviewPanel — Artifact 预览/编辑面板
 *
 * 从 Zustand store 读取 artifact 内容池，以及当前 workspace 恢复出的 activeTabId / previewOpen 状态。
 * 可编辑类型（有 filePath 的 markdown/code/csv）使用 CodeMirror 编辑器。
 *
 * 架构原则：
 * - 文件系统是 source of truth，编辑器直接对接文件
 * - Artifact content 仅作为前端视图快照，给复制/临时渲染预览使用
 * - 独立窗口由下阶段的 viewer spawn 机制负责（单向只读副本），本面板不做 detach/dock
 */

import { useCallback, useEffect } from 'react';
import { useStore } from '../stores';
import { selectArtifacts, selectActiveTabId, selectMarkdownPreviewIds } from '../stores/artifact-slice';
import { setMarkdownPreviewActive, upsertArtifact } from '../stores/artifact-actions';
import { ArtifactEditor } from './ArtifactEditor';
import { ArtifactRenderer } from './preview/ArtifactRenderer';
import { TabBar } from './preview/TabBar';
import { FloatingActions } from './preview/FloatingActions';
import { captureSelection, clearSelection } from '../stores/selection-actions';
import type { Artifact } from '../types';
import previewStyles from './Preview.module.css';

const EDITABLE_TYPES = new Set(['markdown', 'code', 'csv']);

function isEditable(artifact: Artifact | null): boolean {
  if (!artifact) return false;
  return !!artifact.filePath && EDITABLE_TYPES.has(artifact.type);
}

function isMarkdownFile(artifact: Artifact | null): boolean {
  return !!artifact?.filePath && artifact.type === 'markdown';
}

function getEditorMode(artifact: Artifact): 'markdown' | 'code' | 'csv' | 'text' {
  if (artifact.type === 'markdown') return 'markdown';
  if (artifact.type === 'csv') return 'csv';
  return 'code';
}

export function PreviewPanel() {
  const previewOpen = useStore(s => s.previewOpen);
  const activeTabId = useStore(selectActiveTabId);
  const artifacts = useStore(selectArtifacts);
  const markdownPreviewIds = useStore(selectMarkdownPreviewIds);

  const artifact = artifacts.find(a => a.id === activeTabId) ?? null;
  const markdownPreviewActive = !!artifact && markdownPreviewIds.includes(artifact.id);
  const editable = isEditable(artifact) && !markdownPreviewActive;

  const handleToggleMarkdownPreview = useCallback(() => {
    if (!artifact || !isMarkdownFile(artifact)) return;
    setMarkdownPreviewActive(artifact.id, !markdownPreviewActive);
  }, [artifact, markdownPreviewActive]);

  const handleEditorContentChange = useCallback((content: string) => {
    if (!artifact) return;
    upsertArtifact({ ...artifact, content });
  }, [artifact]);

  // DOM 模式选区捕获（非编辑模式下 mouseup 时检测选中文本）
  const handleMouseUp = useCallback(() => {
    if (!artifact || editable) return;
    captureSelection(artifact);
  }, [artifact, editable]);

  // 切换 tab 时清除选区
  useEffect(() => {
    clearSelection();
  }, [activeTabId]);

  return (
    <div className={`${previewStyles.previewPanel}${previewOpen ? '' : ` ${previewStyles.previewPanelCollapsed}`}`} id="previewPanel">
      <div className="resize-handle resize-handle-left" id="previewResizeHandle"></div>
      <div className={previewStyles.previewPanelInner}>
        <TabBar />
        <div className={previewStyles.previewBodyShell}>
          {previewOpen && artifact && (
            <FloatingActions
              content={artifact.content}
              showMarkdownPreviewToggle={isMarkdownFile(artifact)}
              markdownPreviewActive={markdownPreviewActive}
              onToggleMarkdownPreview={handleToggleMarkdownPreview}
            />
          )}
          <div className={previewStyles.previewPanelBody} id="previewBody" onMouseUp={handleMouseUp}>
            {previewOpen && artifact && !editable && (
              <ArtifactRenderer artifact={artifact} />
            )}
            {previewOpen && artifact && editable && (
              <ArtifactEditor
                content={artifact.content}
                filePath={artifact.filePath}
                mode={getEditorMode(artifact)}
                language={artifact.language}
                onSelectionChange={(view) => {
                  if (artifact) captureSelection(artifact, view);
                }}
                onContentChange={handleEditorContentChange}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
