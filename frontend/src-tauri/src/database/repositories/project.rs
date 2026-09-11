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
        session_id: Option<&str>,
    ) -> std::result::Result<ProjectModel, sqlx::Error> {
        // Idempotent on the FULL identity (path, session_id), not on path alone.
        // F061 virtual sub-projects share a path with the plain project for that
        // folder, so a path-only check returned the plain row and the virtual row
        // was never inserted: two Claude chats on one repo then collapsed into a
        // single project and mixed their notes, tasks and screenshots. `IS`
        // comparison in find_by_path_session handles the NULL session_id case, so
        // plain creates still dedupe against plain rows exactly as before.
        if let Some(existing) = Self::find_by_path_session(pool, path, session_id).await? {
            return Ok(existing);
        }

        let id = Uuid::new_v4().to_string();
        let auto_disc: i64 = if auto_discovered { 1 } else { 0 };

        sqlx::query(
            r#"
            INSERT INTO projects (id, name, path, aliases, auto_discovered, session_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(&id)
        .bind(name)
        .bind(path)
        .bind(aliases)
        .bind(auto_disc)
        .bind(session_id)
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

    /// F061: find a project by (path, session_id) identity. `session_id = None`
    /// matches a plain folder project (NULL session_id); `Some(id)` matches the
    /// virtual sub-project for that chat session. Uses `IS` so a NULL bind
    /// compares against NULL rows correctly.
    pub async fn find_by_path_session(
        pool: &SqlitePool,
        path: &str,
        session_id: Option<&str>,
    ) -> std::result::Result<Option<ProjectModel>, sqlx::Error> {
        let project = sqlx::query_as::<_, ProjectModel>(
            "SELECT * FROM projects WHERE path = $1 AND session_id IS $2 LIMIT 1",
        )
        .bind(path)
        .bind(session_id)
        .fetch_optional(pool)
        .await?;
        Ok(project)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::test_helpers::create_test_pool;

    const PATH: &str = "D:\\Dev-projects\\Tandem";

    /// F061 regression: a virtual sub-project must be created even when a PLAIN
    /// project already exists for the same folder. The idempotency check used to
    /// match on path alone, so it returned the plain row, the INSERT never ran,
    /// and two Claude chats on one repo collapsed into a single project.
    #[tokio::test]
    async fn virtual_project_is_created_alongside_plain_project_at_same_path() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let plain = ProjectRepository::create_project(&pool, "Tandem", PATH, "[]", false, None)
            .await
            .unwrap();
        assert_eq!(plain.session_id, None);

        let virt =
            ProjectRepository::create_project(&pool, "Fix the HUD", PATH, "[]", true, Some("sess-1"))
                .await
                .unwrap();

        assert_ne!(virt.id, plain.id, "virtual sub-project must be its own row");
        assert_eq!(virt.session_id.as_deref(), Some("sess-1"));
        assert_eq!(virt.name, "Fix the HUD");
    }

    /// Two chats against the same folder stay separate projects.
    #[tokio::test]
    async fn two_sessions_at_one_path_are_distinct_projects() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let a = ProjectRepository::create_project(&pool, "Chat A", PATH, "[]", true, Some("sess-a"))
            .await
            .unwrap();
        let b = ProjectRepository::create_project(&pool, "Chat B", PATH, "[]", true, Some("sess-b"))
            .await
            .unwrap();

        assert_ne!(a.id, b.id);
        assert_eq!(a.session_id.as_deref(), Some("sess-a"));
        assert_eq!(b.session_id.as_deref(), Some("sess-b"));
    }

    /// The original idempotency guarantee still holds for plain creates: a repeat
    /// create for the same folder returns the existing row instead of erroring on
    /// the UNIQUE(path) constraint.
    #[tokio::test]
    async fn plain_create_is_still_idempotent_by_path() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let first = ProjectRepository::create_project(&pool, "Tandem", PATH, "[]", false, None)
            .await
            .unwrap();
        let second = ProjectRepository::create_project(&pool, "Renamed", PATH, "[]", false, None)
            .await
            .unwrap();

        assert_eq!(first.id, second.id);
        assert_eq!(second.name, "Tandem", "existing row is returned unchanged");
    }

    /// Re-picking the same chat returns the same virtual row (no duplicates).
    #[tokio::test]
    async fn virtual_create_is_idempotent_by_path_and_session() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_test_pool(dir.path()).await;

        let first =
            ProjectRepository::create_project(&pool, "Chat A", PATH, "[]", true, Some("sess-a"))
                .await
                .unwrap();
        let second =
            ProjectRepository::create_project(&pool, "Chat A", PATH, "[]", true, Some("sess-a"))
                .await
                .unwrap();

        assert_eq!(first.id, second.id);
    }
}
