/*
 * Heights for laps whose file has none (Garage 61 and most CSVs). Each .ibt saves its track's
 * height profile in this browser, and later laps there take it by position; elsewhere, with the
 * Map option, heights come from free AWS terrain tiles smoothed over 50 m, marked approximate.
 *
 *   IST.Review.Elevation.has(s)                 -> bool    the file recorded real heights
 *   IST.Review.Elevation.profile(s, origin)     -> prof | null   from its best lap: { name, len, closed, lat, lon, z }
 *   IST.Review.Elevation.save(prof), saved(s, origin) -> prof | null   this browser's profiles (latest 24)
 *   IST.Review.Elevation.fill(s, prof, origin)  -> bool    heights onto every lap, if the lap follows the profile
 *   IST.Review.Elevation.terrain(s, origin)     -> Promise<prof>   approximate, from AWS Terrain Tiles
 */
(function () {
  'use strict';
  IST.Review = IST.Review || {};
  const KEY = 'isloptrain.review.elev', MAX = 24, STEP = 5, R = 6371008.8, D = Math.PI / 180;
  const TILE = (z, x, y) => 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/' + z + '/' + x + '/' + y + '.png';
  const ATTRIB = 'Elevation © Mapzen, AWS Terrain Tiles';

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const frame = (o) => ({ kx: R * D * Math.cos(o.lat * D), ky: R * D });
  const best = (s) => s.laps.filter((l) => l.kind === 'full').sort((a, b) => a.time - b.time)[0] || s.laps.slice().sort((a, b) => b.len - a.len)[0];

  function has(s) {
    if (!s || !(s.channels || []).includes('alt')) return false;
    const l = best(s);
    if (!l) return false;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < l.n; i++) (lo = Math.min(lo, l.z[i])), (hi = Math.max(hi, l.z[i]));
    return hi - lo > 0.5;
  }

  /** Every STEP metres of the session's best lap, as lat / lon (and z when given). */
  function trace(s, origin, z) {
    const l = best(s);
    if (!l || !origin) return null;
    const f = frame(origin), k = Math.max(1, Math.round(STEP / (l.step || 1))), lat = [], lon = [], zz = [];
    for (let i = 0; i < l.n; i += k) {
      lat.push(origin.lat + l.y[i] / f.ky);
      lon.push(origin.lon + l.x[i] / f.kx);
      zz.push(z ? l.z[i] : 0);
    }
    return { name: norm(s.meta && s.meta.track), len: s.trackLen || l.len, closed: l.kind === 'full', lat, lon, z: zz };
  }
  const profile = (s, origin) => trace(s, origin, true);

  // ---------------------------------------------------------------- this browser's profiles
  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || {};
    } catch (e) {
      return {};
    }
  };
  function save(p) {
    if (!p || p.lat.length < 20) return;
    try {
      const c = read(), lat0 = p.lat[0], lon0 = p.lon[0];
      c[(p.name || 'unnamed') + '|' + Math.round(p.len / 10)] = {
        t: Date.now(), name: p.name, len: Math.round(p.len), closed: p.closed, lat0, lon0,
        la: p.lat.map((v) => Math.round((v - lat0) * 1e6)), lo: p.lon.map((v) => Math.round((v - lon0) * 1e6)), z: p.z.map((v) => Math.round(v * 100)),
      };
      Object.keys(c).sort((a, b) => c[b].t - c[a].t).slice(MAX).forEach((k) => delete c[k]);
      localStorage.setItem(KEY, JSON.stringify(c));
    } catch (e) {
      /* full or blocked: just don't keep it */
    }
  }
  const unpack = (e) => ({ name: e.name, len: e.len, closed: e.closed, lat: e.la.map((v) => e.lat0 + v / 1e6), lon: e.lo.map((v) => e.lon0 + v / 1e6), z: e.z.map((v) => v / 100) });
  /** Saved profiles that may be this session's track: same name and length first, then any nearby of the same length. */
  function saved(s, origin) {
    const c = read(), name = norm(s.meta && s.meta.track), len = s.trackLen || 0;
    const near = (e) => !origin || Math.hypot((e.lat0 - origin.lat) * R * D, (e.lon0 - origin.lon) * R * D * Math.cos(origin.lat * D)) < 5000;
    const lenOk = (e, tol) => !len || Math.abs(e.len - len) / Math.max(e.len, len) < tol;
    const all = Object.values(c).sort((a, b) => b.t - a.t);
    return all.filter((e) => name && e.name === name && lenOk(e, 0.03)).concat(all.filter((e) => !(name && e.name === name) && near(e) && lenOk(e, 0.05))).map(unpack);
  }

  // ---------------------------------------------------------------- matching by position
  /**
   * Each lap sample takes the height of the nearest point on the profile's line, searched near
   * the last match so a crossover (Suzuka's bridge) keeps to the level the lap is on. A lap
   * whose samples mostly sit far from the line is another layout: it's left alone.
   */
  function fillLap(lap, px, py, pz, closed) {
    const m = px.length, n = lap.n, out = new Float64Array(n), FAR = 30;
    const cell = 50, grid = new Map(), key = (x, y) => Math.floor(x / cell) + ',' + Math.floor(y / cell);
    for (let j = 0; j < m; j++) {
      const k = key(px[j], py[j]);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(j);
    }
    const seg = (j, x, y) => {
      const a = j, b = closed ? (j + 1) % m : Math.min(m - 1, j + 1);
      const dx = px[b] - px[a], dy = py[b] - py[a], L2 = dx * dx + dy * dy;
      const f = L2 > 0 ? Math.max(0, Math.min(1, ((x - px[a]) * dx + (y - py[a]) * dy) / L2)) : 0;
      return { d: Math.hypot(px[a] + dx * f - x, py[a] + dy * f - y), z: pz[a] + (pz[b] - pz[a]) * f, j };
    };
    let last = -1, hits = 0;
    for (let i = 0; i < n; i++) {
      const x = lap.x[i], y = lap.y[i];
      let b = null;
      if (last >= 0) {
        for (let o = -8; o <= 16; o++) {
          let j = last + o;
          if (closed) j = ((j % m) + m) % m;
          else if (j < 0 || j >= m) continue;
          const r = seg(j, x, y);
          if (!b || r.d < b.d) b = r;
        }
      }
      if (!b || b.d > 12) {
        const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
        for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++) (grid.get(cx + a + ',' + (cy + c)) || []).forEach((j) => {
          const r = seg(j, x, y);
          if (!b || r.d < b.d) b = r;
        });
      }
      if (b && b.d < FAR) (out[i] = b.z), (last = b.j), hits++;
      else (out[i] = NaN), (last = -1);
    }
    if (hits < n * 0.8) return false;
    // the few far samples (a trip off, a pit box) take the heights either side
    let prev = -1;
    for (let i = 0; i <= n; i++) {
      if (i < n && isNaN(out[i])) continue;
      for (let j = prev + 1; j < i; j++) out[j] = prev < 0 ? out[i] : i >= n ? out[prev] : out[prev] + (out[i] - out[prev]) * (j - prev) / (i - prev);
      prev = i;
    }
    lap.z.set(out);
    return true;
  }

  function fill(s, p, origin) {
    if (!p || !origin) return false;
    const f = frame(origin), px = p.lon.map((v) => (v - origin.lon) * f.kx), py = p.lat.map((v) => (v - origin.lat) * f.ky);
    const laps = s.laps.filter((l) => l.n > 1), done = laps.map((l) => fillLap({ n: l.n, x: l.x, y: l.y, z: new Float64Array(l.n) }, px, py, p.z, p.closed));
    if (!done.some(Boolean)) return false;
    laps.forEach((l, k) => done[k] && fillLap(l, px, py, p.z, p.closed));
    return true;
  }

  // ---------------------------------------------------------------- approximate, from terrain tiles
  /** Gaussian along the profile, sigma in metres; wraps round a whole lap. */
  function smooth(a, sigma, closed) {
    const n = a.length, w = Math.ceil((3 * sigma) / STEP), k = [];
    for (let i = -w; i <= w; i++) k.push(Math.exp(-0.5 * ((i * STEP) / sigma) ** 2));
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, t = 0;
      for (let o = -w; o <= w; o++) {
        let j = i + o;
        if (closed) j = ((j % n) + n) % n;
        else if (j < 0 || j >= n) continue;
        s += a[j] * k[o + w];
        t += k[o + w];
      }
      out[i] = s / t;
    }
    return out;
  }
  /** Terrarium encoding: (R * 256 + G + B / 256) - 32768 metres. */
  const decode = (px, o) => px[o] * 256 + px[o + 1] + px[o + 2] / 256 - 32768;

  const tiles = new Map();
  function tile(z, x, y) {
    const k = z + '/' + x + '/' + y;
    if (!tiles.has(k)) {
      tiles.set(k, fetch(TILE(z, x, y)).then((r) => {
        if (!r.ok) throw new Error('terrain tile ' + r.status);
        return r.blob();
      }).then(createImageBitmap).then((img) => {
        const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(256, 256) : Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, 256, 256).data;
      }).catch((e) => {
        tiles.delete(k);
        throw e;
      }));
    }
    return tiles.get(k);
  }

  async function terrain(s, origin) {
    const p = trace(s, origin, false);
    if (!p) throw new Error('no position to look heights up');
    // the finest zoom that keeps the lap to a few dozen tiles
    let z = 15, pix;
    for (; z >= 12; z--) {
      const n = 2 ** z * 256;
      pix = p.lat.map((la, i) => [(p.lon[i] + 180) / 360 * n - 0.5, (1 - Math.log(Math.tan(la * D) + 1 / Math.cos(la * D)) / Math.PI) / 2 * n - 0.5]);
      const need = new Set();
      pix.forEach(([x, y]) => [0, 1].forEach((a) => [0, 1].forEach((b) => need.add(((x + a) >> 8) + ',' + ((y + b) >> 8)))));
      if (need.size <= 64 || z === 12) break;
    }
    const got = new Map();
    await Promise.all([...new Set(pix.flatMap(([x, y]) => [0, 1].flatMap((a) => [0, 1].map((b) => ((Math.floor(x) + a) >> 8) + ',' + ((Math.floor(y) + b) >> 8)))))].map((k) => {
      const [tx, ty] = k.split(',').map(Number);
      return tile(z, tx, ty).then((d) => got.set(k, d));
    }));
    const at = (X, Y) => decode(got.get((X >> 8) + ',' + (Y >> 8)), ((Y & 255) * 256 + (X & 255)) * 4);
    const raw = pix.map(([x, y]) => {
      const X = Math.floor(x), Y = Math.floor(y), fx = x - X, fy = y - Y;
      return (at(X, Y) * (1 - fx) + at(X + 1, Y) * fx) * (1 - fy) + (at(X, Y + 1) * (1 - fx) + at(X + 1, Y + 1) * fx) * fy;
    });
    p.z = smooth(raw, 50, p.closed);
    p.approx = true;
    return p;
  }

  IST.Review.Elevation = { has, profile, save, saved, fill, terrain, smooth, decode, ATTRIB, KEY };
})();
