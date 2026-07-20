import { describe, it, expect, beforeEach } from 'vitest';
import {
  extractActionItems,
  extractActionItemsFromMarkdown,
  extractActionItemsFromLegacy,
  extractActionItemsFromBlockNote,
  stripActionItemsFromMarkdown,
  stripActionItemsFromBlockNote,
  stripActionItemsFromLegacy,
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

describe('stripActionItemsFromMarkdown (display projection)', () => {
  it('removes the action-items heading and its list, keeping other sections', () => {
    const md = [
      '## Session Summary',
      'We talked about the roadmap.',
      '',
      '## Action Items',
      '- Send the proposal to Acme',
      '- Schedule the follow-up call',
      '',
      '## Next Steps',
      '- Keep this one',
    ].join('\n');
    const stripped = stripActionItemsFromMarkdown(md);
    expect(stripped).toContain('## Session Summary');
    expect(stripped).toContain('We talked about the roadmap.');
    expect(stripped).toContain('## Next Steps');
    expect(stripped).toContain('Keep this one');
    // The action items themselves are gone.
    expect(stripped).not.toContain('## Action Items');
    expect(stripped).not.toContain('Send the proposal to Acme');
    expect(stripped).not.toContain('Schedule the follow-up call');
  });

  it('returns the summary unchanged when there is no action-items heading', () => {
    const md = '## Summary\n- a point\n- another point';
    expect(stripActionItemsFromMarkdown(md)).toBe(md);
  });

  it('drops a trailing action-items section entirely', () => {
    const md = '## Notes\nkeep me\n\n## Immediate Action Items\n- gone\n- also gone';
    const stripped = stripActionItemsFromMarkdown(md);
    expect(stripped).toContain('keep me');
    expect(stripped).not.toContain('gone');
    expect(stripped).not.toMatch(/Immediate Action Items/);
  });
});

describe('stripActionItemsFromBlockNote (display projection)', () => {
  it('removes the action-items heading + following blocks until the next heading', () => {
    const blocks = [
      { type: 'heading', content: [{ type: 'text', text: 'Summary' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'keep this' }] },
      { type: 'heading', content: [{ type: 'text', text: 'Action Items' }] },
      { type: 'bulletListItem', content: [{ type: 'text', text: 'drop me' }] },
      { type: 'checkListItem', content: 'drop me too' },
      { type: 'heading', content: [{ type: 'text', text: 'Notes' }] },
      { type: 'bulletListItem', content: [{ type: 'text', text: 'keep this note' }] },
    ];
    const out = stripActionItemsFromBlockNote(blocks);
    const texts = out.map((b) =>
      typeof b.content === 'string'
        ? b.content
        : Array.isArray(b.content)
          ? b.content.map((c: any) => c.text).join('')
          : '',
    );
    expect(texts).toEqual(['Summary', 'keep this', 'Notes', 'keep this note']);
  });

  it('is a no-op when there is no action-items heading', () => {
    const blocks = [
      { type: 'heading', content: [{ type: 'text', text: 'Summary' }] },
      { type: 'bulletListItem', content: [{ type: 'text', text: 'a' }] },
    ];
    expect(stripActionItemsFromBlockNote(blocks)).toHaveLength(2);
  });
});

describe('stripActionItemsFromLegacy (display projection)', () => {
  it('removes the action-items section by title and prunes _section_order', () => {
    const summary = {
      MeetingName: 'Acme call',
      _section_order: ['SessionSummary', 'ImmediateActionItems'],
      SessionSummary: { title: 'Session Summary', blocks: [{ content: 'x' }] },
      ImmediateActionItems: { title: 'Immediate Action Items', blocks: [{ content: 'Email the SOW' }] },
    };
    const out = stripActionItemsFromLegacy(summary);
    expect(out.SessionSummary).toBeDefined();
    expect(out.ImmediateActionItems).toBeUndefined();
    expect(out.MeetingName).toBe('Acme call');
    expect(out._section_order).toEqual(['SessionSummary']);
  });
});

describe('strip/extract are complementary (checklist + hidden body cover the same items)', () => {
  it('markdown: items that extract pulls out are exactly the ones strip removes', () => {
    const md = '## Summary\n- point\n\n## Action Items\n- do A\n- do B';
    const extracted = extractActionItemsFromMarkdown(md);
    const stripped = stripActionItemsFromMarkdown(md);
    for (const item of extracted) expect(stripped).not.toContain(item);
    expect(stripped).toContain('point');
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
