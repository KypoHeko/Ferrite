// Не открывать лишнее консольное окно в release-сборке
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod dsp;
mod player;
mod settings;
mod skins;
mod state;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use dsp::equalizer::EqState;
use dsp::fft::SpectrumBuffer;
use state::AppState;

fn main() {
    let eq = Arc::new(EqState::new());
    let spectrum = Arc::new(SpectrumBuffer::new());
    let (tx, rx) = mpsc::channel();
    let shutdown = Arc::new(AtomicBool::new(false));
    let sd_event = shutdown.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(AppState {
            tx: Mutex::new(tx),
            eq: eq.clone(),
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let player_handle = handle.clone();
            let spec_for_player = spectrum.clone();
            let sd = shutdown.clone();
            std::thread::spawn(move || player::run(rx, player_handle, eq, spec_for_player));
            std::thread::spawn(move || dsp::fft::run_fft(handle, spectrum, sd));
            Ok(())
        })
        .on_window_event(move |_window, event| {
            if matches!(
                event,
                tauri::WindowEvent::Destroyed | tauri::WindowEvent::CloseRequested { .. }
            ) {
                sd_event.store(true, Ordering::Relaxed);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::play,
            commands::pause,
            commands::resume,
            commands::stop,
            commands::seek,
            commands::set_volume,
            commands::eq_bands,
            commands::set_eq_gain,
            commands::set_eq_enabled,
            commands::reset_eq,
            skins::list_skins,
            skins::load_skin,
            skins::get_selected_skin,
            skins::set_selected_skin,
            skins::open_skins_dir,
            settings::load_settings,
            settings::save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("Ошибка при запуске Ferrite");
}
