/*
 * The circuits bundled in data/tracks/ get their map without asking OpenStreetMap's
 * servers, and a circuit known to have nothing on the map shows none without asking either.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./harness');

const ROOT = path.join(__dirname, '..');
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/tracks/index.json'), 'utf8')).circuits;

/** A sandboxed app whose network only serves the site's own files; anything else is logged and fails. */
function app() {
  const outside = [];
  const fetch = async (url) => {
    const file = path.join(ROOT, url);
    if (!/^https?:/.test(url) && fs.existsSync(file)) {
      const body = fs.readFileSync(file, 'utf8');
      return { ok: true, status: 200, json: async () => JSON.parse(body) };
    }
    outside.push(url);
    throw new Error('offline');
  };
  return { IST: load({ fetch }), outside };
}

function decode6(s) {
  const pts = [];
  let i = 0, a = 0, b = 0;
  const num = () => {
    let v = 0, sh = 0, c;
    do (c = s.charCodeAt(i++) - 63), (v |= (c & 0x1f) << sh), (sh += 5);
    while (c >= 0x20);
    return v & 1 ? ~(v >> 1) : v >> 1;
  };
  while (i < s.length) (a += num()), (b += num()), pts.push([a / 1e6, b / 1e6]);
  return pts;
}

test('a bundled circuit is found and fitted from the site alone', async () => {
  const { IST, outside } = app();
  const Tk = IST.Review.Track;
  // a circuit whose map is mostly one closed raceway (no spare layouts to choose between),
  // its lap driven in a sim's own frame (turned and moved)
  let lap = null;
  for (const c of index.filter((x) => x.osm && x.ids.length)) {
    const ways = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/tracks/osm', c.id + '.json'), 'utf8')).ways.map((w) => decode6(w.p));
    const g = Tk.geo(c.lat, c.lon);
    for (const w of ways) {
      const a = w[0], b = w[w.length - 1];
      if (w.length < 50 || Math.abs(a[0] - b[0]) > 1e-5 || Math.abs(a[1] - b[1]) > 1e-5) continue;
      const xy = w.map((p) => g.toXY(p[0], p[1]));
      const x = [], y = [];
      for (let k = 1; k < xy.length; k++) {
        const [x0, y0] = xy[k - 1], [x1, y1] = xy[k], n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0)));
        for (let j = 0; j < n; j++) x.push(x0 + ((x1 - x0) * j) / n), y.push(y0 + ((y1 - y0) * j) / n);
      }
      if (x.length < 2000 || x.length < c.km * 1000 * 0.7) continue;
      const t = 0.7, cs = Math.cos(t), sn = Math.sin(t);
      lap = { c, x: Float32Array.from(x, (v, i) => cs * v - sn * y[i] + 500), y: Float32Array.from(y, (v, i) => sn * x[i] + cs * v - 800) };
      break;
    }
    if (lap) break;
  }
  assert.ok(lap, 'some bundled circuit has a closed raceway to drive');
  const m = await IST.Review.MapData.lookup({ origin: null, id: lap.c.ids[0], track: lap.c.names[0], x: lap.x, y: lap.y });
  assert.ok(m && m.how === 'fit', lap.c.id + ': the lap was placed on the map');
  assert.deepEqual(outside, [], 'no request left the site');
});

test('a circuit with nothing on the map shows no map, without asking anyone', async () => {
  const none = index.find((c) => !c.osm && c.ids.length);
  if (!none) return;
  const { IST, outside } = app();
  const m = await IST.Review.MapData.lookup({ origin: null, id: none.ids[0], track: none.names[0], x: new Float32Array(100), y: new Float32Array(100) });
  assert.equal(m, null);
  assert.deepEqual(outside, []);
});
