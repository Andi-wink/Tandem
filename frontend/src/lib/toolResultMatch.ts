/**
 * Pairing streamed tool_result events with their originating tool calls.
 *
 * The agent can issue several tool calls before any result returns, and results arrive in call
 * order (FIFO). When two calls share a tool name (e.g. two Read calls), the FIRST result must
 * fill the FIRST still-unfilled call, or the panel shows each tool's output against the wrong
 * input. Extracted as a pure function so the FIFO invariant is unit-testable.
 */

export interface ToolCallLike {
  name: string;
  output?: string;
}

/**
 * Returns a new tool-call array with the given result assigned to the EARLIEST still-unfilled
 * call whose name matches `toolName`. Does not mutate the input. If no unfilled matching call
 * exists, the array is returned (shallow-copied) unchanged.
 */
export function assignToolResult<T extends ToolCallLike>(
  calls: T[],
  toolName: string | null | undefined,
  output: string,
): T[] {
  const next = [...calls];
  for (let i = 0; i < next.length; i++) {
    if (next[i].name === toolName && !next[i].output) {
      next[i] = { ...next[i], output };
      break;
    }
  }
  return next;
}
