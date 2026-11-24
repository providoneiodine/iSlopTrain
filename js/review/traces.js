/*
 * The trace strip under the 3D view: a lane per channel against distance,
 * one line per lap, sharing the viewer's cursor.
 *
 *   const tr = IST.Review.Traces.create(canvas, { onCursor(i), onRange(a, b), onReset() })
 *   tr.set(cmp, cfg?)    a comparison from compare.js (laps[0] is the reference), and which lanes
 *   tr.setLanes(cfg)     cfg: { on: Set of lane keys, picks: ['front', 'LF'...], tyreMode: 'temp' | 'press',
 *                        tyreBand: 'avg' | 'i' | 'm' | 'o', abs (ABS band on the brake lane), labels: { key: text } }
 *   tr.setCursor(i)      index on the reference grid, or -1
 *   tr.zoom(a, b)        show indices a..b (no arguments: the whole lap)
 *   tr.draw()            redraw (sizes itself to the canvas's CSS width)
 *   tr.destroy()
 *   Traces.LANES         the lane catalogue, in display order
 *   Traces.PICKS         tyre picks: { key: [wheels] }
 *   Traces.available(cmp, key)   whether any lap has what the lane needs
 *   Traces.DEFAULT, Traces.PRESETS   lane sets
 *
 * Lanes are listed in catalogue order whatever order they were switched on.
 * Tyre lanes are one per pick (a wheel, or the mean of an axle or side).
 *
 * Mouse: hover moves the cursor; drag selects a stretch of track and zooms
 * to it on release (onRange, so the 3D view can follow); shift- or
 * middle-drag pans; wheel zooms around the pointer; double-click resets
 * (onReset). Drawn in the page's style (IST.Theme).
 */
(function () {
  'use strict';
  const Th = IST.Theme, Sym = IST.Symbols;
  const FONT = Sym.FONT;
  const DEG = 180 / Math.PI, G0 = 9.80665;
  const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 1);
  const map = (a, f) => {
    if (!a) return null;
    const o = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) o[i] = f(a[i], i);
    return o;
  };
  const r0 = (v) => Math.round(v);
  const r1 = (v) => (Math.abs(v) < 0.05 ? '0.0' : v.toFixed(1));
  const signed = (d) => (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d);

  // [key, group, label, unit, title, extra]
  const LANES = [
    { key: 'speed', group: 'driving', label: 'Speed', unit: 'km/h', h: 120, needs: ['speed'], series: (L) => map(L.speed, (v) => v * 3.6), fmt: r0, title: 'Speed in km/h' },
    { key: 'delta', group: 'driving', label: 'Delta', unit: 's', h: 84, centre: true, minSpan: 0.1, needs: ['delta'], cmp: true, series: (L) => L.delta, fmt: signed(2), title: 'Time behind (+) or ahead (−) of the reference at that point, in seconds' },
    { key: 'throttle', group: 'driving', label: 'Throttle', unit: '%', h: 58, lo: 0, hi: 100, needs: ['throttle'], series: (L) => map(L.throttle, (v) => v * 100), fmt: r0, title: 'Throttle pedal, %. Grey where the reference lap coasts (neither pedal)' },
    { key: 'brake', group: 'driving', label: 'Brake', unit: '%', h: 58, lo: 0, hi: 100, needs: ['brake'], series: (L) => map(L.brake, (v) => v * 100), fmt: r0, title: 'Brake pedal, %. With ABS on the lane: shaded where ABS acts, dashed for the share of force it removed' },
    { key: 'steer', group: 'driving', label: 'Steering', unit: '°', h: 58, centre: true, needs: ['steer'], series: (L) => map(L.steer, (v) => v * DEG), fmt: r0, title: 'Steering-wheel angle in degrees, + left' },
    { key: 'gear', group: 'driving', label: 'Gear', unit: '', h: 50, step: true, needs: ['gear'], series: (L) => L.gear, fmt: r0, title: 'Gear' },
    { key: 'rpm', group: 'driving', label: 'RPM', unit: 'rpm', h: 58, needs: ['rpm'], series: (L) => L.rpm, fmt: r0, title: 'Engine speed, rpm' },
    { key: 'balance', group: 'car', label: 'Balance', unit: '° wheel', h: 70, centre: true, needs: ['us'], series: (L) => map(L.us, (v) => v * DEG), fmt: signed(1), title: 'Steering lock beyond what the car’s yaw needed, in degrees of wheel: + understeer, − oversteer. Zero through the car’s own linear range' },
    { key: 'yaw', group: 'car', label: 'Yaw rate', unit: '°/s', h: 70, centre: true, needs: ['yawRate'], series: (L) => map(L.yawRate, (v, i) => v * DEG * (L.latG ? sgn(L.latG[i]) : 1)), fmt: r0, title: 'How fast the car rotates, °/s, signed by the turn so left and right corners both read upward' },
    { key: 'beta', group: 'car', label: 'Sideslip', unit: '°', h: 70, centre: true, minSpan: 2, needs: ['beta'], series: (L) => map(L.beta, (v) => v * DEG), fmt: r1, title: 'Body slip angle, °: how far the car points into the corner beyond where it travels. Signed by the turn' },
    { key: 'latG', group: 'car', label: 'Lateral g', unit: 'g', h: 70, centre: true, minSpan: 0.5, needs: ['latG'], series: (L) => map(L.latG, (v) => v / G0), fmt: (v) => v.toFixed(2), title: 'Cornering force in g, + left' },
    { key: 'longG', group: 'car', label: 'Long g', unit: 'g', h: 70, centre: true, minSpan: 0.5, needs: ['longG'], series: (L) => map(L.longG, (v) => v / G0), fmt: (v) => v.toFixed(2), title: 'Acceleration (+) and braking (−) in g' },
    { key: 'grip', group: 'car', label: 'Grip used', unit: '%', h: 58, lo: 0, hi: 115, needs: ['gripUse'], series: (L) => map(L.gripUse, (v) => v * 100), fmt: r0, title: 'Combined g as a share of this session’s own limit at that speed, %. Dips mid-corner are grip left unused' },
    { key: 'tyres', group: 'tyres', label: 'Tyre', virtual: true },
    { key: 'slip', group: 'tyres', label: 'Wheel slip', unit: '%', h: 70, centre: true, needs: ['slipF', 'slipR'], multi: (L) => [{ arr: map(L.slipF, (v) => v * 100) }, { arr: map(L.slipR, (v) => v * 100), dash: true }], fmt: r0, title: 'Wheel speed against the car’s, %: the front’s lowest (solid, down = locking) and the rear’s highest (dashed, up = spinning)' },
    { key: 'ride', group: 'chassis', label: 'Ride height', unit: 'mm', h: 58, needs: ['rhF', 'rhR'], multi: (L) => [{ arr: map(L.rhF, (v) => v * 1000) }, { arr: map(L.rhR, (v) => v * 1000), dash: true }], fmt: r0, title: 'Front (solid) and rear (dashed) ride height, mm' },
    { key: 'steerTq', group: 'chassis', label: 'Steer torque', unit: 'N·m', h: 58, centre: true, needs: ['steerTq'], series: (L) => L.steerTq, fmt: r0, title: 'Torque on the steering column, N·m. When it falls while lock still rises, the fronts are past their peak: understeer' },
  ];
  const PICKS = { LF: ['LF'], RF: ['RF'], LR: ['LR'], RR: ['RR'], front: ['LF', 'RF'], rear: ['LR', 'RR'], left: ['LF', 'LR'], right: ['RF', 'RR'] };
  const PICK_NAME = { LF: 'LF', RF: 'RF', LR: 'LR', RR: 'RR', front: 'Front', rear: 'Rear', left: 'Left', right: 'Right' };
  const BAND_NAME = { i: 'inner', m: 'mid', o: 'outer' };
  const BASIC = ['speed', 'delta', 'throttle', 'brake', 'steer', 'gear'];
  const PRESETS = {
    basic: { on: BASIC, picks: [] },
    handling: { on: ['speed', 'delta', 'throttle', 'brake', 'steer', 'balance', 'yaw', 'beta', 'latG'], picks: [] },
    tyres: { on: ['speed', 'delta', 'brake', 'slip'], picks: ['front', 'rear'] },
    all: { on: LANES.filter((l) => !l.virtual).map((l) => l.key), picks: ['front', 'rear'] },
  };
  const DEFAULT = { on: new Set(BASIC.concat(['balance'])), picks: [], tyreMode: 'temp', tyreBand: 'avg', abs: true, labels: {} };

  const has = (cmp, keys) => cmp.laps.some((L) => keys.every((k) => L[k]));
  function available(cmp, key) {
    if (!cmp) return false;
    if (key === 'delta') return cmp.laps.length > 1;
    if (key === 'tyreTemp') return T_KEYS.some((k) => has(cmp, [k]));
    if (key === 'tyrePress') return P_KEYS.some((k) => has(cmp, [k]));
    if (key === 'tyreBands') return has(cmp, ['tLF_i']);
    if (key === 'abs') return has(cmp, ['absActive']);
    const l = LANES.find((x) => x.key === key);
    return !!l && !l.virtual && has(cmp, l.needs);
  }
  const T_KEYS = ['tLF', 'tRF', 'tLR', 'tRR'], P_KEYS = ['pLF', 'pRF', 'pLR', 'pRR'];

  /** A lane for one tyre pick. */
  function tyreLane(pick, cfg) {
    const press = cfg.tyreMode === 'press';
    const band = !press && cfg.tyreBand !== 'avg' ? cfg.tyreBand : '';
    const chan = (w) => (press ? 'p' + w : 't' + w + (band ? '_' + band : ''));
    const wheels = PICKS[pick];
    return {
      key: (press ? 'press:' : 'tyre:') + pick + (band ? ':' + band : ''), group: 'tyres', h: 58,
      label: (press ? 'Tyre pressure · ' : 'Tyre temp · ') + PICK_NAME[pick] + (band ? ' · ' + BAND_NAME[band] : ''),
      unit: press ? 'kPa' : '°C', needs: wheels.map(chan), fmt: press ? r1 : r0,
      series: (L) => {
        const arrs = wheels.map((w) => L[chan(w)]);
        if (arrs.some((a) => !a)) return null;
        return map(arrs[0], (v, i) => arrs.reduce((s, a) => s + a[i], 0) / arrs.length);
      },
    };
  }

  /** The lanes to draw for this comparison and config, in catalogue order. */
  function lanesFor(cmp, cfg) {
    const out = [];
    LANES.forEach((l) => {
      if (l.virtual) {
        if (l.key === 'tyres') Object.keys(PICKS).forEach((p) => cfg.picks.indexOf(p) >= 0 && out.push(tyreLane(p, cfg)));
        return;
      }
      if (cfg.on.has(l.key)) out.push(l);
    });
    return out.filter((l) => (l.key === 'delta' ? cmp.laps.length > 1 : has(cmp, l.needs)));
  }

  const AXIS = 22, PADL = 10, PADR = 10;

  function create(canvas, o) {
    const g = canvas.getContext('2d');
    let cmp = null, cursor = -1, v0 = 0, v1 = 1, W = 0, H = 0, panes = [];
    let cfg = Object.assign({}, DEFAULT, { on: new Set(DEFAULT.on) });
    const st = { drag: null };
    let cache = new WeakMap(); // lap -> Map(lane key -> [{ arr, dash }])

    function seriesOf(p, L) {
      let m = cache.get(L);
      if (!m) cache.set(L, (m = new Map()));
      if (!m.has(p.key)) {
        const s = p.multi ? p.multi(L) : [{ arr: p.series(L) }];
        m.set(p.key, s.filter((x) => x.arr));
      }
      return m.get(p.key);
    }

    function layout() {
      panes = cmp ? lanesFor(cmp, cfg) : [];
      H = panes.reduce((s, p) => s + p.h, 0) + AXIS;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      W = canvas.clientWidth || 800;
      canvas.style.height = H + 'px';
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    const xOf = (i) => PADL + ((i - v0) / (v1 - v0)) * (W - PADL - PADR);
    const iOf = (x) => v0 + ((x - PADL) / (W - PADL - PADR)) * (v1 - v0);

    function range(p) {
      if (p.lo != null) return [p.lo, p.hi];
      let lo = Infinity, hi = -Infinity;
      const a = Math.max(0, Math.floor(v0)), b = Math.min(cmp.n - 1, Math.ceil(v1));
      cmp.laps.forEach((L) => {
        seriesOf(p, L).forEach(({ arr }) => {
          for (let i = a; i <= b; i++) {
            const v = arr[i];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        });
      });
      if (!isFinite(lo)) return [0, 1];
      if (p.centre) {
        const m = Math.max(Math.abs(lo), Math.abs(hi), p.minSpan || 5);
        return [-m, m];
      }
      if (p.step) return [Math.max(0, lo - 0.5), hi + 0.5];
      const pad = (hi - lo) * 0.08 || 1;
      return [lo - pad, hi + pad];
    }

    /** Fill under arr (down to `floor`, or to the value 0) wherever on(i), in fill. */
    function shade(a, b, every, arr, on, yOf, floorY, fill) {
      g.fillStyle = fill;
      let open = false;
      const pts = [];
      const flush = () => {
        if (pts.length < 2) return (pts.length = 0);
        g.beginPath();
        g.moveTo(pts[0][0], floorY);
        pts.forEach(([x, y]) => g.lineTo(x, y));
        g.lineTo(pts[pts.length - 1][0], floorY);
        g.closePath();
        g.fill();
        pts.length = 0;
      };
      for (let i = a; i <= b; i += every) {
        const v = arr ? arr[i] : NaN;
        if (on(i) && (!arr || isFinite(v))) {
          pts.push([xOf(i), arr ? yOf(v) : null]);
          open = true;
        } else if (open) (flush(), (open = false));
      }
      flush();
    }
    /** Full-height columns wherever on(i). */
    function columns(a, b, every, on, top, bot, fill) {
      g.fillStyle = fill;
      let s = -1;
      for (let i = a; i <= b + every; i += every) {
        const yes = i <= b && on(i);
        if (yes && s < 0) s = i;
        else if (!yes && s >= 0) {
          g.fillRect(xOf(s), top, Math.max(1, xOf(Math.min(b, i)) - xOf(s)), bot - top);
          s = -1;
        }
      }
    }
    const alpha = (hex, a) => {
      const n = parseInt(hex.slice(1), 16);
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
    };

    function line(arr, a, b, every, yOf, step) {
      g.beginPath();
      let prevY = null;
      for (let i = a; i <= b; i += every) {
        const v = arr[i];
        if (!isFinite(v)) {
          prevY = null;
          continue;
        }
        const x = xOf(i), yy = yOf(v);
        if (prevY == null) g.moveTo(x, yy);
        else if (step && yy !== prevY) {
          g.lineTo(x, prevY);
          g.lineTo(x, yy);
        } else g.lineTo(x, yy);
        prevY = yy;
      }
      g.stroke();
    }

    function draw() {
      if (!cmp) return;
      layout();
      g.clearRect(0, 0, W, H);
      g.fillStyle = Th.deep;
      g.fillRect(0, 0, W, H);
      const a = Math.max(0, Math.floor(v0)), b = Math.min(cmp.n - 1, Math.ceil(v1));
      const every = Math.max(1, Math.floor((b - a) / (W * 1.5)));
      let y = 0;
      panes.forEach((p, pi) => {
        const [lo, hi] = range(p);
        const top = y + 18, bot = y + p.h - 6;
        const yOf = (v) => bot - ((v - lo) / (hi - lo || 1)) * (bot - top);
        if (pi) {
          g.fillStyle = Th.line;
          g.fillRect(0, y, W, 1);
        }
        // zero line for centred panes
        if (p.centre) {
          g.fillStyle = 'rgba(161,169,183,0.35)';
          g.fillRect(PADL, Math.round(yOf(0)), W - PADL - PADR, 1);
        }
        g.save();
        g.beginPath();
        g.rect(PADL, y + 2, W - PADL - PADR, p.h - 4);
        g.clip();
        const ref = cmp.laps[0];
        // shading under the lines
        if (p.key === 'throttle') {
          if (ref.coast) columns(a, b, every, (i) => ref.coast[i] > 0.5, y + 2, y + p.h - 2, 'rgba(161,169,183,0.14)');
          cmp.laps.forEach((L) => L.tcActive && shade(a, b, every, seriesOf(p, L)[0].arr, (i) => L.tcActive[i] > 0.5, yOf, yOf(0), alpha(L.color, 0.25)));
        }
        if (p.key === 'brake' && cfg.abs) {
          cmp.laps.forEach((L) => L.absActive && shade(a, b, every, seriesOf(p, L)[0].arr, (i) => L.absActive[i] > 0.5, yOf, yOf(0), alpha(L.color, 0.3)));
        }
        if (p.key === 'balance') {
          const arr = seriesOf(p, ref)[0];
          if (arr) {
            shade(a, b, every, arr.arr, (i) => arr.arr[i] > 0, yOf, yOf(0), alpha(Th.sky, 0.34));
            shade(a, b, every, arr.arr, (i) => arr.arr[i] < 0, yOf, yOf(0), alpha(Th.peach, 0.38));
          }
        }
        // draw comparisons first, the reference on top
        for (let k = cmp.laps.length - 1; k >= 0; k--) {
          const L = cmp.laps[k];
          g.strokeStyle = L.color;
          g.lineJoin = 'round';
          seriesOf(p, L).forEach((s) => {
            g.lineWidth = k === 0 ? 2 : 1.5;
            g.setLineDash(s.dash ? [5, 3] : []);
            line(s.arr, a, b, every, yOf, p.step);
          });
          // the share of brake force ABS took away, dashed
          if (p.key === 'brake' && cfg.abs && L.absCut && L.absActive) {
            g.lineWidth = 1;
            g.setLineDash([3, 3]);
            const cut = map(L.absCut, (v, i) => (L.absActive[i] > 0.5 ? v * 100 : NaN));
            line(cut, a, b, every, yOf, false);
          }
          g.setLineDash([]);
        }
        g.restore();
        // label + values at the cursor
        g.font = '700 10.5px ' + FONT;
        g.letterSpacing = '1.5px';
        g.fillStyle = Th.dim;
        g.textAlign = 'left';
        g.textBaseline = 'alphabetic';
        const label = (cfg.labels && cfg.labels[p.key]) || p.label;
        g.fillText(label.toUpperCase() + (p.unit ? ' · ' + p.unit : ''), PADL + 4, y + 13);
        g.letterSpacing = '0px';
        g.font = '500 10px ' + FONT;
        g.textAlign = 'right';
        g.fillText(p.fmt(hi), W - PADR - 2, y + 13);
        if (cursor >= 0) {
          g.font = '800 11.5px ' + FONT;
          let x = W - PADR - 2 - g.measureText(p.fmt(hi)).width - 18;
          for (let k = cmp.laps.length - 1; k >= 0; k--) {
            const L = cmp.laps[k], s = seriesOf(p, L)[0];
            if (!s) continue;
            const v = s.arr[cursor];
            const txt = p.key === 'delta' && k === 0 ? 'ref' : isFinite(v) ? p.fmt(v) : '–';
            g.fillStyle = L.color;
            g.fillText(txt, x, y + 13);
            x -= g.measureText(txt).width + 12;
          }
        }
        y += p.h;
      });

      // distance axis
      g.fillStyle = Th.line;
      g.fillRect(0, y, W, 1);
      const span = (v1 - v0) * cmp.step;
      const tick = [50, 100, 250, 500, 1000, 2000].find((t) => span / t < 10) || 5000;
      g.font = '500 10px ' + FONT;
      g.textAlign = 'center';
      g.fillStyle = Th.dim;
      for (let d = Math.ceil((v0 * cmp.step) / tick) * tick; d <= v1 * cmp.step; d += tick) {
        const x = xOf(d / cmp.step);
        g.fillRect(x, y, 1, 4);
        g.fillText(d >= 1000 ? (d / 1000).toFixed(d % 1000 ? 2 : 0) + ' km' : d + ' m', x, y + 15);
      }

      // selection band while dragging
      const d = st.drag;
      if (d && d.moved && !d.pan) {
        const xa = Math.max(PADL, Math.min(d.x0, d.x)), xb = Math.min(W - PADR, Math.max(d.x0, d.x));
        g.fillStyle = 'rgba(246,217,143,0.14)';
        g.fillRect(xa, 0, xb - xa, y);
        g.fillStyle = Th.butter;
        g.fillRect(Math.round(xa), 0, 1, y);
        g.fillRect(Math.round(xb), 0, 1, y);
        g.font = '800 11px ' + FONT;
        g.textAlign = 'center';
        g.fillText(Math.round(Math.abs(iOf(xb) - iOf(xa)) * cmp.step) + ' m', (xa + xb) / 2, y - 8);
      }

      // cursor
      if (cursor >= 0 && cursor >= v0 && cursor <= v1) {
        const x = Math.round(xOf(cursor)) + 0.5;
        g.strokeStyle = Th.text;
        g.globalAlpha = 0.75;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, y);
        g.stroke();
        g.globalAlpha = 1;
      }
    }

    const local = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const clampI = (x) => Math.round(Math.max(0, Math.min(cmp.n - 1, iOf(x))));
    const onMove = (e) => {
      if (!cmp) return;
      const p = local(e);
      const d = st.drag;
      if (d && d.pan) {
        const di = ((d.x - p.x) / (W - PADL - PADR)) * (v1 - v0);
        const w = v1 - v0;
        v0 = Math.max(0, Math.min(cmp.n - 1 - w, v0 + di));
        v1 = v0 + w;
      }
      if (d) {
        d.x = p.x;
        if (Math.abs(d.x - d.x0) > 4) d.moved = true;
      }
      o.onCursor(clampI(p.x));
      if (d && d.moved) draw(); // the selection band, or the panned view
    };
    const onDown = (e) => {
      if (!cmp || e.button > 1) return;
      const x = local(e).x;
      // drag selects a stretch to zoom into; shift- or middle-drag pans
      st.drag = { x0: x, x, moved: false, pan: e.shiftKey || e.button === 1 };
      canvas.setPointerCapture(e.pointerId);
      onMove(e);
    };
    const onUp = () => {
      const d = st.drag;
      st.drag = null;
      if (!d || !cmp) return;
      if (!d.pan && d.moved) {
        let a = clampI(Math.min(d.x0, d.x)), b = clampI(Math.max(d.x0, d.x));
        // at least ~40 m, so a twitch doesn't zoom to nothing
        const min = Math.ceil(40 / cmp.step);
        if (b - a < min) {
          const c = (a + b) / 2;
          a = Math.max(0, Math.round(c - min / 2));
          b = Math.min(cmp.n - 1, a + min);
        }
        v0 = a;
        v1 = b;
        if (o.onRange) o.onRange(a, b);
      }
      draw();
    };
    const onWheel = (e) => {
      if (!cmp) return;
      e.preventDefault();
      const at = iOf(local(e).x);
      const k = Math.exp(e.deltaY * 0.0015);
      const w = Math.max(40 / cmp.step, Math.min(cmp.n - 1, (v1 - v0) * k));
      v0 = Math.max(0, at - (at - v0) * (w / (v1 - v0)));
      v1 = Math.min(cmp.n - 1, v0 + w);
      v0 = Math.max(0, v1 - w);
      draw();
    };
    const onDbl = () => {
      if (!cmp) return;
      v0 = 0;
      v1 = cmp.n - 1;
      draw();
      if (o.onReset) o.onReset();
    };
    const onLeave = () => !st.drag && o.onLeave && o.onLeave();
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDbl);

    return {
      set(c, lanes) {
        const keep = cmp && c && cmp.n === c.n;
        cmp = c;
        cache = new WeakMap();
        if (lanes) cfg = lanes;
        if (!keep && c) {
          v0 = 0;
          v1 = c.n - 1;
        }
        draw();
      },
      /** Zoom to an index range (or the whole lap with no arguments). */
      zoom(a, b) {
        if (!cmp) return;
        v0 = a == null ? 0 : a;
        v1 = b == null ? cmp.n - 1 : b;
        draw();
      },
      /** Values at index i for the lanes on screen: [{ key, label, unit, vals: [text per lap] }]. */
      values(i) {
        if (!cmp || i < 0) return [];
        return panes.map((p) => ({
          key: p.key, label: (cfg.labels && cfg.labels[p.key]) || p.label, unit: p.unit,
          vals: cmp.laps.map((L, k) => {
            const s = seriesOf(p, L)[0];
            const v = s ? s.arr[i] : NaN;
            return p.key === 'delta' && k === 0 ? 'ref' : isFinite(v) ? String(p.fmt(v)) : '–';
          }),
        }));
      },
      setLanes(lanes) {
        cfg = lanes;
        cache = new WeakMap();
        draw();
      },
      zoomed: () => !!cmp && (v0 > 0 || v1 < cmp.n - 1),
      setCursor(i) {
        cursor = i;
        // keep the cursor in view while playing
        if (cmp && i >= 0 && (i < v0 || i > v1)) {
          const w = v1 - v0;
          v0 = Math.max(0, Math.min(cmp.n - 1 - w, i - w * 0.1));
          v1 = v0 + w;
        }
        draw();
      },
      draw,
      destroy() {
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointerleave', onLeave);
        canvas.removeEventListener('wheel', onWheel);
        canvas.removeEventListener('dblclick', onDbl);
      },
    };
  }

  IST.Review.Traces = { create, LANES, PICKS, PICK_NAME, PRESETS, DEFAULT, available };
})();
