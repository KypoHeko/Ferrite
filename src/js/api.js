const { invoke } = window.__TAURI__.core;
const { open } = window.__TAURI__.dialog;

// fire-and-forget: catch errors (lost channel / closed output) to avoid
// unhandled rejections; callers don't need the return value of these commands
const fire = (cmd, args) => invoke(cmd, args).catch((e) => console.error(`${cmd}:`, e));

export const play = (path) => invoke('play', { path }); // caller handles await + try/catch
export const pause = () => fire('pause');
export const resume = () => fire('resume');
export const stop = () => fire('stop');
export const seek = (position) => fire('seek', { position });
export const setVolume = (level) => fire('set_volume', { level });

export const setEqGain = (band, db) => fire('set_eq_gain', { band, db });
export const setEqEnabled = (enabled) => fire('set_eq_enabled', { enabled });
export const resetEq = () => fire('reset_eq');
export const eqBands = () => invoke('eq_bands'); // return value is used

export const pickAudioFiles = () =>
  open({
    multiple: true,
    filters: [{ name: 'Audio', extensions: ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac'] }],
  });
