/*
 * Builds the Review viewer's geometry from a comparison (compare.js).
 *
 *   const S = IST.Review.Scene.build(R, cmp, opt)
 *     opt: { exag (elevation x), fences ([bool] per lap: draw its inputs), lean (bool), fenceH (m), closeUp (bool) }
 *   S.items       draw list for R.draw
 *   S.base[k]     Float32Array(n * 3): lap k's line on the road surface, in GL space
 *   S.lateral[k]  Float32Array(n * 2): lap k's left-pointing unit normal (GL x, z)
 *   S.toGL(x, y, z), S.size (extent, m), S.fenceH
 *   S.dispose()
 *   IST.Review.Scene.car(V, pose, rgb)   a car marker, for the page's per-frame car mesh
 *
 * What's drawn:
 *   - a ground plane with a 50 / 100 m grid, the page's blueprint look in 3D
 *   - the track: the laps' average path, with edges and a skirt down to the
 *     ground so elevation reads
 *   - each lap's line on the surface: a thin ribbon in its colour over a dark
 *     outline with a 1 px core, the reference solid and the others dashed at
 *     their own rhythm, lifted a little more per lap
 *   - inputs as fences floating just above each line: throttle (green) and
 *     brake (red) at 0-100 % of fenceH, edged with thin lines in the lap's
 *     colour (25 / 50 / 75 % guides in close-up); downshift blips show as
 *     green spikes inside the red.
 *     With lean, the fence tops lean toward the steering input.
 *   - a post at every gear change (the number is drawn by the page's overlay)
 */
(function () {
  'use strict';
  const GL = IST.Review.GL, Th = IST.Theme;
  const C_THR = GL.rgb(Th.hit), C_BRK = GL.rgb(Th.miss), OUTLINE = GL.rgb('#111317');

  /**
   * A car-sized marker (4.6 x 1.9 m body, cabin on top) at pose { p, fwd, left },
   * appended to a Verts list as lit triangles.
   */
  function car(V, q, color) {
    const dark = color.map((x) => x * 0.35);
    const box = (along, across, h0, h1, back, col) => {
      const c = (a, s, y) => [q.p[0] + q.fwd[0] * a + q.left[0] * s, q.p[1] + y, q.p[2] + q.fwd[2] * a + q.left[2] * s];
      const f = along - back, b = -along - back;
      const P = [c(b, -across, h0), c(f, -across, h0), c(f, across, h0), c(b, across, h0), c(b, -across, h1), c(f, -across, h1), c(f, across, h1), c(b, across, h1)];
      const L = q.left, F = q.fwd, nl = [-L[0], 0, -L[2]], nb = [-F[0], 0, -F[2]];
      const face = (a, b2, c2, d, n) => [a, b2, c2, a, c2, d].forEach((k) => V.push(P[k][0], P[k][1], P[k][2], n[0], n[1], n[2], col));
      face(4, 5, 6, 7, [0, 1, 0]);
      face(1, 2, 6, 5, F);
      face(0, 4, 7, 3, nb);
      face(3, 7, 6, 2, L);
      face(0, 1, 5, 4, nl);
    };
    box(2.3, 0.95, 0.15, 0.85, 0, color);
    box(1.05, 0.75, 0.85, 1.3, 0.35, dark);
  }

  function build(R, cmp, opt) {
    const n = cmp.n, B = cmp.bounds, ce = cmp.centre;
    const exag = opt.exag || 1;
    const ox = (B.x0 + B.x1) / 2, oy = (B.y0 + B.y1) / 2, oz = B.z0;
    const size = Math.max(200, B.x1 - B.x0, B.y1 - B.y0);
    const fenceH = opt.fenceH || Math.max(5, Math.min(16, size / 160));
    const toGL = (x, y, z) => [x - ox, (z - oz) * exag, -(y - oy)];
    const dec = Math.max(1, Math.round(2 / cmp.step)); // geometry every ~2 m
    const items = [];
    const meshes = [];
    const add = (mode, V, it) => {
      if (!V.length) return;
      const m = R.mesh(mode, V.data());
      meshes.push(m);
      items.push(Object.assign({ mesh: m }, it));
    };
    const idx = [];
    for (let i = 0; i < n; i += dec) idx.push(i);
    if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);

    // ---------------------------------------------------------------- ground
    const groundY = -Math.max(2, (B.z1 - B.z0) * exag * 0.08) - 1.5;
    {
      const pad = size * 0.25;
      const gx0 = B.x0 - ox - pad, gx1 = B.x1 - ox + pad, gz0 = -(B.y1 - oy) - pad, gz1 = -(B.y0 - oy) + pad;
      const V = GL.Verts(), c = GL.rgb(Th.deep);
      [[gx0, gz0], [gx1, gz0], [gx1, gz1], [gx0, gz0], [gx1, gz1], [gx0, gz1]].forEach((p) => V.push(p[0], groundY, p[1], 0, 1, 0, c));
      add('tris', V, { lit: false });
      const G = GL.Verts(), gc = GL.rgb(Th.line);
      const sp = size > 2500 ? 100 : 50;
      for (let x = Math.ceil(gx0 / sp) * sp; x <= gx1; x += sp) G.push(x, groundY + 0.02, gz0, 0, 1, 0, gc, 0.55), G.push(x, groundY + 0.02, gz1, 0, 1, 0, gc, 0.55);
      for (let z = Math.ceil(gz0 / sp) * sp; z <= gz1; z += sp) G.push(gx0, groundY + 0.02, z, 0, 1, 0, gc, 0.55), G.push(gx1, groundY + 0.02, z, 0, 1, 0, gc, 0.55);
      add('lines', G, { lit: false, blend: true });
    }

    // ----------------------------------------------------------------- track
    const cGL = new Float32Array(n * 3), lat2 = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const p = toGL(ce.x[i], ce.y[i], ce.z[i]);
      cGL.set(p, i * 3);
    }
    const lateralOf = (P, i, out, k) => {
      const a = Math.max(0, i - 3), b = Math.min(n - 1, i + 3);
      let tx = P[b * 3] - P[a * 3], tz = P[b * 3 + 2] - P[a * 3 + 2];
      const l = Math.hypot(tx, tz) || 1;
      tx /= l;
      tz /= l;
      // left of travel, in GL x/z (y up): rotate the tangent by +90° about y
      out[k] = tz;
      out[k + 1] = -tx;
    };
    for (let i = 0; i < n; i++) lateralOf(cGL, i, lat2, i * 2);
    const edge = (i, side, extra) => {
      const w = ce.w[i] + (extra || 0);
      return [cGL[i * 3] + lat2[i * 2] * w * side, cGL[i * 3 + 1], cGL[i * 3 + 2] + lat2[i * 2 + 1] * w * side];
    };
    const surfN = (i) => {
      // normal from the along-track slope; the track is flat across
      const a = Math.max(0, i - dec), b = Math.min(n - 1, i + dec);
      const T = [cGL[b * 3] - cGL[a * 3], cGL[b * 3 + 1] - cGL[a * 3 + 1], cGL[b * 3 + 2] - cGL[a * 3 + 2]];
      const L = [lat2[i * 2], 0, lat2[i * 2 + 1]];
      const N = IST.Review.M3.v.norm(IST.Review.M3.v.cross(T, L));
      return N[1] < 0 ? [-N[0], -N[1], -N[2]] : N;
    };
    {
      const road = GL.Verts(), cRoad = GL.rgb(Th.panel2);
      const edges = [GL.Verts(), GL.Verts()], cEdge = GL.rgb(Th.lineStrong);
      const skirt = [GL.Verts(), GL.Verts()], cSkirt = GL.rgb(Th.panel);
      idx.forEach((i) => {
        const N = surfN(i);
        const l = edge(i, 1), r = edge(i, -1);
        road.push(l[0], l[1], l[2], N[0], N[1], N[2], cRoad);
        road.push(r[0], r[1], r[2], N[0], N[1], N[2], cRoad);
        [1, -1].forEach((side, s) => {
          const o = edge(i, side, 0.05), m = edge(i, side, -0.45);
          edges[s].push(o[0], o[1] + 0.03, o[2], N[0], N[1], N[2], cEdge);
          edges[s].push(m[0], m[1] + 0.03, m[2], N[0], N[1], N[2], cEdge);
          skirt[s].push(o[0], o[1], o[2], 0, 1, 0, cSkirt, 0.85);
          skirt[s].push(o[0], groundY, o[2], 0, 1, 0, cSkirt, 0.2);
        });
      });
      add('strip', road, { lit: true });
      edges.forEach((V) => add('strip', V, { lit: true, lift: 1 }));
      skirt.forEach((V) => add('strip', V, { lit: false, blend: true }));
    }

    // ------------------------------------------------------------ lap lines
    const base = [], lateral = [];
    cmp.laps.forEach((L, k) => {
      const lift = 0.12 + 0.1 * k;
      const P = new Float32Array(n * 3), Lt = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        const g = toGL(L.x[i], L.y[i], ce.z[i]);
        P[i * 3] = g[0];
        P[i * 3 + 1] = g[1] + lift;
        P[i * 3 + 2] = g[2];
      }
      for (let i = 0; i < n; i++) lateralOf(P, i, Lt, i * 2);
      base.push(P);
      lateral.push(Lt);
      // a thin ribbon over a dark outline so overlapping colours stay separate, a pattern
      // per lap (reference solid, the others dashed at their own rhythm), and a 1 px core
      // line so the lap still shows when the ribbon is thinner than a pixel far away
      const c = GL.rgb(L.color), shade = c.map((x) => x * 0.45), hw = k === 0 ? 0.32 : 0.24;
      const dash = k === 0 ? 0 : 3 + 2 * k; // metres per dash
      const O = GL.Verts(), V = GL.Verts(), Core = GL.Verts();
      idx.forEach((i) => {
        const lx = Lt[i * 2], lz = Lt[i * 2 + 1], x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
        const ow = hw + 0.12;
        O.push(x + lx * ow, y - 0.02, z + lz * ow, 0, 1, 0, OUTLINE);
        O.push(x - lx * ow, y - 0.02, z - lz * ow, 0, 1, 0, OUTLINE);
        const col = dash && Math.floor((i * cmp.step) / dash) % 2 ? shade : c;
        V.push(x + lx * hw, y, z + lz * hw, 0, 1, 0, col);
        V.push(x - lx * hw, y, z - lz * hw, 0, 1, 0, col);
        Core.push(x, y + 0.02, z, 0, 1, 0, c);
      });
      add('strip', O, { lit: false, lift: 1.5 + k });
      add('strip', V, { lit: false, lift: 2 + k });
      add('linestrip', Core, { lit: false, lift: 2.5 + k });
    });

    // ---------------------------------------------------------------- fences
    // Throttle (green) and brake (red) float a little above the road, so a few per cent
    // of pedal shows as a sliver clear of the line rather than vanishing into it. Each
    // fence is edged with thin lines in its lap's colour (bottom at 0 %, top at the
    // value), and in close-up faint guides mark 25, 50 and 75 %.
    const show = opt.fences || cmp.laps.map(() => true);
    const gap = Math.max(0.3, fenceH * 0.08);
    const guides = opt.closeUp ? [0.25, 0.5, 0.75] : [];
    cmp.laps.forEach((L, k) => {
      if (!show[k]) return;
      const P = base[k], Lt = lateral[k], lc = GL.rgb(L.color);
      let smax = 0;
      if (opt.lean && L.steer) for (let i = 0; i < n; i++) smax = Math.max(smax, Math.abs(L.steer[i]));
      const fence = (vals, col, alpha) => {
        if (!vals) return;
        const V = GL.Verts(), E = GL.Verts(), G = GL.Verts();
        let prev = null;
        idx.forEach((i) => {
          const v = Math.max(0, Math.min(1, vals[i]));
          // steering + is left in iRacing; lean the top toward the turn
          const leanAt = (f) => (smax > 0 ? (L.steer[i] / smax) * fenceH * 0.5 * f : 0);
          const bx = P[i * 3], by = P[i * 3 + 1] + gap, bz = P[i * 3 + 2];
          const at = (f) => {
            const l = leanAt(f);
            return [bx + Lt[i * 2] * l, by + f * fenceH, bz + Lt[i * 2 + 1] * l];
          };
          const top = at(v);
          V.push(bx, by, bz, 0, 1, 0, col, alpha * 0.4);
          V.push(top[0], top[1], top[2], 0, 1, 0, col, alpha);
          const cur = { v, top, bot: [bx, by, bz], at };
          if (prev && (v > 0.005 || prev.v > 0.005)) {
            E.push(prev.top[0], prev.top[1], prev.top[2], 0, 1, 0, lc, 1);
            E.push(top[0], top[1], top[2], 0, 1, 0, lc, 1);
            E.push(prev.bot[0], prev.bot[1], prev.bot[2], 0, 1, 0, lc, 0.45);
            E.push(bx, by, bz, 0, 1, 0, lc, 0.45);
            guides.forEach((gl) => {
              if (v < gl || prev.v < gl) return;
              const a = prev.at(gl), b = at(gl);
              G.push(a[0], a[1], a[2], 0, 1, 0, [1, 1, 1], 0.28);
              G.push(b[0], b[1], b[2], 0, 1, 0, [1, 1, 1], 0.28);
            });
          }
          prev = cur;
        });
        add('strip', V, { lit: false, blend: true });
        add('lines', G, { lit: false, blend: true });
        add('lines', E, { lit: false, blend: true });
      };
      fence(L.throttle, C_THR, 0.42);
      fence(L.brake, C_BRK, 0.6);
    });

    // ------------------------------------------------------------ gear posts
    {
      const V = GL.Verts();
      cmp.laps.forEach((L, k) => {
        if (!show[k]) return;
        const c = GL.rgb(L.color);
        L.shifts.forEach((s) => {
          const P = base[k], i = s.i;
          V.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], 0, 1, 0, c, 0.9);
          V.push(P[i * 3], P[i * 3 + 1] + fenceH * 1.25, P[i * 3 + 2], 0, 1, 0, c, 0.9);
        });
      });
      add('lines', V, { lit: false, blend: true });
    }

    return {
      items, base, lateral, toGL, size, fenceH, groundY,
      dispose() {
        meshes.forEach((m) => R.free(m));
        meshes.length = 0;
      },
    };
  }

  IST.Review.Scene = { build, car };
})();
