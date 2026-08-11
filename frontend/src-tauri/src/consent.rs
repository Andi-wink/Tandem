//! Pre-record consent gate.
//!
//! ## Why this is enforced in Rust rather than in the UI
//!
//! Recording is reachable from five places: the record button, the sidebar event, a calendar
//! seed, the global Alt+Shift+E shortcut and the tray menu. A modal in one React component
//! guards one of them. Putting the check inside `start_recording` means every path, present and
//! future, is covered by construction, and the failure mode of a forgotten wiring is "recording
//! refuses to start" rather than "recording starts without consent".
//!
//! ## The ordering that matters
//!
//! Consent must exist *before* capture begins. § 201 Abs. 1 Nr. 1 StGB is complete at the moment
//! of fixation, so consent obtained afterwards does not cure it, and deleting the audio does not
//! undo it. That is precisely the bug this replaces: the old flow awaited the backend start and
//! *then* showed a dismissible toast.
//!
//! ## How it works
//!
//! 1. The UI collects consent and calls `record_consent`, which writes a `consent_log` row and
//!    arms this gate with the returned id.
//! 2. `start_recording` calls `take_valid()`. A fresh, unconsumed grant lets the recording
//!    proceed; anything else returns `CONSENT_REQUIRED`.
//! 3. The grant is *consumed* on use, so one consent authorises exactly one recording.
//! 4. Grants expire after `GRANT_TTL`, so consent collected and then abandoned cannot silently
//!    authorise a recording started an hour later.

use std::sync::{LazyLock, Mutex as StdMutex};
use std::time::{Duration, Instant};

/// Error string returned by `start_recording` when the gate blocks it. The frontend matches on
/// this exact value to decide whether to open the consent modal, so do not reword it casually.
pub const CONSENT_REQUIRED: &str = "CONSENT_REQUIRED";

/// How long a consent grant stays usable. Long enough to cover "get the yes, then pick devices",
/// short enough that a forgotten grant does not authorise a later call.
const GRANT_TTL: Duration = Duration::from_secs(10 * 60);

/// app_settings key for the on/off switch.
const GATE_SETTING_KEY: &str = "consent_gate_enabled";

#[derive(Debug, Clone)]
pub struct ConsentGrant {
    /// `consent_log.id` of the row written when consent was captured.
    pub id: String,
    pub meeting_title: Option<String>,
    granted_at: Instant,
}

static PENDING_GRANT: LazyLock<StdMutex<Option<ConsentGrant>>> =
    LazyLock::new(|| StdMutex::new(None));

/// Arms the gate after a consent record has been persisted.
pub fn arm(id: String, meeting_title: Option<String>) {
    if let Ok(mut guard) = PENDING_GRANT.lock() {
        *guard = Some(ConsentGrant {
            id,
            meeting_title,
            granted_at: Instant::now(),
        });
    }
}

/// Consumes the pending grant if it is still fresh. Returns None when there is no grant or it
/// has expired, in which case the caller must refuse to start.
pub fn take_valid() -> Option<ConsentGrant> {
    let mut guard = PENDING_GRANT.lock().ok()?;
    match guard.take() {
        Some(grant) if grant.granted_at.elapsed() <= GRANT_TTL => Some(grant),
        Some(expired) => {
            log::warn!(
                "Consent grant {} expired after {:?}; recording will be blocked",
                expired.id,
                expired.granted_at.elapsed()
            );
            None
        }
        None => None,
    }
}

/// Drops any pending grant. Called when a start attempt fails, so a grant is not left armed for
/// a recording that never happened.
pub fn clear() {
    if let Ok(mut guard) = PENDING_GRANT.lock() {
        *guard = None;
    }
}

/// Whether the gate is switched on. Defaults to ON: a consent control that ships off is not a
/// control. Stored in `app_settings` so it survives restarts like every other preference.
pub async fn is_enabled(pool: &sqlx::SqlitePool) -> bool {
    let value: Result<Option<Option<String>>, _> =
        sqlx::query_scalar("SELECT value FROM app_settings WHERE key = $1 LIMIT 1")
            .bind(GATE_SETTING_KEY)
            .fetch_optional(pool)
            .await;

    match value {
        Ok(Some(Some(v))) => !matches!(v.trim().to_ascii_lowercase().as_str(), "false" | "0" | "off"),
        // Unset, NULL, or unreadable: default to enforcing.
        _ => true,
    }
}

/// Persists the on/off switch.
pub async fn set_enabled(
    pool: &sqlx::SqlitePool,
    enabled: bool,
) -> std::result::Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO app_settings (key, value)
        VALUES ($1, $2)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        "#,
    )
    .bind(GATE_SETTING_KEY)
    .bind(if enabled { "true" } else { "false" })
    .execute(pool)
    .await?;
    Ok(())
}

/// Jurisdictions where recording a call requires the consent of *every* participant, not just
/// notice. Used to escalate the wording in the consent dialog.
///
/// Sourced from the 2026-08-11 review of primary criminal-code texts. Recording-limb offences
/// only: Austria, Belgium, Spain and Denmark criminalise onward *disclosure* rather than the
/// recording itself and are handled by the local-processing recommendation instead.
pub const ALL_PARTY_CONSENT_JURISDICTIONS: &[(&str, &str)] = &[
    ("GR", "Greece: felony, up to 10 years, express consent required, prosecuted without a complaint"),
    ("DE", "Germany: § 201 Abs. 1 Nr. 1 StGB, up to 3 years. Being a participant is no defence"),
    ("PT", "Portugal: Art 199.º-1(a) CP, even where the words are addressed to you"),
    ("CH", "Switzerland: Art 179ter StGB, explicitly covers a participant recording"),
    ("FR", "France: Art 226-1 CP. Consent is presumed only if participants could object before capture"),
];

/// Returns the warning for a jurisdiction, if it is an all-party-consent one.
pub fn all_party_warning(jurisdiction: &str) -> Option<&'static str> {
    let code = jurisdiction.trim().to_ascii_uppercase();
    ALL_PARTY_CONSENT_JURISDICTIONS
        .iter()
        .find(|(c, _)| *c == code)
        .map(|(_, warning)| *warning)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grant_is_consumed_exactly_once() {
        clear();
        arm("consent-1".to_string(), Some("Call".to_string()));

        let first = take_valid();
        assert!(first.is_some(), "a fresh grant authorises the recording");
        assert_eq!(first.unwrap().id, "consent-1");

        // One consent authorises one recording; a second start must be blocked.
        assert!(
            take_valid().is_none(),
            "grant must not be reusable for a second recording"
        );
    }

    #[test]
    fn no_grant_means_blocked() {
        clear();
        assert!(take_valid().is_none());
    }

    #[test]
    fn clear_disarms_the_gate() {
        clear();
        arm("consent-2".to_string(), None);
        clear();
        assert!(take_valid().is_none(), "cleared grant must not authorise a start");
    }

    #[test]
    fn all_party_jurisdictions_are_flagged_case_insensitively() {
        assert!(all_party_warning("de").is_some());
        assert!(all_party_warning("DE").is_some());
        assert!(all_party_warning(" gr ").is_some());
        // The UK is notice-only for a participant recording their own call (IPA 2016 s.4(1)(b)).
        assert!(all_party_warning("GB").is_none());
        assert!(all_party_warning("US").is_none());
    }
}
