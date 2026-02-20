use std::path::{Path, PathBuf};
use log::{info, error, warn};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tauri::{AppHandle, Emitter, Runtime};

use super::types::{ClaudeFrontendEvent, ClaudeSessionState, ClaudeStreamEvent};

const SESSION_FILE: &str = ".tandem/session.json";

/// Save session state to .tandem/session.json in the project directory
pub fn save_session_json(state: &ClaudeSessionState) -> Result<(), String> {
    let tandem_dir = Path::new(&state.project_dir).join(".tandem");
    std::fs::create_dir_all(&tandem_dir)
        .map_err(|e| format!("Failed to create .tandem dir: {}", e))?;

    let path = tandem_dir.join("session.json");
    let json = serde_json::to_string_pretty(state)
        .map_err(|e| format!("Failed to serialize session: {}", e))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write session.json: {}", e))?;

    info!("Saved session.json to {:?}", path);
    Ok(())
}

/// Load session state from .tandem/session.json in the project directory
pub fn load_session_json(project_dir: &str) -> Result<Option<ClaudeSessionState>, String> {
    let path = Path::new(project_dir).join(SESSION_FILE);
    if !path.exists() {
        return Ok(None);
    }

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read session.json: {}", e))?;
    let state: ClaudeSessionState = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse session.json: {}", e))?;

    info!("Loaded session from {:?}, session_id={:?}", path, state.session_id);
    Ok(Some(state))
}

/// Delete session.json to clear the session
pub fn clear_session_json(project_dir: &str) -> Result<(), String> {
    let path = Path::new(project_dir).join(SESSION_FILE);
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to remove session.json: {}", e))?;
        info!("Cleared session.json at {:?}", path);
    }
    Ok(())
}

/// Generate a CLAUDE.md file for the meeting project directory
pub fn generate_claude_md(
    meeting_id: &str,
    meeting_title: &str,
    project_dir: &str,
) -> Result<(), String> {
    let claude_md_path = Path::new(project_dir).join("CLAUDE.md");

    // Don't overwrite if it already exists
    if claude_md_path.exists() {
        info!("CLAUDE.md already exists at {:?}, skipping generation", claude_md_path);
        return Ok(());
    }

    let content = format!(
r#"# Meeting Context

## Meeting: {}
Meeting ID: {}

## Available Files
- `transcript.json` — Full meeting transcript with timestamps
- `screenshots/` — Screenshots captured during the meeting
- `clipboard.json` — Clipboard captures during the meeting

## Your Role
You are an AI assistant helping analyze this discovery call / meeting.
You have access to the transcript, screenshots, and clipboard captures.
When the user shares context from the meeting, use it to provide insights,
answer questions, and help with follow-up actions.

## Guidelines
- Reference specific parts of the transcript when answering questions
- Be concise and actionable in your responses
- Flag any action items, decisions, or commitments mentioned
- When discussing people, use the names as they appear in the transcript
"#,
        meeting_title, meeting_id
    );

    std::fs::write(&claude_md_path, content)
        .map_err(|e| format!("Failed to write CLAUDE.md: {}", e))?;

    info!("Generated CLAUDE.md at {:?}", claude_md_path);
    Ok(())
}

/// Check if the `claude` CLI is available on PATH
pub fn check_claude_cli() -> Result<PathBuf, String> {
    which::which("claude").map_err(|_| {
        "Claude CLI not found on PATH. Install it with: npm install -g @anthropic-ai/claude-code".to_string()
    })
}

/// Spawn the Claude CLI process and stream events to the frontend.
///
/// For a new session: `claude -p '<message>' --output-format stream-json`
/// For a resumed session: `claude --resume <id> -p '<message>' --output-format stream-json`
pub async fn run_claude_session<R: Runtime>(
    app: &AppHandle<R>,
    meeting_id: &str,
    project_dir: &str,
    message: &str,
    session_id: Option<&str>,
) -> Result<Option<String>, String> {
    // Verify CLI exists
    let claude_path = check_claude_cli()?;
    info!("Using claude CLI at: {:?}", claude_path);

    let mut cmd = Command::new(claude_path);
    cmd.current_dir(project_dir);
    cmd.arg("-p").arg(message);
    cmd.arg("--output-format").arg("stream-json");

    if let Some(sid) = session_id {
        cmd.arg("--resume").arg(sid);
        info!("Resuming session {} for meeting {}", sid, meeting_id);
    } else {
        info!("Starting new session for meeting {}", meeting_id);
    }

    // Pipe stdout for streaming, inherit stderr for debug
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn()
        .map_err(|e| format!("Failed to spawn claude process: {}", e))?;

    let stdout = child.stdout.take()
        .ok_or("Failed to capture claude stdout")?;

    let stderr = child.stderr.take();

    // Spawn stderr reader for logging
    if let Some(stderr) = stderr {
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    warn!("[claude stderr] {}", line);
                }
            }
        });
    }

    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();
    let mut captured_session_id: Option<String> = session_id.map(|s| s.to_string());

    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        // Try to parse as a known stream event
        match serde_json::from_str::<ClaudeStreamEvent>(&line) {
            Ok(event) => {
                match &event {
                    ClaudeStreamEvent::System { session_id: sid, .. } => {
                        if let Some(sid) = sid {
                            captured_session_id = Some(sid.clone());
                            emit_event(app, meeting_id, ClaudeFrontendEvent {
                                event_type: "session_init".to_string(),
                                session_id: Some(sid.clone()),
                                text: None,
                                tool_name: None,
                                tool_input: None,
                                tool_output: None,
                                cost_usd: None,
                                meeting_id: meeting_id.to_string(),
                            });
                        }
                    }
                    ClaudeStreamEvent::Assistant { subtype, text, tool, .. } => {
                        match subtype.as_deref() {
                            Some("text") => {
                                if let Some(t) = text {
                                    emit_event(app, meeting_id, ClaudeFrontendEvent {
                                        event_type: "text_delta".to_string(),
                                        text: Some(t.clone()),
                                        session_id: captured_session_id.clone(),
                                        tool_name: None,
                                        tool_input: None,
                                        tool_output: None,
                                        cost_usd: None,
                                        meeting_id: meeting_id.to_string(),
                                    });
                                }
                            }
                            Some("tool_use") => {
                                if let Some(tc) = tool {
                                    emit_event(app, meeting_id, ClaudeFrontendEvent {
                                        event_type: "tool_call".to_string(),
                                        text: None,
                                        tool_name: tc.name.clone(),
                                        tool_input: tc.input.as_ref().map(|v| v.to_string()),
                                        tool_output: None,
                                        session_id: captured_session_id.clone(),
                                        cost_usd: None,
                                        meeting_id: meeting_id.to_string(),
                                    });
                                }
                            }
                            _ => {}
                        }
                    }
                    ClaudeStreamEvent::ToolResult { tool_name, content, .. } => {
                        emit_event(app, meeting_id, ClaudeFrontendEvent {
                            event_type: "tool_result".to_string(),
                            text: None,
                            tool_name: tool_name.clone(),
                            tool_input: None,
                            tool_output: content.clone(),
                            session_id: captured_session_id.clone(),
                            cost_usd: None,
                            meeting_id: meeting_id.to_string(),
                        });
                    }
                    ClaudeStreamEvent::Result { session_id: sid, cost_usd, .. } => {
                        if let Some(sid) = sid {
                            captured_session_id = Some(sid.clone());
                        }
                        emit_event(app, meeting_id, ClaudeFrontendEvent {
                            event_type: "done".to_string(),
                            text: None,
                            tool_name: None,
                            tool_input: None,
                            tool_output: None,
                            session_id: captured_session_id.clone(),
                            cost_usd: *cost_usd,
                            meeting_id: meeting_id.to_string(),
                        });
                    }
                }
            }
            Err(_) => {
                // Try parsing as a generic JSON object to extract any text
                if let Ok(obj) = serde_json::from_str::<serde_json::Value>(&line) {
                    // Handle unrecognized event types gracefully
                    if let Some(t) = obj.get("type").and_then(|v| v.as_str()) {
                        info!("Unhandled claude stream event type: {}", t);
                    }
                    // Check for session_id in any event
                    if let Some(sid) = obj.get("session_id").and_then(|v| v.as_str()) {
                        if captured_session_id.is_none() {
                            captured_session_id = Some(sid.to_string());
                        }
                    }
                }
            }
        }
    }

    // Wait for child process to finish
    let status = child.wait().await
        .map_err(|e| format!("Failed to wait for claude process: {}", e))?;

    if !status.success() {
        let code = status.code().unwrap_or(-1);
        error!("Claude process exited with code {}", code);
        emit_event(app, meeting_id, ClaudeFrontendEvent {
            event_type: "error".to_string(),
            text: Some(format!("Claude process exited with code {}", code)),
            tool_name: None,
            tool_input: None,
            tool_output: None,
            session_id: captured_session_id.clone(),
            cost_usd: None,
            meeting_id: meeting_id.to_string(),
        });
    }

    Ok(captured_session_id)
}

fn emit_event<R: Runtime>(app: &AppHandle<R>, _meeting_id: &str, event: ClaudeFrontendEvent) {
    if let Err(e) = app.emit("claude-stream-event", &event) {
        error!("Failed to emit claude stream event: {}", e);
    }
}
