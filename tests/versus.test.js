/*
 * Driver vs driver: laps are grouped under the driver who drove them, and the
 * versus card's gap means what it says (+ is behind the reference, and the
 * trend is what was lost or gained over the last stretch).
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const session = (file, driver) => ({ file, meta: { driver } });

/** A reference at a steady 50 m/s and a rival at `v` m/s until `from` m, then at the reference's pace. */
function cmpAt(v, from) {
  const n = 2001, step = 1, ref = new Float32Array(n), t = new Float32Array(n), delta = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    ref[i] = ref[i - 1] + step / 50;
    t[i] = t[i - 1] + step / (i <= from ? v : 50);
    delta[i] = t[i] - ref[i];
  }
  return { n, step, laps: [{ t: ref, delta: new Float32Array(n) }, { t, delta }] };
}

test('laps from several files by one driver sit under that driver, and an unnamed file is its own', () => {
  const { Review } = load();
  const d = Review.Versus.drivers([session('a.ibt', 'Alex Tester'), session('b.ibt', 'Me'), session('c.ibt', ' alex  tester '), session('d.csv', ''), session('e.csv', '')]);
  assert.equal(d.map((x) => x.name).join('|'), 'Alex Tester|Me|d|e');
  assert.equal(d.map((x) => x.sessions.length).join(''), '2111');
});

test('a slower lap shows a + gap and is metres behind; a faster one a − gap and is ahead', () => {
  const { Review } = load();
  const b = Review.Versus.battle(cmpAt(45, 2000), 1, 1000);
  assert.ok(Math.abs(b.delta - (1000 / 45 - 1000 / 50)) < 0.01);
  assert.ok(b.gapM > 95 && b.gapM < 105, 'a tenth slower is 100 m back after 1 km of the reference: ' + b.gapM);
  const fast = Review.Versus.battle(cmpAt(55, 2000), 1, 1000);
  assert.ok(fast.delta < 0 && fast.gapM < 0);
});

test('time lost is counted from one braking point to the next, corner and following straight together', () => {
  const { Review } = load();
  // the rival is slow only from 600 m to 900 m: inside the stretch that starts with braking at 500 m
  const cmp = cmpAt(50, 0), L = cmp.laps[1];
  for (let i = 1; i < cmp.n; i++) L.delta[i] = L.delta[i - 1] + (i > 600 && i <= 900 ? 0.001 : 0);
  const brake = new Float32Array(cmp.n);
  [[500, 560], [1500, 1540]].forEach(([a, b]) => brake.fill(1, a, b));
  cmp.laps[0].brake = brake;
  // T1 and T2 are one complex, T3 stands alone; each corner's start is its top speed, before the pedal
  cmp.corners = [{ start: 480, apex: 580 }, { start: 640, apex: 700 }, { start: 1470, apex: 1560 }];
  cmp.complexes = [{ corners: [0, 1] }, { corners: [2] }];
  const S = Review.Versus.sectors(cmp);
  assert.equal(S.map((x) => x.name + ':' + x.a + '-' + x.b).join(' '), 'Run to T1:0-500 T1–2:500-1500 T3:1500-2000');
  const mid = Review.Versus.sectorAt(cmp, 1, 750), next = Review.Versus.sectorAt(cmp, 1, 1800);
  assert.equal(mid.name, 'T1–2');
  assert.ok(Math.abs(mid.lost - 0.15) < 0.002, 'half the loss by half way: ' + mid.lost);
  assert.ok(Math.abs(mid.prev.lost) < 0.002, 'nothing lost on the run to T1');
  assert.ok(Math.abs(next.lost) < 0.002 && Math.abs(next.prev.lost - 0.3) < 0.002, 'all 0.3 s belongs to T1–2, none to T3');
  assert.equal(Review.Versus.worst(cmp, 1).name, 'T1–2');
});

test('the reference has no battle with itself', () => {
  const { Review } = load();
  assert.equal(Review.Versus.battle(cmpAt(45, 2000), 0, 100), null);
});

test('a lap downloaded from Garage 61 is a whole lap under the driver in its file name', () => {
  const T = load().Telemetry.lib();
  // one flying lap of a 600 m radius circle at 50 m/s, 60 Hz, cut just past the line as Garage 61 does
  const R = 600, len = 2 * Math.PI * R, n = Math.ceil((len - 0.5) / (50 / 60)) + 1, rows = ['Speed,LapDistPct,Lat,Lon,Brake,Throttle'];
  for (let i = 0; i < n; i++) {
    const s = 0.5 + i * (50 / 60), a = s / R;
    rows.push([50, (s % len) / len, 50.44 + (R * Math.sin(a)) / 111320, 5.97 + (R * Math.cos(a)) / (111320 * Math.cos(50.44 * Math.PI / 180)), 0, 1].join(','));
  }
  const r = T.process('Garage 61 - Jamie Sample - Porsche 911 Cup 992.2 - Some Track Grand Prix - 01.15.398 - 01ABC.csv', new TextEncoder().encode(rows.join('\n')).buffer);
  assert.equal(r.meta.driver, 'Jamie Sample');
  assert.equal(r.laps.length, 1);
  assert.equal(r.laps[0].kind, 'full');
});
