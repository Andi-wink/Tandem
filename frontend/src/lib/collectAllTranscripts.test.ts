import { describe, it, expect, vi } from 'vitest';
import { collectAllTranscripts, type FetchTranscriptPage } from './collectAllTranscripts';
import type { Transcript, PaginatedTranscriptsResponse } from '@/types';

function seg(id: string, start: number): Transcript {
  return { id, text: `text ${id}`, timestamp: '00:00:00', audio_start_time: start };
}

/** A fake backend that pages a fixed list at a given page size, setting has_more correctly. */
function pagedBackend(all: Transcript[], pageSize: number): FetchTranscriptPage {
  return async (limit, offset): Promise<PaginatedTranscriptsResponse> => {
    const batch = all.slice(offset, offset + Math.min(limit, pageSize));
    return { transcripts: batch, total_count: all.length, has_more: offset + batch.length < all.length };
  };
}

describe('collectAllTranscripts', () => {
  it('returns everything from a single page when has_more is false', async () => {
    const data = [seg('a', 0), seg('b', 10)];
    const fetchPage = vi.fn(pagedBackend(data, 500));
    const out = await collectAllTranscripts(fetchPage, 500);
    expect(out.map((t) => t.id)).toEqual(['a', 'b']);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith(500, 0);
  });

  it('accumulates offset and follows has_more across multiple pages', async () => {
    // 5 segments, page size 2 -> pages at offset 0, 2, 4 (last returns has_more:false).
    const data = [seg('a', 0), seg('b', 1), seg('c', 2), seg('d', 3), seg('e', 4)];
    const fetchPage = vi.fn(pagedBackend(data, 2));
    const out = await collectAllTranscripts(fetchPage, 2);
    expect(out.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage.mock.calls.map((c) => c[1])).toEqual([0, 2, 4]);
  });

  it('sorts the merged result by audio_start_time regardless of page order', async () => {
    // Backend hands back out-of-order pages; the loop must sort the union.
    const pages: PaginatedTranscriptsResponse[] = [
      { transcripts: [seg('late', 300), seg('mid', 120)], total_count: 3, has_more: true },
      { transcripts: [seg('early', 5)], total_count: 3, has_more: false },
    ];
    let i = 0;
    const fetchPage = vi.fn(async () => pages[i++]);
    const out = await collectAllTranscripts(fetchPage, 2);
    expect(out.map((t) => t.id)).toEqual(['early', 'mid', 'late']);
  });

  it('stops on an empty batch even if the backend keeps claiming has_more (no infinite loop)', async () => {
    const fetchPage = vi.fn(async (): Promise<PaginatedTranscriptsResponse> => ({
      transcripts: [],
      total_count: 0,
      has_more: true,
    }));
    const out = await collectAllTranscripts(fetchPage, 500);
    expect(out).toEqual([]);
    // The empty-batch guard breaks after the first call, never spinning to the MAX_PAGES ceiling.
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('is bounded by the page ceiling when has_more never clears and batches stay non-empty', async () => {
    // Always returns one row and has_more:true -> only the hard ceiling stops it.
    const fetchPage = vi.fn(async (_limit: number, offset: number): Promise<PaginatedTranscriptsResponse> => ({
      transcripts: [seg(`s${offset}`, offset)],
      total_count: Number.MAX_SAFE_INTEGER,
      has_more: true,
    }));
    const out = await collectAllTranscripts(fetchPage, 1);
    expect(fetchPage).toHaveBeenCalledTimes(1000);
    expect(out).toHaveLength(1000);
  });

  it('tolerates a null/undefined transcripts field', async () => {
    const fetchPage = vi.fn(async () => ({ has_more: false } as unknown as PaginatedTranscriptsResponse));
    const out = await collectAllTranscripts(fetchPage, 500);
    expect(out).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
