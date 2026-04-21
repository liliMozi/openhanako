import type { FileRef } from '../../types/file-ref';
import type { DeskFile } from '../../types';
import type { ChatListItem, ContentBlock } from '../chat-types';
import { inferKindByExt, buildFileRefId } from '../../utils/file-kind';

type StateShape = {
  deskFiles: DeskFile[];
  deskBasePath: string;
  deskCurrentPath: string;
  chatSessions?: Record<string, unknown>;
};

function joinPath(base: string, sub: string, name: string): string {
  // 保持 OS 原生习惯：仅用正斜杠拼接（preload 层自行适配 Windows 反斜杠）。
  // UNC 路径（Windows 网络盘，如 //server/share/...）的前导 `//` 必须保留，
  // 否则 pathToFileUrl 的 UNC 分支（要求 `//` 前缀）匹配不上，网络盘图片预览会坏。
  const joined = [base, sub, name].filter(Boolean).join('/');
  return joined.startsWith('//')
    ? '//' + joined.slice(2).replace(/\/+/g, '/')
    : joined.replace(/\/+/g, '/');
}

function extOf(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return undefined;
  return name.slice(dot + 1);
}

// ── Desk ──

let cachedDesk: { files: DeskFile[]; basePath: string; currentPath: string; result: FileRef[] } | null = null;

export function selectDeskFiles(state: StateShape): FileRef[] {
  const { deskFiles, deskBasePath, deskCurrentPath } = state;
  if (
    cachedDesk
    && cachedDesk.files === deskFiles
    && cachedDesk.basePath === deskBasePath
    && cachedDesk.currentPath === deskCurrentPath
  ) {
    return cachedDesk.result;
  }
  const result: FileRef[] = [];
  for (const f of deskFiles) {
    if (f.isDir) continue;
    const path = joinPath(deskBasePath, deskCurrentPath, f.name);
    const ext = extOf(f.name);
    result.push({
      id: buildFileRefId({ source: 'desk', path }),
      kind: inferKindByExt(ext),
      source: 'desk',
      name: f.name,
      path,
      ext,
    });
  }
  cachedDesk = { files: deskFiles, basePath: deskBasePath, currentPath: deskCurrentPath, result };
  return result;
}

// ── Session ──

type SessionStateShape = StateShape & {
  chatSessions?: Record<string, { items: ChatListItem[] } | undefined>;
};

const cachedSession = new Map<string, { items: ChatListItem[]; result: FileRef[] }>();
const EMPTY_SESSION_RESULT: readonly FileRef[] = Object.freeze([]);

/**
 * 清理 session → FileRef[] 缓存。必须由 session 生命周期持有方（chat-slice）
 * 在 clearSession / LRU eviction 时主动调用，否则 cachedSession 只增不减，
 * 长期会让 FileRef.inlineData 里的 base64 载荷在 renderer 里滞留。
 *
 * 不传 sessionPath 时清空整张 Map（用于登出 / 切换 workspace）。
 */
export function invalidateSessionCache(sessionPath?: string): void {
  if (sessionPath == null) {
    cachedSession.clear();
    return;
  }
  cachedSession.delete(sessionPath);
}

export function selectSessionFiles(state: SessionStateShape, sessionPath: string): readonly FileRef[] {
  const items = state.chatSessions?.[sessionPath]?.items;
  if (!items) return EMPTY_SESSION_RESULT;
  const cached = cachedSession.get(sessionPath);
  if (cached && cached.items === items) return cached.result;

  const result: FileRef[] = [];
  for (const item of items) {
    if (item.type !== 'message') continue;
    const msg = item.data;

    // attachments 在前
    if (msg.attachments) {
      for (const att of msg.attachments) {
        if (att.isDir) continue;
        const ext = extOf(att.name);
        result.push({
          id: buildFileRefId({
            source: 'session-attachment',
            sessionPath, messageId: msg.id, path: att.path,
          }),
          kind: inferKindByExt(ext),
          source: 'session-attachment',
          name: att.name,
          path: att.path,
          ext,
          mime: att.mimeType,
          timestamp: msg.timestamp,
          sessionMessageId: msg.id,
          inlineData: att.base64Data && att.mimeType
            ? { base64: att.base64Data, mimeType: att.mimeType }
            : undefined,
        });
      }
    }

    // blocks 在后
    if (msg.blocks) {
      for (let i = 0; i < msg.blocks.length; i++) {
        const b: ContentBlock = msg.blocks[i];
        if (b.type === 'file') {
          result.push({
            id: buildFileRefId({
              source: 'session-block-file',
              sessionPath, messageId: msg.id, blockIdx: i, path: b.filePath,
            }),
            kind: inferKindByExt(b.ext),
            source: 'session-block-file',
            name: b.label || b.filePath.split('/').pop() || b.filePath,
            path: b.filePath,
            ext: b.ext,
            timestamp: msg.timestamp,
            sessionMessageId: msg.id,
          });
        } else if (b.type === 'screenshot') {
          result.push({
            id: buildFileRefId({
              source: 'session-block-screenshot',
              sessionPath, messageId: msg.id, blockIdx: i, path: '',
            }),
            kind: 'image',
            source: 'session-block-screenshot',
            name: `screenshot-${msg.id}-${i}.png`,
            path: '',
            mime: b.mimeType,
            timestamp: msg.timestamp,
            sessionMessageId: msg.id,
            inlineData: { base64: b.base64, mimeType: b.mimeType },
          });
        }
      }
    }
  }

  cachedSession.set(sessionPath, { items, result });
  return result;
}
