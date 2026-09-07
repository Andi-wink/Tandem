-- F056: Custom Transcription Dictionary
--
-- User-editable list of terms that speech-to-text keeps getting wrong.
-- `aliases` is a JSON array of the mistranscriptions to rewrite into `term`
-- (e.g. term "n8n", aliases ["n eight n", "innate", "N8 N"]).
-- Terms feed two paths: the Whisper initial_prompt bias, and a deterministic
-- provider-agnostic post-correction pass over every transcript segment.
CREATE TABLE IF NOT EXISTS custom_dictionary (
    id TEXT PRIMARY KEY,
    term TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_custom_dictionary_enabled ON custom_dictionary (enabled);
