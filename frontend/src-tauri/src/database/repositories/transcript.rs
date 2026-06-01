use crate::api::{TranscriptSearchResult, TranscriptSegment};
use chrono::Utc;
use sqlx::{Connection, Error as SqlxError, SqlitePool};
use tracing::{error, info};
use uuid::Uuid;

pub struct TranscriptsRepository;

impl TranscriptsRepository {
    /// Saves a new meeting and its associated transcript segments.
    /// This function uses a transaction to ensure that either both the meeting
    /// and all its transcripts are saved, or none of them are.
    pub async fn save_transcript(
        pool: &SqlitePool,
        meeting_title: &str,
        transcripts: &[TranscriptSegment],
        folder_path: Option<String>,
    ) -> Result<String, SqlxError> {
        let meeting_id = format!("meeting-{}", Uuid::new_v4());

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        let now = Utc::now();

        // 1. Create the new meeting
        let result = sqlx::query(
            "INSERT INTO meetings (id, title, created_at, updated_at, folder_path) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&meeting_id)
        .bind(meeting_title)
        .bind(now)
        .bind(now)
        .bind(&folder_path)
        .execute(&mut *transaction)
        .await;

        if let Err(e) = result {
            error!("Failed to create meeting '{}': {}", meeting_title, e);
            transaction.rollback().await?;
            return Err(e);
        }

        info!("Successfully created meeting with id: {}", meeting_id);

        // 2. Save each transcript segment with audio timing fields
        for segment in transcripts {
            let transcript_id = format!("transcript-{}", Uuid::new_v4());
            let result = sqlx::query(
                "INSERT INTO transcripts (id, meeting_id, transcript, timestamp, audio_start_time, audio_end_time, duration, speaker)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            )
            .bind(&transcript_id)
            .bind(&meeting_id)
            .bind(&segment.text)
            .bind(&segment.timestamp)
            .bind(segment.audio_start_time)
            .bind(segment.audio_end_time)
            .bind(segment.duration)
            .bind(segment.source.as_deref())
            .execute(&mut *transaction)
            .await;

            if let Err(e) = result {
                error!(
                    "Failed to save transcript segment for meeting {}: {}",
                    meeting_id, e
                );
                transaction.rollback().await?;
                return Err(e);
            }
        }

        info!(
            "Successfully saved {} transcript segments for meeting {}",
            transcripts.len(),
            meeting_id
        );

        // Commit the transaction
        transaction.commit().await?;

        Ok(meeting_id)
    }

    /// Updates the text of a single transcript segment by its ID.
    pub async fn update_transcript_text(
        pool: &SqlitePool,
        transcript_id: &str,
        new_text: &str,
    ) -> Result<bool, SqlxError> {
        let result = sqlx::query(
            "UPDATE transcripts SET transcript = ? WHERE id = ?",
        )
        .bind(new_text)
        .bind(transcript_id)
        .execute(pool)
        .await?;

        Ok(result.rows_affected() > 0)
    }

    /// Searches for a query string within the transcripts.
    /// It returns a list of matching transcripts with context.
    pub async fn search_transcripts(
        pool: &SqlitePool,
        query: &str,
    ) -> Result<Vec<TranscriptSearchResult>, SqlxError> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }

        // Escape LIKE special characters so %, _ in user input are matched literally
        let escaped = query
            .to_lowercase()
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let search_query = format!("%{}%", escaped);

        let rows = sqlx::query_as::<_, (String, String, String, String)>(
            "SELECT m.id, m.title, t.transcript, t.timestamp
             FROM meetings m
             JOIN transcripts t ON m.id = t.meeting_id
             WHERE LOWER(t.transcript) LIKE ? ESCAPE '\\'
             ORDER BY t.timestamp DESC
             LIMIT 50",
        )
        .bind(&search_query)
        .fetch_all(pool)
        .await?;

        let results = rows
            .into_iter()
            .map(|(id, title, transcript, timestamp)| {
                let match_context = Self::get_match_context(&transcript, query);
                TranscriptSearchResult {
                    id,
                    title,
                    match_context,
                    timestamp,
                }
            })
            .collect();

        Ok(results)
    }

    /// Helper function to extract a snippet of text around the first match of a query.
    /// Uses char-based indexing to avoid panicking on multi-byte UTF-8 boundaries.
    fn get_match_context(transcript: &str, query: &str) -> String {
        let query_lower = query.to_lowercase();
        let chars: Vec<char> = transcript.chars().collect();
        let lower_chars: Vec<char> = transcript.to_lowercase().chars().collect();
        let query_chars: Vec<char> = query_lower.chars().collect();

        // Find the match position in char indices (not byte offsets)
        let match_pos = lower_chars
            .windows(query_chars.len())
            .position(|w| w == query_chars.as_slice());

        match match_pos {
            Some(pos) => {
                let context_chars = 100;
                let start = pos.saturating_sub(context_chars);
                let end = (pos + query_chars.len() + context_chars).min(chars.len());

                let mut context = String::new();
                if start > 0 {
                    context.push_str("...");
                }
                context.extend(&chars[start..end]);
                if end < chars.len() {
                    context.push_str("...");
                }
                context
            }
            None => chars.iter().take(200).collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::TranscriptSegment;
    use crate::database::test_helpers::create_test_pool;

    fn make_segment(id: &str, text: &str, ts: &str) -> TranscriptSegment {
        TranscriptSegment {
            id: id.into(),
            text: text.into(),
            timestamp: ts.into(),
            audio_start_time: Some(0.0),
            audio_end_time: Some(1.0),
            duration: Some(1.0),
            source: None,
        }
    }

    #[tokio::test]
    async fn test_save_transcript_creates_meeting_and_segments() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let segments = vec![
            make_segment("t-1", "Hello world", "12:00:00"),
            make_segment("t-2", "Goodbye world", "12:01:00"),
        ];

        let meeting_id =
            TranscriptsRepository::save_transcript(&pool, "Test Meeting", &segments, None)
                .await
                .unwrap();

        assert!(meeting_id.starts_with("meeting-"));

        // Verify segments exist
        let count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM transcripts WHERE meeting_id = ?")
                .bind(&meeting_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count.0, 2);
    }

    #[tokio::test]
    async fn test_save_transcript_with_folder_path() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let segments = vec![make_segment("t-1", "Test", "12:00:00")];
        let meeting_id = TranscriptsRepository::save_transcript(
            &pool,
            "Meeting",
            &segments,
            Some("/recordings/meeting1".into()),
        )
        .await
        .unwrap();

        let folder: Option<String> =
            sqlx::query_scalar("SELECT folder_path FROM meetings WHERE id = ?")
                .bind(&meeting_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(folder.as_deref(), Some("/recordings/meeting1"));
    }

    #[tokio::test]
    async fn test_update_transcript_text() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let segments = vec![make_segment("t-1", "Original text", "12:00:00")];
        let meeting_id =
            TranscriptsRepository::save_transcript(&pool, "Meeting", &segments, None)
                .await
                .unwrap();

        // Get the transcript ID
        let tid: String =
            sqlx::query_scalar("SELECT id FROM transcripts WHERE meeting_id = ?")
                .bind(&meeting_id)
                .fetch_one(&pool)
                .await
                .unwrap();

        let updated = TranscriptsRepository::update_transcript_text(&pool, &tid, "Updated text")
            .await
            .unwrap();
        assert!(updated);

        // Verify update
        let text: String =
            sqlx::query_scalar("SELECT transcript FROM transcripts WHERE id = ?")
                .bind(&tid)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(text, "Updated text");
    }

    #[tokio::test]
    async fn test_update_transcript_text_nonexistent() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let updated =
            TranscriptsRepository::update_transcript_text(&pool, "nonexistent", "New text")
                .await
                .unwrap();
        assert!(!updated);
    }

    #[tokio::test]
    async fn test_search_transcripts() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let segments = vec![
            make_segment("t-1", "The quick brown fox jumps over the lazy dog", "12:00:00"),
            make_segment("t-2", "A different sentence entirely", "12:01:00"),
        ];
        TranscriptsRepository::save_transcript(&pool, "Searchable", &segments, None)
            .await
            .unwrap();

        let results = TranscriptsRepository::search_transcripts(&pool, "brown fox")
            .await
            .unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].match_context.contains("brown fox"));
    }

    #[tokio::test]
    async fn test_search_transcripts_empty_query() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let results = TranscriptsRepository::search_transcripts(&pool, "  ")
            .await
            .unwrap();
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn test_search_transcripts_special_chars() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let segments = vec![make_segment(
            "t-1",
            "Price is 100% guaranteed",
            "12:00:00",
        )];
        TranscriptsRepository::save_transcript(&pool, "Special", &segments, None)
            .await
            .unwrap();

        // Search with % which is a LIKE wildcard — should be escaped
        let results = TranscriptsRepository::search_transcripts(&pool, "100%")
            .await
            .unwrap();
        assert_eq!(results.len(), 1);
    }

    #[tokio::test]
    async fn test_search_transcripts_case_insensitive() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let segments = vec![make_segment("t-1", "Hello World", "12:00:00")];
        TranscriptsRepository::save_transcript(&pool, "Case", &segments, None)
            .await
            .unwrap();

        let results = TranscriptsRepository::search_transcripts(&pool, "hello world")
            .await
            .unwrap();
        assert_eq!(results.len(), 1);
    }

    #[tokio::test]
    async fn test_get_match_context_with_match() {
        let transcript = "This is a long text that contains the word 'important' somewhere in the middle of it";
        let context = TranscriptsRepository::get_match_context(transcript, "important");
        assert!(context.contains("important"));
        // Input is short enough to fit within ±100 char window — no ellipsis expected
        assert!(!context.starts_with("..."), "short text should not be truncated");
        assert_eq!(context, transcript, "entire text should be returned when it fits in the window");
    }

    #[tokio::test]
    async fn test_get_match_context_windowing() {
        // Build a transcript >200 chars with the match near the end to exercise windowing
        let prefix = "A".repeat(150);
        let suffix = "B".repeat(150);
        let transcript = format!("{prefix} TARGET {suffix}");
        let context = TranscriptsRepository::get_match_context(&transcript, "TARGET");
        assert!(context.contains("TARGET"), "match must be in the window");
        assert!(context.starts_with("..."), "long text should have leading ellipsis");
        assert!(context.ends_with("..."), "long text should have trailing ellipsis");
        assert!(context.len() < transcript.len(), "context should be shorter than full transcript");
    }

    #[tokio::test]
    async fn test_get_match_context_no_match() {
        let transcript = "Short text here";
        let context = TranscriptsRepository::get_match_context(transcript, "nonexistent");
        assert_eq!(context, "Short text here");
    }

    #[tokio::test]
    async fn test_get_match_context_utf8() {
        let transcript = "Hello 世界 this is a test with unicode characters 日本語";
        let context = TranscriptsRepository::get_match_context(transcript, "世界");
        assert!(context.contains("世界"));
    }
}
