/*
 * Lines laps up for comparison. Pure functions, no DOM.
 *
 *   IST.Review.Compare.build(ref, laps, colors, track?)  -> comparison (below)
 *     track: { lines: [[[x, y], ...], ...], halfWidth? }, from the map
 *   IST.Review.Compare.fmtLap(s)         1:42.315
 *
 * Every lap is sampled on the reference lap's distance grid by fraction of
 * lap (point k of the reference sits at k / (n - 1) of each lap), so the same
 * corner is at the same index even when lines differ in length. The delta at
 * k is that lap's time to there minus the reference's, so at the line it
 * equals the lap-time difference.
 *
 * Comparison:
 *   { n, step, len, laps: [{ lap, color, t, x, y, z, speed, throttle, brake,
 *     steer, gear, ... (every T.LAP_CHANNELS channel), delta, gain (s / 100 m), off,
 *     events (derive.js, on this grid), shifts: [{ i, from, to }] }],
 *     centre: { x, y, z, w (half width), source }, bounds: { x0, x1, y0, y1, z0, z1 },
 *     corners, complexes (findCorners, below) }
 * laps[0] is the reference.
 *
 * The track's centre comes from the map when there is one (track.lines, in
 * the laps' frame: see track.js), so a line that clips an apex is drawn off
 * centre. Without a map it's the laps' average path, which follows the
 * drivers' lines: an estimate, since telemetry has no track edges.
 * centre.source says which ('map' | 'laps'). The half width covers every
 * lap plus a margin (at least 5 m each side), or the map's width if wider.
 * Each lap's off[i] is its signed distance from the centre (m, + left).
 */
(function () {
  'use strict';
  IST.Review = IST.Review || {};
  const TL = IST.Telemetry.lib();
  const KEYS = TL.LAP_CHANNELS, STEP = new Set(TL.STEP_CHANNELS);

  /** m: how a part lap sits on the grid (see place), else the lap is spread over it by fraction of lap. */
  function sampleOn(lap, n, m) {
    const out = {};
    const last = lap.n - 1;
    KEYS.forEach((k) => {
      const a = lap[k];
      if (!a) return (out[k] = null);
      const o = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const f = m ? m.at[i] : (i / (n - 1)) * last;
        const j = Math.min(last - 1, Math.floor(f));
        const r = f - j;
        o[i] = STEP.has(k) ? (r < 0.5 ? a[j] : a[j + 1]) : a[j] + (a[j + 1] - a[j]) * r;
      }
      out[k] = o;
    });
    // the end of the lap is the lap time, exactly
    if (!m) out.t[n - 1] = lap.time;
    return out;
  }
  /**
   * Part laps (runs at one section after a reset, an out lap) start and stop at different
   * places, so a fraction of each isn't the same spot on the track. Each grid point takes the
   * part of the lap nearest it on the ground, working forwards from where one joins the other:
   * -> { at (lap index per grid point), start, end }. Outside start..end the lap isn't there.
   */
  function place(ref, lap, n) {
    const part = (l) => !!l.kind && l.kind !== 'full';
    if (!part(ref) && !part(lap)) return null;
    const d2 = (A, i, B, j) => (A.x[i] - B.x[j]) * (A.x[i] - B.x[j]) + (A.y[i] - B.y[j]) * (A.y[i] - B.y[j]);
    const nearest = (L, P) => {
      let best = Infinity, at = 0;
      for (let i = 0; i < L.n; i++) if (d2(L, i, P, 0) < best) (best = d2(L, i, P, 0)), (at = i);
      return { at, d: Math.sqrt(best) };
    };
    const onRef = nearest(ref, lap), onLap = nearest(lap, ref);
    if (Math.min(onRef.d, onLap.d) > 30) return null;
    const start = onRef.d <= onLap.d ? onRef.at : 0, last = lap.n - 1, at = new Float32Array(n);
    // (the search only looks a little ahead, so a lap that crosses its own path can't skip round)
    const reach = Math.ceil(25 / lap.step);
    let j = onRef.d <= onLap.d ? 0 : onLap.at, end = n - 1;
    for (let i = start; i < n; i++) {
      let best = Infinity, bj = j;
      for (let q = j; q <= Math.min(last, j + reach); q++) if (d2(ref, i, lap, q) < best) (best = d2(ref, i, lap, q)), (bj = q);
      j = bj;
      // between samples: the foot of the grid point on the stretch to the next one
      let f = j;
      if (j < last) {
        const ax = lap.x[j + 1] - lap.x[j], ay = lap.y[j + 1] - lap.y[j], l2 = ax * ax + ay * ay;
        if (l2 > 0) f = j + Math.max(0, Math.min(1, ((ref.x[i] - lap.x[j]) * ax + (ref.y[i] - lap.y[j]) * ay) / l2));
      }
      at[i] = f;
      if (j >= last) {
        end = i;
        break;
      }
    }
    at.fill(at[start], 0, start);
    at.fill(at[end], end);
    return { at, start, end };
  }

  // the map centre under a reference lap only changes with the lap or the map: keep it
  const centres = new WeakMap(); // ref lap -> { lines, step, c }
  function centreFor(ref, lines, step) {
    const hit = centres.get(ref);
    if (hit && hit.lines === lines && hit.step === step) return hit.c;
    const c = IST.Review.Track.centreOn(ref.x, ref.y, lines, step);
    centres.set(ref, { lines, step, c });
    return c;
  }

  function build(ref, laps, colors, track) {
    const all = [ref].concat(laps.filter((l) => l !== ref));
    const n = ref.n, step = ref.len / (n - 1);
    const out = all.map((lap, i) => {
      const m = lap === ref ? null : place(ref, lap, n);
      const s = lap === ref ? Object.assign({}, ...KEYS.map((k) => ({ [k]: lap[k] }))) : sampleOn(lap, n, m);
      s.start = m ? m.start : 0;
      s.end = m ? m.end : n - 1;
      // (its clock set to the reference's where it joins, so the two cars are there together)
      if (m) for (let i = 0, t0 = s.t[m.start] - ref.t[m.start]; i < n; i++) s.t[i] -= t0;
      if (lap === ref) {
        s.t = Float32Array.from(lap.t);
        s.t[n - 1] = lap.time;
      }
      s.lap = lap;
      s.color = colors ? colors[i % colors.length] : null;
      // events onto the reference grid, by the same fraction-of-lap mapping
      const f = lap === ref ? 1 : (n - 1) / Math.max(1, lap.n - 1);
      const at = (j) => {
        if (!m) return Math.max(0, Math.min(n - 1, Math.round(j * f)));
        let i = m.start;
        while (i < m.end && m.at[i] < j) i++;
        return i;
      };
      s.events = (lap.events || []).map((e) => Object.assign({}, e, { i0: at(e.i0), i1: at(e.i1), iPeak: at(e.iPeak) }));
      return s;
    });
    out.forEach((s) => {
      s.delta = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const k = Math.max(s.start, Math.min(s.end, i));
        s.delta[i] = s.t[k] - out[0].t[k];
      }
      // time gained (-) or lost (+) on the reference, s per 100 m, smoothed over ~20 m
      s.gain = new Float32Array(n);
      if (s !== out[0]) {
        const w = Math.max(1, Math.round(10 / step));
        for (let i = 0; i < n; i++) {
          const a = Math.max(0, i - w), b = Math.min(n - 1, i + w);
          s.gain[i] = b > a ? ((s.delta[b] - s.delta[a]) / ((b - a) * step)) * 100 : 0;
        }
      }
      s.shifts = [];
      if (s.gear) {
        for (let i = 1; i < n; i++) {
          if (s.gear[i] !== s.gear[i - 1] && s.gear[i] > 0 && s.gear[i - 1] > 0) s.shifts.push({ i, from: s.gear[i - 1], to: s.gear[i] });
        }
      }
    });

    // centre: the map's, else the laps' average path
    const cx = new Float32Array(n), cy = new Float32Array(n), cz = new Float32Array(n), w = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let sx = 0, sy = 0, sz = 0, m = 0;
      // (a lap that isn't there yet, or has stopped short, isn't averaged in)
      out.forEach((s) => i >= s.start && i <= s.end && ((sx += s.x[i]), (sy += s.y[i]), (sz += s.z[i]), m++));
      cx[i] = sx / m;
      cy[i] = sy / m;
      cz[i] = sz / m;
    }
    const onMap = track && track.lines && track.lines.length ? centreFor(ref, track.lines, step) : null;
    if (onMap) {
      cx.set(onMap.x);
      cy.set(onMap.y);
    }
    // each lap's signed distance from the centre (+ left of travel)
    out.forEach((s) => {
      s.off = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - 3), b = Math.min(n - 1, i + 3);
        const tx = cx[b] - cx[a], ty = cy[b] - cy[a], l = Math.hypot(tx, ty) || 1;
        s.off[i] = ((s.x[i] - cx[i]) * -ty + (s.y[i] - cy[i]) * tx) / l;
        w[i] = Math.max(w[i], Math.abs(s.off[i]));
      }
    });
    // smooth the width over ~60 m so the edges don't wobble with the lines
    const win = Math.max(2, Math.round(30 / step));
    const ws = new Float32Array(n);
    const minW = Math.max(5, (onMap && track.halfWidth) || 0);
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let k = -win; k <= win; k++) m = Math.max(m, w[Math.min(n - 1, Math.max(0, i + k))]);
      ws[i] = Math.max(minW, m + (onMap ? 1 : 2.5));
    }
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < n; i++) {
      x0 = Math.min(x0, cx[i]);
      x1 = Math.max(x1, cx[i]);
      y0 = Math.min(y0, cy[i]);
      y1 = Math.max(y1, cy[i]);
      z0 = Math.min(z0, cz[i]);
      z1 = Math.max(z1, cz[i]);
    }
    const corners = findCorners(out[0], n, step);
    return { n, step, len: ref.len, laps: out, centre: { x: cx, y: cy, z: cz, w: ws, source: onMap ? 'map' : 'laps' }, bounds: { x0, x1, y0, y1, z0, z1 }, corners: corners.list, complexes: corners.complexes };
  }

  /*
   * Corners from the reference lap: an apex is a speed minimum that the car
   * slows at least ~12 km/h into and speeds up at least ~9 km/h out of
   * (flat-out kinks don't count). dir is +1 for a left-hander, -1 right,
   * from the heading change across the apex. Apexes less than 300 m apart
   * form a complex (a chicane, esses, a double apex).
   *   list:      [{ apex, start, end, dir, complex }]   indices on the grid
   *   complexes: [{ first, last, corners: [k...] }]
   */
  function findCorners(ref, n, step) {
    const v = ref.speed, W = Math.max(1, Math.round(10 / step));
    const sm = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let k = -W; k <= W; k++) {
        const j = i + k;
        if (j >= 0 && j < n) (s += v[j]), c++;
      }
      sm[i] = s / c;
    }
    const win = Math.round(60 / step), reach = Math.round(250 / step);
    const apexes = [];
    for (let i = 1; i < n - 1; i++) {
      let isMin = true;
      for (let k = Math.max(0, i - win); k <= Math.min(n - 1, i + win) && isMin; k++) if (sm[k] < sm[i]) isMin = false;
      if (!isMin) continue;
      let before = 0, after = 0;
      for (let k = Math.max(0, i - reach); k < i; k++) before = Math.max(before, sm[k]);
      for (let k = i + 1; k <= Math.min(n - 1, i + reach); k++) after = Math.max(after, sm[k]);
      if (before - sm[i] < 3.3 || after - sm[i] < 2.5) continue;
      if (apexes.length && (i - apexes[apexes.length - 1]) * step < 30) continue;
      apexes.push(i);
    }
    const head = (i) => {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      return Math.atan2(ref.y[b] - ref.y[a], ref.x[b] - ref.x[a]);
    };
    const off = Math.round(30 / step);
    const list = apexes.map((apex, k) => {
      const prev = k ? apexes[k - 1] : 0, next = k < apexes.length - 1 ? apexes[k + 1] : n - 1;
      let start = prev, end = next;
      for (let i = prev; i < apex; i++) if (sm[i] > sm[start]) start = i;
      for (let i = apex; i <= next; i++) if (sm[i] > sm[end]) end = i;
      const dh = head(Math.min(n - 1, apex + off)) - head(Math.max(0, apex - off));
      return { apex, start, end, dir: Math.sin(dh) >= 0 ? 1 : -1, complex: -1 };
    });
    const complexes = [];
    list.forEach((c, k) => {
      const last = complexes[complexes.length - 1];
      if (last && (c.apex - list[last.corners[last.corners.length - 1]].apex) * step < 300) last.corners.push(k);
      else complexes.push({ corners: [k] });
    });
    complexes.forEach((cx, j) => {
      cx.first = list[cx.corners[0]].start;
      cx.last = list[cx.corners[cx.corners.length - 1]].end;
      cx.corners.forEach((k) => (list[k].complex = j));
    });
    return { list, complexes };
  }

  function fmtLap(s) {
    if (!isFinite(s)) return '–';
    s = Math.round(s * 1000) / 1000; // to the millisecond first, so 119.9996 is 2:00.000, not 1:60.000
    const m = Math.floor(s / 60);
    const r = s - m * 60;
    return (m ? m + ':' + (r < 10 ? '0' : '') : '') + r.toFixed(3);
  }

  IST.Review.Compare = { build, fmtLap };
})();
