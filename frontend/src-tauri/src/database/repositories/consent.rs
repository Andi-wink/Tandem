//! Consent log for recorded calls.
//!
//! Recording a call without every participant's consent is a criminal offence in Germany
//! (§ 201 Abs. 1 Nr. 1 StGB), Greece, Portugal and Switzerland among others, and consent must
//! exist *before* capture begins. GDPR Art 7(1) separately requires that the consent be provable.
//!
//! This module stores the proof. See `migrations/20260811000000_add_consent_log.sql` for the
//! reasoning behind each column, and `crate::consent` for the gate that enforces it.

use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};

/// A consent record as written to (and read back from) the log.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ConsentRecord {
    pub id: String,
    #[sqlx(rename = "meeting_title")]
    pub meeting_title: Option<String>,
    pub meeting_id: Option<String>,
    pub granted_at: String,
    pub recording_started_at: Option<String>,
    /// JSON-encoded array of participant names.
    pub participants: String,
    pub method: String,
    pub jurisdiction: Option<String>,
    pub language: Option<String>,
    pub engine: Option<String>,
    pub processing: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
}

/// What the UI sends when the user completes the pre-record consent gate.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentInput {
    pub meeting_title: Option<String>,
    pub participants: Vec<String>,
    /// "verbal" | "written" | "prior_written"
    pub method: String,
    pub jurisdiction: Option<String>,
    pub notes: Option<String>,
}

pub struct ConsentRepository;

impl ConsentRepository {
    /// Writes a consent record and returns its id. Never updates an existing row: consent
    /// records are evidence, so a correction is a new row, not an edit.
    pub async fn record(
        pool: &SqlitePool,
        input: &ConsentInput,
        language: Option<&str>,
        engine: Option<&str>,
        processing: Option<&str>,
    ) -> std::result::Result<String, sqlx::Error> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        let participants = serde_json::to_string(&input.participants)
            .unwrap_or_else(|_| "[]".to_string());

        sqlx::query(
            r#"
            INSERT INTO consent_log
                (id, meeting_title, meeting_id, granted_at, recording_started_at,
                 participants, method, jurisdiction, language, engine, processing, notes, created_at)
            VALUES ($1, $2, NULL, $3, NULL, $4, $5, $6, $7, $8, $9, $10, $11)
            "#,
        )
        .bind(&id)
        .bind(&input.meeting_title)
        .bind(&now)
        .bind(&participants)
        .bind(&input.method)
        .bind(&input.jurisdiction)
        .bind(language)
        .bind(engine)
        .bind(processing)
        .bind(&input.notes)
        .bind(&now)
        .execute(pool)
        .await?;

        Ok(id)
    }

    /// Stamps the moment the gated recording actually started, and links the meeting once its
    /// title is known. Separate from `record` because consent legally precedes capture and the
    /// gap between the two is exactly what an auditor would want to see.
    pub async fn mark_recording_started(
        pool: &SqlitePool,
        consent_id: &str,
        meeting_title: Option<&str>,
    ) -> std::result::Result<(), sqlx::Error> {
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            UPDATE consent_log
               SET recording_started_at = $1,
                   meeting_title = COALESCE($2, meeting_title)
             WHERE id = $3
            "#,
        )
        .bind(&now)
        .bind(meeting_title)
        .bind(consent_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Most recent consent records, newest first. Used by the settings screen so the log is
    /// inspectable without a SQLite client (an unreadable audit trail is not an audit trail).
    pub async fn list(
        pool: &SqlitePool,
        limit: i64,
    ) -> std::result::Result<Vec<ConsentRecord>, sqlx::Error> {
        sqlx::query_as::<_, ConsentRecord>(
            "SELECT * FROM consent_log ORDER BY granted_at DESC LIMIT $1",
        )
        .bind(limit)
        .fetch_all(pool)
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::test_helpers::create_test_pool;

    fn sample_input() -> ConsentInput {
        ConsentInput {
            meeting_title: Some("Discovery call".to_string()),
            participants: vec!["Andrew".to_string(), "Frau Müller".to_string()],
            method: "verbal".to_string(),
            jurisdiction: Some("DE".to_string()),
            notes: None,
        }
    }

    #[tokio::test]
    async fn records_and_lists_consent() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let id = ConsentRepository::record(
            &pool,
            &sample_input(),
            Some("de"),
            Some("parakeet"),
            Some("local"),
        )
        .await
        .unwrap();

        let rows = ConsentRepository::list(&pool, 10).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, id);
        assert_eq!(rows[0].method, "verbal");
        assert_eq!(rows[0].jurisdiction.as_deref(), Some("DE"));
        assert_eq!(rows[0].language.as_deref(), Some("de"));
        assert_eq!(rows[0].processing.as_deref(), Some("local"));
        // Participants round-trip as JSON, including non-ASCII names.
        let participants: Vec<String> = serde_json::from_str(&rows[0].participants).unwrap();
        assert_eq!(participants, vec!["Andrew", "Frau Müller"]);
        // Consent exists before recording does.
        assert!(rows[0].recording_started_at.is_none());
    }

    #[tokio::test]
    async fn marks_recording_started_after_consent() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let id = ConsentRepository::record(&pool, &sample_input(), None, None, None)
            .await
            .unwrap();
        ConsentRepository::mark_recording_started(&pool, &id, Some("Renamed meeting"))
            .await
            .unwrap();

        let rows = ConsentRepository::list(&pool, 10).await.unwrap();
        let row = &rows[0];
        let started = row.recording_started_at.as_ref().expect("start stamped");
        assert!(row.granted_at <= *started, "consent must precede recording");
        assert_eq!(row.meeting_title.as_deref(), Some("Renamed meeting"));
    }
}
