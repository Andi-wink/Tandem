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

use super::{apply_corrections, compile_entries, prompt_terms, CompiledDictionary, PROMPT_CHAR_BUDGET};
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

    let snapshot = Arc::new(DictionarySnapshot {
        dictionary,
        prompt_terms: prompt,
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

        // Reset so this test cannot leak into others in the same process.
        set_from_rows(&[]);
        assert_eq!(correct("we use n eight n"), "we use n eight n");
        assert_eq!(decoder_prompt_terms(), "");
    }
}
