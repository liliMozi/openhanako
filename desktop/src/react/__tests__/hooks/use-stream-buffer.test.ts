/**
 * streamBufferManager 行为测试
 *
 * 聚焦 "MOOD 后中断" bug 的三条防线：
 *   1) snapshot 能反映 in-flight 内容（供 loadMessages 合并）
 *   2) invalidate 桥接能清掉 buf（数据归属方主动清）
 *   3) ensureMessage 自愈：session 被 initSession 覆盖后，后续 live 事件仍能
 *      绑定回同一条 assistant message，而不是靠"最后一条消息"猜目标
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
    useStore.setState({
      sessions: [{
        path: PATH,
        agentId: 'owner',
        title: null,
        firstMessage: '',
        modified: '',
        messageCount: 0,
      }],
      agents: [{ id: 'owner', yuan: 'butter' }],
      currentAgentId: 'focus',
      agentYuan: 'hanako',
    } as never);

    streamBufferManager.handle({ type: 'mood_start', sessionPath: PATH });
    streamBufferManager.handle({ type: 'mood_text', sessionPath: PATH, delta: 'Vibe: 好\n' });
    streamBufferManager.handle({ type: 'mood_text', sessionPath: PATH, delta: 'Will: 继续' });
    streamBufferManager.handle({ type: 'mood_end', sessionPath: PATH });
    streamBufferManager.handle({ type: 'text_delta', sessionPath: PATH, delta: '正文开始' });

    const snap = snapshotStreamBuffer(PATH);
    const streamed = getItems()[1];
    expect(streamed?.type).toBe('message');
    expect(snap).not.toBeNull();
    expect(snap!.hasContent).toBe(true);
    expect(snap!.messageId).toBe(streamed && streamed.type === 'message' ? streamed.data.id : null);
    expect(snap!.mood).toBe('Vibe: 好\nWill: 继续');
    expect(snap!.moodYuan).toBe('butter');
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

  it('initSession 覆盖同 path 后，后续 tool 事件仍绑定回原 assistant 消息', () => {
    streamBufferManager.handle({ type: 'text_delta', sessionPath: PATH, delta: 'first' });
    expect(getItems().length).toBe(2);
    expect(lastRole()).toBe('assistant');
    const firstAssistant = getItems()[1];
    const assistantId = firstAssistant?.type === 'message' ? firstAssistant.data.id : null;
    expect(assistantId).toBeTruthy();

    // 模拟 loadMessages 覆盖同 path：store 里暂时只剩 user。
    useStore.getState().initSession(PATH, [userItem('u1', 'hi')], false);
    expect(getItems().length).toBe(1);
    expect(lastRole()).toBe('user');

    // 后续不一定还有 text_delta；tool_start 也必须能把同一条 assistant 重新接回来。
    streamBufferManager.handle({ type: 'tool_start', sessionPath: PATH, name: 'web.search', args: { q: 'mi mo' } });
    expect(getItems().length).toBe(2);
    expect(lastRole()).toBe('assistant');
    const last = getItems()[1];
    expect(last.type).toBe('message');
    if (last.type !== 'message') throw new Error('expected assistant message');
    expect(last.data.id).toBe(assistantId);
    expect(last.data.blocks?.some((block: { type: string }) => block.type === 'tool_group')).toBe(true);
  });
});
