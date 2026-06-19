const { listen } = window.__TAURI__.event;

export function initEvents({ onProgress, onEnded, onSpectrum, onTrackInfo }) {
  listen('progress', (e) => onProgress(e.payload));
  listen('ended', () => onEnded());
  listen('spectrum', (e) => onSpectrum(e.payload));
  listen('trackinfo', (e) => onTrackInfo(e.payload));
  listen('trackerror', (e) => onTrackError(e.payload));
}
