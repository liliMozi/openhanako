import { describe, expect, it } from 'vitest';
import { SELECTION_OPEN_DELAY_MS } from '../../components/floating-input/SelectionFloatingInput';

describe('SelectionFloatingInput timing', () => {
  it('opens after a half-second selection debounce', () => {
    expect(SELECTION_OPEN_DELAY_MS).toBe(500);
  });
});
