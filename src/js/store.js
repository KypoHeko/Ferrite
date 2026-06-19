const { invoke } = window.__TAURI__.core;

// Single state snapshot (key-value) stored in one settings.json file.
// The playlist ('playlist' key), EQ preset, and other UI state all live here.

let cache = {};
let timer = null;
let dirty = false;

// Call ONCE on startup before any set/get — populates the snapshot from disk.
export async function load() {
  try { cache = JSON.parse(await invoke('load_settings')) || {}; }
  catch { cache = {}; }
  return cache;
}

export function get(key, fallback) {
  return key in cache ? cache[key] : fallback;
}

function writeNow() {
  clearTimeout(timer);
  timer = null;
  dirty = false;
  invoke('save_settings', { json: JSON.stringify(cache) }).catch(() => {});
}

// merge patch into the snapshot and write after a delay (frequent changes don't hammer the disk)
export function set(patch) {
  cache = { ...cache, ...patch };
  dirty = true;
  clearTimeout(timer);
  timer = setTimeout(writeNow, 300);
}

// same, but immediate — survives an abrupt window close
export function setNow(patch) {
  cache = { ...cache, ...patch };
  writeNow();
}

// flush any pending write (e.g. before the window closes)
export function flush() {
  if (dirty) writeNow();
}
