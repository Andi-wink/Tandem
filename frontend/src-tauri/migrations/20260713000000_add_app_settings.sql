-- Generic key-value app settings table.
-- Used for simple scalar preferences that don't warrant their own column on the
-- single-row `settings` table, e.g. `clients_root` (the folder whose direct
-- subfolders are offered as filing candidates for calls). Keyed by a text key.
CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);
