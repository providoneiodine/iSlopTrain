/*
 * The lap viewer's track centre: with a map outline, a lap that clips an
 * apex is shown off centre by the distance it really was, not as the middle
 * of the road; and laps logged in a sim's own coordinates land on the map.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const IST = load();
const R = 300, N = Math.round(2 * Math.PI * R);
// the map's centreline: a circle, drawn in straight 20 m pieces like OSM
const mapLine = [];
for (let k = 0; k <= 96; k++) {
  const a = (k / 96) * 2 * Math.PI;
  mapLine.push([R * Math.cos(a), R * Math.sin(a)]);
}
// a lap 4 m inside (left of anticlockwise travel) at the "apex", 4 m outside opposite
const off = (i) => 4 * Math.cos((i / N) * 2 * Math.PI);
function lap() {
  const n = N + 1, L = { n, len: N, time: 60, x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), t: new Float32Array(n), speed: new Float32Array(n).fill(40) };
  for (let i = 0; i < n; i++) {
    const a = (i / N) * 2 * Math.PI, r = R - off(i);
    L.x[i] = r * Math.cos(a);
    L.y[i] = r * Math.sin(a);
    L.t[i] = (i / N) * 60;
  }
  return L;
}

test('with a map outline, a lap is drawn off centre by how far it really was', () => {
  const cmp = IST.Review.Compare.build(lap(), [], null, { lines: [mapLine] });
  assert.equal(cmp.centre.source, 'map');
  for (let i = 0; i < N; i += 50) assert.ok(Math.abs(cmp.laps[0].off[i] - off(i)) < 0.6, 'at ' + i + ' m: ' + cmp.laps[0].off[i] + ' vs ' + off(i));
});

test('without one, the centre is the laps’ own path and says so', () => {
  const cmp = IST.Review.Compare.build(lap(), [], null, null);
  assert.equal(cmp.centre.source, 'laps');
});

test('a lap in a sim’s own coordinates (turned, moved, mirrored) is placed on the map', () => {
  // a lopsided circuit, so only one placement fits
  const shape = (a) => R * (1 + 0.25 * Math.cos(a) + 0.15 * Math.sin(2 * a));
  const line = [];
  for (let k = 0; k <= 120; k++) {
    const a = (k / 120) * 2 * Math.PI;
    line.push([shape(a) * Math.cos(a), shape(a) * Math.sin(a)]);
  }
  const n = 2000, truth = [], x = new Float64Array(n), y = new Float64Array(n);
  const th = 1.1, c = Math.cos(th), s = Math.sin(th);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI, r = shape(a) - 3 * Math.cos(3 * a);
    const px = r * Math.cos(a), py = r * Math.sin(a);
    truth.push([px, py]);
    // the sim's frame: mirrored, turned and moved
    x[i] = c * px - s * -py + 500;
    y[i] = s * px + c * -py - 900;
  }
  const f = IST.Review.Track.fit(x, y, [line]);
  assert.ok(f, 'found a fit');
  for (let i = 0; i < n; i += 250) {
    const p = IST.Review.Track.apply(f.m, [x[i], y[i]]);
    assert.ok(Math.hypot(p[0] - truth[i][0], p[1] - truth[i][1]) < 3, 'point ' + i + ' lands where it is on the map');
  }
});
