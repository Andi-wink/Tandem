use crate::database::models::{Setting, TranscriptSetting};
use crate::summary::CustomOpenAIConfig;
use sqlx::SqlitePool;

#[derive(serde::Deserialize, Debug)]
pub struct SaveModelConfigRequest {
    pub provider: String,
    pub model: String,
    #[serde(rename = "whisperModel")]
    pub whisper_model: String,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
    #[serde(rename = "ollamaEndpoint")]
    pub ollama_endpoint: Option<String>,
}

#[derive(serde::Deserialize, Debug)]
pub struct SaveTranscriptConfigRequest {
    pub provider: String,
    pub model: String,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
}

/// Read-only calendar (ICS subscription) configuration.
/// `ics_url` embeds a secret bearer token, so it lives in its own table.
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct CalendarConfig {
    #[serde(rename = "icsUrl")]
    pub ics_url: Option<String>,
    #[serde(rename = "refreshMinutes")]
    pub refresh_minutes: i64,
}

pub struct SettingsRepository;

// Transcript providers: localWhisper, deepgram, elevenLabs, groq, openai
// Summary providers: openai, claude, ollama, groq, added openrouter
// NOTE: Handle data exclusion in the higher layer as this is database abstraction layer(using SELECT *)

impl SettingsRepository {
    pub async fn get_model_config(
        pool: &SqlitePool,
    ) -> std::result::Result<Option<Setting>, sqlx::Error> {
        let setting = sqlx::query_as::<_, Setting>("SELECT * FROM settings LIMIT 1")
            .fetch_optional(pool)
            .await?;
        Ok(setting)
    }

    pub async fn save_model_config(
        pool: &SqlitePool,
        provider: &str,
        model: &str,
        whisper_model: &str,
        ollama_endpoint: Option<&str>,
    ) -> std::result::Result<(), sqlx::Error> {
        // Using id '1' for backward compatibility
        sqlx::query(
            r#"
            INSERT INTO settings (id, provider, model, whisperModel, ollamaEndpoint)
            VALUES ('1', $1, $2, $3, $4)
            ON CONFLICT(id) DO UPDATE SET
                provider = excluded.provider,
                model = excluded.model,
                whisperModel = excluded.whisperModel,
                ollamaEndpoint = excluded.ollamaEndpoint
            "#,
        )
        .bind(provider)
        .bind(model)
        .bind(whisper_model)
        .bind(ollama_endpoint)
        .execute(pool)
        .await?;

        Ok(())
    }

    pub async fn save_api_key(
        pool: &SqlitePool,
        provider: &str,
        api_key: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        // Custom OpenAI uses JSON config (customOpenAIConfig) instead of a separate API key column
        if provider == "custom-openai" {
            return Err(sqlx::Error::Protocol(
                "custom-openai provider should use save_custom_openai_config() instead of save_api_key()".into(),
            ));
        }

        // The Anthropic/Claude key is kept in the OS credential store, never in
        // plaintext SQLite (see database::secure_store).
        if provider == "claude" {
            return crate::database::secure_store::set_anthropic_key(api_key)
                .map_err(|e| sqlx::Error::Protocol(e.into()));
        }

        let api_key_column = match provider {
            "openai" => "openaiApiKey",
            "claude" => "anthropicApiKey",
            "ollama" => "ollamaApiKey",
            "groq" => "groqApiKey",
            "openrouter" => "openRouterApiKey",
            "builtin-ai" => return Ok(()), // No API key needed
            _ => {
                return Err(sqlx::Error::Protocol(
                    format!("Invalid provider: {}", provider).into(),
                ))
            }
        };

        let query = format!(
            r#"
            INSERT INTO settings (id, provider, model, whisperModel, "{}")
            VALUES ('1', 'openai', 'gpt-4o-2024-11-20', 'large-v3', $1)
            ON CONFLICT(id) DO UPDATE SET
                "{}" = $1
            "#,
            api_key_column, api_key_column
        );
        sqlx::query(&query).bind(api_key).execute(pool).await?;

        Ok(())
    }

    pub async fn get_api_key(
        pool: &SqlitePool,
        provider: &str,
    ) -> std::result::Result<Option<String>, sqlx::Error> {
        // Custom OpenAI uses JSON config - extract API key from there
        if provider == "custom-openai" {
            let config = Self::get_custom_openai_config(pool).await?;
            return Ok(config.and_then(|c| c.api_key));
        }

        // The Anthropic/Claude key lives in the OS credential store, not SQLite.
        if provider == "claude" {
            return crate::database::secure_store::get_anthropic_key()
                .map_err(|e| sqlx::Error::Protocol(e.into()));
        }

        let api_key_column = match provider {
            "openai" => "openaiApiKey",
            "ollama" => "ollamaApiKey",
            "groq" => "groqApiKey",
            "claude" => "anthropicApiKey",
            "openrouter" => "openRouterApiKey",
            "builtin-ai" => return Ok(None), // No API key needed
            _ => {
                return Err(sqlx::Error::Protocol(
                    format!("Invalid provider: {}", provider).into(),
                ))
            }
        };

        let query = format!(
            "SELECT {} FROM settings WHERE id = '1' LIMIT 1",
            api_key_column
        );
        let api_key = sqlx::query_scalar(&query).fetch_optional(pool).await?;
        Ok(api_key)
    }

    pub async fn get_transcript_config(
        pool: &SqlitePool,
    ) -> std::result::Result<Option<TranscriptSetting>, sqlx::Error> {
        let setting =
            sqlx::query_as::<_, TranscriptSetting>("SELECT * FROM transcript_settings LIMIT 1")
                .fetch_optional(pool)
                .await?;
        Ok(setting)

    }

    pub async fn save_transcript_config(
        pool: &SqlitePool,
        provider: &str,
        model: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO transcript_settings (id, provider, model)
            VALUES ('1', $1, $2)
            ON CONFLICT(id) DO UPDATE SET
                provider = excluded.provider,
                model = excluded.model
            "#,
        )
        .bind(provider)
        .bind(model)
        .execute(pool)
        .await?;

        Ok(())
    }

    pub async fn save_transcript_api_key(
        pool: &SqlitePool,
        provider: &str,
        api_key: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        let api_key_column = match provider {
            "localWhisper" => "whisperApiKey",
            "parakeet" => return Ok(()), // Parakeet doesn't need an API key, return early
            "deepgram" => "deepgramApiKey",
            "elevenLabs" => "elevenLabsApiKey",
            "groq" => "groqApiKey",
            "openai" => "openaiApiKey",
            "mistral" => "mistralApiKey",
            _ => {
                return Err(sqlx::Error::Protocol(
                    format!("Invalid provider: {}", provider).into(),
                ))
            }
        };

        let query = format!(
            r#"
            INSERT INTO transcript_settings (id, provider, model, "{}")
            VALUES ('1', 'parakeet', 'parakeet-tdt-0.6b-v3-int8', $1)
            ON CONFLICT(id) DO UPDATE SET
                "{}" = $1
            "#,
            api_key_column, api_key_column
        );
        sqlx::query(&query).bind(api_key).execute(pool).await?;

        Ok(())
    }

    pub async fn get_transcript_api_key(
        pool: &SqlitePool,
        provider: &str,
    ) -> std::result::Result<Option<String>, sqlx::Error> {
        let api_key_column = match provider {
            "localWhisper" => "whisperApiKey",
            "parakeet" => return Ok(None), // Parakeet doesn't need an API key
            "deepgram" => "deepgramApiKey",
            "elevenLabs" => "elevenLabsApiKey",
            "groq" => "groqApiKey",
            "openai" => "openaiApiKey",
            "mistral" => "mistralApiKey",
            _ => {
                return Err(sqlx::Error::Protocol(
                    format!("Invalid provider: {}", provider).into(),
                ))
            }
        };

        let query = format!(
            "SELECT {} FROM transcript_settings WHERE id = '1' LIMIT 1",
            api_key_column
        );
        let api_key = sqlx::query_scalar(&query).fetch_optional(pool).await?;
        Ok(api_key)
    }

    pub async fn delete_api_key(
        pool: &SqlitePool,
        provider: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        // Custom OpenAI uses JSON config - clear the entire config
        if provider == "custom-openai" {
            sqlx::query("UPDATE settings SET customOpenAIConfig = NULL WHERE id = '1'")
                .execute(pool)
                .await?;
            return Ok(());
        }

        // The Anthropic/Claude key lives in the OS credential store, not SQLite.
        if provider == "claude" {
            return crate::database::secure_store::delete_anthropic_key()
                .map_err(|e| sqlx::Error::Protocol(e.into()));
        }

        let api_key_column = match provider {
            "openai" => "openaiApiKey",
            "ollama" => "ollamaApiKey",
            "groq" => "groqApiKey",
            "claude" => "anthropicApiKey",
            "openrouter" => "openRouterApiKey",
            "builtin-ai" => return Ok(()), // No API key needed
            _ => {
                return Err(sqlx::Error::Protocol(
                    format!("Invalid provider: {}", provider).into(),
                ))
            }
        };

        let query = format!(
            "UPDATE settings SET {} = NULL WHERE id = '1'",
            api_key_column
        );
        sqlx::query(&query).execute(pool).await?;

        Ok(())
    }

    // ===== CUSTOM OPENAI CONFIG METHODS =====

    /// Gets the custom OpenAI configuration from JSON
    ///
    /// # Returns
    /// * `Ok(Some(CustomOpenAIConfig))` - Config exists and is valid JSON
    /// * `Ok(None)` - No config stored
    /// * `Err(sqlx::Error)` - Database error
    pub async fn get_custom_openai_config(
        pool: &SqlitePool,
    ) -> std::result::Result<Option<CustomOpenAIConfig>, sqlx::Error> {
        use sqlx::Row;

        let row = sqlx::query(
            r#"
            SELECT customOpenAIConfig
            FROM settings
            WHERE id = '1'
            LIMIT 1
            "#
        )
        .fetch_optional(pool)
        .await?;

        match row {
            Some(record) => {
                let config_json: Option<String> = record.get("customOpenAIConfig");

                if let Some(json) = config_json {
                    // Parse JSON into CustomOpenAIConfig
                    let config: CustomOpenAIConfig = serde_json::from_str(&json)
                        .map_err(|e| sqlx::Error::Protocol(
                            format!("Invalid JSON in customOpenAIConfig: {}", e).into()
                        ))?;

                    Ok(Some(config))
                } else {
                    Ok(None)
                }
            }
            None => Ok(None),
        }
    }

    /// Saves the custom OpenAI configuration as JSON
    ///
    /// # Arguments
    /// * `pool` - Database connection pool
    /// * `config` - CustomOpenAIConfig to save (includes endpoint, apiKey, model, maxTokens, temperature, topP)
    ///
    /// # Returns
    /// * `Ok(())` - Config saved successfully
    /// * `Err(sqlx::Error)` - Database or JSON serialization error
    pub async fn save_custom_openai_config(
        pool: &SqlitePool,
        config: &CustomOpenAIConfig,
    ) -> std::result::Result<(), sqlx::Error> {
        // Serialize config to JSON
        let config_json = serde_json::to_string(config)
            .map_err(|e| sqlx::Error::Protocol(
                format!("Failed to serialize config to JSON: {}", e).into()
            ))?;

        // Upsert into settings table
        sqlx::query(
            r#"
            INSERT INTO settings (id, provider, model, whisperModel, customOpenAIConfig)
            VALUES ('1', 'custom-openai', $1, 'large-v3', $2)
            ON CONFLICT(id) DO UPDATE SET
                customOpenAIConfig = excluded.customOpenAIConfig
            "#,
        )
        .bind(&config.model)
        .bind(config_json)
        .execute(pool)
        .await?;

        Ok(())
    }

    // ===== CALENDAR (ICS) CONFIG METHODS =====

    /// Gets the read-only calendar configuration (ICS URL + refresh interval).
    /// Returns a default (no URL, 15 min) when nothing is stored yet.
    pub async fn get_calendar_config(
        pool: &SqlitePool,
    ) -> std::result::Result<CalendarConfig, sqlx::Error> {
        use sqlx::Row;

        let row = sqlx::query(
            "SELECT ics_url, refresh_minutes FROM calendar_settings WHERE id = '1' LIMIT 1",
        )
        .fetch_optional(pool)
        .await?;

        match row {
            Some(record) => Ok(CalendarConfig {
                ics_url: record.get("ics_url"),
                refresh_minutes: record.get("refresh_minutes"),
            }),
            None => Ok(CalendarConfig {
                ics_url: None,
                refresh_minutes: 15,
            }),
        }
    }

    /// Saves the calendar configuration. An empty/None URL clears the calendar.
    pub async fn save_calendar_config(
        pool: &SqlitePool,
        ics_url: Option<&str>,
        refresh_minutes: i64,
    ) -> std::result::Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO calendar_settings (id, ics_url, refresh_minutes)
            VALUES ('1', $1, $2)
            ON CONFLICT(id) DO UPDATE SET
                ics_url = excluded.ics_url,
                refresh_minutes = excluded.refresh_minutes
            "#,
        )
        .bind(ics_url)
        .bind(refresh_minutes)
        .execute(pool)
        .await?;

        Ok(())
    }

    // ===== CLIENTS ROOT (client-folder discovery) =====

    /// Gets the configured "clients root" directory (whose subfolders are offered as filing
    /// candidates for calls). Reuses the key-value `app_settings` table. Returns None when unset —
    /// the command layer supplies the machine default.
    pub async fn get_clients_root(
        pool: &SqlitePool,
    ) -> std::result::Result<Option<String>, sqlx::Error> {
        let value: Option<String> =
            sqlx::query_scalar("SELECT value FROM app_settings WHERE key = 'clients_root' LIMIT 1")
                .fetch_optional(pool)
                .await?
                .flatten();
        Ok(value.filter(|v| !v.trim().is_empty()))
    }

    /// Saves (or, with None, clears) the clients-root directory.
    pub async fn save_clients_root(
        pool: &SqlitePool,
        clients_root: Option<&str>,
    ) -> std::result::Result<(), sqlx::Error> {
        match clients_root {
            Some(path) if !path.trim().is_empty() => {
                sqlx::query(
                    r#"
                    INSERT INTO app_settings (key, value)
                    VALUES ('clients_root', $1)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value
                    "#,
                )
                .bind(path.trim())
                .execute(pool)
                .await?;
            }
            _ => {
                sqlx::query("DELETE FROM app_settings WHERE key = 'clients_root'")
                    .execute(pool)
                    .await?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::test_helpers::create_test_pool;

    #[tokio::test]
    async fn test_save_and_get_model_config() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        SettingsRepository::save_model_config(&pool, "claude", "claude-opus-4-6", "large-v3", None)
            .await
            .unwrap();

        let config = SettingsRepository::get_model_config(&pool)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(config.provider, "claude");
        assert_eq!(config.model, "claude-opus-4-6");
        assert_eq!(config.whisper_model, "large-v3");
    }

    #[tokio::test]
    async fn test_save_model_config_upsert() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        SettingsRepository::save_model_config(&pool, "ollama", "llama3", "small", None)
            .await
            .unwrap();
        SettingsRepository::save_model_config(
            &pool,
            "claude",
            "claude-opus-4-6",
            "large-v3",
            None,
        )
        .await
        .unwrap();

        let config = SettingsRepository::get_model_config(&pool)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(config.provider, "claude");
    }

    #[tokio::test]
    async fn test_get_model_config_empty() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let config = SettingsRepository::get_model_config(&pool).await.unwrap();
        assert!(config.is_none());
    }

    #[tokio::test]
    async fn test_save_and_get_api_key_openai() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        SettingsRepository::save_api_key(&pool, "openai", "sk-test-key")
            .await
            .unwrap();

        let key = SettingsRepository::get_api_key(&pool, "openai")
            .await
            .unwrap();
        assert_eq!(key.as_deref(), Some("sk-test-key"));
    }

    #[tokio::test]
    async fn test_save_and_get_api_key_claude() {
        // The claude key routes through the OS credential store (mocked in tests);
        // serialize with other tests that touch the shared Anthropic account.
        let _guard = crate::database::secure_store::anthropic_test_guard()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        SettingsRepository::save_api_key(&pool, "claude", "sk-ant-test")
            .await
            .unwrap();

        let key = SettingsRepository::get_api_key(&pool, "claude")
            .await
            .unwrap();
        assert_eq!(key.as_deref(), Some("sk-ant-test"));

        // Clean up so the shared mock store does not leak into other tests.
        SettingsRepository::delete_api_key(&pool, "claude")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_save_api_key_invalid_provider() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let result = SettingsRepository::save_api_key(&pool, "invalid-provider", "key").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_save_api_key_custom_openai_error() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let result = SettingsRepository::save_api_key(&pool, "custom-openai", "key").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_save_api_key_builtin_ai_noop() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        // builtin-ai should succeed without storing anything
        SettingsRepository::save_api_key(&pool, "builtin-ai", "key")
            .await
            .unwrap();

        let key = SettingsRepository::get_api_key(&pool, "builtin-ai")
            .await
            .unwrap();
        assert!(key.is_none());
    }

    #[tokio::test]
    async fn test_delete_api_key() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        SettingsRepository::save_api_key(&pool, "groq", "gsk-test")
            .await
            .unwrap();

        // Verify key was stored
        let key = SettingsRepository::get_api_key(&pool, "groq")
            .await
            .unwrap();
        assert_eq!(key.as_deref(), Some("gsk-test"));

        SettingsRepository::delete_api_key(&pool, "groq")
            .await
            .unwrap();

        // Verify key is cleared via the repository API
        // Note: get_api_key returns Some("") for NULL columns, so check for empty
        let key = SettingsRepository::get_api_key(&pool, "groq")
            .await
            .unwrap();
        assert!(
            key.as_deref().unwrap_or("").is_empty(),
            "groq key should be empty/None after deletion, got: {:?}", key
        );
    }

    #[tokio::test]
    async fn test_save_and_get_transcript_config() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        SettingsRepository::save_transcript_config(&pool, "whisper", "large-v3")
            .await
            .unwrap();

        let config = SettingsRepository::get_transcript_config(&pool)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(config.provider, "whisper");
        assert_eq!(config.model, "large-v3");
    }

    #[tokio::test]
    async fn test_save_and_get_transcript_api_key() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        SettingsRepository::save_transcript_api_key(&pool, "deepgram", "dg-test-key")
            .await
            .unwrap();

        let key = SettingsRepository::get_transcript_api_key(&pool, "deepgram")
            .await
            .unwrap();
        assert_eq!(key.as_deref(), Some("dg-test-key"));
    }

    #[tokio::test]
    async fn test_transcript_api_key_parakeet_noop() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        SettingsRepository::save_transcript_api_key(&pool, "parakeet", "key")
            .await
            .unwrap();

        let key = SettingsRepository::get_transcript_api_key(&pool, "parakeet")
            .await
            .unwrap();
        assert!(key.is_none());
    }

    #[tokio::test]
    async fn test_save_and_get_custom_openai_config() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let config = CustomOpenAIConfig {
            endpoint: "https://my-server.com/v1".into(),
            api_key: Some("sk-custom-key".into()),
            model: "my-model".into(),
            max_tokens: Some(4096),
            temperature: Some(0.7),
            top_p: Some(0.9),
        };

        SettingsRepository::save_custom_openai_config(&pool, &config)
            .await
            .unwrap();

        let loaded = SettingsRepository::get_custom_openai_config(&pool)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.endpoint, "https://my-server.com/v1");
        assert_eq!(loaded.api_key.as_deref(), Some("sk-custom-key"));
        assert_eq!(loaded.model, "my-model");
        assert_eq!(loaded.max_tokens, Some(4096));
    }

    #[tokio::test]
    async fn test_get_custom_openai_config_empty() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let config = SettingsRepository::get_custom_openai_config(&pool)
            .await
            .unwrap();
        assert!(config.is_none());
    }

    #[tokio::test]
    async fn test_get_api_key_via_custom_openai() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let config = CustomOpenAIConfig {
            endpoint: "https://example.com".into(),
            api_key: Some("custom-key".into()),
            model: "model".into(),
            max_tokens: None,
            temperature: None,
            top_p: None,
        };

        SettingsRepository::save_custom_openai_config(&pool, &config)
            .await
            .unwrap();

        // get_api_key with "custom-openai" should extract from JSON config
        let key = SettingsRepository::get_api_key(&pool, "custom-openai")
            .await
            .unwrap();
        assert_eq!(key.as_deref(), Some("custom-key"));
    }

    #[tokio::test]
    async fn test_calendar_config_default_when_empty() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let config = SettingsRepository::get_calendar_config(&pool)
            .await
            .unwrap();
        assert!(config.ics_url.is_none());
        assert_eq!(config.refresh_minutes, 15);
    }

    #[tokio::test]
    async fn test_save_and_get_calendar_config() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        SettingsRepository::save_calendar_config(
            &pool,
            Some("https://example.com/secret/cal.ics"),
            30,
        )
        .await
        .unwrap();

        let config = SettingsRepository::get_calendar_config(&pool)
            .await
            .unwrap();
        assert_eq!(
            config.ics_url.as_deref(),
            Some("https://example.com/secret/cal.ics")
        );
        assert_eq!(config.refresh_minutes, 30);
    }

    #[tokio::test]
    async fn test_calendar_config_upsert_and_clear() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        SettingsRepository::save_calendar_config(&pool, Some("https://a.example/1.ics"), 15)
            .await
            .unwrap();
        // Upsert: change URL + interval
        SettingsRepository::save_calendar_config(&pool, Some("https://b.example/2.ics"), 60)
            .await
            .unwrap();

        let config = SettingsRepository::get_calendar_config(&pool)
            .await
            .unwrap();
        assert_eq!(config.ics_url.as_deref(), Some("https://b.example/2.ics"));
        assert_eq!(config.refresh_minutes, 60);

        // Clearing the URL (None) leaves the row but nulls the URL
        SettingsRepository::save_calendar_config(&pool, None, 15)
            .await
            .unwrap();
        let config = SettingsRepository::get_calendar_config(&pool)
            .await
            .unwrap();
        assert!(config.ics_url.is_none());
        assert_eq!(config.refresh_minutes, 15);
    }

    #[tokio::test]
    async fn test_delete_api_key_custom_openai() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let config = CustomOpenAIConfig {
            endpoint: "https://example.com".into(),
            api_key: Some("key".into()),
            model: "model".into(),
            max_tokens: None,
            temperature: None,
            top_p: None,
        };

        SettingsRepository::save_custom_openai_config(&pool, &config)
            .await
            .unwrap();

        SettingsRepository::delete_api_key(&pool, "custom-openai")
            .await
            .unwrap();

        let loaded = SettingsRepository::get_custom_openai_config(&pool)
            .await
            .unwrap();
        assert!(loaded.is_none());
    }
}
