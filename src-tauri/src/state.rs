use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

use crate::dsp::equalizer::EqState;

// Команды, отправляемые в аудиопоток
pub enum PlayerCommand {
    Play(String),
    Pause,
    Resume,
    Stop,
    Seek(f64),
    SetVolume(f32),
}

// Состояние приложения, доступное во всех командах Tauri
pub struct AppState {
    pub tx: Mutex<Sender<PlayerCommand>>,
    pub eq: Arc<EqState>,
}