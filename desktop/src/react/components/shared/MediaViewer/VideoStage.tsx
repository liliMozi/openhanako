import { useEffect, useState } from 'react';
import type { FileRef } from '../../../types/file-ref';
import { loadMediaSource } from './media-source';
import styles from './MediaViewer.module.css';

// prop 名 `file`（不可用 `ref`，React 会截获）
interface Props {
  file: FileRef;
  viewport: { width: number; height: number };
  onReady?: () => void;
  onError?: (e: unknown) => void;
}

export function VideoStage({ file, viewport, onReady, onError }: Props) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    loadMediaSource(file)
      .then((s) => { if (!cancelled) setSrc(s.url); })
      .catch((err) => { if (!cancelled) onError?.(err); });
    return () => { cancelled = true; };
  }, [file.id]);

  return (
    <div className={styles.videoWrap} style={{ maxWidth: viewport.width, maxHeight: viewport.height }}>
      {!src && <div className={styles.spinner} data-testid="video-stage-spinner" />}
      {src && (
        <video
          src={src}
          controls
          autoPlay={false}
          onLoadedData={onReady}
          className={styles.videoEl}
          data-testid="video-stage-video"
        />
      )}
    </div>
  );
}
