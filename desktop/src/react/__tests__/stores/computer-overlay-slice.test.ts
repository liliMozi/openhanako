import { describe, expect, it } from 'vitest';
import {
  computeComputerOverlayPosition,
  createComputerOverlaySlice,
  type ComputerOverlaySlice,
} from '../../stores/computer-overlay-slice';

describe('computer overlay slice', () => {
  function makeSlice() {
    let state = {} as ComputerOverlaySlice;
    const set = (partial: Partial<ComputerOverlaySlice> | ((s: ComputerOverlaySlice) => Partial<ComputerOverlaySlice>)) => {
      state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) };
    };
    state = createComputerOverlaySlice(set);
    return { get state() { return state; } };
  }

  it('stores and clears overlay events by session path', () => {
    const slice = makeSlice();
    slice.state.setComputerOverlayForSession('/s1', {
      phase: 'running',
      action: 'click_element',
      visualSurface: 'provider',
      target: { coordinateSpace: 'element', elementId: 'button-1' },
      ts: 100,
    } as never);

    expect(slice.state.computerOverlayBySession['/s1']).toMatchObject({
      phase: 'running',
      action: 'click_element',
      sessionPath: '/s1',
      visualSurface: 'provider',
    });

    slice.state.clearComputerOverlayForSession('/s1');
    expect(slice.state.computerOverlayBySession['/s1']).toBeUndefined();
  });

  it('computes bounded positions for window coordinates', () => {
    expect(computeComputerOverlayPosition({
      phase: 'running',
      action: 'click_point',
      sessionPath: '/s1',
      target: { coordinateSpace: 'window', x: 500, y: 400 },
      ts: 100,
    })).toEqual({ x: 50, y: 50 });
  });
});
