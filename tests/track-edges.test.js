/*
 * The lap viewer's track edges: a lap that clips a kerb in an .ibt is drawn at
 * that edge, not centred in a ribbon sized round it, and a GPS lap of the same
 * track later borrows those edges from this browser.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const R = 300, N = Math.round(2 * Math.PI * R);
const mapLine = [];
for (let k = 0; k <= 96; k++) {
  const a = (k / 96) * 2 * Math.PI;
  mapLine.push([R * Math.cos(a), R * Math.sin(a)]);
}
// on the left kerb (car centre 4 m left) at the start, the right one (5.5 m right) halfway round
const off = (i) => 4.75 * Math.cos((i / N) * 2 * Math.PI) - 0.75;
function lap(withMaterial) {
  const n = N + 1, L = { n, len: N, step: 1, time: 60, kind: 'full', x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), t: new Float32Array(n), speed: new Float32Array(n).fill(40) };
  if (withMaterial) L.material = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i / N) * 2 * Math.PI, r = R - off(i);
    L.x[i] = r * Math.cos(a);
    L.y[i] = r * Math.sin(a);
    L.t[i] = (i / N) * 60;
    if (withMaterial) L.material[i] = off(i) >= 3.8 || off(i) <= -5.3 ? 12 : 2;
  }
  return L;
}

test('an .ibt lap on a kerb is drawn at that edge, and the far edge is not mirrored round it', () => {
  const IST = load();
  const geo = IST.Review.Track.geo(50, 5), E = IST.Review.Edges, L = lap(true);
  E.save('test', E.learn([L], [mapLine], 0), geo);
  const cmp = IST.Review.Compare.build(L, [], null, { lines: [mapLine], edgesOn: (cx, cy, n) => E.onGrid('test', geo, cx, cy, n) });
  const c = cmp.centre, at0 = 20, half = Math.round(N / 2);
  assert.equal(c.edges, 'kerbs');
  assert.ok(Math.abs(c.wl[at0] - cmp.laps[0].off[at0]) < 1, 'left kerb: edge ' + c.wl[at0] + ', car ' + cmp.laps[0].off[at0]);
  assert.ok(Math.abs(c.wr[half] + cmp.laps[0].off[half]) < 1, 'right kerb: edge ' + c.wr[half] + ', car ' + cmp.laps[0].off[half]);
  assert.ok(c.wr[at0] > c.wl[at0] + 1, 'the right side is not sized to the lap on the left');
});

test('a GPS lap of the same track, later, borrows the .ibt’s edges', () => {
  const store = (() => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  })();
  {
    const IST = load({ localStorage: store }), E = IST.Review.Edges;
    E.save('spa', E.learn([lap(true)], [mapLine], 0), IST.Review.Track.geo(50, 5));
  }
  // a reload, and a session whose frame starts somewhere else
  const IST = load({ localStorage: store }), Tk = IST.Review.Track;
  const g1 = Tk.geo(50, 5), g2 = Tk.geo(50.001, 5.002);
  const move = (p) => g2.toXY(...g1.toLL(p[0], p[1]));
  const L = lap(false), line = mapLine.map(move);
  for (let i = 0; i < L.n; i++) [L.x[i], L.y[i]] = move([L.x[i], L.y[i]]);
  const cmp = IST.Review.Compare.build(L, [], null, { lines: [line], edgesOn: (cx, cy, n) => IST.Review.Edges.onGrid('spa', g2, cx, cy, n) });
  assert.equal(cmp.centre.edges, 'kerbs');
  assert.ok(Math.abs(cmp.centre.wl[20] - cmp.laps[0].off[20]) < 1, 'edge ' + cmp.centre.wl[20] + ', car ' + cmp.laps[0].off[20]);
});
