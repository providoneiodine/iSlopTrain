/*
 * The trace strip under the 3D view: speed, delta, throttle, brake, steering
 * and gear against distance, one line per lap, sharing the viewer's cursor.
 *
 *   const tr = IST.Review.Traces.create(canvas, { onCursor(i), onRange(a, b), onReset() })
 *   tr.set(cmp)          a comparison from compare.js (laps[0] is the reference)
 *   tr.setCursor(i)      index on the reference grid, or -1
 *   tr.zoom(a, b)        show indices a..b (no arguments: the whole lap)
 *   tr.draw()            redraw (sizes itself to the canvas's CSS width)
 *   tr.destroy()
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
  const PANES = [
    { key: 'speed', label: 'Speed', h: 120, val: (v) => v * 3.6, fmt: (v) => Math.round(v), unit: 'km/h' },
    { key: 'delta', label: 'Delta', h: 84, centre: true, fmt: (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2), unit: 's' },
    { key: 'throttle', label: 'Throttle', h: 58, lo: 0, hi: 1, fmt: (v) => Math.round(v * 100), unit: '%' },
    { key: 'brake', label: 'Brake', h: 58, lo: 0, hi: 1, fmt: (v) => Math.round(v * 100), unit: '%' },
    { key: 'steer', label: 'Steering', h: 58, centre: true, val: (v) => (v * 180) / Math.PI, fmt: (v) => Math.round(v), unit: '°' },
    { key: 'gear', label: 'Gear', h: 50, step: true, fmt: (v) => Math.round(v), unit: '' },
  ];
  const AXIS = 22, PADL = 10, PADR = 10;

  function create(canvas, o) {
    const g = canvas.getContext('2d');
    let cmp = null, cursor = -1, v0 = 0, v1 = 1, W = 0, H = 0, panes = [];
    const st = { drag: null };

    function layout() {
      panes = cmp ? PANES.filter((p) => p.key === 'delta' ? cmp.laps.length > 1 : cmp.laps.some((l) => l[p.key])) : [];
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
        const arr = L[p.key];
        if (!arr) return;
        for (let i = a; i <= b; i++) {
          const v = p.val ? p.val(arr[i]) : arr[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      });
      if (!isFinite(lo)) return [0, 1];
      if (p.centre) {
        const m = Math.max(Math.abs(lo), Math.abs(hi), p.key === 'delta' ? 0.1 : 5);
        return [-m, m];
      }
      if (p.step) return [Math.max(0, lo - 0.5), hi + 0.5];
      const pad = (hi - lo) * 0.08 || 1;
      return [lo - pad, hi + pad];
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
        // draw comparisons first, the reference on top
        for (let k = cmp.laps.length - 1; k >= 0; k--) {
          const L = cmp.laps[k], arr = L[p.key];
          if (!arr) continue;
          g.strokeStyle = L.color;
          g.lineWidth = k === 0 ? 2 : 1.5;
          g.lineJoin = 'round';
          g.beginPath();
          let prevY = null;
          for (let i = a; i <= b; i += every) {
            const x = xOf(i), yy = yOf(p.val ? p.val(arr[i]) : arr[i]);
            if (prevY == null) g.moveTo(x, yy);
            else if (p.step && yy !== prevY) {
              g.lineTo(x, prevY);
              g.lineTo(x, yy);
            } else g.lineTo(x, yy);
            prevY = yy;
          }
          g.stroke();
        }
        g.restore();
        // label + values at the cursor
        g.font = '700 10.5px ' + FONT;
        g.letterSpacing = '1.5px';
        g.fillStyle = Th.dim;
        g.textAlign = 'left';
        g.textBaseline = 'alphabetic';
        g.fillText(p.label.toUpperCase() + (p.unit ? ' · ' + p.unit : ''), PADL + 4, y + 13);
        g.letterSpacing = '0px';
        g.font = '500 10px ' + FONT;
        g.textAlign = 'right';
        g.fillText(p.fmt(hi), W - PADR - 2, y + 13);
        if (cursor >= 0) {
          g.font = '800 11.5px ' + FONT;
          let x = W - PADR - 2 - g.measureText(p.fmt(hi)).width - 18;
          for (let k = cmp.laps.length - 1; k >= 0; k--) {
            const L = cmp.laps[k], arr = L[p.key];
            if (!arr) continue;
            const txt = p.key === 'delta' && k === 0 ? 'ref' : p.fmt(p.val ? p.val(arr[cursor]) : arr[cursor]);
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
      set(c) {
        const keep = cmp && c && cmp.n === c.n;
        cmp = c;
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

  IST.Review.Traces = { create };
})();
