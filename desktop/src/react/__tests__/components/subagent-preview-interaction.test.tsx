/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useStore } from '../../stores/index';
import { SubagentCard } from '../../components/chat/SubagentCard';
import { createSubagentPreviewSlice, type SubagentPreviewSlice } from '../../stores/subagent-preview-slice';
import { dispatchStreamKey } from '../../services/stream-key-dispatcher';

function makeSlice(): SubagentPreviewSlice {
  let state: SubagentPreviewSlice;
  const set = (partial: Partial<SubagentPreviewSlice> | ((s: SubagentPreviewSlice) => Partial<SubagentPreviewSlice>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  state = createSubagentPreviewSlice(set);
  return new Proxy({} as SubagentPreviewSlice, {
    get: (_, key: string) => (state as unknown as Record<string, unknown>)[key],
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('subagent preview state ownership', () => {
  let slice: SubagentPreviewSlice;

  beforeEach(() => {
    useStore.setState({
      currentSessionPath: null,
      subagentPreviewByTaskId: {},
    } as never);
    slice = makeSlice();
  });

  it('按 taskId 独立保存 preview 状态，且可同时展开多个 card', () => {
    slice.openSubagentPreview('task-a', '/session/a');
    slice.openSubagentPreview('task-b', '/session/b');

    expect(slice.subagentPreviewByTaskId['task-a']).toEqual({
      open: true,
      sessionPath: '/session/a',
      loading: false,
      loadedOnce: false,
    });
    expect(slice.subagentPreviewByTaskId['task-b']).toEqual({
      open: true,
      sessionPath: '/session/b',
      loading: false,
      loadedOnce: false,
    });
  });

  it('切换 currentSessionPath 不会影响 taskId-owned preview 状态', () => {
    useStore.getState().openSubagentPreview('task-a', '/session/a');
    useStore.getState().setSubagentPreviewLoading('task-a', true);
    useStore.getState().markSubagentPreviewLoaded('task-a');
    useStore.getState().setSubagentPreviewSessionPath('task-a', '/session/a-2');

    useStore.setState({ currentSessionPath: '/session/other' } as never);

    expect(useStore.getState().subagentPreviewByTaskId['task-a']).toEqual({
      open: true,
      sessionPath: '/session/a-2',
      loading: false,
      loadedOnce: true,
    });
  });

  it('重复 open 不会误关 preview，close 只影响对应 taskId', () => {
    useStore.getState().openSubagentPreview('task-a', '/session/a');
    useStore.getState().openSubagentPreview('task-b', '/session/b');
    useStore.getState().openSubagentPreview('task-a', '/session/a-2');
    useStore.getState().closeSubagentPreview('task-a');

    expect(useStore.getState().subagentPreviewByTaskId['task-a']).toEqual({
      open: false,
      sessionPath: '/session/a-2',
      loading: false,
      loadedOnce: false,
    });
    expect(useStore.getState().subagentPreviewByTaskId['task-b']).toEqual({
      open: true,
      sessionPath: '/session/b',
      loading: false,
      loadedOnce: false,
    });
  });

  it('关闭后的 preview 仍可显式更新 sessionPath，供异步回填使用', () => {
    useStore.getState().openSubagentPreview('task-a', '/session/a');
    useStore.getState().closeSubagentPreview('task-a');
    useStore.getState().setSubagentPreviewSessionPath('task-a', null);

    expect(useStore.getState().subagentPreviewByTaskId['task-a']).toEqual({
      open: false,
      sessionPath: null,
      loading: false,
      loadedOnce: false,
    });
  });
});

describe('SubagentCard inline preview interaction', () => {
  beforeEach(() => {
    useStore.setState({
      currentAgentId: null,
      agents: [],
      chatSessions: {
        '/session/subagent-a': {
          items: [{ type: 'message', data: { id: 'a-1', role: 'assistant', blocks: [{ type: 'text', html: '<p>Preview A</p>' }] } }],
          hasMore: false,
          loadingMore: false,
        },
        '/session/subagent-b': {
          items: [{ type: 'message', data: { id: 'b-1', role: 'assistant', blocks: [{ type: 'text', html: '<p>Preview B</p>' }] } }],
          hasMore: false,
          loadingMore: false,
        },
      },
      subagentPreviewByTaskId: {},
    } as never);
  });

  it('点击卡片展开 preview，再点收起时会保留内容到收起动画结束', () => {
    vi.useFakeTimers();

    render(
      <SubagentCard
        block={{
          taskId: 'task-a',
          task: 'do work',
          taskTitle: '任务：do work',
          agentName: 'SORA',
          streamKey: '/session/subagent-a',
          streamStatus: 'done',
          summary: 'done',
        }}
      />,
    );

    const toggle = screen.getByRole('button', { name: /SORA/i });
    fireEvent.click(toggle);
    expect(screen.getByText('Preview A')).toBeTruthy();

    fireEvent.click(toggle);
    expect(screen.getByText('Preview A')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(220);
    });

    expect(screen.queryByText('Preview A')).toBeNull();
  });

  it('收起态显式信任 taskTitle，而不是再从 task 猜摘要', () => {
    render(
      <SubagentCard
        block={{
          taskId: 'task-a',
          task: '任务：这是一段不该显示的旧字段内容\n\n你是一个生活整理顾问。请为用户制定一份一周生活整理清单。',
          taskTitle: '任务：制定一份一周生活整理清单',
          agentName: 'SORA',
          streamKey: '/session/subagent-a',
          streamStatus: 'done',
          summary: '这里是运行时输出，不该出现在收起态',
        }}
      />,
    );

    expect(screen.getByText('任务：制定一份一周生活整理清单')).toBeTruthy();
    expect(screen.queryByText('任务：这是一段不该显示的旧字段内容')).toBeNull();
    expect(screen.queryByText('这里是运行时输出，不该出现在收起态')).toBeNull();
  });

  it('展开后 header 继续显示 taskTitle，不切换成运行时输出', () => {
    render(
      <SubagentCard
        block={{
          taskId: 'task-a',
          task: '任务：这是一段旧正文\n\n详细要求',
          taskTitle: '任务：制定一份一周生活整理清单',
          agentName: 'SORA',
          streamKey: '/session/subagent-a',
          streamStatus: 'done',
          summary: '这里是运行时输出，不该抢占 header',
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /SORA/i }));

    expect(screen.getByText('任务：制定一份一周生活整理清单')).toBeTruthy();
    expect(screen.queryByText('这里是运行时输出，不该抢占 header')).toBeNull();
    expect(screen.getByText('Preview A')).toBeTruthy();
  });

  it('子 session 的 turn_end 不会把 subagent 卡片标记为完成', () => {
    render(
      <SubagentCard
        block={{
          taskId: 'task-a',
          task: 'do work',
          taskTitle: '任务：do work',
          agentName: 'SORA',
          streamKey: '/session/subagent-a',
          streamStatus: 'running',
        }}
      />,
    );

    expect(screen.getByText('已派出')).toBeTruthy();

    act(() => {
      dispatchStreamKey('/session/subagent-a', { type: 'turn_end', sessionPath: '/session/subagent-a' });
    });

    expect(screen.getByText('已派出')).toBeTruthy();
    expect(screen.queryByText('已完成')).toBeNull();
  });

  it('多张 subagent 卡可以同时保持展开', () => {
    render(
      <>
        <SubagentCard
          block={{
            taskId: 'task-a',
            task: 'do work',
            taskTitle: '任务：do work',
            agentName: 'SORA',
            streamKey: '/session/subagent-a',
            streamStatus: 'done',
            summary: 'done',
          }}
        />
        <SubagentCard
          block={{
            taskId: 'task-b',
            task: 'do work',
            taskTitle: '任务：do work',
            agentName: 'MORI',
            streamKey: '/session/subagent-b',
            streamStatus: 'done',
            summary: 'done',
          }}
        />
      </>,
    );

    fireEvent.click(screen.getByRole('button', { name: /SORA/i }));
    fireEvent.click(screen.getByRole('button', { name: /MORI/i }));

    expect(screen.getByText('Preview A')).toBeTruthy();
    expect(screen.getByText('Preview B')).toBeTruthy();
  });
});
