/*
 * How a car's body sits on the road at a point on a lap. Pure, no DOM.
 *
 *   IST.Review.Stance.at(L, j, kind, step) -> { dive, roll, heave, measured }
 *     L: a comparison lap (compare.js), j: fractional grid index, kind: Cars kind,
 *     step: metres per grid index (1 when left out)
 *     dive   rad, + nose down          roll   rad, + leaning right (left side up)
 *     heave  m, + body up              measured: from ride heights, not estimated
 *   IST.Review.Stance.wheels(L, j, step, radii) -> { LF, RF, LR, RR }, each
 *     { rot (rad rolled since the line), omega (rad/s), slip (wheel speed / car speed - 1, NaN unknown),
 *       lock, spin (0..1: slower than the car on the brakes, faster on throttle),
 *       temp ([inner, mid, outer] °C, or null) }
 *     radii: { f, r } tyre radius (m). Without usable wheel speeds a wheel rolls at road speed.
 *   IST.Review.Stance.heat(t) -> -1 (cold, 45 °C or less) .. 0 (70 to 85 °C) .. 1 (115 °C or more)
 *
 * With ride heights (iRacing) the angles are the real ones: rake against the
 * lap's usual for dive, left against right for roll, the mean for heave.
 * Without them they're estimated from the g channels at a rate typical of
 * the car type, so the body still leans the right way by about the right amount.
 */
(function () {
  'use strict';
  IST.Review = IST.Review || {};
  const G0 = 9.80665, DEG = Math.PI / 180;
  // per type: wheelbase and track (m), then estimated roll and dive per g (rad)
  const SPEC = {
    gt: { wb: 2.75, tr: 1.68, roll: 1.4 * DEG, dive: 0.8 * DEG },
    lmp: { wb: 3.0, tr: 1.6, roll: 0.6 * DEG, dive: 0.35 * DEG },
    gtp: { wb: 3.1, tr: 1.66, roll: 0.6 * DEG, dive: 0.35 * DEG },
    formula: { wb: 3.2, tr: 1.6, roll: 0.5 * DEG, dive: 0.3 * DEG },
    road: { wb: 2.65, tr: 1.55, roll: 3.2 * DEG, dive: 1.5 * DEG },
  };
  const bases = new WeakMap(); // lap -> its usual rake, side difference and ride height

  function median(n, get) {
    const s = [];
    for (let i = 0; i < n; i += 5) {
      const x = get(i);
      if (isFinite(x)) s.push(x);
    }
    s.sort((a, b) => a - b);
    return s.length ? s[s.length >> 1] : 0;
  }
  function baseOf(L) {
    let b = bases.get(L);
    if (!b) {
      const n = L.x.length, F = L.rhF, R = L.rhR, lt = L.rhLt, rt = L.rhRt;
      // ride heights in metres are a few centimetres: anything else is another unit, so not used
      const ok = !!(F && R) && Math.abs(median(n, (i) => F[i])) < 0.5;
      b = { ok, rake: ok ? median(n, (i) => R[i] - F[i]) : 0, ride: ok ? median(n, (i) => (F[i] + R[i]) / 2) : 0, sides: ok && !!(lt && rt), side: ok && lt && rt ? median(n, (i) => lt[i] - rt[i]) : 0 };
      bases.set(L, b);
    }
    return b;
  }
  /**
   * Mean round j, weighted down to nothing W samples either side. It changes smoothly as
   * j moves, so the body doesn't tick over once a metre.
   */
  function near(a, j, W) {
    const n = a.length, i0 = Math.max(0, Math.ceil(j - W)), i1 = Math.min(n - 1, Math.floor(j + W));
    let s = 0, c = 0;
    for (let i = i0; i <= i1; i++) {
      const w = 1 - Math.abs(i - j) / W;
      if (w > 0 && isFinite(a[i])) (s += a[i] * w), (c += w);
    }
    return c ? s / c : 0;
  }
  /** Linear between samples. */
  function lerpAt(a, j) {
    const i = Math.max(0, Math.min(a.length - 2, Math.floor(j)));
    return a[i] + (a[i + 1] - a[i]) * Math.max(0, Math.min(1, j - i));
  }

  function at(L, j, kind, step) {
    const S = SPEC[kind] || SPEC.road, b = baseOf(L);
    // averaged over about a fifth of a second of travel, at least ±3 samples: ride heights
    // buzz over bumps at speed, and a fixed few metres there is only a frame or two
    const v = L.speed ? lerpAt(L.speed, j) : 0;
    const W = Math.max(3, Math.min(30, ((isFinite(v) ? v : 0) * 0.1) / (step || 1)));
    let dive = 0, roll = 0, heave = 0;
    if (b.ok) {
      const f = near(L.rhF, j, W), r = near(L.rhR, j, W);
      dive = Math.atan((r - f - b.rake) / S.wb);
      heave = (f + r) / 2 - b.ride;
    } else if (L.longG) dive = (-near(L.longG, j, W) / G0) * S.dive;
    if (b.sides) roll = Math.atan((near(L.rhLt, j, W) - near(L.rhRt, j, W) - b.side) / S.tr);
    else if (L.latG) roll = (near(L.latG, j, W) / G0) * S.roll;
    return { dive, roll, heave, measured: b.ok };
  }

  // ------------------------------------------------------------------ wheels
  const WHEELS = ['LF', 'RF', 'LR', 'RR'];
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const rolled = new WeakMap(); // lap -> { key, ang: { LF: Float64Array | null, ... } }

  /** How far each wheel has turned by every grid index, from its own speed (null: no usable channel). */
  function rolledOf(L, radii) {
    const key = radii.f + '/' + radii.r;
    let c = rolled.get(L);
    if (c && c.key === key) return c;
    c = { key, ang: {} };
    const n = L.t ? L.t.length : 0, v = L.speed;
    WHEELS.forEach((w) => {
      const ws = L['ws' + w];
      c.ang[w] = null;
      if (!ws || !v || n < 2) return;
      // a wheel speed is close to the car's on most of a lap: anything else is another unit
      const m = median(n, (i) => (v[i] > 10 ? ws[i] / v[i] : NaN));
      if (!(m > 0.8 && m < 1.25)) return;
      const r = w[1] === 'F' ? radii.f : radii.r, a = new Float64Array(n);
      const at = (i) => (isFinite(ws[i]) ? ws[i] : v[i]);
      for (let i = 1; i < n; i++) a[i] = a[i - 1] + ((0.5 * (at(i) + at(i - 1))) / r) * Math.max(0, L.t[i] - L.t[i - 1]);
      c.ang[w] = a;
    });
    rolled.set(L, c);
    return c;
  }

  function wheels(L, j, step, radii) {
    const R = rolledOf(L, radii), out = {};
    const v = L.speed ? lerpAt(L.speed, j) : 0;
    const brake = L.brake ? lerpAt(L.brake, j) : 0, thr = L.throttle ? lerpAt(L.throttle, j) : 0;
    WHEELS.forEach((w) => {
      const r = w[1] === 'F' ? radii.f : radii.r, ang = R.ang[w];
      const ws = ang ? lerpAt(L['ws' + w], j) : NaN, live = isFinite(ws);
      const slip = live && v > 8 ? ws / v - 1 : NaN;
      let temp = null;
      const band = (k) => (L[k] ? lerpAt(L[k], j) : NaN);
      const ti = band('t' + w + '_i'), tm = band('t' + w + '_m'), to = band('t' + w + '_o'), t1 = band('t' + w);
      if (isFinite(ti) && isFinite(tm) && isFinite(to)) temp = [ti, tm, to];
      else if (isFinite(t1)) temp = [t1, t1, t1];
      out[w] = {
        rot: ang ? lerpAt(ang, j) : (j * step) / r, omega: (live ? ws : v) / r, slip,
        // the same thresholds as the lockup and wheelspin events (derive.js), eased in
        lock: slip < 0 && brake > 0.05 ? clamp01((-slip - 0.05) / 0.1) : 0,
        spin: slip > 0 && thr > 0.1 ? clamp01((slip - 0.03) / 0.07) : 0,
        temp,
      };
    });
    return out;
  }

  // ------------------------------------------------------------------ crashes
  /**
   * The body's real attitude where the file says the car crashed or spun: null on normal
   * driving, else { w (0..1 blend), yaw (rad, + nose left of travel), head (nose on the map,
   * anticlockwise from +x, NaN unknown), roll (+ right down), pitch (+ nose down) }.
   */
  function crash(L, j) {
    if (!L.crash || !L.bodyYaw) return null;
    const w = lerpAt(L.crash, j);
    if (!(w > 0.001)) return null;
    return { w: Math.min(1, w), yaw: lerpAt(L.bodyYaw, j), head: L.bodyHead ? lerpAt(L.bodyHead, j) : NaN, roll: L.bodyRoll ? lerpAt(L.bodyRoll, j) : 0, pitch: L.bodyPitch ? lerpAt(L.bodyPitch, j) : 0 };
  }

  const vadd = (a, b, k) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
  const vmix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const unit = (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

  /**
   * Turn the drawn car to its crash attitude c (from crash) and lift it so no corner of its
   * box ({ front, rear, width, height }) goes below the road. fwd, left: the level direction of
   * travel and its left in GL space (y up); road, body: the normal frames, which the wheels and
   * the body leave by c.w. Returns { road, body } on the one rigid frame, and ground (road) for the shadow.
   */
  function tumble(fwd, left, road, body, c, box) {
    const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw), cp = Math.cos(c.pitch), sp = Math.sin(c.pitch), cr = Math.cos(c.roll), sr = Math.sin(c.roll);
    const comb = (a, ka, b, kb) => [a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb];
    // the nose's own map heading when known (GL is x east, z south), else its angle to the travel direction
    const U = [0, 1, 0], abs = isFinite(c.head), F = abs ? [Math.cos(c.head), 0, -Math.sin(c.head)] : comb(fwd, cy, left, sy);
    const Lh = abs ? [F[2], 0, -F[0]] : comb(left, cy, fwd, -sy);
    const f1 = comb(F, cp, U, -sp), uT = comb(comb(U, cp, F, sp), cr, Lh, -sr);
    // blend from the normal body frame, then square it up again
    const f = unit(vmix(body.f, f1, c.w)), u0 = vmix(body.u, uT, c.w), u = unit(vadd(u0, f, -dot(u0, f))), l = cross(u, f);
    let low = 0;
    [box.front, box.rear].forEach((a) => [0, box.height].forEach((h) => [-1, 1].forEach((s) => {
      low = Math.min(low, dot(road.u, vadd(comb(f, a, u, h), l, (s * box.width) / 2)));
    })));
    const p = vadd(vmix(road.p, body.p, 1 - c.w), road.u, -low);
    const X = { p, f, u, l };
    return { road: X, body: X, ground: road };
  }

  const heat = (t) => (!isFinite(t) ? 0 : t < 70 ? -clamp01((70 - t) / 25) : clamp01((t - 85) / 30));

  IST.Review.Stance = { at, wheels, heat, crash, tumble, SPEC, WHEELS };
})();
