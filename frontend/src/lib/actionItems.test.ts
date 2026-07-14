import { describe, it, expect, beforeEach } from 'vitest';
import {
  extractActionItems,
  extractActionItemsFromMarkdown,
  extractActionItemsFromLegacy,
  extractActionItemsFromBlockNote,
  actionItemsToMarkdown,
  actionItemId,
  loadCheckedState,
  saveCheckedState,
  actionItemsStorageKey,
} from './actionItems';

describe('extractActionItemsFromMarkdown', () => {
  it('collects bullet items under an Action Items heading', () => {
    const md = [
      '## Session Summary',
      'We talked about the roadmap.',
      '',
      '## Action Items',
      '- Send the proposal to Acme',
      '- [ ] Schedule the follow-up call',
      '* Prepare the invoice',
      '',
      '## Next Steps',
      '- Not an action item',
    ].join('\n');
    expect(extractActionItemsFromMarkdown(md)).toEqual([
      'Send the proposal to Acme',
      'Schedule the follow-up call',
      'Prepare the invoice',
    ]);
  });

  it('matches "Immediate Action Items" heading case-insensitively', () => {
    const md = '# IMMEDIATE ACTION ITEMS\n1. Do the thing\n2) Do the other thing';
    expect(extractActionItemsFromMarkdown(md)).toEqual(['Do the thing', 'Do the other thing']);
  });

  it('returns empty when there is no action-items heading', () => {
    expect(extractActionItemsFromMarkdown('## Summary\n- a point')).toEqual([]);
  });

  it('strips checked task markers', () => {
    const md = '## Action Items\n- [x] Already done\n- [ ] Still to do';
    expect(extractActionItemsFromMarkdown(md)).toEqual(['Already done', 'Still to do']);
  });
});

describe('extractActionItemsFromLegacy', () => {
  it('reads the ImmediateActionItems section by title', () => {
    const summary = {
      MeetingName: 'Acme call',
      SessionSummary: { title: 'Session Summary', blocks: [{ content: 'x' }] },
      ImmediateActionItems: {
        title: 'Immediate Action Items',
        blocks: [{ content: 'Email the SOW' }, { content: 'Book the demo' }, { content: '  ' }],
      },
    };
    expect(extractActionItemsFromLegacy(summary)).toEqual(['Email the SOW', 'Book the demo']);
  });

  it('ignores non-section keys', () => {
    const summary = { markdown: '## Action Items\n- ignored', _section_order: ['x'] };
    expect(extractActionItemsFromLegacy(summary as any)).toEqual([]);
  });
});

describe('extractActionItemsFromBlockNote', () => {
  it('collects list items after an action-items heading', () => {
    const blocks = [
      { type: 'heading', content: [{ type: 'text', text: 'Action Items' }] },
      { type: 'bulletListItem', content: [{ type: 'text', text: 'First task' }] },
      { type: 'checkListItem', content: 'Second task' },
      { type: 'heading', content: [{ type: 'text', text: 'Notes' }] },
      { type: 'bulletListItem', content: [{ type: 'text', text: 'Not a task' }] },
    ];
    expect(extractActionItemsFromBlockNote(blocks)).toEqual(['First task', 'Second task']);
  });
});

describe('extractActionItems (top-level dispatch + dedup)', () => {
  it('dispatches on markdown', () => {
    expect(extractActionItems({ markdown: '## Action Items\n- a\n- a\n- b' })).toEqual(['a', 'b']);
  });

  it('dispatches on legacy sections', () => {
    expect(
      extractActionItems({ ImmediateActionItems: { title: 'Action Items', blocks: [{ content: 'z' }] } }),
    ).toEqual(['z']);
  });

  it('returns [] for null / non-object', () => {
    expect(extractActionItems(null)).toEqual([]);
    expect(extractActionItems(undefined)).toEqual([]);
  });
});

describe('actionItemsToMarkdown', () => {
  it('renders a GFM task list reflecting checked state', () => {
    const items = ['a', 'b'];
    const checked = { [actionItemId(0, 'a')]: true };
    expect(actionItemsToMarkdown(items, checked)).toBe('- [x] a\n- [ ] b');
  });
});

describe('checkbox persistence', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips checked state per meeting id', () => {
    const state = { [actionItemId(0, 'a')]: true };
    saveCheckedState('m1', state);
    expect(loadCheckedState('m1')).toEqual(state);
    expect(loadCheckedState('m2')).toEqual({});
  });

  it('returns {} for corrupt storage', () => {
    localStorage.setItem(actionItemsStorageKey('m3'), 'not-json');
    expect(loadCheckedState('m3')).toEqual({});
  });
});
