/*
 * Heights for laps without them (js/review/elevation.js): an .ibt's track profile is
 * saved in the browser and later laps there take it by position, even across a
 * crossover; another layout is left alone, and terrain heights are smoothed.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

/** One lap of a path (fn(a) -> [east m, north m, height m]) as a CSV, 60 Hz at about 40 m/s. */
function csv(name, fn, o) {
  o = o || {};
  const lat0 = o.lat || 50.437, lon0 = 5.971, kx = 111195 * Math.cos((lat0 * Math.PI) / 180), rows = ['Speed,LapDistPct,Lat,Lon' + (o.alt ? ',Alt' : '')];
  let len = 0;
  for (let i = 1; i <= 2000; i++) { const p = fn((i / 2000) * 2 * Math.PI), q = fn(((i - 1) / 2000) * 2 * Math.PI); len += Math.hypot(p[0] - q[0], p[1] - q[1]); }
  const n = Math.round((len / 40) * 60);
  for (let i = 0; i < n; i++) {
    const [x, y, z] = fn((i / n) * 2 * Math.PI);
    rows.push([40, (i / n).toFixed(6), (lat0 + y / 111195).toFixed(8), (lon0 + x / kx).toFixed(8)].concat(o.alt ? [z.toFixed(1)] : []).join(','));
  }
  return [name, new TextEncoder().encode(rows.join('\n')).buffer];
}
const circle = (R, w) => (a) => [R * Math.cos(a) + w, R * Math.sin(a), 12 * Math.sin(a) + 300];
const eight = (a) => [600 * Math.sin(a), 600 * Math.sin(a) * Math.cos(a), 6 * Math.cos(a) + 300];

function setup() {
  const IST = load(), T = IST.Telemetry.lib(), E = IST.Review.Elevation;
  const run = (args, opt) => T.process(args[0], args[1], opt || {});
  return { E, run };
}
test('an .ibt-style file saves its track, and a later lap there without heights takes them', () => {
  const { E, run } = setup();
  const ibt = run(csv('Spa.ibt.csv', circle(600, 0), { alt: true }));
  assert.ok(E.has(ibt));
  E.save(E.profile(ibt, ibt.origin));
  // a Garage 61 lap on a slightly wider line, no heights
  const g61 = run(csv('Garage 61 - Me - Car - Spa - 01.15.398 - X.csv', circle(603, 0)));
  assert.ok(!E.has(g61));
  const found = E.saved(g61, g61.origin);
  assert.ok(found.length);
  assert.ok(E.fill(g61, found[0], g61.origin));
  const lap = g61.laps[0];
  // compare shape: heights follow 12 sin(angle round the centre) up to a common offset
  const cx = (lap.x.reduce((s, v) => s + v, 0)) / lap.n, cy = (lap.y.reduce((s, v) => s + v, 0)) / lap.n;
  let mx = 0;
  const off = lap.z[0] - 12 * Math.sin(Math.atan2(lap.y[0] - cy, lap.x[0] - cx));
  for (let i = 0; i < lap.n; i += 7) mx = Math.max(mx, Math.abs(lap.z[i] - off - 12 * Math.sin(Math.atan2(lap.y[i] - cy, lap.x[i] - cx))));
  assert.ok(mx < 0.5, 'height error ' + mx.toFixed(2) + ' m');
});

test('at a crossover the lap keeps to the level it is on', () => {
  const { E, run } = setup();
  const ibt = run(csv('Eight.ibt.csv', eight, { alt: true }));
  const prof = E.profile(ibt, ibt.origin);
  const g61 = run(csv('Eight.csv', eight));
  assert.ok(E.fill(g61, prof, g61.origin));
  const a = ibt.laps[0], b = g61.laps[0];
  let mx = 0;
  for (let i = 0; i < Math.min(a.n, b.n); i += 5) mx = Math.max(mx, Math.abs(a.z[i] - b.z[i]));
  assert.ok(mx < 0.6, 'worst ' + mx.toFixed(2) + ' m');
});

test('a lap on another layout is left alone', () => {
  const { E, run } = setup();
  const ibt = run(csv('Spa.ibt.csv', circle(600, 0), { alt: true }));
  const other = run(csv('Other.csv', circle(300, 300)));
  assert.ok(!E.fill(other, E.profile(ibt, ibt.origin), other.origin));
  assert.ok(other.laps[0].z.every((v) => v === 0));
});

test('terrain heights decode from terrarium pixels and smooth without moving a steady slope', () => {
  const { E } = setup();
  assert.equal(E.decode([128, 100, 128], 0), 100.5);
  const ramp = Array.from({ length: 200 }, (_, i) => i * 0.25 + (i % 2 ? 2 : -2));
  const s = E.smooth(ramp, 50, false);
  for (let i = 40; i < 160; i++) assert.ok(Math.abs(s[i] - i * 0.25) < 0.05);
});
