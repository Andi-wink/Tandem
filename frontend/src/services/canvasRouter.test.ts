import { describe, it, expect } from 'vitest';
import { heuristicRoute, routeMessage } from './canvasRouter';

// The heuristic is the deterministic, network-free core of the router. These lock in the routing
// fixes we made (the "canvas" keyword, "map out …" / "process map", and that questions stay in chat).
describe('heuristicRoute', () => {
  const canvas = (m: string, open = false) => expect(heuristicRoute(m, open)).toBe('canvas');
  const chat = (m: string, open = false) => expect(heuristicRoute(m, open)).toBe('chat');
  const ambiguous = (m: string, open = false) => expect(heuristicRoute(m, open)).toBeNull();

  it('routes the explicit "canvas" keyword to the canvas', () => {
    canvas('put the lead flow on the canvas');
    canvas('canvas: map the onboarding');
    canvas('add this to the canvas');
  });

  it('routes "map out" / "process map" / "map … the processes" to the canvas', () => {
    canvas('Map out all the processes for the transcript'); // the exact reported miss
    canvas('map out the onboarding steps');
    canvas('make a process map of the pipeline');
    canvas('map the full lead flow');
  });

  it('routes obvious draw verbs to the canvas', () => {
    canvas('draw a diagram of the architecture');
    canvas('sketch a wireframe');
    canvas('whiteboard the journey');
    canvas('visualize the funnel');
  });

  it('keeps questions / assistant asks in chat', () => {
    chat('what are the action items');
    chat('summarize the call');
    chat('how do I fix this bug');
    chat('explain the architecture');
    chat('draft an email to the client');
  });

  it('treats edit imperatives as canvas only when a board is open', () => {
    canvas('make it blue', true);
    ambiguous('make it blue', false);
  });

  it('leaves genuinely ambiguous messages unresolved', () => {
    ambiguous('map the data field to the column'); // "map" without a process/flow word
    chat(''); // empty -> safe default
  });
});

// routeMessage falls back to 'chat' on ambiguous input when no API key is available (no network).
describe('routeMessage (no key, deterministic paths)', () => {
  it('honors the heuristic for clear cases', async () => {
    expect(await routeMessage('draw a diagram', {})).toBe('canvas');
    expect(await routeMessage('summarize the call', {})).toBe('chat');
  });

  it('defaults ambiguous-without-key to chat', async () => {
    expect(await routeMessage('make it blue', { canvasOpen: false })).toBe('chat');
  });
});
