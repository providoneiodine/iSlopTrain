/*
 * Where the track's edges really are, either side of the map's centreline. A sim's own
 * telemetry (an iRacing .ibt, with the surface under the car) is exact to the centimetre, so
 * kerb strikes (rumble-strip material under the car) and how far the laps spread on
 * asphalt pin each edge; GPS laps (Garage 61, phone loggers) aren't, so they borrow
 * what an .ibt taught this browser about that track.
 *
 *   IST.Review.Edges.learn(laps, lines, halfWidth)
 *       -> { x, y, tx, ty, l, r, q, step } | null
 *     laps: a session's laps in its own frame, the best full lap first; lines: the
 *     map's track lines in the same frame (track.js). A centreline every ~2 m under
 *     the first lap, with each edge's distance from it (l left, r right, m) and how it
 *     was found (q: 2 kerb strikes, 1 the laps' spread, 0 the map's width or a typical one).
 *   IST.Review.Edges.save(key, profile, geo)   kept in this browser, merged with what's there
 *   IST.Review.Edges.onGrid(key, geo, cx, cy, n) -> { l, r, q } | null
 *     The stored edges at each point of a centre (cx, cy: the comparison's grid, in the
 *     frame geo maps); NaN (q 0) where nothing was stored.
 *
 * Stored in localStorage under KEY as { [track key]: { t, d } }: d is flat integers,
 * per point lat / lon (1e-6 degrees, each a step from the one before), heading
 * (degrees), left and right (decimetres) and q. The latest 16 tracks are kept. Only
 * the geometry of the track is stored, never a lap.
 */
(function () {
  'use strict';
  IST.Review = IST.Review || {};
  const KEY = 'isloptrain.review.edges', MAX = 16;
  const TYPICAL = 6.5; // half a typical circuit's width, m
  const KERB_OUT = 0.4; // the car's centre on a kerb to the road's outer edge, m
  const R_EARTH = 6371008.8, DEG = Math.PI / 180;
  // on the road: asphalt, concrete, racing dirt, rumble strips (not paint: painted run-off)
  const onRoad = (m) => (m >= 1 && m <= 8) || (m >= 11 && m <= 14);

  const mem = new Map(); // key -> decoded points, so a blocked store still works this visit

  /** Points in a uniform grid: each(x, y, r, fn(k)) visits those within r cells' reach. */
  function gridOf(X, Y, cell) {
    const g = new Map(), key = (i, j) => i * 73856093 + j;
    for (let k = 0; k < X.length; k++) {
      const h = key(Math.floor(X[k] / cell), Math.floor(Y[k] / cell));
      if (!g.has(h)) g.set(h, []);
      g.get(h).push(k);
    }
    return (x, y, fn) => {
      const ci = Math.floor(x / cell), cj = Math.floor(y / cell);
      for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
        const L = g.get(key(i, j));
        if (L) L.forEach(fn);
      }
    };
  }
  const tangent = (X, Y, n, i) => {
    const a = Math.max(0, i - 3), b = Math.min(n - 1, i + 3);
    const tx = X[b] - X[a], ty = Y[b] - Y[a], l = Math.hypot(tx, ty) || 1;
    return [tx / l, ty / l];
  };
  /** Running max (or mean) over ±w samples. */
  function windowed(a, w, mean) {
    const n = a.length, o = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let m = mean ? 0 : -Infinity, c = 0;
      for (let k = Math.max(0, i - w); k <= Math.min(n - 1, i + w); k++) {
        if (!(a[k] === a[k])) continue;
        if (mean) (m += a[k]), c++;
        else m = Math.max(m, a[k]);
      }
      o[i] = mean ? (c ? m / c : NaN) : m;
    }
    return o;
  }

  function learn(laps, lines, halfWidth) {
    const ref = laps[0], Tk = IST.Review.Track;
    if (!ref || !lines || !lines.length) return null;
    const c = Tk.centreOn(ref.x, ref.y, lines, ref.step);
    if (!c) return null;
    const stride = Math.max(1, Math.round(2 / ref.step)), step = stride * ref.step;
    const np = Math.floor((ref.n - 1) / stride) + 1;
    const x = new Float32Array(np), y = new Float32Array(np), tx = new Float32Array(np), ty = new Float32Array(np);
    for (let k = 0; k < np; k++) (x[k] = c.x[k * stride]), (y[k] = c.y[k * stride]);
    for (let k = 0; k < np; k++) [tx[k], ty[k]] = tangent(x, y, np, k);

    // each lap onto the profile: its nearest point running the same way, within 20 m
    const spread = [new Float32Array(np).fill(NaN), new Float32Array(np).fill(NaN)];
    const onP = laps.map((L) => {
      const off = new Float32Array(np).fill(NaN), material = new Uint8Array(np);
      const each = gridOf(L.x, L.y, 20);
      for (let k = 0; k < np; k++) {
        let best = -1, bd = 400;
        each(x[k], y[k], (j) => {
          const d = (L.x[j] - x[k]) ** 2 + (L.y[j] - y[k]) ** 2;
          if (d >= bd) return;
          const t = tangent(L.x, L.y, L.n, j);
          if (t[0] * tx[k] + t[1] * ty[k] > 0.7) (bd = d), (best = j);
        });
        if (best < 0) continue;
        const o = (L.x[best] - x[k]) * -ty[k] + (L.y[best] - y[k]) * tx[k];
        off[k] = o;
        material[k] = L.material ? L.material[best] : 0;
        if (!L.material || onRoad(material[k])) {
          const s = o >= 0 ? 0 : 1, v = Math.abs(o);
          if (!(spread[s][k] >= v)) spread[s][k] = v;
        }
      }
      return { off, material, start: 0, end: np - 1 };
    });
    const runs = Tk.kerbRuns(onP.filter((p, i) => laps[i].material), np, step);

    const l = new Float32Array(np), r = new Float32Array(np), q = new Uint8Array(np);
    const W60 = Math.round(60 / step), W6 = Math.round(6 / step), W4 = Math.round(4 / step);
    [l, r].forEach((E, s) => {
      const sp = spread[s], wide = windowed(sp, W60), near = windowed(sp, W4);
      // the kerbs on this side: where the car's centre ran on them, out to the edge
      const K = runs.filter((u) => (s ? u.at < 0 : u.at > 0)).map((u) => ({ i0: u.i0, i1: u.i1, v: Math.abs(u.at) + KERB_OUT }));
      const fade = (d) => Math.max(0, 1 - (d * step) / 80);
      let h = 0;
      const raw = new Float32Array(np), w = new Float32Array(np);
      for (let k = 0; k < np; k++) {
        const base = halfWidth > 0 ? halfWidth : isFinite(wide[k]) ? Math.max(4, Math.min(12, wide[k] + 0.3)) : TYPICAL;
        while (h < K.length && K[h].i1 < k) h++;
        const a = K[h - 1], b = K[h];
        let v = base, wt = 0;
        if (b && b.i0 <= k) (v = b.v), (wt = 1);
        else if (a && b) {
          const f = (k - a.i1) / Math.max(1, b.i0 - a.i1);
          (v = a.v + (b.v - a.v) * f), (wt = Math.max(fade(k - a.i1), fade(b.i0 - k)));
        } else if (a || b) (v = (a || b).v), (wt = fade(a ? k - a.i1 : b.i0 - k));
        raw[k] = base + (v - base) * wt;
        w[k] = wt;
      }
      const sm = windowed(raw, W6, true);
      for (let k = 0; k < np; k++) {
        // never inside where a lap ran on the road
        E[k] = Math.min(20, isFinite(near[k]) ? Math.max(sm[k], near[k] + 0.3) : sm[k]);
        q[k] = Math.max(q[k], w[k] > 0.5 ? 2 : isFinite(near[k]) && halfWidth <= 0 ? 1 : 0);
      }
    });
    return { x, y, tx, ty, l, r, q, step };
  }

  // -------------------------------------------------------------- storage
  const readAll = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || {};
    } catch (e) {
      return {};
    }
  };
  /** -> [{ lat, lon, h (deg), l, r, q }] */
  function decode(d) {
    const out = [];
    let la = 0, lo = 0;
    for (let k = 0; k + 5 < d.length; k += 6) {
      la += d[k];
      lo += d[k + 1];
      out.push({ lat: la / 1e6, lon: lo / 1e6, h: d[k + 2], l: d[k + 3] / 10, r: d[k + 4] / 10, q: d[k + 5] });
    }
    return out;
  }
  function encode(pts) {
    const d = [];
    let la = 0, lo = 0;
    pts.forEach((p) => {
      const a = Math.round(p.lat * 1e6), b = Math.round(p.lon * 1e6);
      d.push(a - la, b - lo, Math.round(p.h), Math.round(p.l * 10), Math.round(p.r * 10), p.q);
      (la = a), (lo = b);
    });
    return d;
  }
  function get(key) {
    if (!key) return null;
    if (!mem.has(key)) {
      const rec = readAll()[key];
      mem.set(key, rec && rec.d ? decode(rec.d) : null);
    }
    return mem.get(key);
  }

  function save(key, P, geo) {
    if (!key || !P || !geo) return;
    const fresh = [];
    for (let k = 0; k < P.x.length; k += 2) {
      const a = geo.toLL(P.x[k], P.y[k]), b = geo.toLL(P.x[k] + P.tx[k], P.y[k] + P.ty[k]);
      const kx = Math.cos(a[0] * DEG);
      fresh.push({ lat: a[0], lon: a[1], h: ((Math.atan2((b[1] - a[1]) * kx, b[0] - a[0]) / DEG) + 360) % 360, l: P.l[k], r: P.r[k], q: P.q[k] });
    }
    if (!fresh.length) return;
    // a layout driven before keeps its points; where this one runs, the better-measured wins
    const old = get(key) || [], lat0 = fresh[0].lat, lon0 = fresh[0].lon;
    const kx = R_EARTH * DEG * Math.cos(lat0 * DEG), ky = R_EARTH * DEG;
    const fx = fresh.map((p) => (p.lon - lon0) * kx), fy = fresh.map((p) => (p.lat - lat0) * ky);
    const each = gridOf(fx, fy, 10), dropNew = new Set();
    const kept = old.filter((o) => {
      const ox = (o.lon - lon0) * kx, oy = (o.lat - lat0) * ky;
      let keep = true;
      each(ox, oy, (j) => {
        if ((fx[j] - ox) ** 2 + (fy[j] - oy) ** 2 > 16) return;
        const dh = Math.abs(((fresh[j].h - o.h + 540) % 360) - 180);
        if (dh > 60) return;
        if (o.q > fresh[j].q) dropNew.add(j);
        else keep = false;
      });
      return keep;
    });
    const pts = kept.concat(fresh.filter((p, j) => !dropNew.has(j)));
    mem.set(key, pts);
    try {
      const all = readAll();
      all[key] = { t: Date.now(), d: encode(pts) };
      Object.keys(all).sort((a, b) => all[b].t - all[a].t).slice(MAX).forEach((k) => delete all[k]);
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch (e) {
      /* full or blocked: kept for this visit only */
    }
  }

  function onGrid(key, geo, cx, cy, n) {
    const pts = get(key);
    if (!pts || !pts.length || !geo) return null;
    const ky = R_EARTH * DEG;
    const X = new Float32Array(pts.length), Y = new Float32Array(pts.length), TX = new Float32Array(pts.length), TY = new Float32Array(pts.length);
    pts.forEach((p, k) => {
      const a = geo.toXY(p.lat, p.lon), kx = ky * Math.cos(p.lat * DEG);
      const b = geo.toXY(p.lat + Math.cos(p.h * DEG) / ky, p.lon + Math.sin(p.h * DEG) / kx);
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      (X[k] = a[0]), (Y[k] = a[1]), (TX[k] = (b[0] - a[0]) / l), (TY[k] = (b[1] - a[1]) / l);
    });
    const each = gridOf(X, Y, 10);
    const l = new Float32Array(n).fill(NaN), r = new Float32Array(n).fill(NaN), q = new Uint8Array(n);
    let any = false;
    for (let i = 0; i < n; i++) {
      const t = tangent(cx, cy, n, i);
      let best = -1, bd = 36, dot = 0;
      each(cx[i], cy[i], (k) => {
        const d = (X[k] - cx[i]) ** 2 + (Y[k] - cy[i]) ** 2, c = TX[k] * t[0] + TY[k] * t[1];
        if (d < bd && Math.abs(c) > 0.7) (bd = d), (best = k), (dot = c);
      });
      if (best < 0) continue;
      const p = pts[best];
      // driven the other way round: its left is our right
      (l[i] = dot > 0 ? p.l : p.r), (r[i] = dot > 0 ? p.r : p.l), (q[i] = p.q), (any = true);
    }
    return any ? { l, r, q } : null;
  }

  IST.Review.Edges = { learn, save, onGrid, KEY, TYPICAL };
})();
