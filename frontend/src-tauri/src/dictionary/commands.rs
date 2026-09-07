// F056: Tauri commands for the custom transcription dictionary.
//
// Every mutation refreshes the in-memory snapshot in `super::cache` before it
// returns, so a term the user just added takes effect on the very next audio
// chunk without an app restart.

use log::{info, warn};
use serde::{Deserialize, Serialize};

use super::cache;
use crate::database::models::CustomDictionaryEntry;
use crate::database::repositories::dictionary::DictionaryRepository;
use crate::state::AppState;

/// Wire shape for the UI: `aliases` is a real array here, not the JSON string
/// the database column holds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DictionaryEntryDto {
    pub id: String,
    pub term: String,
    pub aliases: Vec<String>,
    pub enabled: bool,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

impl From<CustomDictionaryEntry> for DictionaryEntryDto {
    fn from(row: CustomDictionaryEntry) -> Self {
        Self {
            id: row.id,
            term: row.term,
            aliases: serde_json::from_str(&row.aliases).unwrap_or_default(),
            enabled: row.enabled != 0,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

/// One entry as it appears in an import payload. `id` is optional so a
/// hand-written or exported-from-another-machine file does not need to carry ids.
#[derive(Debug, Clone, Deserialize)]
pub struct DictionaryImportEntry {
    #[serde(default)]
    pub term: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// True when a sqlx error is SQLite's UNIQUE-constraint failure. Matched on the
/// database error code rather than the message text, which is not stable.
fn is_unique_violation(err: &sqlx::Error) -> bool {
    match err {
        // SQLITE_CONSTRAINT_UNIQUE is 2067, SQLITE_CONSTRAINT_PRIMARYKEY is 1555.
        sqlx::Error::Database(db) => matches!(db.code().as_deref(), Some("2067") | Some("1555")),
        _ => false,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DictionaryImportResult {
    pub imported: usize,
    pub skipped: usize,
}

/// Normalize aliases before they are stored: trim, drop blanks, drop duplicates
/// that differ only in case. Keeps the stored JSON tidy so the UI and the
/// compiled regexes agree on what is actually in the entry.
fn normalize_aliases(aliases: &[String]) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for alias in aliases {
        let trimmed = alias.trim();
        if trimmed.is_empty() {
            continue;
        }
        if seen.iter().any(|s| s.eq_ignore_ascii_case(trimmed)) {
            continue;
        }
        seen.push(trimmed.to_string());
    }
    seen
}

#[tauri::command]
pub async fn list_dictionary_entries(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<DictionaryEntryDto>, String> {
    let pool = state.db_manager.pool();
    let rows = DictionaryRepository::list_entries(pool)
        .await
        .map_err(|e| format!("Failed to list dictionary entries: {}", e))?;

    // A list call is also the frontend's cue that the dictionary UI is open, and
    // it is the only command guaranteed to run on the first-launch path (where
    // the startup refresh had no database yet), so prime the cache here too.
    if let Err(e) = cache::refresh(pool).await {
        warn!("F056: dictionary cache refresh failed during list: {}", e);
    }

    Ok(rows.into_iter().map(DictionaryEntryDto::from).collect())
}

#[tauri::command]
pub async fn upsert_dictionary_entry(
    state: tauri::State<'_, AppState>,
    id: Option<String>,
    term: String,
    aliases: Vec<String>,
    enabled: bool,
) -> Result<DictionaryEntryDto, String> {
    let term = term.trim().to_string();
    if term.is_empty() {
        return Err("A dictionary entry needs a term.".to_string());
    }

    let pool = state.db_manager.pool();
    let aliases = normalize_aliases(&aliases);
    let aliases_json = serde_json::to_string(&aliases)
        .map_err(|e| format!("Failed to encode aliases: {}", e))?;

    // Terms are unique case-insensitively (see the 20260907000001 migration).
    // Resolve the target row by TERM before writing, so "New Term" with a term
    // that already exists edits that entry instead of hitting the constraint:
    // the user's intent when typing an existing word is to change it, not to
    // learn that a row they cannot see is in the way.
    let existing = DictionaryRepository::find_by_term(pool, &term)
        .await
        .map_err(|e| format!("Failed to check for an existing '{}': {}", term, e))?;

    let target_id = match (&id, &existing) {
        // Renaming an entry onto a term another row already owns. Merging would
        // silently discard one of the two alias lists, so refuse and say which
        // entry is in the way.
        (Some(editing), Some(found)) if editing != &found.id => {
            return Err(format!(
                "\"{}\" is already in the dictionary. Edit that entry instead, or rename it first.",
                found.term
            ));
        }
        (Some(editing), _) => Some(editing.clone()),
        (None, Some(found)) => Some(found.id.clone()),
        (None, None) => None,
    };

    let row = DictionaryRepository::upsert_entry(pool, target_id, &term, &aliases_json, enabled)
        .await
        .map_err(|e| {
            // Belt and braces: a concurrent insert can still lose the race above.
            if is_unique_violation(&e) {
                format!("\"{}\" is already in the dictionary.", term)
            } else {
                format!("Failed to save dictionary entry: {}", e)
            }
        })?;

    if let Err(e) = cache::refresh(pool).await {
        warn!("F056: dictionary cache refresh failed after upsert: {}", e);
    }

    Ok(DictionaryEntryDto::from(row))
}

#[tauri::command]
pub async fn delete_dictionary_entry(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let pool = state.db_manager.pool();
    DictionaryRepository::delete_entry(pool, &id)
        .await
        .map_err(|e| format!("Failed to delete dictionary entry: {}", e))?;

    if let Err(e) = cache::refresh(pool).await {
        warn!("F056: dictionary cache refresh failed after delete: {}", e);
    }

    Ok(())
}

/// Import a JSON array of entries. Merging is by term (case-insensitive), so
/// re-importing the same file updates rows instead of duplicating them.
#[tauri::command]
pub async fn import_dictionary(
    state: tauri::State<'_, AppState>,
    json: String,
) -> Result<DictionaryImportResult, String> {
    let incoming: Vec<DictionaryImportEntry> = serde_json::from_str(&json)
        .map_err(|e| format!("That does not look like a dictionary JSON array: {}", e))?;

    let pool = state.db_manager.pool();
    let mut imported = 0usize;
    let mut skipped = 0usize;

    for entry in incoming {
        let term = entry.term.trim().to_string();
        if term.is_empty() {
            skipped += 1;
            continue;
        }

        let existing_id = DictionaryRepository::find_by_term(pool, &term)
            .await
            .map_err(|e| format!("Failed to look up '{}': {}", term, e))?
            .map(|row| row.id);

        let aliases = normalize_aliases(&entry.aliases);
        let aliases_json = serde_json::to_string(&aliases)
            .map_err(|e| format!("Failed to encode aliases for '{}': {}", term, e))?;

        DictionaryRepository::upsert_entry(pool, existing_id, &term, &aliases_json, entry.enabled)
            .await
            .map_err(|e| format!("Failed to import '{}': {}", term, e))?;
        imported += 1;
    }

    if let Err(e) = cache::refresh(pool).await {
        warn!("F056: dictionary cache refresh failed after import: {}", e);
    }
    info!("F056: imported {} dictionary entries ({} skipped)", imported, skipped);

    Ok(DictionaryImportResult { imported, skipped })
}

/// Export the whole dictionary as a pretty-printed JSON array string. The
/// frontend decides what to do with it (copy to clipboard, save to a file).
#[tauri::command]
pub async fn export_dictionary(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let pool = state.db_manager.pool();
    let rows = DictionaryRepository::list_entries(pool)
        .await
        .map_err(|e| format!("Failed to read dictionary: {}", e))?;

    let dtos: Vec<DictionaryEntryDto> = rows.into_iter().map(DictionaryEntryDto::from).collect();
    serde_json::to_string_pretty(&dtos).map_err(|e| format!("Failed to encode dictionary: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_aliases_trims_blanks_and_case_duplicates() {
        let input = vec![
            "  n eight n  ".to_string(),
            "".to_string(),
            "   ".to_string(),
            "N Eight N".to_string(),
            "innate".to_string(),
        ];
        assert_eq!(
            normalize_aliases(&input),
            vec!["n eight n".to_string(), "innate".to_string()]
        );
    }

    #[test]
    fn import_entries_default_to_enabled() {
        let parsed: Vec<DictionaryImportEntry> =
            serde_json::from_str(r#"[{"term":"n8n","aliases":["n eight n"]}]"#).unwrap();
        assert_eq!(parsed.len(), 1);
        assert!(parsed[0].enabled, "an entry without `enabled` must import as enabled");
    }

    #[test]
    fn dto_parses_the_stored_alias_json() {
        let row = CustomDictionaryEntry {
            id: "1".into(),
            term: "n8n".into(),
            aliases: r#"["n eight n","innate"]"#.into(),
            enabled: 0,
            created_at: String::new(),
            updated_at: String::new(),
        };
        let dto = DictionaryEntryDto::from(row);
        assert_eq!(dto.aliases, vec!["n eight n", "innate"]);
        assert!(!dto.enabled);
    }
}
