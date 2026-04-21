import { useStore } from '../stores';
import { selectDeskFiles, selectSessionFiles } from '../stores/selectors/file-refs';
import type { FileRef, FileKind, FileSource } from '../types/file-ref';
import { isMediaKind, buildFileRefId } from './file-kind';

interface OpenInput {
  filePath: string;
  label: string;
  ext: string;
  kind: FileKind;
  /**
   * 显式来源。不传时保守默认 'desk'。
   * 不要靠 state.currentSessionPath 推导：用户可能在非聚焦 transcript / 只读视图里点击。
   */
  origin?: 'desk' | 'session';
  /** origin === 'session' 时调用方必传（从 prop 而非 store 读取） */
  sessionPath?: string;
  /** session 场景：消息 id，用于精准定位消息内 attachment/block */
  messageId?: string;
  /** session-block-* 场景：block 在 msg.blocks 中的索引 */
  blockIdx?: number;
}

export function openMediaViewerFromContext(input: OpenInput): void {
  const state = useStore.getState();
  const origin = input.origin ?? 'desk';
  const sessionPath = input.sessionPath ?? '';

  const rawFiles: readonly FileRef[] = origin === 'session'
    ? selectSessionFiles(state, sessionPath)
    : selectDeskFiles(state);
  const files = rawFiles.filter(f => isMediaKind(f.kind));

  // 按 id 匹配（不是 path）—— id 由 buildFileRefId 统一生成
  const startId = origin === 'session'
    ? buildFileRefId({
        source: input.blockIdx !== undefined ? 'session-block-file' : 'session-attachment',
        sessionPath,
        messageId: input.messageId,
        blockIdx: input.blockIdx,
        path: input.filePath,
      })
    : buildFileRefId({ source: 'desk', path: input.filePath });

  const startRef = files.find(f => f.id === startId);
  if (!startRef) {
    // 防御：序列里找不到（外部 ad-hoc / 新文件尚未加载）→ solo 序列
    const soloSource: FileSource = origin === 'desk'
      ? 'desk'
      : input.blockIdx !== undefined
        ? 'session-block-file'
        : 'session-attachment';
    const solo: FileRef = {
      id: startId,
      kind: input.kind,
      source: soloSource,
      name: input.label,
      path: input.filePath,
      ext: input.ext,
      sessionMessageId: input.messageId,
    };
    state.setMediaViewer({ files: [solo], currentId: solo.id, origin });
    return;
  }

  state.setMediaViewer({ files, currentId: startRef.id, origin });
}

/**
 * 直接用已构造的 FileRef 打开 —— 给 screenshot 等**无 path** media 用。
 * 内部按 ref.id 在 session 序列里找匹配；命中则融入序列，否则 solo。
 * 不再"绕过统一入口直接 setMediaViewer"。
 */
export function openMediaViewerForRef(ref: FileRef, opts: {
  origin: 'desk' | 'session';
  sessionPath?: string;
}): void {
  const state = useStore.getState();
  const rawFiles: readonly FileRef[] = opts.origin === 'session'
    ? selectSessionFiles(state, opts.sessionPath ?? '')
    : selectDeskFiles(state);
  const files = rawFiles.filter(f => isMediaKind(f.kind));
  const match = files.find(f => f.id === ref.id);
  if (match) {
    state.setMediaViewer({ files, currentId: ref.id, origin: opts.origin });
  } else {
    state.setMediaViewer({ files: [ref], currentId: ref.id, origin: opts.origin });
  }
}
