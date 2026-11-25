/*
 * The Review viewer's cars: one low-poly model per car type, built once in
 * car space and placed every frame.
 *
 *   IST.Review.Cars.KINDS                  ['gt', 'lmp', 'gtp', 'formula', 'road']
 *   IST.Review.Cars.kindOf(name)           car type from a car's name (road when unknown)
 *   IST.Review.Cars.model(kind)            the cached model: { tris, len, width, wheelbase, track }
 *   IST.Review.Cars.emit(V, model, road, body, rgb, st)   append lit triangles to a Verts list
 *     road, body: { p, f, u, l } origin and forward / up / left unit axes in GL space.
 *     The wheels sit on `road`; everything sprung sits on `body` (road plus stance).
 *     st: { steer (front wheel angle, rad, + left), brake (bool),
 *           wheels ({ LF, RF, LR, RR } from Stance.wheels: each turns by its rot), tint (bool) }
 *     With tint, each tyre shows its temperature across the tread (inner, middle, outer:
 *     blue cold, glowing red hot) and its rim turns rose while locking, mint while spinning.
 *     Spokes blur as the wheel speeds up, so a locked wheel stands out by its sharp ones.
 *   IST.Review.Cars.shadow(V, model, road) append a soft dark patch under the car
 *
 * Car space is [a, h, s]: metres forward of the car's centre, up from the
 * road, and to the left. The shapes are generic for their class and carry
 * no real car's badge, livery or exact lines.
 */
(function () {
  'use strict';
  const v = IST.Review.M3.v;
  const KINDS = ['gt', 'lmp', 'gtp', 'formula', 'road'];
  const SUN = [0.35, 0.85, 0.4]; // the renderer's light: a normal along it draws at full brightness
  const FIXED = {
    dark: [0.07, 0.075, 0.09], glass: [0.1, 0.13, 0.17], tyre: [0.05, 0.05, 0.055], rim: [0.5, 0.52, 0.56],
    lamp: [1, 0.97, 0.85], tail: [0.42, 0.04, 0.04], tailOn: [1, 0.14, 0.09],
  };
  const COLD = [0.1, 0.34, 0.62], HOT = [1, 0.13, 0.04], WHITE_HOT = [1, 0.5, 0.12];
  const GL = IST.Review.GL, Th = IST.Theme;
  const LOCK = GL.rgb(Th.rose), SPIN = GL.rgb(Th.mint);
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

  /** Car type from its name as telemetry gives it (iRacing's CarScreenName, a CSV's Vehicle row). */
  function kindOf(name) {
    const s = String(name || '').toLowerCase();
    if (/gtp|lmdh|lmh|hypercar|\b963\b|v-series|arx-0?6|m hybrid|499p|sf-?24|valkyrie|\b9x8\b/.test(s)) return 'gtp';
    if (/lmp|p217|js ?p\d|oreca|radical|prototype|riley|\bdp\b/.test(s)) return 'lmp';
    if (/formula|\bf[1-4]\b|indy|dallara (ir|dw|f3|il)|\bir-?\d\d\b|\bw1\d\b|mp4-|skip barber|\bsf\d\d|usf|\bff ?1600|\bvee\b|lotus (49|79)|fr ?[23]\.[05]|\bfw\d\d/.test(s)) return 'formula';
    if (/gt[1-4]\b|gt[de]\b|gt500|gt2 rs|911.*cup|cup.*(911|992|991)|challenge|supercar|\bgt\b.*(pro|am)/.test(s)) return 'gt';
    return 'road';
  }

  // ---------------------------------------------------------------- builder
  function Builder() {
    const tris = [], parts = [{}];
    let part = 0;
    const B = {
      tris, parts,
      /** ref: a point inside the shape, so the normal comes out pointing away from it. */
      tri(a, b, c, key, ref) {
        let n = v.cross(v.sub(b, a), v.sub(c, a));
        if (v.len(n) < 1e-9) return;
        n = v.norm(n);
        const mid = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
        if (ref && n[0] * (mid[0] - ref[0]) + n[1] * (mid[1] - ref[1]) + n[2] * (mid[2] - ref[2]) < 0) n = v.scale(n, -1);
        tris.push({ p: [a, b, c], n, key, part });
      },
      quad(a, b, c, d, key, ref) {
        B.tri(a, b, c, key, ref);
        B.tri(a, c, d, key, ref);
      },
      /** Skin between rings of points; keyOf(seg, face); open: no face from the last point back to the first. */
      loft(rings, keyOf, open, caps) {
        const m = rings[0].length, cen = (r) => r.reduce((s, p) => v.add(s, p), [0, 0, 0]).map((x) => x / m);
        for (let i = 0; i + 1 < rings.length; i++) {
          const r0 = rings[i], r1 = rings[i + 1], ref = v.lerp(cen(r0), cen(r1), 0.5);
          for (let j = 0; j < (open ? m - 1 : m); j++) {
            const j1 = (j + 1) % m;
            B.quad(r0[j], r0[j1], r1[j1], r1[j], keyOf(i, j), ref);
          }
        }
        if (caps) {
          [0, rings.length - 1].forEach((i, e) => {
            const r = rings[i], c = cen(r), ref = v.lerp(c, cen(rings[e ? i - 1 : 1]), 0.5);
            for (let j = 0; j < m; j++) B.tri(c, r[j], r[(j + 1) % m], caps, ref);
          });
        }
      },
      box(a0, a1, h0, h1, s0, s1, key) {
        const P = [[a0, h0, s0], [a1, h0, s0], [a1, h0, s1], [a0, h0, s1], [a0, h1, s0], [a1, h1, s0], [a1, h1, s1], [a0, h1, s1]];
        const ref = [(a0 + a1) / 2, (h0 + h1) / 2, (s0 + s1) / 2];
        [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7], [1, 2, 6, 5], [0, 3, 7, 4]].forEach((f) => B.quad(P[f[0]], P[f[1]], P[f[2]], P[f[3]], key, ref));
      },
      /** The same box on both sides of the car. */
      pair(a0, a1, h0, h1, s0, s1, key) {
        B.box(a0, a1, h0, h1, s0, s1, key);
        B.box(a0, a1, h0, h1, -s1, -s0, key);
      },
      /** A wheel as its own part (unsprung, the fronts steered): axle at a, outer face at s = side * so. */
      wheel(a, side, so, r, w, steer) {
        parts.push({ wheel: true, id: (side > 0 ? 'L' : 'R') + (steer ? 'F' : 'R'), steer, pa: a, ph: r, ps: side * (so - w / 2) });
        part = parts.length - 1;
        const N = 14, s1 = side * so, s0 = side * (so - w), ref = [a, r, side * (so - w / 2)];
        const at = (k, rad, s) => [a + Math.cos((k / N) * 2 * Math.PI) * rad, r + Math.sin((k / N) * 2 * Math.PI) * rad, s];
        const band = (b) => s0 + ((s1 - s0) * b) / 3;
        for (let k = 0; k < N; k++) {
          // the tread in three bands, inner to outer, each coloured by its own temperature
          for (let b = 0; b < 3; b++) B.quad(at(k, r, band(b)), at(k + 1, r, band(b)), at(k + 1, r, band(b + 1)), at(k, r, band(b + 1)), 'tread' + b, ref);
          B.quad(at(k, r, s1), at(k + 1, r, s1), at(k + 1, r * 0.64, s1), at(k, r * 0.64, s1), 'wall', ref);
          // spokes: every third wedge of the rim left dark
          B.tri([a, r, s1], at(k, r * 0.64, s1), at(k + 1, r * 0.64, s1), k % 3 === 2 ? 'spoke' : 'rim', ref);
          B.tri([a, r, s0], at(k, r, s0), at(k + 1, r, s0), 'tyre', ref);
        }
        part = 0;
      },
      /** A wheel arch: a shell over the top of a wheel with a lip, and a dark gap round the tyre. */
      flare(a, side, so, r, R, depth) {
        const s1 = side * (so + 0.012), s0 = side * (so - depth), ref = [a, r, side * (so - depth / 2)];
        const N = 12, A0 = -0.3, A1 = Math.PI + 0.3;
        const at = (k, rad, s) => [a + Math.cos(A0 + ((A1 - A0) * k) / N) * rad, r + Math.sin(A0 + ((A1 - A0) * k) / N) * rad, s];
        for (let k = 0; k < N; k++) {
          B.quad(at(k, R, s0), at(k + 1, R, s0), at(k + 1, R, s1), at(k, R, s1), 'body', ref);
          B.quad(at(k, R, s1), at(k + 1, R, s1), at(k + 1, r + 0.04, s1), at(k, r + 0.04, s1), 'body', ref);
          B.quad(at(k, r + 0.04, s1), at(k + 1, r + 0.04, s1), at(k + 1, r - 0.02, s1), at(k, r - 0.02, s1), 'dark', ref);
          B.tri([a, r, s0], at(k, R, s0), at(k + 1, R, s0), 'body', ref);
        }
      },
    };
    return B;
  }

  /** A body cross-section at a: floor, sill, shoulder and crown each side. kc: crown width as a share of w. */
  function section(a, w, y0, y1, y2, kc) {
    const c = kc == null ? 0.5 : kc, ym = y0 + (y1 - y0) * 0.4;
    return [[a, y0, -w * 0.88], [a, ym, -w], [a, y1, -w * 0.93], [a, y2, -w * c], [a, y2, w * c], [a, y1, w * 0.93], [a, ym, w], [a, y0, w * 0.88]];
  }
  /** A cabin ring: base half width w at y0, top half width wt at y1. */
  const cab = (a, w, wt, y0, y1) => [[a, y0, -w], [a, y1, -wt], [a, y1, wt], [a, y0, w]];

  function hull(B, rows, kc) {
    B.loft(rows.map((r) => section(r[0], r[1], r[2], r[3], r[4], r[5] == null ? kc : r[5])), () => 'body', false, 'body');
  }
  /** rows: cabin rings front to back. The first span is the windscreen, the last the rear screen (tailBody: an engine cover instead). */
  function cabin(B, rows, tailBody) {
    const last = rows.length - 2;
    B.loft(rows.map((r) => cab.apply(null, r)), (i, j) => {
      if (i === 0) return 'glass';
      if (i === last) return j === 1 ? (tailBody ? 'body' : 'glass') : 'body';
      return j === 1 ? 'body' : 'glass';
    }, true, 'body');
  }
  function wheels(B, o) {
    [1, -1].forEach((side) => {
      B.wheel(o.af, side, o.sf, o.rf, o.wf, true);
      B.wheel(o.ar, side, o.sr, o.rr, o.wr, false);
      if (o.flare) {
        B.flare(o.af, side, o.sf, o.rf, o.rf + o.flare[0], o.depth || 0.4);
        B.flare(o.ar, side, o.sr, o.rr, o.rr + o.flare[1], o.depth || 0.4);
      }
    });
  }
  /** A wing: a plane between end plates on two posts. */
  function wing(B, a0, a1, h, half, plateH, postH0, postS) {
    B.box(a0, a1, h, h + 0.035, -half, half, 'dark');
    B.box(a0 + 0.05, a0 + 0.14, h + 0.035, h + 0.075, -half, half, 'trim');
    B.pair(a0 - 0.05, a1 + 0.05, h - plateH * 0.7, h + plateH * 0.3, half, half + 0.025, 'body');
    if (postS) B.pair(a1 - 0.14, a1 - 0.04, postH0, h, postS - 0.02, postS + 0.02, 'dark');
  }

  // ------------------------------------------------------------------ models
  const MODELS = {
    /* Front-engined GT: a long flat bonnet, the cabin set well back, wide hips and a high wing. */
    gt(B) {
      hull(B, [
        [2.42, 0.62, 0.2, 0.4, 0.44], [2.3, 0.9, 0.1, 0.5, 0.55], [1.95, 0.98, 0.08, 0.64, 0.7], [1.45, 0.98, 0.08, 0.72, 0.77],
        [0.5, 0.96, 0.08, 0.76, 0.81], [-0.2, 0.95, 0.08, 0.78, 0.82], [-0.95, 0.98, 0.08, 0.83, 0.86], [-1.32, 1.0, 0.08, 0.88, 0.91],
        [-2.0, 0.99, 0.12, 0.9, 0.93], [-2.38, 0.93, 0.3, 0.86, 0.9],
      ], 0.55);
      cabin(B, [[0.3, 0.78, 0.78, 0.78, 0.8], [-0.42, 0.8, 0.6, 0.78, 1.19], [-1.05, 0.8, 0.58, 0.82, 1.17], [-1.98, 0.68, 0.44, 0.88, 0.95]]);
      wheels(B, { af: 1.45, ar: -1.3, sf: 1.02, sr: 1.04, rf: 0.35, rr: 0.36, wf: 0.31, wr: 0.33, flare: [0.085, 0.09] });
      B.box(2.2, 2.52, 0.05, 0.085, -0.98, 0.98, 'dark'); // splitter
      B.box(2.3, 2.44, 0.13, 0.34, -0.56, 0.56, 'dark'); // intake
      B.pair(2.2, 2.33, 0.42, 0.57, 0.6, 0.66, 'lamp');
      B.pair(0.85, 1.55, 0.7, 0.785, 0.14, 0.46, 'dark'); // bonnet vents
      B.pair(1.72, 1.95, 0.6, 0.715, 0.2, 0.44, 'dark');
      B.pair(-0.95, 1.0, 0.05, 0.15, 0.9, 1.0, 'dark'); // sills
      B.pair(0.05, 0.2, 0.84, 0.92, 0.84, 1.02, 'body'); // mirrors
      B.box(-2.52, -2.3, 0.08, 0.3, -0.82, 0.82, 'dark'); // diffuser
      B.box(-2.46, -2.3, 0.9, 0.96, -0.9, 0.9, 'body'); // ducktail
      B.pair(-2.4, -2.37, 0.7, 0.76, 0.3, 0.9, 'tail');
      wing(B, -2.6, -2.24, 1.2, 0.95, 0.2, 0.9, 0.4);
    },
    /* Closed prototype: a narrow canopy, wheel-arch humps either side of a low nose, a fin and a full-width wing. */
    lmp(B) {
      hull(B, [
        [2.36, 0.4, 0.1, 0.22, 0.26], [2.05, 0.86, 0.06, 0.3, 0.36], [1.5, 0.93, 0.06, 0.4, 0.48], [0.8, 0.94, 0.06, 0.46, 0.56],
        [0, 0.95, 0.06, 0.5, 0.62], [-1.0, 0.95, 0.06, 0.54, 0.66], [-1.5, 0.95, 0.06, 0.54, 0.62], [-2.2, 0.93, 0.1, 0.48, 0.54], [-2.36, 0.9, 0.22, 0.44, 0.48],
      ], 0.5);
      cabin(B, [[1.1, 0.46, 0.4, 0.5, 0.52], [0.45, 0.52, 0.36, 0.52, 0.98], [-0.25, 0.5, 0.34, 0.56, 1.0], [-1.7, 0.2, 0.08, 0.6, 0.66]], true);
      wheels(B, { af: 1.5, ar: -1.5, sf: 0.95, sr: 0.95, rf: 0.34, rr: 0.355, wf: 0.3, wr: 0.34, flare: [0.08, 0.07], depth: 0.46 });
      B.box(2.1, 2.5, 0.04, 0.07, -0.93, 0.93, 'dark');
      B.pair(1.86, 1.94, 0.5, 0.66, 0.6, 0.86, 'lamp');
      B.pair(-0.9, 0.9, 0.04, 0.2, 0.86, 0.96, 'dark');
      B.pair(0.5, 0.62, 0.6, 0.67, 0.56, 0.72, 'body');
      B.box(-2.2, -0.5, 0.6, 1.02, -0.018, 0.018, 'body'); // fin
      B.box(-2.5, -2.25, 0.06, 0.34, -0.85, 0.85, 'dark');
      B.pair(-2.385, -2.36, 0.36, 0.46, 0.5, 0.86, 'tail');
      wing(B, -2.55, -2.2, 0.98, 0.93, 0.32, 0.5, 0);
    },
    /* Hypercar-style prototype: a fuller, squarer body than the LMP, a wider canopy and a light bar across the tail. */
    gtp(B) {
      hull(B, [
        [2.5, 0.7, 0.12, 0.34, 0.38], [2.3, 0.94, 0.06, 0.44, 0.5], [1.55, 0.99, 0.06, 0.52, 0.6], [0.8, 0.99, 0.06, 0.54, 0.64],
        [0, 0.99, 0.06, 0.56, 0.68], [-1.0, 1.0, 0.06, 0.6, 0.72], [-1.55, 1.0, 0.06, 0.62, 0.7], [-2.3, 0.99, 0.1, 0.6, 0.64], [-2.5, 0.96, 0.24, 0.56, 0.6],
      ], 0.6);
      cabin(B, [[1.2, 0.62, 0.56, 0.58, 0.6], [0.5, 0.66, 0.46, 0.6, 1.03], [-0.3, 0.64, 0.44, 0.64, 1.04], [-1.9, 0.3, 0.14, 0.68, 0.74]], true);
      wheels(B, { af: 1.55, ar: -1.55, sf: 1.0, sr: 1.0, rf: 0.355, rr: 0.355, wf: 0.31, wr: 0.34, flare: [0.1, 0.09], depth: 0.5 });
      B.box(2.3, 2.64, 0.04, 0.07, -0.97, 0.97, 'dark');
      B.box(2.42, 2.52, 0.12, 0.3, -0.5, 0.5, 'dark');
      B.pair(2.3, 2.42, 0.34, 0.5, 0.72, 0.76, 'lamp'); // upright light blades
      B.pair(2.3, 2.42, 0.34, 0.5, 0.82, 0.86, 'lamp');
      B.pair(-1.0, 1.0, 0.04, 0.2, 0.9, 1.0, 'dark');
      B.pair(0.55, 0.68, 0.7, 0.77, 0.7, 0.86, 'body');
      B.box(-2.45, -0.6, 0.66, 1.06, -0.02, 0.02, 'body');
      B.box(-2.66, -2.4, 0.06, 0.36, -0.9, 0.9, 'dark');
      B.box(-2.53, -2.5, 0.5, 0.55, -0.92, 0.92, 'tail');
      wing(B, -2.68, -2.3, 0.94, 0.99, 0.4, 0.6, 0);
    },
    /* Single-seater: a narrow tub and nose, open wheels, side pods, an airbox and a wing at each end. */
    formula(B) {
      hull(B, [
        [2.5, 0.07, 0.2, 0.26, 0.28], [1.7, 0.2, 0.14, 0.36, 0.4], [0.9, 0.3, 0.08, 0.5, 0.54], [0.2, 0.34, 0.06, 0.56, 0.6],
        [-0.6, 0.36, 0.06, 0.6, 0.68], [-1.5, 0.26, 0.08, 0.5, 0.56], [-2.2, 0.14, 0.14, 0.36, 0.4],
      ], 0.6);
      B.loft([[0.7, 0.72, 0.06, 0.32, 0.36], [0.2, 0.8, 0.06, 0.44, 0.48], [-0.8, 0.78, 0.06, 0.42, 0.46], [-1.5, 0.5, 0.08, 0.3, 0.34]]
        .map((r) => section(r[0], r[1], r[2], r[3], r[4], 0.7)), () => 'body', false, 'dark'); // side pods
      B.loft([cab(-0.25, 0.14, 0.1, 0.6, 0.62), cab(-0.5, 0.17, 0.12, 0.6, 0.98), cab(-1.6, 0.05, 0.03, 0.5, 0.58)], (i) => (i ? 'body' : 'dark'), true, 'body'); // airbox
      B.box(-0.2, 0.45, 0.5, 0.62, -0.2, 0.2, 'dark'); // cockpit opening
      wheels(B, { af: 1.6, ar: -1.6, sf: 0.95, sr: 0.95, rf: 0.33, rr: 0.345, wf: 0.3, wr: 0.38 });
      [[1.6, 0.33], [-1.6, 0.345]].forEach(([a, r]) => B.pair(a - 0.04, a + 0.04, r - 0.03, r + 0.03, 0.2, 0.62, 'dark')); // suspension arms
      B.box(2.2, 2.6, 0.08, 0.11, -0.9, 0.9, 'dark');
      B.box(2.22, 2.4, 0.11, 0.2, -0.9, 0.9, 'body');
      B.pair(2.15, 2.62, 0.06, 0.3, 0.9, 0.92, 'body');
      B.box(-2.25, -2.18, 0.34, 0.42, -0.06, 0.06, 'tail');
      wing(B, -2.5, -2.12, 0.9, 0.5, 0.42, 0.36, 0.08);
    },
    /* Road car: a taller hatchback-coupe body on a shorter wheelbase, no wing. */
    road(B) {
      hull(B, [
        [2.16, 0.74, 0.24, 0.5, 0.54], [2.02, 0.86, 0.16, 0.62, 0.68], [1.3, 0.9, 0.14, 0.78, 0.86], [0.75, 0.9, 0.14, 0.88, 0.94],
        [0, 0.9, 0.14, 0.92, 0.96], [-1.3, 0.9, 0.14, 0.94, 0.98], [-2.0, 0.88, 0.18, 0.92, 0.96], [-2.18, 0.82, 0.3, 0.84, 0.88],
      ], 0.6);
      cabin(B, [[0.9, 0.82, 0.8, 0.9, 0.92], [0.15, 0.82, 0.62, 0.92, 1.4], [-1.0, 0.82, 0.6, 0.94, 1.38], [-1.9, 0.78, 0.5, 0.94, 1.0]]);
      wheels(B, { af: 1.32, ar: -1.3, sf: 0.92, sr: 0.92, rf: 0.33, rr: 0.33, wf: 0.24, wr: 0.24, flare: [0.07, 0.07], depth: 0.34 });
      B.box(2.1, 2.19, 0.26, 0.42, -0.5, 0.5, 'dark');
      B.pair(2.02, 2.12, 0.54, 0.66, 0.5, 0.8, 'lamp');
      B.pair(0.55, 0.68, 0.94, 1.02, 0.82, 0.98, 'body');
      B.pair(-2.2, -2.17, 0.7, 0.8, 0.4, 0.8, 'tail');
      B.box(-2.22, -2.1, 0.2, 0.34, -0.8, 0.8, 'dark');
    },
  };

  const cache = {};
  function model(kind) {
    if (!MODELS[kind]) kind = 'road';
    if (cache[kind]) return cache[kind];
    const B = Builder();
    MODELS[kind](B);
    let a0 = Infinity, a1 = -Infinity, w = 0;
    B.tris.forEach((t) => t.p.forEach((p) => ((a0 = Math.min(a0, p[0])), (a1 = Math.max(a1, p[0])), (w = Math.max(w, Math.abs(p[2]))))));
    const wh = B.parts.filter((p) => p.wheel);
    const fr = wh.find((p) => p.steer), rr = wh.find((p) => !p.steer);
    const m = {
      kind, tris: B.tris, parts: B.parts, front: a1, rear: a0, len: a1 - a0, width: w * 2,
      radii: { f: fr.ph, r: rr.ph },
      wheelbase: Math.max(...wh.map((p) => p.pa)) - Math.min(...wh.map((p) => p.pa)),
      track: 2 * Math.max(...wh.map((p) => Math.abs(p.ps))),
    };
    return (cache[kind] = m);
  }

  /** One wheel's colours and turn from its Stance.wheels entry: { cs, sn, col, glow } by triangle key. */
  function wheelLook(w, tint) {
    const o = { cs: Math.cos(w.rot), sn: Math.sin(w.rot), col: {}, glow: {} };
    // spokes lose contrast as the wheel speeds up (a blur), and are sharp on a wheel that has stopped
    const blur = Math.max(0, Math.min(1, (Math.abs(w.omega) - 12) / 33)) * 0.75;
    const even = mix(FIXED.rim, FIXED.dark, 0.3);
    let rim = mix(FIXED.rim, even, blur), spoke = mix(FIXED.dark, even, blur), rimGlow = 0;
    let heat = [0, 0, 0];
    if (tint) {
      if (w.temp) heat = w.temp.map(IST.Review.Stance.heat);
      const flag = w.lock > w.spin ? LOCK : SPIN, f = Math.max(w.lock, w.spin);
      if (f > 0) (rim = mix(rim, flag, f)), (spoke = mix(spoke, flag, f * 0.5)), (rimGlow = f);
    }
    const tyre = (h) => (h < 0 ? mix(FIXED.tyre, COLD, -h * 0.8) : mix(FIXED.tyre, h > 0.7 ? mix(HOT, WHITE_HOT, (h - 0.7) / 0.3) : HOT, Math.min(1, h * 1.3)));
    for (let b = 0; b < 3; b++) (o.col['tread' + b] = tyre(heat[b])), (o.glow['tread' + b] = Math.abs(heat[b]));
    // the sidewall takes the tyre's mean at half strength, so heat reads from the side too
    const mean = (heat[0] + heat[1] + heat[2]) / 3;
    o.col.wall = tyre(mean * 0.55);
    o.glow.wall = Math.abs(mean) * 0.55;
    o.col.tyre = FIXED.tyre;
    o.col.rim = rim;
    o.col.spoke = spoke;
    o.glow.rim = rimGlow;
    o.glow.spoke = rimGlow * 0.5;
    return o;
  }
  const STILL = { rot: 0, omega: 0, lock: 0, spin: 0, temp: null };

  function emit(V, m, road, body, rgb, st) {
    const col = Object.assign({}, FIXED, { body: rgb, trim: rgb.map((x) => x * 0.5) });
    if (st && st.brake) col.tail = FIXED.tailOn;
    const d = (st && st.steer) || 0, cs = Math.cos(d), sn = Math.sin(d);
    const tris = m.tris, parts = m.parts;
    const looks = parts.map((P) => (P.wheel ? wheelLook((st && st.wheels && st.wheels[P.id]) || STILL, !!(st && st.tint)) : null));
    for (let i = 0; i < tris.length; i++) {
      const t = tris[i], P = parts[t.part], X = P.wheel ? road : body, W = looks[t.part];
      const c = W ? W.col[t.key] : col[t.key];
      // glow: 1 draws at full brightness whatever way the face points, 0 is lit by the sun
      const g = W ? W.glow[t.key] || 0 : t.key === 'lamp' || t.key === 'tail' ? 1 : 0;
      let na = t.n[0], nh = t.n[1], ns = t.n[2];
      if (W) {
        const a0 = na;
        na = a0 * W.cs + nh * W.sn;
        nh = nh * W.cs - a0 * W.sn;
      }
      if (P.steer) {
        const a0 = na;
        na = a0 * cs - ns * sn;
        ns = a0 * sn + ns * cs;
      }
      const nx = (X.f[0] * na + X.u[0] * nh + X.l[0] * ns) * (1 - g) + SUN[0] * g;
      const ny = (X.f[1] * na + X.u[1] * nh + X.l[1] * ns) * (1 - g) + SUN[1] * g;
      const nz = (X.f[2] * na + X.u[2] * nh + X.l[2] * ns) * (1 - g) + SUN[2] * g;
      for (let k = 0; k < 3; k++) {
        const p = t.p[k];
        let a = p[0], h = p[1], s = p[2];
        if (W) {
          // rolling forward: the top of the wheel moves toward the nose
          const da = a - P.pa, dh = h - P.ph;
          a = P.pa + da * W.cs + dh * W.sn;
          h = P.ph + dh * W.cs - da * W.sn;
        }
        if (P.steer) {
          const da = a - P.pa, ds = s - P.ps;
          a = P.pa + da * cs - ds * sn;
          s = P.ps + da * sn + ds * cs;
        }
        V.push(X.p[0] + X.f[0] * a + X.u[0] * h + X.l[0] * s, X.p[1] + X.f[1] * a + X.u[1] * h + X.l[1] * s, X.p[2] + X.f[2] * a + X.u[2] * h + X.l[2] * s, nx, ny, nz, c);
      }
    }
  }

  function shadow(V, m, road) {
    const K = [0, 0, 0], at = (a, s) => [road.p[0] + road.f[0] * a + road.l[0] * s, road.p[1] + road.f[1] * a + road.l[1] * s + 0.02, road.p[2] + road.f[2] * a + road.l[2] * s];
    const w = m.width / 2, ring = (g) => [at(m.front + g, w + g), at(m.front + g, -w - g), at(m.rear - g, -w - g), at(m.rear - g, w + g)];
    const I = ring(-0.25), O = ring(0.45);
    const put = (p, al) => V.push(p[0], p[1], p[2], 0, 1, 0, K, al);
    [0, 1, 2, 0, 2, 3].forEach((k) => put(I[k], 0.42));
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) % 4;
      [[I[k], 0.42], [I[j], 0.42], [O[j], 0], [I[k], 0.42], [O[j], 0], [O[k], 0]].forEach(([p, al]) => put(p, al));
    }
  }

  IST.Review.Cars = { KINDS, kindOf, model, emit, shadow };
})();
