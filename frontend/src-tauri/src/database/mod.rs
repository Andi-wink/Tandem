pub mod commands;
pub mod manager;
pub mod models;
pub mod repositories;
pub mod setup;

#[cfg(test)]
pub(crate) mod test_helpers {
    use sqlx::SqlitePool;

    /// Create a temporary SQLite pool with all migrations applied.
    /// Uses a file-based DB in the given directory (required by sqlx migrations).
    pub async fn create_test_pool(dir: &std::path::Path) -> SqlitePool {
        let db_path = dir.join("test.sqlite");
        let db_url = format!("sqlite:{}?mode=rwc", db_path.display());
        let pool = SqlitePool::connect(&db_url)
            .await
            .expect("Failed to connect to test database");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("Failed to run migrations");
        pool
    }
}
