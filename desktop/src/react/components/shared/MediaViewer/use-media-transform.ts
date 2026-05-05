import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';

export interface Transform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface ScaleRange {
  min: number;
  max: number;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * 以 viewport 为基准，计算让 natural 大小"适配并留 10% 边距"的 scale。
 */
export function computeFitScale(natural: Size | null, viewport: Size): number {
  if (!natural || natural.w === 0 || natural.h === 0) return 1;
  const ratio = Math.min(viewport.w / natural.w, viewport.h / natural.h);
  return ratio * 0.9;
}

/**
 * 缩放并锚定鼠标位置：缩放前后鼠标点对应的图片坐标保持不变。
 * @param point viewport 相对坐标
 * @param factor 乘性因子，例如 1.1 / (1/1.1)
 */
export function zoomAtPoint(
  current: Transform,
  point: { x: number; y: number },
  factor: number,
  range: ScaleRange,
): Transform {
  const desired = current.scale * factor;
  const newScale = clamp(desired, range.min, range.max);
  if (newScale === current.scale) return current;
  const k = newScale / current.scale - 1;
  return {
    scale: newScale,
    offsetX: current.offsetX - (point.x - current.offsetX) * k,
    offsetY: current.offsetY - (point.y - current.offsetY) * k,
  };
}

function computeCenterOffset(natural: Size | null, viewport: Size, scale: number): { x: number; y: number } {
  if (!natural || natural.w === 0 || natural.h === 0) return { x: 0, y: 0 };
  return {
    x: (viewport.w - natural.w * scale) / 2,
    y: (viewport.h - natural.h * scale) / 2,
  };
}

export function computeCenteredTransform(
  transform: Transform,
  natural: Size | null,
  viewport: Size,
): string {
  const center = computeCenterOffset(natural, viewport, transform.scale);
  return `translate(${center.x + transform.offsetX}px, ${center.y + transform.offsetY}px) scale(${transform.scale})`;
}

function zoomAtPointCentered(
  current: Transform,
  point: { x: number; y: number },
  factor: number,
  range: ScaleRange,
  natural: Size | null,
  viewport: Size,
): Transform {
  if (!natural || natural.w === 0 || natural.h === 0) {
    return zoomAtPoint(current, point, factor, range);
  }
  const desired = current.scale * factor;
  const newScale = clamp(desired, range.min, range.max);
  if (newScale === current.scale) return current;

  const currentCenter = computeCenterOffset(natural, viewport, current.scale);
  const nextCenter = computeCenterOffset(natural, viewport, newScale);
  const imageX = (point.x - currentCenter.x - current.offsetX) / current.scale;
  const imageY = (point.y - currentCenter.y - current.offsetY) / current.scale;
  return {
    scale: newScale,
    offsetX: point.x - nextCenter.x - imageX * newScale,
    offsetY: point.y - nextCenter.y - imageY * newScale,
  };
}

/**
 * MediaViewer 图像交互 hook。
 * 负责：transform 状态管理、滚轮/拖动/双击事件包装、reset 工具。
 */
export function useMediaTransform(opts: {
  natural: Size | null;
  viewport: Size;
  range?: ScaleRange;
}) {
  const fitScale = useMemo(() => computeFitScale(opts.natural, opts.viewport), [opts.natural, opts.viewport]);
  const range = useMemo<ScaleRange>(
    () => opts.range ?? { min: fitScale, max: Math.max(fitScale * 8, 1) },
    [opts.range, fitScale],
  );

  const [transform, setTransform] = useState<Transform>({ scale: fitScale, offsetX: 0, offsetY: 0 });

  // natural/viewport 变化时重置（切图或窗口尺寸变化）
  useEffect(() => {
    setTransform({ scale: fitScale, offsetX: 0, offsetY: 0 });
  }, [fitScale]);

  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number; moved: boolean } | null>(null);

  const onWheel = useCallback((e: React.WheelEvent<HTMLElement>) => {
    if (!e.altKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setTransform((t) => zoomAtPointCentered(t, point, factor, range, opts.natural, opts.viewport));
  }, [opts.natural, opts.viewport, range]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (transform.scale <= fitScale) return; // 只有放大后才允许拖动
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseX: transform.offsetX,
      baseY: transform.offsetY,
      moved: false,
    };
  }, [transform.scale, transform.offsetX, transform.offsetY, fitScale]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
    setTransform((t) => ({ ...t, offsetX: d.baseX + dx, offsetY: d.baseY + dy }));
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const el = e.currentTarget;
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    dragRef.current = null;
  }, []);

  const onDoubleClick = useCallback(() => {
    setTransform((t) => {
      const target = Math.abs(t.scale - fitScale) < 0.01 ? 1 : fitScale;
      return { scale: target, offsetX: 0, offsetY: 0 };
    });
  }, [fitScale]);

  const reset = useCallback(() => setTransform({ scale: fitScale, offsetX: 0, offsetY: 0 }), [fitScale]);

  const zoomIn = useCallback(
    () => setTransform((t) => zoomAtPointCentered(t, { x: opts.viewport.w / 2, y: opts.viewport.h / 2 }, 1.2, range, opts.natural, opts.viewport)),
    [opts.natural, opts.viewport, range],
  );
  const zoomOut = useCallback(
    () => setTransform((t) => zoomAtPointCentered(t, { x: opts.viewport.w / 2, y: opts.viewport.h / 2 }, 1 / 1.2, range, opts.natural, opts.viewport)),
    [opts.natural, opts.viewport, range],
  );

  return {
    transform,
    fitScale,
    range,
    cssTransform: computeCenteredTransform(transform, opts.natural, opts.viewport),
    onWheel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onDoubleClick,
    reset,
    zoomIn,
    zoomOut,
    dragMoved: () => dragRef.current?.moved ?? false,
  };
}
