import React, { useState, useEffect, useRef, useCallback } from 'react';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import styles from './WechatQrcodeOverlay.module.css';

type QrStatus = 'loading' | 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error';

const MAX_REFRESH = 3;

export function WechatQrcodeOverlay() {
  const [visible, setVisible] = useState(false);
  const [qrcodeUrl, setQrcodeUrl] = useState('');
  const [qrcodeId, setQrcodeId] = useState('');
  const [status, setStatus] = useState<QrStatus>('loading');
  const [error, setError] = useState('');
  const [refreshCount, setRefreshCount] = useState(0);
  const stoppedRef = useRef(true);

  const stopPolling = useCallback(() => { stoppedRef.current = true; }, []);

  const close = useCallback(() => {
    stopPolling();
    setVisible(false);
    setQrcodeUrl('');
    setQrcodeId('');
    setStatus('loading');
    setError('');
    setRefreshCount(0);
  }, [stopPolling]);

  const fetchQrcode = useCallback(async () => {
    setStatus('loading');
    setError('');
    try {
      const res = await hanaFetch('/api/bridge/wechat/qrcode', { method: 'POST' });
      const data = await res.json();
      if (data.ok && data.qrcodeUrl) {
        setQrcodeUrl(data.qrcodeUrl);
        setQrcodeId(data.qrcodeId);
        setStatus('waiting');
      } else {
        setStatus('error');
        setError(data.error || t('settings.bridge.wechatLoginFailed'));
      }
    } catch (err: unknown) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  /**
   * 递归 await 轮询。每次等上一个请求完成后再等 1s 发下一个，
   * 避免 setInterval 在长轮询（35s hold）期间堆叠请求。
   */
  const startPolling = useCallback((id: string) => {
    stoppedRef.current = false;

    (async () => {
      while (!stoppedRef.current) {
        try {
          const res = await hanaFetch('/api/bridge/wechat/qrcode-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ qrcodeId: id }),
          });
          if (stoppedRef.current) return;
          const data = await res.json();

          if (data.status === 'scanned') {
            setStatus('scanned');
          } else if (data.status === 'confirmed' && data.botToken) {
            stoppedRef.current = true;
            setStatus('confirmed');
            await hanaFetch('/api/bridge/config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                platform: 'wechat',
                credentials: { botToken: data.botToken },
                enabled: true,
              }),
            });
            // 微信只绑定一个账号，扫码用户即 owner
            if (data.userId) {
              await hanaFetch('/api/bridge/owner', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ platform: 'wechat', userId: data.userId }),
              }).catch((err: unknown) => console.warn('[WechatQrcodeOverlay] set owner failed', err));
            }
            window.dispatchEvent(new Event('hana-bridge-reload'));
            setTimeout(close, 1200);
            return;
          } else if (data.status === 'expired') {
            stoppedRef.current = true;
            setRefreshCount((prev) => {
              const next = prev + 1;
              if (next >= MAX_REFRESH) {
                setStatus('error');
                setError(t('settings.bridge.wechatExpired'));
              } else {
                fetchQrcode();
              }
              return next;
            });
            return;
          }
        } catch { /* 网络错误静默重试 */ }

        // 请求完成后等 1 秒再发下一个
        if (!stoppedRef.current) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    })();
  }, [close, fetchQrcode]);

  // 监听显示事件
  useEffect(() => {
    const show = () => {
      setVisible(true);
      setRefreshCount(0);
      fetchQrcode();
    };
    window.addEventListener('hana-show-wechat-qrcode', show);
    return () => {
      window.removeEventListener('hana-show-wechat-qrcode', show);
      stopPolling();
    };
  }, [fetchQrcode, stopPolling]);

  // qrcodeId 变化时开始轮询（不依赖 status，避免 scanned 状态触发 cleanup）
  useEffect(() => {
    if (qrcodeId) {
      startPolling(qrcodeId);
    }
    return stopPolling;
  }, [qrcodeId, startPolling, stopPolling]);

  if (!visible) return null;

  const statusLabel = (() => {
    switch (status) {
      case 'loading': return t('settings.bridge.wechatScanning');
      case 'waiting': return t('settings.bridge.wechatScanning');
      case 'scanned': return t('settings.bridge.wechatScanned');
      case 'confirmed': return t('settings.bridge.wechatLoginSuccess');
      case 'expired': return t('settings.bridge.wechatExpired');
      case 'error': return error || t('settings.bridge.wechatLoginFailed');
      default: return '';
    }
  })();

  const statusClass = status === 'confirmed' ? styles.success
    : (status === 'error' || status === 'expired') ? styles.error
    : '';

  return (
    <div className={`${styles.overlay} ${styles.visible}`} onClick={close}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <button className={styles.closeBtn} onClick={close} aria-label="close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        <div className={styles.title}>{t('settings.bridge.wechat')}</div>

        <div className={styles.qrcodeContainer}>
          {status === 'loading' && <span className={styles.loading}>...</span>}
          {qrcodeUrl && status !== 'loading' && (
            <img className={styles.qrcodeImg} src={qrcodeUrl} alt="WeChat QR Code" />
          )}
        </div>

        <div className={`${styles.statusText} ${statusClass}`}>{statusLabel}</div>
      </div>
    </div>
  );
}
