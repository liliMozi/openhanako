import { useState } from 'react';
import styles from './InputArea.module.css';
import { useI18n } from '../../hooks/use-i18n';
import type { TodoItem, TodoStatus } from '../../types';

/**
 * TodoDisplay — 对标 Claude Code TodoWrite 的三态渲染组件
 *
 * - pending: ○ 灰色默认
 * - in_progress: ⟳ accent 色，显示 activeForm
 * - completed: ✓ success 色 + 删除线
 *
 * TodoItem 严格 3 字段，不加索引签名或透传式消费。
 */

const STATUS_ICON: Record<TodoStatus, string> = {
  pending: '○',
  in_progress: '⟳',
  completed: '✓',
};

const STATUS_CLASS: Record<TodoStatus, string> = {
  pending: 'todo-bar-pending',
  in_progress: 'todo-bar-in-progress',
  completed: 'todo-bar-done',
};

/**
 * 展示文案：in_progress 用 activeForm，否则用 content
 * 若 activeForm 缺失（旧数据降级），fallback 到 content
 */
function displayText(todo: TodoItem): string {
  if (todo.status === 'in_progress' && todo.activeForm) return todo.activeForm;
  return todo.content || todo.activeForm || '';
}

/**
 * 折叠态预览：优先第一个 in_progress，否则第一个 pending，全完成显示 allDone 文案
 */
function pickPreview(todos: TodoItem[], allDoneText: string): string {
  const inProgress = todos.find((t) => t.status === 'in_progress');
  if (inProgress) return displayText(inProgress);
  const pending = todos.find((t) => t.status === 'pending');
  if (pending) return displayText(pending);
  return allDoneText;
}

export function TodoDisplay({ todos }: { todos: TodoItem[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  if (!todos || todos.length === 0) return null;

  const completedCount = todos.filter((t) => t.status === 'completed').length;
  const preview = pickPreview(todos, t('common.allDone'));

  return (
    <div className={`${styles['todo-bar']}${open ? ` ${styles['todo-bar-open']}` : ''}`}>
      {open && (
        <div className={styles['todo-bar-list']}>
          {todos.map((td, i) => {
            const statusClass = styles[STATUS_CLASS[td.status]] ?? '';
            return (
              <div
                key={`todo-${i}`}
                className={`${styles['todo-bar-item']}${statusClass ? ` ${statusClass}` : ''}`}
              >
                <span className={styles['todo-bar-check']}>{STATUS_ICON[td.status]}</span>
                <span>{displayText(td)}</span>
              </div>
            );
          })}
        </div>
      )}
      <button className={styles['todo-bar-trigger']} onClick={() => setOpen(!open)}>
        <span className={styles['todo-bar-icon']}>☑</span>
        <span className={styles['todo-bar-preview']}>{preview}</span>
        <span className={styles['todo-bar-count']}>
          {completedCount}/{todos.length}
        </span>
      </button>
    </div>
  );
}
