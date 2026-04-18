import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../../stores';
import { isMediaKind } from '../../../utils/file-kind';
import { ImageStage } from './ImageStage';
import { VideoStage } from './VideoStage';
import styles from './MediaViewer.module.css';

export function MediaViewer() {
  const state = useStore(s => s.mediaViewer);
  const closeMediaViewer = useStore(s => s.closeMediaViewer);
  const setMediaViewerCurrent = useStore(s => s.setMediaViewerCurrent);

  const containerRef = useRef<HTMLDivElement>(null);
  const [chromeVisible, setChromeVisible] = useState(true);
  const idleTimerRef = useRef<number | null>(null);
  const [viewport, setViewport] = useState({ width: 800, height: 600 });
  const [zoomCmd, setZoomCmd] = useState({ in: 0, out: 0, reset: 0 });

  // 只关心 open/close 切换，不关心 state 内容变化，提成布尔以满足 exhaustive-deps
  const isOpen = !!state;

  // 尺寸追踪
  useEffect(() => {
    if (!isOpen) return;
    const update = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [isOpen]);

  // 控件淡出
  const kickIdleTimer = useCallback(() => {
    setChromeVisible(true);
    if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => setChromeVisible(false), 2500);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    kickIdleTimer();
    const onMove = () => kickIdleTimer();
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    };
  }, [isOpen, kickIdleTimer]);

  // 切换逻辑
  const currentIndex = useMemo(() => {
    if (!state) return -1;
    return state.files.findIndex(f => f.id === state.currentId);
  }, [state]);

  const canPrev = currentIndex > 0;
  const canNext = state ? currentIndex >= 0 && currentIndex < state.files.length - 1 : false;

  const goPrev = useCallback(() => {
    if (!state || !canPrev) return;
    setMediaViewerCurrent(state.files[currentIndex - 1].id);
  }, [state, canPrev, currentIndex, setMediaViewerCurrent]);

  const goNext = useCallback(() => {
    if (!state || !canNext) return;
    setMediaViewerCurrent(state.files[currentIndex + 1].id);
  }, [state, canNext, currentIndex, setMediaViewerCurrent]);

  // 键盘快捷键（window 级，挂 `useEffect`）
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      // 避免和原生 <video> 冲突：video focus 时 Space 留给原生
      if (e.key === ' ' && document.activeElement instanceof HTMLVideoElement) return;
      switch (e.key) {
        case 'Escape': e.preventDefault(); closeMediaViewer(); break;
        case 'ArrowLeft': e.preventDefault(); goPrev(); break;
        case 'ArrowRight': e.preventDefault(); goNext(); break;
        case '+':
        case '=':
          e.preventDefault();
          setZoomCmd((c) => ({ ...c, in: c.in + 1 }));
          break;
        case '-':
          e.preventDefault();
          setZoomCmd((c) => ({ ...c, out: c.out + 1 }));
          break;
        case '0':
          e.preventDefault();
          setZoomCmd((c) => ({ ...c, reset: c.reset + 1 }));
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, closeMediaViewer, goPrev, goNext]);

  // 自动关闭：当前文件丢失或非媒体类型
  useEffect(() => {
    if (!state) return;
    const current = state.files.find(f => f.id === state.currentId);
    if (!current || !isMediaKind(current.kind)) {
      closeMediaViewer();
    }
  }, [state, closeMediaViewer]);

  if (!state) return null;

  const current = state.files[currentIndex];
  if (!current || !isMediaKind(current.kind)) return null;
  const prev = canPrev ? state.files[currentIndex - 1] : undefined;
  const next = canNext ? state.files[currentIndex + 1] : undefined;
  const multi = state.files.length > 1;

  const onOverlayClick = (e: React.MouseEvent) => {
    // 只响应遮罩本身的点击（不拦截内部冒泡）
    if (e.target === e.currentTarget) closeMediaViewer();
  };

  return (
    <div
      ref={containerRef}
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label="媒体预览"
      data-testid="media-viewer-overlay"
      onClick={onOverlayClick}
    >
      {/* 顶栏 */}
      <div className={`${styles.topbar} ${chromeVisible ? '' : styles.hidden}`}>
        <span className={styles.name} data-testid="media-viewer-name">{current.name}</span>
        {multi && (
          <span className={styles.index} data-testid="media-viewer-index">
            {currentIndex + 1} / {state.files.length}
          </span>
        )}
        <button
          className={styles.closeBtn}
          data-testid="media-viewer-close"
          aria-label="关闭"
          onClick={(e) => { e.stopPropagation(); closeMediaViewer(); }}
        >×</button>
      </div>

      {/* 左右箭头（仅多张时） */}
      {multi && (
        <>
          <button
            className={`${styles.navBtn} ${styles.navPrev} ${chromeVisible ? '' : styles.hidden}`}
            data-testid="media-viewer-prev"
            aria-label="上一张"
            disabled={!canPrev}
            onClick={(e) => { e.stopPropagation(); goPrev(); }}
          >‹</button>
          <button
            className={`${styles.navBtn} ${styles.navNext} ${chromeVisible ? '' : styles.hidden}`}
            data-testid="media-viewer-next"
            aria-label="下一张"
            disabled={!canNext}
            onClick={(e) => { e.stopPropagation(); goNext(); }}
          >›</button>
        </>
      )}

      {/* Stage */}
      <div className={styles.stageWrap} onClick={(e) => e.stopPropagation()}>
        {current.kind === 'video' ? (
          <VideoStage file={current} viewport={viewport} />
        ) : (
          <ImageStage
            file={current}
            viewport={viewport}
            neighbors={{ prev, next }}
            zoomCmd={zoomCmd}
            key={current.id}
          />
        )}
      </div>
    </div>
  );
}
