/*
 * How a car's body sits on the road at a point on a lap. Pure, no DOM.
 *
 *   IST.Review.Stance.at(L, j, kind) -> { dive, roll, heave, measured }
 *     L: a comparison lap (compare.js), j: fractional grid index, kind: Cars kind
 *     dive   rad, + nose down          roll   rad, + leaning right (left side up)
 *     heave  m, + body up              measured: from ride heights, not estimated
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
  /** Mean over about ±2 samples round j, so a kerb strike doesn't snap the body. */
  function near(a, j) {
    const n = a.length, i0 = Math.max(0, Math.floor(j) - 2), i1 = Math.min(n - 1, Math.floor(j) + 3);
    let s = 0, c = 0;
    for (let i = i0; i <= i1; i++) if (isFinite(a[i])) (s += a[i]), c++;
    return c ? s / c : 0;
  }

  function at(L, j, kind) {
    const S = SPEC[kind] || SPEC.road, b = baseOf(L);
    let dive = 0, roll = 0, heave = 0;
    if (b.ok) {
      const f = near(L.rhF, j), r = near(L.rhR, j);
      dive = Math.atan((r - f - b.rake) / S.wb);
      heave = (f + r) / 2 - b.ride;
    } else if (L.longG) dive = (-near(L.longG, j) / G0) * S.dive;
    if (b.sides) roll = Math.atan((near(L.rhLt, j) - near(L.rhRt, j) - b.side) / S.tr);
    else if (L.latG) roll = (near(L.latG, j) / G0) * S.roll;
    return { dive, roll, heave, measured: b.ok };
  }

  IST.Review.Stance = { at, SPEC };
})();
