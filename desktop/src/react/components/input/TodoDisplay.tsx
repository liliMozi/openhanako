import { useState } from 'react';
import styles from './InputArea.module.css';

export function TodoDisplay({ todos }: { todos: Array<{ text: string; done: boolean }> }) {
  const [open, setOpen] = useState(false);

  if (!todos || todos.length === 0) return null;

  const done = todos.filter(td => td.done).length;
  const current = todos.find(td => !td.done);

  return (
    <div className={`${styles['todo-bar']}${open ? ` ${styles['todo-bar-open']}` : ''}`}>
      {open && (
        <div className={styles['todo-bar-list']}>
          {todos.map((td, i) => (
            <div key={`todo-${i}`} className={`${styles['todo-bar-item']}${td.done ? ` ${styles['todo-bar-done']}` : ''}`}>
              <span className={styles['todo-bar-check']}>{td.done ? '✓' : '○'}</span>
              <span>{td.text}</span>
            </div>
          ))}
        </div>
      )}
      <button className={styles['todo-bar-trigger']} onClick={() => setOpen(!open)}>
        <span className={styles['todo-bar-icon']}>☑</span>
        <span className={styles['todo-bar-preview']}>
          {current ? current.text : 'All done'}
        </span>
        <span className={styles['todo-bar-count']}>{done}/{todos.length}</span>
      </button>
    </div>
  );
}
