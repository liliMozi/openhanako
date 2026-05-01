import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../hooks/use-stream-buffer', () => ({
  streamBufferManager: {
    handle: vi.fn(),
  },
}));

vi.mock('../../stores/session-actions', () => ({
  loadSessions: vi.fn(),
}));

vi.mock('../../stores/desk-actions', () => ({
  loadDeskFiles: vi.fn(),
}));

vi.mock('../../stores/channel-actions', () => ({
  loadChannels: vi.fn(),
  openChannel: vi.fn(),
}));

vi.mock('../../stores/artifact-actions', () => ({
  handleArtifact: vi.fn(),
}));

vi.mock('../../services/app-event-actions', () => ({
  handleAppEvent: vi.fn(),
}));

vi.mock('../../services/stream-resume', () => ({
  replayStreamResume: vi.fn(),
  isStreamResumeRebuilding: () => null,
  isStreamScopedMessage: () => false,
  updateSessionStreamMeta: vi.fn(),
}));

vi.mock('../../services/stream-key-dispatcher', () => ({
  dispatchStreamKey: vi.fn(),
}));

import { streamBufferManager } from '../../hooks/use-stream-buffer';
import { useStore } from '../../stores';
import { applyStreamingStatus, configureWsMessageHandler, handleServerMessage } from '../../services/ws-message-handler';
import { dispatchStreamKey } from '../../services/stream-key-dispatcher';
import { handleAppEvent } from '../../services/app-event-actions';

describe('ws-message-handler applyStreamingStatus', () => {
  beforeEach(() => {
    useStore.setState({
      currentSessionPath: '/focused.jsonl',
      pendingNewSession: false,
      sessions: [],
      streamingSessions: [],
      inlineErrors: {},
    } as never);
  });

  it('isStreaming=true 对传入的 path 做 addStreamingSession（即使不是焦点 session）', () => {
    applyStreamingStatus(true, '/other.jsonl');
    expect(useStore.getState().streamingSessions).toEqual(['/other.jsonl']);
  });

  it('isStreaming=false 对传入的 path 做 removeStreamingSession（非焦点 session 也必须清）', () => {
    useStore.setState({ streamingSessions: ['/focused.jsonl', '/other.jsonl'] } as never);
    applyStreamingStatus(false, '/other.jsonl');
    expect(useStore.getState().streamingSessions).toEqual(['/focused.jsonl']);
  });

  it('stream_resume 场景：服务端返回 isStreaming=false，前端把焦点 session 从 streamingSessions 移除', () => {
    useStore.setState({ streamingSessions: ['/focused.jsonl'] } as never);
    applyStreamingStatus(false, '/focused.jsonl');
    expect(useStore.getState().streamingSessions).toEqual([]);
  });

  it('isStreaming=true 时重复调用不会产生重复 path', () => {
    applyStreamingStatus(true, '/focused.jsonl');
    applyStreamingStatus(true, '/focused.jsonl');
    expect(useStore.getState().streamingSessions).toEqual(['/focused.jsonl']);
  });

  it('sessionPath 为 null 不抛错（防御调用方漏传）', () => {
    useStore.setState({ streamingSessions: ['/focused.jsonl'] } as never);
    expect(() => applyStreamingStatus(false, null)).not.toThrow();
    expect(useStore.getState().streamingSessions).toEqual(['/focused.jsonl']);
  });
});

describe('ws-message-handler session-scoped desktop events', () => {
  beforeEach(() => {
    useStore.setState({
      currentSessionPath: '/session/a.jsonl',
      pendingNewSession: false,
      sessions: [{
        path: '/session/a.jsonl',
        title: 'A',
        firstMessage: 'hello',
        modified: '2026-04-24T10:00:00.000Z',
        messageCount: 1,
        agentId: 'a1',
        agentName: 'Hana',
        cwd: null,
      }],
      chatSessions: {},
      streamingSessions: [],
      computerOverlayBySession: {},
    } as never);
    useStore.getState().clearSession('/session/a.jsonl');
    useStore.getState().initSession('/session/a.jsonl', [], false);
  });

  it('session_user_message 直接把 user message 追加到对应桌面 session', () => {
    handleServerMessage({
      type: 'session_user_message',
      sessionPath: '/session/a.jsonl',
      message: {
        text: 'hello from bridge',
        quotedText: 'quote',
        attachments: [{ path: '/tmp/a.png', name: 'a.png', isDir: false }],
      },
    });

    const items = useStore.getState().chatSessions['/session/a.jsonl']?.items || [];
    expect(items).toHaveLength(1);
    const first = items[0];
    expect(first?.type).toBe('message');
    if (!first || first.type !== 'message') throw new Error('expected message item');
    expect(first.data.role).toBe('user');
    expect(first.data.text).toBe('hello from bridge');
    expect(first.data.quotedText).toBe('quote');
    expect(first.data.attachments).toEqual([{ path: '/tmp/a.png', name: 'a.png', isDir: false }]);
  });

  it('computer_overlay 写入当前 session 的 overlay keyed 状态并支持 clear', () => {
    handleServerMessage({
      type: 'computer_overlay',
      sessionPath: '/session/a.jsonl',
      phase: 'running',
      action: 'click_element',
      leaseId: 'lease-1',
      snapshotId: 'snapshot-1',
      visualSurface: 'provider',
      target: { coordinateSpace: 'element', elementId: 'mock-button' },
      ts: 100,
    });

    expect(useStore.getState().computerOverlayBySession['/session/a.jsonl']).toMatchObject({
      phase: 'running',
      action: 'click_element',
      leaseId: 'lease-1',
      visualSurface: 'provider',
    });

    handleServerMessage({
      type: 'computer_overlay',
      sessionPath: '/session/a.jsonl',
      phase: 'clear',
      action: 'stop',
      ts: 101,
    });

    expect(useStore.getState().computerOverlayBySession['/session/a.jsonl']).toBeUndefined();
  });

  it('bridge_rc_attached / detached 直接补丁 sessions 列表上的接管态', () => {
    handleServerMessage({
      type: 'bridge_rc_attached',
      sessionPath: '/session/a.jsonl',
      sessionKey: 'feishu_dm_1@a1',
      platform: 'feishu',
      title: 'A',
    });

    expect(useStore.getState().sessions[0]?.rcAttachment).toEqual({
      sessionKey: 'feishu_dm_1@a1',
      platform: 'feishu',
      title: 'A',
    });

    handleServerMessage({
      type: 'bridge_rc_detached',
      sessionPath: '/session/a.jsonl',
    });

    expect(useStore.getState().sessions[0]?.rcAttachment).toBeNull();
  });
});

describe('ws-message-handler background chat stream routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({
      currentSessionPath: '/session/a.jsonl',
      pendingNewSession: false,
      sessions: [
        {
          path: '/session/a.jsonl',
          title: 'A',
          firstMessage: 'hello',
          modified: '2026-04-24T10:00:00.000Z',
          messageCount: 1,
          agentId: 'a1',
          agentName: 'Hana',
          cwd: null,
        },
        {
          path: '/session/b.jsonl',
          title: 'B',
          firstMessage: 'hi',
          modified: '2026-04-24T10:01:00.000Z',
          messageCount: 1,
          agentId: 'a1',
          agentName: 'Hana',
          cwd: null,
        },
      ],
      chatSessions: {},
      streamingSessions: [],
    } as never);
    useStore.getState().clearSession('/session/a.jsonl');
    useStore.getState().clearSession('/session/b.jsonl');
    useStore.getState().initSession('/session/a.jsonl', [], false);
    useStore.getState().initSession('/session/b.jsonl', [], false);
  });

  it('非当前 session 的正文流也进入主聊天 buffer，同时保留 streamKey 预览分发', () => {
    const msg = {
      type: 'text_delta',
      sessionPath: '/session/b.jsonl',
      delta: '后台正文',
    };

    handleServerMessage(msg);

    expect(streamBufferManager.handle).toHaveBeenCalledWith(msg);
    expect(dispatchStreamKey).toHaveBeenCalledWith('/session/b.jsonl', msg);
  });
});

describe('ws-message-handler app events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureWsMessageHandler({});
  });

  it('app_event 消息会 route 到 handleAppEvent', () => {
    handleServerMessage({
      type: 'app_event',
      event: {
        type: 'models-changed',
        payload: { reason: 'provider' },
      },
    });

    expect(handleAppEvent).toHaveBeenCalledWith('models-changed', { reason: 'provider' });
  });
});

describe('ws-message-handler turn_end side effects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({
      currentSessionPath: '/session/a.jsonl',
      pendingNewSession: false,
      sessions: [{
        path: '/session/a.jsonl',
        title: 'A',
        firstMessage: 'hello',
        modified: '2026-04-24T10:00:00.000Z',
        messageCount: 1,
        agentId: 'a1',
        agentName: 'Hana',
        cwd: null,
      }],
      chatSessions: {},
      streamingSessions: [],
    } as never);
  });

  it('turn_end requests context usage through the injected callback', () => {
    const requestContextUsage = vi.fn();
    configureWsMessageHandler({ requestContextUsage });

    handleServerMessage({
      type: 'turn_end',
      sessionPath: '/session/a.jsonl',
    });

    expect(requestContextUsage).toHaveBeenCalledWith('/session/a.jsonl');
  });
});
