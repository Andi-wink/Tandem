import { describe, it, expect } from 'vitest';
import {
  groupMeetingsByProject,
  loadCollapsedGroups,
  saveCollapsedGroups,
  loadGroupMode,
  saveGroupMode,
  UNFILED_KEY,
  COLLAPSED_GROUPS_KEY,
  GROUP_MODE_KEY,
  KeyValueStorage,
} from './sidebarGrouping';

const projects = [
  { name: 'Acme', path: 'D:/Dev-projects/Client_projects/Acme' },
  { name: 'Globex', path: 'D:/Dev-projects/Client_projects/Globex' },
];

/** In-memory storage for round-trip tests. */
function fakeStorage(initial: Record<string, string> = {}): KeyValueStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v; },
  };
}

const acmeFolder = (leaf: string) => `D:/Dev-projects/Client_projects/Acme/.tandem/${leaf}`;
const globexFolder = (leaf: string) => `D:/Dev-projects/Client_projects/Globex/.tandem/${leaf}`;

describe('groupMeetingsByProject', () => {
  it('groups filed meetings under their project and unfiled under Unfiled', () => {
    const meetings = [
      { id: 'm1', title: 'Acme Kickoff', folderPath: acmeFolder('Kickoff') },
      { id: 'm2', title: 'Loose note', folderPath: 'C:/Users/test/.meetily/recordings/Loose' },
      { id: 'm3', title: 'Acme Review', folderPath: acmeFolder('Review') },
    ];
    const groups = groupMeetingsByProject(meetings, projects);

    const acme = groups.find((g) => g.label === 'Acme');
    expect(acme?.meetings.map((m) => m.id)).toEqual(['m1', 'm3']);

    const unfiled = groups.find((g) => g.isUnfiled);
    expect(unfiled?.key).toBe(UNFILED_KEY);
    expect(unfiled?.label).toBe('Unfiled');
    expect(unfiled?.meetings.map((m) => m.id)).toEqual(['m2']);
  });

  it('treats a null/undefined/empty folder path as Unfiled', () => {
    const meetings = [
      { id: 'a', title: 'no folder', folderPath: null },
      { id: 'b', title: 'undef folder' },
      { id: 'c', title: 'empty folder', folderPath: '' },
    ];
    const groups = groupMeetingsByProject(meetings, projects);
    expect(groups).toHaveLength(1);
    expect(groups[0].isUnfiled).toBe(true);
    expect(groups[0].meetings.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('orders groups by the recency of their most-recent meeting (first-seen), Unfiled last', () => {
    // meetings arrive newest-first. Globex's newest is at index 0, Acme's at index 1.
    const meetings = [
      { id: 'g1', title: 'Globex newest', folderPath: globexFolder('N') },
      { id: 'a1', title: 'Acme older', folderPath: acmeFolder('O') },
      { id: 'u1', title: 'Unfiled', folderPath: null },
      { id: 'g2', title: 'Globex oldest', folderPath: globexFolder('X') },
    ];
    const groups = groupMeetingsByProject(meetings, projects);
    expect(groups.map((g) => g.label)).toEqual(['Globex', 'Acme', 'Unfiled']);
    // within Globex, recency order is preserved
    expect(groups[0].meetings.map((m) => m.id)).toEqual(['g1', 'g2']);
  });

  it('always sorts Unfiled last even when it is the most recent group', () => {
    const meetings = [
      { id: 'u1', title: 'Unfiled newest', folderPath: null },
      { id: 'a1', title: 'Acme', folderPath: acmeFolder('K') },
    ];
    const groups = groupMeetingsByProject(meetings, projects);
    expect(groups.map((g) => g.label)).toEqual(['Acme', 'Unfiled']);
  });

  it('returns an empty array for no meetings', () => {
    expect(groupMeetingsByProject([], projects)).toEqual([]);
  });
});

describe('collapse-state persistence', () => {
  it('round-trips the collapsed set through storage', () => {
    const storage = fakeStorage();
    const set = new Set(['D:/Dev-projects/Client_projects/Acme', UNFILED_KEY]);
    saveCollapsedGroups(storage, set);
    expect(storage.data[COLLAPSED_GROUPS_KEY]).toBeTruthy();

    const loaded = loadCollapsedGroups(storage);
    expect(loaded).toEqual(set);
  });

  it('defaults to an empty set when nothing is stored (all expanded)', () => {
    expect(loadCollapsedGroups(fakeStorage())).toEqual(new Set());
  });

  it('degrades to an empty set on malformed JSON', () => {
    expect(loadCollapsedGroups(fakeStorage({ [COLLAPSED_GROUPS_KEY]: '{not json' }))).toEqual(new Set());
  });
});

describe('view-mode persistence', () => {
  it('round-trips the mode', () => {
    const storage = fakeStorage();
    saveGroupMode(storage, 'byProject');
    expect(storage.data[GROUP_MODE_KEY]).toBe('byProject');
    expect(loadGroupMode(storage)).toBe('byProject');
  });

  it('defaults to recent when unset or unrecognised', () => {
    expect(loadGroupMode(fakeStorage())).toBe('recent');
    expect(loadGroupMode(fakeStorage({ [GROUP_MODE_KEY]: 'garbage' }))).toBe('recent');
  });
});
