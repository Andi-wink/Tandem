import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordProjectDirUse,
  forgetProjectDirUse,
  getProjectDirHistory,
} from './projectDirHistory';

beforeEach(() => {
  window.localStorage.clear();
});

describe('forgetProjectDirUse (I3: unlearn on Undo)', () => {
  it('removes a single-use entry entirely when its count drops to zero', () => {
    recordProjectDirUse('D:/clients/Globex', 'Globex', 'Kickoff call');
    expect(getProjectDirHistory()).toHaveLength(1);

    forgetProjectDirUse('D:/clients/Globex');
    expect(getProjectDirHistory()).toHaveLength(0);
  });

  it('decrements by one, preserving counts contributed by other real uses', () => {
    recordProjectDirUse('D:/clients/Acme', 'Acme', 'Call 1');
    recordProjectDirUse('D:/clients/Acme', 'Acme', 'Call 2');
    recordProjectDirUse('D:/clients/Acme', 'Acme', 'Call 3');
    expect(getProjectDirHistory()[0].count).toBe(3);

    forgetProjectDirUse('D:/clients/Acme');
    const after = getProjectDirHistory();
    expect(after).toHaveLength(1);
    expect(after[0].count).toBe(2);
  });

  it('matches case- and separator-insensitively (Windows paths)', () => {
    recordProjectDirUse('D:/clients/Acme', 'Acme');
    forgetProjectDirUse('d:\\clients\\acme');
    expect(getProjectDirHistory()).toHaveLength(0);
  });

  it('is a no-op for an untracked directory', () => {
    recordProjectDirUse('D:/clients/Acme', 'Acme');
    forgetProjectDirUse('D:/clients/NeverFiled');
    const after = getProjectDirHistory();
    expect(after).toHaveLength(1);
    expect(after[0].count).toBe(1);
  });

  it('ignores empty/whitespace input', () => {
    recordProjectDirUse('D:/clients/Acme', 'Acme');
    forgetProjectDirUse('');
    forgetProjectDirUse('   ');
    expect(getProjectDirHistory()[0].count).toBe(1);
  });

  it('undoing an auto-route restores the prior ranking (regression scenario)', () => {
    // Correct folder used twice; a mis-routed auto-file bumps the wrong folder to a tie.
    recordProjectDirUse('D:/clients/Correct', 'Correct');
    recordProjectDirUse('D:/clients/Correct', 'Correct');
    recordProjectDirUse('D:/clients/Wrong', 'Wrong'); // the bad auto-route

    // Undo the bad route: Wrong must fall back out of contention.
    forgetProjectDirUse('D:/clients/Wrong');

    const ranked = getProjectDirHistory();
    expect(ranked).toHaveLength(1);
    expect(ranked[0].name).toBe('Correct');
  });
});
