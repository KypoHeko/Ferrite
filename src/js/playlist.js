import * as api from './api.js';
import * as player from './player.js';
import * as store from './store.js';

const elPlaylist = document.getElementById('playlist');
const elShuffle = document.getElementById('shuffle');
const elRepeat = document.getElementById('repeat');
const elCount = document.getElementById('track-count');

// webview for receiving dropped files (native drag & drop with file paths)
const webview =
  window.__TAURI__.webviewWindow?.getCurrentWebviewWindow?.() ||
  window.__TAURI__.webview?.getCurrentWebview?.();

const AUDIO_RE = /\.(mp3|flac|wav|ogg|oga|opus|m4a|aac|wma|aif|aiff)$/i;
const isAudio = (p) => AUDIO_RE.test(p);

let playlist = [];
let nextId = 1;
let currentId = null;
let selectedId = null;
let failStreak = 0;

let shuffle = false;
let shuffleBag = [];
const repeatModes = ['off', 'all', 'one'];
let repeatMode = 'off';

// mouse-based drag-to-sort
let downId = null;
let downY = 0;
let dragging = false;
let dragId = null;
let dropTargetId = null;
let dropAfter = false;
let didDrag = false;

const fileName = (p) => p.split(/[\\/]/).pop();
const currentIndex = () => playlist.findIndex((t) => t.id === currentId);

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function trackWord(n) {
  return n === 1 ? 'track' : 'tracks';
}

function updateCount() {
  elCount.textContent = `${playlist.length} ${trackWord(playlist.length)}`;
}

// persist playlist and modes immediately (survives an abrupt close)
function persist() {
  store.setNow({
    playlist: playlist.map((t) => ({ path: t.path, name: t.name })),
    shuffle,
    repeat: repeatMode,
  });
}

function render() {
  updateCount();
  if (playlist.length === 0) {
    elPlaylist.innerHTML =
      '<li class="empty"><button type="button" class="pl-add">Empty — drop tracks here</button></li>';
    return;
  }
  elPlaylist.innerHTML = playlist.map((t, i) => {
    const cls = [t.id === currentId ? 'active' : '', t.id === selectedId ? 'selected' : '']
      .filter(Boolean).join(' ');
    return `<li data-id="${t.id}" class="${cls}">
              <span class="idx">${String(i + 1).padStart(3, '0')}</span>
              <span class="name">${escapeHtml(t.name)}</span>
            </li>`;
  }).join('');
}

function applyClasses() {
  for (const li of elPlaylist.querySelectorAll('li[data-id]')) {
    const id = Number(li.dataset.id);
    li.classList.toggle('active', id === currentId);
    li.classList.toggle('selected', id === selectedId);
  }
}

function clearDropMarkers() {
  for (const li of elPlaylist.querySelectorAll('.drop-before, .drop-after')) {
    li.classList.remove('drop-before', 'drop-after');
  }
}

// --- shuffle ---
function refillBag() {
  shuffleBag = playlist.map((t) => t.id).filter((id) => id !== currentId);
  if (shuffleBag.length === 0) shuffleBag = playlist.map((t) => t.id);
}

function pickNext() {
  if (repeatMode === 'one') return currentIndex();
  if (shuffle) {
    if (shuffleBag.length === 0) {
      if (repeatMode === 'all') refillBag(); else return -1;
    }
    if (shuffleBag.length === 0) return -1;
    const r = Math.floor(Math.random() * shuffleBag.length);
    const id = shuffleBag.splice(r, 1)[0];
    return playlist.findIndex((t) => t.id === id);
  }
  const idx = currentIndex();
  if (idx < playlist.length - 1) return idx + 1;
  return repeatMode === 'all' ? 0 : -1;
}

// --- navigation ---
function startPlay(i) {
  if (i < 0 || i >= playlist.length) return;
  const t = playlist[i];
  currentId = t.id;
  shuffleBag = shuffleBag.filter((id) => id !== t.id);
  applyClasses();
  player.playTrack(t, i + 1);
}

export function playNext() {
  const i = pickNext();
  if (i >= 0) startPlay(i);
  else player.finishPlayback();
}

export function playPrev() {
  failStreak = 0;
  const idx = currentIndex();
  if (idx > 0) startPlay(idx - 1);
  else if (idx === 0) startPlay(repeatMode === 'all' ? playlist.length - 1 : 0);
  else if (playlist.length) startPlay(0);
}

export function handlePlayPause() {
  failStreak = 0;
  if (playlist.length === 0) return;
  const idx = currentIndex();
  if (idx === -1) return startPlay(0);
  if (player.getEnded()) return startPlay(idx);
  player.togglePause();
}

export function handleEnded() { playNext(); }

export function notePlaybackOk() { failStreak = 0; }

export function handleTrackError() {
  failStreak++;
  if (playlist.length === 0 || failStreak >= playlist.length) {
    failStreak = 0;
    player.finishPlayback();
    player.showMessage('Cannot play — file missing or unsupported');
    return;
  }
  playNext();
}

// --- playlist mutations ---
function addFiles(paths, atIndex) {
  const items = paths.map((p) => ({ id: nextId++, path: p, name: fileName(p) }));
  if (atIndex == null || atIndex < 0 || atIndex >= playlist.length) {
    playlist.push(...items);
  } else {
    playlist.splice(atIndex, 0, ...items);
  }
  if (shuffle) refillBag();
  player.setControlsEnabled(playlist.length > 0);
  render();
  persist();
}

// insertion index from a vertical cursor coordinate (CSS pixels)
function indexFromY(clientY) {
  const rows = [...elPlaylist.querySelectorAll('li[data-id]')];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return i;
  }
  return playlist.length;
}

function markDropAt(clientY) {
  clearDropMarkers();
  const plRect = elPlaylist.getBoundingClientRect();
  if (clientY < plRect.top || clientY > plRect.bottom) return;
  const rows = [...elPlaylist.querySelectorAll('li[data-id]')];
  if (!rows.length) return;
  const i = indexFromY(clientY);
  if (i < rows.length) rows[i].classList.add('drop-before');
  else rows[rows.length - 1].classList.add('drop-after');
}

async function openAddDialog() {
  const selected = await api.pickAudioFiles();
  if (!selected) return;
  addFiles(Array.isArray(selected) ? selected : [selected]);
}

function removeTrack(id) {
  const idx = playlist.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const wasCurrent = id === currentId;
  // auto-advance only when removing the CURRENTLY PLAYING track
  // (paused / stopped / finished — just remove without auto-play)
  const advance = wasCurrent && player.getIsPlaying();
  playlist.splice(idx, 1);
  shuffleBag = shuffleBag.filter((x) => x !== id);
  if (selectedId === id) {
    selectedId = playlist.length ? playlist[Math.min(idx, playlist.length - 1)].id : null;
  }
  if (wasCurrent) {
    if (playlist.length === 0) { player.clear(); currentId = null; }
    else if (advance) startPlay(Math.min(idx, playlist.length - 1));
    else { player.clear(); currentId = null; }
  }
  player.setControlsEnabled(playlist.length > 0);
  render();
  persist();
}

function moveTrackTo(fromId, targetId, after) {
  if (fromId === targetId) return;
  const from = playlist.findIndex((t) => t.id === fromId);
  if (from === -1) return;
  const [item] = playlist.splice(from, 1);
  let to = playlist.findIndex((t) => t.id === targetId);
  if (to === -1) to = playlist.length;
  if (after) to += 1;
  playlist.splice(to, 0, item);
  render();
  persist();
}

// --- mouse drag-to-sort (HTML5 DnD is unavailable when file drop is enabled) ---
function onMouseMove(e) {
  if (downId == null) return;
  if (!dragging) {
    if (Math.abs(e.clientY - downY) < 5) return;
    dragging = true;
    didDrag = true;
    dragId = downId;
    const src = elPlaylist.querySelector(`li[data-id="${dragId}"]`);
    if (src) src.classList.add('dragging');
  }
  clearDropMarkers();
  const rows = [...elPlaylist.querySelectorAll('li[data-id]')];
  let placed = false;
  for (const li of rows) {
    const r = li.getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) {
      li.classList.add('drop-before');
      dropTargetId = Number(li.dataset.id);
      dropAfter = false;
      placed = true;
      break;
    }
  }
  if (!placed && rows.length) {
    const last = rows[rows.length - 1];
    last.classList.add('drop-after');
    dropTargetId = Number(last.dataset.id);
    dropAfter = true;
  }
}

function onMouseUp() {
  if (downId != null && dragging && dropTargetId != null) {
    moveTrackTo(dragId, dropTargetId, dropAfter);
  } else {
    const d = elPlaylist.querySelector('.dragging');
    if (d) d.classList.remove('dragging');
    clearDropMarkers();
  }
  downId = null;
  dragging = false;
  dragId = null;
  dropTargetId = null;
}

export function init() {
  // restore saved state (no auto-play)
  const savedTracks = store.get('playlist', []);
  if (Array.isArray(savedTracks)) {
    playlist = savedTracks
      .filter((t) => t && typeof t.path === 'string')
      .map((t) => ({ id: nextId++, path: t.path, name: t.name || fileName(t.path) }));
  }
  shuffle = store.get('shuffle', false) === true;
  const r = store.get('repeat', 'off');
  repeatMode = repeatModes.includes(r) ? r : 'off';
  elShuffle.classList.toggle('on', shuffle);
  elRepeat.classList.toggle('on', repeatMode !== 'off');
  elRepeat.classList.toggle('one', repeatMode === 'one');
  elRepeat.title = 'Repeat: ' + ({ off: 'off', all: 'all', one: 'one track' }[repeatMode]);
  if (shuffle) refillBag();
  player.setControlsEnabled(playlist.length > 0);

  elPlaylist.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    downId = Number(li.dataset.id);
    downY = e.clientY;
    dragging = false;
    didDrag = false;
  });
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  elPlaylist.addEventListener('click', (e) => {
    if (e.target.closest('.pl-add')) { openAddDialog(); return; }
    if (didDrag) { didDrag = false; return; }
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    selectedId = Number(li.dataset.id);
    applyClasses();
  });

  elPlaylist.addEventListener('dblclick', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    failStreak = 0;
    startPlay(playlist.findIndex((t) => t.id === Number(li.dataset.id)));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' && selectedId != null) removeTrack(selectedId);
  });

  // receive files dropped onto the window
  if (webview) {
    webview.onDragDropEvent((event) => {
      const t = event.payload.type;
      const dpr = window.devicePixelRatio || 1;
      const y = event.payload.position ? event.payload.position.y / dpr : 0;
      if (t === 'enter') {
        document.body.classList.add('drop-target');
      } else if (t === 'over') {
        document.body.classList.add('drop-target');
        markDropAt(y);
      } else if (t === 'leave') {
        document.body.classList.remove('drop-target');
        clearDropMarkers();
      } else if (t === 'drop') {
        document.body.classList.remove('drop-target');
        clearDropMarkers();
        const audio = (event.payload.paths || []).filter(isAudio);
        if (!audio.length) return;
        const plRect = elPlaylist.getBoundingClientRect();
        const idx = (y >= plRect.top && y <= plRect.bottom) ? indexFromY(y) : playlist.length;
        addFiles(audio, idx);
      }
    });
  }

  elShuffle.addEventListener('click', () => {
    shuffle = !shuffle;
    elShuffle.classList.toggle('on', shuffle);
    if (shuffle) refillBag(); else shuffleBag = [];
    persist();
  });

  elRepeat.addEventListener('click', () => {
    repeatMode = repeatModes[(repeatModes.indexOf(repeatMode) + 1) % repeatModes.length];
    elRepeat.classList.toggle('on', repeatMode !== 'off');
    elRepeat.classList.toggle('one', repeatMode === 'one');
    elRepeat.title = 'Repeat: ' + ({ off: 'off', all: 'all', one: 'one track' }[repeatMode]);
    persist();
  });

  render();
}
