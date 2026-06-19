use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use biquad::{Biquad, Coefficients, DirectForm1, ToHertz, Type};
use rodio::source::{SeekError, Source};

pub const NUM_BANDS: usize = 10;

/// Центральные частоты полос (октавный графический эквалайзер).
pub const BAND_FREQS: [f32; NUM_BANDS] =
    [31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0];

const Q: f32 = 1.41; // ~1 октава на полосу

/// Разделяемое состояние эквалайзера.
pub struct EqState {
    gains_db: Mutex<[f32; NUM_BANDS]>,
    enabled: AtomicBool,
    version: AtomicU64,
}

impl EqState {
    pub fn new() -> Self {
        Self {
            gains_db: Mutex::new([0.0; NUM_BANDS]),
            enabled: AtomicBool::new(true),
            version: AtomicU64::new(0),
        }
    }

    pub fn set_gain(&self, band: usize, db: f32) {
        if band < NUM_BANDS {
            if let Ok(mut g) = self.gains_db.lock() {
                g[band] = db.clamp(-12.0, 12.0);
            }
            self.version.fetch_add(1, Ordering::Release);
        }
    }

    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::Release);
        self.version.fetch_add(1, Ordering::Release);
    }

    pub fn reset(&self) {
        if let Ok(mut g) = self.gains_db.lock() {
            *g = [0.0; NUM_BANDS];
        }
        self.version.fetch_add(1, Ordering::Release);
    }

    fn snapshot(&self) -> (bool, [f32; NUM_BANDS]) {
        let enabled = self.enabled.load(Ordering::Acquire);
        let gains = self.gains_db.lock().map(|g| *g).unwrap_or([0.0; NUM_BANDS]);
        (enabled, gains)
    }
}

impl Default for EqState {
    fn default() -> Self {
        Self::new()
    }
}

fn band_coeffs(sample_rate: u32, freq: f32, gain_db: f32) -> Coefficients<f32> {
    // экзотический sample_rate / freq выше Найквиста -> Err: тогда полоса без изменения
    let f = freq.clamp(1.0, sample_rate as f32 / 2.0 - 1.0);
    Coefficients::<f32>::from_params(Type::PeakingEQ(gain_db), (sample_rate as f32).hz(), f.hz(), Q)
        .unwrap_or(Coefficients { a1: 0.0, a2: 0.0, b0: 1.0, b1: 0.0, b2: 0.0 })
}

fn make_band_filters(sample_rate: u32, gains: &[f32; NUM_BANDS]) -> [DirectForm1<f32>; NUM_BANDS] {
    std::array::from_fn(|i| DirectForm1::<f32>::new(band_coeffs(sample_rate, BAND_FREQS[i], gains[i])))
}

/// Источник-обёртка: каскад из 10 биквад-фильтров на каждый канал.
pub struct Equalizer<S> {
    inner: S,
    channels: u16,
    sample_rate: u32,
    state: Arc<EqState>,
    filters: Vec<[DirectForm1<f32>; NUM_BANDS]>, // [канал][полоса]
    enabled: bool,
    seen_version: u64,
    ch: usize,
}

impl<S> Equalizer<S>
where
    S: Source<Item = f32>,
{
    pub fn new(inner: S, state: Arc<EqState>) -> Self {
        let channels = inner.channels().max(1);
        let sample_rate = inner.sample_rate().max(1);
        let (enabled, gains) = state.snapshot();
        let version = state.version.load(Ordering::Acquire);

        let filters = (0..channels as usize)
            .map(|_| make_band_filters(sample_rate, &gains))
            .collect();

        Self { inner, channels, sample_rate, state, filters, enabled, seen_version: version, ch: 0 }
    }

    fn rebuild(&mut self) {
        let (enabled, gains) = self.state.snapshot();
        self.enabled = enabled;
        for ch in self.filters.iter_mut() {
            for (i, f) in ch.iter_mut().enumerate() {
                f.update_coefficients(band_coeffs(self.sample_rate, BAND_FREQS[i], gains[i]));
            }
        }
    }
}

impl<S> Iterator for Equalizer<S>
where
    S: Source<Item = f32>,
{
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        let sample = self.inner.next()?;

        let v = self.state.version.load(Ordering::Acquire);
        if v != self.seen_version {
            self.seen_version = v;
            self.rebuild();
        }

        let ch = self.ch;
        self.ch = (self.ch + 1) % self.channels as usize;

        if !self.enabled {
            return Some(sample);
        }

        let mut out = sample;
        for f in self.filters[ch].iter_mut() {
            out = f.run(out);
        }
        Some(out)
    }

    #[inline]
    fn size_hint(&self) -> (usize, Option<usize>) {
        self.inner.size_hint()
    }
}

impl<S> Source for Equalizer<S>
where
    S: Source<Item = f32>,
{
    #[inline]
    fn current_span_len(&self) -> Option<usize> { self.inner.current_span_len() }
    #[inline]
    fn channels(&self) -> u16 { self.channels }
    #[inline]
    fn sample_rate(&self) -> u32 { self.sample_rate }
    #[inline]
    fn total_duration(&self) -> Option<Duration> { self.inner.total_duration() }
    #[inline]
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> { self.inner.try_seek(pos) }
}