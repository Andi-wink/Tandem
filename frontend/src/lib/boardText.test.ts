import { describe, it, expect } from 'vitest';
import { normalizeBoardText } from './boardText';

/**
 * Verbatim copy of a real board file:
 * ~/Music/tandem-recordings/Meeting 2026-07-09_13-23-58_2026-07-09_12-23/whiteboard.md
 */
const REAL_BOARD = `# Whiteboard

## Text

- MCP Server
- HackBox
- Minecraft Server
- Proxy Server
`;

/**
 * Verbatim copy of the placeholder file the canvas writes for a board with nothing readable on it
 * (four of the six real boards in that folder are exactly this).
 */
const PLACEHOLDER_BOARD = `# Whiteboard

_(no text or HTML content on the board)_`;

describe('normalizeBoardText', () => {
  it('keeps the content of a real board and drops the canvas document furniture', () => {
    expect(normalizeBoardText(REAL_BOARD)).toBe(
      '- MCP Server\n- HackBox\n- Minecraft Server\n- Proxy Server',
    );
  });

  it('returns nothing for the placeholder file, so no empty section is rendered', () => {
    expect(normalizeBoardText(PLACEHOLDER_BOARD)).toBe('');
  });

  it('returns nothing for empty or whitespace input', () => {
    expect(normalizeBoardText('')).toBe('');
    expect(normalizeBoardText('   \n\n  ')).toBe('');
  });

  it('demotes any remaining heading to bold so it cannot outrank the handover headings', () => {
    expect(normalizeBoardText('# Whiteboard\n\n## Text\n\n### Pricing\n\nfixed fee')).toBe(
      '**Pricing**\n\nfixed fee',
    );
  });

  it('drops the HTML section heading the same way as the text one', () => {
    expect(normalizeBoardText('# Whiteboard\n\n## HTML\n\n<div>built shape</div>')).toBe('<div>built shape</div>');
  });

  it('strips code fences so an unterminated one cannot swallow the document', () => {
    expect(normalizeBoardText('# Whiteboard\n\n```html\n<b>x</b>\n```\nafter')).toBe('<b>x</b>\nafter');
  });

  it('escapes a thematic break line so it cannot split the handover document', () => {
    expect(normalizeBoardText('# Whiteboard\n\nnext steps\n---\nmore')).toBe('next steps\n\\---\nmore');
    expect(normalizeBoardText('# Whiteboard\n\n***')).toBe('\\***');
  });

  it('keeps a "Whiteboard" heading that is genuinely part of the board content', () => {
    expect(normalizeBoardText('# Whiteboard\n\n## Text\n\nplan\n\n# Whiteboard\n\nthe board itself')).toBe(
      'plan\n\n**Whiteboard**\n\nthe board itself',
    );
  });

  it('collapses the blank runs the removals leave behind', () => {
    expect(normalizeBoardText('# Whiteboard\n\n\n\n## Text\n\n\n\na\n\n\n\nb\n\n\n')).toBe('a\n\nb');
  });

  it('handles CRLF line endings', () => {
    expect(normalizeBoardText('# Whiteboard\r\n\r\n## Text\r\n\r\n- a\r\n- b\r\n')).toBe('- a\n- b');
  });
});
