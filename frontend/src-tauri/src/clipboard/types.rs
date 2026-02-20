use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ClipboardContentType {
    Text,
    Image,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipboardData {
    pub id: String,
    pub content_type: ClipboardContentType,
    pub text: Option<String>,
    pub file_path: Option<String>,
    pub thumbnail_base64: Option<String>,
    pub timestamp: String,
    pub recording_elapsed_secs: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}
