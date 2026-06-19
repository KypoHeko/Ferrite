use std::fs::File;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::Duration;

use rodio::source::Source;
use rodio::{Decoder, OutputStreamBuilder, Sink};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::dsp::equalizer::{EqState, Equalizer};
use crate::dsp::fft::{SpectrumBuffer, SpectrumTap};
use crate::state::PlayerCommand;

#[derive(Clone, Serialize)]
struct Progress {
    position: f64,
    duration: Option<f64>,
    paused: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackInfo {
    sample_rate: u32,
    channels: u16,
    kbps: Option<u32>,
}

#[derive(Clone, Serialize)]
struct TrackError {
    path: String,
    reason: String,
}

pub fn run(
    rx: Receiver<PlayerCommand>,
    app: AppHandle,
    eq: Arc<EqState>,
    spectrum: Arc<SpectrumBuffer>,
) {
    let stream = match OutputStreamBuilder::open_default_stream() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[ferrite] failed to open audio output: {e}");
            return;
        }
    };

    let mut sink = Sink::connect_new(stream.mixer());
    let mut volume: f32 = 1.0;
    let mut duration: Option<f64> = None;
    let mut active = false;
    let mut paused = false;

    let tick = Duration::from_millis(200);

    loop {
        match rx.recv_timeout(tick) {
            Ok(cmd) => match cmd {
                PlayerCommand::Play(path) => {
                    let file = match File::open(&path) {
                        Ok(f) => f,
                        Err(e) => { 
                            eprintln!("[ferrite] open {path}: {e}"); 
                            let _ = app.emit("trackerror", TrackError { path, reason: e.to_string() });
                            continue; 
                        }
                    };
                    // file size — used to estimate average bitrate
                    let file_size = file.metadata().ok().map(|m| m.len());

                    let source = match Decoder::try_from(file) {
                        Ok(s) => s,
                        Err(e) => { 
                            eprintln!("[ferrite] decode {path}: {e}"); 
                            let _ = app.emit("trackerror", TrackError { path, reason: e.to_string() });
                            continue; 
                        }
                    };

                    let sample_rate = source.sample_rate();
                    let channels = source.channels();
                    duration = source.total_duration().map(|d| d.as_secs_f64());

                    // average bitrate = size(bytes) * 8 / duration(s) / 1000
                    let kbps = match (file_size, duration) {
                        (Some(bytes), Some(dur)) if dur > 0.0 =>
                            Some((bytes as f64 * 8.0 / dur / 1000.0).round() as u32),
                        _ => None,
                    };
                    let _ = app.emit("trackinfo", TrackInfo { sample_rate, channels, kbps });

                    // decoder -> equalizer -> spectrum tap -> sink
                    let eqd = Equalizer::new(source, eq.clone());
                    let tapped = SpectrumTap::new(eqd, spectrum.clone());

                    sink.stop();
                    sink = Sink::connect_new(stream.mixer());
                    sink.set_volume(volume);
                    sink.append(tapped);
                    sink.play();
                    active = true;
                    paused = false;
                }
                PlayerCommand::Pause => {
                    sink.pause();
                    paused = true;
                }
                PlayerCommand::Resume => {
                    if active {
                        sink.play();
                        paused = false;
                    }
                }
                PlayerCommand::Stop => {
                    sink.pause();
                    let _ = sink.try_seek(Duration::ZERO);
                    paused = true;
                    emit_progress(&app, 0.0, duration, true);
                }
                PlayerCommand::Seek(secs) => {
                    let _ = sink.try_seek(Duration::from_secs_f64(secs));
                }
                PlayerCommand::SetVolume(v) => {
                    volume = v;
                    sink.set_volume(v);
                }
            },
            Err(RecvTimeoutError::Timeout) => {
                if active && !paused {
                    // sink.empty() is the authoritative end-of-track signal: the source
                    // queue has drained, meaning playback finished. More reliable than
                    // a hand-rolled heuristic:
                    //  * correctly catches even very short tracks (< one tick);
                    //  * no false positives — append keeps the count > 0 while audio
                    //    is actually playing, so the sink is never empty at track start.
                    if sink.empty() {
                        active = false;
                        let _ = app.emit("ended", ());
                    } else {
                        let raw = sink.get_pos().as_secs_f64();
                        let pos = duration.map_or(raw, |d| raw.min(d));
                        emit_progress(&app, pos, duration, paused);
                    }
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn emit_progress(app: &AppHandle, position: f64, duration: Option<f64>, paused: bool) {
    let _ = app.emit(
        "progress",
        Progress {
            position,
            duration,
            paused,
        },
    );
}
