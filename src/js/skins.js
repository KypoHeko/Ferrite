const { invoke } = window.__TAURI__.core;

// Allowlist of variables a skin may set. IMPORTANT: keep in sync with
// SKINNABLE_TOKENS + SKINNABLE_ASSETS in skins.rs — otherwise a token
// will be applied but won't be cleared when the skin changes.
const SKINNABLE = [
  '--accent-rgb', '--bg',
  '--shell-1', '--shell-2', '--shell-3',
  '--titlebar-1', '--titlebar-2',
  '--inset', '--panel-bg',
  '--danger-rgb', '--font-mono', '--font-sans',
  '--bg-image',
];

const root = document.documentElement;
let menuEl, listEl, btnEl;
let currentId = 'default';

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// remove all previously applied overrides -> revert to tokens.css
function clearOverrides() {
  for (const name of SKINNABLE) root.style.removeProperty(name);
}

function applySkin({ tokens = {}, assets = {} }) {
  clearOverrides();
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
  for (const [k, dataUri] of Object.entries(assets)) {
    // escape quotes so a rogue data-URI can't break the url() token on the frontend
    const safe = String(dataUri).replace(/"/g, '%22');
    root.style.setProperty(k, `url("${safe}")`);
  }
  // visualizer re-reads the accent color from the token
  window.dispatchEvent(new Event('skin-applied'));
}

function markActive() {
  if (!listEl) return;
  for (const b of listEl.querySelectorAll('[data-skin]')) {
    b.classList.toggle('active', b.dataset.skin === currentId);
  }
}

async function selectSkin(id, persist = true) {
  try {
    const data = await invoke('load_skin', { id });
    applySkin(data);
    currentId = id;
    markActive();
    if (persist) invoke('set_selected_skin', { id }).catch(() => {});
  } catch (e) {
    console.error('load_skin:', e);
  }
}

async function buildMenu() {
  if (!listEl) return;
  let skins = [];
  try {
    skins = await invoke('list_skins');
  } catch (e) {
    console.error('list_skins:', e);
  }
  listEl.innerHTML = skins.map((s) => `
    <button type="button" class="skin-item" data-skin="${escapeHtml(s.id)}">
      <span class="skin-name">${escapeHtml(s.name)}</span>
      <span class="skin-author">${escapeHtml(s.author)}</span>
    </button>`).join('');
  markActive();
}

function toggleMenu(show) {
  if (!menuEl) return;
  const visible = !menuEl.classList.contains('hidden');
  const next = show === undefined ? !visible : show;
  menuEl.classList.toggle('hidden', !next);
  if (next) buildMenu();
}

export async function init() {
  menuEl = document.getElementById('skin-menu');
  listEl = document.getElementById('skin-list');
  btnEl = document.getElementById('skin-toggle');
  const openDir = document.getElementById('skin-open-dir');
  const refresh = document.getElementById('skin-refresh');

  if (btnEl) btnEl.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });

  if (listEl) listEl.addEventListener('click', (e) => {
    const item = e.target.closest('[data-skin]');
    if (item) { selectSkin(item.dataset.skin); toggleMenu(false); }
  });

  if (openDir) openDir.addEventListener('click', () => invoke('open_skins_dir').catch(() => {}));
  if (refresh) refresh.addEventListener('click', () => buildMenu());

  // click outside the menu closes it
  document.addEventListener('click', (e) => {
    if (menuEl && !menuEl.classList.contains('hidden') &&
        !menuEl.contains(e.target) && e.target !== btnEl) {
      toggleMenu(false);
    }
  });

  // apply the saved selection on startup
  try {
    const id = await invoke('get_selected_skin');
    currentId = id || 'default';
    if (currentId !== 'default') await selectSkin(currentId, false);
  } catch (e) { /* no saved selection — stay on default */ }
}
