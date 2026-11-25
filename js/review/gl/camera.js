/*
 * Camera for the Review viewer.
 *
 *   const cam = IST.Review.Camera.create()
 *   cam.mode                        'orbit' or a follow mode (see rigs.js)
 *   cam.frame(size, W, H)           orbit: fit the whole track
 *   cam.flyTo(target, dist, ms)     orbit: ease there; cam.fitDist(extent, W, H) sizes it
 *   cam.follow(rig, dt)             follow modes: ease toward a rig (rigs.js); cam.moving says it hasn't settled
 *   cam.pivot                       [x, y] in the element: where the followed car is drawn (the page sets it)
 *   cam.matrices(W, H)              -> { vp, eye, fog, dist (eye to what it looks at, m) }
 *   cam.attach(el, onChange)        returns detach()
 *
 * Orbit: drag to orbit, right / shift-drag to pan, wheel to zoom.
 * Follow modes: drag turns the rig (cam.user.yaw / pitch), wheel scales its
 * distance (cam.user.zoom); rigs.js reads those. Looking straight down, a
 * drag turns the view round the car like a dial instead.
 *
 * Following eases the camera's offset from the car (rig.anchor), not its
 * place in the world: the car is where the frame puts it and the camera goes
 * with it, so an uneven frame can't shake the car on screen however fast it
 * goes. A rig with cut: true (a trackside camera switching corners) jumps.
 */
(function () {
  'use strict';
  const M = IST.Review.M3;
  const ease = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

  function create() {
    const cam = {
      mode: 'orbit',
      target: [0, 0, 0], yaw: 0.6, pitch: 0.85, dist: 1000, size: 1000,
      fov: 0.75,
      user: { zoom: 1, yaw: 0, pitch: 0 },
      view: null, // { eye, target, up, fov } in follow modes, from the eased offsets in cam.rel
      rel: null,
      moving: false,
      pivot: null,
      touched: 0, // s left of answering a drag or the wheel at once
      anim: null,
      frame(size, W, H) {
        cam.size = size;
        cam.target = [0, 0, 0];
        cam.yaw = 0.35;
        cam.pitch = 0.95;
        cam.anim = null;
        cam.dist = cam.fitDist(size, W, H);
      },
      flyTo(target, dist, ms) {
        cam.anim = { t0: performance.now(), dur: ms || 450, from: { target: cam.target.slice(), dist: cam.dist }, to: { target: target.slice(), dist } };
      },
      animating: () => !!cam.anim,
      fitDist(extent, W, H) {
        const aspect = W && H ? W / H : 16 / 9;
        return ((extent * 0.6) / Math.tan(cam.fov / 2)) / Math.min(1, aspect) * 1.05;
      },
      setMode(mode) {
        if (mode === cam.mode) return;
        cam.mode = mode;
        cam.user = { zoom: 1, yaw: 0, pitch: 0 };
        cam.view = cam.rel = null;
      },
      follow(rig, dt) {
        if (!rig) return;
        const A = rig.anchor || [0, 0, 0], fixed = !!rig.fixed;
        const want = { eye: fixed ? rig.eye : M.v.sub(rig.eye, A), target: M.v.sub(rig.target, A), up: rig.up || [0, 1, 0], fov: rig.fov || cam.fov };
        let s = cam.rel;
        if (!s || rig.cut || s.fixed !== fixed) {
          s = cam.rel = { eye: want.eye.slice(), target: want.target.slice(), up: want.up.slice(), fov: want.fov, fixed };
          cam.moving = true;
        } else {
          // a drag or the wheel is answered at once; the car turning is eased
          const r = rig.rate || {}, fast = cam.touched > 0 ? 30 : 0;
          cam.touched = Math.max(0, cam.touched - dt);
          const k = (rate) => 1 - Math.exp(-Math.max(rate, fast) * dt);
          const far = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
          cam.moving = far(s.eye, want.eye) + far(s.target, want.target) > 2e-3 || far(s.up, want.up) > 1e-3 || Math.abs(s.fov - want.fov) > 1e-4 || cam.touched > 0;
          s.eye = ease(s.eye, want.eye, k(r.eye || 7));
          s.target = ease(s.target, want.target, k(r.target || 10));
          s.up = M.v.norm(ease(s.up, want.up, k(r.up || 5)));
          s.fov += (want.fov - s.fov) * k(r.fov || 6);
        }
        cam.view = { eye: fixed ? s.eye : M.v.add(A, s.eye), target: M.v.add(A, s.target), up: s.up, fov: s.fov };
      },
      matrices(W, H) {
        const aspect = W / Math.max(1, H);
        if (cam.mode !== 'orbit' && cam.view) {
          const v = cam.view, d = M.v.len(M.v.sub(v.eye, v.target));
          const vp = M.mul(M.perspective(v.fov, aspect, 0.3, Math.max(2000, cam.size * 4)), M.lookAt(v.eye, v.target, v.up));
          return { vp, eye: v.eye, dist: d, fog: { near: Math.max(200, d * 4), far: Math.max(200, d * 4) + cam.size * 2 } };
        }
        if (cam.anim) {
          const a = cam.anim, f = Math.min(1, (performance.now() - a.t0) / a.dur), e = 1 - Math.pow(1 - f, 3);
          cam.target = M.v.lerp(a.from.target, a.to.target, e);
          // distance eases in log space so a big zoom doesn't rush the last bit
          cam.dist = Math.exp(Math.log(a.from.dist) + (Math.log(a.to.dist) - Math.log(a.from.dist)) * e);
          if (f >= 1) cam.anim = null;
        }
        const cp = Math.cos(cam.pitch), t = cam.target;
        const eye = [t[0] + cam.dist * cp * Math.sin(cam.yaw), t[1] + cam.dist * Math.sin(cam.pitch), t[2] + cam.dist * cp * Math.cos(cam.yaw)];
        const near = Math.max(0.3, cam.dist * 0.01), far = Math.max(cam.dist * 4, cam.size * 4);
        const vp = M.mul(M.perspective(cam.fov, aspect, near, far), M.lookAt(eye, t, [0, 1, 0]));
        return { vp, eye, dist: cam.dist, fog: { near: cam.dist * 1.2, far: cam.dist * 1.2 + cam.size * 2.5 } };
      },
      attach(el, onChange) {
        let drag = null;
        const down = (e) => {
          if (e.button > 2) return;
          drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.button === 1 || e.shiftKey, moved: 0 };
          cam.anim = null;
          el.setPointerCapture && el.setPointerCapture(e.pointerId);
        };
        const move = (e) => {
          if (!drag) return;
          const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
          drag.x = e.clientX;
          drag.y = e.clientY;
          drag.moved += Math.abs(dx) + Math.abs(dy);
          if (cam.mode !== 'orbit') {
            const lim = IST.Review.Rigs.LIMITS[cam.mode] || [-0.2, 1.2];
            if (lim[0] === lim[1]) {
              // straight down: turn the view by the angle the pointer sweeps round the car, so the
              // ground goes with the pointer; near the car that angle is damped, so a drag across it is calm
              const b = el.getBoundingClientRect(), pv = cam.pivot || [b.width / 2, b.height / 2];
              const rx = e.clientX - dx - b.left - pv[0], ry = e.clientY - dy - b.top - pv[1];
              cam.user.yaw += (rx * dy - ry * dx) / Math.max(rx * rx + ry * ry, 70 * 70);
            } else {
              cam.user.yaw -= dx * 0.006;
              cam.user.pitch = Math.max(lim[0], Math.min(lim[1], cam.user.pitch + dy * 0.004));
            }
            cam.touched = 0.25;
          } else if (drag.pan) {
            // grab-the-ground: right = (cos yaw, 0, -sin yaw), forward = (-sin yaw, 0, -cos yaw)
            const k = cam.dist * 0.0016, c = Math.cos(cam.yaw), s = Math.sin(cam.yaw);
            cam.target[0] += (-c * dx - s * dy) * k;
            cam.target[2] += (s * dx - c * dy) * k;
          } else {
            cam.yaw -= dx * 0.006;
            cam.pitch = Math.max(0.08, Math.min(1.5, cam.pitch + dy * 0.005));
          }
          onChange();
        };
        const up = () => (drag = null);
        const wheel = (e) => {
          e.preventDefault();
          cam.anim = null;
          const f = Math.exp(e.deltaY * 0.0012);
          if (cam.mode !== 'orbit') (cam.user.zoom = Math.max(0.2, Math.min(8, cam.user.zoom * f))), (cam.touched = 0.25);
          else cam.dist = Math.max(15, Math.min(cam.size * 3, cam.dist * f));
          onChange();
        };
        const ctx = (e) => e.preventDefault();
        el.addEventListener('pointerdown', down);
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
        el.addEventListener('wheel', wheel, { passive: false });
        el.addEventListener('contextmenu', ctx);
        cam.dragging = () => !!drag && drag.moved > 3;
        return () => {
          el.removeEventListener('pointerdown', down);
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
          el.removeEventListener('wheel', wheel);
          el.removeEventListener('contextmenu', ctx);
        };
      },
      dragging: () => false,
    };
    return cam;
  }

  IST.Review.Camera = { create };
})();
