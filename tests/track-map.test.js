/*
 * Track map: the highlighted complex runs from the reference's braking point to its
 * exit, the next one is offered on a straight, and a point snaps to the nearest metre.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

/** 1 km at 1 m: brake at 280, one corner apexing at 300, full throttle again from 340; a two-corner complex at 600/700. */
function cmp() {
  const n = 1000, brake = new Float32Array(n), throttle = new Float32Array(n).fill(1), speed = new Float32Array(n).fill(60);
  for (let i = 280; i < 300; i++) (brake[i] = 1), (throttle[i] = 0);
  for (let i = 300; i < 340; i++) throttle[i] = 0.5;
  for (let i = 680; i < 720; i++) throttle[i] = 0.5;
  const corners = [
    { apex: 300, start: 0, end: 500, dir: 1, complex: 0 },
    { apex: 600, start: 500, end: 650, dir: -1, complex: 1 },
    { apex: 700, start: 650, end: 999, dir: 1, complex: 1 },
  ];
  const complexes = [{ corners: [0], first: 0, last: 500 }, { corners: [1, 2], first: 500, last: 999 }];
  return { n, step: 1, laps: [{ brake, throttle, speed }], corners, complexes };
}

test('a complex is highlighted from the brake going down to full throttle, and named by its corners', () => {
  const { Review } = load();
  const S = Review.TrackMap.spans(cmp());
  assert.equal(S[0].a, 280);
  assert.ok(S[0].b >= 340 && S[0].b <= 365, 'exit near full throttle: ' + S[0].b);
  assert.equal(S[0].name, 'T1');
  assert.equal(S[1].name, 'T2–3');
});

test('on a straight the next complex is shown, past the last one the first', () => {
  const { Review } = load();
  const c = cmp(), M = Review.TrackMap;
  assert.deepEqual({ ...M.complexAt(c, 300) }, { c: 0, on: true });
  assert.deepEqual({ ...M.complexAt(c, 450) }, { c: 1, on: false });
  assert.deepEqual({ ...M.complexAt(c, 990) }, { c: 0, on: false });
  assert.equal(M.complexAt(c, -1), null);
});

test('a point on the map snaps to the nearest grid index', () => {
  const { Review } = load();
  const r = Review.TrackMap.nearest(new Float32Array([0, 0, 10, 0, 20, 0]), 12, 3);
  assert.equal(r.i, 1);
  assert.ok(Math.abs(r.d - Math.hypot(2, 3)) < 1e-6);
});

test('corner numbers come from the data’s names, with named corners numbered only where they fit', () => {
  const { Review } = load();
  const L = (names) => Review.Corners.label(names.map((name) => ({ name, start: 0, end: 0 }))).join(',');
  assert.equal(L(['Turn 1', 'Turn 3', 'Moraine Sweep', 'Turn 5']), '1,3,4,5');
  assert.equal(L(['T1', 'Hairpin', 'Esses', 'T3']), '1,,,3', 'two names, one free number: neither guessed');
  assert.equal(L(['La Source', 'Eau Rouge']), '1,2', 'no numbers at all: in order');
  assert.equal(Review.Corners.clean('Spa 2024 Combined'), 'spa-2024-combined');
});

test('a stretch is named by the data’s corners inside it', () => {
  const { Review } = load();
  const cmp = { turns: [{ apex: 100, label: '1' }, { apex: 300, label: '4' }, { apex: 350, label: '5' }] };
  assert.equal(Review.Corners.nameSpan(cmp, 250, 400), 'T4–5');
  assert.equal(Review.Corners.nameSpan(cmp, 120, 200), 'T1', 'none inside: the nearest');
  assert.equal(Review.Corners.nameSpan({}, 0, 10), null);
});

test('a track’s shown name finds its layout in the corner data', () => {
  const { Review } = load();
  const q = 'Circuit de Spa-Francorchamps Grand Prix Pits';
  const names = ['Spa Endurance', 'Spa Grand Prix Pits', 'Spa Grand Prix Pits - 2010', 'Spa Classic Pits'];
  const s = names.map((n) => Review.Corners.score(q, n));
  assert.equal(names[s.indexOf(Math.max(...s))], 'Spa Grand Prix Pits');
  assert.ok(Review.Corners.score('Road America · Full Course', 'Okayama Full Course') < 0.6, 'a shared layout word alone is no match');
});
