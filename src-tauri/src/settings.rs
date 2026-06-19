use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

// Single UI state file (panel visibility, size, EQ preset, playlist) in app_config_dir —
// same file-based approach as skins. The schema is owned by the frontend (store.js);
// Rust reads and writes the JSON as-is.

const MAX_SETTINGS_BYTES: usize = 8 * 1024 * 1024;

fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("settings.json"))
}

fn read_nonempty(path: PathBuf) -> Option<String> {
    fs::read_to_string(path).ok().filter(|s| !s.trim().is_empty())
}

#[tauri::command]
pub fn load_settings(app: AppHandle) -> String {
    let new_path = settings_file(&app).ok();
    // one-time migration: fall back to the old state.json if settings.json doesn't exist
    let old_path = app.path().app_config_dir().ok().map(|d| d.join("state.json"));
    new_path
        .and_then(read_nonempty)
        .or_else(|| old_path.and_then(read_nonempty))
        .unwrap_or_else(|| "{}".into())
}

#[tauri::command]
pub fn save_settings(app: AppHandle, json: String) -> Result<(), String> {
    if json.len() > MAX_SETTINGS_BYTES {
        return Err("settings too large".into());
    }
    // reject garbage — a corrupt file would break state on the next launch
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| format!("invalid JSON: {e}"))?;
    let path = settings_file(&app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(path, json).map_err(|e| e.to_string())
}
