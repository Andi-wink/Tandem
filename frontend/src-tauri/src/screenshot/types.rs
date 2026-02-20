use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureMode {
    Fullscreen,
    Region,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenshotData {
    pub id: String,
    pub file_path: String,
    pub thumbnail_base64: String,
    pub timestamp: String,
    pub recording_elapsed_secs: Option<f64>,
    pub width: u32,
    pub height: u32,
    pub capture_mode: CaptureMode,
}
