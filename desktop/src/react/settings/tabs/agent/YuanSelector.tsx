import React from 'react';
import { t } from '../../helpers';

import kongBannerUrl from '../../../../assets/kong-banner.jpg';

export function YuanSelector({ currentYuan, onChange }: { currentYuan: string; onChange: (key: string) => void }) {
  const types = t('yuan.types') || {};
  const entries = Object.entries(types) as [string, { label?: string; avatar?: string }][];
  const hIdx = entries.findIndex(([k]) => k === 'hanako');
  if (hIdx >= 0 && entries.length >= 3) {
    const [h] = entries.splice(hIdx, 1);
    entries.splice(1, 0, h);
  }

  const chips = entries.filter(([k]) => k !== 'kong');
  const kongMeta = (types as Record<string, { label?: string }>).kong;

  return (
    <div className="yuan-selector">
      <div className="yuan-chips">
        {chips.map(([key, meta]) => (
          <button
            key={key}
            className={`yuan-chip${key === currentYuan ? ' selected' : ''}`}
            type="button"
            onClick={() => { if (key !== currentYuan) onChange(key); }}
          >
            <img
              className="yuan-chip-avatar"
              src={`assets/${meta.avatar || 'Hanako.png'}`}
              draggable={false}
            />
            <div className="yuan-chip-info">
              <span className="yuan-chip-name">{key}</span>
              <span className="yuan-chip-desc">{meta.label || ''}</span>
            </div>
          </button>
        ))}
      </div>
      {kongMeta && (
        <button
          className={`yuan-kong-banner${currentYuan === 'kong' ? ' selected' : ''}`}
          type="button"
          style={{ backgroundImage: `url(${kongBannerUrl})` }}
          onClick={() => { if (currentYuan !== 'kong') onChange('kong'); }}
        >
          <span className="yuan-kong-name">{'\u7A7A'}</span>
          <span className="yuan-kong-desc">{kongMeta.label || ''}</span>
        </button>
      )}
    </div>
  );
}
