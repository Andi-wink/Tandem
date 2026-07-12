//! Read-only calendar (ICS) fetch.
//!
//! Privacy-first, no OAuth: the user pastes a published ICS subscription URL
//! (Outlook "Publish calendar", Google secret ICS, Proton share link) once in
//! Settings. We fetch the raw ICS text here in Rust (reqwest, no browser fetch,
//! so no CORS) and hand it to the frontend, which parses it locally. Nothing
//! calendar-related ever leaves the machine.
//!
//! The ICS URL embeds a bearer token, so it is treated as a secret: we never
//! log or echo the full URL. Only the host is logged.

use crate::database::repositories::setting::SettingsRepository;
use crate::state::AppState;
use log::{error as log_error, info as log_info};

/// Max ICS body we will read (5 MB). A published calendar feed is well under this.
const MAX_ICS_BYTES: usize = 5 * 1024 * 1024;

/// Redact a URL down to its host for safe logging (never leak the token path/query).
fn safe_host(url: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(u) => u.host_str().map(|h| h.to_string()).unwrap_or_else(|| "<no-host>".into()),
        Err(_) => "<unparseable-url>".into(),
    }
}

/// Normalize a user-provided calendar URL:
/// - rewrite a leading `webcal://` (Outlook/Apple subscribe scheme) to `https://`
/// - require the result to be `https://` (reject http/file/etc.)
fn normalize_ics_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("No calendar URL configured".to_string());
    }

    let rewritten = if let Some(rest) = trimmed.strip_prefix("webcal://") {
        format!("https://{}", rest)
    } else if let Some(rest) = trimmed.strip_prefix("webcals://") {
        format!("https://{}", rest)
    } else {
        trimmed.to_string()
    };

    if !rewritten.starts_with("https://") {
        return Err(
            "Calendar URL must start with https:// or webcal:// (http and local files are not allowed)"
                .to_string(),
        );
    }

    Ok(rewritten)
}

/// Fetch the raw ICS text for the given URL, or the stored URL when `url` is None.
///
/// Passing `url` explicitly powers the Settings "Test connection" button without
/// having to save first. Parsing lives in the frontend (`lib/ics.ts`).
#[tauri::command]
pub async fn fetch_calendar_ics(
    state: tauri::State<'_, AppState>,
    url: Option<String>,
) -> Result<String, String> {
    // Resolve the URL: explicit arg wins, else the stored config.
    let raw_url = match url {
        Some(u) if !u.trim().is_empty() => u,
        _ => {
            let config = SettingsRepository::get_calendar_config(state.db_manager.pool())
                .await
                .map_err(|e| {
                    log_error!("Failed to read calendar config: {}", e);
                    "Could not read the saved calendar configuration".to_string()
                })?;
            config
                .ics_url
                .filter(|u| !u.trim().is_empty())
                .ok_or_else(|| "No calendar URL configured".to_string())?
        }
    };

    let fetch_url = normalize_ics_url(&raw_url)?;
    log_info!("Fetching calendar ICS from host: {}", safe_host(&fetch_url));

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("Tandem/1.0 (calendar)")
        .build()
        .map_err(|e| {
            log_error!("Failed to build HTTP client: {}", e);
            "Internal error building the network client".to_string()
        })?;

    let resp = client.get(&fetch_url).send().await.map_err(|e| {
        // Never echo the URL (token). Log host only; give the user a clean message.
        log_error!(
            "Calendar fetch failed for host {}: {}",
            safe_host(&fetch_url),
            e
        );
        if e.is_timeout() {
            "The calendar server did not respond in time. Check your connection and try again."
                .to_string()
        } else {
            "Could not reach the calendar. Check the URL is correct and the calendar is published."
                .to_string()
        }
    })?;

    if !resp.status().is_success() {
        let status = resp.status();
        log_error!(
            "Calendar fetch returned {} for host {}",
            status,
            safe_host(&fetch_url)
        );
        return Err(format!(
            "The calendar URL returned an error ({}). Double-check the link and that the calendar is still published.",
            status.as_u16()
        ));
    }

    let bytes = resp.bytes().await.map_err(|e| {
        log_error!(
            "Failed reading calendar body from host {}: {}",
            safe_host(&fetch_url),
            e
        );
        "The calendar response could not be read.".to_string()
    })?;

    if bytes.len() > MAX_ICS_BYTES {
        return Err("The calendar feed is unexpectedly large and was not loaded.".to_string());
    }

    // ICS is UTF-8 (RFC 5545). Be lenient about invalid bytes rather than failing.
    let text = String::from_utf8_lossy(&bytes).to_string();

    if !text.contains("BEGIN:VCALENDAR") {
        return Err(
            "That URL did not return a calendar feed. Make sure it is a published ICS link, not the calendar's web page."
                .to_string(),
        );
    }

    log_info!(
        "Fetched calendar ICS ({} bytes) from host {}",
        bytes.len(),
        safe_host(&fetch_url)
    );
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_rewrites_webcal() {
        assert_eq!(
            normalize_ics_url("webcal://example.com/cal.ics").unwrap(),
            "https://example.com/cal.ics"
        );
        assert_eq!(
            normalize_ics_url("webcals://example.com/cal.ics").unwrap(),
            "https://example.com/cal.ics"
        );
    }

    #[test]
    fn test_normalize_accepts_https_and_trims() {
        assert_eq!(
            normalize_ics_url("  https://example.com/cal.ics  ").unwrap(),
            "https://example.com/cal.ics"
        );
    }

    #[test]
    fn test_normalize_rejects_http_and_file() {
        assert!(normalize_ics_url("http://example.com/cal.ics").is_err());
        assert!(normalize_ics_url("file:///etc/passwd").is_err());
        assert!(normalize_ics_url("").is_err());
    }

    #[test]
    fn test_safe_host_hides_token() {
        let h = safe_host("https://outlook.office365.com/owa/calendar/abc-secret-token/cal.ics");
        assert_eq!(h, "outlook.office365.com");
        assert!(!h.contains("secret"));
    }
}
