import { describe, it, expect } from 'vitest';
import { previewForNotification } from './agentNotification';

describe('previewForNotification', () => {
  it('collapses whitespace so multi-line agent output fits one notification line', () => {
    expect(previewForNotification('Fixed  the\n\nlogin   redirect.\n')).toBe(
      'Fixed the login redirect.',
    );
  });

  it('leaves short replies untouched', () => {
    expect(previewForNotification('Done.')).toBe('Done.');
  });

  it('truncates at a word boundary with an ellipsis', () => {
    const long = 'alpha bravo charlie delta echo foxtrot';
    const out = previewForNotification(long, 20);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(21);
    expect(out).toBe('alpha bravo charlie…');
  });

  it('hard-cuts when a single token is longer than the limit', () => {
    const out = previewForNotification('a'.repeat(50), 10);
    expect(out).toBe(`${'a'.repeat(10)}…`);
  });
});
