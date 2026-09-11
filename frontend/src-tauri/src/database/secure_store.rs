//! OS-level secure storage for sensitive API keys.
//!
//! Some provider keys (currently the Anthropic/Claude key) must never sit in
//! plaintext in `meeting_minutes.sqlite`. This module keeps them in the
//! operating system's credential store instead: Windows Credential Manager on
//! Windows and the Keychain on macOS, via the `keyring` crate. Values are
//! encrypted at rest and scoped to the current OS user.
//!
//! In test builds the credential store is replaced by an in-process map so the
//! suite stays hermetic and never touches the developer's real keychain.

use sqlx::SqlitePool;

/// Service name under which all Tandem secrets are grouped in the OS store.
/// Matches the Tauri bundle identifier so the entries are easy to locate.
/// Only referenced by the real keyring backend, not the in-process test store.
#[cfg_attr(test, allow(dead_code))]
const SERVICE: &str = "com.tandem.ai";

/// Account name for the Anthropic/Claude API key entry.
const ANTHROPIC_ACCOUNT: &str = "anthropic-api-key";

/// Stores `value` under `account` in the OS credential store.
/// An empty value clears the entry instead of storing a blank secret.
pub fn set_secret(account: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return delete_secret(account);
    }
    #[cfg(test)]
    {
        test_store::set(account, value);
        Ok(())
    }
    #[cfg(not(test))]
    {
        let entry = keyring::Entry::new(SERVICE, account)
            .map_err(|e| format!("keyring open failed: {}", e))?;
        entry
            .set_password(value)
            .map_err(|e| format!("keyring write failed: {}", e))
    }
}

/// Reads the secret stored under `account`, or `None` if there is no entry.
pub fn get_secret(account: &str) -> Result<Option<String>, String> {
    #[cfg(test)]
    {
        Ok(test_store::get(account))
    }
    #[cfg(not(test))]
    {
        let entry = keyring::Entry::new(SERVICE, account)
            .map_err(|e| format!("keyring open failed: {}", e))?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("keyring read failed: {}", e)),
        }
    }
}

/// Removes the secret stored under `account`. A missing entry is not an error.
pub fn delete_secret(account: &str) -> Result<(), String> {
    #[cfg(test)]
    {
        test_store::remove(account);
        Ok(())
    }
    #[cfg(not(test))]
    {
        let entry = keyring::Entry::new(SERVICE, account)
            .map_err(|e| format!("keyring open failed: {}", e))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("keyring delete failed: {}", e)),
        }
    }
}

// ===== Anthropic key convenience wrappers =====

pub fn set_anthropic_key(value: &str) -> Result<(), String> {
    set_secret(ANTHROPIC_ACCOUNT, value)
}

pub fn get_anthropic_key() -> Result<Option<String>, String> {
    get_secret(ANTHROPIC_ACCOUNT)
}

pub fn delete_anthropic_key() -> Result<(), String> {
    delete_secret(ANTHROPIC_ACCOUNT)
}

/// One-time migration: if a plaintext Anthropic key still lives in the
/// `settings.anthropicApiKey` column, move it into the OS credential store and
/// blank the column. Best-effort: any failure is logged and swallowed so it can
/// never block application startup. Safe to run on every launch.
pub async fn migrate_anthropic_key_to_secure_store(pool: &SqlitePool) {
    // Read the plaintext column directly (get_api_key already delegates to the
    // secure store for "claude", so we must query the column ourselves here).
    let plaintext: Option<String> =
        match sqlx::query_scalar("SELECT anthropicApiKey FROM settings WHERE id = '1' LIMIT 1")
            .fetch_optional(pool)
            .await
        {
            Ok(v) => v.flatten(),
            Err(e) => {
                log::warn!("secure-store migration: failed to read settings: {}", e);
                return;
            }
        };

    let plaintext = match plaintext {
        Some(v) if !v.trim().is_empty() => v,
        _ => return, // nothing to migrate
    };

    // Only overwrite the secure store if it does not already hold a key, so a
    // user who re-entered their key after an earlier migration is not clobbered.
    match get_anthropic_key() {
        Ok(Some(_)) => {
            log::info!("secure-store migration: key already present in OS store; clearing plaintext copy");
        }
        Ok(None) => {
            if let Err(e) = set_anthropic_key(&plaintext) {
                log::warn!("secure-store migration: failed to write to OS store, leaving plaintext in place: {}", e);
                return;
            }
            log::info!("secure-store migration: moved Anthropic API key from SQLite into the OS credential store");
        }
        Err(e) => {
            log::warn!("secure-store migration: OS store unavailable, leaving plaintext in place: {}", e);
            return;
        }
    }

    // Blank the plaintext column now that the key is safely in the OS store.
    if let Err(e) = sqlx::query("UPDATE settings SET anthropicApiKey = NULL WHERE id = '1'")
        .execute(pool)
        .await
    {
        log::warn!("secure-store migration: failed to clear plaintext column: {}", e);
    }
}

#[cfg(test)]
mod test_store {
    //! In-process replacement for the OS credential store, used only in tests.
    use std::collections::HashMap;
    use std::sync::Mutex;

    use once_cell::sync::Lazy;

    static STORE: Lazy<Mutex<HashMap<String, String>>> =
        Lazy::new(|| Mutex::new(HashMap::new()));

    pub fn set(account: &str, value: &str) {
        STORE
            .lock()
            .unwrap()
            .insert(account.to_string(), value.to_string());
    }

    pub fn get(account: &str) -> Option<String> {
        STORE.lock().unwrap().get(account).cloned()
    }

    pub fn remove(account: &str) {
        STORE.lock().unwrap().remove(account);
    }
}

/// Serializes tests that touch the shared Anthropic account so that the parallel
/// test runner cannot let them clobber each other's entry.
#[cfg(test)]
pub(crate) fn anthropic_test_guard() -> &'static std::sync::Mutex<()> {
    static GUARD: once_cell::sync::Lazy<std::sync::Mutex<()>> =
        once_cell::sync::Lazy::new(|| std::sync::Mutex::new(()));
    &GUARD
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::test_helpers::create_test_pool;

    #[test]
    fn test_set_get_delete_roundtrip() {
        set_secret("test-account-roundtrip", "sk-secret").unwrap();
        assert_eq!(
            get_secret("test-account-roundtrip").unwrap().as_deref(),
            Some("sk-secret")
        );
        delete_secret("test-account-roundtrip").unwrap();
        assert!(get_secret("test-account-roundtrip").unwrap().is_none());
    }

    #[test]
    fn test_empty_value_clears_entry() {
        set_secret("test-account-empty", "value").unwrap();
        set_secret("test-account-empty", "").unwrap();
        assert!(get_secret("test-account-empty").unwrap().is_none());
    }

    #[tokio::test]
    async fn test_migrate_moves_plaintext_and_blanks_column() {
        let _guard = anthropic_test_guard()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        // Seed a plaintext Anthropic key the old (insecure) way.
        sqlx::query(
            r#"INSERT INTO settings (id, provider, model, whisperModel, anthropicApiKey)
               VALUES ('1', 'claude', 'claude-opus-4-6', 'large-v3', 'sk-ant-plaintext')"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        // Ensure a clean secure store for this account before migrating.
        delete_anthropic_key().unwrap();

        migrate_anthropic_key_to_secure_store(&pool).await;

        // Key now lives in the secure store...
        assert_eq!(
            get_anthropic_key().unwrap().as_deref(),
            Some("sk-ant-plaintext")
        );

        // ...and the plaintext column has been blanked.
        let col: Option<String> =
            sqlx::query_scalar("SELECT anthropicApiKey FROM settings WHERE id = '1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(col.is_none(), "plaintext column should be NULL, got {:?}", col);

        // Cleanup so the in-process store does not leak into other tests.
        delete_anthropic_key().unwrap();
    }
}
