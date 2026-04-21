import type { FileRef } from '../../../types/file-ref';

export interface MediaSource {
  url: string;
  cleanup?: () => void;
}

/**
 * FileRef → 可供 <img> / <video> 直接消费的 URL。
 *
 * 设计原则：
 *   - 文件路径一律走 platform.getFileUrl（preload 层统一编码 + UNC / Windows 盘符兜底）。
 *     禁止前端手拼 file://，也不再把图片整文件 readFileBase64 进 JS 堆。浏览器原生解码
 *     file:// 资源，邻图预加载靠 <link rel=preload> / new Image() 走 disk cache，不重复占用内存。
 *   - 只有无 path 的 inline 数据（screenshot，base64 已随消息进 renderer）才走 data URL。
 */
export async function loadMediaSource(ref: FileRef): Promise<MediaSource> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- window.platform 的运行时存在性要在这里显式校验
  const platform = (window as any).platform;
  if (!platform) throw new Error('platform not available');

  // 1) inline data 优先（screenshot：path === ''，base64 已随消息进 renderer）
  if (ref.inlineData) {
    return { url: `data:${ref.inlineData.mimeType};base64,${ref.inlineData.base64}` };
  }

  // 2) 文件路径走 platform.getFileUrl —— image / svg / video 一视同仁
  if (typeof platform.getFileUrl !== 'function') {
    throw new Error('platform.getFileUrl not available (preload.cjs 未实现)');
  }
  if (!ref.path) {
    throw new Error(`media ref 缺少 path: ${ref.id}`);
  }
  if (ref.kind !== 'image' && ref.kind !== 'svg' && ref.kind !== 'video') {
    throw new Error(`unsupported media kind: ${ref.kind}`);
  }
  return { url: platform.getFileUrl(ref.path) };
}
