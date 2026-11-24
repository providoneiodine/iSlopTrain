/*
 * A made-up session to try the viewer without a telemetry file: a generated
 * closed circuit and a GT-like car doing an out lap, three timed laps and
 * part of an in lap, written out as a CSV export so it goes through the same
 * import path as a real file.
 *
 *   IST.Review.Demo.csv(seed) -> CSV text
 *
 * The laps differ on purpose: lap 2 brakes early and soft for one corner,
 * lap 3 carries less speed through another. The physics is a simple
 * point-mass speed profile (grip, braking and power limits), not LineLab's
 * solver: it's for showing the viewer, not for judging a line.
 */
(function () {
  'use strict';
  IST.Review = IST.Review || {};
  const U = IST.util;

  function circuit(rng) {
    // control points round a loop, radius varied for corners, then a closed Catmull-Rom spline
    const K = 12, R = 520, pts = [];
    for (let k = 0; k < K; k++) {
      const a = (k / K) * Math.PI * 2 + rng.range(-0.12, 0.12);
      const r = R * (k % 4 === 1 ? rng.range(0.45, 0.6) : rng.range(0.8, 1.15));
      pts.push([Math.cos(a) * r * 1.35, Math.sin(a) * r]);
    }
    const dense = [];
    for (let k = 0; k < K; k++) {
      const p0 = pts[(k + K - 1) % K], p1 = pts[k], p2 = pts[(k + 1) % K], p3 = pts[(k + 2) % K];
      for (let s = 0; s < 60; s++) {
        const t = s / 60, t2 = t * t, t3 = t2 * t;
        dense.push([0, 1].map((d) => 0.5 * (2 * p1[d] + (-p0[d] + p2[d]) * t + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3)));
      }
    }
    // resample every metre
    const out = [[dense[0][0], dense[0][1]]];
    let carry = 0;
    for (let i = 1; i <= dense.length; i++) {
      const a = dense[i - 1], b = dense[i % dense.length];
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      let d = 1 - carry;
      while (d <= seg) {
        out.push([a[0] + ((b[0] - a[0]) * d) / seg, a[1] + ((b[1] - a[1]) * d) / seg]);
        d += 1;
      }
      carry = seg - (d - 1);
    }
    out.pop();
    const n = out.length;
    // curvature, smoothed over ±8 m
    const raw = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = out[(i + n - 1) % n], b = out[i], c = out[(i + 1) % n];
      const h1 = Math.atan2(b[1] - a[1], b[0] - a[0]), h2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
      raw[i] = Math.atan2(Math.sin(h2 - h1), Math.cos(h2 - h1));
    }
    const smooth = (src, w) => {
      const o = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let k = -w; k <= w; k++) s += src[(i + k + n) % n];
        o[i] = s / (2 * w + 1);
      }
      return o;
    };
    const kappa = smooth(raw, 8);
    const wide = smooth(kappa, 45);
    const phase = rng.range(0, 6.28);
    const z = out.map((_, i) => 9 * Math.sin((i / n) * Math.PI * 2 + phase) + 3.5 * Math.sin((i / n) * Math.PI * 6 + phase * 2));
    return { pts: out, n, kappa, wide, z };
  }

  /** Speed profile (m/s per metre) for one lap's driving. */
  function profile(C, d) {
    const n = C.n, v = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const k = Math.abs(C.kappa[i]) * (d.lineK || 0.8);
      const aLat = 16.5 * (d.slowAt && inZone(i, d.slowAt, n) ? 0.9 : 1);
      v[i] = Math.min(76, k > 1e-5 ? Math.sqrt(aLat / k) : 76);
    }
    // braking backwards, twice round so the loop closes
    for (let rep = 0; rep < 2; rep++) {
      for (let i = n - 1; i >= 0; i--) {
        const j = (i + 1) % n;
        const ab = d.earlyAt && inZone(i, d.earlyAt, n) ? 10.5 : 14.5;
        v[i] = Math.min(v[i], Math.sqrt(v[j] * v[j] + 2 * ab));
      }
    }
    for (let rep = 0; rep < 2; rep++) {
      for (let i = 0; i < n; i++) {
        const p = (i + n - 1) % n;
        const aa = Math.max(0.6, 8.5 * (1 - v[p] / 82));
        v[i] = Math.min(v[i], Math.sqrt(v[p] * v[p] + 2 * aa));
      }
    }
    return v;
  }
  const inZone = (i, z, n) => ((i - z[0] + n) % n) < z[1];

  /** The slowest corner zones, for the laps' deliberate mistakes. */
  function corners(C, v) {
    const n = C.n, out = [];
    for (let i = 0; i < n; i++) {
      const a = v[(i + n - 1) % n], b = v[(i + 1) % n];
      if (v[i] <= a && v[i] < b && v[i] < 50) out.push({ i, v: v[i] });
    }
    out.sort((a, b) => a.v - b.v);
    return out;
  }

  function csv(seed) {
    const rng = U.rng(seed || 7);
    const C = circuit(rng), n = C.n;
    const base = profile(C, {});
    const cs = corners(C, base);
    const c1 = cs[0] ? cs[0].i : n >> 2, c2 = cs[1] ? cs[1].i : n >> 1;
    // per-lap driving: [lap number, profile, zone of the deliberate mistake]
    const laps = [
      { lap: 0, v: profile(C, { lineK: 1.05 }) },
      { lap: 1, v: base },
      { lap: 2, v: profile(C, { earlyAt: [(c1 - 140 + n) % n, 140] }) },
      { lap: 3, v: profile(C, { slowAt: [(c2 - 60 + n) % n, 120] }) },
      { lap: 4, v: profile(C, { lineK: 1.1 }) },
    ];
    const UP = [0, 23, 33, 42, 51, 60, 69, 999];
    const rows = ['"Format","Generated demo CSV"', '"Venue","Demo Circuit"', '"Vehicle","GT demo car"', '"Driver","You"', '',
      'Time [s],Lap,Lap Distance [m],Speed [km/h],Throttle [%],Brake [%],Steering [deg],Gear,RPM,Pos X [m],Pos Y [m],Pos Z [m]'];
    const dt = 1 / 60;
    let t = 0, s = n * 0.55, li = 0, gear = 2, blip = 0;
    const pedal = { thr: 0.5, brk: 0 };
    const inLapEnd = n * 0.3;
    const pos = (si) => {
      const i = Math.floor(si) % n, j = (i + 1) % n, f = si - Math.floor(si);
      // racing line: drift to the inside of the corners ahead, back out on the straights
      const nOff = (k) => U.clamp(Math.tanh(C.wide[k] * 260) * 4.8, -5.2, 5.2) * (li === 2 ? 0.85 : 1);
      const a = C.pts[i], b = C.pts[j];
      const tx = b[0] - a[0], ty = b[1] - a[1], tl = Math.hypot(tx, ty) || 1;
      const off = nOff(i) + (nOff(j) - nOff(i)) * f;
      return [a[0] + tx * f - (ty / tl) * off, a[1] + ty * f + (tx / tl) * off, C.z[i] + (C.z[j] - C.z[i]) * f];
    };
    for (let guard = 0; guard < 60 * 60 * 15; guard++) {
      const L = laps[li], v = L.v;
      const i = Math.floor(s) % n, j = (i + 1) % n;
      const sp = v[i] + (v[j] - v[i]) * (s - Math.floor(s));
      // longitudinal acceleration over ±4 m, so the pedals don't chatter where the profile kinks
      const va = v[(i + n - 4) % n], vb = v[(i + 4) % n];
      const acc = (vb * vb - va * va) / 16;
      let thrT, brkT = 0;
      if (acc < -1.5) brkT = Math.pow(U.clamp(-acc / 14.5, 0, 1), 0.7);
      else if (acc > 0.4) thrT = 1;
      else thrT = U.clamp(0.25 + 0.45 * (sp / 76), 0, 1);
      if (thrT == null) thrT = 0;
      // pedals move at a human rate: ~0.15 s to full brake, ~0.3 s to full throttle
      pedal.brk += U.clamp(brkT - pedal.brk, -dt / 0.25, dt / 0.12);
      pedal.thr += U.clamp(thrT - pedal.thr, -dt / 0.08, dt / 0.3);
      let thr = pedal.thr;
      const brk = pedal.brk;
      // gearbox with hysteresis, a throttle blip on each downshift
      if (sp > UP[gear] && gear < 7) gear++;
      else if (gear > 1 && sp < UP[gear - 1] - 4) {
        gear--;
        if (brk > 0) blip = 0.09;
      }
      if (blip > 0) {
        thr = Math.max(thr, 0.6);
        blip -= dt;
      }
      const rpm = 3200 + U.clamp((sp - (UP[gear - 1] - 4)) / (UP[gear] - UP[gear - 1] + 4), 0, 1.05) * 5400;
      const steer = (Math.atan(2.7 * C.kappa[i]) * 14 * 180) / Math.PI;
      const p = pos(s);
      rows.push([t.toFixed(4), L.lap, (s % n).toFixed(2), (sp * 3.6).toFixed(2), (thr * 100).toFixed(1), (brk * 100).toFixed(1), steer.toFixed(2), gear, Math.round(rpm), p[0].toFixed(2), p[1].toFixed(2), p[2].toFixed(2)].join(','));
      t += dt;
      s += sp * dt;
      if (s >= n) {
        s -= n;
        li++;
      }
      if (li === laps.length - 1 && s > inLapEnd) break;
    }
    return rows.join('\n');
  }

  IST.Review.Demo = { csv };
})();
