/**
 * ChannelCreateOverlay — 创建频道弹窗
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useI18n } from '../../hooks/use-i18n';
import { hanaUrl } from '../../hooks/use-hana-fetch';
import { createChannel } from '../../stores/channel-actions';
import { yuanFallbackAvatar } from '../../utils/agent-helpers';
import styles from './Channels.module.css';

/* eslint-disable @typescript-eslint/no-explicit-any -- catch(err: any) 提取 message */

let _avatarTs = Date.now();
export function refreshCreateAvatarTs() { _avatarTs = Date.now(); }

function AgentChipAvatar({ agentId, agentName, yuan, hasAvatar }: {
  agentId: string; agentName: string; yuan?: string; hasAvatar?: boolean;
}) {
  const [error, setError] = useState(false);
  const src = hasAvatar ? hanaUrl(`/api/agents/${agentId}/avatar?t=${_avatarTs}`) : null;

  return (
    <span className={styles.chipAvatar}>
      {src && !error ? (
        <img
          src={src}
          className={styles.chipAvatarImg}
          onError={() => setError(true)}
        />
      ) : (
        <img src={yuanFallbackAvatar(yuan)} className={styles.chipAvatarImg} />
      )}
    </span>
  );
}

export function ChannelCreateOverlay() {
  const { t } = useI18n();
  const agents = useStore(s => s.agents);
  const visible = useStore(s => s.channelCreateOverlayVisible);
  const setVisible = useStore(s => s.setChannelCreateOverlayVisible);

  const [name, setName] = useState('');
  const [intro, setIntro] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [nameError, setNameError] = useState(false);
  const [membersError, setMembersError] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // When overlay becomes visible, reset form and select all agents
  useEffect(() => {
    if (visible) {
      setName('');
      setIntro('');
      setSelectedMembers(agents.map((a) => a.id));
      setNameError(false);
      setMembersError(false);
      requestAnimationFrame(() => nameRef.current?.focus());
    }
  }, [visible, agents]);

  const toggleMember = useCallback((agentId: string) => {
    setSelectedMembers((prev) =>
      prev.includes(agentId)
        ? prev.filter((id) => id !== agentId)
        : [...prev, agentId],
    );
    setMembersError(false);
  }, []);

  const handleCancel = useCallback(() => {
    setVisible(false);
  }, [setVisible]);

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      setVisible(false);
    }
  }, [setVisible]);

  const handleSubmit = useCallback(async () => {
    if (creating) return;
    if (!name.trim()) {
      nameRef.current?.focus();
      return;
    }
    if (selectedMembers.length < 2) {
      setMembersError(true);
      setTimeout(() => setMembersError(false), 1500);
      return;
    }

    setCreating(true);
    try {
      await createChannel(name.trim(), selectedMembers, intro.trim() || undefined);
      setVisible(false);
    } catch (err: any) {
      const msg = String(err?.message || err || '');
      if (msg.includes('已存在') || msg.includes('409')) {
        setNameError(true);
        nameRef.current?.focus();
        setTimeout(() => setNameError(false), 2000);
      } else {
        setVisible(false);
      }
    } finally {
      setCreating(false);
    }
  }, [creating, name, selectedMembers, intro, setVisible]);

  const handleNameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') handleCancel();
  }, [handleCancel]);

  return (
    <div
      className={`${styles.createOverlay}${visible ? ` ${styles.createOverlayVisible}` : ''}`}
      onClick={handleOverlayClick}
    >
      <div className={styles.createCard}>
        <h3 className={styles.createTitle}>{t('channel.createTitle')}</h3>
        <div className={styles.createField}>
          <label className={styles.createFieldLabel}>{t('channel.createName')}</label>
          <input
            ref={nameRef}
            className={styles.createInput}
            type="text"
            placeholder={nameError ? t('channel.nameExists') : t('channel.createNamePlaceholder')}
            autoComplete="off"
            value={name}
            onChange={(e) => { setName(e.target.value); setNameError(false); }}
            onKeyDown={handleNameKeyDown}
            style={nameError ? { outline: '1.5px solid var(--danger, #c44)' } : undefined}
          />
        </div>
        <div className={styles.createField}>
          <label className={styles.createFieldLabel}>{t('channel.createMembers')}</label>
          <div
            className={styles.channelCreateMembers}
            style={membersError ? { outline: '1.5px solid var(--danger, #c44)' } : undefined}
          >
            {agents.map((agent) => {
              const isSelected = selectedMembers.includes(agent.id);
              return (
                <button
                  key={agent.id}
                  type="button"
                  className={`${styles.channelCreateMemberChip}${isSelected ? ` ${styles.channelCreateMemberChipSelected}` : ''}`}
                  onClick={() => toggleMember(agent.id)}
                >
                  <AgentChipAvatar agentId={agent.id} agentName={agent.name} yuan={agent.yuan} hasAvatar={agent.hasAvatar} />
                  <span>{agent.name || agent.id}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className={styles.createField}>
          <label className={styles.createFieldLabel}>
            {t('channel.createIntro')}{' '}
            <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>
              {t('channel.createIntroOptional')}
            </span>
          </label>
          <textarea
            className={`${styles.createInput} ${styles.channelCreateIntro}`}
            rows={2}
            placeholder={t('channel.createIntroPlaceholder')}
            style={{ resize: 'vertical', minHeight: '2.4rem' }}
            value={intro}
            onChange={(e) => setIntro(e.target.value)}
          />
        </div>
        <div className={styles.createActions}>
          <button className={styles.createCancel} onClick={handleCancel}>
            {t('channel.createCancel')}
          </button>
          <button className={styles.createConfirm} onClick={handleSubmit} disabled={creating}>
            {t('channel.createConfirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
