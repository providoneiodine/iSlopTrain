/*
 * Vector GT3 cockpit overlay (LHD, 911-style), drawn over the track renderer.
 *
 * Geometry lives in view-angle space: (u, v) = (tan of the horizontal angle, tan of
 * the vertical angle) from the eye, measured from the renderer's principal point
 * (screen centre x, unpitched horizon y). Screen = centre + (u, v) * proj, so a
 * change of FOV is an exact zoom, as it is in a real camera, and the cockpit stays
 * locked to the car while the renderer pitches / yaws the world behind it.
 *
 * Eye ~1.05 m, driver seated ~0.38 m left of the car's centreline. From there the
 * near (left) A-pillar sits ~20-28 deg left, the right one ~45 deg right (only on
 * wide FOVs), the rear-view camera screen up and to the right, the left wing peak
 * just inside the windscreen.
 *
 *   const C = new Cockpit({ body: 'pearl' });
 *   C.frameFor(R, seat);          // after Renderer.prepare (seat: eye offset, m)
 *   C.draw(g, wheelDeg, info);    // info: { gear, kmh, rpm (0..1), delta? }
 *   C.coverage(x0, y0, x1, y1)    // 0..1 share of that screen rect hidden (after draw)
 *   C.hidden(rect, wheelDeg)      // same, for a predicted wheel angle (cheap away from the wheel)
 *   Cockpit.steerAt(track, pos)   // wheel angle (deg) on the racing line
 *   Cockpit.dash(v)               // { gear, kmh, rpm } for a speed in m/s
 */
(function () {
  'use strict';
  const U = IST.util;

  const BODY = {
    pearl: [222, 226, 231],
    red: [172, 20, 28],
    blue: [92, 152, 200],
    graphite: [70, 75, 84],
    lime: [178, 214, 60],
  };
  const MS = 8; // occlusion mask: 1 cell = 8x8 px

  // ---------------------------------------------------------------- patterns
  function carbon() {
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    const g = c.getContext('2d');
    g.fillStyle = '#16181c';
    g.fillRect(0, 0, 8, 8);
    // 2x2 twill: alternating diagonal tows
    for (let y = 0; y < 8; y += 2) {
      for (let x = 0; x < 8; x += 2) {
        const on = ((x + y) >> 1) % 2 === 0;
        g.fillStyle = on ? '#202328' : '#111316';
        g.fillRect(x, y, 2, 2);
        g.fillStyle = on ? 'rgba(255,255,255,.035)' : 'rgba(0,0,0,.2)';
        g.fillRect(x, y, 2, 1);
      }
    }
    return c;
  }
  function suede() {
    const c = document.createElement('canvas');
    c.width = c.height = 96;
    const g = c.getContext('2d');
    const d = g.createImageData(96, 96);
    for (let i = 0; i < d.data.length; i += 4) {
      const n = Math.random() * 22;
      d.data[i] = d.data[i + 1] = d.data[i + 2] = n;
      d.data[i + 3] = 28;
    }
    g.putImageData(d, 0, 0);
    return c;
  }

  // ------------------------------------------------------------------ helpers
  /** Smooth curve (Catmull-Rom as cubic Beziers) through screen points. */
  function spline(g, pts, move) {
    if (move) g.moveTo(pts[0][0], pts[0][1]);
    else g.lineTo(pts[0][0], pts[0][1]);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      g.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
    }
  }
  function rr(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function Cockpit(o) {
    o = o || {};
    this.body = o.body || 'pearl';
    this.wheel = o.wheel !== false;
    this.night = !!o.night; // minimal theme: dim the paint and interior highlights
    this.pat = null;
    this.mask = document.createElement('canvas');
    this.mg = this.mask.getContext('2d', { willReadFrequently: true });
    this.static = document.createElement('canvas'); // static mask, cached per layout
    this.key = '';
    this.cells = null;
  }

  /**
   * W, H: canvas; proj: px per unit tan (renderer focal length); cy: unpitched horizon y.
   * seat: eye offset from the reference position in metres {x: right, y: up, z: forward}.
   */
  Cockpit.prototype.frame = function (W, H, proj, cy, seat) {
    this.W = W;
    this.H = H;
    this.f = proj;
    this.cx = W / 2;
    this.cy = cy;
    this.seat = seat || { x: 0, y: 0, z: 0 };
  };
  /**
   * Screen point of a cockpit point seen at (u, v) from the reference eye, d metres
   * ahead. Moving the eye re-projects it, so near parts (wheel, pillar) shift more
   * than far ones (bonnet): real parallax from the seat settings.
   */
  /** Frame from a prepared renderer: cockpit locked to the unpitched horizon. */
  Cockpit.prototype.frameFor = function (R, seat) {
    this.frame(R.W, R.H, R.proj, Math.round(R.H * R.horizonFrac), seat);
  };
  Cockpit.prototype.P = function (u, v, d) {
    d = d || this.d;
    const s = this.seat, k = d / Math.max(0.12, d - s.z);
    return [this.cx + (u - s.x / d) * k * this.f, this.cy + (v + s.y / d) * k * this.f];
  };
  Cockpit.prototype.Ps = function (arr) {
    return arr.map((q) => this.P(q[0], q[1], q[2]));
  };
  /** Screen scale (px per unit) at depth d. */
  Cockpit.prototype.S = function (d) {
    d = d || this.d;
    return (this.f * d) / Math.max(0.12, d - this.seat.z);
  };

  // --------------------------------------------------------------- geometry
  /*
   * Reference framing: 16:9, 54 deg horizontal, horizon ~37 % down (lens shift), the
   * way most sim drivers on a single screen sit: wheel rim level with the dash top,
   * the windscreen base just below the horizon, the roof bar across the top and the
   * near A-pillar + cage tube taking the left fifth of the screen. Points are
   * [u, v] or [u, v, depth m]; each group has a default depth.
   */
  const G = {
    body: { d: 2.0, top: [[-0.31, 0.6], [-0.31, 0.1], [-0.27, 0.078], [-0.18, 0.068], [-0.08, 0.075], [0.12, 0.088], [0.36, 0.079], [0.5, 0.068], [0.6, 0.074], [0.67, 0.095], [0.72, 0.6]] },
    lower: {
      d: 0.9,
      doorL: [[-1.2, 0.7], [-0.7, 0.3], [-0.45, 0.15], [-0.3, 0.095]],
      dash: [[-0.3, 0.095], [-0.1, 0.087], [0.2, 0.085], [0.5, 0.087], [0.78, 0.095]],
      doorR: [[0.78, 0.095], [1.05, 0.26], [1.7, 0.7]],
    },
    pillarL: { d: 0.65, out: [[-0.5, 0.11, 0.9], [-0.53, 0.0, 0.8], [-0.6, -0.13, 0.6], [-0.72, -0.26, 0.45]], in: [[-0.3, 0.095, 0.9], [-0.308, 0.0, 0.8], [-0.33, -0.12, 0.6], [-0.37, -0.22, 0.45]] },
    cageL: { d: 0.55, pts: [[-0.33, 0.9], [-0.333, 0.25], [-0.342, -0.04], [-0.365, -0.24]] },
    pillarR: { d: 0.9, out: [[0.9, 0.1], [1.0, 0.0], [1.25, -0.16], [1.5, -0.3]], in: [[0.78, 0.095], [0.84, 0.0], [1.0, -0.13], [1.14, -0.22]] },
    cageR: { d: 0.8, pts: [[0.84, 0.6], [0.87, 0.1], [0.98, -0.1], [1.14, -0.25]] },
    header: { d: 0.6, pts: [[-0.7, -0.27], [-0.345, -0.13], [-0.1, -0.152], [0.2, -0.161], [0.6, -0.163], [1.0, -0.15], [1.5, -0.24]] },
    doorBar: { d: 0.4, pts: [[-0.36, 0.3], [-0.62, 0.52], [-1.0, 0.95]] },
    wingMirror: { d: 0.95, box: [-0.76, 0.03, -0.6, 0.1] },
    rearView: { d: 0.6, box: [0.27, -0.153, 0.52, -0.085] },
    vents: { d: 0.75, list: [[-0.235, 0.2, 0.042], [0.31, 0.19, 0.048], [0.47, 0.19, 0.045]] },
    wheel: { d: 0.55, u: 0, v: 0.268, r: 0.265, sy: 0.92 },
  };

  // -------------------------------------------------------------- drawing
  /** Fill style, or solid white in mask mode. */
  Cockpit.prototype.fs = function (g, style) {
    g.fillStyle = this.m ? '#fff' : style;
  };
  Cockpit.prototype.paint = function () {
    const col = BODY[this.body] || BODY.pearl;
    return this.night ? U.mix(col, [20, 24, 32], 0.6) : col;
  };

  Cockpit.prototype.drawBody = function (g) {
    this.d = G.body.d;
    const P = this.P.bind(this), lit = this.paint();
    g.beginPath();
    spline(g, this.Ps(G.body.top), true);
    g.closePath();
    if (this.m) return this.fs(g), g.fill();
    const gr = g.createLinearGradient(0, P(0, 0.064)[1], 0, P(0, 0.11)[1]);
    gr.addColorStop(0, U.rgb(U.mix(lit, [200, 220, 240], 0.3)));
    gr.addColorStop(0.35, U.rgb(lit));
    gr.addColorStop(1, U.rgb(U.mix(lit, [0, 0, 0], 0.5)));
    g.fillStyle = gr;
    g.fill();
    // sky catching the wing crests
    g.save();
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(255,255,255,' + (this.night ? 0.12 : 0.6) + ')';
    g.lineWidth = Math.max(1, this.f * 0.003);
    g.shadowColor = 'rgba(255,255,255,.6)';
    g.shadowBlur = this.f * 0.008;
    for (const crest of [[[-0.27, 0.081], [-0.18, 0.071], [-0.09, 0.078]], [[0.38, 0.082], [0.5, 0.071], [0.62, 0.079]]]) {
      g.beginPath();
      spline(g, this.Ps(crest), true);
      g.stroke();
    }
    g.restore();
  };

  Cockpit.prototype.drawWingMirror = function (g) {
    this.d = G.wingMirror.d;
    const P = this.P.bind(this), lit = this.paint(), b = G.wingMirror.box;
    const [x0, y0] = P(b[0], b[1]), [x1, y1] = P(b[2], b[3]);
    this.fs(g, U.rgb(U.mix(lit, [0, 0, 0], 0.45)));
    g.beginPath();
    g.moveTo(...P(b[2] - 0.03, b[3] - 0.02));
    g.lineTo(...P(b[2] + 0.01, b[3] - 0.025));
    g.lineTo(...P(b[2] + 0.07, b[3] + 0.045));
    g.lineTo(...P(b[2] + 0.02, b[3] + 0.06));
    g.closePath();
    g.fill();
    g.beginPath();
    rr(g, x0, y0, x1 - x0, y1 - y0, (y1 - y0) * 0.42);
    if (this.m) return this.fs(g), g.fill();
    const gr = g.createLinearGradient(0, y0, 0, y1);
    gr.addColorStop(0, U.rgb(U.mix(lit, [0, 0, 0], 0.15)));
    gr.addColorStop(1, U.rgb(U.mix(lit, [0, 0, 0], 0.6)));
    g.fillStyle = gr;
    g.fill();
    const ix = x0 + (x1 - x0) * 0.1, iy = y0 + (y1 - y0) * 0.16, iw = (x1 - x0) * 0.78, ih = (y1 - y0) * 0.68;
    g.save();
    g.beginPath();
    rr(g, ix, iy, iw, ih, ih * 0.38);
    g.clip();
    const gl = g.createLinearGradient(0, iy, 0, iy + ih);
    gl.addColorStop(0, this.night ? '#1a2130' : '#9fb8cf');
    gl.addColorStop(0.5, this.night ? '#141821' : '#7d8fa1');
    gl.addColorStop(0.52, this.night ? '#22252c' : '#4d5158');
    gl.addColorStop(1, this.night ? '#15171b' : '#3d4046');
    g.fillStyle = gl;
    g.fillRect(ix, iy, iw, ih);
    g.fillStyle = 'rgba(255,255,255,.12)';
    g.beginPath();
    g.moveTo(ix, iy + ih * 0.2);
    g.lineTo(ix + iw * 0.35, iy);
    g.lineTo(ix + iw * 0.5, iy);
    g.lineTo(ix, iy + ih * 0.6);
    g.fill();
    g.restore();
  };

  Cockpit.prototype.drawLower = function (g) {
    const L = G.lower;
    this.d = L.d;
    const P = this.P.bind(this);
    g.beginPath();
    spline(g, this.Ps(L.doorL), true);
    spline(g, this.Ps(L.dash), false);
    spline(g, this.Ps(L.doorR), false);
    g.lineTo(...P(1.7, 3));
    g.lineTo(...P(-1.2, 3));
    g.closePath();
    if (this.m) return this.fs(g), g.fill();
    const top = P(0, 0.085)[1];
    const gr = g.createLinearGradient(0, top, 0, this.H);
    gr.addColorStop(0, this.night ? '#15161b' : '#202228');
    gr.addColorStop(0.08, '#141519');
    gr.addColorStop(1, '#08090b');
    g.fillStyle = gr;
    g.fill();
    g.save();
    g.clip();
    g.fillStyle = this.pat.suede;
    g.fill();
    // door card: a touch lighter
    g.beginPath();
    spline(g, this.Ps(L.doorL.slice().reverse()), true);
    g.lineTo(...P(-1.2, 3));
    g.lineTo(...P(-0.34, 3));
    g.closePath();
    g.fillStyle = 'rgba(255,255,255,.03)';
    g.fill();
    // dash top surface catching the light, fading toward the driver
    const bot = P(0, 0.14)[1];
    const sh = g.createLinearGradient(0, top, 0, bot);
    sh.addColorStop(0, this.night ? 'rgba(255,255,255,.03)' : 'rgba(255,255,255,.07)');
    sh.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = sh;
    g.fillRect(0, top - 2, this.W, bot - top + 2);
    g.restore();
    this.drawVents(g);
    this.d = L.d;
    g.strokeStyle = this.night ? 'rgba(255,255,255,.05)' : 'rgba(255,255,255,.12)';
    g.lineWidth = Math.max(1, this.f * 0.002);
    g.beginPath();
    spline(g, this.Ps(L.dash), true);
    g.stroke();
  };

  /** Round eyeball vents: brushed bezel, dark slats. */
  Cockpit.prototype.drawVents = function (g) {
    this.d = G.vents.d;
    for (const [u, v, r] of G.vents.list) {
      const [x, y] = this.P(u, v), R = r * this.S();
      g.save();
      g.translate(x, y);
      g.scale(1, 0.86);
      const bz = g.createLinearGradient(0, -R, 0, R);
      bz.addColorStop(0, this.night ? '#4a4e57' : '#9aa0aa');
      bz.addColorStop(0.5, '#3b3f47');
      bz.addColorStop(1, this.night ? '#2a2d33' : '#6c717b');
      g.beginPath();
      g.arc(0, 0, R, 0, Math.PI * 2);
      g.fillStyle = bz;
      g.fill();
      g.beginPath();
      g.arc(0, 0, R * 0.8, 0, Math.PI * 2);
      g.fillStyle = '#060708';
      g.fill();
      g.clip();
      g.strokeStyle = '#24272d';
      g.lineWidth = Math.max(1, R * 0.07);
      for (let k = -3; k <= 3; k++) {
        g.beginPath();
        g.moveTo(-R, k * R * 0.22);
        g.lineTo(R, k * R * 0.22 - R * 0.05);
        g.stroke();
      }
      g.restore();
    }
  };

  Cockpit.prototype.glass = function (g) {
    if (this.m) return;
    this.d = G.lower.d;
    const P = this.P.bind(this);
    // dash reflection: darkens the bonnet just above the windscreen base
    const b = P(0, 0.087)[1], a = P(0, 0.06)[1];
    const gr = g.createLinearGradient(0, a, 0, b);
    gr.addColorStop(0, 'rgba(10,12,16,0)');
    gr.addColorStop(1, 'rgba(10,12,16,.25)');
    g.fillStyle = gr;
    g.fillRect(P(-0.3, 0)[0], a, P(0.8, 0)[0] - P(-0.3, 0)[0], b - a);
    // soft sheen across the screen, upper left
    const s = g.createLinearGradient(...P(-0.3, -0.16), ...P(0.15, 0.09));
    s.addColorStop(0, 'rgba(255,255,255,0)');
    s.addColorStop(0.45, 'rgba(255,255,255,' + (this.night ? 0.015 : 0.035) + ')');
    s.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = s;
    g.beginPath();
    g.moveTo(...P(-0.3, 0.09));
    g.lineTo(...P(-0.33, -0.14));
    g.lineTo(...P(0.1, -0.16));
    g.lineTo(...P(0.45, 0.087));
    g.closePath();
    g.fill();
  };

  /** Tube with cylinder shading (lx: light direction, +1 = from the right); w in units at the current depth. */
  Cockpit.prototype.tube = function (g, pts, w, lx, base) {
    const S = this.Ps(pts);
    w *= this.S();
    const line = (width, color, dx) => {
      g.save();
      g.translate(dx * w, -Math.abs(dx) * w * 0.3);
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath();
      spline(g, S, true);
      g.stroke();
      g.restore();
    };
    g.lineCap = 'round';
    g.lineJoin = 'round';
    if (this.m) return line(w, '#fff', 0);
    const c = base || ['#07080a', '#1c1f24', '#2b2f36'];
    line(w, c[0], 0);
    line(w * 0.72, c[1], lx * 0.08);
    line(w * 0.36, c[2], lx * 0.17);
    line(w * 0.1, this.night ? 'rgba(255,255,255,.08)' : 'rgba(255,255,255,.24)', lx * 0.27);
  };
  const PAD = ['#2a2d33', '#4a4f58', '#646a74']; // foam padding on the cage, lighter than trim

  Cockpit.prototype.pillar = function (g, p) {
    this.d = p.d;
    const out = this.Ps(p.out), inn = this.Ps(p.in).reverse();
    g.beginPath();
    spline(g, out, true);
    spline(g, inn, false);
    g.closePath();
    if (this.m) return this.fs(g), g.fill();
    const a = out[1], b = inn[inn.length - 2];
    const gr = g.createLinearGradient(a[0], a[1], b[0], b[1]);
    gr.addColorStop(0, '#08090b');
    gr.addColorStop(0.8, '#15171b');
    gr.addColorStop(1, this.night ? '#1a1c21' : '#24272d');
    g.fillStyle = gr;
    g.fill();
    g.save();
    g.clip();
    g.fillStyle = this.pat.suede;
    g.fill();
    g.restore();
    g.strokeStyle = '#030304';
    g.lineWidth = Math.max(1.5, this.f * 0.003);
    g.beginPath();
    spline(g, this.Ps(p.in), true);
    g.stroke();
  };

  Cockpit.prototype.drawHeader = function (g) {
    this.d = G.header.d;
    const P = this.P.bind(this), H = G.header.pts;
    const hd = this.Ps(H);
    // sun strip: tinted, not opaque, so it never counts as occlusion
    if (!this.m) {
      const strip = this.Ps(H.map((q) => [q[0], q[1] + 0.034]));
      g.beginPath();
      spline(g, hd, true);
      spline(g, strip.slice().reverse(), false);
      g.closePath();
      g.fillStyle = 'rgba(14,18,26,.5)';
      g.fill();
    }
    g.beginPath();
    spline(g, hd, true);
    g.lineTo(...P(1.5, -3));
    g.lineTo(...P(-0.7, -3));
    g.closePath();
    if (this.m) return this.fs(g), g.fill();
    const gr = g.createLinearGradient(0, P(0, -0.25)[1], 0, P(0, -0.16)[1]);
    gr.addColorStop(0, '#060708');
    gr.addColorStop(1, this.night ? '#131418' : '#1b1d22');
    g.fillStyle = gr;
    g.fill();
  };

  Cockpit.prototype.drawRearView = function (g) {
    this.d = G.rearView.d;
    const P = this.P.bind(this), b = G.rearView.box, S = this.S();
    const [x0, y0] = P(b[0], b[1]), [x1, y1] = P(b[2], b[3]);
    this.fs(g, '#0b0c0f');
    const sx = P((b[0] + b[2]) / 2, 0)[0], top = P(0, -0.25)[1];
    g.fillRect(sx - S * 0.01, top, S * 0.02, y0 - top + 2);
    g.beginPath();
    rr(g, x0, y0, x1 - x0, y1 - y0, S * 0.012);
    g.fill();
    if (this.m) return;
    const pad = S * 0.007, ix = x0 + pad, iy = y0 + pad, iw = x1 - x0 - 2 * pad, ih = y1 - y0 - 2 * pad;
    g.save();
    g.beginPath();
    rr(g, ix, iy, iw, ih, S * 0.006);
    g.clip();
    const gr = g.createLinearGradient(0, iy, 0, iy + ih);
    gr.addColorStop(0, this.night ? '#11161f' : '#5f7690');
    gr.addColorStop(0.45, this.night ? '#1a2230' : '#8ea4ba');
    gr.addColorStop(0.46, this.night ? '#1d2026' : '#55585f');
    gr.addColorStop(1, this.night ? '#141619' : '#3a3c41');
    g.fillStyle = gr;
    g.fillRect(ix, iy, iw, ih);
    g.fillStyle = this.night ? '#2a2d33' : '#6d7077';
    g.beginPath();
    g.moveTo(ix + iw * 0.47, iy + ih * 0.46);
    g.lineTo(ix + iw * 0.53, iy + ih * 0.46);
    g.lineTo(ix + iw * 0.95, iy + ih);
    g.lineTo(ix + iw * 0.05, iy + ih);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,.07)';
    g.beginPath();
    g.moveTo(ix, iy);
    g.lineTo(ix + iw * 0.25, iy);
    g.lineTo(ix + iw * 0.1, iy + ih);
    g.lineTo(ix, iy + ih);
    g.fill();
    g.restore();
  };

  // ----------------------------------------------------------------- wheel
  Cockpit.prototype.drawWheel = function (g, deg, info) {
    const W = G.wheel;
    this.d = W.d;
    const [cx, cy] = this.P(W.u, W.v), R = W.r * this.S(), m = this.m;
    info = info || {};
    g.save();
    g.translate(cx, cy);
    g.scale(1, W.sy);
    g.rotate((deg * Math.PI) / 180);
    g.scale(R, R); // local units: 1 = wheel half-width
    const px = 1 / R; // one screen pixel in local units
    g.lineJoin = 'round';

    // paddles behind
    this.fs(g, '#2a2d33');
    for (const s of [-1, 1]) {
      g.beginPath();
      rr(g, s > 0 ? 0.66 : -1.06, -0.2, 0.4, 0.5, 0.08);
      g.fill();
    }
    // grips
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(s * 0.7, -0.64);
      g.bezierCurveTo(s * 0.98, -0.66, s * 1.06, -0.3, s * 1.04, 0);
      g.bezierCurveTo(s * 1.03, 0.36, s * 0.96, 0.62, s * 0.76, 0.66);
      g.lineTo(s * 0.66, 0.5);
      g.bezierCurveTo(s * 0.76, 0.2, s * 0.76, -0.2, s * 0.68, -0.46);
      g.closePath();
      if (m) {
        this.fs(g);
        g.fill();
        continue;
      }
      const gr = g.createLinearGradient(s * 0.66, 0, s * 1.05, 0);
      gr.addColorStop(0, '#0d0e10');
      gr.addColorStop(0.55, '#1b1c20');
      gr.addColorStop(0.8, '#26282d');
      gr.addColorStop(1, '#0b0c0e');
      g.fillStyle = gr;
      g.fill();
      g.save();
      g.clip();
      g.strokeStyle = 'rgba(255,255,255,.035)';
      g.lineWidth = px;
      for (let y = -0.6; y < 0.65; y += 0.045) {
        g.beginPath();
        g.moveTo(s * 0.6, y);
        g.lineTo(s * 1.1, y + 0.02);
        g.stroke();
      }
      g.restore();
    }
    // top bar between the grips
    g.beginPath();
    g.moveTo(-0.72, -0.64);
    g.quadraticCurveTo(0, -0.7, 0.72, -0.64);
    g.lineTo(0.7, -0.5);
    g.quadraticCurveTo(0, -0.55, -0.7, -0.5);
    g.closePath();
    this.fs(g, '#141518');
    g.fill();
    // carbon face plate
    g.beginPath();
    g.moveTo(-0.74, -0.52);
    g.quadraticCurveTo(0, -0.57, 0.74, -0.52);
    g.bezierCurveTo(0.78, -0.1, 0.74, 0.3, 0.42, 0.62);
    g.lineTo(-0.42, 0.62);
    g.bezierCurveTo(-0.74, 0.3, -0.78, -0.1, -0.74, -0.52);
    g.closePath();
    if (m) {
      this.fs(g);
      g.fill();
      g.restore();
      return;
    }
    g.save();
    g.scale(px * 1.5, px * 1.5); // weave at a fixed pixel scale
    g.fillStyle = this.pat.carbon;
    g.fill();
    g.restore();
    const sh = g.createLinearGradient(0, -0.55, 0, 0.62);
    sh.addColorStop(0, 'rgba(255,255,255,.07)');
    sh.addColorStop(0.4, 'rgba(0,0,0,0)');
    sh.addColorStop(1, 'rgba(0,0,0,.35)');
    g.fillStyle = sh;
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,.08)';
    g.lineWidth = px * 1.2;
    g.stroke();

    // centre mark on the top bar
    g.fillStyle = '#f6d98f';
    g.fillRect(-0.025, -0.68, 0.05, 0.16);

    // shift lights
    const n = 12, rpm = U.clamp(info.rpm || 0, 0, 1), lit = Math.round(rpm * n);
    const flash = rpm > 0.97 && Math.floor(performance.now() / 70) % 2 === 0;
    for (let i = 0; i < n; i++) {
      const x = -0.4 + (0.8 * (i + 0.5)) / n;
      const on = flash || i < lit;
      const c = i < 4 ? '#5ee08a' : i < 8 ? '#ff5a4e' : '#5aa8ff';
      g.beginPath();
      g.arc(x, -0.445, 0.022, 0, Math.PI * 2);
      g.fillStyle = on ? c : '#202227';
      if (on) {
        g.shadowColor = c;
        g.shadowBlur = 8;
      }
      g.fill();
      g.shadowBlur = 0;
    }
    // display
    g.beginPath();
    rr(g, -0.31, -0.39, 0.62, 0.32, 0.035);
    g.fillStyle = '#040506';
    g.fill();
    g.strokeStyle = '#2a2d33';
    g.lineWidth = px * 1.5;
    g.stroke();
    g.fillStyle = '#eef0f4';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '620 0.22px ' + IST.Symbols.FONT;
    g.fillText(String(info.gear || 'N'), 0, -0.225);
    g.font = '520 0.07px ' + IST.Symbols.FONT;
    g.fillStyle = '#c9cfd9';
    g.textAlign = 'left';
    g.fillText(String(Math.round(info.kmh || 0)), -0.27, -0.31);
    g.font = '420 0.05px ' + IST.Symbols.FONT;
    g.fillStyle = '#a1a9b7';
    g.fillText('KM/H', -0.27, -0.245);
    g.textAlign = 'right';
    g.font = '520 0.07px ' + IST.Symbols.FONT;
    if (U.isNum(info.delta)) {
      const d = info.delta;
      g.fillStyle = d <= 0 ? '#a6e3c4' : '#f09ca6';
      g.fillText((d <= 0 ? '−' : '+') + Math.abs(d).toFixed(2), 0.27, -0.31);
      g.font = '420 0.05px ' + IST.Symbols.FONT;
      g.fillStyle = '#a1a9b7';
      g.fillText('DELTA', 0.27, -0.245);
    } else {
      g.fillStyle = '#c9cfd9';
      g.fillText(Math.round((info.rpm || 0) * 100) + '%', 0.27, -0.31);
      g.font = '420 0.05px ' + IST.Symbols.FONT;
      g.fillStyle = '#a1a9b7';
      g.fillText('RPM', 0.27, -0.245);
    }
    g.fillStyle = 'rgba(255,255,255,.05)'; // glare
    g.beginPath();
    g.moveTo(-0.31, -0.39);
    g.lineTo(-0.05, -0.39);
    g.lineTo(-0.2, -0.07);
    g.lineTo(-0.31, -0.07);
    g.fill();

    // buttons
    const rings = [['#f09ca6', '#f6d98f', '#eef0f4'], ['#9fcbef', '#a6e3c4', '#f5b09a']];
    for (const s of [-1, 1]) {
      const rc = rings[s < 0 ? 0 : 1];
      [-0.3, -0.08, 0.14].forEach((y, k) => {
        const x = s * 0.52;
        g.beginPath();
        g.arc(x, y, 0.075, 0, Math.PI * 2);
        g.fillStyle = rc[k];
        g.fill();
        g.beginPath();
        g.arc(x, y + 0.006, 0.056, 0, Math.PI * 2);
        const bg = g.createRadialGradient(x - 0.02, y - 0.02, 0.005, x, y, 0.06);
        bg.addColorStop(0, '#3a3d44');
        bg.addColorStop(1, '#141519');
        g.fillStyle = bg;
        g.fill();
      });
      // rotary
      const rx = s * 0.22, ry = 0.17;
      g.beginPath();
      g.arc(rx, ry, 0.095, 0, Math.PI * 2);
      g.fillStyle = '#0c0d10';
      g.fill();
      g.strokeStyle = '#3a3d44';
      g.lineWidth = px;
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 10) {
        g.beginPath();
        g.moveTo(rx + Math.cos(a) * 0.075, ry + Math.sin(a) * 0.075);
        g.lineTo(rx + Math.cos(a) * 0.093, ry + Math.sin(a) * 0.093);
        g.stroke();
      }
      g.beginPath();
      g.arc(rx, ry, 0.062, 0, Math.PI * 2);
      g.fillStyle = '#1d1f24';
      g.fill();
      g.strokeStyle = s < 0 ? '#f6d98f' : '#9fcbef';
      g.lineWidth = 0.014;
      g.beginPath();
      g.moveTo(rx, ry);
      g.lineTo(rx + 0.03 * s, ry - 0.05);
      g.stroke();
    }
    g.restore();
  };

  // ------------------------------------------------------------------ frame
  Cockpit.prototype.drawStatic = function (g) {
    this.drawBody(g);
    this.drawWingMirror(g);
    this.glass(g);
    this.drawLower(g);
    this.d = G.doorBar.d;
    this.tube(g, G.doorBar.pts, 0.05, 1);
    this.pillar(g, G.pillarR);
    this.d = G.cageR.d;
    this.tube(g, G.cageR.pts, 0.045, -1, PAD);
    this.pillar(g, G.pillarL);
    this.drawHeader(g);
    this.d = G.header.d;
    this.tube(g, G.header.pts.map((q) => [q[0], q[1] - 0.028]), 0.05, 0.4, PAD);
    // near cage tube: in front of everything but the wheel; dark sleeve on its lower half
    this.d = G.cageL.d;
    this.tube(g, G.cageL.pts, 0.075, 1, PAD);
    this.tube(g, [[-0.33, 0.9], [-0.333, 0.4], [-0.336, 0.08]], 0.092, 1);
    this.drawRearView(g);
  };

  Cockpit.prototype.draw = function (g, deg, info) {
    if (!this.pat) this.pat = { carbon: g.createPattern(carbon(), 'repeat'), suede: g.createPattern(suede(), 'repeat') };
    this.m = false;
    this.drawStatic(g);
    if (this.wheel !== false) this.drawWheel(g, deg, info);
    this.deg = deg; // the mask for this frame is built when something asks (coverage, drawMask)
    this.cells = null;
  };

  /** Static part of the occlusion mask (everything but the wheel): drawn and read back once per layout. */
  Cockpit.prototype.layout = function () {
    const mw = Math.ceil(this.W / MS), mh = Math.ceil(this.H / MS);
    const key = [this.W, this.H, this.f, this.cy, this.seat.x, this.seat.y, this.seat.z].join();
    if (key === this.key) return;
    this.key = key;
    this.static.width = this.mask.width = mw;
    this.static.height = this.mask.height = mh;
    const sg = this.static.getContext('2d');
    sg.setTransform(1 / MS, 0, 0, 1 / MS, 0, 0);
    this.m = true;
    this.drawStatic(sg);
    this.m = false;
    sg.setTransform(1, 0, 0, 1, 0, 0);
    this.sCells = sg.getImageData(0, 0, mw, mh).data;
    this.mw = mw;
    this.mh = mh;
    this.cells = null;
  };

  /** Low-res occlusion mask with the wheel at deg: the static parts once per layout, plus the wheel. */
  Cockpit.prototype.updateMask = function (deg) {
    this.layout();
    const mw = this.mw, mh = this.mh;
    const mg = this.mg;
    mg.setTransform(1, 0, 0, 1, 0, 0);
    mg.clearRect(0, 0, mw, mh);
    mg.drawImage(this.static, 0, 0);
    mg.setTransform(1 / MS, 0, 0, 1 / MS, 0, 0);
    this.m = true;
    if (this.wheel !== false) this.drawWheel(mg, deg);
    this.m = false;
    this.cells = mg.getImageData(0, 0, mw, mh).data;
  };

  /** Share of a screen rect's mask cells that are hidden in cells. */
  Cockpit.prototype.share = function (cells, x0, y0, x1, y1) {
    if (!cells) return 0;
    const a = Math.max(0, Math.floor(x0 / MS)), b = Math.min(this.mw - 1, Math.floor(x1 / MS));
    const c = Math.max(0, Math.floor(y0 / MS)), d = Math.min(this.mh - 1, Math.floor(y1 / MS));
    let n = 0, hid = 0;
    for (let y = c; y <= d; y++) {
      for (let x = a; x <= b; x++) {
        n++;
        if (cells[(y * this.mw + x) * 4 + 3] > 127) hid++;
      }
    }
    return n ? hid / n : 0;
  };

  Cockpit.prototype.coverage = function (x0, y0, x1, y1) {
    if (!this.cells && this.deg != null) this.updateMask(this.deg);
    return this.share(this.cells, x0, y0, x1, y1);
  };

  /**
   * Share of rect [x0, y0, x1, y1] hidden with the wheel at deg. Flash drills ask this
   * for dozens of predicted frames at once, so it must be cheap: a rect clear of the
   * wheel at that angle is read from the static mask, with no drawing or read-back.
   */
  Cockpit.prototype.hidden = function (rect, deg) {
    this.layout();
    if (this.wheel !== false && this.nearWheel(rect, deg)) {
      this.updateMask(deg);
      const out = this.share(this.cells, rect[0], rect[1], rect[2], rect[3]);
      this.cells = null; // predicted angle, not the drawn one
      return out;
    }
    return this.share(this.sCells, rect[0], rect[1], rect[2], rect[3]);
  };

  // everything drawWheel draws, in its local units (1 = wheel half-width), with a margin
  const WHEEL_BOX = [-1.12, -0.76, 1.12, 0.72];
  /** Could the wheel at deg touch this screen rect? Errs towards yes (the rect's bounds in the wheel's own frame). */
  Cockpit.prototype.nearWheel = function (rect, deg) {
    const w = G.wheel, c = this.P(w.u, w.v, w.d), R = w.r * this.S(w.d);
    const a = (-deg * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
    const pad = MS; // mask cells straddle the rect's edges
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [px, py] of [[rect[0] - pad, rect[1] - pad], [rect[2] + pad, rect[1] - pad], [rect[2] + pad, rect[3] + pad], [rect[0] - pad, rect[3] + pad]]) {
      const dx = (px - c[0]) / R, dy = (py - c[1]) / (R * w.sy);
      const lx = dx * cs - dy * sn, ly = dx * sn + dy * cs;
      x0 = Math.min(x0, lx);
      x1 = Math.max(x1, lx);
      y0 = Math.min(y0, ly);
      y1 = Math.max(y1, ly);
    }
    return x1 > WHEEL_BOX[0] && x0 < WHEEL_BOX[2] && y1 > WHEEL_BOX[1] && y0 < WHEEL_BOX[3];
  };

  /** Steering wheel angle (deg, + = clockwise) for the racing line at pos: wheelbase 2.5 m, ratio 13:1. */
  Cockpit.steerAt = function (track, pos) {
    const HW = track.HALF_W;
    return Cockpit.steerFrom((p) => track.lateralAt(p) * HW, (p) => track.curvatureAt(p), pos);
  };
  /**
   * Same from any path: lat(s) = lateral offset (m, + right) of the car, curv(s) = road
   * centreline curvature (1/m). Path curvature = road curvature + lat'', averaged over 12 m.
   */
  Cockpit.steerFrom = function (lat, curv, pos) {
    const y = (p) => lat(Math.max(0, p));
    let k = 0, n = 0;
    for (let s = pos - 6; s <= pos + 6; s += 3, n++) k += (curv(Math.max(0, s)) || 0) + (y(s + 4) - 2 * y(s) + y(s - 4)) / 16;
    return U.clamp((Math.atan(2.5 * (k / n)) * 13 * 180) / Math.PI, -320, 320);
  };
  /** Road curvature lookup for a LineLab geometry (5 m segments). */
  Cockpit.segCurv = (geo) => (s) => geo.segs[Math.max(0, Math.min(geo.segs.length - 1, Math.floor(s / 5)))];
  const GEAR_TOP = [0, 0, 75, 110, 145, 180, 220, 400];
  /** Wheel display values for a speed (m/s). */
  Cockpit.dash = function (v) {
    const kmh = v * 3.6;
    let gear = 2;
    while (gear < 7 && kmh > GEAR_TOP[gear]) gear++;
    const lo = GEAR_TOP[gear - 1] * 0.8, hi = Math.min(GEAR_TOP[gear], 300);
    return { gear, kmh, rpm: U.clamp((kmh - lo) / (hi - lo), 0, 1) };
  };

  /** Debug: tint the hidden cells. */
  Cockpit.prototype.drawMask = function (g, color) {
    if (!this.cells && this.deg != null) this.updateMask(this.deg);
    if (!this.cells) return;
    g.fillStyle = color || 'rgba(196,180,239,.45)';
    for (let y = 0; y < this.mh; y++) {
      for (let x = 0; x < this.mw; x++) {
        if (this.cells[(y * this.mw + x) * 4 + 3] > 127) g.fillRect(x * MS, y * MS, MS, MS);
      }
    }
  };

  Cockpit.BODY = BODY;
  Cockpit.GEOMETRY = G;
  IST.Cockpit = Cockpit;
})();
