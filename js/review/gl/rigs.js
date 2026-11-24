/*
 * Follow-camera rigs: where the camera wants to be for the car at the cursor.
 *
 *   IST.Review.Rigs.MODES                  [[mode, label, title]] for the toolbar (orbit first)
 *   IST.Review.Rigs.pose(scene, k, f)      lap k at fractional grid index f: { p, fwd, left } in GL space
 *   IST.Review.Rigs.rig(mode, ctx)         -> { eye, target, up, key, rate } for Camera.follow
 *     ctx: { pose, f, cmp, scene, user: { zoom, yaw, pitch } }
 *
 * Rigs:
 *   chase      low and behind the car, looking down the road
 *   top        straight down over the car, travel direction up the screen:
 *              the clearest view of where each line sits across the track
 *   side       level with the car from its right, so the input fences read
 *              like a trace
 *   trackside  a fixed camera on the outside of the nearest apex, panning to
 *              follow the car through the corner, like a TV camera
 *   complex    a high camera beyond the last apex of the corner complex the
 *              car is in, looking back down the whole sequence
 * The trackside and complex cameras cut (rig.key changes) when the car moves
 * on to the next corner. Without detected corners they fall back to chase.
 */
(function () {
  'use strict';
  const UP = [0, 1, 0];
  const add = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

  const MODES = [
    ['orbit', 'Orbit', 'Free camera (drag, right-drag, wheel)'],
    ['chase', 'Chase', 'Behind the car'],
    ['top', 'Top', 'Straight down, travel direction up: track position'],
    ['side', 'Side', 'Level with the car: inputs side-on'],
    ['trackside', 'Apex', 'Trackside camera at the nearest apex'],
    ['complex', 'Complex', 'High camera past the last apex of the corner sequence'],
  ];

  function pose(scene, k, f) {
    const P = scene.base[k], n = P.length / 3;
    f = Math.max(0, Math.min(n - 1, f));
    const i = Math.min(n - 2, Math.floor(f)), r = f - i;
    const p = [0, 1, 2].map((d) => P[i * 3 + d] + (P[(i + 1) * 3 + d] - P[i * 3 + d]) * r);
    // heading over ±5 m, blended between neighbouring samples so it turns smoothly
    const a = Math.max(0, i - 5), b = Math.min(n - 1, i + 6);
    let fx = P[b * 3] - P[a * 3], fz = P[b * 3 + 2] - P[a * 3 + 2];
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
    const y = user.yaw, d = 26 * user.zoom, pitch = Math.max(0.05, 0.27 + user.pitch);
    const f = add(add([0, 0, 0], q.fwd, Math.cos(y)), q.left, Math.sin(y));
    const eye = add(add(q.p, f, -d * Math.cos(pitch)), UP, d * Math.sin(pitch) + 1.5);
    return { eye, target: add(add(q.p, q.fwd, 10), UP, 1.5), up: UP, key: 'chase', rate: { eye: 7, target: 14 } };
  }

  function top(ctx) {
    const { pose: q, user } = ctx;
    const h = 42 * user.zoom;
    const y = user.yaw;
    const upv = add(add([0, 0, 0], q.fwd, Math.cos(y)), q.left, Math.sin(y));
    // the car sits below centre so more of the road ahead shows
    const c = add(q.p, q.fwd, h * 0.1);
    return { eye: add(c, UP, h), target: c, up: upv, key: 'top', rate: { eye: 9, target: 9, up: 4 } };
  }

  function side(ctx) {
    const { pose: q, user, scene } = ctx;
    const d = 32 * user.zoom, y = user.yaw;
    // the car's right, turned by the user's drag
    const s = add(add([0, 0, 0], q.left, -Math.cos(y)), q.fwd, Math.sin(y));
    const lift = d * (0.18 + user.pitch * 0.6);
    const target = add(q.p, UP, scene.fenceH * 0.45);
    return { eye: add(add(q.p, s, d), UP, lift), target, up: UP, key: 'side', rate: { eye: 7, target: 14 } };
  }

  function trackside(ctx) {
    const { cmp, scene, f, pose: q, user } = ctx;
    const k = nearestCorner(cmp, f);
    if (k < 0) return chase(ctx);
    const c = cmp.corners[k], a = pose(scene, 0, c.apex);
    const out = add([0, 0, 0], a.left, -c.dir); // outside of the corner
    const w = cmp.centre.w[c.apex];
    const eye = add(add(add(a.p, out, w + 14 * user.zoom), a.fwd, -6), UP, 5 + 4 * user.zoom + user.pitch * 20);
    return { eye, target: add(q.p, UP, 1.2), up: UP, key: 'apex' + k, rate: { eye: 20, target: 10 } };
  }

  function complex(ctx) {
    const { cmp, scene, f, pose: q, user } = ctx;
    const k = nearestCorner(cmp, f);
    if (k < 0) return chase(ctx);
    const cx = cmp.complexes[cmp.corners[k].complex];
    const last = cmp.corners[cx.corners[cx.corners.length - 1]];
    const a = pose(scene, 0, last.apex);
    const out = add([0, 0, 0], a.left, -last.dir);
    const w = cmp.centre.w[last.apex];
    const eye = add(add(add(a.p, a.fwd, 30 * user.zoom), out, w + 18 * user.zoom), UP, 20 * user.zoom + user.pitch * 40);
    return { eye, target: add(q.p, UP, 1), up: UP, key: 'complex' + cmp.corners[k].complex, rate: { eye: 20, target: 8 } };
  }

  const RIGS = { chase, top, side, trackside, complex };
  function rig(mode, ctx) {
    return (RIGS[mode] || chase)(ctx);
  }

  IST.Review.Rigs = { MODES, pose, rig, nearestCorner };
})();
