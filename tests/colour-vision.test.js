/*
 * Each colour vision mode promises that the pairs which carry meaning (gain / loss,
 * throttle / brake, the balance and speed ramps, the five lap colours) stay apart
 * for the vision type it names, using the Machado et al. (2009) full-severity matrices.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, memoryStorage } = require('./harness');

const MACHADO = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const rgb = (h) => [1, 3, 5].map((i) => lin(parseInt(h.slice(i, i + 2), 16) / 255));
function seen(h, type) {
  const c = rgb(h);
  if (type === 'mono') {
    const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    return [y, y, y];
  }
  return MACHADO[type].map((r) => Math.min(1, Math.max(0, r[0] * c[0] + r[1] * c[1] + r[2] * c[2])));
}
function oklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const dist = (a, b, type) => Math.hypot(...oklab(seen(a, type)).map((x, i) => x - oklab(seen(b, type))[i]));

// Pairs that sit side by side in one paint, fence or legend.
const PAIRS = [['mint', 'rose'], ['mint', 'neutral'], ['rose', 'neutral'], ['hit', 'miss'], ['sky', 'neutral'], ['sky', 'peach'],
  ['peach', 'neutral'], ['peach', 'rose'], ['sky', 'rose'], ['sky', 'butter'], ['butter', 'rose'], ['ideal', 'pick']];
const MIN = 0.085; // OKLab distance; the standard pastels fall to 0.02 under deuteranopia

for (const type of ['protan', 'deutan', 'tritan', 'mono']) {
  test(type + ' mode keeps meaningful colour pairs and lap colours apart for that vision type', () => {
    const ls = memoryStorage();
    load({ localStorage: ls }).Storage.setPref('cvd', type);
    const IST = load({ localStorage: ls }); // the saved mode applies on the next page load
    assert.equal(IST.Palette.current(), type);
    const Th = IST.Theme;
    for (const [a, b] of PAIRS) assert.ok(dist(Th[a], Th[b], type) >= MIN, a + ' / ' + b + ' look alike: ' + dist(Th[a], Th[b], type).toFixed(3));
    for (let i = 0; i < Th.laps.length; i++)
      for (let j = i + 1; j < Th.laps.length; j++) assert.ok(dist(Th.laps[i], Th.laps[j], type) >= MIN, 'laps ' + i + ' and ' + j + ' look alike');
  });
}

test('an unknown saved mode falls back to the standard palette', () => {
  const ls = memoryStorage();
  load({ localStorage: ls }).Storage.setPref('cvd', 'nonsense');
  assert.equal(load({ localStorage: ls }).Palette.current(), 'standard');
});
