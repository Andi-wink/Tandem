use log::info;
use tauri::{AppHandle, Emitter, Manager};

use super::manager::DatabaseManager;
use crate::state::AppState;

/// Initialize database on app startup
/// Handles first launch detection and conditional initialization
pub async fn initialize_database_on_startup(app: &AppHandle) -> Result<(), String> {
    // Check if this is the first launch (no database exists yet)
    let is_first_launch = DatabaseManager::is_first_launch(app)
        .await
        .map_err(|e| format!("Failed to check first launch status: {}", e))?;

    if is_first_launch {
        info!("First launch detected - will notify window when ready");

        // Delay event emission to ensure window is ready and React listeners are registered
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            app_handle
                .emit("first-launch-detected", ())
                .expect("Failed to emit first-launch-detected event");
            info!("Emitted first-launch-detected after delay");
        });
    } else {
        // Normal flow - initialize database immediately
        let db_manager = DatabaseManager::new_from_app_handle(app)
            .await
            .map_err(|e| format!("Failed to initialize database manager: {}", e))?;

        app.manage(AppState { db_manager });

        // F056: prime the custom-dictionary snapshot before any recording can
        // start, so the first transcribed chunk of the session is already
        // corrected. A failure here is logged, not fatal: the dictionary is an
        // enhancement and the app must still start without it.
        if let Some(state) = app.try_state::<AppState>() {
            match crate::dictionary::cache::refresh(state.db_manager.pool()).await {
                Ok(count) => info!("F056: loaded {} custom dictionary entries", count),
                Err(e) => log::warn!("F056: failed to load custom dictionary: {}", e),
            }
        }

        info!("Database initialized successfully");
    }

    Ok(())
}
