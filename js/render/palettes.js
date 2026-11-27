/*
 * Colour vision modes: each swaps the values behind IST.Theme's roles and the
 * matching CSS custom properties, chosen to stay apart under the Machado et al.
 * (2009) dichromacy simulation and, for monochrome, by lightness alone.
 *
 *   IST.Palette.MODES    [{ id, label, hint }]
 *   IST.Palette.apply(id) swap Theme + :root tokens (unknown ids fall back to standard)
 *   IST.Palette.current() the applied mode id
 */
(function () {
  'use strict';
  const Th = IST.Theme;

  // Roles that carry meaning; the slate structure colours never change.
  const STANDARD = {
    peach: '#f5b09a', butter: '#f6d98f', mint: '#a6e3c4', sky: '#9fcbef', lilac: '#c4b4ef', rose: '#f09ca6',
    hit: '#30d158', miss: '#ff453a', missDark: '#8a1a14', neutral: '#a1a9b7', crash: '#ff7a3d', off: '#e0737f',
    ideal: '#5fd38a', pick: '#ff8a4d',
    laps: ['#f6d98f', '#9fcbef', '#c4b4ef', '#f5b09a', '#eef0f4'],
    names: { mint: 'mint', rose: 'rose', sky: 'sky', peach: 'peach', butter: 'butter', lilac: 'lilac', hit: 'green', miss: 'red', ideal: 'green', pick: 'orange' },
  };
  // Red-green modes move meaning onto the blue / orange axis both dichromat types keep.
  const RED_GREEN = {
    mint: '#74b4ff', sky: '#74b4ff', peach: '#f0d29a', lilac: '#d6cfe0', neutral: '#a8a8a8',
    hit: '#3d9bff', miss: '#ff9f0a', missDark: '#7a4a00', crash: '#ffffff', ideal: '#3d9bff', pick: '#ff9f0a',
    laps: ['#f6d98f', '#6fa8f0', '#f08a24', '#ada48e', '#eef0f4'],
    names: { mint: 'blue', rose: 'orange', sky: 'blue', peach: 'pale orange', butter: 'yellow', lilac: 'pale grey', hit: 'blue', miss: 'orange', ideal: 'blue', pick: 'orange' },
  };
  const MODES = [
    { id: 'standard', label: 'Standard', hint: 'The default pastels.', set: {} },
    { id: 'protan', label: 'Protanopia', hint: 'Red-weak vision. Gain and loss, throttle and brake move to blue and orange.',
      set: Object.assign({}, RED_GREEN, { rose: '#ff9638', off: '#ff9638' }) },
    { id: 'deutan', label: 'Deuteranopia', hint: 'Green-weak vision, the most common type. Gain and loss, throttle and brake move to blue and orange.',
      set: Object.assign({}, RED_GREEN, { rose: '#ff8c2e', off: '#ff8c2e' }) },
    { id: 'tritan', label: 'Tritanopia', hint: 'Blue-yellow vision. Gain and loss move to teal and red; blue and yellow never pair.',
      set: {
        mint: '#5fd6c8', sky: '#5fd6c8', rose: '#ff7a8a', peach: '#f7b2c6', crash: '#ffffff', off: '#ff7a8a', ideal: '#30d1c0', pick: '#ff4d6a',
        laps: ['#f6d98f', '#5fd6c8', '#ff7a8a', '#b59cff', '#eef0f4'],
        names: { mint: 'teal', rose: 'red', sky: 'teal', peach: 'pink', butter: 'yellow', lilac: 'lilac', hit: 'green', miss: 'red', ideal: 'teal', pick: 'red' },
      } },
    { id: 'mono', label: 'Monochrome', hint: 'Achromatopsia or low colour vision. Every pair differs in lightness: darker is better or less, brighter is worse or more.',
      set: {
        mint: '#6889ab', sky: '#6889ab', neutral: '#acb2ba', peach: '#e2cca9', rose: '#fff4e6', butter: '#d9b45a',
        hit: '#eaf2ff', miss: '#c4573f', missDark: '#5a2418', crash: '#ffffff', off: '#fff4e6', ideal: '#ffffff', pick: '#e2841e',
        laps: ['#f6d98f', '#7ebcf2', '#e2841e', '#9969c3', '#ffffff'],
        names: { mint: 'dark blue', rose: 'brightest', sky: 'dark blue', peach: 'light', butter: 'gold', lilac: 'lilac', hit: 'white', miss: 'dark red', ideal: 'white', pick: 'orange' },
      } },
  ];
  const CSS_VARS = ['peach', 'butter', 'mint', 'sky', 'lilac', 'rose', 'hit', 'miss', 'missDark', 'neutral'];
  const cssName = (k) => '--' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
  let cur = 'standard';

  function apply(id) {
    const mode = MODES.find((m) => m.id === id) || MODES[0];
    cur = mode.id;
    const v = Object.assign({}, STANDARD, mode.set);
    Object.keys(v).forEach((k) => (Th[k] = Array.isArray(v[k]) ? v[k].slice() : typeof v[k] === 'object' ? Object.assign({}, v[k]) : v[k]));
    const root = typeof document !== 'undefined' && document.documentElement;
    if (root && root.style) {
      CSS_VARS.forEach((k) => root.style.setProperty(cssName(k), v[k]));
      root.dataset.cvd = cur;
    }
    return cur;
  }

  IST.Palette = { MODES: MODES.map(({ id, label, hint }) => ({ id, label, hint })), apply, current: () => cur, values: (id) => Object.assign({}, STANDARD, (MODES.find((m) => m.id === id) || MODES[0]).set) };
  apply(IST.Storage ? IST.Storage.getPref('cvd', 'standard') : 'standard');
})();
