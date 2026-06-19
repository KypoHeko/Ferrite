const canvas = document.getElementById('spectrum');
const ctx = canvas.getContext('2d');
const vizBox = canvas.closest('.viz');           // container we collapse
const toggleBtn = document.getElementById('viz-toggle');

const DEFAULT_BARS = 48;
let target = [];
let display = new Array(DEFAULT_BARS).fill(0);
let peaks = new Array(DEFAULT_BARS).fill(0);
let lastActive = 0; // timestamp of the last "active" (non-silent) frame

let rafId = null;   // handle of the scheduled frame, null = loop is stopped
let running = false;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (w === canvas.width && h === canvas.height) return; // size unchanged — don't reset the canvas
  canvas.width = w;
  canvas.height = h;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

export function handleSpectrum(payload) {
  target = payload.bars || [];
  if (display.length !== target.length && target.length) {
    display = new Array(target.length).fill(0);
    peaks = new Array(target.length).fill(0);
  }
  for (let i = 0; i < target.length; i++) {
    if (target[i] > 0.02) { lastActive = performance.now(); break; }
  }
}

function draw() {
  if (!running) return; // guard against a stray frame after stop()

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  const n = display.length;
  if (n === 0) { rafId = requestAnimationFrame(draw); return; }

  const now = performance.now();
  const idle = now - lastActive > 3500;
  const t = now / 1000;

  for (let i = 0; i < n; i++) {
    // idle: gentle travelling wave; active: real spectrum
    const tv = idle
      ? 0.15 + 0.135 * (0.5 + 0.5 * Math.sin(t * 1.6 + i * 0.45))
      : (target[i] || 0);
    display[i] += (tv - display[i]) * (idle ? 0.12 : 0.35);
    if (display[i] > peaks[i]) peaks[i] = display[i];
    else peaks[i] = Math.max(0, peaks[i] - 0.012);
  }

  const gap = 2;
  const bw = (w - gap * (n - 1)) / n;
  const grad = ctx.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, '#006633');
  grad.addColorStop(0.5, '#00cc66');
  grad.addColorStop(1, '#00ff88');

  for (let i = 0; i < n; i++) {
    const x = i * (bw + gap);
    const bh = display[i] * (h - 3);
    ctx.fillStyle = grad;
    ctx.fillRect(x, h - bh, bw, bh);

    const py = h - peaks[i] * (h - 3);
    ctx.fillStyle = '#b6ffce';
    ctx.fillRect(x, py - 2, bw, 2);
  }

  rafId = requestAnimationFrame(draw);
}

// ---- start / stop rendering ----
export function start() {
  if (running) return;
  running = true;
  resize();                          // size may have changed while stopped
  rafId = requestAnimationFrame(draw);
}

export function stop() {
  running = false;
  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight); // clear the canvas
}

export function toggle() {
  if (running) stop(); else start();
  return running;
}

// ---- react to collapse/expand ----
// The is-collapsed class, button state, and window size are managed by windowctl.js
// (same as the equalizer) — here we only start/stop rendering.
const COLLAPSE_MS = 200; // slightly longer than the CSS transition (.16s) to finish the collapse animation

function onVisibility(collapsed) {
  if (collapsed) {
    // don't stop immediately: let the bars "slide away" with the panel animation,
    // then stop rendering (only if the panel is still collapsed)
    setTimeout(() => {
      if (!vizBox || vizBox.classList.contains('is-collapsed')) stop();
    }, COLLAPSE_MS);
  } else {
    start();
  }
}

export function init() {
  window.addEventListener('resize', resize);
  // button only requests the toggle — windowctl.js handles the window and class changes
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      document.dispatchEvent(new Event('viz-toggle-request'));
    });
  }
  document.addEventListener('viz-visibility', (e) => onVisibility(e.detail.collapsed));
  start();
}
