use log::{info, error};
use tauri::{AppHandle, Emitter, Runtime};

use super::session;
use super::types::{ClaudeFrontendEvent, ClaudeSessionState};

/// Start or resume a Claude session for a meeting.
/// If a session.json exists in the project dir, resumes it automatically.
#[tauri::command]
pub async fn start_claude_session<R: Runtime>(
    app: AppHandle<R>,
    meeting_id: String,
    meeting_title: String,
    project_dir: String,
    context_block: Option<String>,
    message: String,
) -> Result<(), String> {
    info!(
        "start_claude_session: meeting={}, project_dir={}, has_context={}",
        meeting_id,
        project_dir,
        context_block.is_some()
    );

    // Verify claude CLI is available
    session::check_claude_cli()?;

    // Ensure project directory exists
    std::fs::create_dir_all(&project_dir)
        .map_err(|e| format!("Failed to create project dir: {}", e))?;

    // Ensure .tandem directory exists
    let tandem_dir = std::path::Path::new(&project_dir).join(".tandem");
    std::fs::create_dir_all(&tandem_dir)
        .map_err(|e| format!("Failed to create .tandem dir: {}", e))?;

    // Generate CLAUDE.md on first call
    session::generate_claude_md(&meeting_id, &meeting_title, &project_dir)?;

    // Check for existing session
    let existing = session::load_session_json(&project_dir)?;
    let resume_id = existing.and_then(|s| s.session_id);

    if resume_id.is_some() {
        info!("Resuming existing session for meeting {}", meeting_id);
    }

    // Assemble the full message with context block
    let full_message = match context_block {
        Some(ctx) if !ctx.is_empty() => format!(
            "<context>\n{}\n</context>\n\n{}",
            ctx, message
        ),
        _ => message,
    };

    // Emit session ready event
    let _ = app.emit("claude-session-ready", serde_json::json!({
        "meeting_id": meeting_id,
        "project_dir": project_dir,
        "resuming": resume_id.is_some(),
    }));

    // Run the Claude CLI in a spawned task
    let app_clone = app.clone();
    let meeting_id_clone = meeting_id.clone();
    let project_dir_clone = project_dir.clone();

    tokio::spawn(async move {
        match session::run_claude_session(
            &app_clone,
            &meeting_id_clone,
            &project_dir_clone,
            &full_message,
            resume_id.as_deref(),
        )
        .await
        {
            Ok(session_id) => {
                // Save session state
                let state = ClaudeSessionState {
                    meeting_id: meeting_id_clone.clone(),
                    session_id: session_id.clone(),
                    project_dir: project_dir_clone,
                };
                if let Err(e) = session::save_session_json(&state) {
                    error!("Failed to save session state: {}", e);
                }
                info!(
                    "Claude session completed for meeting {}, session_id={:?}",
                    meeting_id_clone, session_id
                );
            }
            Err(e) => {
                error!("Claude session failed for meeting {}: {}", meeting_id_clone, e);
                let _ = app_clone.emit(
                    "claude-stream-event",
                    ClaudeFrontendEvent {
                        event_type: "error".to_string(),
                        text: Some(e),
                        tool_name: None,
                        tool_input: None,
                        tool_output: None,
                        session_id: None,
                        cost_usd: None,
                        meeting_id: meeting_id_clone,
                    },
                );
            }
        }
    });

    Ok(())
}

/// Send a message to an existing Claude session.
/// Loads session_id from .tandem/session.json and resumes.
#[tauri::command]
pub async fn send_claude_message<R: Runtime>(
    app: AppHandle<R>,
    meeting_id: String,
    project_dir: String,
    context_block: Option<String>,
    message: String,
) -> Result<(), String> {
    info!(
        "send_claude_message: meeting={}, has_context={}",
        meeting_id,
        context_block.is_some()
    );

    // Load existing session
    let existing = session::load_session_json(&project_dir)?
        .ok_or("No existing session found. Call start_claude_session first.")?;

    let session_id = existing
        .session_id
        .ok_or("Session exists but has no session_id")?;

    // Assemble the full message with context block
    let full_message = match context_block {
        Some(ctx) if !ctx.is_empty() => format!(
            "<context>\n{}\n</context>\n\n{}",
            ctx, message
        ),
        _ => message,
    };

    let app_clone = app.clone();
    let meeting_id_clone = meeting_id.clone();
    let project_dir_clone = project_dir.clone();

    tokio::spawn(async move {
        match session::run_claude_session(
            &app_clone,
            &meeting_id_clone,
            &project_dir_clone,
            &full_message,
            Some(&session_id),
        )
        .await
        {
            Ok(new_session_id) => {
                // Update session state with potentially new session_id
                let state = ClaudeSessionState {
                    meeting_id: meeting_id_clone.clone(),
                    session_id: new_session_id.or(Some(session_id)),
                    project_dir: project_dir_clone,
                };
                if let Err(e) = session::save_session_json(&state) {
                    error!("Failed to save session state: {}", e);
                }
            }
            Err(e) => {
                error!("Claude message failed: {}", e);
                let _ = app_clone.emit(
                    "claude-stream-event",
                    ClaudeFrontendEvent {
                        event_type: "error".to_string(),
                        text: Some(e),
                        tool_name: None,
                        tool_input: None,
                        tool_output: None,
                        session_id: None,
                        cost_usd: None,
                        meeting_id: meeting_id_clone,
                    },
                );
            }
        }
    });

    Ok(())
}

/// Get the current Claude session state for a meeting
#[tauri::command]
pub async fn get_claude_session(
    project_dir: String,
) -> Result<Option<ClaudeSessionState>, String> {
    session::load_session_json(&project_dir)
}

/// Clear the Claude session for a meeting
#[tauri::command]
pub async fn clear_claude_session(project_dir: String) -> Result<(), String> {
    session::clear_session_json(&project_dir)
}

/// Check if the claude CLI is available
#[tauri::command]
pub async fn check_claude_cli_available() -> Result<bool, String> {
    Ok(session::check_claude_cli().is_ok())
}
