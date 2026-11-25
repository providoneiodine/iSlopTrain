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
 *   IST.Review.Track.align(x, y, lines)
 *       -> { m, fitted, shift, med, cover } | null
 *     For GPS laps: a shift (ICP, translation, plus a turn of up to 2° on laps
 *     over 1.5 km across) onto the lines, kept when no point moves over 150 m
 *     and it cuts the median miss by over half a metre.
 *     cover is the share of the lap within 25 m of a line; low means the GPS
 *     spot isn't the track the lap was driven on.
 *   IST.Review.Track.roadProbe(cx, cy, n, step), roadShift(probe, score), asphalt(r, g, b)
 *     Where the satellite image's road sits against the map's centre, and
 *     how wide it is, from how asphalt-like the pixels are across it.
 *   IST.Review.Track.keepOn(offs, n, step, road?, hw?)
 *     How far to slide a road sideways so the laps stay on it (only where
 *     they all leave it on one side): the map's road (laps moved, compare.js)
 *     and the image's (image moved, maplayer.js).
 *   IST.Review.Track.kerbRuns(laps, n, step), kerbProbe(cx, cy, n, step, runs),
 *       kerbShift(probe, score, road?), anchorField(anchors, n, step)
 *     Kerb strikes in telemetry pin where the road's edge is; finding that
 *     edge in the image (where grey asphalt gives way, whatever the kerb's
 *     colours) says how far off the image is there, better than the
 *     asphalt-band estimate alone.
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

  /** About 250 points along the lap, and their centroid. */
  function sample(x, y) {
    const n = x.length, stride = Math.max(1, Math.floor(n / 250)), src = [];
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i += stride) src.push([x[i], y[i]]), (sx += x[i]), (sy += y[i]);
    return { src, c: [sx / src.length, sy / src.length] };
  }

  /** ICP from m0: pair each lap point with the nearest line point, solve, repeat. */
  function icp(I, src, m0, iters) {
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
  }

  /** Share of the lap's points within r metres of a line once moved by m. */
  function cover(I, src, m, r) {
    let k = 0;
    src.forEach((p) => {
      const q = apply(m, p), hit = I.nearest(q[0], q[1], 1);
      if (hit && hit.d <= r) k++;
    });
    return k / (src.length || 1);
  }

  function fit(x, y, lines) {
    const n = x.length;
    if (!lines || !lines.length || n < 50) return null;
    const I = pointIndex(lines, 1, 40);
    if (I.count < 20) return null;
    const { src, c } = sample(x, y);
    let best = null;
    [1, -1].forEach((mir) => {
      for (let deg = 0; deg < 360; deg += 15) {
        const t = deg * DEG, cs = Math.cos(t), s = Math.sin(t);
        const r = [cs, -s * mir, s, cs * mir];
        const tx = I.centroid[0] - (r[0] * c[0] + r[1] * c[1]), ty = I.centroid[1] - (r[2] * c[0] + r[3] * c[1]);
        const f = icp(I, src, [r[0], r[1], r[2], r[3], tx, ty], 8);
        if (!best || f.med < best.med) best = f;
      }
    });
    if (!best || !isFinite(best.med)) return null;
    best = icp(I, src, best.m, 60);
    if (best.med > 4 || best.p90 > 15) return null;
    return best;
  }

  /** Median distance from the lap's points (moved by m) to the nearest line. */
  function medianMiss(I, src, m) {
    const ds = [];
    src.forEach((p) => {
      const q = apply(m, p), hit = I.nearest(q[0], q[1], 4);
      if (hit) ds.push(hit.d);
    });
    ds.sort((a, b) => a - b);
    return ds.length > src.length * 0.5 ? ds[ds.length >> 1] : Infinity;
  }

  /** Diagonal of the points' bounding box, metres. */
  const span = (pts) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    pts.forEach((p) => ((x0 = Math.min(x0, p[0])), (x1 = Math.max(x1, p[0])), (y0 = Math.min(y0, p[1])), (y1 = Math.max(y1, p[1]))));
    return Math.hypot(x1 - x0, y1 - y0);
  };
  function align(x, y, lines) {
    if (!lines || !lines.length || x.length < 20) return null;
    const I = pointIndex(lines, 1, 40);
    if (I.count < 20) return null;
    const { src } = sample(x, y);
    const id = [1, 0, 0, 1, 0, 0], raw = cover(I, src, id, 25);
    // translation only: GPS error is an offset, and a turn is poorly pinned on a part lap
    let tx = 0, ty = 0;
    for (let it = 0; it < 40; it++) {
      const pairs = [];
      src.forEach((p) => {
        const hit = I.nearest(p[0] + tx, p[1] + ty, 4);
        if (hit) pairs.push({ ex: hit.p[0] - p[0] - tx, ey: hit.p[1] - p[1] - ty, d: hit.d });
      });
      if (pairs.length < src.length * 0.5) break;
      const ds = pairs.map((e) => e.d).sort((a, b) => a - b), cut = Math.max(5, ds[ds.length >> 1] * 3);
      let sx = 0, sy = 0, k = 0;
      pairs.forEach((e) => e.d <= cut && ((sx += e.ex), (sy += e.ey), k++));
      if (!k) break;
      tx += sx / k;
      ty += sy / k;
      if (Math.hypot(sx / k, sy / k) < 0.01) break;
    }
    let m = [1, 0, 0, 1, tx, ty], med = medianMiss(I, src, m);
    const med0 = medianMiss(I, src, id);
    // a long lap whose GPS is turned a little about the origin (iRacing's Le Mans: 0.6°, 50 m off
    // at Mulsanne) is pinned well enough to also take a small turn
    if (med > 3 && span(src) > 1500) {
      const r = icp(I, src, m, 40), turn = Math.abs(Math.atan2(r.m[2], r.m[0])) / DEG;
      if (r.m[0] * r.m[3] - r.m[1] * r.m[2] > 0 && turn <= 2 && r.med < med - 0.5) (m = r.m), (med = r.med);
    }
    // how far the nudge moves the lap, at most
    const shift = src.reduce((s, p) => Math.max(s, Math.hypot(apply(m, p)[0] - p[0], apply(m, p)[1] - p[1])), 0);
    // keep the nudge only when it's a clear improvement, close to where GPS put the lap
    const ok = med <= 6 && shift >= 1 && shift <= 150 && med < med0 - 0.5;
    const fitted = ok ? cover(I, src, m, 25) : 0;
    return { m: ok ? m : id, fitted: ok, shift: ok ? shift : 0, med: ok ? med : med0, cover: Math.max(raw, fitted) };
  }

  // ------------------------------------------------------- imagery check
  const PROBE_EVERY = 4, PROBE_HALF = 30; // m along the centre, m either side of it

  /** Points across the road every few metres: imagery is scored at each (see roadShift). */
  function roadProbe(cx, cy, n, step) {
    const every = Math.max(1, Math.round(PROBE_EVERY / step)), idx = [], nx = [], ny = [], pts = [];
    for (let i = 0; i < n; i += every) {
      const a = Math.max(0, i - 3), b = Math.min(n - 1, i + 3);
      const tx = cx[b] - cx[a], ty = cy[b] - cy[a], l = Math.hypot(tx, ty);
      if (!l) continue;
      idx.push(i);
      nx.push(-ty / l);
      ny.push(tx / l);
      for (let u = -PROBE_HALF; u <= PROBE_HALF; u++) pts.push([cx[i] - (ty / l) * u, cy[i] + (tx / l) * u]);
    }
    return { idx, nx, ny, pts, w: 2 * PROBE_HALF + 1, n, step };
  }

  /**
   * Where the road in the imagery sits from the map's centre (at, m, + left) and its half
   * width (half), along the lap: -> { at, half }.
   * score: per probe point, how asphalt-like the pixel there is (0..1, NaN unknown). Stretches
   * where the road is unclear (trees, shadow) are bridged from their neighbours; null when
   * too little of the lap gives a clear answer.
   */
  function roadShift(P, score) {
    const W = P.w, MAX = 15, D = 2 * MAX + 1, m = P.idx.length, HS = [4, 5, 6, 7, 8, 9];
    // per probe line, prefix sums so any band's mean is two lookups
    const sum = new Float32Array(m * (W + 1)), cnt = new Uint16Array(m * (W + 1));
    for (let k = 0; k < m; k++) {
      for (let j = 0; j < W; j++) {
        const v = score[k * W + j], o = k * (W + 1) + j;
        sum[o + 1] = sum[o] + (v >= 0 ? v : 0);
        cnt[o + 1] = cnt[o] + (v >= 0 ? 1 : 0);
      }
    }
    const band = (k, j0, j1, out) => {
      j0 = Math.max(0, j0);
      j1 = Math.min(W - 1, j1);
      if (j1 < j0) return;
      const o = k * (W + 1);
      out[0] += sum[o + j1 + 1] - sum[o + j0];
      out[1] += cnt[o + j1 + 1] - cnt[o + j0];
    };
    // stretches of ~100 m, half overlapping: the road-wide band (any width) most asphalt-like
    // against its verges, nudged towards no shift
    const per = Math.max(4, Math.round(100 / PROBE_EVERY)), hop = per >> 1, cent = [], val = [], half = [];
    const I = [0, 0], O = [0, 0];
    for (let a = 0; a < m; a += hop) {
      const b = Math.min(m, a + per);
      let best = -Infinity, bd = 0, bh = 5, zero = -Infinity;
      for (const H of HS) for (let d = -MAX; d <= MAX; d++) {
        let t = 0, c = 0;
        for (let k = a; k < b; k++) {
          const j = PROBE_HALF + d;
          I[0] = I[1] = O[0] = O[1] = 0;
          band(k, j - H, j + H, I);
          band(k, j - H - 8, j - H - 3, O);
          band(k, j + H + 3, j + H + 8, O);
          if (I[1] > H && O[1] > 4) (t += I[0] / I[1] - O[0] / O[1]), c++;
        }
        if (c < (b - a) * 0.5) continue;
        const f = t / c - 0.004 * Math.abs(d);
        if (d === 0) zero = Math.max(zero, f);
        if (f > best) (best = f), (bd = d), (bh = H);
      }
      cent.push(P.idx[Math.min(m - 1, (a + b) >> 1)]);
      half.push(bh);
      // a clear road, and clearly better than where the map has it
      val.push(best > 0.3 ? (best - zero > 0.03 ? bd : 0) : NaN);
      if (b === m) break;
    }
    const K = [];
    val.forEach((v, k) => v === v && K.push(k));
    if (K.length < val.length * 0.4) return null;
    // a stretch disagreeing with both neighbours by over 4 m is a misread
    const v2 = val.slice();
    for (let q = 1; q < K.length - 1; q++) {
      const p = val[K[q - 1]], r = val[K[q + 1]], v = val[K[q]];
      if (Math.abs(v - p) > 4 && Math.abs(v - r) > 4) v2[K[q]] = (p + r) / 2;
    }
    // along the lap: linear between stretches, unclear ones bridged
    const at = new Float32Array(P.n), hw = new Float32Array(P.n);
    let h = 0;
    for (let i = 0; i < P.n; i++) {
      while (h < K.length && cent[K[h]] < i) h++;
      const a = K[Math.max(0, h - 1)], b = K[Math.min(K.length - 1, h)];
      const f = a === b ? 0 : Math.max(0, Math.min(1, (i - cent[a]) / Math.max(1, cent[b] - cent[a])));
      at[i] = v2[a] + (v2[b] - v2[a]) * f;
      hw[i] = half[a] + (half[b] - half[a]) * f;
    }
    return { at, half: hw };
  }

  /**
   * The shift (m, + left) that keeps every lap within a road where all of them leave it on
   * the same side: one lap running wide alone isn't a misplaced road. offs: per lap { off
   * (from the centre, + left), start, end }; road: { at (its middle, from the centre), half },
   * or none for the centre itself with half width hw. Spread over ~120 m so it never kinks.
   */
  function keepOn(offs, n, step, road, hw) {
    const ex = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // the image's road ends at its paint: the car's centre on the line still has wheels on asphalt
      const c = road ? road.at[i] : 0, lim = road ? road.half[i] : Math.max(2, hw - 1);
      let e = null;
      offs.forEach((s) => {
        if (i < s.start || i > s.end) return;
        const r = s.off[i] - c, x = r > lim ? r - lim : r < -lim ? r + lim : 0;
        e = e === null ? x : e * x <= 0 ? 0 : Math.abs(x) < Math.abs(e) ? x : e;
      });
      ex[i] = e || 0;
    }
    // widen each correction to the stretch round it, then blend its ends in
    const W = Math.max(1, Math.round(60 / step)), d = new Float32Array(n), b = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let k = Math.max(0, i - W); k <= Math.min(n - 1, i + W); k++) if (Math.abs(ex[k]) > Math.abs(m)) m = ex[k];
      d[i] = m;
    }
    for (let i = 0; i < n; i++) {
      let t = 0, c = 0;
      for (let k = Math.max(0, i - W); k <= Math.min(n - 1, i + W); k++) (t += d[k]), c++;
      b[i] = t / c;
    }
    return b;
  }

  // ----------------------------------------------------------- kerb anchors
  const KERB_ALONG = 0.2, KERB_ACROSS = 0.25, KERB_REACH = 6; // m between samples; m searched round the car

  /**
   * Kerb strikes from telemetry (rumble-strip material under the car), merged across laps:
   * [{ i0, i1, at (the car's offset from the centre there, m, + left) }]. The car is on the
   * kerb, so that offset is where the kerb is.
   */
  function kerbRuns(laps, n, step) {
    const hit = [];
    laps.forEach((L) => {
      if (!L.material || !L.off) return;
      for (let i = Math.max(0, L.start || 0); i <= Math.min(n - 1, L.end == null ? n - 1 : L.end); i++) {
        if (L.material[i] >= 11 && L.material[i] <= 14) hit.push([i, L.off[i]]);
      }
    });
    hit.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    // same stretch and same side of the road: one kerb
    const runs = [], gap = Math.max(1, Math.round(8 / step));
    hit.forEach(([i, o]) => {
      const r = runs.find((q) => i - q.i1 <= gap && q.offs[0] * o > 0);
      if (r) (r.i1 = Math.max(r.i1, i)), r.offs.push(o);
      else runs.push({ i0: i, i1: i, offs: [o] });
    });
    // a long strike near the road's edge, at the same offset lap after lap: a brief touch, a
    // chicane's kerb near the middle of the map's line, or a scatter of offsets (a wide kerb,
    // a wobble onto it) says little about where the edge is
    return runs
      .map((r) => {
        const o = r.offs.slice().sort((a, b) => a - b);
        return { i0: r.i0, i1: r.i1, at: o[o.length >> 1], spread: o[Math.floor(o.length * 0.9)] - o[Math.floor(o.length * 0.1)] };
      })
      .filter((r) => (r.i1 - r.i0) * step >= 8 && Math.abs(r.at) >= 3.5 && r.spread <= 1.5);
  }

  /**
   * Sample points round each kerb run: lines parallel to the centre, every KERB_ACROSS m from
   * KERB_REACH m inside to outside the car, each sampled every KERB_ALONG m along the run.
   */
  function kerbProbe(cx, cy, n, step, runs) {
    const pts = [], lines = [];
    const at = (f) => {
      const i = Math.max(0, Math.min(n - 2, Math.floor(f))), t = f - i;
      const a = Math.max(0, i - 3), b = Math.min(n - 1, i + 4);
      const tx = cx[b] - cx[a], ty = cy[b] - cy[a], l = Math.hypot(tx, ty) || 1;
      return [cx[i] + (cx[i + 1] - cx[i]) * t, cy[i] + (cy[i + 1] - cy[i]) * t, -ty / l, tx / l];
    };
    runs.forEach((r) => {
      const pad = Math.round(4 / step), f0 = Math.max(0, r.i0 - pad), f1 = Math.min(n - 1, r.i1 + pad);
      const along = [];
      for (let f = f0; f <= f1; f += KERB_ALONG / step) along.push(at(f));
      const us = [];
      for (let u = r.at - KERB_REACH; u <= r.at + KERB_REACH + 1e-6; u += KERB_ACROSS) us.push(u);
      lines.push({ run: r, us, len: along.length, start: pts.length });
      us.forEach((u) => along.forEach((c) => pts.push([c[0] + c[2] * u, c[1] + c[3] * u])));
    });
    return { pts, lines };
  }

  /**
   * Where each kerb really is in the image: score is how asphalt-like the image is (asphalt())
   * at each kerbProbe point. A kerb, whatever its colours, isn't grey asphalt, so the road's
   * edge on the strike's side is where asphalt gives way; the car's centre on the kerb is
   * about half a metre past it. -> [{ i, shift, strength }]: how far to move the image
   * (m, + left) to put that kerb under the cars. Kept only when that edge holds steady along
   * the whole strike, the shift is a few metres at most, and (with road, from roadShift) the
   * kerb sits where the image's road ends.
   */
  function kerbShift(K, score, road) {
    const out = [], E = Math.round(0.75 / KERB_ACROSS), CHUNK = Math.round(3 / KERB_ALONG);
    K.lines.forEach((L) => {
      const side = Math.sign(L.run.at), nu = L.us.length;
      // the edge in samples k0..k1 along the run: the strongest asphalt-to-not step on the
      // strike's side, beyond the middle of the road -> { u, step } | null
      const edge = (k0, k1) => {
        const a = L.us.map((u, q) => {
          let t = 0, c = 0;
          for (let k = k0; k < k1; k++) {
            const v = score[L.start + q * L.len + k];
            if (v >= 0) (t += v), c++;
          }
          return c > (k1 - k0) * 0.6 ? t / c : NaN;
        });
        let best = 0, bq = -1;
        for (let q = E; q < nu - E; q++) {
          const inner = a[side > 0 ? q - E : q + E], outer = a[side > 0 ? q + E : q - E];
          if (L.us[q] * side < 2 || !(inner === inner && outer === outer)) continue;
          if (inner > 0.55 && inner - outer > best) (best = inner - outer), (bq = q);
        }
        return bq < 0 || best < 0.35 ? null : { u: L.us[bq], step: best };
      };
      const all = edge(0, L.len);
      if (!all) return;
      // a kerb's edge runs unbroken along the road; a tree's shadow, a fence or a parked car
      // gives an edge that jumps about or comes and goes, so each 3 m piece must agree
      const parts = [];
      let pieces = 0;
      for (let k = 0; k + CHUNK <= L.len; k += CHUNK) {
        pieces++;
        const e = edge(k, k + CHUNK);
        if (e) parts.push(e.u);
      }
      if (pieces < 3 || parts.length < pieces * 0.7) return;
      const dev = parts.map((u) => Math.abs(u - all.u)).sort((x, y) => x - y);
      if (dev[Math.floor(dev.length * 0.75)] > 0.75) return;
      const shift = L.run.at - (all.u + side * 0.5);
      // a sane measurement: a few metres at most, and the kerb where the image's road ends
      if (Math.abs(shift) > 5) return;
      const i = (L.run.i0 + L.run.i1) >> 1;
      if (road && Math.abs(Math.abs(all.u - road.at[i]) - road.half[i]) > 2.5) return;
      out.push({ i, shift, strength: all.step });
    });
    return out;
  }

  /**
   * Anchor shifts spread along the lap: linear between neighbours, fading to nothing 250 m
   * past the last one. -> { at, w } (shift, and how much it's trusted, 0..1).
   */
  function anchorField(anchors, n, step) {
    const at = new Float32Array(n), w = new Float32Array(n);
    const A = anchors.slice().sort((a, b) => a.i - b.i);
    if (!A.length) return { at, w };
    const fade = (d) => Math.max(0, 1 - (d * step) / 250);
    let h = 0;
    for (let i = 0; i < n; i++) {
      while (h < A.length && A[h].i < i) h++;
      const a = A[Math.max(0, h - 1)], b = A[Math.min(A.length - 1, h)];
      if (a === b) {
        at[i] = a.shift;
        w[i] = fade(Math.abs(i - a.i));
      } else {
        const f = (i - a.i) / (b.i - a.i);
        at[i] = a.shift + (b.shift - a.shift) * f;
        // between two anchors far apart, trust drops in the middle
        w[i] = Math.max(fade(i - a.i), fade(b.i - i));
      }
    }
    return { at, w };
  }

  /** How much a pixel looks like asphalt: grey (unsaturated) and neither dark shadow nor bright paint. */
  function asphalt(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), lum = (r + g + b) / 3;
    if (lum < 30 || lum > 170) return 0;
    const sat = mx - mn;
    return sat < 18 ? 1 : sat < 40 ? (40 - sat) / 22 : 0;
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

  IST.Review.Track = { centreOn, fit, align, roadProbe, roadShift, keepOn, kerbRuns, kerbProbe, kerbShift, anchorField, asphalt, apply, invert, geo };
})();
