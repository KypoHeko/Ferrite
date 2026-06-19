import * as events from './events.js';
import * as player from './player.js';
import * as playlist from './playlist.js';
import * as equalizer from './equalizer.js';
import * as visualizer from './visualizer.js';
import * as windowctl from './windowctl.js';
import * as skins from './skins.js';
import * as store from './store.js';

// Load saved state first — modules read it during init().
await store.load();

player.init({
  onPrev: playlist.playPrev,
  onNext: playlist.playNext,
  onPlayPause: playlist.handlePlayPause,
});

playlist.init();
equalizer.init();
visualizer.init();
windowctl.init();
skins.init();

events.initEvents({
  onProgress: player.handleProgress,
  onEnded: playlist.handleEnded,
  onSpectrum: visualizer.handleSpectrum,
  onTrackInfo: (info) => { player.setTrackInfo(info); playlist.notePlaybackOk(); },
  onTrackError: playlist.handleTrackError,
});

// safety net: flush any pending writes before the window closes
window.addEventListener('beforeunload', () => store.flush());
