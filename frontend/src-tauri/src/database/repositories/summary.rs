use crate::database::models::SummaryProcess;
use chrono::Utc;
use serde_json::Value;
use sqlx::SqlitePool;
use tracing::{error, info as log_info};

pub struct SummaryProcessesRepository;

impl SummaryProcessesRepository {
    /// Retrieves the current summary process state for a given meeting ID.
    pub async fn get_summary_data(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Option<SummaryProcess>, sqlx::Error> {
        sqlx::query_as::<_, SummaryProcess>("SELECT * FROM summary_processes WHERE meeting_id = ?")
            .bind(meeting_id)
            .fetch_optional(pool)
            .await
    }

    pub async fn update_meeting_summary(
        pool: &SqlitePool,
        meeting_id: &str,
        summary: &Value,
    ) -> Result<bool, sqlx::Error> {
        let mut transaction = pool.begin().await?;

        let meeting_exists: bool = sqlx::query("SELECT 1 FROM meetings WHERE id = ?")
            .bind(meeting_id)
            .fetch_optional(&mut *transaction)
            .await?
            .is_some();

        if !meeting_exists {
            log_info!(
                "Attempted to save summary for a non-existent meeting_id: {}",
                meeting_id
            );
            transaction.rollback().await?;
            return Ok(false);
        }

        let result_json = serde_json::to_string(summary);
        if result_json.is_err() {
            error!("Can't convert the json to string for saving to Database");
            transaction.rollback().await?;
            return Ok(false);
        }
        let now = Utc::now();

        sqlx::query("UPDATE summary_processes SET result = ?, updated_at = ? WHERE meeting_id = ?")
            .bind(&result_json.unwrap())
            .bind(now)
            .bind(meeting_id)
            .execute(&mut *transaction)
            .await?;

        sqlx::query("UPDATE meetings SET updated_at = ? WHERE id = ?")
            .bind(now)
            .bind(meeting_id)
            .execute(&mut *transaction)
            .await?;

        transaction.commit().await?;

        log_info!(
            "Successfully updated summary and timestamp for meeting_id: {}",
            meeting_id
        );
        Ok(true)
    }

    pub async fn get_summary_data_for_meeting(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Option<SummaryProcess>, sqlx::Error> {
        sqlx::query_as::<_, SummaryProcess>(
            "SELECT p.* FROM summary_processes p JOIN transcript_chunks t ON p.meeting_id = t.meeting_id WHERE p.meeting_id = ?",
        )
        .bind(meeting_id)
        .fetch_optional(pool)
        .await
    }

    pub async fn create_or_reset_process(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<(), sqlx::Error> {
        log_info!(
            "Creating or resetting summary process for meeting_id: {}",
            meeting_id
        );
        let now = Utc::now();
        sqlx::query(
            r#"
            INSERT INTO summary_processes (meeting_id, status, created_at, updated_at, start_time, result, error)
            VALUES (?, 'PENDING', ?, ?, ?, NULL, NULL)
            ON CONFLICT(meeting_id) DO UPDATE SET
                status = 'PENDING',
                updated_at = excluded.updated_at,
                start_time = excluded.start_time,
                result_backup = result,
                result_backup_timestamp = excluded.updated_at,
                result = result,
                error = NULL
            "#
        )
        .bind(meeting_id)
        .bind(now)
        .bind(now)
        .bind(now)
        .execute(pool)
        .await?;
        log_info!(
            "Backed up existing summary before regeneration for meeting_id: {}",
            meeting_id
        );
        Ok(())
    }

    pub async fn update_process_completed(
        pool: &SqlitePool,
        meeting_id: &str,
        result: Value, // Keep this as Value to handle both old and new formats if needed
        chunk_count: i64,
        processing_time: f64,
    ) -> Result<(), sqlx::Error> {
        let now = Utc::now();
        let result_str = serde_json::to_string(&result)
            .map_err(|e| sqlx::Error::Protocol(format!("Failed to serialize result: {}", e)))?;

        sqlx::query(
            r#"
            UPDATE summary_processes
            SET status = 'completed', result = ?, updated_at = ?, end_time = ?, chunk_count = ?, processing_time = ?, error = NULL, result_backup = NULL, result_backup_timestamp = NULL
            WHERE meeting_id = ?
            "#
        )
        .bind(result_str)
        .bind(now)
        .bind(now)
        .bind(chunk_count)
        .bind(processing_time)
        .bind(meeting_id)
        .execute(pool)
        .await?;
        log_info!(
            "Summary completed and backup cleared for meeting_id: {}",
            meeting_id
        );
        Ok(())
    }

    pub async fn update_process_failed(
        pool: &SqlitePool,
        meeting_id: &str,
        error: &str,
    ) -> Result<(), sqlx::Error> {
        let now = Utc::now();

        // Restore from backup if it exists, otherwise keep current result
        sqlx::query(
            r#"
            UPDATE summary_processes
            SET
                status = 'failed',
                error = ?,
                updated_at = ?,
                end_time = ?,
                result = COALESCE(result_backup, result),
                result_backup = NULL,
                result_backup_timestamp = NULL
            WHERE meeting_id = ?
            "#,
        )
        .bind(error)
        .bind(now)
        .bind(now)
        .bind(meeting_id)
        .execute(pool)
        .await?;
        log_info!(
            "Summary generation failed and backup restored for meeting_id: {}",
            meeting_id
        );
        Ok(())
    }

    pub async fn update_process_cancelled(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<(), sqlx::Error> {
        let now = Utc::now();

        // Restore from backup if it exists, otherwise keep current result
        sqlx::query(
            r#"
            UPDATE summary_processes
            SET
                status = 'cancelled',
                updated_at = ?,
                end_time = ?,
                error = 'Generation was cancelled by user',
                result = COALESCE(result_backup, result),
                result_backup = NULL,
                result_backup_timestamp = NULL
            WHERE meeting_id = ?
            "#,
        )
        .bind(now)
        .bind(now)
        .bind(meeting_id)
        .execute(pool)
        .await?;
        log_info!(
            "Marked summary process as cancelled and restored backup for meeting_id: {}",
            meeting_id
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::repositories::meeting::MeetingsRepository;
    use crate::database::test_helpers::create_test_pool;
    use serde_json::json;

    /// Helper: create a meeting and summary process for testing
    async fn setup_meeting_with_process(pool: &SqlitePool) -> String {
        let meeting_id = "test-meeting-1";
        MeetingsRepository::update_meeting_title(pool, meeting_id, "Test Meeting")
            .await
            .unwrap();
        SummaryProcessesRepository::create_or_reset_process(pool, meeting_id)
            .await
            .unwrap();
        meeting_id.to_string()
    }

    #[tokio::test]
    async fn test_create_or_reset_process() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        MeetingsRepository::update_meeting_title(&pool, "m-1", "Meeting")
            .await
            .unwrap();

        SummaryProcessesRepository::create_or_reset_process(&pool, "m-1")
            .await
            .unwrap();

        let process = SummaryProcessesRepository::get_summary_data(&pool, "m-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(process.status, "PENDING");
        assert!(process.result.is_none());
        assert!(process.error.is_none());
    }

    #[tokio::test]
    async fn test_update_process_completed() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;
        let meeting_id = setup_meeting_with_process(&pool).await;

        let result = json!({ "title": "Summary", "blocks": [] });
        SummaryProcessesRepository::update_process_completed(
            &pool,
            &meeting_id,
            result.clone(),
            3,
            1.5,
        )
        .await
        .unwrap();

        let process = SummaryProcessesRepository::get_summary_data(&pool, &meeting_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(process.status, "completed");
        assert_eq!(process.chunk_count, 3);
        assert!(process.error.is_none());
        // Backup cleared on completion
        assert!(process.result_backup.is_none());
    }

    #[tokio::test]
    async fn test_update_process_failed_restores_backup() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;
        let meeting_id = setup_meeting_with_process(&pool).await;

        // First complete a summary
        let original = json!({ "title": "Original Summary" });
        SummaryProcessesRepository::update_process_completed(
            &pool,
            &meeting_id,
            original.clone(),
            2,
            1.0,
        )
        .await
        .unwrap();

        // Reset (creates backup of current result)
        SummaryProcessesRepository::create_or_reset_process(&pool, &meeting_id)
            .await
            .unwrap();

        // Fail — should restore backup
        SummaryProcessesRepository::update_process_failed(&pool, &meeting_id, "Out of tokens")
            .await
            .unwrap();

        let process = SummaryProcessesRepository::get_summary_data(&pool, &meeting_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(process.status, "failed");
        assert_eq!(process.error.as_deref(), Some("Out of tokens"));
        // Backup should have been restored into result
        assert!(process.result.is_some());
        // Backup fields cleared after restore
        assert!(process.result_backup.is_none());
    }

    #[tokio::test]
    async fn test_update_process_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;
        let meeting_id = setup_meeting_with_process(&pool).await;

        SummaryProcessesRepository::update_process_cancelled(&pool, &meeting_id)
            .await
            .unwrap();

        let process = SummaryProcessesRepository::get_summary_data(&pool, &meeting_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(process.status, "cancelled");
        assert_eq!(
            process.error.as_deref(),
            Some("Generation was cancelled by user")
        );
    }

    #[tokio::test]
    async fn test_update_meeting_summary() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;
        let meeting_id = setup_meeting_with_process(&pool).await;

        let summary = json!({ "blocks": [{ "type": "text", "text": "Summary content" }] });
        let ok = SummaryProcessesRepository::update_meeting_summary(&pool, &meeting_id, &summary)
            .await
            .unwrap();
        assert!(ok);
    }

    #[tokio::test]
    async fn test_update_meeting_summary_nonexistent() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let summary = json!({ "title": "Orphan" });
        let ok =
            SummaryProcessesRepository::update_meeting_summary(&pool, "nonexistent", &summary)
                .await
                .unwrap();
        assert!(!ok);
    }

    #[tokio::test]
    async fn test_get_summary_data_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let data = SummaryProcessesRepository::get_summary_data(&pool, "nonexistent")
            .await
            .unwrap();
        assert!(data.is_none());
    }
}
