import { describe, it, expect } from 'vitest';
import { assignToolResult } from './toolResultMatch';

type Call = { name: string; input: string; output?: string };

describe('assignToolResult (FIFO tool_result pairing)', () => {
  it('fills the FIRST unfilled call when two same-name calls are pending', () => {
    const calls: Call[] = [
      { name: 'Read', input: 'A' },
      { name: 'Read', input: 'B' },
    ];
    // First result belongs to Read(A) — must land on index 0, not index 1.
    const after = assignToolResult(calls, 'Read', 'output-for-A');
    expect(after[0].output).toBe('output-for-A');
    expect(after[1].output).toBeUndefined();
  });

  it('pairs sequential results with their calls in order', () => {
    let calls: Array<{ name: string; input: string; output?: string }> = [
      { name: 'Read', input: 'A' },
      { name: 'Read', input: 'B' },
    ];
    calls = assignToolResult(calls, 'Read', 'out-A');
    calls = assignToolResult(calls, 'Read', 'out-B');
    expect(calls[0]).toMatchObject({ input: 'A', output: 'out-A' });
    expect(calls[1]).toMatchObject({ input: 'B', output: 'out-B' });
  });

  it('skips already-filled calls and matches by name', () => {
    const calls: Call[] = [
      { name: 'Read', input: 'A', output: 'done' },
      { name: 'Grep', input: 'G' },
      { name: 'Read', input: 'B' },
    ];
    const after = assignToolResult(calls, 'Read', 'out-B');
    expect(after[0].output).toBe('done'); // untouched
    expect(after[1].output).toBeUndefined(); // wrong name, untouched
    expect(after[2].output).toBe('out-B'); // next unfilled Read
  });

  it('does not mutate the input array', () => {
    const calls: Call[] = [{ name: 'Read', input: 'A' }];
    const after = assignToolResult(calls, 'Read', 'x');
    expect(calls[0].output).toBeUndefined();
    expect(after).not.toBe(calls);
  });

  it('returns a copy unchanged when there is no unfilled matching call', () => {
    const calls: Call[] = [{ name: 'Read', input: 'A', output: 'done' }];
    const after = assignToolResult(calls, 'Read', 'y');
    expect(after[0].output).toBe('done');
  });
});
