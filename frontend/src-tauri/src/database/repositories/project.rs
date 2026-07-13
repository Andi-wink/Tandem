use crate::database::models::ProjectModel;
use sqlx::SqlitePool;
use uuid::Uuid;

pub struct ProjectRepository;

impl ProjectRepository {
    pub async fn list_projects(
        pool: &SqlitePool,
    ) -> std::result::Result<Vec<ProjectModel>, sqlx::Error> {
        let projects = sqlx::query_as::<_, ProjectModel>(
            "SELECT * FROM projects ORDER BY name ASC",
        )
        .fetch_all(pool)
        .await?;
        Ok(projects)
    }

    /// Create a project, or return the existing one if `path` is already registered.
    ///
    /// `path` has a UNIQUE constraint, and callers frequently "adopt" a folder that may already be
    /// a registered project but hasn't shown up yet in the caller's local project list (e.g. the
    /// frontend's project picker resolves `listProjects()` asynchronously, so a fast click on a
    /// not-yet-loaded row falls through to "create a project for this dir"). Without this check
    /// that INSERT fails on the UNIQUE constraint, the frontend surfaces an error and the user's
    /// selection appears to silently do nothing — requiring them to reopen the picker and pick again
    /// once the project list has caught up. Treating create-by-path as idempotent fixes that at the
    /// root instead of requiring every caller to pre-check.
    pub async fn create_project(
        pool: &SqlitePool,
        name: &str,
        path: &str,
        aliases: &str,
        auto_discovered: bool,
    ) -> std::result::Result<ProjectModel, sqlx::Error> {
        if let Some(existing) = Self::find_by_path(pool, path).await? {
            return Ok(existing);
        }

        let id = Uuid::new_v4().to_string();
        let auto_disc: i64 = if auto_discovered { 1 } else { 0 };

        sqlx::query(
            r#"
            INSERT INTO projects (id, name, path, aliases, auto_discovered)
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(&id)
        .bind(name)
        .bind(path)
        .bind(aliases)
        .bind(auto_disc)
        .execute(pool)
        .await?;

        // Fetch and return the created project
        let project = sqlx::query_as::<_, ProjectModel>(
            "SELECT * FROM projects WHERE id = $1",
        )
        .bind(&id)
        .fetch_one(pool)
        .await?;

        Ok(project)
    }

    pub async fn update_project(
        pool: &SqlitePool,
        id: &str,
        name: &str,
        path: &str,
        aliases: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            UPDATE projects
            SET name = $1, path = $2, aliases = $3, updated_at = datetime('now')
            WHERE id = $4
            "#,
        )
        .bind(name)
        .bind(path)
        .bind(aliases)
        .bind(id)
        .execute(pool)
        .await?;

        Ok(())
    }

    pub async fn delete_project(
        pool: &SqlitePool,
        id: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM projects WHERE id = $1")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn find_by_path(
        pool: &SqlitePool,
        path: &str,
    ) -> std::result::Result<Option<ProjectModel>, sqlx::Error> {
        let project = sqlx::query_as::<_, ProjectModel>(
            "SELECT * FROM projects WHERE path = $1 LIMIT 1",
        )
        .bind(path)
        .fetch_optional(pool)
        .await?;
        Ok(project)
    }
}
