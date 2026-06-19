import * as api from './api.js';
import * as store from './store.js';

const elPanel = document.getElementById('eq');
const elBands = document.getElementById('eq-bands');
const elToggle = document.getElementById('eq-toggle');
const elEnable = document.getElementById('eq-enable');
const elReset = document.getElementById('eq-reset');
const elPresets = document.getElementById('eq-presets');

// 10 bands: 32 64 125 250 500 1k 2k 4k 8k 16k
const PRESETS = [
  { name: 'Flat',      gains: [ 0,  0,  0,  0,  0,  0,  0,  0,  0,  0] },
  { name: 'Bass',      gains: [ 6,  5,  4,  2,  0,  0,  0,  0,  0,  0] },
  { name: 'Treble',    gains: [ 0,  0,  0,  0,  0,  2,  3,  5,  6,  7] },
  { name: 'Rock',      gains: [ 5,  4,  2,  0, -1,  0,  2,  4,  5,  5] },
  { name: 'Pop',       gains: [-1,  0,  2,  3,  4,  3,  2,  0, -1, -1] },
  { name: 'Jazz',      gains: [ 3,  2,  0,  2,  0,  0, -1,  2,  3,  3] },
  { name: 'Classical', gains: [ 4,  3,  2,  0,  0,  0,  0,  2,  3,  4] },
  { name: 'Electronic',gains: [ 5,  4,  0,  0, -2,  2,  3,  4,  5,  5] },
  { name: 'Vocal',     gains: [-2, -1,  2,  4,  5,  4,  2,  1, -1, -2] },
  { name: 'Night',     gains: [-4, -3, -2,  0,  2,  3,  3,  2,  1,  0] },
];

function freqLabel(f) {
  if (f >= 1000) return (f % 1000 === 0 ? `${f / 1000}k` : `${(f / 1000).toFixed(1)}k`);
  return `${f}`;
}

export async function init() {
  const bands = await api.eqBands();
  const savedGains = store.get('eqGains', []);
  const savedEnabled = store.get('eqEnabled', true);

  elBands.innerHTML = bands.map((f, i) => `
    <div class="eq-band">
      <div class="eq-slot">
        <input type="range" data-band="${i}" min="-12" max="12" step="1" value="${Number(savedGains[i]) || 0}" />
      </div>
      <label>${freqLabel(f)}</label>
    </div>`).join('');

  // push saved state into the audio stream
  bands.forEach((_, i) => {
    const g = Number(savedGains[i]) || 0;
    if (g) api.setEqGain(i, g);
  });
  elEnable.checked = savedEnabled;
  if (!savedEnabled) api.setEqEnabled(false);

  function persist(immediate) {
    const gains = [...elBands.querySelectorAll('input[data-band]')].map((inp) => Number(inp.value));
    const patch = { eqGains: gains, eqEnabled: elEnable.checked };
    (immediate ? store.setNow : store.set)(patch);
  }

    function getGains() {
      return [...elBands.querySelectorAll('input[data-band]')].map((inp) => Number(inp.value));
    }

    function setGains(gains) {
      elBands.querySelectorAll('input[data-band]').forEach((inp, i) => {
        inp.value = gains[i] ?? 0;
        api.setEqGain(i, gains[i] ?? 0);
      });
      persist(true);
      updateActivePreset();
    }

    function updateActivePreset() {
      const cur = getGains().join(',');
      elPresets.querySelectorAll('.eq-preset').forEach((btn) => {
        const preset = PRESETS.find((p) => p.name === btn.dataset.preset);
        btn.classList.toggle('is-active', !!preset && preset.gains.join(',') === cur);
      });
    }

    // build preset buttons
    elPresets.innerHTML = PRESETS.map((p) =>
      `<button class="eq-preset" data-preset="${p.name}">${p.name}</button>`
    ).join('');

    elPresets.addEventListener('click', (e) => {
      const btn = e.target.closest('.eq-preset');
      if (!btn) return;
      const preset = PRESETS.find((p) => p.name === btn.dataset.preset);
      if (preset) setGains(preset.gains);
    });

  elBands.addEventListener('input', (e) => {
    const inp = e.target.closest('input[data-band]');
    if (inp) { api.setEqGain(Number(inp.dataset.band), Number(inp.value)); persist(false); }
  });

  elToggle.addEventListener('click', () => {
    document.dispatchEvent(new Event('eq-toggle-request'));
  });

  elEnable.addEventListener('change', () => { api.setEqEnabled(elEnable.checked); persist(true); });

  elReset.addEventListener('click', () => {
    api.resetEq();
    for (const inp of elBands.querySelectorAll('input[data-band]')) inp.value = 0;
    persist(true);
    updateActivePreset();
  });

  updateActivePreset();
}
