import * as store from './store.js';

const W = window.__TAURI__.window;
const { getCurrentWindow, LogicalSize, PhysicalPosition, currentMonitor } = W;
const win = getCurrentWindow();

const shell = () => document.querySelector('.shell');
const playlistEl = () => document.querySelector('.playlist');

const MIN_W = 330;
const PL_MIN = parseInt(
  getComputedStyle(document.documentElement).getPropertyValue('--pl-min')
) || 96;

let savedPlH = 0; // playlist height before collapse
let busy = false; // prevents overlapping panel animations

// chrome height (everything except the playlist; including EQ when expanded)
function chromeHeight() {
  const pl = playlistEl();
  const plH = pl && !pl.classList.contains('is-collapsed') ? pl.offsetHeight : 0;
  return shell().offsetHeight - plH;
}

// reliable chrome height: sum of all panels EXCEPT the playlist.
// Independent of window size (only the playlist stretches), so it stays correct
// even when the window is squeezed and the playlist has hit its minimum height.
// 1px border top + 1px border bottom + 12px margin-bottom of the playlist
const SHELL_PAD = 14;
function fixedChromeHeight() {
  let h = 0;
  for (const el of shell().children) {
    if (el.classList.contains('playlist')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') continue;
    if (el.classList.contains('is-collapsed')) continue; // collapsed panels don't contribute
    // scrollHeight is more reliable than offsetHeight: overflow:hidden can't underreport it
    const elH = Math.max(el.offsetHeight, el.scrollHeight);
    h += elH + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
  }
  return h;
}
function requiredMinHeight() {
  const pl = playlistEl();
  const plVisible = pl && !pl.classList.contains('is-collapsed');
  return Math.round(fixedChromeHeight() + (plVisible ? PL_MIN : 0) + SHELL_PAD);
}

// --- smooth window height animation ---
let anim = null;
function animateWindowHeight(targetH) {
  return new Promise((resolve) => {
    if (anim) cancelAnimationFrame(anim);
    const w = shell().offsetWidth;
    const startH = shell().offsetHeight;
    if (Math.abs(targetH - startH) < 2) { resolve(); return; }
    const dur = 150, t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3); // easeOutCubic
      win.setSize(new LogicalSize(w, Math.round(startH + (targetH - startH) * e)));
      if (k < 1) anim = requestAnimationFrame(step);
      else { anim = null; resolve(); }
    };
    anim = requestAnimationFrame(step);
  });
}

// --- minimum height: chrome + one playlist row (EQ is part of the chrome) ---
async function updateConstraints() {
  const minH = requiredMinHeight();
  try {
    await win.setMinSize(new LogicalSize(MIN_W, minH)); // hint to the OS (if allowed)
    if (shell().offsetHeight < minH) await animateWindowHeight(minH);
  } catch (e) {
    console.error('updateConstraints:', e);
  }
}

// Hard clamp on manual resize.
// shell has min-height — content is never clipped while the window is small, no flicker.
// Time-debounced: animation fires after the user releases the resize handle.
let clampTimer = null;
function clampOnResize() {
  if (busy) return;
  clearTimeout(clampTimer);
  clampTimer = setTimeout(() => {
    clampTimer = null;
    if (anim) return; // panel animation already running — don't interfere
    const minH = requiredMinHeight();
    win.setMinSize(new LogicalSize(MIN_W, minH)).catch(() => {});
    if (shell().offsetHeight < minH) {
      animateWindowHeight(minH);
    }
    // remember the new playlist height (user dragged the window edge)
    const pl = playlistEl();
    if (pl && !pl.classList.contains('is-collapsed')) {
      savedPlH = pl.offsetHeight;
      store.set({ playlistHeight: savedPlH });
    }
  }, 150);
}

// measure full panel height (with vertical margins) without triggering a visible animation.
// Used by both the equalizer and the visualizer.
function measurePanel(el) {
  const prev = el.style.transition;
  const wasCol = el.classList.contains('is-collapsed');
  el.style.transition = 'none';
  el.classList.remove('is-collapsed');
  const cs = getComputedStyle(el);
  const h = el.offsetHeight + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
  if (wasCol) el.classList.add('is-collapsed');
  void el.offsetHeight; // reflow (instant, transition disabled)
  el.style.transition = prev;
  return h;
}

// apply is-collapsed without playing the CSS transition (used on startup)
function setCollapsedInstant(el, collapsed) {
  if (!el) return;
  const prev = el.style.transition;
  el.style.transition = 'none';
  el.classList.toggle('is-collapsed', collapsed);
  void el.offsetHeight; // reflow — lock the state without animation
  el.style.transition = prev;
}

// --- show/hide equalizer: window grows/shrinks by its height ---
async function toggleEq() {
  if (busy) return;
  busy = true;
  const eq = document.getElementById('eq');
  const btn = document.getElementById('eq-toggle');
  if (eq) {
    const showing = eq.classList.contains('is-collapsed');
    const contrib = measurePanel(eq);
    if (btn) btn.classList.toggle('on', showing);
    if (showing) {
      eq.classList.remove('is-collapsed');
      await animateWindowHeight(shell().offsetHeight + contrib);
    } else {
      eq.classList.add('is-collapsed');
      await animateWindowHeight(Math.max(0, shell().offsetHeight - contrib));
    }
    await updateConstraints();
    store.set({ eqCollapsed: eq.classList.contains('is-collapsed') });
  }
  busy = false;
}

// --- show/hide visualizer: window grows/shrinks by its height ---
async function toggleViz() {
  if (busy) return;
  busy = true;
  const viz = document.querySelector('.viz');
  const btn = document.getElementById('viz-toggle');
  if (viz) {
    const showing = viz.classList.contains('is-collapsed'); // will become visible
    const contrib = measurePanel(viz);
    if (btn) btn.classList.toggle('on', showing);
    if (showing) viz.classList.remove('is-collapsed');
    else viz.classList.add('is-collapsed');
    // tell the visualizer whether to stop rendering (it stops the loop itself after the animation)
    document.dispatchEvent(new CustomEvent('viz-visibility', { detail: { collapsed: !showing } }));
    if (showing) await animateWindowHeight(shell().offsetHeight + contrib);
    else await animateWindowHeight(Math.max(0, shell().offsetHeight - contrib));
    await updateConstraints();
    store.set({ vizCollapsed: viz.classList.contains('is-collapsed') });
  }
  busy = false;
}

// --- show/hide playlist ---
// Same pattern as EQ and visualizer:
//   is-collapsed (max-height:0 + opacity:0 in CSS) drives the transition,
//   the window is animated to the saved/measured playlist height.
async function togglePlaylist(btn) {
  if (busy) return;
  busy = true;
  const pl = playlistEl();
  if (pl) {
    const showing = pl.classList.contains('is-collapsed'); // will become visible
    const contrib = showing ? (savedPlH || 200) : pl.offsetHeight;
    if (!showing) savedPlH = pl.offsetHeight; // save before collapsing
    if (btn) btn.classList.toggle('on', showing);
    if (showing) {
      // expanding: remove is-collapsed first, then grow
      pl.classList.remove('is-collapsed');
      await animateWindowHeight(shell().offsetHeight + contrib);
    } else {
      // collapsing: shrink the window first, then add is-collapsed
      try { await win.setMinSize(new LogicalSize(MIN_W, 120)); } catch (e) {}
      await animateWindowHeight(Math.max(0, shell().offsetHeight - contrib));
      pl.classList.add('is-collapsed');
    }
    await updateConstraints();
    const collapsedNow = pl.classList.contains('is-collapsed');
    store.set({ plCollapsed: collapsedNow, playlistHeight: collapsedNow ? savedPlH : pl.offsetHeight });
  }
  busy = false;
}

// apply saved visibility/size on startup — without animation, in a single frame
async function applySavedLayout() {
  const eq = document.getElementById('eq');
  const viz = document.querySelector('.viz');
  const pl = playlistEl();
  const eqBtn = document.getElementById('eq-toggle');
  const vizBtn = document.getElementById('viz-toggle');
  const plBtn = document.getElementById('pl-toggle');

  const eqCol = store.get('eqCollapsed', false) === true;
  const vizCol = store.get('vizCollapsed', false) === true;
  const plCol = store.get('plCollapsed', false) === true;
  const savedH = Number(store.get('playlistHeight', 0)) || 0;
  if (savedH) savedPlH = savedH;

  setCollapsedInstant(eq, eqCol);
  if (eqBtn) eqBtn.classList.toggle('on', !eqCol);
  setCollapsedInstant(viz, vizCol);
  if (vizBtn) vizBtn.classList.toggle('on', !vizCol);
  setCollapsedInstant(pl, plCol);
  if (plBtn) plBtn.classList.toggle('on', !plCol);

  // visualizer is collapsed — stop rendering (it listens for this event)
  if (vizCol) {
    document.dispatchEvent(new CustomEvent('viz-visibility', { detail: { collapsed: true } }));
  }

  // set the final window height in a single frame (no per-frame animation)
  const plH = (!plCol && savedPlH) ? savedPlH : 0;
  const targetH = Math.round(fixedChromeHeight() + plH + SHELL_PAD);
  try { await win.setMinSize(new LogicalSize(MIN_W, 120)); } catch (e) {}
  try { await win.setSize(new LogicalSize(shell().offsetWidth, targetH)); } catch (e) {}
  await updateConstraints();
}

// --- edge snapping ---
// On Windows, frameless windows have an invisible DWM resize border on left/right:
// outerSize is wider than innerSize by the border thickness on each side; no border on top.
// We compensate so the visible edge snaps to the monitor boundary, not the outer one.
let pendingSnap = null;
let moveTimer   = null;

async function snapToEdges(pos) {
  try {
    const mon = await currentMonitor();
    if (!mon) return;
    const [outer, inner] = await Promise.all([win.outerSize(), win.innerSize()]);
    const T = 10;
    const mx = mon.position.x, my = mon.position.y;
    const mw = mon.size.width;
    const borderX = Math.round((outer.width - inner.width) / 2);
    let x = pos.x, y = pos.y;
    if (Math.abs((x + borderX) - mx) <= T)                       x = mx - borderX;
    if (Math.abs((x + outer.width - borderX) - (mx + mw)) <= T) x = mx + mw - outer.width + borderX;
    if (Math.abs(y - my) <= T)                                    y = my;
    if (x !== pos.x || y !== pos.y) await win.setPosition(new PhysicalPosition(x, y));
  } catch (e) { /* no monitor or permission — skip */ }
}

export function init() {
  const closeBtn = document.getElementById('win-close');
  if (closeBtn) closeBtn.addEventListener('click', () => win.close());

  const minBtn = document.getElementById('win-min');
  if (minBtn) minBtn.addEventListener('click', () => win.minimize());

  const plToggle = document.getElementById('pl-toggle');
  if (plToggle) plToggle.addEventListener('click', () => togglePlaylist(plToggle));

  // equalizer toggle request comes from equalizer.js
  document.addEventListener('eq-toggle-request', toggleEq);

  // visualizer toggle request comes from visualizer.js
  document.addEventListener('viz-toggle-request', toggleViz);

  // snap to edges after dragging.
  // mouseup is the primary trigger (mouse button released).
  // 250 ms debounce as fallback: on Windows, OS-level dragging via WM_NCLBUTTONDOWN
  // may not deliver mouseup to the webview, so snapping fires after the pause instead.
  document.addEventListener('mouseup', () => {
    if (!pendingSnap) return;
    clearTimeout(moveTimer);
    const pos = pendingSnap;
    pendingSnap = null;
    snapToEdges(pos);
  });
  try {
    win.onMoved(({ payload }) => {
      pendingSnap = payload;
      clearTimeout(moveTimer);
      moveTimer = setTimeout(() => {
        if (pendingSnap) { snapToEdges(pendingSnap); pendingSnap = null; }
      }, 250);
    });
  } catch (e) { /* event not available */ }

  // prevent the window from shrinking so far that the playlist is hidden
  try {
    win.onResized(() => clampOnResize());
  } catch (e) { /* event not available */ }

  // apply saved layout (panel visibility + playlist height)
  // without animation, then re-enforce constraints after render/font load
  applySavedLayout();
  setTimeout(updateConstraints, 160);
  setTimeout(updateConstraints, 450);
}
