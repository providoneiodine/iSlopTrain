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

test('a GPS lap a few metres off the map is lined up with the raceway', () => {
  const shape = (a) => R * (1 + 0.25 * Math.cos(a) + 0.15 * Math.sin(2 * a));
  const line = [];
  for (let k = 0; k <= 120; k++) {
    const a = (k / 120) * 2 * Math.PI;
    line.push([shape(a) * Math.cos(a), shape(a) * Math.sin(a)]);
  }
  const n = 2000, x = new Float64Array(n), y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI, r = shape(a) - 2 * Math.cos(3 * a);
    // the sim's GPS: 9 m east and 6 m south of where the map has the track
    x[i] = r * Math.cos(a) + 9;
    y[i] = r * Math.sin(a) - 6;
  }
  const a = IST.Review.Track.align(x, y, [line]);
  assert.ok(a && a.fitted, 'lined up');
  assert.ok(Math.abs(a.shift - Math.hypot(9, 6)) < 2, 'moved by the offset: ' + a.shift);
  assert.ok(a.cover > 0.95);
});

test('a long GPS lap turned a little about its origin (iRacing at Le Mans) is lined up with the map', () => {
  // a 13 km loop whose GPS is turned 0.6° about a point 3 km away: up to ~50 m off
  const S = 2500, shape = (a) => S * (1 + 0.3 * Math.cos(a) + 0.1 * Math.sin(3 * a));
  const line = [];
  for (let k = 0; k <= 400; k++) {
    const a = (k / 400) * 2 * Math.PI;
    line.push([shape(a) * Math.cos(a), shape(a) * Math.sin(a)]);
  }
  const n = 6000, x = new Float64Array(n), y = new Float64Array(n), t = 0.6 * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI, px = shape(a) * Math.cos(a) - 3000, py = shape(a) * Math.sin(a);
    x[i] = c * px - s * py + 3000;
    y[i] = s * px + c * py;
  }
  const a = IST.Review.Track.align(x, y, [line]);
  assert.ok(a && a.fitted, 'lined up');
  assert.ok(a.cover > 0.95, 'cover ' + a.cover);
  assert.ok(a.med < 2, 'median miss ' + a.med);
});

test('a GPS lap where the map has no matching raceway is not called a track', () => {
  // the lap's circuit was built over; the only raceway nearby is a small kart loop
  const kart = [];
  for (let k = 0; k <= 40; k++) kart.push([600 + 60 * Math.cos((k / 40) * 2 * Math.PI), 60 * Math.sin((k / 40) * 2 * Math.PI)]);
  const L = lap();
  const a = IST.Review.Track.align(L.x, L.y, [kart]);
  assert.ok(!a || a.cover < 0.6, 'cover ' + (a && a.cover));
});

test('laps that all leave the mapped road on one side are put back on it, a lap running wide alone is not', () => {
  // GPS drifts 9 m outward over a 200 m stretch: both laps are off the asphalt there
  const drift = (i) => { const d = Math.abs(i - 900); return d < 100 ? 9 : d < 200 ? 9 * (200 - d) / 100 : 0; };
  const a = lap(), b = lap();
  [a, b].forEach((L) => {
    for (let i = 0; i < L.n; i++) {
      const g = (i / N) * 2 * Math.PI, r = R - off(i) + drift(i);
      L.x[i] = r * Math.cos(g);
      L.y[i] = r * Math.sin(g);
    }
  });
  let cmp = IST.Review.Compare.build(a, [b], null, { lines: [mapLine], halfWidth: 6 });
  assert.ok(Math.abs(cmp.laps[0].off[900]) <= 6, 'back on the road: ' + cmp.laps[0].off[900]);
  assert.ok(Math.abs(cmp.laps[0].off[300] - off(300)) < 0.6, 'untouched elsewhere');
  // the same drift on one lap only is that lap running wide
  cmp = IST.Review.Compare.build(a, [lap()], null, { lines: [mapLine], halfWidth: 6 });
  assert.ok(Math.abs(cmp.laps[0].off[900]) > 10, 'still wide: ' + cmp.laps[0].off[900]);
});

test('the satellite image’s road is found where it really is, even off the map’s line', () => {
  // a straight 1 km road whose imagery sits 6 m right of the map's centre, with a stretch under trees
  const n = 1001, cx = new Float32Array(n), cy = new Float32Array(n);
  for (let i = 0; i < n; i++) cx[i] = i;
  const Tk = IST.Review.Track, P = Tk.roadProbe(cx, cy, n, 1), score = new Float32Array(P.pts.length);
  P.pts.forEach((p, k) => {
    const trees = p[0] > 400 && p[0] < 480;
    score[k] = trees ? 0.1 : Math.abs(p[1] + 6) <= 6 ? 0.9 : 0.1;
  });
  const road = Tk.roadShift(P, score);
  assert.ok(road, 'found');
  for (let i = 0; i < n; i += 100) assert.ok(Math.abs(road.at[i] + 6) <= 1, 'at ' + i + ' m: ' + road.at[i]);
});

test('a kerb the car struck pins the image where that kerb really is, whatever its colour', () => {
  // the image's road sits 2 m left of the map's: asphalt from -4 to +8 m, the kerb past it
  const n = 1001, cx = new Float32Array(n), cy = new Float32Array(n);
  for (let i = 0; i < n; i++) cx[i] = i;
  const material = new Uint8Array(n), off = new Float32Array(n);
  for (let i = 400; i < 430; i++) (material[i] = 11), (off[i] = 6.5);
  const Tk = IST.Review.Track, runs = Tk.kerbRuns([{ material, off, start: 0, end: n - 1 }], n, 1);
  assert.equal(runs.length, 1);
  const K = Tk.kerbProbe(cx, cy, n, 1, runs);
  const score = Float32Array.from(K.pts, (p) => (p[1] >= -4 && p[1] <= 8 ? 0.9 : 0.05));
  const a = Tk.kerbShift(K, score);
  assert.equal(a.length, 1);
  assert.ok(Math.abs(a[0].shift + 2) <= 0.5, 'image moved 2 m right: ' + a[0].shift);
  // tree shadows breaking the asphalt up near the edge aren't a kerb
  const shade = Float32Array.from(K.pts, (p) => (p[1] >= -4 && p[1] <= (Math.floor(p[0] / 3) % 2 ? 8 : 4.5) ? 0.9 : 0.05));
  assert.equal(Tk.kerbShift(K, shade).length, 0);
  // nor is a strike whose offset wanders from lap to lap
  const wobble = Float32Array.from(off, (v, i) => (v ? v + (i % 2 ? 1.2 : -1.2) : 0));
  assert.equal(Tk.kerbRuns([{ material, off: wobble, start: 0, end: n - 1 }], n, 1).length, 0);
});
