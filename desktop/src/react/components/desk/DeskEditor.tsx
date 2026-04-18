/**
 * JianEditor — jian.md 编辑器面板 + 执行记录
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { saveJianContent } from '../../stores/desk-actions';
import s from './Desk.module.css';

const EXEC_LOG_START = '<!-- exec-log -->';
const EXEC_LOG_END = '<!-- /exec-log -->';
const LOG_LINE_RE = /^- \[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s+(.+?)(?:\s+\|\s+(.+))?$/;

/** 从完整 jian 内容中分离指令和执行记录 */
function splitJian(raw: string) {
  const startIdx = raw.indexOf(EXEC_LOG_START);
  if (startIdx === -1) return { instructions: raw, logs: [] };
  const endIdx = raw.indexOf(EXEC_LOG_END, startIdx);
  const logBlock = endIdx === -1
    ? raw.slice(startIdx + EXEC_LOG_START.length)
    : raw.slice(startIdx + EXEC_LOG_START.length, endIdx);
  const logs = logBlock.trim().split('\n')
    .map(line => {
      const m = line.match(LOG_LINE_RE);
      if (!m) return null;
      return { time: m[1], task: m[2], result: m[3] || '', raw: line };
    })
    .filter(Boolean) as { time: string; task: string; result: string; raw: string }[];
  return { instructions: raw.slice(0, startIdx).trimEnd(), logs };
}

/** 将指令和日志条目重新拼合为完整 jian 内容 */
function combineJian(instructions: string, logs: { raw: string }[]) {
  if (logs.length === 0) return instructions;
  return instructions + '\n\n' + EXEC_LOG_START + '\n' + logs.map(l => l.raw).join('\n') + '\n' + EXEC_LOG_END;
}

export function JianEditor() {
  const deskJianContent = useStore(s => s.deskJianContent);
  const [localValue, setLocalValue] = useState('');
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const prevContentRef = useRef(deskJianContent);
  const logsRef = useRef<{ time: string; task: string; result: string; raw: string }[]>([]);

  // 解析 store 内容，分离指令和日志
  const parsed = useMemo(() => splitJian(deskJianContent || ''), [deskJianContent]);

  useEffect(() => {
    if (deskJianContent !== prevContentRef.current) {
      setLocalValue(parsed.instructions);
      logsRef.current = parsed.logs;
      prevContentRef.current = deskJianContent;
    }
  }, [deskJianContent, parsed]);

  // 初始化
  useEffect(() => {
    setLocalValue(parsed.instructions);
    logsRef.current = parsed.logs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = useCallback((instructions: string, logs: typeof logsRef.current) => {
    const full = combineJian(instructions, logs);
    useStore.setState({ deskJianContent: full });
    prevContentRef.current = full;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => saveJianContent(full), 800);
  }, []);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setLocalValue(value);
    save(value, logsRef.current);
  }, [save]);

  const handleDeleteLog = useCallback((idx: number) => {
    const next = logsRef.current.filter((_, i) => i !== idx);
    logsRef.current = next;
    save(localValue, next);
  }, [localValue, save]);

  return (
    <div className={s.editor} data-desk-editor="">
      <div className={s.editorHeader}>
        <span className={s.editorLabel}>{(window.t ?? ((p: string) => p))('desk.jianLabel')}</span>
      </div>
      <span className={s.editorStatus} ref={statusRef}></span>
      <textarea
        className={s.editorInput}
        placeholder={(window.t ?? ((p: string) => p))('desk.jianPlaceholder')}
        spellCheck={false}
        value={localValue}
        onChange={handleInput}
      />
      {parsed.logs.length > 0 && (
        <div className={s.execLog}>
          <div className={s.execLogHeader}>
            {(window.t ?? ((p: string) => p))('desk.execLogLabel')}
          </div>
          <ul className={s.execLogList}>
            {parsed.logs.map((log, i) => (
              <li key={log.time + i} className={s.execLogItem}>
                <span className={s.execLogTime}>{log.time}</span>
                <span className={s.execLogTask}>{log.task}</span>
                {log.result && <span className={s.execLogResult}>{log.result}</span>}
                <button
                  className={s.execLogDelete}
                  onClick={() => handleDeleteLog(i)}
                  title={(window.t ?? ((p: string) => p))('desk.execLogDelete')}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
