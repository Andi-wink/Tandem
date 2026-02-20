use serde::{Deserialize, Serialize};

/// Persistent session state stored in .tandem/session.json
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeSessionState {
    pub meeting_id: String,
    pub session_id: Option<String>,
    pub project_dir: String,
}

/// A single stream event parsed from Claude CLI NDJSON output.
/// The Claude CLI `--output-format stream-json` emits one JSON object per line.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ClaudeStreamEvent {
    /// Initial system message with session info
    #[serde(rename = "system")]
    System {
        subtype: Option<String>,
        session_id: Option<String>,
        #[serde(flatten)]
        extra: serde_json::Value,
    },
    /// Assistant text or tool_use message
    #[serde(rename = "assistant")]
    Assistant {
        subtype: Option<String>,
        /// Present when subtype is "text"
        text: Option<String>,
        /// Present when subtype is "tool_use"
        tool: Option<ToolCallInfo>,
        #[serde(flatten)]
        extra: serde_json::Value,
    },
    /// Tool execution result
    #[serde(rename = "tool_result")]
    ToolResult {
        tool_name: Option<String>,
        content: Option<String>,
        #[serde(flatten)]
        extra: serde_json::Value,
    },
    /// Final result with session_id and cost
    #[serde(rename = "result")]
    Result {
        subtype: Option<String>,
        session_id: Option<String>,
        cost_usd: Option<f64>,
        duration_ms: Option<u64>,
        #[serde(flatten)]
        extra: serde_json::Value,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallInfo {
    pub name: Option<String>,
    pub input: Option<serde_json::Value>,
}

/// Event payload emitted to the frontend during streaming
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeFrontendEvent {
    pub event_type: String,       // "text_delta", "tool_call", "tool_result", "done", "error"
    pub text: Option<String>,
    pub tool_name: Option<String>,
    pub tool_input: Option<String>,
    pub tool_output: Option<String>,
    pub session_id: Option<String>,
    pub cost_usd: Option<f64>,
    pub meeting_id: String,
}
