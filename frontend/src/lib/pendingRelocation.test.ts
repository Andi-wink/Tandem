import { describe, it, expect, beforeEach } from 'vitest';
import {
  setPendingRelocation,
  peekPendingRelocation,
  clearPendingRelocation,
} from './pendingRelocation';

beforeEach(() => {
  window.sessionStorage.clear();
});

describe('pendingRelocation', () => {
  it('sets and peeks a pending relocation without consuming it', () => {
    setPendingRelocation({ meetingId: 'live-1', toProjectPath: 'D:/clients/Acme/.tandem', projectName: 'Acme' });
    const p = peekPendingRelocation();
    expect(p?.meetingId).toBe('live-1');
    expect(p?.toProjectPath).toBe('D:/clients/Acme/.tandem');
    expect(p?.projectName).toBe('Acme');
    expect(typeof p?.createdAt).toBe('number');
    // Peek is non-destructive.
    expect(peekPendingRelocation()?.projectName).toBe('Acme');
  });

  it('carries the optional fromFolder for undo-back-to-origin', () => {
    setPendingRelocation({
      meetingId: 'live-2',
      fromFolder: 'C:/recordings/Meeting 2026-07-13',
      toProjectPath: 'D:/clients/Acme/.tandem',
      projectName: 'Acme',
    });
    expect(peekPendingRelocation()?.fromFolder).toBe('C:/recordings/Meeting 2026-07-13');
  });

  it('clear removes it', () => {
    setPendingRelocation({ meetingId: 'live-3', toProjectPath: 'D:/x/.tandem', projectName: 'X' });
    clearPendingRelocation();
    expect(peekPendingRelocation()).toBeNull();
  });

  it('returns null (and clears) on corrupt data', () => {
    window.sessionStorage.setItem('tandem.pendingRelocation', '{ not json');
    expect(peekPendingRelocation()).toBeNull();
    expect(window.sessionStorage.getItem('tandem.pendingRelocation')).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    window.sessionStorage.setItem('tandem.pendingRelocation', JSON.stringify({ projectName: 'X' }));
    expect(peekPendingRelocation()).toBeNull();
  });

  it('rejects an entry with no owning meetingId token (stale-session guard)', () => {
    // An entry lacking the session token must never be honored — it can't be proven to belong to
    // the current recording, so it must be treated as corrupt/stale.
    window.sessionStorage.setItem(
      'tandem.pendingRelocation',
      JSON.stringify({ toProjectPath: 'D:/a/.tandem', projectName: 'A', createdAt: Date.now() }),
    );
    expect(peekPendingRelocation()).toBeNull();
  });

  it('is a single slot — a second set overwrites the first', () => {
    setPendingRelocation({ meetingId: 'live-a', toProjectPath: 'D:/a/.tandem', projectName: 'A' });
    setPendingRelocation({ meetingId: 'live-b', toProjectPath: 'D:/b/.tandem', projectName: 'B' });
    expect(peekPendingRelocation()?.projectName).toBe('B');
    expect(peekPendingRelocation()?.meetingId).toBe('live-b');
  });
});
