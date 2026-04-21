import type { FileKind, FileSource } from '../types/file-ref';

export const EXT_TO_KIND: Record<string, FileKind> = {
  // image（包含老格式 ico / tiff / heic，统一归入 image；SVG 因走 XML 渲染单独一类）
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image',
  webp: 'image', bmp: 'image', avif: 'image', ico: 'image',
  tiff: 'image', tif: 'image', heic: 'image', heif: 'image',
  svg: 'svg',
  // video
  mp4: 'video', webm: 'video', mov: 'video', m4v: 'video', mkv: 'video',
  // audio
  mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', m4a: 'audio',
  // docs
  pdf: 'pdf',
  docx: 'doc', xlsx: 'doc', xls: 'doc',
  md: 'markdown', markdown: 'markdown',
  // code-like
  js: 'code', ts: 'code', jsx: 'code', tsx: 'code', py: 'code',
  css: 'code', json: 'code', yaml: 'code', yml: 'code',
  xml: 'code', sql: 'code', sh: 'code', bash: 'code', txt: 'code',
  c: 'code', cpp: 'code', h: 'code', java: 'code',
  rs: 'code', go: 'code', rb: 'code', php: 'code',
  html: 'code', htm: 'code', csv: 'code',
};

export function inferKindByExt(ext: string | undefined): FileKind {
  if (!ext) return 'other';
  return EXT_TO_KIND[ext.toLowerCase()] ?? 'other';
}

const MEDIA_KINDS: ReadonlySet<FileKind> = new Set(['image', 'svg', 'video']);

export function isMediaKind(kind: FileKind): boolean {
  return MEDIA_KINDS.has(kind);
}

/**
 * 图片或 SVG —— 用于渲染侧 "这个扩展名是否要展示成 img" 的判断。
 * 中心表 EXT_TO_KIND 是唯一源，禁止组件自己维护 IMAGE_EXTS 私有表。
 */
export function isImageOrSvgExt(ext: string | undefined): boolean {
  if (!ext) return false;
  const kind = inferKindByExt(ext);
  return kind === 'image' || kind === 'svg';
}

/**
 * 从文件名取扩展名（小写、不带点）。扩展名缺失返回 undefined。
 */
export function extOfName(name: string): string | undefined {
  if (!name) return undefined;
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return undefined;
  return name.slice(dot + 1).toLowerCase();
}

/**
 * 统一构造 FileRef.id。selector 和调用方共用同一算法，避免 id 分叉。
 * - desk：desk:<path>
 * - session-attachment：sess:<sessionPath>:<messageId>:att:<path>
 * - session-block-file：sess:<sessionPath>:<messageId>:block:<blockIdx>:<path>
 * - session-block-screenshot：sess:<sessionPath>:<messageId>:block:<blockIdx>:screenshot
 */
export function buildFileRefId(parts: {
  source: FileSource;
  sessionPath?: string;
  messageId?: string;
  blockIdx?: number;
  path: string;
}): string {
  switch (parts.source) {
    case 'desk':
      return `desk:${parts.path}`;
    case 'session-attachment':
      return `sess:${parts.sessionPath}:${parts.messageId}:att:${parts.path}`;
    case 'session-block-file':
      return `sess:${parts.sessionPath}:${parts.messageId}:block:${parts.blockIdx}:${parts.path}`;
    case 'session-block-screenshot':
      return `sess:${parts.sessionPath}:${parts.messageId}:block:${parts.blockIdx}:screenshot`;
  }
}
