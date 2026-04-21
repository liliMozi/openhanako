/**
 * LeavesOverlay — 树阴光影叠层
 *
 * 循环播放 leaves-overlay.mp4（正放+倒放拼接，无缝循环），
 * mix-blend-mode: multiply 让白色区域透明，阴影叠在界面上。
 * 通过 body class toggle 控制开关（和纸质纹理同一模式）。
 */

import { memo, useRef, useEffect, useState } from 'react';

// Vite 会处理这个 import，返回构建后的资源 URL
import leavesSrc from '../../assets/textures/leaves-overlay.mp4';

export const LeavesOverlay = memo(function LeavesOverlay() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [enabled, setEnabled] = useState(
    () => localStorage.getItem('hana-leaves-overlay') === '1',
  );

  // 监听跨窗口事件
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.type === 'leaves-overlay-changed') {
        setEnabled(detail.enabled);
      }
    };
    window.addEventListener('hana-settings', handler);
    return () => window.removeEventListener('hana-settings', handler);
  }, []);

  // 确保视频播放
  useEffect(() => {
    if (enabled && videoRef.current) {
      videoRef.current.play().catch(() => {});
    }
  }, [enabled]);

  if (!enabled) return null;

  return (
    <>
      {/* 亮度补偿（抵消 multiply 视频变暗） */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 139,
          pointerEvents: 'none',
          background: 'rgba(255, 253, 247, 0.12)',
        }}
      />
      <video
        ref={videoRef}
        autoPlay
        loop
        muted
        playsInline
        style={{
          position: 'fixed',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          mixBlendMode: 'multiply',
          opacity: 0.28,
          pointerEvents: 'none',
          zIndex: 140,
        }}
      >
        <source src={leavesSrc} type="video/mp4" />
      </video>
    </>
  );
});
