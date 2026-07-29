import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { addJot, clearJots, readJots } from '@/lib/meetingJots';
import { JotStrip } from './JotStrip';

// The strip only needs four things from the app shell, so they are stubbed rather than wrapped in real
// providers. The jot store (useMeetingJots + sessionStorage) is deliberately REAL: chip behaviour is
// exactly what these tests are checking.
const recordingState = { isRecording: true, recordingMode: 'meeting' as 'meeting' | 'solo' };
const addNote = vi.fn<(text: string) => boolean>();
const transcriptsRef = { current: [] as Array<{ audio_start_time?: number; audio_end_time?: number }> };

vi.mock('@/contexts/RecordingStateContext', () => ({
  useRecordingState: () => recordingState,
}));
vi.mock('@/contexts/TranscriptContext', () => ({
  useTranscripts: () => ({ transcriptsRef, addNote }),
}));
vi.mock('@/components/Sidebar/SidebarProvider', () => ({
  useSidebar: () => ({ isCollapsed: false }),
}));
vi.mock('@/contexts/ClaudeContext', () => ({
  useClaude: () => ({ isPanelOpen: false, panelWidth: 400 }),
}));

/** Open the destination dropdown and pick an option. */
async function pickDestination(name: 'transcript' | 'note') {
  fireEvent.pointerDown(screen.getByTestId('jot-destination'), { button: 0, pointerType: 'mouse' });
  const item = await screen.findByTestId(`jot-destination-${name}`);
  fireEvent.pointerDown(item, { pointerType: 'mouse' });
  fireEvent.pointerUp(item, { pointerType: 'mouse' });
  fireEvent.click(item);
  await waitFor(() => {
    expect(screen.getByTestId('jot-destination')).toHaveAttribute('data-destination', name);
  });
}

/** Type a line and commit it with Enter. */
function typeAndCommit(text: string) {
  const input = screen.getByTestId('jot-input') as HTMLInputElement;
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
  return input;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearJots();
  recordingState.isRecording = true;
  recordingState.recordingMode = 'meeting';
  transcriptsRef.current = [];
  addNote.mockReturnValue(true);
});

describe('JotStrip destinations', () => {
  it('defaults to Transcript: Enter calls addNote, clears the input, files no jot', async () => {
    render(<JotStrip />);

    expect(screen.getByTestId('jot-destination')).toHaveAttribute('data-destination', 'transcript');
    expect(screen.getByTestId('jot-input')).toHaveAttribute('placeholder', 'Add to transcript... (Enter)');

    const input = typeAndCommit('send them the pricing sheet');

    expect(addNote).toHaveBeenCalledWith('send them the pricing sheet');
    await waitFor(() => expect(input.value).toBe(''));
    expect(screen.queryByTestId('jot-chip')).toBeNull();
    expect(readJots()).toHaveLength(0);
  });

  it('keeps the text in the input when addNote refuses the note', async () => {
    addNote.mockReturnValue(false);
    render(<JotStrip />);

    const input = typeAndCommit('rejected line');

    expect(addNote).toHaveBeenCalledWith('rejected line');
    await waitFor(() => expect(input.value).toBe('rejected line'));
  });

  it('destination Note creates a timestamped chip and never touches the transcript', async () => {
    transcriptsRef.current = [{ audio_start_time: 10, audio_end_time: 12 }];
    render(<JotStrip />);

    await pickDestination('note');
    expect(screen.getByTestId('jot-input')).toHaveAttribute('placeholder', 'Jot a note... (Enter)');

    typeAndCommit('pricing concerns');

    const chips = await screen.findAllByTestId('jot-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveTextContent('pricing concerns');
    expect(addNote).not.toHaveBeenCalled();
    expect(readJots()[0].audioMs).toBe(12000);
  });

  it('editing a chip commits as a jot edit even while the destination is Transcript', async () => {
    render(<JotStrip />);

    // Seed one chip through the Note destination, then switch back to the Transcript default.
    await pickDestination('note');
    typeAndCommit('first note');
    await screen.findByTestId('jot-chip');
    await pickDestination('transcript');
    addNote.mockClear();

    // Click the chip's text button to start editing it.
    fireEvent.click(screen.getAllByTitle('Click to edit')[0]);
    const input = screen.getByTestId('jot-input') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('first note'));
    expect(input).toHaveAttribute('placeholder', 'Edit note... (Enter)');

    typeAndCommit('first note edited');

    await waitFor(() => {
      expect(screen.getAllByTestId('jot-chip')[0]).toHaveTextContent('first note edited');
    });
    expect(screen.getAllByTestId('jot-chip')).toHaveLength(1);
    expect(addNote).not.toHaveBeenCalled();
    expect(readJots()[0].content).toBe('first note edited');
  });
});

describe('JotStrip in solo mode', () => {
  beforeEach(() => {
    recordingState.recordingMode = 'solo';
  });

  it('renders with the destination locked to Transcript and no chips', async () => {
    // A stale jot in the store must not surface in solo.
    addJot('leftover jot', 1000);
    render(<JotStrip />);

    expect(screen.getByTestId('jot-strip')).toBeInTheDocument();
    const destination = screen.getByTestId('jot-destination');
    expect(destination).toHaveAttribute('data-destination', 'transcript');
    expect(destination).toHaveTextContent('Transcript');
    // No dropdown at all, so "Note" cannot be reached.
    expect(screen.queryByTestId('jot-destination-note')).toBeNull();
    fireEvent.pointerDown(destination, { button: 0, pointerType: 'mouse' });
    expect(screen.queryByTestId('jot-destination-note')).toBeNull();

    expect(screen.queryByTestId('jot-chips')).toBeNull();
    expect(screen.queryByTestId('jot-chip')).toBeNull();
  });

  it('files typed text into the transcript, never as a jot', async () => {
    render(<JotStrip />);

    const input = typeAndCommit('solo thought');

    expect(addNote).toHaveBeenCalledWith('solo thought');
    await waitFor(() => expect(input.value).toBe(''));
    expect(readJots()).toHaveLength(0);
  });
});

describe('JotStrip visibility', () => {
  it('renders nothing when no recording is active', () => {
    recordingState.isRecording = false;
    const { container } = render(<JotStrip />);
    expect(container).toBeEmptyDOMElement();
  });
});
