import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch, hanaUrl } from '../api';
import { t } from '../helpers';
import { loadAgents } from '../actions';
import styles from '../Settings.module.css';

const platform = window.platform;
const CROP_SIZE = 256;
const OUTPUT_SIZE = 512;

interface CropState {
  role: string;
  img: HTMLImageElement;
  scale: number;
  minScale: number;
  ox: number;
  oy: number;
}

export function CropOverlay() {
  const [visible, setVisible] = useState(false);
  const [cropState, setCropState] = useState<CropState | null>(null);
  const [imgSrc, setImgSrc] = useState('');
  const viewportRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef({ dragging: false, startX: 0, startY: 0 });

  // Listen for crop events
  useEffect(() => {
    const handler = (e: Event) => {
      const { role, file } = (e as CustomEvent).detail;
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const minScale = CROP_SIZE / Math.min(img.width, img.height);
          const scale = minScale;
          const ox = (CROP_SIZE - img.width * scale) / 2;
          const oy = (CROP_SIZE - img.height * scale) / 2;
          setCropState({ role, img, scale, minScale, ox, oy });
          setImgSrc(reader.result as string);
          setVisible(true);
        };
        img.src = reader.result as string;
      };
      reader.readAsDataURL(file);
    };
    window.addEventListener('hana-open-cropper', handler);
    return () => window.removeEventListener('hana-open-cropper', handler);
  }, []);

  const close = useCallback(() => {
    setVisible(false);
    setCropState(null);
  }, []);

  const clamp = useCallback((s: CropState) => {
    const sw = s.img.width * s.scale;
    const sh = s.img.height * s.scale;
    s.ox = Math.min(0, Math.max(CROP_SIZE - sw, s.ox));
    s.oy = Math.min(0, Math.max(CROP_SIZE - sh, s.oy));
  }, []);

  const updateTransform = useCallback(() => {
    if (!cropState || !imgRef.current) return;
    imgRef.current.style.transform = `translate(${cropState.ox}px, ${cropState.oy}px) scale(${cropState.scale})`;
  }, [cropState]);

  useEffect(() => { updateTransform(); }, [cropState, updateTransform]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!cropState) return;
    dragRef.current = { dragging: true, startX: e.clientX - cropState.ox, startY: e.clientY - cropState.oy };
    viewportRef.current?.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!cropState || !dragRef.current.dragging) return;
    cropState.ox = e.clientX - dragRef.current.startX;
    cropState.oy = e.clientY - dragRef.current.startY;
    clamp(cropState);
    updateTransform();
  };

  const handlePointerUp = () => {
    dragRef.current.dragging = false;
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (!cropState) return;
    e.preventDefault();
    const oldScale = cropState.scale;
    const delta = e.deltaY > 0 ? 0.95 : 1.05;
    cropState.scale = Math.max(cropState.minScale, Math.min(cropState.minScale * 5, oldScale * delta));
    const cx = CROP_SIZE / 2;
    const cy = CROP_SIZE / 2;
    cropState.ox = cx - (cx - cropState.ox) * (cropState.scale / oldScale);
    cropState.oy = cy - (cy - cropState.oy) * (cropState.scale / oldScale);
    clamp(cropState);
    updateTransform();
  };

  const confirm = async () => {
    if (!cropState) return;
    const s = cropState;
    // eslint-disable-next-line no-restricted-syntax -- offscreen canvas for image crop, not part of React tree
    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const ctx = canvas.getContext('2d')!;
    const srcX = -s.ox / s.scale;
    const srcY = -s.oy / s.scale;
    const srcSize = CROP_SIZE / s.scale;
    ctx.drawImage(s.img, srcX, srcY, srcSize, srcSize, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    const dataUrl = canvas.toDataURL('image/png');
    const role = s.role;
    close();
    await uploadCroppedAvatar(role, dataUrl);
  };

  if (!visible) return null;

  return (
    <div className={`${styles['crop-overlay']} ${styles['visible']}`} onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className={styles['crop-card']}>
        <div className={styles['crop-header']}>
          <h3 className={styles['crop-title']}>{t('settings.crop.title')}</h3>
          <button className={styles['crop-close']} onClick={close}>✕</button>
        </div>
        <div
          className={styles['crop-viewport']}
          ref={viewportRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onWheel={handleWheel}
        >
          <img className={styles['crop-img']} ref={imgRef} src={imgSrc} draggable={false} />
          <div className={styles['crop-circle']} />
        </div>
        <div className={styles['crop-hint']}>{t('settings.crop.hint')}</div>
        <div className={styles['crop-actions']}>
          <button className={`${styles['crop-btn']} ${styles['crop-btn-cancel']}`} onClick={close}>{t('settings.crop.cancel')}</button>
          <button className={`${styles['crop-btn']} ${styles['crop-btn-confirm']}`} onClick={confirm}>{t('settings.crop.confirm')}</button>
        </div>
      </div>
    </div>
  );
}

async function uploadCroppedAvatar(role: string, dataUrl: string) {
  const store = useSettingsStore.getState();
  try {
    let uploadUrl: string;
    if (role === 'agent') {
      const agentId = store.getSettingsAgentId();
      uploadUrl = `/api/agents/${agentId}/avatar`;
    } else {
      uploadUrl = `/api/avatar/${role}`;
    }

    const res = await hanaFetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: dataUrl }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const ts = Date.now();
    if (role === 'agent') {
      const agentId = store.getSettingsAgentId();
      await loadAgents();
      if (agentId === store.currentAgentId) {
        platform?.settingsChanged?.('agent-updated', { agentId });
      }
    } else {
      const url = hanaUrl(`/api/avatar/${role}?t=${ts}`);
      store.set({ userAvatarUrl: url });
    }
    store.showToast(t('settings.crop.updated'), 'success');
  } catch (err: any) {
    store.showToast(err.message, 'error');
  }
}
