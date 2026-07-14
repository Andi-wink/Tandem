import { describe, it, expect } from 'vitest';
import { shouldAcceptToggle, RECORD_TOGGLE_DEBOUNCE_MS } from './recordToggle';

describe('shouldAcceptToggle', () => {
  it('accepts the first toggle (no prior timestamp)', () => {
    expect(shouldAcceptToggle(null, 1000)).toBe(true);
  });

  it('drops a repeat inside the debounce window', () => {
    expect(shouldAcceptToggle(1000, 1000 + 500)).toBe(false);
    expect(shouldAcceptToggle(1000, 1000 + (RECORD_TOGGLE_DEBOUNCE_MS - 1))).toBe(false);
  });

  it('accepts a toggle exactly at the window boundary', () => {
    expect(shouldAcceptToggle(1000, 1000 + RECORD_TOGGLE_DEBOUNCE_MS)).toBe(true);
  });

  it('accepts a toggle after the window has elapsed', () => {
    expect(shouldAcceptToggle(1000, 1000 + RECORD_TOGGLE_DEBOUNCE_MS + 250)).toBe(true);
  });

  it('honors a custom window', () => {
    expect(shouldAcceptToggle(0, 100, 200)).toBe(false);
    expect(shouldAcceptToggle(0, 200, 200)).toBe(true);
  });
});
