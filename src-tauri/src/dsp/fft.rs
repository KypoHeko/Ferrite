use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rodio::source::{SeekError, Source};
use rustfft::num_complex::Complex;
use rustfft::FftPlanner;
use tauri::{AppHandle, Emitter};

pub const FFT_SIZE: usize = 2048;
pub const NUM_BARS: usize = 48;

const FREQ_MIN: f32 = 30.0;
const FREQ_MAX: f32 = 16000.0;
const DB_MIN: f32 = -65.0; // нижняя граница уровня (тише — пусто)
const DB_MAX: f32 = -10.0; // верхняя граница (громче — полный столбик)

const ATTACK: f32 = 0.6;
const DECAY: f32 = 0.15;

#[derive(Clone, serde::Serialize)]
struct Spectrum {
    bars: Vec<f32>,
}

struct Ring {
    data: Vec<f32>,
    pos: usize,
}

/// Общий буфер: щуп пишет моно-сэмплы, FFT-поток читает снимок.
pub struct SpectrumBuffer {
    ring: Mutex<Ring>,
    written: AtomicU64,
    sample_rate: AtomicU32,
}

impl SpectrumBuffer {
    pub fn new() -> Self {
        Self {
            ring: Mutex::new(Ring { data: vec![0.0; FFT_SIZE], pos: 0 }),
            written: AtomicU64::new(0),
            sample_rate: AtomicU32::new(44100),
        }
    }

    fn push_chunk(&self, chunk: &[f32]) {
        if let Ok(mut r) = self.ring.lock() {
            for &v in chunk {
                let p = r.pos;
                r.data[p] = v;
                r.pos = (p + 1) % FFT_SIZE;
            }
        }
        self.written.fetch_add(chunk.len() as u64, Ordering::Relaxed);
    }

    fn snapshot(&self, out: &mut [f32]) {
        if let Ok(r) = self.ring.lock() {
            let pos = r.pos;
            for (i, slot) in out.iter_mut().enumerate() {
                *slot = r.data[(pos + i) % FFT_SIZE]; // от старых к новым
            }
        }
    }
}

const FLUSH: usize = 64;

/// Источник-щуп: пропускает звук без изменений, попутно копит моно-сэмплы.
pub struct SpectrumTap<S> {
    inner: S,
    shared: Arc<SpectrumBuffer>,
    channels: usize,
    ch: usize,
    frame_sum: f32,
    local: Vec<f32>,
}

impl<S> SpectrumTap<S>
where
    S: Source<Item = f32>,
{
    pub fn new(inner: S, shared: Arc<SpectrumBuffer>) -> Self {
        let channels = inner.channels().max(1) as usize;
        shared.sample_rate.store(inner.sample_rate().max(1), Ordering::Relaxed);
        Self { inner, shared, channels, ch: 0, frame_sum: 0.0, local: Vec::with_capacity(FLUSH) }
    }
}

impl<S> Iterator for SpectrumTap<S>
where
    S: Source<Item = f32>,
{
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        let s = self.inner.next()?;
        self.frame_sum += s;
        self.ch += 1;
        if self.ch >= self.channels {
            self.local.push(self.frame_sum / self.channels as f32);
            self.frame_sum = 0.0;
            self.ch = 0;
            if self.local.len() >= FLUSH {
                self.shared.push_chunk(&self.local);
                self.local.clear();
            }
        }
        Some(s)
    }

    #[inline]
    fn size_hint(&self) -> (usize, Option<usize>) {
        self.inner.size_hint()
    }
}

impl<S> Source for SpectrumTap<S>
where
    S: Source<Item = f32>,
{
    #[inline]
    fn current_span_len(&self) -> Option<usize> { self.inner.current_span_len() }
    #[inline]
    fn channels(&self) -> u16 { self.inner.channels() }
    #[inline]
    fn sample_rate(&self) -> u32 { self.inner.sample_rate() }
    #[inline]
    fn total_duration(&self) -> Option<Duration> { self.inner.total_duration() }
    #[inline]
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        let r = self.inner.try_seek(pos);
        self.local.clear();   // не тащим недописанный кадр через перемотку
        self.frame_sum = 0.0;
        self.ch = 0;
        r
    }
}

/// Поток анализа: снимает буфер, считает FFT, шлёт событие "spectrum".
pub fn run_fft(app: AppHandle, shared: Arc<SpectrumBuffer>, shutdown: Arc<AtomicBool>) {
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);

    let window: Vec<f32> = (0..FFT_SIZE)
        .map(|n| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * n as f32 / (FFT_SIZE as f32 - 1.0)).cos())
        .collect();

    let mut samples = vec![0.0f32; FFT_SIZE];
    let mut buf = vec![Complex { re: 0.0f32, im: 0.0f32 }; FFT_SIZE];
    let mut smoothed = vec![0.0f32; NUM_BARS];

    let mut last_written = 0u64;
    let frame = Duration::from_millis(33); // ~30 кадров/с

    while !shutdown.load(Ordering::Relaxed) {
        std::thread::sleep(frame);

        let written = shared.written.load(Ordering::Relaxed);
        let has_new = written != last_written;
        last_written = written;

        let mut raw = [0.0f32; NUM_BARS];

        if has_new {
            shared.snapshot(&mut samples);
            let sr = shared.sample_rate.load(Ordering::Relaxed) as f32;

            for i in 0..FFT_SIZE {
                buf[i].re = samples[i] * window[i];
                buf[i].im = 0.0;
            }
            fft.process(&mut buf);

            let half = FFT_SIZE / 2;
            let bin_hz = sr / FFT_SIZE as f32;
            let norm = (FFT_SIZE as f32 / 2.0) * 0.5; // длина/2 * усиление окна Хэнна

            for b in 0..NUM_BARS {
                let f_lo = FREQ_MIN * (FREQ_MAX / FREQ_MIN).powf(b as f32 / NUM_BARS as f32);
                let f_hi = FREQ_MIN * (FREQ_MAX / FREQ_MIN).powf((b + 1) as f32 / NUM_BARS as f32);
                let k_lo = ((f_lo / bin_hz).floor() as usize).clamp(1, half - 1);
                let k_hi = ((f_hi / bin_hz).ceil() as usize).clamp(k_lo + 1, half);

                let mut peak = 0.0f32;
                for k in k_lo..k_hi {
                    let m = buf[k].norm() / norm;
                    if m > peak { peak = m; }
                }
                let db = 20.0 * (peak + 1e-9).log10();
                raw[b] = ((db - DB_MIN) / (DB_MAX - DB_MIN)).clamp(0.0, 1.0);
            }
        }

        let mut any = false;
        for b in 0..NUM_BARS {
            let target = raw[b];
            let coeff = if target > smoothed[b] { ATTACK } else { DECAY };
            smoothed[b] += (target - smoothed[b]) * coeff;
            if smoothed[b] > 0.001 { any = true; }
        }

        if has_new || any {
            let _ = app.emit("spectrum", Spectrum { bars: smoothed.clone() });
        }
    }
}