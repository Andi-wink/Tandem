/**
 * Whiteboard snapshot inspection.
 *
 * The board is saved on every canvas close, recording stop and quit, so a meeting that never had
 * anything drawn on it still ends up with a `whiteboard.tldr.json` on disk. "A file exists" is
 * therefore not evidence that anyone drew: the handover document would gain an empty Whiteboard
 * section, and the client library would fill up with blank boards.
 *
 * Counting shapes is the honest test. A tldraw store is a flat record map keyed by id, where every
 * record carries a `typeName` ('shape', 'page', 'camera', 'instance', ...). Only 'shape' records are
 * things a person put on the board.
 *
 * Snapshots reach us in two shapes depending on the tldraw version and which helper produced them
 * (`getSnapshot()` returns `{ document: { store }, session }`, the older `store.getSnapshot()`
 * returns `{ store, schema }`), and they arrive across a postMessage bridge, so the input is
 * genuinely unknown. Anything unrecognisable counts as zero rather than throwing: a miscount must
 * never cost the user their handover document.
 */

/** Records in a tldraw store snapshot, in either of the two shapes the bridge can hand us. */
function extractStore(snapshot: unknown): Record<string, unknown> | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const root = snapshot as Record<string, unknown>;

  // `{ document: { store: {...} } }` — the modern getSnapshot() shape.
  const doc = root.document;
  if (doc && typeof doc === 'object') {
    const docStore = (doc as Record<string, unknown>).store;
    if (docStore && typeof docStore === 'object') return docStore as Record<string, unknown>;
  }

  // `{ store: {...} }` — the flat store snapshot shape.
  const store = root.store;
  if (store && typeof store === 'object') return store as Record<string, unknown>;

  return null;
}

/**
 * How many shapes the board holds. 0 means nothing was drawn (or the snapshot is unreadable), which
 * is what the handover document and the persistence layer use to decide whether a board exists at all.
 */
export function countShapes(snapshot: unknown): number {
  const store = extractStore(snapshot);
  if (!store) return 0;

  let count = 0;
  for (const record of Object.values(store)) {
    if (record && typeof record === 'object' && (record as Record<string, unknown>).typeName === 'shape') {
      count++;
    }
  }
  return count;
}
