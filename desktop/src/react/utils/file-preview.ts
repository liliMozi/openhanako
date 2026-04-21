/**
 * file-preview.ts — 文件预览工具函数
 *
 * 从 file-cards-shim.ts 提取，供 React 组件直接 import。
 */

import type { Artifact } from '../types';
import { openPreview } from '../stores/artifact-actions';
import { inferKindByExt, isMediaKind } from './file-kind';
import { openMediaViewerFromContext } from './open-media-viewer';


// ── 可在 Artifacts 面板中预览的文件类型 ──
// 注意：image / svg 类型由 MediaViewer 处理，不再进入 Artifacts 面板。

export const PREVIEWABLE_EXTS: Record<string, string> = {
  html: 'html', htm: 'html',
  md: 'markdown', markdown: 'markdown',
  js: 'code', ts: 'code', jsx: 'code', tsx: 'code',
  py: 'code', css: 'code', json: 'code', yaml: 'code', yml: 'code',
  xml: 'code', sql: 'code', sh: 'code', bash: 'code',
  txt: 'code',
  c: 'code', cpp: 'code', h: 'code', java: 'code',
  rs: 'code', go: 'code', rb: 'code', php: 'code',
  csv: 'csv', pdf: 'pdf',
  docx: 'docx', xlsx: 'xlsx', xls: 'xlsx',
};

export const BINARY_PREVIEW_TYPES = new Set(['pdf']);

export async function readFileForPreview(filePath: string, ext: string): Promise<string | null> {
  const previewType = PREVIEWABLE_EXTS[ext];
  if (!previewType) return null;
  const p = window.platform;
  if (!p) return null;
  if (previewType === 'docx') return p.readDocxHtml?.(filePath) ?? null;
  if (previewType === 'xlsx') return p.readXlsxHtml?.(filePath) ?? null;
  if (BINARY_PREVIEW_TYPES.has(previewType)) return p.readFileBase64?.(filePath) ?? null;
  return p.readFile?.(filePath) ?? null;
}

/**
 * 打开文件预览：读取文件内容 → 创建 Artifact → 打开预览面板
 *
 * @param context 调用上下文。media 类型（image/svg/video）会按 context 分流到 MediaViewer；
 *   其它类型走 Artifacts 面板。context 必须由调用方显式提供，不从 store 推导。
 */
export async function openFilePreview(
  filePath: string,
  label: string,
  ext: string,
  context?: {
    origin?: 'desk' | 'session';
    sessionPath?: string;
    messageId?: string;
    blockIdx?: number;
  },
): Promise<void> {
  const fileName = label || filePath.split('/').pop() || filePath;

  if (ext === 'skill') {
    // .skill 文件可能是纯文本也可能是 zip，先尝试读取内容在预览面板展示
    const name = fileName.replace(/\.skill$/, '');
    const content = await window.platform?.readFile?.(filePath);
    if (content != null) {
      const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
      const artifact: Artifact = {
        id: `skill-${name}`,
        type: 'markdown',
        title: name,
        content: body,
      };
      openPreview(artifact);
      return;
    }
    // 读取失败（可能是 zip 格式），尝试 skill viewer
    window.platform?.openSkillViewer?.({ skillPath: filePath });
    return;
  }

  // Media 类型（image / svg / video）分流到 MediaViewer，不经过 Artifacts 面板。
  const mediaKind = inferKindByExt(ext);
  if (isMediaKind(mediaKind)) {
    openMediaViewerFromContext({
      filePath,
      label: fileName,
      ext,
      kind: mediaKind,
      origin: context?.origin,
      sessionPath: context?.sessionPath,
      messageId: context?.messageId,
      blockIdx: context?.blockIdx,
    });
    return;
  }

  const canPreview = ext in PREVIEWABLE_EXTS;
  if (canPreview) {
    const content = await readFileForPreview(filePath, ext);
    if (content != null) {
      const previewType = PREVIEWABLE_EXTS[ext];
      const artifact: Artifact = {
        id: `file-${filePath}`,
        type: previewType,
        title: fileName,
        content,
        filePath,
        ext,
        language: previewType === 'code' ? ext : undefined,
      };
      openPreview(artifact);
      return;
    }
  }

  // 无法预览的文件类型
  const artifact: Artifact = {
    id: `file-${filePath}`,
    type: 'file-info',
    title: fileName,
    content: '',
    filePath,
    ext,
  };
  openPreview(artifact);
}

/**
 * 打开 Skill 预览：读取 skill 文件 → 创建 markdown Artifact → 打开预览面板
 */
export async function openSkillPreview(skillName: string, skillFilePath: string): Promise<void> {
  const content = await window.platform?.readFile?.(skillFilePath);
  if (content != null) {
    const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
    const artifact: Artifact = {
      id: `skill-${skillName}`,
      type: 'markdown',
      title: skillName,
      content: body,
    };
    openPreview(artifact);
  }
}
