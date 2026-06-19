use tauri::State;

use crate::dsp::equalizer::BAND_FREQS;
use crate::state::{AppState, PlayerCommand};

fn send(state: &State<AppState>, cmd: PlayerCommand) -> Result<(), String> {
    state
        .tx
        .lock()
        .map_err(|e| e.to_string())?
        .send(cmd)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn play(path: String, state: State<AppState>) -> Result<(), String> {
    send(&state, PlayerCommand::Play(path))
}

#[tauri::command]
pub fn pause(state: State<AppState>) -> Result<(), String> {
    send(&state, PlayerCommand::Pause)
}

#[tauri::command]
pub fn resume(state: State<AppState>) -> Result<(), String> {
    send(&state, PlayerCommand::Resume)
}

#[tauri::command]
pub fn stop(state: State<AppState>) -> Result<(), String> {
    send(&state, PlayerCommand::Stop)
}

#[tauri::command]
pub fn seek(position: f64, state: State<AppState>) -> Result<(), String> {
    send(&state, PlayerCommand::Seek(position))
}

#[tauri::command]
pub fn set_volume(level: f32, state: State<AppState>) -> Result<(), String> {
    send(&state, PlayerCommand::SetVolume(level))
}

#[tauri::command]
pub fn eq_bands() -> Vec<f32> {
    BAND_FREQS.to_vec()
}

#[tauri::command]
pub fn set_eq_gain(band: usize, db: f32, state: State<AppState>) -> Result<(), String> {
    state.eq.set_gain(band, db);
    Ok(())
}

#[tauri::command]
pub fn set_eq_enabled(enabled: bool, state: State<AppState>) -> Result<(), String> {
    state.eq.set_enabled(enabled);
    Ok(())
}

#[tauri::command]
pub fn reset_eq(state: State<AppState>) -> Result<(), String> {
    state.eq.reset();
    Ok(())
}