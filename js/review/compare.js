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

  function sampleOn(lap, n) {
    const out = {};
    const last = lap.n - 1;
    KEYS.forEach((k) => {
      const a = lap[k];
      if (!a) return (out[k] = null);
      const o = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const f = (i / (n - 1)) * last;
        const j = Math.min(last - 1, Math.floor(f));
        const r = f - j;
        o[i] = STEP.has(k) ? (r < 0.5 ? a[j] : a[j + 1]) : a[j] + (a[j + 1] - a[j]) * r;
      }
      out[k] = o;
    });
    // the end of the lap is the lap time, exactly
    out.t[n - 1] = lap.time;
    return out;
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
      const s = lap === ref ? Object.assign({}, ...KEYS.map((k) => ({ [k]: lap[k] }))) : sampleOn(lap, n);
      if (lap === ref) {
        s.t = Float32Array.from(lap.t);
        s.t[n - 1] = lap.time;
      }
      s.lap = lap;
      s.color = colors ? colors[i % colors.length] : null;
      // events onto the reference grid, by the same fraction-of-lap mapping
      const f = lap === ref ? 1 : (n - 1) / Math.max(1, lap.n - 1);
      const at = (j) => Math.max(0, Math.min(n - 1, Math.round(j * f)));
      s.events = (lap.events || []).map((e) => Object.assign({}, e, { i0: at(e.i0), i1: at(e.i1), iPeak: at(e.iPeak) }));
      return s;
    });
    out.forEach((s) => {
      s.delta = new Float32Array(n);
      for (let i = 0; i < n; i++) s.delta[i] = s.t[i] - out[0].t[i];
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
      let sx = 0, sy = 0, sz = 0;
      out.forEach((s) => ((sx += s.x[i]), (sy += s.y[i]), (sz += s.z[i])));
      cx[i] = sx / out.length;
      cy[i] = sy / out.length;
      cz[i] = sz / out.length;
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
