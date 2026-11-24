/*
 * Builds the Review viewer's geometry from a comparison (compare.js).
 *
 *   const S = IST.Review.Scene.build(R, cmp, opt)
 *     opt: { exag (elevation x), fences ([bool] per lap, "whose": its fence, paint and markers), lean (bool),
 *            fenceH (m), closeUp (bool), map (bool: satellite ground coming, so no road surface, edges or centre line),
 *            paint ('lap' or a Layers.PAINTS key), fence ('inputs' | 'balance' | 'grip' | 'delta' | 'none'), absTint (bool),
 *            deltaLap (the one lap whose delta fence is drawn, or -1),
 *            markers (Set of event kinds to underline), gears (bool: gear posts),
 *            attitude (bool: body-slip arrows and wedges), attScale (drawn angle x) }
 *   S.items       the static draw list for R.draw (maplayer.js adds the ground tiles to it)
 *   S.layerItems  the current layers' draw list (lap ribbons, fences, halos, gear posts): draw both
 *   S.setLayers(opt)  swap the layer fields of opt without rebuilding the rest (recent sets cached)
 *   S.centre      Float32Array(n * 3): the track centre in GL space (S.centreLat its left normal)
 *   S.base[k]     Float32Array(n * 3): lap k's line on the road surface, in GL space
 *   S.lateral[k]  Float32Array(n * 2): lap k's left-pointing unit normal (GL x, z)
 *   S.toGL(x, y, z), S.size (extent, m), S.fenceH
 *   S.dispose()
 *   IST.Review.Scene.car(V, pose, rgb)   a car marker, for the page's per-frame car mesh
 *
 * What's drawn:
 *   - a ground plane with a 50 / 100 m grid, the page's blueprint look in 3D
 *   - the track round its centre (the map's when there is one, else the laps'
 *     average path: compare.js), with edges and a skirt down to the ground so
 *     elevation reads. A map centre is drawn as a faint dashed line. Over
 *     satellite ground none of this is drawn: the imagery is the road, and
 *     edges from an estimated width wouldn't line up with it.
 *   - each lap's line on the surface: a thin ribbon in its colour over a dark
 *     outline with a 1 px core, the reference solid and the others dashed at
 *     their own rhythm, lifted a little more per lap
 *   - inputs as fences floating just above each line: throttle (green) and
 *     brake (red) at 0-100 % of fenceH, edged with thin lines in the lap's
 *     colour (25 / 50 / 75 % guides in close-up); downshift blips show as
 *     green spikes inside the red.
 *     With lean, the fence tops lean toward the steering input.
 *   - a post at every gear change (the number is drawn by the page's overlay)
 *   - attitude: every 12 m (5 m close up) an arrow along the car's body axis, the
 *     travel direction as a faint tick, and the slip angle between them shaded
 *     by how far it is past this session's usual at that lateral g (Layers)
 */
(function () {
  'use strict';
  const GL = IST.Review.GL, Th = IST.Theme, Ly = IST.Review.Layers;
  const DEG = Math.PI / 180;
  const C_THR = GL.rgb(Th.hit), C_BRK = GL.rgb(Th.miss), C_ABS = GL.rgb('#8a1a14'), OUTLINE = GL.rgb('#111317');
  const C_US = GL.rgb(Th.sky), C_OS = GL.rgb(Th.peach), C_ROSE = GL.rgb(Th.rose), C_BUT = GL.rgb(Th.butter);

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
    const autoFenceH = Math.max(5, Math.min(16, size / 160));
    const toGL = (x, y, z) => [x - ox, (z - oz) * exag, -(y - oy)];
    const dec = Math.max(1, Math.round(2 / cmp.step)); // geometry every ~2 m
    const items = [];
    const meshes = [], textures = [];
    // add() puts a mesh in the current sink: the static scene, or one set of layers
    let sink = { items, meshes };
    const add = (mode, V, it) => {
      if (!V.length) return;
      const m = R.mesh(mode, V.data());
      sink.meshes.push(m);
      sink.items.push(Object.assign({ mesh: m }, it));
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
      // over satellite ground the imagery is the road: drawn edges from an estimated
      // width wouldn't line up with the real asphalt, so they're left out
      if (!opt.map) {
        add('strip', road, { lit: true });
        skirt.forEach((V) => add('strip', V, { lit: false, blend: true }));
        edges.forEach((V) => add('strip', V, { lit: true, lift: 1 }));
      }
    }
    // the map's centreline, dashed 4 m on / 4 m off (not over imagery, for the same reason)
    if (ce.source === 'map' && !opt.map) {
      const D = GL.Verts(), cc = [1, 1, 1];
      const every = Math.max(1, Math.round(4 / cmp.step));
      for (let i = 0; i + every < n; i += every * 2) {
        const a = i * 3, b = (i + every) * 3;
        D.push(cGL[a], cGL[a + 1] + 0.05, cGL[a + 2], 0, 1, 0, cc, 0.45);
        D.push(cGL[b], cGL[b + 1] + 0.05, cGL[b + 2], 0, 1, 0, cc, 0.45);
      }
      add('lines', D, { lit: false, blend: true });
    }

    // ------------------------------------------------------------ lap lines
    const base = [], lateral = [];
    const speedRange = (L) => {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < n; i++) (lo = Math.min(lo, L.speed[i])), (hi = Math.max(hi, L.speed[i]));
      return { lo, hi };
    };
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
    });

    /*
     * Everything that depends on the Layers choices: lap ribbons (lap colour or painted),
     * fences, event halos and gear posts. Built into its own mesh set so a change of
     * layer never touches the ground, the track or the map tiles, and kept in a small
     * cache so switching back to a recent choice is instant.
     */
    function buildLayers(opt) {
      const fenceH = opt.fenceH || autoFenceH;
      const show = opt.fences || cmp.laps.map(() => true);
      const paintKey = opt.paint && opt.paint !== 'lap' ? opt.paint : null;
      cmp.laps.forEach((L, k) => {
        const P = base[k], Lt = lateral[k];
        // a thin ribbon over a dark outline so overlapping colours stay separate, a pattern
        // per lap (reference solid, the others dashed at their own rhythm), and a 1 px core
        // line so the lap still shows when the ribbon is thinner than a pixel far away
        // a painted line (balance, grip...) keeps a lap-colour edge so laps stay apart
        const c = GL.rgb(L.color), shade = c.map((x) => x * 0.45), hw = k === 0 ? 0.32 : 0.24;
        const pk = paintKey && show[k] && !(paintKey === 'gain' && k === 0) ? paintKey : null;
        const ctx = pk === 'speed' ? speedRange(L) : null;
        const dash = k === 0 ? 0 : 3 + 2 * k; // metres per dash
        const O = GL.Verts(), V = GL.Verts(), Core = GL.Verts();
        idx.forEach((i) => {
          const lx = Lt[i * 2], lz = Lt[i * 2 + 1], x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
          const ow = hw + (pk ? 0.2 : 0.12), edgeC = pk ? c : OUTLINE;
          O.push(x + lx * ow, y - 0.02, z + lz * ow, 0, 1, 0, edgeC);
          O.push(x - lx * ow, y - 0.02, z - lz * ow, 0, 1, 0, edgeC);
          const off = dash && Math.floor((i * cmp.step) / dash) % 2;
          const pc = pk ? Ly.paint(pk, L, i, ctx) : null;
          const col = pc ? (off ? pc.map((q) => q * 0.72) : pc) : off ? shade : c;
          V.push(x + lx * hw, y, z + lz * hw, 0, 1, 0, col);
          V.push(x - lx * hw, y, z - lz * hw, 0, 1, 0, col);
          Core.push(x, y + 0.02, z, 0, 1, 0, pc || c);
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
      const gap = Math.max(0.3, fenceH * 0.08);
      const fenceKind = opt.fence || 'inputs';
      const guides = opt.closeUp ? [0.25, 0.5, 0.75] : [];
      cmp.laps.forEach((L, k) => {
        if (!show[k]) return;
        const P = base[k], Lt = lateral[k], lc = GL.rgb(L.color);
        let smax = 0;
        if (opt.lean && L.steer) for (let i = 0; i < n; i++) smax = Math.max(smax, Math.abs(L.steer[i]));
        // vals: 0..1 array or (i) -> value; col: rgb, or (i, v) -> [rgb, alpha factor]
        const fence = (vals, col, alpha, max) => {
          if (!vals) return;
          const V = GL.Verts(), E = GL.Verts(), G = GL.Verts();
          const get = typeof vals === 'function' ? vals : (i) => vals[i];
          const colAt = typeof col === 'function' ? col : () => [col, 1];
          let prev = null;
          idx.forEach((i) => {
            const raw = get(i);
            const v = isFinite(raw) ? Math.max(0, Math.min(max || 1, raw)) : 0;
            const [cc, af] = colAt(i, v);
            // steering + is left in iRacing; lean the top toward the turn
            const leanAt = (f) => (smax > 0 ? (L.steer[i] / smax) * fenceH * 0.5 * f : 0);
            const bx = P[i * 3], by = P[i * 3 + 1] + gap, bz = P[i * 3 + 2];
            const at = (f) => {
              const l = leanAt(f);
              return [bx + Lt[i * 2] * l, by + f * fenceH, bz + Lt[i * 2 + 1] * l];
            };
            const top = at(v);
            V.push(bx, by, bz, 0, 1, 0, cc, alpha * 0.4 * af);
            V.push(top[0], top[1], top[2], 0, 1, 0, cc, alpha * af);
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
        if (fenceKind === 'inputs') {
          fence(L.throttle, C_THR, 0.42);
          // ABS: the brake fence striped darker every 2 m where it was cutting force
          const abs = opt.absTint !== false && L.absActive;
          const brkCol = abs ? (i) => (abs[i] > 0.5 ? (Math.floor((i * cmp.step) / 2) % 2 ? [C_ABS, 1] : [C_BRK, 0.55]) : [C_BRK, 1]) : C_BRK;
          fence(L.brake, brkCol, 0.6);
        } else if (fenceKind === 'balance' && L.us) {
          fence((i) => L.us[i] / (20 * DEG), C_US, 0.55);
          fence((i) => -L.us[i] / (20 * DEG), C_OS, 0.55);
        } else if (fenceKind === 'grip' && L.gripUse) {
          fence(L.gripUse, (i, v) => [v > 1 ? C_ROSE : C_BUT, 1], 0.5, 1.15);
        } else if (fenceKind === 'delta' && k > 0 && k === opt.deltaLap) {
          // the gap to the reference, full height at this lap's biggest gap: a rising fence is
          // time going, a falling one time coming back; the fill says which, per 100 m
          let big = 0.05;
          for (let i = 0; i < n; i++) big = Math.max(big, Math.abs(L.delta[i]));
          // fill saturates at this lap's own 90th-percentile rate, so small gaps still show colour
          const g = [];
          for (let i = 0; i < n; i += 5) g.push(Math.abs(L.gain[i]));
          g.sort((a, b) => a - b);
          const gs = Math.max(0.004, g[Math.floor(g.length * 0.9)] || 0);
          const NEU = Ly.rgb('#a1a9b7'), MINT = Ly.rgb(Th.mint);
          fence((i) => Math.abs(L.delta[i]) / big, (i) => {
            const v = L.gain[i], t = Math.min(1, Math.abs(v) / gs);
            return [Ly.mix(NEU, v < 0 ? MINT : C_ROSE, t), 0.6 + 0.4 * t];
          }, 0.75);
        }
      });

      // ----------------------------------------------------- event underlines
      // a halo round the lap line from an event's start to its end (kerbs and coasting
      // dashed), under the line so the lap's own colour stays on top
      if (opt.markers && opt.markers.size) {
        const H = GL.Verts();
        cmp.laps.forEach((L, k) => {
          if (!show[k] || !L.events) return;
          const P = base[k], Lt = lateral[k];
          const hw = 0.85 + 0.1 * k;
          const side = (i, s) => [P[i * 3] + Lt[i * 2] * hw * s, P[i * 3 + 1] - 0.03, P[i * 3 + 2] + Lt[i * 2 + 1] * hw * s];
          L.events.forEach((e) => {
            if (!opt.markers.has(e.kind) || e.kind === 'bbChange') return;
            const col = GL.rgb(Ly.markerFor(e.kind).color);
            const dashed = e.kind === 'kerb' || e.kind === 'coast';
            const a = Math.max(0, e.i0 - 1), b = Math.min(n - 1, e.i1 + 1);
            const st = Math.max(1, Math.min(dec, b - a));
            for (let i = a; i < b; i += st) {
              const j = Math.min(b, i + st);
              if (dashed && Math.floor((i * cmp.step) / 2) % 2) continue;
              const p = [side(i, 1), side(i, -1), side(j, 1), side(j, -1)];
              [0, 1, 2, 2, 1, 3].forEach((q) => H.push(p[q][0], p[q][1], p[q][2], 0, 1, 0, col, 0.85));
            }
          });
        });
        add('tris', H, { lit: false, blend: true, lift: 1.2 });
      }

      // ------------------------------------------------------------ gear posts
      if (opt.gears !== false) {
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
      // -------------------------------------------------------- attitude
      // where the nose points against where the car is going: an arrow along the body
      // axis, the travel direction as a faint tick down the line, and the angle between
      // them shaded by how much more (peach, rose) or less (sky) the car rotated than
      // usual at that lateral g. attScale exaggerates the drawn angle.
      if (opt.attitude) {
        const every = Math.max(1, Math.round((opt.closeUp ? 5 : 12) / cmp.step));
        const R0 = opt.closeUp ? 4.5 : 7, sc = opt.attScale || 1, SEG = 6;
        const W = GL.Verts(), A = GL.Verts();
        const seg = (x0, y0, z0, x1, y1, z1, c, al) => (A.push(x0, y0, z0, 0, 1, 0, c, al), A.push(x1, y1, z1, 0, 1, 0, c, al));
        cmp.laps.forEach((L, k) => {
          if (!show[k] || !L.vx || !L.vy) return;
          const P = base[k], Lt = lateral[k], lc = [1, 1, 1];
          for (let i = every >> 1; i < n; i += every) {
            const a0 = Ly.nose(L, i);
            if (!isFinite(a0)) continue;
            const a = Math.max(-80 * DEG, Math.min(80 * DEG, a0 * sc));
            const lx = Lt[i * 2], lz = Lt[i * 2 + 1], tx = -lz, tz = lx; // travel = left rotated back 90°
            const dir = (q) => [tx * Math.cos(q) + lx * Math.sin(q), tz * Math.cos(q) + lz * Math.sin(q)];
            const x = P[i * 3], y = P[i * 3 + 1] + 0.06, z = P[i * 3 + 2];
            const col = Ly.attitudeColor(L, i);
            // shaded wedge from travel to heading
            for (let s2 = 0; s2 < SEG; s2++) {
              const p = dir((a * s2) / SEG), q = dir((a * (s2 + 1)) / SEG);
              W.push(x, y, z, 0, 1, 0, col, 0.35);
              W.push(x + p[0] * R0, y, z + p[1] * R0, 0, 1, 0, col, 0.9);
              W.push(x + q[0] * R0, y, z + q[1] * R0, 0, 1, 0, col, 0.9);
            }
            // travel tick
            seg(x, y + 0.01, z, x + tx * R0, y + 0.01, z + tz * R0, OUTLINE, 0.9);
            // heading arrow (white, so it reads over any line colour): tail behind the point, head at the rim
            const h2 = dir(a), tail = R0 * 0.35, hd = R0 * 0.22;
            const tip = [x + h2[0] * R0, z + h2[1] * R0];
            seg(x - h2[0] * tail, y + 0.02, z - h2[1] * tail, tip[0], y + 0.02, tip[1], lc, 1);
            [0.45, -0.45].forEach((s3) => {
              const b = dir(a + Math.PI - s3);
              seg(tip[0], y + 0.02, tip[1], tip[0] + b[0] * hd, y + 0.02, tip[1] + b[1] * hd, lc, 1);
            });
          }
        });
        add('tris', W, { lit: false, blend: true, lift: 3 });
        add('lines', A, { lit: false, blend: true, lift: 3.5 });
      }
    }

    const cache = new Map(); // layer key -> { items, meshes, fenceH }
    const MAX_CACHED = 6;
    const keyOf = (o) => JSON.stringify([o.paint, o.fence, o.fences, o.lean, o.absTint !== false, o.markers ? [...o.markers].sort() : [], o.gears !== false, o.fenceH || 0, !!o.closeUp, !!o.attitude, o.attScale || 1, o.deltaLap == null ? -1 : o.deltaLap]);
    const S = {
      items, layerItems: [], base, lateral, toGL, exag, size, fenceH: autoFenceH, groundY, centre: cGL, centreLat: lat2, pad: size * 0.25,
      /** Show these layers (scene opt fields: paint, fence, fences, lean, absTint, markers, gears, fenceH, closeUp). */
      setLayers(o) {
        const key = keyOf(o);
        let L = cache.get(key);
        if (L) cache.delete(key); // re-insert: most recent last
        else {
          L = { items: [], meshes: [], fenceH: o.fenceH || autoFenceH };
          sink = L;
          buildLayers(o);
          sink = { items, meshes };
          while (cache.size >= MAX_CACHED) {
            const [k0, old] = cache.entries().next().value;
            old.meshes.forEach((m) => R.free(m));
            cache.delete(k0);
          }
        }
        cache.set(key, L);
        S.layerItems = L.items;
        S.fenceH = L.fenceH;
        return S;
      },
      /** Keep a mesh or texture made elsewhere (the map layer) until dispose. */
      adopt(m, tex) {
        if (m) meshes.push(m);
        if (tex) textures.push(tex);
      },
      disposed: false,
      dispose() {
        cache.forEach((L) => L.meshes.forEach((m) => R.free(m)));
        cache.clear();
        meshes.forEach((m) => R.free(m));
        textures.forEach((t) => R.freeTexture(t));
        meshes.length = 0;
        textures.length = 0;
        this.disposed = true;
      },
    };
    return S.setLayers(opt);
  }

  IST.Review.Scene = { build, car };
})();
