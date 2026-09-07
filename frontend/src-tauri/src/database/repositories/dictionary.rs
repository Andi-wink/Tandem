// F056: Custom Transcription Dictionary repository.
//
// CRUD over the `custom_dictionary` table. The hot transcription path never
// touches this repository: it reads the in-memory snapshot in
// `crate::dictionary::cache`, which these commands refresh after every write.

use crate::database::models::CustomDictionaryEntry;
use sqlx::SqlitePool;
use uuid::Uuid;

pub struct DictionaryRepository;

impl DictionaryRepository {
    /// Every entry, enabled or not, newest edit last. The UI shows all of them;
    /// the cache filters on `enabled`.
    pub async fn list_entries(
        pool: &SqlitePool,
    ) -> std::result::Result<Vec<CustomDictionaryEntry>, sqlx::Error> {
        sqlx::query_as::<_, CustomDictionaryEntry>(
            "SELECT * FROM custom_dictionary ORDER BY term COLLATE NOCASE ASC",
        )
        .fetch_all(pool)
        .await
    }

    /// Only the rows that should influence transcription, in USER CREATION
    /// ORDER. That order is load-bearing: it is the order the terms reach the
    /// decoder prompt in, and the prompt is capped, so sorting alphabetically
    /// here would make the surviving terms depend on their spelling. `rowid`
    /// breaks ties between rows created in the same second.
    pub async fn list_enabled_entries(
        pool: &SqlitePool,
    ) -> std::result::Result<Vec<CustomDictionaryEntry>, sqlx::Error> {
        sqlx::query_as::<_, CustomDictionaryEntry>(
            "SELECT * FROM custom_dictionary WHERE enabled = 1 ORDER BY created_at ASC, rowid ASC",
        )
        .fetch_all(pool)
        .await
    }

    /// Every entry in USER CREATION ORDER, for export. Export must not use the
    /// alphabetical `list_entries` ordering: creation order decides which terms
    /// survive the capped decoder prompt, so an alphabetical export would
    /// silently reshuffle prompt priority when the file is imported elsewhere.
    pub async fn list_entries_in_creation_order(
        pool: &SqlitePool,
    ) -> std::result::Result<Vec<CustomDictionaryEntry>, sqlx::Error> {
        sqlx::query_as::<_, CustomDictionaryEntry>(
            "SELECT * FROM custom_dictionary ORDER BY created_at ASC, rowid ASC",
        )
        .fetch_all(pool)
        .await
    }

    /// Upsert keyed on the term itself, for import.
    ///
    /// Takes a connection rather than the pool so the caller can run a whole
    /// import inside one transaction. Conflict resolution is delegated to the
    /// `term COLLATE NOCASE` unique index, which makes each row a single
    /// statement and closes the check-then-insert race that a separate lookup
    /// would leave open.
    pub async fn upsert_by_term(
        conn: &mut sqlx::SqliteConnection,
        term: &str,
        aliases_json: &str,
        enabled: bool,
    ) -> std::result::Result<(), sqlx::Error> {
        let id = Uuid::new_v4().to_string();
        let enabled_i: i64 = if enabled { 1 } else { 0 };

        sqlx::query(
            r#"
            INSERT INTO custom_dictionary (id, term, aliases, enabled)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT(term COLLATE NOCASE) DO UPDATE SET
                aliases = excluded.aliases,
                enabled = excluded.enabled,
                updated_at = datetime('now')
            "#,
        )
        .bind(&id)
        .bind(term)
        .bind(aliases_json)
        .bind(enabled_i)
        .execute(conn)
        .await?;

        Ok(())
    }

    /// Insert when `id` is None or unknown, update otherwise. Returns the stored row.
    pub async fn upsert_entry(
        pool: &SqlitePool,
        id: Option<String>,
        term: &str,
        aliases_json: &str,
        enabled: bool,
    ) -> std::result::Result<CustomDictionaryEntry, sqlx::Error> {
        let id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let enabled_i: i64 = if enabled { 1 } else { 0 };

        sqlx::query(
            r#"
            INSERT INTO custom_dictionary (id, term, aliases, enabled)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT(id) DO UPDATE SET
                term = excluded.term,
                aliases = excluded.aliases,
                enabled = excluded.enabled,
                updated_at = datetime('now')
            "#,
        )
        .bind(&id)
        .bind(term)
        .bind(aliases_json)
        .bind(enabled_i)
        .execute(pool)
        .await?;

        sqlx::query_as::<_, CustomDictionaryEntry>(
            "SELECT * FROM custom_dictionary WHERE id = $1",
        )
        .bind(&id)
        .fetch_one(pool)
        .await
    }

    pub async fn delete_entry(
        pool: &SqlitePool,
        id: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM custom_dictionary WHERE id = $1")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// Import merges by term (case-insensitive): an incoming term that already
    /// exists updates that row rather than creating a duplicate, so importing the
    /// same file twice is idempotent instead of doubling the dictionary.
    pub async fn find_by_term(
        pool: &SqlitePool,
        term: &str,
    ) -> std::result::Result<Option<CustomDictionaryEntry>, sqlx::Error> {
        sqlx::query_as::<_, CustomDictionaryEntry>(
            "SELECT * FROM custom_dictionary WHERE term = $1 COLLATE NOCASE LIMIT 1",
        )
        .bind(term)
        .fetch_optional(pool)
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::test_helpers::create_test_pool;

    #[tokio::test]
    async fn upsert_inserts_then_updates_the_same_row() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let created =
            DictionaryRepository::upsert_entry(&pool, None, "n8n", r#"["n eight n"]"#, true)
                .await
                .unwrap();
        assert_eq!(created.term, "n8n");
        assert_eq!(created.enabled, 1);

        let updated = DictionaryRepository::upsert_entry(
            &pool,
            Some(created.id.clone()),
            "n8n",
            r#"["n eight n","innate"]"#,
            false,
        )
        .await
        .unwrap();
        assert_eq!(updated.id, created.id);
        assert_eq!(updated.enabled, 0);

        let all = DictionaryRepository::list_entries(&pool).await.unwrap();
        assert_eq!(all.len(), 1, "upsert must not create a second row");

        let enabled = DictionaryRepository::list_enabled_entries(&pool).await.unwrap();
        assert!(enabled.is_empty(), "disabled entry must be filtered out");

        DictionaryRepository::delete_entry(&pool, &created.id).await.unwrap();
        assert!(DictionaryRepository::list_entries(&pool).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_duplicate_term_is_rejected_case_insensitively() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        DictionaryRepository::upsert_entry(&pool, None, "n8n", r#"["n eight n"]"#, true)
            .await
            .unwrap();

        // A fresh id with the same term in different casing must hit the unique
        // index rather than quietly creating a second competing row.
        let err = DictionaryRepository::upsert_entry(&pool, None, "N8N", r#"["innate"]"#, true)
            .await
            .expect_err("a duplicate term must be rejected");
        match err {
            sqlx::Error::Database(db) => {
                assert_eq!(db.code().as_deref(), Some("2067"), "expected a UNIQUE violation");
            }
            other => panic!("expected a database error, got {:?}", other),
        }

        assert_eq!(DictionaryRepository::list_entries(&pool).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn enabled_entries_come_back_in_creation_order() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        // Inserted deliberately out of alphabetical order: the prompt cap makes
        // this ordering load-bearing, so it must follow insertion, not spelling.
        for term in ["zulu", "alpha", "mike"] {
            DictionaryRepository::upsert_entry(&pool, None, term, "[]", true)
                .await
                .unwrap();
        }

        let terms: Vec<String> = DictionaryRepository::list_enabled_entries(&pool)
            .await
            .unwrap()
            .into_iter()
            .map(|e| e.term)
            .collect();
        assert_eq!(terms, vec!["zulu", "alpha", "mike"]);
    }

    #[tokio::test]
    async fn upsert_by_term_merges_on_the_term_and_rolls_back_with_its_transaction() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        // Committed transaction: both rows land, and the case variant MERGES
        // onto the existing term rather than creating a second row.
        let mut tx = pool.begin().await.unwrap();
        DictionaryRepository::upsert_by_term(tx.as_mut(), "n8n", r#"["n eight n"]"#, true)
            .await
            .unwrap();
        DictionaryRepository::upsert_by_term(tx.as_mut(), "N8N", r#"["innate"]"#, false)
            .await
            .unwrap();
        DictionaryRepository::upsert_by_term(tx.as_mut(), "Tandem", r#"["tandum"]"#, true)
            .await
            .unwrap();
        tx.commit().await.unwrap();

        let rows = DictionaryRepository::list_entries(&pool).await.unwrap();
        assert_eq!(rows.len(), 2, "the case variant must merge, not duplicate");
        let n8n = rows.iter().find(|r| r.term.eq_ignore_ascii_case("n8n")).unwrap();
        assert_eq!(n8n.aliases, r#"["innate"]"#, "the later import wins");
        assert_eq!(n8n.enabled, 0);

        // Rolled-back transaction: a partial import leaves nothing behind.
        let mut tx = pool.begin().await.unwrap();
        DictionaryRepository::upsert_by_term(tx.as_mut(), "Excalidraw", "[]", true)
            .await
            .unwrap();
        drop(tx); // no commit: sqlx rolls back

        let rows = DictionaryRepository::list_entries(&pool).await.unwrap();
        assert_eq!(rows.len(), 2, "an uncommitted import must not persist");
        assert!(!rows.iter().any(|r| r.term == "Excalidraw"));
    }

    #[tokio::test]
    async fn export_ordering_is_creation_order_not_alphabetical() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        for term in ["zulu", "alpha", "mike"] {
            DictionaryRepository::upsert_entry(&pool, None, term, "[]", true)
                .await
                .unwrap();
        }

        let exported: Vec<String> = DictionaryRepository::list_entries_in_creation_order(&pool)
            .await
            .unwrap()
            .into_iter()
            .map(|e| e.term)
            .collect();
        assert_eq!(exported, vec!["zulu", "alpha", "mike"]);

        // The UI list stays alphabetical; only export changed.
        let listed: Vec<String> = DictionaryRepository::list_entries(&pool)
            .await
            .unwrap()
            .into_iter()
            .map(|e| e.term)
            .collect();
        assert_eq!(listed, vec!["alpha", "mike", "zulu"]);
    }

    #[tokio::test]
    async fn find_by_term_is_case_insensitive() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;
        DictionaryRepository::upsert_entry(&pool, None, "Tandem", r#"["tandum"]"#, true)
            .await
            .unwrap();
        let found = DictionaryRepository::find_by_term(&pool, "tandem").await.unwrap();
        assert!(found.is_some());
    }
}
