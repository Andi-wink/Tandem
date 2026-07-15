//! Global quick-capture: a small frameless always-on-top bar (Alt+Shift+N) that turns
//! whatever is on the clipboard, plus an optional note, into a dated note filed under the
//! right project's `.tandem/notes` folder.
//!
//! Tandem keeps its OWN rolling history of the last few *text* clipboard items in memory
//! (Windows only exposes the current clipboard item to apps; Win+V history is off-limits).
//! The buffer is memory-only, capped, and cleared the moment the feature is toggled off:
//! it is never written to disk or sent anywhere except the note file / AI panel on an
//! explicit user action. Image clips are out of scope this pass (text only).

pub mod commands;

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use uuid::Uuid;

/// Fixed window label for the quick-capture bar.
pub const QUICK_CAPTURE_WINDOW_LABEL: &str = "quick-capture";

/// Max text items kept in the rolling clipboard buffer. Mirrors CLIP_BUFFER_CAP in the
/// frontend's quickCapture.ts (both implement the same cap + consecutive-dupe collapse).
const CLIP_BUFFER_CAP: usize = 3;

/// A single buffered clipboard text item.
#[derive(Debug, Clone, Serialize)]
pub struct Clip {
    pub id: String,
    pub text: String,
}

/// Shared, memory-only state for the quick-capture feature. Managed as `Arc<QuickCaptureState>`
/// so the clipboard watcher, the global-shortcut handler, and the Tauri commands can all reach
/// the same buffer + enabled flag.
pub struct QuickCaptureState {
    enabled: AtomicBool,
    /// Front = most recent. Never persisted.
    buffer: Mutex<VecDeque<Clip>>,
}

impl Default for QuickCaptureState {
    fn default() -> Self {
        Self::new()
    }
}

impl QuickCaptureState {
    pub fn new() -> Self {
        Self {
            // Fail-closed at process start: the watcher stays idle until the main window
            // explicitly syncs the saved preference (QuickCaptureListener calls
            // set_quick_capture_enabled on mount). The user-facing default is still ON
            // (the frontend enables when the preference is unset), but a user who disabled
            // Quick Capture is guaranteed it never records for the boot window before that
            // async sync lands. Privacy invariant: a saved "off" is honored from the first
            // clipboard poll, not just after React hydrates.
            enabled: AtomicBool::new(false),
            buffer: Mutex::new(VecDeque::new()),
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    /// Flip the feature on/off. Turning it off clears the rolling buffer immediately so no
    /// copied text lingers in memory once the user opts out.
    pub fn set_enabled(&self, value: bool) {
        self.enabled.store(value, Ordering::Relaxed);
        if !value {
            if let Ok(mut buf) = self.buffer.lock() {
                buf.clear();
            }
        }
    }

    /// Roll a freshly observed clipboard text into the buffer. A consecutive duplicate (the
    /// same text as the most recent item) is a no-op, so repeated polls of an unchanged
    /// clipboard never grow the buffer. Capped at CLIP_BUFFER_CAP (oldest dropped).
    pub fn push_text(&self, text: String) {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return;
        }
        let Ok(mut buf) = self.buffer.lock() else {
            return;
        };
        if let Some(front) = buf.front() {
            if front.text == trimmed {
                return; // consecutive dupe
            }
        }
        buf.push_front(Clip {
            id: Uuid::new_v4().to_string(),
            text: trimmed.to_string(),
        });
        while buf.len() > CLIP_BUFFER_CAP {
            buf.pop_back();
        }
    }

    /// Snapshot of the current buffer, most recent first.
    pub fn clips(&self) -> Vec<Clip> {
        self.buffer
            .lock()
            .map(|buf| buf.iter().cloned().collect())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_collapses_consecutive_dupes_and_caps() {
        let s = QuickCaptureState::new();
        s.push_text("one".into());
        s.push_text("one".into()); // consecutive dupe
        assert_eq!(s.clips().len(), 1);
        s.push_text("two".into());
        s.push_text("three".into());
        s.push_text("four".into()); // exceeds cap of 3
        let texts: Vec<String> = s.clips().into_iter().map(|c| c.text).collect();
        assert_eq!(texts, vec!["four", "three", "two"]);
    }

    #[test]
    fn disabling_clears_the_buffer() {
        let s = QuickCaptureState::new();
        s.push_text("secret".into());
        assert_eq!(s.clips().len(), 1);
        s.set_enabled(false);
        assert!(s.clips().is_empty());
        assert!(!s.enabled());
    }

    #[test]
    fn ignores_blank_text() {
        let s = QuickCaptureState::new();
        s.push_text("   ".into());
        assert!(s.clips().is_empty());
    }

    #[test]
    fn defaults_disabled_until_synced() {
        // Fail-closed: the watcher must not treat the feature as on until the frontend
        // syncs the saved preference, so a user who disabled Quick Capture never has it
        // record during the boot window.
        let s = QuickCaptureState::new();
        assert!(!s.enabled());
        s.set_enabled(true);
        assert!(s.enabled());
    }
}
