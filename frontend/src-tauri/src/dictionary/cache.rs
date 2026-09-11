// F056: in-memory dictionary snapshot for the transcription hot path.
//
// Transcription runs on every audio chunk, on several worker tasks at once. It
// must never await a SQLite query or recompile a regex to correct a segment, so
// the compiled dictionary lives here as an immutable `Arc` snapshot published
// behind a `RwLock`. Readers clone the Arc (one atomic increment) and drop the
// lock immediately; writers build a whole new snapshot and swap it in.
//
// Refresh points: once at startup (database/setup.rs) and after every mutation
// command in `super::commands`.

use std::sync::{Arc, OnceLock, RwLock};

use super::{
    apply_corrections, compile_entries, keyterms, prompt_terms, CompiledDictionary,
    KEYTERMS_MAX_BATCH, KEYTERMS_MAX_REALTIME, KEYTERM_CHARS_MAX_BATCH,
    KEYTERM_CHARS_MAX_REALTIME, PROMPT_CHAR_BUDGET,
};
use crate::database::models::CustomDictionaryEntry;
use crate::database::repositories::dictionary::DictionaryRepository;
use sqlx::SqlitePool;

/// One published, immutable view of the enabled dictionary.
#[derive(Debug, Default)]
pub struct DictionarySnapshot {
    pub dictionary: CompiledDictionary,
    /// Pre-rendered comma-separated term list for decoder prompts, already
    /// capped at `PROMPT_CHAR_BUDGET`. Rendered once here so the whisper call
    /// does no string work per chunk.
    pub prompt_terms: String,
    /// Pre-built `keyterms` list for the ElevenLabs Scribe BATCH endpoint,
    /// already capped to the documented 1000 terms / 50 chars.
    pub keyterms_batch: Vec<String>,
    /// Pre-built `keyterms` list for the Scribe REALTIME websocket, capped to
    /// its tighter 50 terms / 20 chars. Kept separate rather than derived at
    /// call time so neither transcription route does list work per chunk.
    pub keyterms_realtime: Vec<String>,
}

static CACHE: OnceLock<RwLock<Arc<DictionarySnapshot>>> = OnceLock::new();

fn cell() -> &'static RwLock<Arc<DictionarySnapshot>> {
    CACHE.get_or_init(|| RwLock::new(Arc::new(DictionarySnapshot::default())))
}

/// Current snapshot. Cheap enough to call per transcript segment.
pub fn snapshot() -> Arc<DictionarySnapshot> {
    match cell().read() {
        Ok(guard) => guard.clone(),
        // A poisoned lock means a writer panicked mid-swap. The dictionary is a
        // best-effort enhancement, never a correctness requirement, so degrade
        // to "no dictionary" rather than propagating a panic into the audio path.
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

/// Correct `text` using the current snapshot. Convenience wrapper for callers
/// that do not need the snapshot for anything else.
pub fn correct(text: &str) -> String {
    let snap = snapshot();
    if snap.dictionary.is_empty() {
        return text.to_string();
    }
    apply_corrections(text, &snap.dictionary)
}

/// Comma-separated term list to append to a decoder prompt. Empty when the
/// dictionary is empty, in which case callers must leave their prompt alone.
pub fn decoder_prompt_terms() -> String {
    snapshot().prompt_terms.clone()
}

/// `keyterms` for the ElevenLabs Scribe batch endpoint (`scribe_v2`). Empty
/// when the dictionary is empty, in which case callers must omit the field.
pub fn scribe_keyterms_batch() -> Vec<String> {
    snapshot().keyterms_batch.clone()
}

/// `keyterms` for the Scribe realtime websocket (`scribe_v2_realtime`), under
/// that route's tighter limits.
pub fn scribe_keyterms_realtime() -> Vec<String> {
    snapshot().keyterms_realtime.clone()
}

/// Replace the published snapshot with one compiled from `rows`.
pub fn set_from_rows(rows: &[CustomDictionaryEntry]) {
    let pairs: Vec<(String, Vec<String>)> = rows
        .iter()
        .filter(|row| row.enabled != 0)
        .map(|row| {
            // `aliases` is user-editable JSON. A malformed value degrades that
            // entry to "term only" (still useful for the prompt) instead of
            // failing the whole refresh.
            let aliases: Vec<String> =
                serde_json::from_str(&row.aliases).unwrap_or_else(|_| Vec::new());
            (row.term.clone(), aliases)
        })
        .collect();

    let dictionary = compile_entries(pairs);
    let prompt = prompt_terms(&dictionary, PROMPT_CHAR_BUDGET);
    let keyterms_batch = keyterms(&dictionary, KEYTERMS_MAX_BATCH, KEYTERM_CHARS_MAX_BATCH);
    let keyterms_realtime =
        keyterms(&dictionary, KEYTERMS_MAX_REALTIME, KEYTERM_CHARS_MAX_REALTIME);

    let snapshot = Arc::new(DictionarySnapshot {
        dictionary,
        prompt_terms: prompt,
        keyterms_batch,
        keyterms_realtime,
    });

    match cell().write() {
        Ok(mut guard) => *guard = snapshot,
        Err(poisoned) => *poisoned.into_inner() = snapshot,
    }
}

/// Reload the snapshot from SQLite. Called at startup and after every mutation.
pub async fn refresh(pool: &SqlitePool) -> Result<usize, sqlx::Error> {
    let rows = DictionaryRepository::list_enabled_entries(pool).await?;
    set_from_rows(&rows);
    Ok(rows.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(term: &str, aliases: &str, enabled: i64) -> CustomDictionaryEntry {
        CustomDictionaryEntry {
            id: term.to_string(),
            term: term.to_string(),
            aliases: aliases.to_string(),
            enabled,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn snapshot_round_trips_rows_and_skips_disabled_and_malformed() {
        set_from_rows(&[
            row("n8n", r#"["n eight n"]"#, 1),
            row("Tandem", r#"["tandum"]"#, 0),
            row("Excalidraw", "not json at all", 1),
        ]);

        assert_eq!(correct("we use n eight n"), "we use n8n");
        // Disabled entries do not correct.
        assert_eq!(correct("tandum stays"), "tandum stays");
        // Malformed aliases still contribute the term to the prompt.
        let terms = decoder_prompt_terms();
        assert!(terms.contains("Excalidraw"), "got: {}", terms);
        assert!(!terms.contains("Tandem"), "got: {}", terms);

        // Scribe keyterms follow the same enabled filter, in creation order.
        // Asserted here rather than in a second #[test] because the snapshot is
        // process-global: a parallel test mutating it would race this one.
        assert_eq!(scribe_keyterms_batch(), vec!["n8n", "Excalidraw"]);
        assert_eq!(scribe_keyterms_realtime(), vec!["n8n", "Excalidraw"]);

        // Reset so this test cannot leak into others in the same process.
        set_from_rows(&[]);
        assert_eq!(correct("we use n eight n"), "we use n eight n");
        assert_eq!(decoder_prompt_terms(), "");
        assert!(scribe_keyterms_batch().is_empty());
        assert!(scribe_keyterms_realtime().is_empty());
    }

}
