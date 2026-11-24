/*
 * Satellite ground under the Review track: Esri imagery tiles draped on a
 * terrain that follows the track's own elevation.
 *
 *   IST.Review.MapLayer.build(R, S, cmp, geo, onChange)
 *     R: renderer, S: the built scene (scene.js), geo: Track.geo for the
 *     laps' frame. Tiles load in the background; each one is added to
 *     S.items as it arrives and onChange() is called so the page redraws.
 *     Everything is freed with S.dispose().
 *
 * Three layers: a coarse zoom over the whole ground (at most ~36 tiles);
 * the road and ~45 m of run-off at z18 (~0.4 m a pixel at Spa's latitude),
 * z17 for very long circuits; and the road plus ~20 m at the finest zoom Esri
 * actually has there (z19, ~0.2 m a pixel, at Spa; z20 in some cities),
 * looked up first so no placeholder tiles are fetched. Each finer layer is
 * pushed back less in depth (all behind the laps), and the coarse one also
 * sits 1.5 m lower, so a coarser layer never shows through a finer one. Tiles are cut along
 * Web Mercator lines, so each is a grid of vertices mapped back to the laps'
 * frame one by one.
 *
 * Coarse tiles are marked (item.coarse): close up they're only a blur round
 * the sharp corridor, so the page stops drawing them when the camera is near.
 *
 * Telemetry has heights only along the track, so the ground's height is a
 * nearness-weighted mix of the centre's heights around it, then bounded
 * near the road: 0.4 m under it out to the edge, then climbing or falling
 * at most 1 in 3. So a bank can't swallow the road or the cars, and there
 * are no cliffs for the top-down imagery to smear down. Where two stretches
 * at different heights pass close, staying under the road wins. Far from
 * the track it's a smooth blend of the whole track's heights.
 */
(function () {
  'use strict';
  const GL = IST.Review.GL;
  const TINT = [0.9, 0.9, 0.9];
  const MAX_BASE = 36;
  const DETAIL = [[18, 280], [17, 420], [16, 600]]; // zoom, most tiles we'll fetch at it
  const ROAD = [[20, 700], [19, 900], [18, 900]]; // the road strip: finest first

  const lon2x = (lon, z) => ((lon + 180) / 360) * Math.pow(2, z);
  const lat2y = (lat, z) => {
    const r = (lat * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z);
  };
  const x2lon = (x, z) => (x / Math.pow(2, z)) * 360 - 180;
  const y2lat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / Math.pow(2, z)))) * 180) / Math.PI;

  /** Points bucketed by (x, z) cell, each `stride` numbers long, for neighbourhood queries. */
  function gridOf(stride, cell) {
    const grid = new Map(), key = (i, j) => i * 73856093 + j;
    return {
      add(x, z, vals) {
        const k = key(Math.floor(x / cell), Math.floor(z / cell));
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(...vals);
      },
      each(x, z, rings, fn) {
        const ci = Math.floor(x / cell), cj = Math.floor(z / cell);
        for (let i = ci - rings; i <= ci + rings; i++) for (let j = cj - rings; j <= cj + rings; j++) {
          const L = grid.get(key(i, j));
          if (L) for (let k = 0; k < L.length; k += stride) fn(L, k);
        }
      },
    };
  }

  /** Ground height in GL space at (x, z). */
  function terrain(S, cmp, exag) {
    const C = S.centre, n = C.length / 3, w = cmp.centre.w, step = cmp.step;
    const smooth = gridOf(3, 60), clamp = gridOf(4, 30), coarse = [];
    const every = (m) => Math.max(1, Math.round(m / step));
    for (let i = 0; i < n; i += every(5)) smooth.add(C[i * 3], C[i * 3 + 2], [C[i * 3], C[i * 3 + 1], C[i * 3 + 2]]);
    for (let i = 0; i < n; i += every(2)) clamp.add(C[i * 3], C[i * 3 + 2], [C[i * 3], C[i * 3 + 1], C[i * 3 + 2], w[i]]);
    for (let i = 0; i < n; i += every(200)) coarse.push(C[i * 3], C[i * 3 + 1], C[i * 3 + 2]);
    const slope = exag / 3; // how steeply ground may climb or fall away from the road's edge
    return (x, z) => {
      let sw = 0, sh = 0;
      smooth.each(x, z, 3, (L, k) => {
        const d2 = (L[k] - x) ** 2 + (L[k + 2] - z) ** 2;
        const wt = 1 / ((d2 + 16) * (d2 + 16));
        sw += wt;
        sh += wt * L[k + 1];
      });
      let gw = 0, gh = 0;
      for (let k = 0; k < coarse.length; k += 3) {
        const wt = 1 / ((coarse[k] - x) ** 2 + (coarse[k + 2] - z) ** 2 + 100);
        gw += wt;
        gh += wt * coarse[k + 1];
      }
      const far = 1 / Math.pow(200 * 200, 2);
      let h = (sh + far * (gh / gw)) / (sw + far) - 0.4;
      // near the road the ground follows it: just under it to the edge, then climbing or
      // falling at most 1 in 3. Never above it (that wins where two stretches of track at
      // different heights pass close), and no cliffs, which would smear the imagery.
      let hi = Infinity, lo = -Infinity;
      clamp.each(x, z, 3, (L, k) => {
        const d = Math.hypot(L[k] - x, L[k + 2] - z), g = slope * Math.max(0, d - L[k + 3] - 1.5);
        hi = Math.min(hi, L[k + 1] - 0.4 + g);
        lo = Math.max(lo, L[k + 1] - 0.4 - g);
      });
      return Math.min(hi, Math.max(lo, h));
    };
  }

  // Tile work per frame, so the view keeps drawing while the ground fills in. Script time
  // alone isn't the limit: a tile's mesh is ~30 KB of vertices, cheap to hand over but not
  // to upload, and hundreds in one frame stall the page on the GPU. So: a time budget and
  // a tile count, whichever comes first.
  const BUDGET = 6, PER_FRAME = 40;

  /**
   * opt.texCache: a Map ('z/x/y' -> texture) that outlives the scene (the page keeps one per
   * GL context), so a rebuild re-drapes tiles it already has without fetching or uploading them.
   */
  function build(R, S, cmp, geo, onChange, opt) {
    const texCache = opt && opt.texCache;
    const ce = cmp.centre, n = cmp.n, B = cmp.bounds, pad = S.pad;
    const height = terrain(S, cmp, S.exag || 1);
    // the ground's corners in lat / lon
    let la0 = Infinity, la1 = -Infinity, lo0 = Infinity, lo1 = -Infinity;
    [[B.x0 - pad, B.y0 - pad], [B.x1 + pad, B.y0 - pad], [B.x0 - pad, B.y1 + pad], [B.x1 + pad, B.y1 + pad]].forEach((p) => {
      const ll = geo.toLL(p[0], p[1]);
      la0 = Math.min(la0, ll[0]);
      la1 = Math.max(la1, ll[0]);
      lo0 = Math.min(lo0, ll[1]);
      lo1 = Math.max(lo1, ll[1]);
    });
    const range = (z) => ({ x0: Math.floor(lon2x(lo0, z)), x1: Math.floor(lon2x(lo1, z)), y0: Math.floor(lat2y(la1, z)), y1: Math.floor(lat2y(la0, z)) });
    let zb = 18;
    while (zb > 10) {
      const r = range(zb);
      if ((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) <= MAX_BASE) break;
      zb--;
    }
    const want = [];
    const rb = range(zb);
    for (let x = rb.x0; x <= rb.x1; x++) for (let y = rb.y0; y <= rb.y1; y++) want.push({ z: zb, x, y, layer: 0 });
    // fine tiles along the track: the road and `margin` m either side
    const corridor = (zd, margin, layer) => {
      const set = new Map();
      for (let i = 0; i < n; i += Math.max(1, Math.round(10 / cmp.step))) {
        const a = Math.max(0, i - 3), b = Math.min(n - 1, i + 3);
        const tx = ce.x[b] - ce.x[a], ty = ce.y[b] - ce.y[a], l = Math.hypot(tx, ty) || 1;
        [-1, -0.5, 0, 0.5, 1].forEach((f) => {
          const off = f * (ce.w[i] + margin);
          const ll = geo.toLL(ce.x[i] - (ty / l) * off, ce.y[i] + (tx / l) * off);
          const x = Math.floor(lon2x(ll[1], zd)), y = Math.floor(lat2y(ll[0], zd));
          if (!set.has(x + ',' + y)) set.set(x + ',' + y, { z: zd, x, y, layer, i });
        });
      }
      return set;
    };
    let zc = zb;
    for (const [zd, max] of DETAIL) {
      if (zd <= zb) break;
      const set = corridor(zd, 45, 1);
      if (set.size <= max) {
        // in lap order, so the ground fills in round the circuit rather than at random
        Array.from(set.values()).sort((p, q) => p.i - q.i).forEach((t) => want.push(t));
        zc = zd;
        break;
      }
    }

    function patch(t) {
      const N = 16, drop = t.layer ? 0 : 1.5;
      const P = [];
      for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
        const lat = y2lat(t.y + j / N, t.z), lon = x2lon(t.x + i / N, t.z);
        const xy = geo.toXY(lat, lon);
        const g = S.toGL(xy[0], xy[1], 0);
        P.push([g[0], height(g[0], g[2]) - drop, g[2], i / N, j / N]);
      }
      const data = new Float32Array(N * N * 6 * GL.TSTRIDE);
      let o = 0;
      const put = (p) => {
        data.set(p, o);
        o += GL.TSTRIDE;
      };
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const a = P[j * (N + 1) + i], b = P[j * (N + 1) + i + 1], c = P[(j + 1) * (N + 1) + i], d = P[(j + 1) * (N + 1) + i + 1];
        put(a); put(b); put(d); put(a); put(d); put(c);
      }
      return data;
    }

    // lift: further layers are pushed back further, so finer always wins
    const LIFT = [-4, -2, -1];
    let pending = 0, failed = 0, total = 0;
    // tiles that have arrived wait here and are draped a few at a time each frame
    const queue = [];
    let pumping = false;
    const place = (t, img) => {
      const key = t.z + '/' + t.x + '/' + t.y;
      let tex = texCache && texCache.get(key);
      if (!tex) {
        tex = R.texture(img);
        if (texCache) texCache.set(key, tex);
        else S.adopt(null, tex);
      }
      const mesh = R.texMesh('tris', patch(t));
      S.adopt(mesh);
      S.items.push({ mesh, tex, tint: TINT, lift: LIFT[t.layer || 0], coarse: !t.layer });
    };
    const pump = () => {
      if (S.disposed) return (queue.length = 0), (pumping = false);
      const t0 = performance.now();
      let placed = 0;
      while (queue.length && placed < PER_FRAME && (performance.now() - t0 < BUDGET || !placed)) {
        const [t, img] = queue.shift();
        place(t, img);
        placed++;
      }
      onChange();
      if (queue.length) requestAnimationFrame(pump);
      else pumping = false;
    };
    const arrive = (t, img) => {
      if (S.disposed) return;
      queue.push([t, img]);
      if (!pumping) (pumping = true), requestAnimationFrame(pump);
    };
    const load = (list) => list.forEach((t) => {
      // already uploaded for an earlier scene: no fetch, no decode, no upload
      if (texCache && texCache.has(t.z + '/' + t.x + '/' + t.y)) return arrive(t, null);
      pending++;
      total++;
      IST.Review.MapData.tile(t.z, t.x, t.y).then((img) => arrive(t, img), () => failed++).finally(() => {
        if (--pending === 0 && failed === total && !S.disposed) onChange(new Error('no imagery'));
      });
    });
    load(want);

    // the road itself at the finest zoom Esri really has there (checked first, so no
    // "no data" placeholders are fetched); where it has none, the layer below shows
    (async () => {
      for (const [zr, max] of ROAD) {
        if (zr <= zc || S.disposed) continue;
        const list = Array.from(corridor(zr, 20, 2).values());
        if (list.length > max) continue;
        let have;
        try {
          have = await IST.Review.MapData.available(zr, list);
        } catch (e) {
          return;
        }
        const ok = list.filter((t) => have.has(t.x + ',' + t.y));
        if (ok.length >= list.length * 0.6) {
          if (!S.disposed) load(ok.sort((p, q) => p.i - q.i));
          return;
        }
      }
    })();
    return { zoom: zb, corridor: zc };
  }

  IST.Review.MapLayer = { build };
})();
