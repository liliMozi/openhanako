/**
 * DeskEmptyOverlay — 未设置书桌路径时的空状态提示
 */

import { useStore } from '../../stores';
import { ICONS } from './desk-types';
import s from './Desk.module.css';

export function DeskEmptyOverlay() {
  const deskBasePath = useStore(s => s.deskBasePath);

  if (deskBasePath) return null;

  return (
    <div className={s.emptyOverlay}>
      <p className={s.emptyText}>{(window.t ?? ((p: string) => p))('desk.emptyTitle')}</p>
      <p className={s.emptyHint}>
        {(window.t ?? ((p: string) => p))('desk.emptyHint')}
      </p>
      <button className={s.emptyBtn} onClick={() => window.platform?.openSettings('work')}>
        <span dangerouslySetInnerHTML={{ __html: ICONS.settings }} />
        {(window.t ?? ((p: string) => p))('desk.goToSettings')}
      </button>
    </div>
  );
}
