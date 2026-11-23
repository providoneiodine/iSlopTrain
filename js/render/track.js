/*
 * Procedural circuit generator + pseudo-3D (segment-projection) renderer.
 *
 * Track model: 5 m segments, each with a curvature (1/m). Corners ease in,
 * hold, ease out; the apex sits at ~60 % of the constant-radius part
 * (slightly late apex, as taught for most corners). A speed profile is
 * computed from lateral grip, braking and acceleration limits, so the car
 * brakes into corners and accelerates out - giving realistic changes in
 * look-ahead time.
 *
 * The renderer is deliberately separate from the drills so alternative views
 * (themes, FOV, camera height, future WebGL view) can be swapped in.
 */
(function () {
  'use strict';
  const U = IST.util;
  const SEG = 5; // metres per segment
  const HALF_W = 6; // half track width (12 m wide circuit)

  function lowerBound(arr, pos) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (arr[m].pos < pos) lo = m + 1;
      else hi = m;
    }
    return lo;
  }

  // ------------------------------------------------------------------ track
  /*
   * Corner vocabulary. r = radius range (m), a = direction change range (rad),
   * apex = where in the constant part the apex sits, shape = curvature profile.
   */
  const CORNER_TYPES = {
    kink: { r: [160, 400], a: [0.15, 0.4], apex: 0.5 },
    sweeper: { r: [110, 280], a: [0.7, 1.7], apex: 0.55 },
    medium: { r: [50, 110], a: [0.6, 1.6], apex: 0.6 },
    tight: { r: [25, 50], a: [0.9, 1.8], apex: 0.62 },
    hairpin: { r: [14, 24], a: [2.6, 3.05], apex: 0.65 },
    tightening: { r: [40, 90], a: [1.0, 2.0], apex: 0.8, shape: 'tighten' }, // decreasing radius, late apex
    opening: { r: [35, 80], a: [0.9, 1.8], apex: 0.35, shape: 'open' }, // increasing radius, early apex
  };
  // relative weights per track character; chicane / esses / double are compound features
  const MIXES = {
    mixed: { kink: 1, sweeper: 1.2, medium: 2, tight: 1.5, hairpin: 0.6, tightening: 0.7, opening: 0.7, chicane: 1.3, esses: 0.6, double: 0.6 },
    technical: { kink: 0.4, sweeper: 0.5, medium: 1.5, tight: 2, hairpin: 1.2, tightening: 1, opening: 1, chicane: 2.2, esses: 1.2, double: 1 },
    fast: { kink: 2, sweeper: 2.5, medium: 2, tight: 0.6, hairpin: 0.2, tightening: 0.6, opening: 0.8, chicane: 0.6, esses: 0.8, double: 0.5 },
  };
  const ELEVATION = {
    flat: null,
    rolling: { grade: 0.05, span: 14, bump: 4 },
    hilly: { grade: 0.1, span: 32, bump: 9 },
  };

  /*
   * Familiar corner complexes: rare set pieces modelled on famous real corners from
   * public track maps, elevation surveys and GT3 / prototype onboards. Geometry is the
   * centreline (radius, direction change); the racing line and speed come out of the
   * same model as every other corner, so they stay smooth and consistent.
   *
   * steps: ['s', metres, opt] straight | ['c', dir (-1 left, +1 right), radius m, angle rad, opt]
   * opt.h     height (m, relative to the complex start) at the END of that step; the
   *           heights form a smooth monotone spline that replaces the generic terrain
   *           (on every elevation setting: the hill IS the corner)
   * opt.apex  apex position within the constant part (0..1); opt.shape 'tighten' | 'open'
   * opt.line  share of the track width the line uses (1 = full outside-apex-outside,
   *           lower for kinks taken nearly straight)
   */
  const s_ = (m, o) => ['s', m, o];
  const L = (r, a, o) => ['c', -1, r, a, o];
  const R = (r, a, o) => ['c', 1, r, a, o];
  const FAMILIAR = [
    // ---- Spa-Francorchamps
    { id: 'la-source', name: 'La Source', steps: [s_(60), R(16, 3.0, { apex: 0.7 }), s_(70, { h: -4 })] },
    { id: 'eau-rouge', name: 'Eau Rouge–Raidillon', // compression at the bottom, ~16 % wall, blind crest
      steps: [s_(140, { h: -7 }), L(170, 0.3, { line: 0.5, h: -9 }), s_(10), R(120, 0.75, { h: 7 }), s_(20), L(200, 0.4, { apex: 0.4, h: 18 }), s_(80, { h: 20 })] },
    { id: 'pouhon', name: 'Pouhon', // fast downhill double-apex left
      steps: [s_(120, { h: -6 }), L(130, 0.9, { apex: 0.5, h: -12 }), s_(25, { h: -14 }), L(110, 1.1, { apex: 0.65, h: -20 }), s_(60, { h: -22 })] },
    { id: 'blanchimont', name: 'Blanchimont', steps: [s_(80), L(320, 0.3, { line: 0.6, h: -3 }), s_(90, { h: -6 }), L(260, 0.35, { line: 0.7, h: -8 }), s_(80, { h: -9 })] },
    { id: 'bus-stop', name: 'Bus Stop', steps: [s_(60), R(22, 0.9), s_(3), L(20, 1.3, { apex: 0.6 }), s_(40)] },
    // ---- Nürburgring Nordschleife
    { id: 'flugplatz', name: 'Flugplatz', steps: [s_(120, { h: 7 }), s_(30, { h: 7.5 }), s_(60, { h: 1 }), R(240, 0.3, { line: 0.6, h: -4 }), s_(80, { h: -8 })] },
    { id: 'fuchsrohre', name: 'Fuchsröhre', // flat-out plunge, compression, climb into the left
      steps: [s_(120, { h: -10 }), L(420, 0.2, { line: 0.5, h: -16 }), s_(30), R(380, 0.22, { line: 0.5, h: -24 }), s_(40, { h: -26 }), s_(120, { h: -14 }), L(140, 0.5, { h: -8 }), s_(60, { h: -6 })] },
    { id: 'adenauer', name: 'Adenauer Forst',
      steps: [s_(90, { h: -4 }), L(140, 0.3, { line: 0.6 }), s_(20, { h: -8 }), R(32, 1.0, { h: -10 }), s_(5), L(38, 1.1, { h: -13 }), s_(60, { h: -14 })] },
    { id: 'bergwerk', name: 'Bergwerk', steps: [s_(80, { h: -3 }), R(38, 1.5, { apex: 0.65, h: -2 }), s_(100, { h: 6 })] },
    { id: 'karussell', name: 'Karussell', steps: [s_(100, { h: -3 }), L(34, 3.5, { apex: 0.55, h: -5 }), s_(80, { h: -2 })] },
    // ---- Laguna Seca
    { id: 'corkscrew', name: 'The Corkscrew', // blind crest at turn-in, ~18 m drop
      steps: [s_(90, { h: 5 }), s_(70, { h: 9.5 }), L(16, 1.2, { h: 6.5 }), s_(5), R(40, 1.3, { h: -5 }), s_(90, { h: -9 })] },
    // ---- Silverstone
    { id: 'maggotts', name: 'Maggotts–Becketts–Chapel',
      steps: [s_(60), L(170, 0.4, { line: 0.6 }), s_(5), R(120, 0.55), s_(3), L(75, 0.75), s_(3), R(50, 0.95, { apex: 0.55 }), s_(10), L(160, 0.45, { apex: 0.4 }), s_(40, { h: 1 })] },
    { id: 'copse', name: 'Copse', steps: [s_(80), R(95, 1.25, { apex: 0.55 }), s_(60)] },
    // ---- Suzuka
    { id: 'suzuka-s', name: 'S Curves–Dunlop', // uphill esses into the long left
      steps: [s_(60), R(80, 0.7, { h: 3 }), s_(5), L(70, 0.95, { h: 6 }), s_(5), R(65, 1.0, { h: 10 }), s_(5), L(75, 0.9, { h: 13 }), s_(20), L(140, 1.3, { apex: 0.7, h: 20 }), s_(40, { h: 22 })] },
    { id: 'degner', name: 'Degner', steps: [s_(60, { h: -1 }), R(75, 0.75, { apex: 0.5, h: -3 }), s_(55, { h: -5 }), R(32, 1.4, { apex: 0.6, h: -6 }), s_(50)] },
    { id: 'spoon', name: 'Spoon', steps: [s_(80, { h: -2 }), L(60, 0.9, { h: -4 }), s_(12), L(55, 1.6, { apex: 0.7, h: -6 }), s_(60, { h: -6 })] },
    { id: '130r', name: '130R–Casio', steps: [s_(60), L(130, 1.15, { apex: 0.5 }), s_(200, { h: -3 }), R(14, 1.1), s_(2), L(18, 1.0), s_(40, { h: -3 })] },
    // ---- Monza
    { id: 'rettifilo', name: 'Variante del Rettifilo', steps: [s_(60), R(12, 1.25), s_(3), L(15, 1.2), s_(50)] },
    { id: 'lesmo', name: 'Lesmo', steps: [s_(80, { h: -1 }), R(55, 1.25, { h: -2 }), s_(140, { h: -4 }), R(45, 1.3, { apex: 0.65, h: -5 }), s_(60)] },
    { id: 'ascari', name: 'Ascari', steps: [s_(80, { h: -1 }), L(85, 0.55), s_(5), R(45, 0.95), s_(5), L(100, 0.7, { apex: 0.45, h: -3 }), s_(60)] },
    { id: 'parabolica', name: 'Parabolica', steps: [s_(60), R(80, 2.9, { shape: 'open', apex: 0.3 }), s_(60)] },
    // ---- Imola
    { id: 'acque-minerali', name: 'Acque Minerali', steps: [s_(60, { h: -4 }), R(45, 1.3, { h: -9 }), s_(40, { h: -8 }), R(55, 0.8, { h: -3 }), s_(60, { h: 1 })] },
    { id: 'rivazza', name: 'Rivazza', steps: [s_(80, { h: -5 }), L(40, 1.5, { h: -10 }), s_(20), L(50, 1.2, { apex: 0.6, h: -12 }), s_(60)] },
    // ---- Le Mans
    { id: 'tertre-rouge', name: 'Tertre Rouge', steps: [s_(60), R(22, 1.4, { apex: 0.5 }), s_(20), R(140, 0.3, { line: 0.6 }), s_(60)] },
    { id: 'indianapolis', name: 'Indianapolis–Arnage', steps: [s_(80), R(300, 0.3, { line: 0.6 }), s_(60), L(40, 1.4, { apex: 0.65 }), s_(280), R(25, 1.6, { apex: 0.6 }), s_(60)] },
    { id: 'porsche', name: 'Porsche Curves',
      steps: [s_(80), R(110, 0.8, { h: 1 }), s_(30), L(70, 1.1, { h: 2 }), s_(20), R(90, 0.75, { h: 3 }), s_(15), L(110, 0.6, { h: 3 }), s_(60, { h: 2 })] },
    // ---- Interlagos
    { id: 'senna-s', name: 'Senna S–Curva do Sol',
      steps: [s_(60, { h: -4 }), L(30, 1.1, { h: -9 }), s_(10, { h: -10 }), R(45, 1.2, { h: -14 }), s_(60, { h: -16 }), L(140, 1.1, { apex: 0.55, h: -18 }), s_(60)] },
    // ---- Brands Hatch
    { id: 'paddock', name: 'Paddock Hill–Druids', // off-camber plunge, then the uphill hairpin
      steps: [s_(80, { h: 1 }), s_(20, { h: 1.5 }), R(75, 1.3, { apex: 0.5, h: -9 }), s_(40, { h: -12 }), s_(60, { h: -6 }), R(18, 3.0, { apex: 0.65, h: -3 }), s_(60, { h: -5 })] },
    // ---- Mount Panorama
    { id: 'dipper', name: 'Skyline–Esses–Dipper',
      steps: [s_(60, { h: 2 }), L(40, 1.1, { h: -2 }), s_(20, { h: -4.5 }), R(50, 0.9, { h: -12 }), s_(10), L(45, 0.95, { h: -18 }), s_(10, { h: -20 }), L(45, 1.2, { h: -27 }), s_(150, { h: -40 }), L(24, 1.7, { apex: 0.6, h: -44 }), s_(60, { h: -46 })] },
    // ---- Circuit of the Americas
    { id: 'cota-t1', name: 'COTA Turn 1 & Esses', // ~30 m climb to a blind hairpin, then the esses downhill
      steps: [s_(150, { h: 12 }), s_(130, { h: 28 }), L(20, 2.5, { apex: 0.65, h: 29 }), s_(80, { h: 26 }), R(110, 0.6, { h: 23 }), s_(5), L(90, 0.7, { h: 21 }), s_(5), R(80, 0.75, { h: 19 }), s_(5), L(100, 0.7, { h: 18 }), s_(50)] },
    // ---- Mugello
    { id: 'arrabbiata', name: 'Arrabbiata', steps: [s_(60, { h: 1 }), R(160, 0.85, { h: 4 }), s_(25, { h: 5 }), R(150, 0.9, { apex: 0.55, h: 7 }), s_(60, { h: 8 })] },
    // ---- Watkins Glen
    { id: 'glen-esses', name: 'The Esses', steps: [s_(60), R(90, 0.6, { h: 4 }), s_(10), L(140, 0.55, { h: 9 }), s_(10), R(160, 0.45, { h: 13 }), s_(60, { h: 15 })] },
    // ---- Sebring / Road America
    { id: 'sunset', name: 'Sunset Bend', steps: [s_(60), R(110, 2.0, { apex: 0.6 }), s_(60)] },
    { id: 'carousel-ra', name: 'Carousel', steps: [s_(60, { h: -2 }), R(110, 2.6, { apex: 0.6, h: -5 }), s_(60, { h: -6 })] },
  ];
  // expected familiar complexes per km of track
  const FAMILIAR_RATE = { off: 0, rare: 0.06, often: 0.4, silly: 2.5 };

  function pickWeighted(weights, rng) {
    let sum = 0;
    for (const k in weights) sum += weights[k];
    let r = rng() * sum;
    for (const k in weights) {
      r -= weights[k];
      if (r <= 0) return k;
    }
    return Object.keys(weights)[0];
  }

  function generate(o) {
    const rng = o.rng || U.rng(U.randomSeed());
    const vmax = o.vmax || 60, aLat = o.aLat || 15, aBrake = o.aBrake || 13, aAccel = o.aAccel || 6;
    const mix = MIXES[o.mix] || MIXES.mixed;
    const segs = [];
    const corners = [];
    const straight = (n) => {
      for (let i = 0; i < n; i++) segs.push(0);
    };

    function corner(type, dir, radius, angle, opt) {
      const T = CORNER_TYPES[type];
      opt = opt || {};
      const shape = opt.shape || T.shape, apexF = opt.apex != null ? opt.apex : T.apex;
      const total = Math.max(4, Math.round((angle * radius) / SEG));
      const nIn = Math.max(2, Math.round(total * rng.range(0.2, 0.35)));
      const nOut = Math.max(2, Math.round(total * rng.range(0.25, 0.4)));
      const nHold = Math.max(1, total - Math.round((nIn + nOut) / 2));
      const k = dir / radius;
      const k0 = shape === 'tighten' ? 0.65 : shape === 'open' ? 1.3 : 1;
      const k1 = shape === 'tighten' ? 1.25 : shape === 'open' ? 0.6 : 1;
      const start = segs.length;
      for (let i = 0; i < nIn; i++) segs.push(k * k0 * U.smooth((i + 0.5) / nIn));
      for (let i = 0; i < nHold; i++) segs.push(k * U.lerp(k0, k1, nHold > 1 ? i / (nHold - 1) : 0.5));
      for (let i = 0; i < nOut; i++) segs.push(k * k1 * (1 - U.smooth((i + 0.5) / nOut)));
      const apexSeg = start + nIn + Math.min(nHold - 1, Math.floor(nHold * apexF));
      corners.push({
        index: corners.length, type, dir, radius, angle, line: opt.line != null ? opt.line : 1,
        startPos: start * SEG, // turn-in
        apexPos: (apexSeg + 0.5) * SEG,
        endPos: segs.length * SEG, // track-out
      });
    }
    const simple = (type, dir) => {
      const T = CORNER_TYPES[type];
      corner(type, dir, rng.range(T.r[0], T.r[1]), rng.range(T.a[0], T.a[1]));
    };

    straight(o.leadIn != null ? o.leadIn : 50);
    const minSegs = Math.ceil((o.minLength || 6000) / SEG);
    let lastDir = 1;
    // familiar complexes: own RNG (seeded from the main one only when enabled) so tracks
    // with them off stay identical to before for a given seed
    const iRate = FAMILIAR_RATE[o.familiar] || (typeof o.familiar === 'number' ? o.familiar : 0);
    const irng = iRate > 0 ? U.rng(Math.floor(rng() * 4294967296)) : null;
    const iGap = () => (-Math.log(1 - irng() * 0.999) / iRate) * 1000; // exponential spacing, m
    let nextFamiliar = irng ? segs.length * SEG + 300 + iGap() : Infinity;
    let lastFamiliar = null;
    const familiars = [];
    while (segs.length < minSegs) {
      // slight bias to alternate direction, like real circuits
      const dir = rng() < 0.6 ? -lastDir : lastDir;
      let kind = pickWeighted(mix, rng);
      const firstOfFeature = corners.length;
      if (segs.length * SEG >= nextFamiliar && corners.length) {
        kind = 'familiar';
        const pool = FAMILIAR.filter((x) => x !== lastFamiliar);
        const C = pool[Math.floor(irng() * pool.length)];
        lastFamiliar = C;
        const s0 = segs.length;
        const hk = [[s0, 0]]; // height keypoints [segment index, m]
        for (const st of C.steps) {
          const opt = (st[0] === 's' ? st[2] : st[4]) || {};
          if (st[0] === 's') straight(Math.max(1, Math.round(st[1] / SEG)));
          else {
            const r = st[2], a = st[3];
            corner(r < 25 && a > 2.4 ? 'hairpin' : r < 60 ? 'tight' : r < 120 ? 'medium' : 'sweeper', st[1], r, a, opt);
          }
          if (opt.h != null) hk.push([segs.length, opt.h]);
        }
        for (let i = firstOfFeature; i < corners.length; i++) corners[i].familiar = C.name;
        familiars.push({ id: C.id, name: C.name, startPos: s0 * SEG, endPos: segs.length * SEG, s0, s1: segs.length, hk });
        nextFamiliar = segs.length * SEG + iGap();
      } else if (kind === 'chicane') {
        // quick left-right (or right-left); sometimes a third flick
        corner('tight', dir, rng.range(20, 45), rng.range(0.5, 0.95));
        straight(rng.int(0, 2));
        corner('tight', -dir, rng.range(20, 45), rng.range(0.5, 0.95));
        if (rng() < 0.25) {
          straight(rng.int(0, 2));
          corner('tight', dir, rng.range(25, 50), rng.range(0.4, 0.8));
        }
      } else if (kind === 'esses') {
        const n = rng.int(3, 4);
        for (let i = 0; i < n; i++) {
          if (i) straight(rng.int(1, 4));
          corner('medium', i % 2 ? -dir : dir, rng.range(45, 110), rng.range(0.4, 0.9));
        }
      } else if (kind === 'double') {
        // double apex: same direction twice with a short release between
        corner('tight', dir, rng.range(30, 60), rng.range(0.7, 1.2));
        straight(rng.int(3, 8));
        corner('tight', dir, rng.range(25, 55), rng.range(0.7, 1.3));
      } else {
        simple(kind, dir);
      }
      // category used for stats: the compound feature if any, else the corner type
      for (let i = firstOfFeature; i < corners.length; i++) corners[i].cat = kind;
      lastDir = corners[corners.length - 1].dir;
      straight(rng.int(o.minStraight || 24, o.maxStraight || 90));
    }
    straight(o.tail || 260);

    const n = segs.length;

    // elevation: smooth ramps plus occasional crests / compressions
    const hgt = new Float32Array(n + 1);
    const E = ELEVATION[o.elevation || 'flat'];
    if (E) {
      let i = Math.min(n, 20), cur = 0;
      while (i < n) {
        const L = Math.min(n - i, rng.int(16, 80));
        if (rng() < 0.28 && L >= 16) {
          const maxA = Math.min(E.bump, (1.6 * E.grade * L * SEG) / Math.PI);
          const A = (rng() < 0.6 ? 1 : -1) * rng.range(0.4, 1) * maxA; // + crest, - compression
          for (let k = 0; k < L; k++) hgt[i + k] = cur + A * Math.sin((Math.PI * k) / L);
        } else {
          let dh = rng.range(-1, 1) * Math.min(E.span, E.grade * L * SEG);
          if (Math.abs(cur + dh) > E.span * 1.5) dh = -dh;
          for (let k = 0; k < L; k++) hgt[i + k] = cur + dh * U.smooth(k / L);
          cur += dh;
        }
        i += L;
      }
      hgt[n] = cur;
    }
    // familiar complexes bring their own hill; everything after shifts to stay continuous
    for (const ic of familiars) {
      const base = hgt[ic.s0], e = Math.min(n, ic.s1);
      // monotone cubic (Fritsch-Carlson) through the keypoints: smooth grade changes,
      // no overshoot past a crest or the bottom of a compression; entry slope matches
      // the terrain before the complex
      const P = ic.hk.filter((q, i, a) => !i || q[0] > a[i - 1][0]);
      if (P[P.length - 1][0] < e) P.push([e, P[P.length - 1][1]]);
      const m = P.length, d = [], t = new Array(m);
      for (let i = 0; i < m - 1; i++) d.push((P[i + 1][1] - P[i][1]) / (P[i + 1][0] - P[i][0]));
      t[0] = ic.s0 > 0 ? hgt[ic.s0] - hgt[ic.s0 - 1] : 0;
      if (m > 1 && d[0] * t[0] <= 0) t[0] = 0;
      else if (m > 1) t[0] = Math.min(Math.abs(t[0]), 3 * Math.abs(d[0])) * Math.sign(d[0]);
      for (let i = 1; i < m - 1; i++) t[i] = d[i - 1] * d[i] <= 0 ? 0 : (2 * d[i - 1] * d[i]) / (d[i - 1] + d[i]);
      t[m - 1] = 0;
      let seg = 0;
      const old = hgt[e];
      for (let k = ic.s0; k <= e; k++) {
        while (seg < m - 2 && k > P[seg + 1][0]) seg++;
        const x0 = P[seg][0], x1 = P[Math.min(m - 1, seg + 1)][0], hw = Math.max(1, x1 - x0);
        const u = U.clamp((k - x0) / hw, 0, 1), u2 = u * u, u3 = u2 * u;
        const y0 = P[seg][1], y1 = P[Math.min(m - 1, seg + 1)][1];
        hgt[k] = base + (2 * u3 - 3 * u2 + 1) * y0 + (u3 - 2 * u2 + u) * hw * t[seg] + (-2 * u3 + 3 * u2) * y1 + (u3 - u2) * hw * t[Math.min(m - 1, seg + 1)];
      }
      const delta = hgt[e] - old;
      for (let k = e + 1; k <= n; k++) hgt[k] += delta;
      delete ic.s0;
      delete ic.s1;
      delete ic.hk;
    }
    const slope = (i) => (hgt[Math.min(n, i + 1)] - hgt[i]) / SEG;

    /*
     * Racing line keypoints (lateral, half-widths, +right): outside -> apex -> outside.
     * Where corners are linked (the exit of one runs into the entry of the next) the
     * intermediate outside points are dropped: a flick goes apex to apex directly, a
     * double apex drifts only part way out between them. That keeps the line (and the
     * camera on it) smooth through chicanes and esses instead of zig-zagging.
     */
    const kp = [];
    corners.forEach((c, i) => {
      const m = c.line;
      c._in = [c.startPos - 10, -c.dir * 0.72 * m];
      c._ex = [c.endPos + 15, -c.dir * 0.7 * m];
      c._linked = 0;
      if (i) {
        const p = corners[i - 1];
        if (p._ex && p._ex[0] > c._in[0] - 15) {
          p._linked++;
          c._linked++;
          if (p.dir === c.dir && c.apexPos - p.apexPos > 50) {
            kp.push([(p.apexPos + c.apexPos) / 2, -c.dir * 0.3 * Math.min(m, p.line)]);
          }
          p._ex = null;
          c._in = null;
        }
      }
    });
    corners.forEach((c) => {
      if (c._in) kp.push(c._in);
      kp.push([c.apexPos, c.dir * 0.82 * c.line, 1]);
      if (c._ex) kp.push(c._ex);
      delete c._in;
      delete c._ex;
    });
    kp.sort((a, b) => a[0] - b[0]);
    // keep keypoints at least 10 m apart (an apex wins over an outside point)
    for (let i = 1; i < kp.length; ) {
      if (kp[i][0] - kp[i - 1][0] < 10) kp.splice(kp[i][2] && !kp[i - 1][2] ? i - 1 : i, 1);
      else i++;
    }

    /*
     * Speed profile at segment boundaries (m/s). Lateral grip limits speed on the radius
     * the LINE takes, not the centreline: using the width (outside-apex-outside) opens a
     * corner of radius r and turn angle a to about r + w / (1 - cos(a/2)), which is why
     * kinks are flat and hairpins barely change. Linked corners share the width. Aero
     * (o.aero) adds grip with speed: aLat * (1 + aero * v^2 / VREF^2).
     */
    const VREF = 70, aero = o.aero || 0;
    const kLine = new Float32Array(n).fill(1);
    corners.forEach((c) => {
      const w = 9 * c.line * (1 - 0.3 * Math.min(2, c._linked));
      const f = c.radius / (c.radius + w / Math.max(0.02, 1 - Math.cos(Math.min(Math.PI, c.angle) / 2)));
      for (let i = Math.floor(c.startPos / SEG); i < Math.min(n, c.endPos / SEG); i++) kLine[i] = f;
      delete c._linked;
    });
    const v = new Float32Array(n + 1);
    for (let i = 0; i < n; i++) {
      const c = Math.abs(segs[i]) * kLine[i];
      const den = c - (aLat * aero) / (VREF * VREF);
      v[i] = c > 1e-6 && den > 0 ? Math.min(vmax, Math.sqrt(aLat / den)) : vmax;
    }
    v[n] = vmax;
    // gravity: uphill helps braking and hurts acceleration, downhill the reverse
    for (let i = n - 1; i >= 0; i--) {
      const ab = Math.max(2, aBrake + 9.81 * slope(i));
      v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * ab * SEG));
    }
    v[0] = Math.min(v[0], o.vStart != null ? o.vStart : vmax * 0.6);
    for (let i = 1; i <= n; i++) {
      const aa = Math.max(0.4, aAccel - 9.81 * slope(i - 1));
      v[i] = Math.min(v[i], Math.sqrt(v[i - 1] * v[i - 1] + 2 * aa * SEG));
    }

    const tCum = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) tCum[i + 1] = tCum[i] + SEG / Math.max(1, 0.5 * (v[i] + v[i + 1]));

    // racing line from the keypoints above
    const lat = new Float32Array(n + 1);
    let ki = 0;
    for (let i = 0; i <= n; i++) {
      const p = i * SEG;
      while (ki < kp.length - 1 && kp[ki + 1][0] <= p) ki++;
      if (!kp.length) lat[i] = 0;
      else if (p <= kp[0][0]) lat[i] = kp[0][1];
      else if (ki >= kp.length - 1) lat[i] = kp[kp.length - 1][1];
      else {
        const p0 = kp[ki][0], v0 = kp[ki][1], p1 = kp[ki + 1][0], v1 = kp[ki + 1][1];
        lat[i] = U.lerp(v0, v1, U.smooth(U.clamp((p - p0) / Math.max(1, p1 - p0), 0, 1)));
      }
    }

    // braking-distance boards (3-2-1) before each corner, on the outside
    const boards = [];
    corners.forEach((c, i) => {
      const prevEnd = i ? corners[i - 1].endPos : 0;
      [3, 2, 1].forEach((num) => {
        const p = c.startPos - num * 50 - 30;
        if (p > prevEnd + 25) boards.push({ pos: p, x: -c.dir * (HALF_W + 2.2), num });
      });
    });
    boards.sort((a, b) => a.pos - b.pos);

    // marshal posts, alternating sides
    const marshals = [];
    for (let p = 150, s = 1; p < n * SEG; p += rng.range(120, 220), s = -s) marshals.push({ pos: p, side: s });

    const interp = (arr, pos) => {
      const f = U.clamp(pos / SEG, 0, n);
      const i = Math.min(n - 1, Math.floor(f));
      return arr[i] + (arr[i + 1] - arr[i]) * (f - i);
    };

    return {
      SEG, HALF_W, segs, corners, boards, marshals, v, tCum, lat, hgt, familiars,
      length: n * SEG,
      lastCornerEnd: corners.length ? corners[corners.length - 1].endPos : 0,
      speedAt: (pos) => interp(v, pos),
      heightAt: (pos) => interp(hgt, pos),
      slopeAt: (pos) => slope(U.clamp(Math.floor(pos / SEG), 0, n - 1)),
      timeAt: (pos) => interp(tCum, pos),
      lateralAt: (pos) => interp(lat, pos),
      /** car heading relative to the track (rad, + = right) from the line's lateral drift */
      lineYawAt: (pos) => Math.atan(((interp(lat, pos + 4) - interp(lat, Math.max(0, pos - 4))) * HALF_W) / 8),
      curvatureAt: (pos) => segs[U.clamp(Math.floor(pos / SEG), 0, n - 1)],
      /** inverse of timeAt: where the car is T seconds into the lap */
      posAtTime(T) {
        if (T <= 0) return 0;
        if (T >= tCum[n]) return n * SEG;
        let lo = 0, hi = n;
        while (hi - lo > 1) {
          const m = (lo + hi) >> 1;
          if (tCum[m] <= T) lo = m;
          else hi = m;
        }
        return (lo + (T - tCum[lo]) / Math.max(1e-6, tCum[lo + 1] - tCum[lo])) * SEG;
      },
      /** index of the first corner whose apex is still ahead of pos, or -1 */
      nextCornerIndex(pos) {
        let lo = 0, hi = corners.length;
        while (lo < hi) {
          const m = (lo + hi) >> 1;
          if (corners[m].apexPos > pos) hi = m;
          else lo = m + 1;
        }
        return lo < corners.length ? lo : -1;
      },
    };
  }

  // ----------------------------------------------------------------- themes
  const THEMES = {
    realistic: {
      skyTop: [64, 116, 182], skyBottom: [172, 202, 228],
      hillFar: [118, 146, 164], hillNear: [78, 112, 86],
      grass: [[78, 135, 62], [70, 124, 56]],
      road: [[92, 94, 100], [88, 90, 96]],
      kerb: [[205, 40, 40], [238, 238, 238]],
      line: [240, 240, 240],
      fog: [182, 202, 220], fogAmt: 0.85,
      boardBg: '#101215', boardFg: '#f4f4f4', boardBorder: '#f4f4f4', post: '#d5d7db',
      distBg: '#f2f2f2', distFg: '#15171b',
    },
    minimal: {
      skyTop: [7, 8, 11], skyBottom: [15, 17, 23],
      hillFar: null, hillNear: null,
      grass: [[13, 14, 18], [16, 17, 22]],
      road: [[38, 40, 48], [35, 37, 45]],
      kerb: [[125, 125, 140], [72, 72, 84]],
      line: [205, 210, 222],
      fog: [11, 12, 16], fogAmt: 0.9,
      boardBg: '#000000', boardFg: '#ffffff', boardBorder: '#66ccff', post: '#4b5a6a',
      distBg: '#2a2f38', distFg: '#7b8494',
    },
  };

  const fogCurve = (f) => Math.pow(U.clamp((f - 0.22) / 0.78, 0, 1), 1.5);

  function quad(g, x1, y1, x2, y2, x3, y3, x4, y4) {
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.lineTo(x3, y3);
    g.lineTo(x4, y4);
    g.closePath();
    g.fill();
  }

  function drawDistBoard(g, pr, th, num) {
    const s = pr.s, w = 1.4 * s, h = 1.1 * s;
    if (w < 1.5) return;
    const top = pr.y - 2.3 * s;
    g.globalAlpha = 1 - pr.fog * 0.7;
    g.fillStyle = th.post;
    g.fillRect(pr.x - 0.05 * s, top, Math.max(1, 0.1 * s), 2.3 * s);
    g.fillStyle = th.distBg;
    g.fillRect(pr.x - w / 2, top, w, h);
    g.fillStyle = th.distFg;
    for (let i = 0; i < num; i++) g.fillRect(pr.x - w / 2 + w * (0.14 + i * 0.27), top + h * 0.15, w * 0.13, h * 0.7);
    g.globalAlpha = 1;
  }

  // --------------------------------------------------------------- renderer
  function Renderer(track, o) {
    o = o || {};
    this.track = track;
    this.theme = THEMES[o.theme] || THEMES.realistic;
    this.fov = o.fov || 70; // horizontal, degrees
    this.drawDist = o.drawDist || 170; // segments (850 m)
    this.camH = o.camH || 1.15; // eye height, m
    this.horizonFrac = o.horizon || 0.42;
    this.showDecor = o.decor !== false; // braking boards etc.
    const N = this.drawDist + 2;
    this.xs = new Float64Array(N);
    this.dzs = new Float64Array(N);
    this.sx = new Float64Array(N);
    this.sy = new Float64Array(N);
    this.sw = new Float64Array(N);
    this.ys = new Float64Array(N); // road height at each boundary (m)
    this.clip = new Float64Array(N); // highest screen y of road nearer than boundary j (crest occlusion)
    this.ready = false;
  }
  Renderer.THEMES = THEMES;

  /** Project the visible track for camera cam = {pos, x (lateral m), heading (rad), yaw (rad, car vs track, + = right)}. */
  Renderer.prototype.prepare = function (W, H, cam) {
    const t = this.track, N = this.drawDist;
    this.W = W;
    this.H = H;
    this.cam = cam;
    this.proj = W / 2 / Math.tan((this.fov * Math.PI) / 360);
    // small yaw of the car relative to the track = a sideways shift of the whole image
    this.yawShift = -this.proj * Math.tan(cam.yaw || 0);
    // camera follows the terrain and pitches with the local gradient (smoothed)
    const pitch = (t.heightAt(cam.pos + 10) - t.heightAt(Math.max(0, cam.pos - 5))) / 15;
    // pitch may move the horizon 24 % up / 30 % down from its set place
    const hf = this.horizonFrac;
    this.horizonY = Math.round(U.clamp(H * hf + pitch * this.proj * 0.9, H * Math.max(0.04, hf - 0.24), H * Math.min(0.96, hf + 0.3)));
    this.camY = t.heightAt(cam.pos) + this.camH;
    const baseIdx = Math.floor(cam.pos / SEG);
    const frac = cam.pos / SEG - baseIdx;
    this.baseIdx = baseIdx;
    let x = 0, slope = 0;
    this.xs[0] = 0;
    this.dzs[0] = 0.8;
    for (let j = 1; j <= N; j++) {
      const L = j === 1 ? (1 - frac) * SEG : SEG;
      const k = t.segs[baseIdx + j - 1] || 0;
      x += slope * L + 0.5 * k * L * L;
      slope += k * L;
      this.xs[j] = x;
      this.dzs[j] = Math.max(0.8, (j - frac) * SEG);
    }
    let minY = Infinity;
    for (let j = 0; j <= N; j++) {
      const s = this.proj / this.dzs[j];
      this.ys[j] = j === 0 ? t.heightAt(cam.pos) : t.heightAt((baseIdx + j) * SEG);
      this.sx[j] = W / 2 + (this.xs[j] - cam.x) * s + this.yawShift;
      this.sy[j] = this.horizonY + (this.camY - this.ys[j]) * s;
      this.sw[j] = HALF_W * s;
      if (j > 0) minY = Math.min(minY, this.sy[j]);
      this.clip[j] = minY;
    }
    this.ready = true;
  };

  /** Screen position of a world point (along-track pos, lateral m, height m) for the prepared frame. */
  Renderer.prototype.project = function (pos, xOff, h) {
    if (!this.ready) return null;
    const dz = pos - this.cam.pos;
    if (dz < 1.5 || dz > this.drawDist * SEG) return null;
    const jf = pos / SEG - this.baseIdx;
    const j0 = Math.floor(jf);
    if (j0 < 0 || j0 >= this.drawDist) return null;
    const xc = this.xs[j0] + (this.xs[j0 + 1] - this.xs[j0]) * (jf - j0);
    const s = this.proj / dz;
    const ground = this.track.heightAt(pos);
    return {
      x: this.W / 2 + (xc + xOff - this.cam.x) * s + this.yawShift,
      y: this.horizonY + (this.camY - ground - (h || 0)) * s,
      s, dz,
      clip: j0 > 0 ? this.clip[j0] : Infinity, // anything below this screen y is hidden by a nearer crest
    };
  };

  Renderer.prototype.hills = function (g, color, amp, f1, f2, phase) {
    const W = this.W, H = this.H, hz = this.horizonY, proj = this.proj, hd = (this.cam.heading || 0) + (this.cam.yaw || 0);
    g.beginPath();
    g.moveTo(0, hz + 1);
    for (let x = 0; x <= W + 10; x += 10) {
      const a = (x - W / 2) / proj + hd;
      const y = hz - H * amp * (0.35 + 0.4 * (0.5 + 0.5 * Math.sin(a * f1 + phase)) + 0.25 * (0.5 + 0.5 * Math.sin(a * f2 + phase * 2.3)));
      g.lineTo(x, y);
    }
    g.lineTo(W + 10, hz + 1);
    g.closePath();
    g.fillStyle = U.rgb(color);
    g.fill();
  };

  Renderer.prototype.decor = function () {
    const out = [], b = this.track.boards, th = this.theme;
    const from = this.cam.pos + 2, to = this.cam.pos + this.drawDist * SEG;
    for (let i = lowerBound(b, from); i < b.length && b[i].pos < to; i++) {
      const d = b[i];
      out.push({ pos: d.pos, x: d.x, draw: (g, pr) => drawDistBoard(g, pr, th, d.num) });
    }
    return out;
  };

  /** sprites: [{pos, x, draw(g, pr, renderer)}]; pr = {x, y (ground), s (px per m), dz, fog} */
  Renderer.prototype.draw = function (g, sprites) {
    if (!this.ready) return;
    const th = this.theme, W = this.W, H = this.H, hz = this.horizonY, N = this.drawDist, t = this.track;
    const rgb = U.rgb;

    const sky = g.createLinearGradient(0, 0, 0, hz);
    sky.addColorStop(0, rgb(th.skyTop));
    sky.addColorStop(1, rgb(th.skyBottom));
    g.fillStyle = sky;
    g.fillRect(0, 0, W, hz + 1);
    if (th.hillFar) {
      this.hills(g, U.mix(th.hillFar, th.fog, 0.45), 0.07, 5, 11, 0.3);
      this.hills(g, U.mix(th.hillNear, th.fog, 0.25), 0.04, 9, 17, 2.1);
    }
    g.fillStyle = rgb(U.mix(th.grass[0], th.fog, th.fogAmt));
    g.fillRect(0, hz, W, H - hz);

    const sx = this.sx, sy = this.sy, sw = this.sw;
    for (let j = N - 1; j >= 0; j--) {
      const idx = this.baseIdx + j;
      if (idx >= t.segs.length) continue;
      const y1 = sy[j], y2 = sy[j + 1]; // near, far
      if (y2 >= y1 || y2 > H) continue; // back side of a crest, or below the screen
      if (j > 0 && y2 >= this.clip[j]) continue; // fully hidden behind a nearer crest
      const fT = th.fogAmt * fogCurve(j / N);
      const col = (c) => rgb(fT > 0.002 ? U.mix(c, th.fog, fT) : c);

      g.fillStyle = col(th.grass[Math.floor(idx / 3) % 2]);
      g.fillRect(0, y2, W, Math.min(H, y1) - y2 + 1);

      const x1 = sx[j], x2 = sx[j + 1], w1 = sw[j], w2 = sw[j + 1];
      const curved = t.segs[idx] !== 0;
      if (curved) {
        g.fillStyle = col(th.kerb[idx % 2]);
        quad(g, x1 - w1 * 1.14, y1, x1 - w1, y1, x2 - w2, y2, x2 - w2 * 1.14, y2);
        quad(g, x1 + w1, y1, x1 + w1 * 1.14, y1, x2 + w2 * 1.14, y2, x2 + w2, y2);
      }
      g.fillStyle = col(th.road[Math.floor(idx / 2) % 2]);
      quad(g, x1 - w1, y1, x1 + w1, y1, x2 + w2, y2, x2 - w2, y2);
      if (!curved) {
        g.fillStyle = col(th.line);
        quad(g, x1 - w1, y1, x1 - w1 * 0.965, y1, x2 - w2 * 0.965, y2, x2 - w2, y2);
        quad(g, x1 + w1 * 0.965, y1, x1 + w1, y1, x2 + w2, y2, x2 + w2 * 0.965, y2);
      }
    }

    const list = (this.showDecor ? this.decor() : []).concat(sprites || []);
    list.sort((a, b) => b.pos - a.pos);
    const maxDz = N * SEG;
    for (const sp of list) {
      const pr = this.project(sp.pos, sp.x, 0);
      if (!pr) continue;
      pr.fog = th.fogAmt * fogCurve(pr.dz / maxDz);
      if (pr.clip < H) {
        // hide the part of the sprite that is behind a nearer crest
        g.save();
        g.beginPath();
        g.rect(0, 0, W, pr.clip);
        g.clip();
        sp.draw(g, pr, this);
        g.restore();
      } else sp.draw(g, pr, this);
    }
  };


  Renderer.prototype.render = function (g, W, H, cam, sprites) {
    this.prepare(W, H, cam);
    this.draw(g, sprites);
  };

  IST.Track = { generate, SEG, HALF_W, CORNER_TYPES, MIXES, ELEVATION, FAMILIAR, FAMILIAR_RATE };
  IST.TrackRenderer = Renderer;
})();
