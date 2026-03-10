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
                "INSERT INTO transcripts (id, meeting_id, transcript, timestamp, audio_start_time, audio_end_time, duration)
                 VALUES (?, ?, ?, ?, ?, ?, ?)"
            )
            .bind(&transcript_id)
            .bind(&meeting_id)
            .bind(&segment.text)
            .bind(&segment.timestamp)
            .bind(segment.audio_start_time)
            .bind(segment.audio_end_time)
            .bind(segment.duration)
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
