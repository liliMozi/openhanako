import { memo, useRef, useEffect } from 'react';
import type { SlashItem } from '../InputArea';
import styles from './InputArea.module.css';

export const SlashCommandMenu = memo(function SlashCommandMenu({ commands, selected, busy, onSelect, onHover }: {
  commands: SlashItem[];
  selected: number;
  busy: string | null;
  onSelect: (cmd: SlashItem) => void;
  onHover: (i: number) => void;
}) {
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <div className={styles['slash-menu']}>
      {commands.map((cmd, i) => (
        <button
          key={cmd.name}
          ref={i === selected ? selectedRef : undefined}
          className={`${styles['slash-menu-item']}${i === selected ? ` ${styles.selected}` : ''}${busy === cmd.name ? ` ${styles.busy}` : ''}`}
          onMouseEnter={() => onHover(i)}
          onClick={() => !busy && onSelect(cmd)}
          disabled={!!busy}
        >
          <span className={styles['slash-menu-icon']} dangerouslySetInnerHTML={{ __html: cmd.icon }} />
          <span className={styles['slash-menu-label']}>{cmd.label}</span>
          <span className={styles['slash-menu-desc']}>{cmd.description}</span>
        </button>
      ))}
    </div>
  );
});
