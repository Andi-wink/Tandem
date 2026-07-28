use crate::api::{MeetingDetails, MeetingTranscript};
use crate::database::models::{MeetingModel, Transcript};
use chrono::Utc;
use sqlx::{Connection, Error as SqlxError, SqliteConnection, SqlitePool};
use tracing::{error, info};

pub struct MeetingsRepository;

impl MeetingsRepository {
    pub async fn get_meetings(pool: &SqlitePool) -> Result<Vec<MeetingModel>, sqlx::Error> {
        let meetings =
            sqlx::query_as::<_, MeetingModel>("SELECT * FROM meetings ORDER BY created_at DESC")
                .fetch_all(pool)
                .await?;
        Ok(meetings)
    }

    pub async fn delete_meeting(pool: &SqlitePool, meeting_id: &str) -> Result<bool, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        match delete_meeting_with_transaction(&mut transaction, meeting_id).await {
            Ok(success) => {
                if success {
                    transaction.commit().await?;
                    info!(
                        "Successfully deleted meeting {} and all associated data",
                        meeting_id
                    );
                    Ok(true)
                } else {
                    transaction.rollback().await?;
                    Ok(false)
                }
            }
            Err(e) => {
                let _ = transaction.rollback().await;
                error!("Failed to delete meeting {}: {}", meeting_id, e);
                Err(e)
            }
        }
    }

    pub async fn get_meeting(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Option<MeetingDetails>, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        // Get meeting details
        let meeting: Option<MeetingModel> =
            sqlx::query_as("SELECT id, title, created_at, updated_at, folder_path FROM meetings WHERE id = ?")
                .bind(meeting_id)
                .fetch_optional(&mut *transaction)
                .await?;

        if meeting.is_none() {
            transaction.rollback().await?;
            return Err(SqlxError::RowNotFound);
        }

        if let Some(meeting) = meeting {
            // Get all transcripts for this meeting
            let transcripts =
                sqlx::query_as::<_, Transcript>("SELECT * FROM transcripts WHERE meeting_id = ?")
                    .bind(meeting_id)
                    .fetch_all(&mut *transaction)
                    .await?;

            transaction.commit().await?;

            // Convert Transcript to MeetingTranscript
            let meeting_transcripts = transcripts
                .into_iter()
                .map(|t| MeetingTranscript {
                    id: t.id,
                    text: t.transcript,
                    timestamp: t.timestamp,
                    audio_start_time: t.audio_start_time,
                    audio_end_time: t.audio_end_time,
                    duration: t.duration,
                    speaker: t.speaker.clone(),
                })
                .collect::<Vec<_>>();

            Ok(Some(MeetingDetails {
                id: meeting.id,
                title: meeting.title,
                created_at: meeting.created_at.0.to_rfc3339(),
                updated_at: meeting.updated_at.0.to_rfc3339(),
                transcripts: meeting_transcripts,
            }))
        } else {
            transaction.rollback().await?;
            Ok(None)
        }
    }

    /// Get meeting metadata without transcripts (for pagination)
    pub async fn get_meeting_metadata(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Option<MeetingModel>, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let meeting: Option<MeetingModel> =
            sqlx::query_as("SELECT id, title, created_at, updated_at, folder_path FROM meetings WHERE id = ?")
                .bind(meeting_id)
                .fetch_optional(pool)
                .await?;

        Ok(meeting)
    }

    /// Get meeting transcripts with pagination support
    pub async fn get_meeting_transcripts_paginated(
        pool: &SqlitePool,
        meeting_id: &str,
        limit: i64,
        offset: i64,
    ) -> Result<(Vec<Transcript>, i64), SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        // Get total count of transcripts for this meeting
        let total: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM transcripts WHERE meeting_id = ?"
        )
        .bind(meeting_id)
        .fetch_one(pool)
        .await?;

        // Get paginated transcripts ordered by audio_start_time
        let transcripts = sqlx::query_as::<_, Transcript>(
            "SELECT * FROM transcripts
             WHERE meeting_id = ?
             ORDER BY audio_start_time ASC
             LIMIT ? OFFSET ?"
        )
        .bind(meeting_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await?;

        Ok((transcripts, total.0))
    }

    pub async fn update_meeting_title(
        pool: &SqlitePool,
        meeting_id: &str,
        new_title: &str,
    ) -> Result<bool, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        let now = Utc::now().naive_utc();

        // Upsert: create the meeting if it doesn't exist yet (e.g. during live recording)
        sqlx::query(
            "INSERT INTO meetings (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at"
        )
            .bind(meeting_id)
            .bind(new_title)
            .bind(now)
            .bind(now)
            .execute(&mut *transaction)
            .await?;

        transaction.commit().await?;
        Ok(true)
    }

    /// Update meeting title and folder_path together (used when renaming also renames the folder on disk)
    pub async fn update_meeting_title_and_folder(
        pool: &SqlitePool,
        meeting_id: &str,
        new_title: &str,
        new_folder_path: &str,
    ) -> Result<bool, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        let now = Utc::now().naive_utc();

        let rows_affected = sqlx::query(
            "UPDATE meetings SET title = ?, folder_path = ?, updated_at = ? WHERE id = ?",
        )
        .bind(new_title)
        .bind(new_folder_path)
        .bind(now)
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

        if rows_affected.rows_affected() == 0 {
            transaction.rollback().await?;
            return Ok(false);
        }
        transaction.commit().await?;
        Ok(true)
    }

    /// Update only the meeting's folder_path (used when relocating the meeting folder on disk
    /// without renaming it, e.g. filing a call under a project's .tandem after recording stops).
    pub async fn update_meeting_folder_path(
        pool: &SqlitePool,
        meeting_id: &str,
        new_folder_path: &str,
    ) -> Result<bool, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let now = Utc::now().naive_utc();
        let rows_affected = sqlx::query(
            "UPDATE meetings SET folder_path = ?, updated_at = ? WHERE id = ?",
        )
        .bind(new_folder_path)
        .bind(now)
        .bind(meeting_id)
        .execute(pool)
        .await?;

        Ok(rows_affected.rows_affected() > 0)
    }

    pub async fn update_meeting_name(
        pool: &SqlitePool,
        meeting_id: &str,
        new_title: &str,
    ) -> Result<bool, SqlxError> {
        let mut transaction = pool.begin().await?;
        let now = Utc::now();

        // Update meetings table
        let meeting_update =
            sqlx::query("UPDATE meetings SET title = ?, updated_at = ? WHERE id = ?")
                .bind(new_title)
                .bind(now)
                .bind(meeting_id)
                .execute(&mut *transaction)
                .await?;

        if meeting_update.rows_affected() == 0 {
            transaction.rollback().await?;
            return Ok(false); // Meeting not found
        }

        // Update transcript_chunks table
        sqlx::query("UPDATE transcript_chunks SET meeting_name = ? WHERE meeting_id = ?")
            .bind(new_title)
            .bind(meeting_id)
            .execute(&mut *transaction)
            .await?;

        transaction.commit().await?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::TranscriptSegment;
    use crate::database::repositories::transcript::TranscriptsRepository;
    use crate::database::test_helpers::create_test_pool;

    #[tokio::test]
    async fn test_get_meetings_empty() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;
        let meetings = MeetingsRepository::get_meetings(&pool).await.unwrap();
        assert!(meetings.is_empty());
    }

    #[tokio::test]
    async fn test_update_meeting_title_creates_meeting() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let ok = MeetingsRepository::update_meeting_title(&pool, "m-1", "Test Meeting")
            .await
            .unwrap();
        assert!(ok);

        let meetings = MeetingsRepository::get_meetings(&pool).await.unwrap();
        assert_eq!(meetings.len(), 1);
        assert_eq!(meetings[0].id, "m-1");
        assert_eq!(meetings[0].title, "Test Meeting");
    }

    #[tokio::test]
    async fn test_update_meeting_title_upsert() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        MeetingsRepository::update_meeting_title(&pool, "m-1", "Original")
            .await
            .unwrap();
        MeetingsRepository::update_meeting_title(&pool, "m-1", "Updated")
            .await
            .unwrap();

        let meetings = MeetingsRepository::get_meetings(&pool).await.unwrap();
        assert_eq!(meetings.len(), 1);
        assert_eq!(meetings[0].title, "Updated");
    }

    #[tokio::test]
    async fn test_update_meeting_title_empty_id_error() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let result = MeetingsRepository::update_meeting_title(&pool, "  ", "Test").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_meeting_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        MeetingsRepository::update_meeting_title(&pool, "m-1", "My Meeting")
            .await
            .unwrap();

        let meta = MeetingsRepository::get_meeting_metadata(&pool, "m-1")
            .await
            .unwrap();
        assert!(meta.is_some());
        assert_eq!(meta.unwrap().title, "My Meeting");
    }

    #[tokio::test]
    async fn test_get_meeting_metadata_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let meta = MeetingsRepository::get_meeting_metadata(&pool, "nonexistent")
            .await
            .unwrap();
        assert!(meta.is_none());
    }

    #[tokio::test]
    async fn test_get_meeting_with_transcripts() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let segments = vec![TranscriptSegment {
            id: "t-1".into(),
            text: "Hello world".into(),
            timestamp: "12:00:00".into(),
            audio_start_time: Some(0.0),
            audio_end_time: Some(2.5),
            duration: Some(2.5),
            source: None,
        }];
        let meeting_id = TranscriptsRepository::save_transcript(&pool, "Test", &segments, None)
            .await
            .unwrap();

        let details = MeetingsRepository::get_meeting(&pool, &meeting_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(details.title, "Test");
        assert_eq!(details.transcripts.len(), 1);
        assert_eq!(details.transcripts[0].text, "Hello world");
    }

    #[tokio::test]
    async fn test_get_meeting_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let result = MeetingsRepository::get_meeting(&pool, "nonexistent").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_delete_meeting_cascade() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let segments = vec![TranscriptSegment {
            id: "t-1".into(),
            text: "Segment 1".into(),
            timestamp: "12:00:00".into(),
            audio_start_time: None,
            audio_end_time: None,
            duration: None,
            source: None,
        }];
        let meeting_id =
            TranscriptsRepository::save_transcript(&pool, "Meeting", &segments, None)
                .await
                .unwrap();

        let deleted = MeetingsRepository::delete_meeting(&pool, &meeting_id)
            .await
            .unwrap();
        assert!(deleted);

        let meetings = MeetingsRepository::get_meetings(&pool).await.unwrap();
        assert!(meetings.is_empty());

        // Verify transcript rows were also cascade-deleted
        let transcript_count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM transcripts WHERE meeting_id = ?")
                .bind(&meeting_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(transcript_count.0, 0, "transcripts should be cascade-deleted");
    }

    #[tokio::test]
    async fn test_delete_nonexistent_meeting() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let deleted = MeetingsRepository::delete_meeting(&pool, "nonexistent")
            .await
            .unwrap();
        assert!(!deleted);
    }

    #[tokio::test]
    async fn test_delete_meeting_empty_id() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let result = MeetingsRepository::delete_meeting(&pool, "").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_meeting_transcripts_paginated() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let segments: Vec<TranscriptSegment> = (0..5)
            .map(|i| TranscriptSegment {
                id: format!("t-{}", i),
                text: format!("Segment {}", i),
                timestamp: format!("12:00:0{}", i),
                audio_start_time: Some(i as f64),
                audio_end_time: Some(i as f64 + 1.0),
                duration: Some(1.0),
                source: None,
            })
            .collect();
        let meeting_id =
            TranscriptsRepository::save_transcript(&pool, "Paginated", &segments, None)
                .await
                .unwrap();

        let (page1, total) =
            MeetingsRepository::get_meeting_transcripts_paginated(&pool, &meeting_id, 2, 0)
                .await
                .unwrap();
        assert_eq!(total, 5);
        assert_eq!(page1.len(), 2);

        let (page2, _) =
            MeetingsRepository::get_meeting_transcripts_paginated(&pool, &meeting_id, 2, 2)
                .await
                .unwrap();
        assert_eq!(page2.len(), 2);

        let (page3, _) =
            MeetingsRepository::get_meeting_transcripts_paginated(&pool, &meeting_id, 2, 4)
                .await
                .unwrap();
        assert_eq!(page3.len(), 1);
    }

    #[tokio::test]
    async fn test_update_meeting_title_and_folder() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        MeetingsRepository::update_meeting_title(&pool, "m-1", "Old Title")
            .await
            .unwrap();

        let ok = MeetingsRepository::update_meeting_title_and_folder(
            &pool,
            "m-1",
            "New Title",
            "/new/path",
        )
        .await
        .unwrap();
        assert!(ok);

        let meta = MeetingsRepository::get_meeting_metadata(&pool, "m-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(meta.title, "New Title");
        assert_eq!(meta.folder_path.as_deref(), Some("/new/path"));
    }

    #[tokio::test]
    async fn test_update_meeting_title_and_folder_nonexistent() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let ok = MeetingsRepository::update_meeting_title_and_folder(
            &pool,
            "nonexistent",
            "Title",
            "/path",
        )
        .await
        .unwrap();
        assert!(!ok);
    }

    #[tokio::test]
    async fn test_update_meeting_name_nonexistent() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let ok = MeetingsRepository::update_meeting_name(&pool, "nonexistent", "Title")
            .await
            .unwrap();
        assert!(!ok);
    }
}

async fn delete_meeting_with_transaction(
    transaction: &mut SqliteConnection,
    meeting_id: &str,
) -> Result<bool, SqlxError> {
    // Check if meeting exists
    let meeting_exists: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM meetings WHERE id = ?")
        .bind(meeting_id)
        .fetch_optional(&mut *transaction)
        .await?;

    if meeting_exists.is_none() {
        error!("Meeting {} not found for deletion", meeting_id);
        return Ok(false);
    }

    // Delete from related tables in proper order
    // 1. Delete from transcript_chunks
    sqlx::query("DELETE FROM transcript_chunks WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    // 2. Delete from summary_processes
    sqlx::query("DELETE FROM summary_processes WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    // 3. Delete from transcripts
    sqlx::query("DELETE FROM transcripts WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    // 4. Finally, delete the meeting
    let result = sqlx::query("DELETE FROM meetings WHERE id = ?")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    Ok(result.rows_affected() > 0)
}
