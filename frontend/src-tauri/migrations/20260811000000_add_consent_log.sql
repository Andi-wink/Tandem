-- Consent log for recorded calls.
--
-- Why this exists: recording a call in Germany, Greece, Portugal, Switzerland and several other
-- jurisdictions is a criminal offence without the consent of every participant (e.g. § 201 Abs. 1
-- Nr. 1 StGB, up to three years). Consent must exist BEFORE capture starts; consent obtained
-- afterwards does not cure a completed offence. Separately, GDPR Art 7(1) accountability means the
-- consent must be provable, which a dismissible toast is not.
--
-- Until 2026-08-11 Tandem had no consent feature at all: the only artefact was a toast fired AFTER
-- recording had already begun, whose acknowledgement was never persisted.
--
-- One row per recording start. Rows are evidence and are never rewritten in place.
CREATE TABLE IF NOT EXISTS consent_log (
    id             TEXT PRIMARY KEY,
    -- Meeting this consent was granted for. Text rather than a FK: the meeting row may not exist
    -- yet at consent time (consent precedes capture, which precedes the meeting record), and the
    -- log must survive meeting deletion.
    meeting_title  TEXT,
    meeting_id     TEXT,
    -- RFC3339 UTC. When consent was obtained, which must precede recording_started_at.
    granted_at     TEXT NOT NULL,
    -- RFC3339 UTC, set when the gated recording actually started. NULL means consent was captured
    -- but recording never began (user cancelled, device error), which is itself worth keeping.
    recording_started_at TEXT,
    -- JSON array of participant names/roles as stated by the user.
    participants   TEXT NOT NULL DEFAULT '[]',
    -- How consent was obtained: 'verbal' (spoken yes on the call), 'written' (email/chat reply),
    -- 'prior_written' (engagement letter or calendar-invite notice accepted in advance).
    method         TEXT NOT NULL,
    -- ISO 3166-1 alpha-2 of the counterparty, e.g. 'DE'. Drives the all-party-consent warning.
    jurisdiction   TEXT,
    -- Transcription language and engine at the moment of consent. The engine matters legally:
    -- sending audio to a cloud vendor is a separate offence limb in several jurisdictions
    -- (e.g. § 201 Abs. 1 Nr. 2 StGB), so what the user consented to includes where it was sent.
    language       TEXT,
    engine         TEXT,
    -- 'local' or 'cloud', denormalised from engine so a later audit does not have to know which
    -- provider names were cloud in August 2026.
    processing     TEXT,
    notes          TEXT,
    created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consent_log_granted_at ON consent_log(granted_at DESC);
CREATE INDEX IF NOT EXISTS idx_consent_log_meeting_id ON consent_log(meeting_id);
