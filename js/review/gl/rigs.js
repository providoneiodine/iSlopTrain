/*
 * Follow-camera rigs: where the camera wants to be for the car at the cursor.
 *
 *   IST.Review.Rigs.MODES                  [[mode, label, title]] for the toolbar (orbit first)
 *   IST.Review.Rigs.LIMITS[mode]           [lo, hi] for user.pitch (a drag past either end does nothing)
 *   IST.Review.Rigs.pose(scene, k, f)      lap k at fractional grid index f: { p, fwd, left } in GL space
 *   IST.Review.Rigs.rig(mode, ctx)         -> { eye, target, up, anchor, fixed, fov, key, rate } for Camera.follow
 *     ctx: { pose, f, cmp, scene, user: { zoom, yaw, pitch } }
 *     anchor: the car. The camera eases its offset from the car, not its place in the
 *     world, so the car holds still on screen at any speed. fixed: the eye stays put (Apex).
 *
 * Rigs:
 *   chase      low and behind the car, looking past it down the road; a drag orbits the car
 *   top        straight down over the car, travel direction up the screen:
 *              the clearest view of where each line sits across the track
 *   side       level with the car from its right, so the input fences read
 *              like a trace
 *   trackside  ("Apex") a fixed camera beyond the outside edge of the corner, panning and
 *              zooming with the car like a TV camera. A lone corner gets it low at the apex;
 *              a sequence (chicane, esses) gets it higher, past the last apex, looking back
 *              down the whole sequence.
 * The Apex camera cuts (rig.key changes) when the car moves on to the next corner or
 * sequence. Without detected corners it falls back to chase.
 */
(function () {
  'use strict';
  const UP = [0, 1, 0];
  const add = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
  /** a * ca + b * cb */
  const mix2 = (a, ca, b, cb) => [a[0] * ca + b[0] * cb, a[1] * ca + b[1] * cb, a[2] * ca + b[2] * cb];

  const MODES = [
    ['orbit', 'Orbit', 'Free camera (drag, right-drag, wheel)'],
    ['chase', 'Chase', 'Behind the car'],
    ['top', 'Top', 'Straight down, travel direction up: track position'],
    ['side', 'Side', 'Level with the car: inputs side-on'],
    ['trackside', 'Apex', 'Trackside camera at each corner or corner sequence'],
  ];
  const LIMITS = { chase: [-0.2, 1.15], top: [0, 0], side: [-0.25, 1.2], trackside: [-0.15, 1.5] };

  const pose = (scene, k, f) => poseOn(scene.base[k], f);
  /** The same along any GL polyline (the track centre, for the trackside cameras). */
  function poseOn(P, f) {
    const n = P.length / 3;
    f = Math.max(0, Math.min(n - 1, f));
    const i = Math.min(n - 2, Math.floor(f)), r = f - i;
    const p = [0, 1, 2].map((d) => P[i * 3 + d] + (P[(i + 1) * 3 + d] - P[i * 3 + d]) * r);
    // heading over ±5 m at the sample each side, blended, so it turns without a step every metre
    let fx = 0, fz = 0;
    for (let e = 0; e < 2; e++) {
      const a = Math.max(0, i + e - 5), b = Math.min(n - 1, i + e + 5), w = e ? r : 1 - r;
      const dx = P[b * 3] - P[a * 3], dz = P[b * 3 + 2] - P[a * 3 + 2], l = Math.hypot(dx, dz) || 1;
      fx += (dx / l) * w;
      fz += (dz / l) * w;
    }
    const l = Math.hypot(fx, fz) || 1;
    fx /= l;
    fz /= l;
    // left of travel, matching Scene's lateral (GL y up)
    return { p, fwd: [fx, 0, fz], left: [fz, 0, -fx] };
  }

  function nearestCorner(cmp, f) {
    let best = -1, bd = Infinity;
    cmp.corners.forEach((c, k) => {
      const d = Math.abs(c.apex - f);
      if (d < bd) (bd = d), (best = k);
    });
    return best;
  }

  function chase(ctx) {
    const { pose: q, user } = ctx;
    const y = user.yaw, d = 26 * user.zoom, pitch = 0.27 + user.pitch;
    // the way the camera faces along the ground: the car's heading, turned by the drag
    const f = mix2(q.fwd, Math.cos(y), q.left, Math.sin(y));
    // (roof height, less when zoomed right in so the car doesn't drop out of the bottom)
    const lift = Math.min(1.5, 0.3 + d * 0.05);
    const eye = add(add(q.p, f, -d * Math.cos(pitch)), UP, d * Math.sin(pitch) + lift);
    // look past the car along that same line (less so from above), so it stays in one
    // place on screen from any side
    const target = add(add(q.p, f, Math.min(10, d * 0.4) * Math.cos(pitch)), UP, lift);
    return { eye, target, up: UP, anchor: q.p, key: 'chase', rate: { eye: 7, target: 10 } };
  }

  function top(ctx) {
    const { pose: q, user } = ctx;
    const h = 42 * user.zoom, y = user.yaw;
    const upv = mix2(q.fwd, Math.cos(y), q.left, Math.sin(y));
    // the car sits below centre so more of what's up the screen shows; one rate for all
    // three, so the car doesn't wander while the view turns
    const c = add(q.p, upv, h * 0.1);
    return { eye: add(c, UP, h), target: c, up: upv, anchor: q.p, key: 'top', rate: { eye: 5, target: 5, up: 5 } };
  }

  function side(ctx) {
    const { pose: q, user, scene } = ctx;
    const d = 32 * user.zoom, y = user.yaw;
    // the car's right, turned by the user's drag
    const s = mix2(q.left, -Math.cos(y), q.fwd, Math.sin(y));
    const lift = d * (0.18 + user.pitch * 0.6);
    const target = add(q.p, UP, scene.fenceH * 0.45);
    return { eye: add(add(q.p, s, d), UP, lift), target, up: UP, anchor: q.p, key: 'side', rate: { eye: 7, target: 10 } };
  }

  function trackside(ctx) {
    const { cmp, scene, f, pose: q, user } = ctx;
    const k = nearestCorner(cmp, f);
    if (k < 0) return chase(ctx);
    const cx = cmp.complexes[cmp.corners[k].complex];
    const first = cmp.corners[cx.corners[0]], last = cmp.corners[cx.corners[cx.corners.length - 1]];
    // 0 for a lone corner, rising to 1 for a sequence 150 m or more from first apex to last
    const seq = Math.max(0, Math.min(1, ((last.apex - first.apex) * cmp.step) / 150));
    const a = poseOn(scene.centre, last.apex), y = user.yaw;
    // beyond the outside edge; a drag swings the camera round the apex and raises it
    const out = mix2(a.left, -last.dir * Math.cos(y), a.fwd, Math.sin(y));
    const w = cmp.centre.w[last.apex];
    const eye = add(add(add(a.p, out, w + 14 + 4 * seq), a.fwd, -6 + 36 * seq), UP, 5 + 15 * seq + user.pitch * 25);
    const target = add(q.p, UP, 1.2);
    // a zoom lens: about 8 m above and below the car close up, a little more with distance
    const dist = Math.hypot(eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]);
    const fov = Math.max(0.05, Math.min(0.9, 2 * Math.atan(((8 + dist * 0.03) * user.zoom) / dist)));
    return { eye, target, up: UP, anchor: q.p, fixed: true, fov, key: 'apex' + cmp.corners[k].complex, rate: { eye: 12, target: 12, fov: 3 } };
  }

  const RIGS = { chase, top, side, trackside };
  function rig(mode, ctx) {
    return (RIGS[mode] || chase)(ctx);
  }

  IST.Review.Rigs = { MODES, LIMITS, pose, rig, nearestCorner };
})();
