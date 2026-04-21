/**
 * streamBufferManager 行为测试
 *
 * 聚焦 "MOOD 后中断" bug 的三条防线：
 *   1) snapshot 能反映 in-flight 内容（供 loadMessages 合并）
 *   2) invalidate 桥接能清掉 buf（数据归属方主动清）
 *   3) ensureMessage 自愈：session 被 initSession 覆盖后 last msg 变成 user
 *      时，新 text_delta 要重新 append 新 assistant，而不是卡在
 *      messageAppended=true 把正文写到 user 消息上
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { streamBufferManager } from '../../hooks/use-stream-buffer';
import {
  snapshotStreamBuffer,
  invalidateStreamBuffer,
} from '../../stores/stream-invalidator';
import { useStore } from '../../stores';
import type { ChatListItem } from '../../stores/chat-types';

const PATH = '/test/session.jsonl';

function userItem(id: string, text: string): ChatListItem {
  return { type: 'message', data: { id, role: 'user', text } };
}

function getItems(): ChatListItem[] {
  return useStore.getState().chatSessions[PATH]?.items ?? [];
}

function lastRole(): string | undefined {
  const items = getItems();
  const last = items[items.length - 1];
  return last?.type === 'message' ? last.data.role : undefined;
}

describe('streamBufferManager.snapshot', () => {
  beforeEach(() => {
    streamBufferManager.clearAll();
    useStore.getState().clearSession(PATH);
    useStore.getState().initSession(PATH, [userItem('u1', 'hi')], false);
  });

  it('空 buffer 返回 null', () => {
    expect(snapshotStreamBuffer(PATH)).toBeNull();
  });

  it('累积 mood + text 后，snapshot 反映当前内容', () => {
    streamBufferManager.handle({ type: 'mood_start', sessionPath: PATH });
    streamBufferManager.handle({ type: 'mood_text', sessionPath: PATH, delta: 'Vibe: 好\n' });
    streamBufferManager.handle({ type: 'mood_text', sessionPath: PATH, delta: 'Will: 继续' });
    streamBufferManager.handle({ type: 'mood_end', sessionPath: PATH });
    streamBufferManager.handle({ type: 'text_delta', sessionPath: PATH, delta: '正文开始' });

    const snap = snapshotStreamBuffer(PATH);
    expect(snap).not.toBeNull();
    expect(snap!.hasContent).toBe(true);
    expect(snap!.mood).toBe('Vibe: 好\nWill: 继续');
    expect(snap!.text).toBe('正文开始');
    expect(snap!.inMood).toBe(false);
  });

  it('invalidate 之后 snapshot 变 null（归属方清干净）', () => {
    streamBufferManager.handle({ type: 'text_delta', sessionPath: PATH, delta: 'abc' });
    expect(snapshotStreamBuffer(PATH)?.hasContent).toBe(true);

    invalidateStreamBuffer(PATH);
    expect(snapshotStreamBuffer(PATH)).toBeNull();
  });
});

describe('streamBufferManager.ensureMessage 自愈', () => {
  beforeEach(() => {
    streamBufferManager.clearAll();
    useStore.getState().clearSession(PATH);
    useStore.getState().initSession(PATH, [userItem('u1', 'hi')], false);
  });

  it('首次 text_delta 会 append 一条新 assistant', () => {
    streamBufferManager.handle({ type: 'text_delta', sessionPath: PATH, delta: '你好' });
    expect(getItems().length).toBe(2);
    expect(lastRole()).toBe('assistant');
  });

  it('initSession 覆盖同 path 让 last msg 变回 user 时，新 text_delta 自愈', () => {
    // 首次 delta：ensureMessage append 新 assistant，buf.messageAppended=true
    streamBufferManager.handle({ type: 'text_delta', sessionPath: PATH, delta: 'first' });
    expect(getItems().length).toBe(2);
    expect(lastRole()).toBe('assistant');

    // 模拟 loadMessages 的路径：initSession 覆盖同一 path（不触发 invalidate，
    // 因为 LRU 只淘汰别的 session）。此时 buf.messageAppended 还是 true，
    // 但 store 里 last msg 又回到 user——正是 bug 的核心场景。
    useStore.getState().initSession(PATH, [userItem('u1', 'hi')], false);
    expect(getItems().length).toBe(1);
    expect(lastRole()).toBe('user');

    // 下一个 delta：ensureMessage 的自愈分支应重新 append 新 assistant，
    // 避免后续 flush 把正文 html 塞进 user 消息。
    streamBufferManager.handle({ type: 'text_delta', sessionPath: PATH, delta: 'second' });
    expect(getItems().length).toBe(2);
    expect(lastRole()).toBe('assistant');
  });
});
