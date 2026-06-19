import * as api from './api.js';

const els = {
  track: document.getElementById('track'),
  playpause: document.getElementById('playpause'),
  prev: document.getElementById('prev'),
  next: document.getElementById('next'),
  stop: document.getElementById('stop'),
  seek: document.getElementById('seek'),
  cur: document.getElementById('cur'),
  tot: document.getElementById('tot'),
  vol: document.getElementById('vol'),
  volVal: document.getElementById('vol-val'),
  nowNum: document.getElementById('now-num'),
  nowTitle: document.getElementById('now-title'),
  kbps: document.getElementById('kbps'),
  khz: document.getElementById('khz'),
  stereo: document.getElementById('stereo'),
  format: document.getElementById('fmt'),
};

let isPlaying = false;
let ended = false;
let isSeeking = false;
let lastInfo = null;   // last track info (restored on resume)

// format label derived from file extension
function formatLabel(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  const map = {
    mp3: 'MP3', flac: 'FLAC', wav: 'WAV', wave: 'WAV',
    ogg: 'OGG', oga: 'OGG', opus: 'OPUS',
    m4a: 'AAC', aac: 'AAC', wma: 'WMA', aif: 'AIFF', aiff: 'AIFF',
  };
  return map[ext] || (ext ? ext.toUpperCase() : '—');
}

function fmt(secs) {
  if (secs == null || isNaN(secs)) return '--:--';
  const s = Math.max(0, Math.floor(secs));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function updateSeekFill() {
  const el = els.seek;
  const max = Number(el.max) || 1;
  const pct = (Number(el.value) / max) * 100;
  el.style.setProperty('--seek-pct', `${pct}%`);
}

function setPlaying(state) {
  isPlaying = state;
  els.playpause.classList.toggle('playing', state);
}

// LCD track name marquee — activates only when text overflows
function updateMarquee() {
  const el = els.track;
  el.classList.remove('scroll');
  requestAnimationFrame(() => {
    const overflow = el.scrollWidth - el.parentElement.clientWidth;
    if (overflow > 4) {
      el.style.setProperty('--marquee-shift', `-${overflow}px`);
      el.style.setProperty('--marquee-dur', `${Math.max(4, overflow / 22)}s`);
      el.classList.add('scroll');
    }
  });
}

export const getIsPlaying = () => isPlaying;
export const getEnded = () => ended;

export function setControlsEnabled(has) {
  for (const b of [els.playpause, els.stop, els.prev, els.next]) b.disabled = !has;
}

export async function playTrack(track, number) {
  ended = false;
  els.track.textContent = track.name;
  els.nowTitle.textContent = track.name;
  els.nowNum.textContent = String(number).padStart(3, '0') + '.';
  els.format.textContent = formatLabel(track.path);
  updateMarquee();
  try {
    await api.play(track.path);
    setPlaying(true);
  } catch (e) {
    els.track.textContent = 'Error: ' + e;
  }
}

export function togglePause() {
  if (isPlaying) { api.pause(); setPlaying(false); }
  else { api.resume(); setPlaying(true); if (lastInfo) setTrackInfo(lastInfo); }
}

export function finishPlayback() { // end of playlist
  api.stop();
  setPlaying(false);
  ended = true;
  els.seek.disabled = true;
  lastInfo = null;
  resetLcdInfo();
}

export function clear() {           // playlist emptied
  api.stop();
  setPlaying(false);
  ended = false;
  els.track.textContent = 'No file selected';
  els.track.classList.remove('scroll');
  els.nowNum.textContent = '—';
  els.nowTitle.textContent = '—';
  els.cur.textContent = '00:00';
  els.tot.textContent = '--:--';
  els.seek.disabled = true;
  els.seek.value = 0;
  updateSeekFill();
  resetLcdInfo();
}

// show a transient message on the track LCD (e.g. a skipped/missing file)
export function showMessage(msg) {
  els.track.textContent = msg;
  els.track.classList.remove('scroll');
}

function resetLcdInfo() {
  els.kbps.textContent = '—';
  els.khz.textContent = '—';
  els.stereo.textContent = 'STEREO';
  els.format.textContent = '—';
}

export function setTrackInfo({ sampleRate, channels, kbps }) {
  lastInfo = { sampleRate, channels, kbps };
  els.khz.textContent = sampleRate ? String(Math.round(sampleRate / 1000)) : '—';
  els.stereo.textContent = channels >= 2 ? 'STEREO' : 'MONO';
  els.kbps.textContent = kbps ? String(kbps) : '—';
}

export function handleProgress({ position, duration }) {
  els.cur.textContent = fmt(position);
  if (duration) {
    els.tot.textContent = fmt(duration);
    els.seek.disabled = false;
    els.seek.max = duration;
    if (!isSeeking) { els.seek.value = position; updateSeekFill(); }
  } else {
    els.tot.textContent = '--:--';
    els.seek.disabled = true;
  }
}

export function init({ onPrev, onNext, onPlayPause }) {
  els.playpause.addEventListener('click', onPlayPause);
  els.next.addEventListener('click', onNext);
  els.prev.addEventListener('click', onPrev);

  els.stop.addEventListener('click', () => {
    api.stop();
    ended = false;
    setPlaying(false);
    resetLcdInfo();
    isSeeking = false;
    els.seek.value = 0;
    updateSeekFill();
    els.cur.textContent = '00:00';
  });

  els.seek.addEventListener('input', () => {
    isSeeking = true;
    updateSeekFill();
    els.cur.textContent = fmt(Number(els.seek.value));
  });
  els.seek.addEventListener('change', async () => {
    await api.seek(Number(els.seek.value));
    isSeeking = false;
  });

  els.vol.addEventListener('input', () => {
    api.setVolume(els.vol.value / 100);
    els.volVal.textContent = els.vol.value;
  });
  els.volVal.textContent = els.vol.value;
}
