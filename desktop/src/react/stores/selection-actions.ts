import { useStore } from './index';
import type { Artifact } from '../types';
import type { EditorView } from '@codemirror/view';

/**
 * 捕获 artifact 中的文本选中。
 * CM 模式传入 cmView，DOM 模式不传。
 */
export function captureSelection(artifact: Artifact, cmView?: EditorView): void {
  if (cmView) {
    captureCMSelection(artifact, cmView);
  } else {
    captureDOMSelection(artifact);
  }
}

function captureCMSelection(artifact: Artifact, view: EditorView): void {
  const { from, to } = view.state.selection.main;
  if (from === to) {
    clearSelection();
    return;
  }
  const text = view.state.sliceDoc(from, to).trim();
  if (!text) {
    clearSelection();
    return;
  }
  const lineStart = view.state.doc.lineAt(from).number;
  const lineEnd = view.state.doc.lineAt(to).number;

  useStore.getState().setQuotedSelection({
    text,
    sourceTitle: artifact.title,
    sourceFilePath: artifact.filePath,
    lineStart,
    lineEnd,
    charCount: text.length,
  });
}

function captureDOMSelection(artifact: Artifact): void {
  const sel = window.getSelection();
  const text = sel?.toString().trim();
  if (!text) {
    clearSelection();
    return;
  }
  const clipped = text.length > 2000 ? text.slice(0, 2000) : text;

  useStore.getState().setQuotedSelection({
    text: clipped,
    sourceTitle: artifact.title,
    charCount: text.length,
  });
}

export function clearSelection(): void {
  const s = useStore.getState();
  if (s.quotedSelection) s.clearQuotedSelection();
}
