// @vitest-environment jsdom

import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComputerUseOverlay } from '../../components/ComputerUseOverlay';
import { getWebSocket } from '../../services/websocket';
import { useStore } from '../../stores';

vi.mock('../../services/websocket', () => ({
  getWebSocket: vi.fn(),
}));

describe('ComputerUseOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({
      currentSessionPath: '/session/a.jsonl',
      computerOverlayBySession: {},
    } as never);
  });

  it('does not draw background action cursors in the Hanako window', () => {
    useStore.getState().setComputerOverlayForSession('/session/b.jsonl', {
      phase: 'running',
      action: 'click_element',
      ts: 100,
    });
    const first = render(<ComputerUseOverlay />);
    expect(first.container.firstChild).toBeNull();
    first.unmount();

    useStore.getState().setComputerOverlayForSession('/session/a.jsonl', {
      phase: 'running',
      action: 'click_element',
      visualSurface: 'renderer',
      target: { coordinateSpace: 'element', elementId: 'mock-button' },
      ts: 101,
    });
    const second = render(<ComputerUseOverlay />);
    expect(second.container.querySelector('[data-action="click_element"]')).toBeNull();
  });

  it('does not draw done pulses in the Hanako window', () => {
    useStore.getState().setComputerOverlayForSession('/session/a.jsonl', {
      phase: 'done',
      action: 'click_element',
      target: { coordinateSpace: 'element', elementId: 'mock-button' },
      ts: 101,
    });
    render(<ComputerUseOverlay />);

    expect(document.querySelector('[data-action="click_element"]')).toBeNull();
  });

  it('does not draw a renderer cursor when the provider owns the visual surface', () => {
    useStore.getState().setComputerOverlayForSession('/session/a.jsonl', {
      phase: 'running',
      action: 'click_element',
      visualSurface: 'provider',
      target: { coordinateSpace: 'element', elementId: 'mock-button' },
      ts: 101,
    } as never);
    render(<ComputerUseOverlay />);

    expect(document.querySelector('[data-action="click_element"]')).toBeNull();
  });

  it('shows foreground takeover notice and aborts current session on Escape', () => {
    const send = vi.fn();
    vi.mocked(getWebSocket).mockReturnValue({ send } as unknown as WebSocket);
    useStore.getState().setComputerOverlayForSession('/session/a.jsonl', {
      phase: 'running',
      action: 'click_point',
      inputMode: 'foreground-input',
      requiresForeground: true,
      interruptKey: 'Escape',
      target: { coordinateSpace: 'window', x: 120, y: 140 },
      ts: 102,
    });

    render(<ComputerUseOverlay />);
    expect(document.body.textContent).toContain('前台接管');

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(send).toHaveBeenCalledWith(JSON.stringify({
      type: 'abort',
      sessionPath: '/session/a.jsonl',
    }));
    expect(useStore.getState().computerOverlayBySession['/session/a.jsonl']).toBeUndefined();
  });

  it('keeps the Hanako overlay reserved for foreground takeover UI only', () => {
    useStore.getState().setComputerOverlayForSession('/session/a.jsonl', {
      phase: 'running',
      action: 'click_point',
      inputMode: 'background',
      visualSurface: 'renderer',
      target: { coordinateSpace: 'window', x: 120, y: 140 },
      ts: 102,
    });

    const rendered = render(<ComputerUseOverlay />);

    expect(rendered.container.firstChild).toBeNull();
  });
});
