/*
 * Track geometry from map data: the true centreline under a lap, and how to
 * line up laps that have no GPS with a map. Pure functions, no DOM, no network
 * (mapdata.js fetches; this file only does the geometry).
 *
 *   IST.Review.Track.centreOn(x, y, lines, step)
 *       -> { x, y, ok (share of the lap matched) } | null
 *     For each point of a lap (x, y: arrays in metres), the nearest point on
 *     the map's track lines (lines: [[[x, y], ...], ...], same frame) that runs
 *     the same way. The offsets are smoothed and gaps bridged, so the result
 *     is a centreline on the lap's own distance grid. null if under 70 % of
 *     the lap found a line.
 *   IST.Review.Track.fit(x, y, lines)  -> { m: [a, b, c, d, tx, ty], med, p90 } | null
 *     The rigid transform (rotation, translation, maybe a mirror) that puts
 *     the lap on the lines: X = a x + b y + tx, Y = c x + d y + ty. For sims
 *     that log their own world coordinates. Tries every heading and both
 *     handednesses, refines by ICP, and rejects a fit whose median miss is
 *     over 4 m (wrong track, or a layout the map doesn't have).
 *   IST.Review.Track.apply(m, p), invert(m)
 *   IST.Review.Track.geo(lat0, lon0, m?)  local metres <-> lat / lon
 *     { toXY(lat, lon) -> [x, y], toLL(x, y) -> [lat, lon] }. Matches laps.js:
 *     east and north metres from the origin on a flat earth, then m (a
 *     transform from those metres into the session's frame; identity for GPS).
 *
 * OSM draws raceways along the middle of the asphalt to within a couple of
 * metres where it's traced from imagery. That's the "ground truth" here; the
 * satellite image under it is the check.
 */
(function () {
  'use strict';
  IST.Review = IST.Review || {};
  const R_EARTH = 6371008.8, DEG = Math.PI / 180;

  /** Segments of the lines in a uniform grid, for nearest-point queries. */
  function segIndex(lines, cell) {
    const segs = [];
    lines.forEach((L, w) => {
      for (let k = 1; k < L.length; k++) {
        const a = L[k - 1], b = L[k];
        const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
        if (l > 1e-6) segs.push({ ax: a[0], ay: a[1], dx, dy, l, tx: dx / l, ty: dy / l, w });
      }
    });
    const grid = new Map();
    const key = (i, j) => i * 73856093 + j;
    segs.forEach((s, k) => {
      const i0 = Math.floor(Math.min(s.ax, s.ax + s.dx) / cell), i1 = Math.floor(Math.max(s.ax, s.ax + s.dx) / cell);
      const j0 = Math.floor(Math.min(s.ay, s.ay + s.dy) / cell), j1 = Math.floor(Math.max(s.ay, s.ay + s.dy) / cell);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const g = key(i, j);
        if (!grid.has(g)) grid.set(g, []);
        grid.get(g).push(k);
      }
    });
    /** Candidates within r of (x, y): [{ x, y, d, tx, ty }] */
    function near(x, y, r) {
      const out = [], seen = new Set();
      const i0 = Math.floor((x - r) / cell), i1 = Math.floor((x + r) / cell), j0 = Math.floor((y - r) / cell), j1 = Math.floor((y + r) / cell);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const list = grid.get(key(i, j));
        if (!list) continue;
        for (const k of list) {
          if (seen.has(k)) continue;
          seen.add(k);
          const s = segs[k];
          const u = (x - s.ax) * s.tx + (y - s.ay) * s.ty, t = Math.max(0, Math.min(s.l, u));
          const px = s.ax + s.tx * t, py = s.ay + s.ty * t, d = Math.hypot(x - px, y - py);
          // end: the foot falls past the segment's end (u outside it by more than a hair)
          if (d <= r) out.push({ x: px, y: py, d, tx: s.tx, ty: s.ty, w: s.w, end: u < -0.5 || u > s.l + 0.5 });
        }
      }
      return out;
    }
    return { near, count: segs.length };
  }

  function centreOn(x, y, lines, step) {
    const n = x.length;
    if (!lines || !lines.length || n < 10) return null;
    const I = segIndex(lines, 25);
    if (!I.count) return null;
    const R = 30; // a lap is never further than this from the middle of the road
    const ox = new Float64Array(n), oy = new Float64Array(n), has = new Uint8Array(n);
    let prev = null, prevW = -1;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 3), b = Math.min(n - 1, i + 3);
      let hx = x[b] - x[a], hy = y[b] - y[a];
      const hl = Math.hypot(hx, hy) || 1;
      hx /= hl;
      hy /= hl;
      let best = null, bs = Infinity;
      for (const c of I.near(x[i], y[i], R)) {
        // a way's loose end isn't the road beside us: the car drives on past it, and the
        // next way (or the next segment, round a bend) carries on from there
        if (c.end) continue;
        // same direction of travel (either way along the way: OSM direction is arbitrary)
        if (Math.abs(c.tx * hx + c.ty * hy) < 0.8) continue;
        // nearest wins, but stay on the way we're on while it lasts: a bike or club
        // layout's branch can run closer to a lap that cuts a chicane
        const jump = prev ? Math.hypot(c.x - x[i] - prev[0], c.y - y[i] - prev[1]) : 0;
        const s = c.d + 0.3 * jump + (prevW >= 0 && c.w !== prevW ? 8 : 0);
        if (s < bs) (bs = s), (best = c);
      }
      if (best) {
        ox[i] = best.x - x[i];
        oy[i] = best.y - y[i];
        has[i] = 1;
        prev = [ox[i], oy[i]];
        prevW = best.w;
      }
    }
    let matched = 0;
    for (let i = 0; i < n; i++) matched += has[i];
    if (matched < n * 0.7) return null;
    // bridge gaps linearly (wrapping round the lap)
    const idx = [];
    for (let i = 0; i < n; i++) if (has[i]) idx.push(i);
    for (let k = 0; k < idx.length; k++) {
      const a = idx[k], b = idx[(k + 1) % idx.length], span = (b - a + n) % n || n;
      for (let j = 1; j < span; j++) {
        const i = (a + j) % n, f = j / span;
        ox[i] = ox[a] + (ox[b] - ox[a]) * f;
        oy[i] = oy[a] + (oy[b] - oy[a]) * f;
      }
    }
    // a median over ±10 m drops brief flips onto a neighbouring branch
    const Wm = Math.max(1, Math.round(10 / (step || 1)));
    const med = (a) => {
      const o = new Float64Array(n), win = [];
      for (let i = 0; i < n; i++) {
        win.length = 0;
        for (let k = -Wm; k <= Wm; k++) win.push(a[Math.min(n - 1, Math.max(0, i + k))]);
        win.sort((p, q) => p - q);
        o[i] = win[Wm];
      }
      return o;
    };
    const mx = med(ox), my = med(oy);
    ox.set(mx);
    oy.set(my);
    // then smooth over ±8 m: the map line is drawn in straight pieces
    const W = Math.max(1, Math.round(8 / (step || 1)));
    const sx = new Float64Array(n), sy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let ax = 0, ay = 0, c = 0;
      for (let k = -W; k <= W; k++) {
        const j = Math.min(n - 1, Math.max(0, i + k));
        ax += ox[j];
        ay += oy[j];
        c++;
      }
      sx[i] = x[i] + ax / c;
      sy[i] = y[i] + ay / c;
    }
    return { x: sx, y: sy, ok: matched / n };
  }

  // ------------------------------------------------------------- rigid fit
  const apply = (m, p) => [m[0] * p[0] + m[1] * p[1] + m[4], m[2] * p[0] + m[3] * p[1] + m[5]];
  function invert(m) {
    const det = m[0] * m[3] - m[1] * m[2];
    const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
    return [a, b, c, d, -(a * m[4] + b * m[5]), -(c * m[4] + d * m[5])];
  }

  /** Dense points along the lines, gridded for nearest lookups. */
  function pointIndex(lines, spacing, cell) {
    const P = [];
    lines.forEach((L) => {
      for (let k = 1; k < L.length; k++) {
        const a = L[k - 1], b = L[k], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const m = Math.max(1, Math.ceil(l / spacing));
        for (let j = 0; j < m; j++) P.push([a[0] + ((b[0] - a[0]) * j) / m, a[1] + ((b[1] - a[1]) * j) / m]);
      }
      if (L.length) P.push(L[L.length - 1]);
    });
    const grid = new Map(), key = (i, j) => i * 73856093 + j;
    P.forEach((p, k) => {
      const g = key(Math.floor(p[0] / cell), Math.floor(p[1] / cell));
      if (!grid.has(g)) grid.set(g, []);
      grid.get(g).push(k);
    });
    function nearest(x, y, maxRing) {
      const ci = Math.floor(x / cell), cj = Math.floor(y / cell);
      let best = -1, bd = Infinity;
      for (let r = 0; r <= maxRing; r++) {
        for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
          const list = grid.get(key(i, j));
          if (!list) continue;
          for (const k of list) {
            const d = (P[k][0] - x) ** 2 + (P[k][1] - y) ** 2;
            if (d < bd) (bd = d), (best = k);
          }
        }
        if (best >= 0 && Math.sqrt(bd) < r * cell) break;
      }
      return best < 0 ? null : { p: P[best], d: Math.sqrt(bd) };
    }
    let cx = 0, cy = 0;
    P.forEach((p) => ((cx += p[0]), (cy += p[1])));
    return { nearest, centroid: [cx / (P.length || 1), cy / (P.length || 1)], count: P.length };
  }

  /** Best rotation + translation taking src to dst (2D Procrustes, no scale, no mirror). */
  function procrustes(src, dst) {
    const n = src.length;
    let sx = 0, sy = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) (sx += src[i][0]), (sy += src[i][1]), (dx += dst[i][0]), (dy += dst[i][1]);
    sx /= n; sy /= n; dx /= n; dy /= n;
    let sc = 0, ss = 0;
    for (let i = 0; i < n; i++) {
      const ax = src[i][0] - sx, ay = src[i][1] - sy, bx = dst[i][0] - dx, by = dst[i][1] - dy;
      sc += ax * bx + ay * by;
      ss += ax * by - ay * bx;
    }
    const th = Math.atan2(ss, sc), c = Math.cos(th), s = Math.sin(th);
    return [c, -s, s, c, dx - (c * sx - s * sy), dy - (s * sx + c * sy)];
  }
  const compose = (A, B) => [ // A after B
    A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3],
    A[0] * B[4] + A[1] * B[5] + A[4], A[2] * B[4] + A[3] * B[5] + A[5],
  ];

  function fit(x, y, lines) {
    const n = x.length;
    if (!lines || !lines.length || n < 50) return null;
    const I = pointIndex(lines, 1, 40);
    if (I.count < 20) return null;
    // ~250 points along the lap
    const stride = Math.max(1, Math.floor(n / 250));
    const src = [];
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i += stride) src.push([x[i], y[i]]), (sx += x[i]), (sy += y[i]);
    sx /= src.length;
    sy /= src.length;
    const run = (m0, iters) => {
      let m = m0, med = Infinity, p90 = Infinity;
      for (let it = 0; it < iters; it++) {
        const pairs = [];
        src.forEach((p) => {
          const q = apply(m, p), hit = I.nearest(q[0], q[1], 4);
          if (hit) pairs.push({ p, q: hit.p, d: hit.d });
        });
        if (pairs.length < src.length * 0.5) return { m, med: Infinity, p90: Infinity };
        const ds = pairs.map((e) => e.d).sort((a, b) => a - b);
        med = ds[ds.length >> 1];
        p90 = ds[Math.floor(ds.length * 0.9)];
        const cut = Math.max(5, med * 3);
        const keep = pairs.filter((e) => e.d <= cut);
        const mir = m[0] * m[3] - m[1] * m[2] < 0;
        // solve in the un-mirrored frame so the step stays a rotation
        const pre = mir ? [1, 0, 0, -1, 0, 0] : [1, 0, 0, 1, 0, 0];
        const step = procrustes(keep.map((e) => apply(pre, e.p)), keep.map((e) => e.q));
        m = compose(step, pre);
      }
      return { m, med, p90 };
    };
    let best = null;
    [1, -1].forEach((mir) => {
      for (let deg = 0; deg < 360; deg += 15) {
        const t = deg * DEG, c = Math.cos(t), s = Math.sin(t);
        const r = [c, -s * mir, s, c * mir];
        const tx = I.centroid[0] - (r[0] * sx + r[1] * sy), ty = I.centroid[1] - (r[2] * sx + r[3] * sy);
        const f = run([r[0], r[1], r[2], r[3], tx, ty], 8);
        if (!best || f.med < best.med) best = f;
      }
    });
    if (!best || !isFinite(best.med)) return null;
    best = run(best.m, 60);
    if (best.med > 4 || best.p90 > 15) return null;
    return best;
  }

  // ------------------------------------------------------------------ geo
  function geo(lat0, lon0, m) {
    const kx = R_EARTH * DEG * Math.cos(lat0 * DEG), ky = R_EARTH * DEG;
    const M = m || [1, 0, 0, 1, 0, 0], Mi = invert(M);
    return {
      lat0, lon0, m: M,
      toXY: (lat, lon) => apply(M, [(lon - lon0) * kx, (lat - lat0) * ky]),
      toLL: (x, y) => {
        const e = apply(Mi, [x, y]);
        return [lat0 + e[1] / ky, lon0 + e[0] / kx];
      },
    };
  }

  IST.Review.Track = { centreOn, fit, apply, invert, geo };
})();
