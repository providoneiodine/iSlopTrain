/*
 * Line Lab: corner complexes, racing lines and a lap-time model.
 *
 *   geo   = LineLab.build(spec, { mirror, rnd })   corner complex (5 m segments, same model as track.js)
 *   ideal = LineLab.solveIdeal(geo)                minimum-time line for this complex
 *   lines = LineLab.distractors(geo, ideal, level, n, rnd)  realistic flawed lines, tuned to a time-loss band
 *   fit   = LineLab.fitDrawn(geo, raw); LineLab.intentGen(geo, fit.ctrl, tolM)  a hand-drawn line, read for intent
 *   v     = LineLab.judge(geo, ideal, line)            corner-by-corner placement vs the ideal
 *   sim   = LineLab.simulate(geo, keys, { full: true })     speed / time profile along a line
 *
 * A line is a list of keypoints { s (m along the centreline), n (lateral
 * position, -1 = left edge, +1 = right edge), role, ci (corner index) }
 * joined by smootherstep curves, so it is parallel to the track at every
 * keypoint (turn-in on the outside, apex on the inside, track-out on the
 * outside).
 *
 * Lap-time model: quasi-steady-state point mass (Brayshaw & Harrison, 2005):
 * speed limited by lateral grip on the line's own curvature, with a friction
 * ellipse shared between cornering and braking/driving, a power limit and
 * drag. The ideal line is found by pattern search over the keypoints
 * (minimum time to the end of the exit straight, cf. Kapania et al., 2016),
 * so every flawed line is slower by construction, and by how much is
 * computed, not asserted.
 *
 * Limits: no weight transfer, no yaw inertia, constant grip (no aero), flat.
 * Good enough to rank lines and show where time goes, not to predict lap times.
 */
(function () {
  'use strict';
  const U = IST.util;
  const SEG = 5; // m per curvature segment (as track.js)
  const HW = 6; // half track width (m)
  const DS = 2.5; // m between simulation samples
  const NMAX = 0.82; // car centre stays ~1 m inside each edge
  const TAIL = 900; // extra straight after the finish so the in-car view has road ahead
  const CAR = { aLat: 13.5, aBrake: 14, aTrac: 9, power: 330, drag: 0.0007, vMax: 95 };
  /*
   * Grip that grows with speed (downforce): a car may add dfLat / dfBrake (m/s^2 per
   * (m/s)^2) to its lateral and braking limits. Draw the Line's CAR has none.
   */
  const latA = (car, v) => car.aLat + (car.dfLat || 0) * v * v;
  const brkA = (car, v) => car.aBrake + (car.dfBrake || 0) * v * v;

  const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);

  // --------------------------------------------------------------- geometry
  /**
   * spec.items: ['s', length m] | ['c', dir (+1 right, -1 left), radius m, angle deg, shape?]
   * o.mirror flips left/right; o.rnd (seeded rng) jitters radii, angles and straights.
   */
  function build(spec, o) {
    o = o || {};
    const m = o.mirror ? -1 : 1, rnd = o.rnd;
    const jit = (a, b) => (rnd ? U.lerp(a, b, rnd()) : 1);
    const segs = [], corners = [];
    const items = spec.items;
    let approach = 0, exitLen = 0;
    items.forEach((it, idx) => {
      if (it[0] === 's') {
        const edge = idx === 0 || idx === items.length - 1;
        const len = it[1] * (edge ? jit(0.88, 1.12) : jit(0.7, 1.3));
        const n = Math.max(0, Math.round(len / SEG));
        for (let i = 0; i < n; i++) segs.push(0);
        if (idx === 0) approach = n * SEG;
        if (idx === items.length - 1) exitLen = n * SEG;
        return;
      }
      const dir = it[1] * m, shape = it[4] || null;
      const R = it[2] * jit(0.87, 1.13), deg = Math.min(178, it[3] * jit(0.93, 1.07));
      const angle = (deg * Math.PI) / 180;
      const total = Math.max(4, Math.round((angle * R) / SEG));
      const nIn = Math.max(2, Math.round(total * 0.28)), nOut = Math.max(2, Math.round(total * 0.32));
      const nHold = Math.max(1, total - Math.round((nIn + nOut) / 2));
      const k = dir / R;
      const k0 = shape === 'tighten' ? 0.72 : shape === 'open' ? 1.3 : 1;
      const k1 = shape === 'tighten' ? 1.3 : shape === 'open' ? 0.72 : 1;
      const start = segs.length;
      for (let i = 0; i < nIn; i++) segs.push(k * k0 * U.smooth((i + 0.5) / nIn));
      for (let i = 0; i < nHold; i++) segs.push(k * U.lerp(k0, k1, nHold > 1 ? i / (nHold - 1) : 0.5));
      for (let i = 0; i < nOut; i++) segs.push(k * k1 * (1 - U.smooth((i + 0.5) / nOut)));
      corners.push({ index: corners.length, dir, R, deg, shape, startPos: start * SEG, endPos: segs.length * SEG });
    });
    const sEnd = segs.length * SEG;
    for (let i = 0; i < TAIL / SEG; i++) segs.push(0);

    // centreline samples (screen-style coordinates: y down, +curvature turns right)
    const N = Math.round((sEnd + 20) / DS);
    const cx = new Float64Array(N + 1), cy = new Float64Array(N + 1), nx = new Float64Array(N + 1), ny = new Float64Array(N + 1), th = new Float64Array(N + 1);
    let x = 0, y = 0, a = -Math.PI / 2;
    for (let i = 0; i <= N; i++) {
      cx[i] = x;
      cy[i] = y;
      th[i] = a;
      nx[i] = -Math.sin(a);
      ny[i] = Math.cos(a);
      const k = segs[Math.floor((i + 0.5) * DS / SEG)] || 0;
      const mid = a + k * DS * 0.5;
      x += Math.cos(mid) * DS;
      y += Math.sin(mid) * DS;
      a += k * DS;
    }
    const iEnd = Math.round(sEnd / DS);
    const buf = alloc(N);

    // 3-2-1 braking boards on the outside before corners with a real approach
    const boards = [];
    corners.forEach((c, i) => {
      const prevEnd = i ? corners[i - 1].endPos : 0;
      [3, 2, 1].forEach((num) => {
        const p = c.startPos - num * 50 - 20;
        if (p > prevEnd + 40) boards.push({ pos: p, x: -c.dir * (HW + 2.2), num });
      });
    });

    return {
      spec, mirror: !!o.mirror, segs, corners, boards, approach, exitLen, sEnd, iEnd, N,
      cx, cy, nx, ny, th, buf, vIn: spec.vIn || 68,
      HALF_W: HW, SEG, DS,
      heightAt: () => 0,
    };
  }

  function alloc(N) {
    return {
      px: new Float64Array(N + 1), py: new Float64Array(N + 1),
      L: new Float64Array(N + 1), k: new Float64Array(N + 1), v: new Float64Array(N + 1),
    };
  }

  // ----------------------------------------------------------------- lines
  /*
   * A line is its lateral position n at every sample (-1 = left edge, +1 =
   * right edge). The ideal is a uniform cubic B-spline over control points
   * every KNOT m through the complex (C2, so curvature is continuous, and it
   * never leaves the hull of its control points, so it stays on track).
   * Before the first and after the last control point it holds still.
   */
  const KNOT = 7.5;

  function knots(geo) {
    if (geo.knots) return geo.knots;
    const C = geo.corners;
    const s0 = Math.max(0, C[0].startPos - 140), s1 = Math.min(geo.sEnd - 15, C[C.length - 1].endPos + 120);
    const M = Math.ceil((s1 - s0) / KNOT);
    return (geo.knots = { s0, M });
  }

  function ctrlToN(geo, c, out) {
    const K = knots(geo), M = K.M, N = geo.N;
    const n = out || new Float64Array(N + 1);
    const cl = (j) => c[j < 0 ? 0 : j > M ? M : j];
    for (let i = 0; i <= N; i++) {
      const u = (i * DS - K.s0) / KNOT;
      if (u <= -1) {
        n[i] = c[0];
        continue;
      }
      if (u >= M + 1) {
        n[i] = c[M];
        continue;
      }
      const j = Math.floor(u), t = u - j, t2 = t * t, t3 = t2 * t;
      n[i] = (cl(j - 1) * (1 - 3 * t + 3 * t2 - t3) + cl(j) * (4 - 6 * t2 + 3 * t3) + cl(j + 1) * (1 + 3 * t + 3 * t2 - 3 * t3) + cl(j + 2) * t3) / 6;
    }
    return n;
  }

  /** Start shape: outside -> apex at ~60 % -> outside (opposite-hand corners close together go apex to apex). */
  function template(geo) {
    const C = geo.corners;
    const keys = [{ s: 0, n: -C[0].dir * NMAX }];
    C.forEach((c, i) => {
      const prev = C[i - 1], next = C[i + 1], len = c.endPos - c.startPos;
      const linkPrev = prev && prev.dir !== c.dir && c.startPos - prev.endPos < 40;
      const linkNext = next && next.dir !== c.dir && next.startPos - c.endPos < 40;
      if (!linkPrev) keys.push({ s: Math.max(prev ? prev.endPos + 12 : 20, c.startPos - 8), n: -c.dir * NMAX });
      keys.push({ s: c.startPos + len * 0.6, n: c.dir * NMAX });
      if (!linkNext) keys.push({ s: Math.min(next ? next.startPos - 20 : geo.sEnd - 30, c.endPos + 30), n: -c.dir * NMAX * (next && next.dir === c.dir ? 0.4 : 1) });
    });
    keys.sort((a, b) => a.s - b.s);
    const at = (s) => {
      if (s <= keys[0].s) return keys[0].n;
      for (let i = 0; i < keys.length - 1; i++) {
        const a = keys[i], b = keys[i + 1];
        if (s < b.s) return a.n + (b.n - a.n) * smoother((s - a.s) / Math.max(1, b.s - a.s));
      }
      return keys[keys.length - 1].n;
    };
    const K = knots(geo), c = new Float64Array(K.M + 1);
    for (let j = 0; j <= K.M; j++) c[j] = j === 0 ? keys[0].n : at(K.s0 + j * KNOT);
    return c;
  }

  // ------------------------------------------------------------ simulation
  /**
   * Quasi-steady-state speed profile along a line (lateral positions n).
   * Returns the time to the finish (or to o.iStop with a free end), or the
   * full profile with o.full. o.car swaps the car model (default CAR),
   * o.vIn the entry speed.
   */
  function simulate(geo, n, o) {
    o = o || {};
    const car = o.car || CAR;
    const iStop = Math.min(geo.N, o.iStop || geo.iEnd);
    const B = o.full ? alloc(iStop) : geo.buf;
    const { px, py, L, k, v } = B;
    const cx = geo.cx, cy = geo.cy, nxA = geo.nx, nyA = geo.ny;
    for (let i = 0; i <= iStop; i++) {
      px[i] = cx[i] + n[i] * HW * nxA[i];
      py[i] = cy[i] + n[i] * HW * nyA[i];
    }
    for (let i = 0; i < iStop; i++) L[i] = Math.hypot(px[i + 1] - px[i], py[i + 1] - py[i]);
    k[0] = 0;
    for (let i = 1; i < iStop; i++) {
      const ax = px[i] - px[i - 1], ay = py[i] - py[i - 1], bx = px[i + 1] - px[i], by = py[i + 1] - py[i];
      const lc = Math.hypot(px[i + 1] - px[i - 1], py[i + 1] - py[i - 1]);
      k[i] = (2 * (ax * by - ay * bx)) / (L[i - 1] * L[i] * lc || 1);
    }
    k[iStop] = k[iStop - 1];

    const vMax = car.vMax, df = car.dfLat || 0;
    for (let i = 0; i <= iStop; i++) {
      // v^2 c = aLat + df v^2
      const c = Math.abs(k[i]), den = c - df;
      v[i] = c > 1e-6 && den > 0 ? Math.min(vMax, Math.sqrt(car.aLat / den)) : vMax;
    }
    v[0] = Math.min(v[0], o.vIn || geo.vIn);
    // forward: drive (traction / power / drag), limited by the grip left after cornering
    for (let i = 0; i < iStop; i++) {
      const vi = v[i], u = (vi * vi * Math.abs(k[i])) / latA(car, vi);
      const ell = u < 1 ? Math.sqrt(1 - u * u) : 0;
      const a = Math.min(car.aTrac, car.power / Math.max(vi, 1)) * ell - car.drag * vi * vi;
      const vn = Math.sqrt(Math.max(0, vi * vi + 2 * L[i] * a));
      if (vn < v[i + 1]) v[i + 1] = vn;
    }
    // backward: braking on the same friction ellipse; drag helps
    for (let i = iStop - 1; i >= 0; i--) {
      const vj = v[i + 1], u = (vj * vj * Math.abs(k[i + 1])) / latA(car, vj);
      const ell = u < 1 ? Math.sqrt(1 - u * u) : 0;
      const b = brkA(car, vj) * ell + car.drag * vj * vj;
      const vp = Math.sqrt(vj * vj + 2 * L[i] * b);
      if (vp < v[i]) v[i] = vp;
    }
    if (!o.full) {
      let T = 0;
      for (let i = 0; i < iStop; i++) T += (2 * L[i]) / (v[i] + v[i + 1]);
      return T;
    }
    const tc = new Float64Array(iStop + 1);
    for (let i = 0; i < iStop; i++) tc[i + 1] = tc[i] + (2 * L[i]) / (v[i] + v[i + 1]);
    return { px, py, k, v, tc, time: tc[iStop], iStop };
  }

  // ------------------------------------------------------------- optimiser
  /**
   * Pattern search on control points lo..hi: blocks of 8, 4, 2 and 1 points
   * nudged up and down with a shrinking step (multi-scale, so whole-corner
   * shifts are found as easily as local tweaks). A generator: it yields
   * every ~150 evaluations so a drill can spread the work over frames.
   */
  function* optimizeGen(geo, c, lo, hi, o) {
    o = o || {};
    const nb = geo.nbuf || (geo.nbuf = new Float64Array(geo.N + 1));
    const f = () => simulate(geo, ctrlToN(geo, c, nb), o.sim);
    let best = f(), step = o.step || 0.32, evals = 0, lastY = 0;
    const maxEvals = o.maxEvals || 20000, save = new Float64Array(8);
    const bLo = o.lo, bHi = o.hi; // optional per-control-point bounds (default ±NMAX)
    lo = Math.max(1, lo); // c[0] is the shared start position
    while (step >= 0.006 && evals < maxEvals) {
      let improved = false;
      for (const bs of [8, 4, 2, 1]) {
        for (let i = lo; i <= hi; i += bs) {
          if (evals - lastY >= 150) {
            lastY = evals;
            yield;
          }
          const e = Math.min(hi, i + bs - 1);
          for (const sg of [1, -1]) {
            let moved = false;
            for (let rep = 0; rep < 4; rep++) {
              let changed = false;
              for (let j = i; j <= e; j++) {
                save[j - i] = c[j];
                c[j] = U.clamp(c[j] + sg * step, bLo ? bLo[j] : -NMAX, bHi ? bHi[j] : NMAX);
                if (c[j] !== save[j - i]) changed = true;
              }
              if (!changed) break;
              const t = f();
              evals++;
              if (t < best - 1e-7) {
                best = t;
                moved = improved = true;
              } else {
                for (let j = i; j <= e; j++) c[j] = save[j - i];
                break;
              }
            }
            if (moved) break;
          }
        }
      }
      if (!improved) step /= 2;
    }
    return { time: best, evals };
  }

  /** Run a generator to completion (synchronous use). */
  function run(gen) {
    let r;
    while (!(r = gen.next()).done);
    return r.value;
  }
  const optimize = (geo, c, lo, hi, o) => run(optimizeGen(geo, c, lo, hi, o));

  function lineFrom(geo, n, ideal, info) {
    const sim = simulate(geo, n, { full: true });
    const L = Object.assign({ n, sim, time: sim.time }, info);
    if (ideal) {
      L.loss = sim.time - ideal.time;
      L.dev = maxDev(geo, n, ideal.n);
    }
    L.ph = phases(geo, L);
    return L;
  }

  function idealFrom(geo, c, evals) {
    const L = lineFrom(geo, ctrlToN(geo, c), null, { isIdeal: true, ctrl: c, evals });
    L.loss = 0;
    L.dev = 0;
    return L;
  }

  /**
   * Minimum-time line. After the pattern search, "basin hops": if moving a
   * whole corner a few metres earlier or later is faster, restart from there
   * (pattern search alone can stall in a neighbouring optimum).
   */
  function* solveGen(geo) {
    const c = template(geo), M = knots(geo).M, K = knots(geo);
    let evals = (yield* optimizeGen(geo, c, 1, M)).evals;
    let L = idealFrom(geo, c, evals);
    for (let round = 0; round < 4; round++) {
      // try the flaw moves themselves (shifts, narrowing): if one is faster, restart from it
      let hop = null;
      const tryN = (n) => {
        if (!n) return;
        const t = simulate(geo, n);
        if (t < L.time - 0.004 && (!hop || t < hop.t)) hop = { n, t };
      };
      for (let ci = 0; ci < geo.corners.length; ci++) {
        for (const d of [5, -5, 10, -10, 16, -16]) tryN(warp(geo, L, ci, d));
        for (const w of ['entry', 'apex', 'exit']) for (const m of [0.15, 0.35]) tryN(narrow(geo, L, ci, w, m));
      }
      yield;
      if (!hop) break;
      // refit the control points to that line, then polish
      const c2 = new Float64Array(c.length);
      for (let j = 0; j <= M; j++) c2[j] = j === 0 ? c[0] : U.clamp(sampleN(hop.n, K.s0 + j * KNOT, geo.N), -NMAX, NMAX);
      const r = yield* optimizeGen(geo, c2, 1, M, { step: 0.08 });
      evals += r.evals;
      if (r.time >= L.time - 1e-4) break;
      c.set(c2);
      L = idealFrom(geo, c, evals);
    }
    // smooth-and-repolish: the drawn-line reader starts from a smoothed copy, and must not find a faster line than this
    const win = windowOf(geo), raw = new Float64Array(geo.N + 1).fill(NaN);
    for (let round = 0; round < 2; round++) {
      for (let i = Math.round(win.sA / DS); i <= Math.round(win.sB / DS); i++) raw[i] = L.n[i];
      const c3 = yield* intentGen(geo, fitDrawn(geo, raw).ctrl, 1.5);
      const r = yield* optimizeGen(geo, c3, 1, M, { step: 0.04 });
      evals += r.evals;
      if (r.time >= L.time - 0.002) break;
      L = idealFrom(geo, c3, evals);
    }
    return L;
  }
  const solveIdeal = (geo) => run(solveGen(geo));

  // ---------------------------------------------------------------- phases
  /**
   * Per corner: brake point (speed peak before it, if it brakes), turn-in
   * (steering starts: path curvature passes 12 % of its peak), apex (closest
   * to the inside) and track-out (first reaches the outside again).
   */
  function phases(geo, line) {
    const n = line.n, sim = line.sim, k = sim.k, v = sim.v, C = geo.corners, top = sim.iStop;
    const idx = (s) => U.clamp(Math.round(s / DS), 0, top);
    const info = C.map((c) => ({ ci: c.index, dir: c.dir }));
    // apex: furthest to the inside (middle of the contact patch if it hugs the kerb)
    C.forEach((c, ci) => {
      const a = idx(c.startPos - 10), b = idx(c.endPos + 10), d = c.dir;
      let im = a;
      for (let i = a; i <= b; i++) if (d * n[i] > d * n[im]) im = i;
      let l = im, r = im;
      while (l > a && d * n[l - 1] >= d * n[im] - 0.012) l--;
      while (r < b && d * n[r + 1] >= d * n[im] - 0.012) r++;
      info[ci].ia = Math.round((l + r) / 2);
    });
    // turn-in: walking back from the apex until the steering is (almost) straight
    C.forEach((c, ci) => {
      const d = c.dir, ia = info[ci].ia, floor = ci ? info[ci - 1].ia : 0;
      let peak = 0;
      for (let i = idx(c.startPos - 30); i <= ia; i++) peak = Math.max(peak, d * k[i]);
      let i = ia;
      while (i > floor + 1 && d * k[i] > 0.12 * peak) i--;
      info[ci].ti = i;
    });
    // track-out: first reaches (near) its outermost point before the next turn-in
    C.forEach((c, ci) => {
      const d = c.dir, ia = info[ci].ia;
      const lim = ci < C.length - 1 ? info[ci + 1].ti : Math.min(top, ia + Math.round(220 / DS));
      let mx = -Infinity;
      for (let i = ia; i <= lim; i++) mx = Math.max(mx, -d * n[i]);
      if (mx < 0.35) return;
      let i = ia;
      while (i < lim && -d * n[i] < mx - 0.025) i++;
      if (ci < C.length - 1 && (info[ci + 1].ti - i) * DS < 15) return; // runs straight into the next corner
      info[ci].to = i;
    });
    const out = [];
    let lo = 0;
    info.forEach((f, ci) => {
      let imax = lo;
      for (let i = lo; i <= f.ia; i++) if (v[i] > v[imax]) imax = i;
      let imin = f.ti;
      for (let i = f.ti; i <= Math.min(top, f.ia + 20); i++) if (v[i] < v[imin]) imin = i;
      f.vMin = v[imin];
      f.iMin = imin;
      if (v[imax] - v[imin] > 2.5 && imax < f.ti) out.push({ kind: 'brake', ci, s: imax * DS, v: v[imax] });
      out.push({ kind: 'turnin', ci, s: f.ti * DS, v: v[f.ti] });
      out.push({ kind: 'apex', ci, s: f.ia * DS, v: v[f.ia], vMin: f.vMin });
      if (f.to != null) out.push({ kind: 'exit', ci, s: f.to * DS, v: v[f.to] });
      lo = f.ia;
    });
    out.sort((a, b) => a.s - b.s);
    out.push({ kind: 'end', ci: -1, s: geo.sEnd, v: v[geo.iEnd] });
    line.corners = info;
    return out;
  }

  // ---------------------------------------------------------------- flaws
  const FLAWS = {
    early: { label: 'Early turn-in', phase: 'turnin' },
    late: { label: 'Late turn-in', phase: 'turnin' },
    entry: { label: 'Narrow entry', phase: 'turnin' },
    apex: { label: 'Missed apex', phase: 'apex' },
    exit: { label: 'Narrow exit', phase: 'exit' },
    priority: { label: 'Wrong corner prioritised', phase: 'apex' },
  };
  const MAGS = [0.2, 0.32, 0.45, 0.62, 0.8, 1];
  const SHIFT = 26; // m of turn-in shift at magnitude 1

  /** Loss bands (s) per level: wrong lines get closer to the ideal as you level up. */
  const BANDS = [null, [0.35, 1.4], [0.24, 0.85], [0.16, 0.55], [0.11, 0.38], [0.075, 0.26], [0.045, 0.17]];
  const MAX_LEVEL = BANDS.length - 1;

  const ramp = (s, a, b) => (b <= a ? (s >= b ? 1 : 0) : smoother(U.clamp((s - a) / (b - a), 0, 1)));
  const bump = (s, p0, p1, p2, p3) => Math.min(ramp(s, p0, p1), 1 - ramp(s, p2, p3));

  function sampleN(n, s, top) {
    const f = U.clamp(s / DS, 0, top);
    const i = Math.min(top - 1, Math.floor(f));
    return n[i] + (n[i + 1] - n[i]) * (f - i);
  }

  /** Neighbouring apexes bound how far a flaw around corner ci may reach. */
  function span(geo, ideal, ci) {
    const C = ideal.corners, f = C[ci];
    const prev = ci ? C[ci - 1].ia * DS : 0, next = ci < C.length - 1 ? C[ci + 1].ia * DS : geo.sEnd;
    const ti = f.ti * DS, ap = f.ia * DS;
    const to = f.to != null ? f.to * DS : ap + 0.5 * (next - ap);
    return { prev, next, ti, ap, to };
  }

  /** Corner ci's whole lateral profile happens d m earlier (d > 0) or later (d < 0). */
  function warpWindow(geo, ideal, ci, d) {
    const sp = span(geo, ideal, ci);
    const r1 = Math.min(75, (sp.ti - sp.prev) * 0.7), r2 = Math.min(75, (sp.next - sp.to) * 0.7);
    if (r1 < Math.abs(d) * 1.4 || r2 < Math.abs(d) * 1.4) return null;
    return (s) => Math.min(ramp(s, sp.ti - r1, sp.ti), 1 - ramp(s, sp.to, sp.to + r2));
  }
  function warp(geo, ideal, ci, d) {
    const w = warpWindow(geo, ideal, ci, d);
    if (!w) return null;
    const top = geo.N, n = ideal.n, out = new Float64Array(top + 1);
    for (let i = 0; i <= top; i++) out[i] = sampleN(n, i * DS + d * w(i * DS), top);
    return out;
  }

  /** Pull the line towards the middle of the track around one phase. */
  function narrow(geo, ideal, ci, where, m) {
    const sp = span(geo, ideal, ci), top = geo.N, n = ideal.n, out = new Float64Array(top + 1);
    let p;
    if (where === 'entry') {
      if (ci && ideal.corners[ci - 1].to == null) return null; // linked to the corner before: no separate entry
      p = [sp.ti - 60, sp.ti - 18, sp.ti + 4, sp.ap - 6];
    } else if (where === 'apex') p = [sp.ti + 0.25 * (sp.ap - sp.ti), sp.ap - 5, sp.ap + 5, sp.ap + 0.75 * (sp.to - sp.ap)];
    else {
      if (ideal.corners[ci].to == null) return null;
      p = [sp.ap + 0.3 * (sp.to - sp.ap), sp.to - 4, sp.to + 25, Math.min(sp.next - 5, sp.to + 85)];
    }
    p[0] = Math.max(p[0], sp.prev + 5);
    p[3] = Math.min(p[3], sp.next - 5);
    if (!(p[0] < p[1] && p[1] <= p[2] && p[2] < p[3])) return null;
    for (let i = 0; i <= top; i++) out[i] = n[i] * (1 - m * 0.9 * bump(i * DS, p[0], p[1], p[2], p[3]));
    return out;
  }

  function applyFlaw(geo, ideal, type, ci, mag) {
    if (type === 'early') return warp(geo, ideal, ci, SHIFT * mag);
    if (type === 'late') return warp(geo, ideal, ci, -SHIFT * mag * 0.8);
    if (type === 'entry' || type === 'apex' || type === 'exit') return narrow(geo, ideal, ci, type, mag);
    return null;
  }

  /**
   * "Corner j's own fastest line": optimise the control points up to just
   * after corner j for the time to there (free end, so the next corner's
   * braking doesn't count), then make the best of the rest from there on.
   */
  function* priorityLineGen(geo, ideal, j) {
    const C = geo.corners;
    if (j >= C.length - 1) return null;
    const K = knots(geo), c = Float64Array.from(ideal.ctrl);
    const sp = span(geo, ideal, j);
    const sStop = Math.min(C[j].endPos + 40, (sp.ap + sp.next) / 2 + 10);
    const kStop = Math.min(K.M, Math.ceil((sStop - K.s0) / KNOT) + 1);
    yield* optimizeGen(geo, c, 1, kStop, { sim: { iStop: Math.round(sStop / DS) } });
    yield* optimizeGen(geo, c, kStop + 2, K.M);
    return ctrlToN(geo, c);
  }

  function maxDev(geo, a, b) {
    let m = 0;
    for (let i = 0; i <= geo.iEnd; i += 2) m = Math.max(m, Math.abs(a[i] - b[i]));
    return m * HW;
  }

  /** Corner j's own fastest line for every corner but the last (cached on the ideal). */
  function* priorityGen(geo, ideal) {
    if (ideal.prio) return ideal.prio;
    const out = [];
    for (let j = 0; j < geo.corners.length - 1; j++) {
      const n = yield* priorityLineGen(geo, ideal, j);
      if (n) out.push(lineFrom(geo, n, ideal, { flaw: 'priority', ci: j, mag: 1 }));
    }
    return (ideal.prio = out);
  }
  const priorityLines = (geo, ideal) => ideal.prio || run(priorityGen(geo, ideal));

  /**
   * Pick `count` flawed lines whose time loss sits in the level's band, each a
   * different kind of mistake where possible, and visibly different from
   * the ideal and from each other.
   */
  function distractors(geo, ideal, level, count, rnd) {
    const band = BANDS[U.clamp(level, 1, MAX_LEVEL)];
    const target = Math.sqrt(band[0] * band[1]);
    const dist = (loss) => Math.abs(Math.log(Math.max(loss, 1e-3) / target));
    const cands = [];
    let beaten = false; // a "flaw" beat the ideal: the caller should use another variant
    ['early', 'late', 'entry', 'apex', 'exit'].forEach((type) => {
      geo.corners.forEach((c, ci) => {
        let best = null;
        for (const mag of MAGS) {
          const n = applyFlaw(geo, ideal, type, ci, mag);
          if (!n) continue;
          const loss = simulate(geo, n) - ideal.time;
          if (loss < -0.002) beaten = true;
          if (loss < 0.03 || maxDev(geo, n, ideal.n) < 0.9) continue;
          if (!best || dist(loss) < dist(best.loss)) best = { n, loss, flaw: type, ci, mag };
        }
        if (best) cands.push(best);
      });
    });
    priorityLines(geo, ideal).forEach((L) => {
      if (L.loss >= 0.03 && L.dev >= 0.9) cands.push({ line: L, n: L.n, loss: L.loss, flaw: 'priority', ci: L.ci, mag: 1, bonus: 0.7 });
    });
    const inBand = (L) => L.loss >= band[0] * 0.85 && L.loss <= band[1] * 1.2;
    cands.forEach((L) => (L.score = dist(L.loss) + (inBand(L) ? 0 : 1.5) - (L.bonus || 0) + rnd() * 0.5));
    cands.sort((a, b) => a.score - b.score);
    const out = [], types = {}, slots = {};
    for (const pass of [0, 1]) {
      for (const L of cands) {
        if (out.length >= count) break;
        const slot = L.flaw + ':' + L.ci;
        if (slots[slot] || (pass === 0 && types[L.flaw])) continue;
        if (out.some((o) => maxDev(geo, o.n, L.n) < 0.7)) continue;
        out.push(L);
        types[L.flaw] = slots[slot] = true;
      }
    }
    const lines = out.map((L) => L.line || lineFrom(geo, L.n, ideal, { flaw: L.flaw, ci: L.ci, mag: L.mag }));
    lines.beaten = beaten || (ideal.prio || []).some((p) => p.loss < -0.002);
    return lines;
  }

  /** Time at track position s along a simulated line. */
  function timeAt(sim, s) {
    return sampleAt(sim.tc, sim, s);
  }
  function sampleAt(arr, sim, s) {
    const f = U.clamp(s / DS, 0, sim.iStop);
    const i = Math.min(sim.iStop - 1, Math.floor(f));
    return arr[i] + (arr[i + 1] - arr[i]) * (f - i);
  }
  /** Track position reached T seconds along a simulated line. */
  function posAtTime(sim, T) {
    const tc = sim.tc;
    if (T <= 0) return 0;
    if (T >= tc[sim.iStop]) return sim.iStop * DS;
    let lo = 0, hi = sim.iStop;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (tc[m] <= T) lo = m;
      else hi = m;
    }
    return (lo + (T - tc[lo]) / Math.max(1e-9, tc[lo + 1] - tc[lo])) * DS;
  }

  // ---------------------------------------------------------- drawn lines
  /**
   * World point (x, y) -> { i, s, n }: nearest centreline sample (searched
   * within ±range samples of hint, so a stroke can't jump across a hairpin),
   * s refined along the tangent, n the lateral position (±1 = edges).
   */
  function project(geo, x, y, hint, range) {
    const lo = hint == null ? 0 : Math.max(0, hint - range), hi = hint == null ? geo.iEnd : Math.min(geo.N, hint + range);
    let bi = lo, bd = Infinity;
    for (let i = lo; i <= hi; i++) {
      const dx = x - geo.cx[i], dy = y - geo.cy[i], d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    const dx = x - geo.cx[bi], dy = y - geo.cy[bi];
    return { i: bi, s: bi * DS + dx * Math.cos(geo.th[bi]) + dy * Math.sin(geo.th[bi]), n: (dx * geo.nx[bi] + dy * geo.ny[bi]) / HW };
  }

  /**
   * A hand-drawn lateral profile (raw[i], NaN where not drawn) -> a line in
   * the same B-spline form as the ideal: gaps interpolated, the ends held,
   * hand jitter smoothed out (box filter, ~6 m), control points clamped so
   * the car stays on track. Drawing on the kerb means "use all the road".
   */
  function fitDrawn(geo, raw) {
    const N = geo.N, def = [];
    for (let i = 0; i <= N; i++) if (!isNaN(raw[i])) def.push(i);
    if (def.length < 2) return null;
    const d = new Float64Array(N + 1);
    for (let i = 0; i <= def[0]; i++) d[i] = raw[def[0]];
    for (let k = 1; k < def.length; k++) {
      const a = def[k - 1], b = def[k];
      for (let i = a; i <= b; i++) d[i] = raw[a] + ((raw[b] - raw[a]) * (i - a)) / Math.max(1, b - a);
    }
    for (let i = def[def.length - 1]; i <= N; i++) d[i] = raw[def[def.length - 1]];
    for (let i = 0; i <= N; i++) d[i] = U.clamp(d[i], -1, 1);
    const tmp = new Float64Array(N + 1), R = 2;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i <= N; i++) {
        let s = 0, m = 0;
        for (let j = Math.max(0, i - R); j <= Math.min(N, i + R); j++, m++) s += d[j];
        tmp[i] = s / m;
      }
      d.set(tmp);
    }
    const K = knots(geo), c = new Float64Array(K.M + 1);
    for (let j = 0; j <= K.M; j++) c[j] = U.clamp(sampleN(d, K.s0 + j * KNOT, N), -NMAX, NMAX);
    return { ctrl: c, n: ctrlToN(geo, c), from: def[0] * DS, to: def[def.length - 1] * DS };
  }

  /**
   * The line the driver meant: the fastest line within tolM metres (either
   * side) of the drawn one. Mouse wobble and a slightly-off kerb cost
   * nothing; where you put the car (turn-in, apex, track-out) still counts.
   */
  function* intentGen(geo, ctrl, tolM) {
    const c = Float64Array.from(ctrl), M = knots(geo).M, t = tolM / HW;
    const lo = new Float64Array(M + 1), hi = new Float64Array(M + 1);
    for (let j = 0; j <= M; j++) {
      lo[j] = Math.max(-NMAX, c[j] - t);
      hi[j] = Math.min(NMAX, c[j] + t);
    }
    if (t > 0) yield* optimizeGen(geo, c, 1, M, { lo, hi, step: Math.max(0.02, t / 2), maxEvals: 8000 });
    return c;
  }

  /**
   * Corner by corner, where line L puts the car compared with the ideal:
   * turn-in and apex (m later +, earlier -), metres of road left unused at
   * turn-in, apex and track-out, minimum speed difference, and the time
   * lost through that corner (segments split midway between the ideal's
   * apexes; the last one runs to the end of the straight).
   * Issues are flagged past o.along m / o.lat m.
   */
  function judge(geo, ideal, L, o) {
    o = o || {};
    const along = o.along || 8, lat = o.lat || 1.2;
    const C = geo.corners, I = ideal.corners, Y = L.corners, nI = ideal.n, nY = L.n;
    const dt = (s) => timeAt(L.sim, s) - timeAt(ideal.sim, s);
    const bounds = [Math.max(0, C[0].startPos - 150)];
    for (let k = 1; k < C.length; k++) bounds.push(((I[k - 1].ia + I[k].ia) * DS) / 2);
    bounds.push(geo.sEnd);
    const out = C.map((c, ci) => {
      const d = c.dir, fi = I[ci], fy = Y[ci];
      const fromOut = (n) => Math.max(0, (1 + d * n) * HW - (1 - NMAX) * HW);
      const fromIn = (n) => Math.max(0, (1 - d * n) * HW - (1 - NMAX) * HW);
      const r = { ci, dir: d, cost: dt(bounds[ci + 1]) - dt(bounds[ci]), issues: [] };
      r.dTurn = (fy.ti - fi.ti) * DS;
      r.dApex = (fy.ia - fi.ia) * DS;
      r.dv = (fy.vMin - fi.vMin) * 3.6;
      const linked = ci > 0 && I[ci - 1].to == null;
      r.entry = linked ? null : fromOut(nY[fy.ti]) - fromOut(nI[fi.ti]);
      r.apexIn = fromIn(nY[fy.ia]) - fromIn(nI[fi.ia]);
      r.exit = null;
      if (fi.to != null) {
        // closest the line gets to the outside between its apex and just after the ideal's track-out
        let m = Infinity;
        const lim = Math.min(L.sim.iStop, fi.to + Math.round(20 / DS));
        for (let i = fy.ia; i <= lim; i++) m = Math.min(m, fromOut(nY[i]));
        r.exit = m - fromOut(nI[fi.to]);
      }
      // turn-in is only trusted where the corner has its own entry and the detector found a sensible point
      const tiOk = !linked && Math.abs(r.dTurn) < 45;
      const sides = (k, sg) => {
        const agrees = tiOk && sg * r.dTurn >= 4;
        r.issues.push({ kind: k, phase: agrees ? 'turnin' : 'apex', turn: agrees });
      };
      if (r.dApex < -along || (tiOk && r.dTurn < -along && r.dApex <= 3)) sides('early', -1);
      else if (r.dApex > along || (tiOk && r.dTurn > along && r.dApex >= -3)) sides('late', 1);
      if (r.entry != null && r.entry > lat) r.issues.push({ kind: 'entry', phase: 'turnin' });
      if (r.apexIn > lat) r.issues.push({ kind: 'apex', phase: 'apex' });
      if (r.exit != null && r.exit > lat) r.issues.push({ kind: 'exit', phase: 'exit' });
      return r;
    });
    // faster (or no slower) than the ideal through a corner the ideal compromises, and paid for it in the next one
    out.forEach((r, ci) => {
      const nx = out[ci + 1];
      if (nx && nx.cost > 0.04 && (r.dv >= 2.5 || (r.cost < -0.03 && !nx.issues.length))) r.issues.push({ kind: 'priority', phase: 'apex' });
    });
    // a corner that cost real time with nothing over the line: name its biggest deviation if it's at least half way there
    out.forEach((r, ci) => {
      if (r.issues.length || r.cost < 0.08 || (ci && out[ci - 1].issues.some((is) => is.kind === 'priority'))) return;
      const tiOk = !(ci > 0 && I[ci - 1].to == null) && Math.abs(r.dTurn) < 45;
      const cand = [
        ['apexT', Math.abs(r.dApex) / along],
        ['turnT', tiOk ? Math.abs(r.dTurn) / along : 0],
        ['entry', r.entry != null ? r.entry / lat : 0],
        ['apex', r.apexIn / lat],
        ['exit', r.exit != null ? r.exit / lat : 0],
      ].sort((a, b) => b[1] - a[1])[0];
      if (cand[1] < 0.5) return;
      if (cand[0] === 'apexT') r.issues.push({ kind: r.dApex < 0 ? 'early' : 'late', phase: 'apex' });
      else if (cand[0] === 'turnT') r.issues.push({ kind: r.dTurn < 0 ? 'early' : 'late', phase: 'turnin', turn: true });
      else r.issues.push({ kind: cand[0], phase: cand[0] === 'entry' ? 'turnin' : cand[0] });
    });
    out.bounds = bounds;
    return out;
  }

  // ------------------------------------------------------------- top-down
  /** Display window: the complex plus a stub of each straight. */
  function windowOf(geo) {
    const C = geo.corners;
    return { sA: Math.max(0, C[0].startPos - 75), sB: Math.min(geo.sEnd, C[C.length - 1].endPos + 80) };
  }

  /**
   * Fit the complex (or window win = {sA, sB}) into a w x h box: best
   * rotation (10° steps), approach kept pointing up-ish on ties.
   * o.rot (rad) fixes the rotation (to match another view).
   * o.upright = s: for drawing on. The track at s (the approach) runs
   * straight up the screen, so every line is drawn bottom to top, the way
   * the car is driving, instead of along a diagonal.
   */
  function fitView(geo, w, h, pad, win, o) {
    pad = pad == null ? 18 : pad;
    win = win || windowOf(geo);
    o = o || {};
    const rots = [];
    const i0 = Math.round(win.sA / DS), i1 = Math.round(win.sB / DS);
    if (o.rot != null) rots.push(o.rot);
    else if (o.upright != null) rots.push(-Math.PI / 2 - geo.th[Math.round(o.upright / DS)]); // heading a shows as a + r; up the screen is -π/2
    else for (let deg = 0; deg < 360; deg += 10) rots.push((deg * Math.PI) / 180);
    const pts = [];
    for (let i = i0; i <= i1; i += 3) {
      for (const e of [-1.3, 1.3]) pts.push([geo.cx[i] + e * HW * geo.nx[i], geo.cy[i] + e * HW * geo.ny[i]]);
    }
    let best = null;
    for (const r of rots) {
      const c = Math.cos(r), s = Math.sin(r);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of pts) {
        const X = p[0] * c - p[1] * s, Y = p[0] * s + p[1] * c;
        if (X < x0) x0 = X;
        if (X > x1) x1 = X;
        if (Y < y0) y0 = Y;
        if (Y > y1) y1 = Y;
      }
      const scale = Math.min((w - 2 * pad) / (x1 - x0), (h - 2 * pad) / (y1 - y0));
      // approach heading after rotation: prefer travelling up the screen
      const ah = geo.th[i0] + r;
      const score = scale * (1 + 0.06 * Math.max(0, -Math.sin(ah)) + 0.01 * -Math.cos(ah + Math.PI / 2));
      if (!best || score > best.score) best = { score, r, c, s, scale, x0, x1, y0, y1 };
    }
    const b = best;
    const ox = (w - (b.x1 - b.x0) * b.scale) / 2 - b.x0 * b.scale;
    const oy = (h - (b.y1 - b.y0) * b.scale) / 2 - b.y0 * b.scale;
    return {
      w, h, scale: b.scale, rot: b.r, win, i0, i1,
      map: (x, y) => [ox + (x * b.c - y * b.s) * b.scale, oy + (x * b.s + y * b.c) * b.scale],
      unmap: (X, Y) => {
        const x = (X - ox) / b.scale, y = (Y - oy) / b.scale;
        return [x * b.c + y * b.s, -x * b.s + y * b.c];
      },
    };
  }

  function edgePath(g, geo, V, from, to, e) {
    g.beginPath();
    for (let i = from; i <= to; i++) {
      const p = V.map(geo.cx[i] + e * HW * geo.nx[i], geo.cy[i] + e * HW * geo.ny[i]);
      if (i === from) g.moveTo(p[0], p[1]);
      else g.lineTo(p[0], p[1]);
    }
  }

  /** Track surface, edge lines, kerbs, direction arrow, turn numbers and straight labels. */
  function drawTrack(g, geo, V, o) {
    o = o || {};
    const sc = V.scale, i0 = V.i0, i1 = V.i1;
    g.save();
    g.lineJoin = 'round';
    g.lineCap = 'butt';
    edgePath(g, geo, V, i0, i1, 0);
    g.strokeStyle = 'rgba(220,224,232,0.85)';
    g.lineWidth = (2 * HW + 1) * sc;
    g.stroke();
    g.strokeStyle = o.road || '#383b44';
    g.lineWidth = 2 * HW * sc;
    g.stroke();
    // kerbs on both edges through each corner
    const kw = Math.max(2, 1.1 * sc);
    geo.corners.forEach((c) => {
      const a = Math.round(c.startPos / DS), b = Math.round(c.endPos / DS);
      for (const e of [-1.04, 1.04]) {
        edgePath(g, geo, V, a, b, e);
        g.lineWidth = kw;
        g.setLineDash([]);
        g.strokeStyle = '#f2f2f2';
        g.stroke();
        g.setLineDash([Math.max(3, 3 * sc), Math.max(3, 3 * sc)]);
        g.strokeStyle = '#d23a32';
        g.stroke();
      }
    });
    g.setLineDash([]);
    // fade the straight stubs into the background
    const fade = (from, to, rev) => {
      const n = to - from;
      for (let i = 0; i < n; i += 2) {
        const t = i / n, a = rev ? t : 1 - t;
        g.globalAlpha = 0.55 * a * a;
        edgePath(g, geo, V, from + i, Math.min(to, from + i + 2), 0);
        g.strokeStyle = o.bg || '#141a16';
        g.lineWidth = (2 * HW + 1.6) * sc;
        g.stroke();
      }
      g.globalAlpha = 1;
    };
    const fadeLen = Math.round(28 / DS);
    fade(i0, i0 + fadeLen, false);
    fade(i1 - fadeLen, i1, true);
    // direction arrow on the approach
    const ia = i0 + fadeLen + 4;
    const p = V.map(geo.cx[ia], geo.cy[ia]), q = V.map(geo.cx[ia + 6], geo.cy[ia + 6]);
    const ang = Math.atan2(q[1] - p[1], q[0] - p[0]), L = Math.max(7, HW * sc * 0.9);
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.beginPath();
    g.moveTo(p[0] + Math.cos(ang) * L, p[1] + Math.sin(ang) * L);
    g.lineTo(p[0] + Math.cos(ang + 2.5) * L * 0.8, p[1] + Math.sin(ang + 2.5) * L * 0.8);
    g.lineTo(p[0] + Math.cos(ang - 2.5) * L * 0.8, p[1] + Math.sin(ang - 2.5) * L * 0.8);
    g.closePath();
    g.fill();
    if (o.labels !== false) {
      const fs = o.fontSize || 12;
      geo.corners.forEach((c, i) => {
        const im = Math.round((c.startPos + c.endPos) / 2 / DS);
        const e = -c.dir * (1 + 14 / HW / Math.max(0.6, sc));
        const t = V.map(geo.cx[im] + e * HW * geo.nx[im], geo.cy[im] + e * HW * geo.ny[im]);
        IST.Symbols.text(g, 'T' + (i + 1), U.clamp(t[0], 14, V.w - 14), U.clamp(t[1], 12, V.h - 6), { align: 'center', baseline: 'middle', size: fs, weight: 820, color: '#cfd5df', alpha: 0.85 });
      });
      // what follows matters: label the exit straight
      const ie = i1 - Math.round(20 / DS);
      const e1 = V.map(geo.cx[ie], geo.cy[ie]), e2 = V.map(geo.cx[i1], geo.cy[i1]);
      const ea = Math.atan2(e2[1] - e1[1], e2[0] - e1[0]);
      const lx = U.clamp(e2[0] + Math.cos(ea) * 6, 30, V.w - 30), ly = U.clamp(e2[1] + Math.sin(ea) * 6, 12, V.h - 8);
      const al = Math.cos(ea) > 0.4 ? 'right' : Math.cos(ea) < -0.4 ? 'left' : 'center';
      IST.Symbols.text(g, Math.round(geo.exitLen / 10) * 10 + ' m straight', al === 'right' ? Math.min(V.w - 6, lx + 20) : al === 'left' ? Math.max(6, lx - 20) : lx, ly + (Math.sin(ea) > 0.5 ? 2 : Math.sin(ea) < -0.5 ? 10 : 4), { align: al, baseline: 'middle', size: fs, weight: 720, color: '#f6d98f', alpha: 0.9 });
    }
    g.restore();
  }

  /** Stroke a simulated line (sim.px/py) between track positions. */
  function drawLine(g, geo, V, sim, o) {
    o = o || {};
    const a = Math.max(V.i0, Math.round((o.from != null ? o.from : 0) / DS));
    const b = Math.min(V.i1, sim.iStop, Math.round((o.to != null ? o.to : geo.sEnd) / DS));
    if (b <= a) return;
    g.save();
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.beginPath();
    for (let i = a; i <= b; i++) {
      const p = V.map(sim.px[i], sim.py[i]);
      if (i === a) g.moveTo(p[0], p[1]);
      else g.lineTo(p[0], p[1]);
    }
    if (o.glow) {
      g.shadowColor = o.color;
      g.shadowBlur = o.glow;
    }
    if (o.dash) g.setLineDash(o.dash);
    g.globalAlpha = o.alpha == null ? 1 : o.alpha;
    g.strokeStyle = o.color || '#f6d98f';
    g.lineWidth = o.width || 2.5;
    g.stroke();
    g.restore();
  }

  /** Screen position of a line at track position s in view V. */
  function pointAt(geo, V, sim, s) {
    return V.map(sampleAt(sim.px, sim, s), sampleAt(sim.py, sim, s));
  }

  IST.LineLab = {
    SEG, HW, DS, NMAX, CAR, FLAWS, BANDS, MAX_LEVEL,
    build, knots, template, ctrlToN, simulate, optimize, optimizeGen, run, solveGen, solveIdeal, priorityGen, priorityLines, lineFrom, applyFlaw, distractors,
    latA, brkA, phases, timeAt, sampleAt, sampleN, posAtTime, maxDev, project, fitDrawn, intentGen, judge,
    windowOf, fitView, drawTrack, drawLine, pointAt,
  };
})();
