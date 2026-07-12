import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  setRecordingSeed,
  peekRecordingSeed,
  consumeRecordingSeed,
  clearRecordingSeed,
} from './recordingSeed';

beforeEach(() => {
  window.sessionStorage.clear();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('recordingSeed', () => {
  it('sets and peeks a seed without consuming it', () => {
    setRecordingSeed({ title: 'Acme discovery call', eventUid: 'e1', projectPath: 'C:/clients/acme' });
    expect(peekRecordingSeed()?.title).toBe('Acme discovery call');
    // Peek is non-destructive.
    expect(peekRecordingSeed()?.projectPath).toBe('C:/clients/acme');
  });

  it('consume returns the seed then removes it', () => {
    setRecordingSeed({ title: 'Beta sync', eventUid: 'e2' });
    expect(consumeRecordingSeed()?.title).toBe('Beta sync');
    expect(peekRecordingSeed()).toBeNull();
  });

  it('clear removes the seed', () => {
    setRecordingSeed({ title: 'X', eventUid: 'e3' });
    clearRecordingSeed();
    expect(peekRecordingSeed()).toBeNull();
  });

  it('expires the seed after the 2-minute TTL', () => {
    const t0 = Date.parse('2026-07-13T12:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    setRecordingSeed({ title: 'Stale', eventUid: 'e4' });
    // 90s later: still fresh.
    vi.setSystemTime(t0 + 90_000);
    expect(peekRecordingSeed()?.title).toBe('Stale');
    // Past 2 min: expired and cleared.
    vi.setSystemTime(t0 + 121_000);
    expect(peekRecordingSeed()).toBeNull();
    expect(window.sessionStorage.getItem('tandem.recordingSeed')).toBeNull();
  });

  it('degrades to null on corrupt JSON', () => {
    window.sessionStorage.setItem('tandem.recordingSeed', '{not json');
    expect(peekRecordingSeed()).toBeNull();
  });
});
