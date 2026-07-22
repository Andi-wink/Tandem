-- Calendar (read-only ICS) settings.
-- Own table so the secret-ish ICS subscription URL (it embeds a bearer token)
-- stays isolated from the main settings row. Single-row upsert keyed on id='1',
-- mirroring the settings/transcript_settings idiom.
CREATE TABLE IF NOT EXISTS calendar_settings (
    id TEXT PRIMARY KEY DEFAULT '1',
    ics_url TEXT,
    refresh_minutes INTEGER NOT NULL DEFAULT 15
);
