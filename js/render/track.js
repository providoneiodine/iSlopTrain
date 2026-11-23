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

    function corner(type, dir, radius, angle) {
      const T = CORNER_TYPES[type];
      const total = Math.max(4, Math.round((angle * radius) / SEG));
      const nIn = Math.max(2, Math.round(total * rng.range(0.2, 0.35)));
      const nOut = Math.max(2, Math.round(total * rng.range(0.25, 0.4)));
      const nHold = Math.max(1, total - Math.round((nIn + nOut) / 2));
      const k = dir / radius;
      const k0 = T.shape === 'tighten' ? 0.65 : T.shape === 'open' ? 1.3 : 1;
      const k1 = T.shape === 'tighten' ? 1.25 : T.shape === 'open' ? 0.6 : 1;
      const start = segs.length;
      for (let i = 0; i < nIn; i++) segs.push(k * k0 * U.smooth((i + 0.5) / nIn));
      for (let i = 0; i < nHold; i++) segs.push(k * U.lerp(k0, k1, nHold > 1 ? i / (nHold - 1) : 0.5));
      for (let i = 0; i < nOut; i++) segs.push(k * k1 * (1 - U.smooth((i + 0.5) / nOut)));
      const apexSeg = start + nIn + Math.min(nHold - 1, Math.floor(nHold * T.apex));
      corners.push({
        index: corners.length, type, dir, radius, angle,
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
    while (segs.length < minSegs) {
      // slight bias to alternate direction, like real circuits
      const dir = rng() < 0.6 ? -lastDir : lastDir;
      const kind = pickWeighted(mix, rng);
      const firstOfFeature = corners.length;
      if (kind === 'chicane') {
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
    const slope = (i) => (hgt[Math.min(n, i + 1)] - hgt[i]) / SEG;

    // speed profile at segment boundaries (m/s)
    const v = new Float32Array(n + 1);
    for (let i = 0; i < n; i++) {
      const c = Math.abs(segs[i]);
      v[i] = c > 1e-6 ? Math.min(vmax, Math.sqrt(aLat / c)) : vmax;
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

    // racing line (lateral position in half-widths, +right): outside -> apex -> outside
    const kp = [];
    corners.forEach((c) => {
      kp.push([c.startPos - 10, -c.dir * 0.72], [c.apexPos, c.dir * 0.82], [c.endPos + 15, -c.dir * 0.7]);
    });
    kp.sort((a, b) => a[0] - b[0]);
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
      SEG, HALF_W, segs, corners, boards, marshals, v, tCum, lat, hgt,
      length: n * SEG,
      lastCornerEnd: corners.length ? corners[corners.length - 1].endPos : 0,
      speedAt: (pos) => interp(v, pos),
      heightAt: (pos) => interp(hgt, pos),
      slopeAt: (pos) => slope(U.clamp(Math.floor(pos / SEG), 0, n - 1)),
      timeAt: (pos) => interp(tCum, pos),
      lateralAt: (pos) => interp(lat, pos),
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
    this.horizonY = Math.round(U.clamp(H * this.horizonFrac + pitch * this.proj * 0.9, H * 0.18, H * 0.72));
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

  IST.Track = { generate, SEG, HALF_W, CORNER_TYPES, MIXES, ELEVATION };
  IST.TrackRenderer = Renderer;
})();
