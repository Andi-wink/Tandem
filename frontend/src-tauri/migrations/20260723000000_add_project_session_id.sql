-- F061: virtual sub-projects keyed by chat session.
--
-- A project row gains an optional `session_id` (nullable TEXT). A row with a
-- session_id is a "virtual sub-project": same folder path as a plain project,
-- but its identity is (path, session_id) and it files under
-- `<path>/.tandem/sessions/<session_id>/`. A plain folder project has a NULL
-- session_id and may coexist with any number of virtual sub-projects at the
-- same path.
--
-- The original `projects` table declared `path TEXT NOT NULL UNIQUE`, which
-- forbids two rows sharing a path. SQLite cannot drop a column-level UNIQUE
-- constraint in place, so we rebuild the table without it and instead enforce
-- uniqueness over (path, session_id) via an expression index. COALESCE maps a
-- NULL session_id to '' so that at most one plain project exists per path while
-- virtual sub-projects remain distinct per session_id.

CREATE TABLE projects_new (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    aliases TEXT DEFAULT '[]',
    auto_discovered INTEGER DEFAULT 0,
    session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO projects_new (id, name, path, aliases, auto_discovered, created_at, updated_at)
    SELECT id, name, path, aliases, auto_discovered, created_at, updated_at FROM projects;

DROP TABLE projects;

ALTER TABLE projects_new RENAME TO projects;

CREATE UNIQUE INDEX ux_projects_path_session
    ON projects (path, COALESCE(session_id, ''));
