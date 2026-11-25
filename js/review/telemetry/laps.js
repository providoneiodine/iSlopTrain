/*
 * From a parsed session to laps you can compare. A factory: see common.js.
 *
 *   T.laps(session, opt)            -> { laps, posSource, trackLen, warnings }
 *   T.process(name, buf, opt)       parse + laps, what the Worker runs per file
 *
 * Steps:
 *   1. Distance travelled, integrated from speed (or from positions).
 *   2. World position: exported x/y/z, else GPS turned into metres, else
 *      dead-reckoned from speed and heading (yaw, yaw rate, or lateral g / speed),
 *      with each lap's drift spread back along it so it closes on itself.
 *   3. Lap boundaries: a lap-number channel, else a lap-distance wrap, else
 *      .ldx beacons, else the whole run as one segment. Crossings are
 *      interpolated between samples so lap times are good to a few ms.
 *   4. Each lap resampled every opt.step metres (default 1) along its own
 *      distance, so laps line up by distance, not time.
 *
 * A lap record (Float32Array channels, all n long, index i at i * step metres):
 *   { lapNo, kind: 'full' | 'out' | 'in' | 'partial', pit, time (s), len (m), step, n,
 *     t (s from the line), x, y, z (m, z up), speed (m/s), throttle, brake (0..1),
 *     steer (rad), gear, rpm, ... every channel in T.LAP_CHANNELS (common.js), derived ones
 *     included; events: T.events (derive.js) }  missing channels are null.
 */
(function () {
  'use strict';
  IST.Telemetry.def('laps', function (T) {
    const R_EARTH = 6371008.8;

    const median = (a) => {
      if (!a.length) return NaN;
      const s = a.slice().sort((x, y) => x - y);
      return s[s.length >> 1];
    };
    const range = (a) => {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < a.length; i++) {
        if (a[i] < lo) lo = a[i];
        if (a[i] > hi) hi = a[i];
      }
      return hi - lo;
    };

    /**
     * A channel logged in coarse steps (iRacing's Alt comes in 0.1 m steps, so a gentle
     * slope reads as a staircase). The true value is known where the level changes: half
     * way between the two. Straight lines join those points along the distance travelled.
     */
    function unstep(a, t, v) {
      const n = a.length;
      let q = Infinity, changes = 0;
      for (let i = 1; i < n; i++) {
        const d = Math.abs(a[i] - a[i - 1]);
        if (d > 0) changes++, (q = Math.min(q, d));
      }
      // a channel that changes on most samples isn't stepped: left as it is
      if (!changes || changes > n * 0.5) return Float64Array.from(a);
      const dist = new Float64Array(n), out = new Float64Array(n);
      for (let i = 1; i < n; i++) dist[i] = dist[i - 1] + Math.abs(v[i]) * Math.max(0, t[i] - t[i - 1]);
      let i0 = -1, v0 = 0;
      for (let i = 1; i < n; i++) {
        // (a jump of several steps at once is a glitch or a reset, not a slope)
        if (a[i] === a[i - 1] || Math.abs(a[i] - a[i - 1]) > q * 3) continue;
        const v1 = (a[i] + a[i - 1]) / 2, span = dist[i] - (i0 < 0 ? 0 : dist[i0]);
        for (let j = Math.max(0, i0); j <= i; j++) {
          const f = i0 < 0 ? 1 : span > 0 ? (dist[j] - dist[i0]) / span : (j - i0) / (i - i0);
          out[j] = i0 < 0 ? v1 : v0 + (v1 - v0) * f;
        }
        (i0 = i), (v0 = v1);
      }
      if (i0 < 0) return Float64Array.from(a);
      for (let j = i0; j < n; j++) out[j] = v0;
      return out;
    }

    /** World position (m, z up) for every sample, and where it came from. */
    function positions(S, t, v) {
      const C = S.ch, n = S.n;
      if (C.x && C.y && range(C.x) + range(C.y) > 50) {
        // which axis is up? the one that varies least (sims are often y-up)
        const ax = [C.x, C.y, C.z].filter(Boolean);
        let up = -1;
        if (ax.length === 3) {
          const r = ax.map(range);
          up = r.indexOf(Math.min.apply(null, r));
        }
        const flat = [0, 1, 2].filter((k) => k !== up && ax[k]);
        // y-up sims are left-handed (x right, z forward): mirror so the map isn't flipped
        const mirror = up === 1 ? -1 : 1;
        const X = Float64Array.from(ax[flat[0]]), Y = Float64Array.from(ax[flat[1]]).map((q) => q * mirror);
        return { x: X, y: Y, z: up >= 0 ? Float64Array.from(ax[up]) : new Float64Array(n), source: 'world' };
      }
      if (C.lat && C.lon && range(C.lat) + range(C.lon) > 1e-4) {
        let lat0 = 0, lon0 = 0, k = 0;
        for (let i = 0; i < n; i += Math.max(1, n >> 8)) if (C.lat[i] || C.lon[i]) (lat0 += C.lat[i]), (lon0 += C.lon[i]), k++;
        lat0 /= k || 1;
        lon0 /= k || 1;
        // iRacing stores degrees; a few tools store radians
        const deg = Math.abs(lat0) > Math.PI / 2 + 0.01 || range(C.lat) > 0.05 || Math.abs(lon0) > Math.PI ? Math.PI / 180 : 1;
        const kx = R_EARTH * deg * Math.cos(lat0 * deg), ky = R_EARTH * deg;
        const x = new Float64Array(n), y = new Float64Array(n), z = C.alt ? Float64Array.from(C.alt) : new Float64Array(n);
        // a sample with no fix (0, 0 before the car is placed, or a glitch far from the track)
        // takes the nearest good one: left in, it puts a point of the lap half a world away
        const good = (i) => (C.lat[i] || C.lon[i]) && Math.abs(C.lat[i] - lat0) * ky < 50000 && Math.abs(C.lon[i] - lon0) * kx < 50000;
        let last = -1;
        for (let i = 0; i < n; i++) {
          if (good(i)) {
            x[i] = (C.lon[i] - lon0) * kx;
            y[i] = (C.lat[i] - lat0) * ky;
            for (let j = last < 0 ? 0 : i; j < i; j++) (x[j] = x[i]), (y[j] = y[i]), (z[j] = z[i]);
            last = i;
          } else if (last >= 0) (x[i] = x[last]), (y[i] = y[last]), (z[i] = z[last]);
        }
        return { x, y, z: C.alt ? unstep(z, t, v) : z, source: 'gps', origin: { lat: lat0 * deg * 180 / Math.PI, lon: lon0 * deg * 180 / Math.PI } };
      }
      // dead reckoning
      const x = new Float64Array(n), y = new Float64Array(n);
      let psi = 0;
      const headingFromYaw = !!C.yaw;
      if (!C.yaw && !C.yawRate && !C.latG) return { x, y, z: new Float64Array(n), source: 'none' };
      for (let i = 1; i < n; i++) {
        const dt = Math.max(0, t[i] - t[i - 1]);
        if (headingFromYaw) psi = C.yaw[i];
        else if (C.yawRate) psi += C.yawRate[i] * dt;
        else psi += (C.latG[i] / Math.max(5, v[i])) * dt;
        x[i] = x[i - 1] + v[i] * Math.cos(psi) * dt;
        y[i] = y[i - 1] + v[i] * Math.sin(psi) * dt;
      }
      return { x, y, z: new Float64Array(n), source: 'reckoned' };
    }

    /** Sample positions where one lap ends and the next starts, as fractional indices. */
    function boundaries(S, t, L) {
      const C = S.ch, n = S.n, out = [];
      const wrapAt = (d, i, len) => {
        // d drops from near len to near 0 between i-1 and i: interpolate the crossing
        const a = len - d[i - 1], b = d[i];
        return i - 1 + (a + b > 0 ? Math.min(1, Math.max(0, a / (a + b))) : 1);
      };
      const dist = C.lapDist && !monotonic(C.lapDist) ? C.lapDist : C.lapPct ? C.lapPct.map((p) => p * L) : null;
      if (C.lap) {
        for (let i = 1; i < n; i++) {
          if (C.lap[i] > C.lap[i - 1]) {
            // refine with the distance wrap nearby, if there is one
            let f = i;
            if (dist) for (let j = Math.max(1, i - 30); j < Math.min(n, i + 30); j++) if (dist[j - 1] - dist[j] > L * 0.5) f = wrapAt(dist, j, L);
            out.push(f);
          }
        }
        if (out.length) return { at: out, how: 'lap' };
      }
      if (dist) {
        for (let i = 1; i < n; i++) if (dist[i - 1] - dist[i] > L * 0.5) out.push(wrapAt(dist, i, L));
        if (out.length) return { at: out, how: 'distance' };
      }
      if (S.beacons && S.beacons.length) {
        S.beacons.forEach((bt) => {
          let lo = 0, hi = n - 1;
          while (hi - lo > 1) {
            const m = (lo + hi) >> 1;
            if (t[m] <= bt) lo = m;
            else hi = m;
          }
          const f = t[hi] > t[lo] ? lo + (bt - t[lo]) / (t[hi] - t[lo]) : lo;
          if (f > 0 && f < n - 1) out.push(f);
        });
        if (out.length) return { at: out, how: 'beacon' };
      }
      return { at: [], how: 'none' };
    }
    function monotonic(a) {
      let drops = 0;
      for (let i = 1; i < a.length; i++) if (a[i] < a[i - 1] - 1) drops++;
      return drops === 0;
    }

    const lerpAt = (a, f) => {
      const i = Math.floor(f), j = Math.min(a.length - 1, i + 1);
      return a[i] + (a[j] - a[i]) * (f - i);
    };

    T.laps = function (S, opt) {
      opt = opt || {};
      const step = opt.step || 1;
      const C = S.ch, n = S.n;
      const t = C.t ? C.t : Float64Array.from({ length: n }, (_, i) => i / S.rate);
      const warnings = (S.warnings || []).slice();

      // speed and distance travelled
      let v = C.speed;
      let P = null;
      if (!v) {
        P = positions(S, t, new Float64Array(n));
        v = new Float64Array(n);
        for (let i = 1; i < n; i++) v[i] = Math.hypot(P.x[i] - P.x[i - 1], P.y[i] - P.y[i - 1]) / Math.max(1e-3, t[i] - t[i - 1]);
        v[0] = v[1] || 0;
      }
      const cum = new Float64Array(n);
      for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + 0.5 * (Math.abs(v[i]) + Math.abs(v[i - 1])) * Math.max(0, t[i] - t[i - 1]);
      if (!P) P = positions(S, t, v);
      if (P.source === 'none') warnings.push('No position, heading or lateral-g channel: the 3D line can’t be drawn for this file.');
      if (P.source === 'reckoned') warnings.push('No world position in this file: the line is rebuilt from speed and heading, so it may drift.');

      // derived channels at the native rate (they need time for rates and lags), cut like the rest
      const D = T.derive ? T.derive(S, t) : { ch: {}, calib: null };
      Object.assign(C, D.ch);
      if (D.calib) D.calib.notes.forEach((w) => warnings.push(w));

      // track length: from the file, or the lap distance channel, or the laps themselves
      let L = S.meta.trackLen || 0;
      if (!L && C.lapDist && !monotonic(C.lapDist)) {
        let hi = 0;
        for (let i = 0; i < n; i++) if (C.lapDist[i] > hi) hi = C.lapDist[i];
        L = hi;
      }
      let B = boundaries(S, t, L || 1e9);
      if (!L && B.at.length >= 2) {
        const d = [];
        for (let k = 1; k < B.at.length; k++) d.push(lerpAt(cum, B.at[k]) - lerpAt(cum, B.at[k - 1]));
        L = median(d);
        if (C.lapPct) B = boundaries(S, t, L);
      }

      // segments between boundaries
      const cuts = [0].concat(B.at, [n - 1]);
      const segs = [];
      for (let k = 0; k < cuts.length - 1; k++) {
        const a = cuts[k], b = cuts[k + 1];
        if (b - a < 2) continue;
        segs.push({ a, b, bounded: k > 0 && k < cuts.length - 2, first: k === 0, last: k === cuts.length - 2, covered: lerpAt(cum, b) - lerpAt(cum, a) });
      }
      const full = segs.filter((s) => s.bounded).map((s) => s.covered);
      const refLen = L || median(full) || Math.max.apply(null, segs.map((s) => s.covered));
      const lapBase = C.lap ? Math.round(lerpAt(C.lap, Math.min(n - 1, (segs[0] ? segs[0].a : 0) + 1))) : 1;

      const laps = [];
      segs.forEach((s, k) => {
        // a single segment that ends where it starts is a lap (a one-lap export)
        const closes = B.how === 'none' && segs.length === 1 && Math.hypot(lerpAt(P.x, s.b) - lerpAt(P.x, s.a), lerpAt(P.y, s.b) - lerpAt(P.y, s.a)) < 40;
        let kind = 'partial';
        if ((s.bounded || closes) && s.covered > refLen * 0.9) kind = 'full';
        else if (s.first && !s.last) kind = 'out';
        else if (s.last && !s.first) kind = 'in';
        const lap = cut(S, P, t, v, cum, s, step);
        if (!lap) return;
        lap.kind = kind;
        lap.lapNo = C.lap ? Math.round(lerpAt(C.lap, Math.min(n - 1, s.a + 1))) : lapBase + k;
        if (C.onPit) {
          let pit = false;
          for (let i = Math.ceil(s.a); i <= Math.floor(s.b); i++) if (C.onPit[i] > 0.5) (pit = true), (i = n);
          lap.pit = pit;
        }
        if (kind === 'full' && P.source === 'reckoned') closeLoop(lap);
        lap.cond = lapConditions(S, s);
        lap.events = T.events ? T.events(lap) : [];
        laps.push(lap);
      });
      if (B.how === 'none' && laps.length === 1 && laps[0].kind !== 'full') warnings.push('No lap markers found: showing the whole run as one segment.');
      return { laps, posSource: P.source, origin: P.origin || null, trackLen: refLen, warnings, split: B.how, calib: D.calib };
    };

    /** A lap's conditions: the session's, overridden by the lap's own mean (or, for skies, its middle sample). */
    function lapConditions(S, s) {
      const c = Object.assign({}, S.meta.cond || {});
      const a = Math.max(0, Math.ceil(s.a)), b = Math.min(S.n - 1, Math.floor(s.b));
      for (const k in T.COND_CHANNELS) {
        const ch = S.ch[k];
        if (!ch || b < a) continue;
        if (k === 'cSkies') {
          const v = T.SKIES[Math.round(ch[(a + b) >> 1])];
          if (v) c.skies = v;
          continue;
        }
        let sum = 0, cnt = 0;
        for (let i = a; i <= b; i++) {
          if (isFinite(ch[i])) {
            sum += ch[i];
            cnt++;
          }
        }
        if (cnt) c[T.COND_CHANNELS[k]] = sum / cnt;
      }
      return c;
    }

    /** Resample one segment [s.a, s.b] (fractional sample indices) every `step` metres. */
    function cut(S, P, t, v, cum, s, step) {
      const C = S.ch;
      const d0 = lerpAt(cum, s.a), len = lerpAt(cum, s.b) - d0;
      if (!(len > step * 10)) return null;
      const m = Math.floor(len / step) + 1;
      const OUT = T.LAP_CHANNELS, STEP = {};
      T.STEP_CHANNELS.forEach((k) => (STEP[k] = true));
      const src = Object.assign({}, C, { t, x: P.x, y: P.y, z: P.z, speed: v });
      const out = {};
      OUT.forEach((k) => (out[k] = src[k] ? new Float32Array(m) : null));
      const t0 = lerpAt(t, s.a);
      let j = Math.floor(s.a);
      const jEnd = Math.ceil(s.b);
      for (let i = 0; i < m; i++) {
        const g = d0 + i * step;
        while (j < jEnd - 1 && cum[j + 1] <= g) j++;
        const span = cum[j + 1] - cum[j];
        const f = span > 0 ? Math.min(1, Math.max(0, (g - cum[j]) / span)) : 0;
        for (const k of OUT) {
          const a = src[k];
          if (!a) continue;
          out[k][i] = STEP[k] ? (f < 0.5 ? a[j] : a[j + 1]) : a[j] + (a[j + 1] - a[j]) * f;
        }
        out.t[i] -= t0;
      }
      const time = lerpAt(t, s.b) - t0;
      return Object.assign(out, { time, len, step, n: m });
    }

    /** Spread a dead-reckoned lap's closing error back along it. */
    function closeLoop(lap) {
      const n = lap.n, ex = lap.x[n - 1] - lap.x[0], ey = lap.y[n - 1] - lap.y[0];
      for (let i = 0; i < n; i++) {
        const f = i / (n - 1);
        lap.x[i] -= ex * f;
        lap.y[i] -= ey * f;
      }
    }

    /** Parse one file and cut its laps. buf is an ArrayBuffer; opt: { sidecar, progress, step }. */
    T.process = function (name, buf, opt) {
      opt = opt || {};
      const u8 = new Uint8Array(buf, 0, Math.min(64, buf.byteLength));
      const F = T.pick(name, u8);
      if (!F) throw new Error('Unknown file type. Supported: .ibt, .ld (+ .ldx), .csv');
      const prog = opt.progress || function () {};
      const S = F.parse(buf, name, { sidecar: opt.sidecar, progress: (p) => prog(0.1 + 0.7 * p, 'Reading ' + F.label) });
      prog(0.85, 'Cutting laps');
      const R = T.laps(S, { step: opt.step });
      return { name, format: F.label, meta: S.meta, rate: S.rate, laps: R.laps, posSource: R.posSource, origin: R.origin, trackLen: R.trackLen, split: R.split, warnings: R.warnings, channels: Object.keys(S.ch), calib: R.calib };
    };
  });
})();
