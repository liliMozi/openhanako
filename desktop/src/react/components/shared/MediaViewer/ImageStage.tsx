import { useEffect, useRef, useState } from 'react';
import type { FileRef } from '../../../types/file-ref';
import { loadMediaSource } from './media-source';
import { useMediaTransform } from './use-media-transform';
import styles from './MediaViewer.module.css';

// 注意：prop 名 `file` 不可改为 `ref`。React 会把 `ref` 当 forwardRef 的 ref 截获，
// 函数组件 props 里拿不到值，会导致 loadMediaSource(undefined) → 图片渲染不出来。
interface Props {
  file: FileRef;
  viewport: { width: number; height: number };
  neighbors?: { prev?: FileRef; next?: FileRef };
  zoomCmd?: { in: number; out: number; reset: number };
  onReady?: () => void;
  onError?: (e: unknown) => void;
}

export function ImageStage({ file, viewport, neighbors, zoomCmd, onReady, onError }: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const imgElRef = useRef<HTMLImageElement | null>(null);

  // 加载当前图
  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setNatural(null);
    loadMediaSource(file)
      .then((s) => { if (!cancelled) setSrc(s.url); })
      .catch((err) => { if (!cancelled) onError?.(err); });
    return () => { cancelled = true; };
    // 依赖 id 而非 file/onError：file 是引用类型每次新建；onError 仅在错误时被调用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  // 邻近预加载（触发浏览器缓存）
  // 仅对 image/svg 预加载：loadMediaSource 只支持这两类，其他 kind 会抛 "unsupported media kind"。
  useEffect(() => {
    const preload = async (nf?: FileRef) => {
      if (!nf || (nf.kind !== 'image' && nf.kind !== 'svg')) return;
      try {
        const s = await loadMediaSource(nf);
        const img = new Image();
        img.src = s.url;
      } catch { /* ignore */ }
    };
    preload(neighbors?.prev);
    preload(neighbors?.next);
    // 依赖 id 而非对象：邻居切换时才需要重新预加载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [neighbors?.prev?.id, neighbors?.next?.id]);

  const transformApi = useMediaTransform({
    natural,
    viewport: { w: viewport.width, h: viewport.height },
  });

  const { cssTransform, onWheel, onPointerDown, onPointerMove, onPointerUp, onDoubleClick, fitScale, transform } = transformApi;

  // 外壳的缩放命令（单调计数器）变化时触发对应动作
  const prevCmdRef = useRef({ in: 0, out: 0, reset: 0 });
  useEffect(() => {
    if (!zoomCmd) return;
    if (zoomCmd.in > prevCmdRef.current.in) transformApi.zoomIn();
    if (zoomCmd.out > prevCmdRef.current.out) transformApi.zoomOut();
    if (zoomCmd.reset > prevCmdRef.current.reset) transformApi.reset();
    prevCmdRef.current = zoomCmd;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomCmd?.in, zoomCmd?.out, zoomCmd?.reset]);

  const cursorStyle = transform.scale > fitScale + 0.01 ? 'grab' : 'default';

  return (
    <div
      className={styles.stage}
      data-testid="image-stage"
      data-zoom-in-seq={zoomCmd?.in ?? 0}
      data-zoom-out-seq={zoomCmd?.out ?? 0}
      data-reset-seq={zoomCmd?.reset ?? 0}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onDoubleClick}
      style={{ transform: cssTransform, cursor: cursorStyle }}
    >
      {!src && <div className={styles.spinner} data-testid="image-stage-spinner" />}
      {src && (
        <img
          ref={imgElRef}
          src={src}
          alt={file.name}
          onLoad={(e) => {
            const el = e.currentTarget;
            setNatural({ w: el.naturalWidth, h: el.naturalHeight });
            onReady?.();
          }}
          onError={() => onError?.(new Error(`image decode failed: ${file.name}`))}
          draggable={false}
          className={styles.stageImg}
        />
      )}
    </div>
  );
}
