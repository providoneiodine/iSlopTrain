/*
 * The track map floating in the corner of the 3D view: the circuit from above (north up), the
 * app's corner numbers, the complex the reference is in, the cars, and a dot to scrub with.
 *
 *   const m = IST.Review.TrackMap.create(canvas, { onPreview(i | -1), onPick(i) })
 *   m.set(cmp)                 a comparison from compare.js
 *   m.update(f, cars)          f: the cursor (fractional index, or -1); cars: [{ j, color, ref }]
 *   m.resize(), m.cancel() (drop a preview, true if there was one), m.current(), m.destroy()
 *   TrackMap.spans(cmp)        each complex's stretch [{ a, b, name }]: braking point to full throttle
 *   TrackMap.complexAt(cmp, f) { c, on }: the complex f is in (on), else the next one
 *   TrackMap.nearest(pts, x, y) the grid index nearest a point, and its distance
 *
 * Corner numbers are the circuit's when corners.js knows the track (cmp.turns), else the app's
 * (braking zones on the reference); the versus card names stretches the same way. Hover the map to preview a point (the
 * traces show it dashed), click or drag and release to move the cursor there.
 */
(function () {
  'use strict';
  IST.Review = IST.Review || {};
  const Th = IST.Theme;
  const FONT = (IST.Symbols && IST.Symbols.FONT) || 'sans-serif';
  const PAD = 16, HIT = 18;

  const made = new WeakMap();
  function spans(cmp) {
    if (made.has(cmp)) return made.get(cmp);
    const R = cmp.laps[0];
    const out = (cmp.complexes || []).map((cx) => {
      const first = cmp.corners[cx.corners[0]];
      // as the versus card's stretches: from the brake going down (or the top speed before a lift)
      let a = first.start;
      if (R.brake) for (let i = first.start; i < first.apex; i++) if (R.brake[i] > 0.05) { a = i; break; }
      // out at the exit: back to full throttle, else halfway back up to the next top speed
      const last = cmp.corners[cx.corners[cx.corners.length - 1]], v = R.speed;
      let b = cx.last;
      for (let i = last.apex; i < cx.last; i++) {
        if (R.throttle ? R.throttle[i] >= 0.95 : v[i] >= (v[last.apex] + v[cx.last]) / 2) { b = i; break; }
      }
      b = Math.min(cx.last, b + Math.round(20 / cmp.step));
      const n0 = cx.corners[0] + 1, n1 = cx.corners[cx.corners.length - 1] + 1;
      const known = IST.Review.Corners && IST.Review.Corners.nameSpan(cmp, a, b);
      return { a, b, name: known || (n0 === n1 ? 'T' + n0 : 'T' + n0 + '–' + n1) };
    });
    made.set(cmp, out);
    return out;
  }

  function complexAt(cmp, f) {
    const S = spans(cmp);
    if (!S.length || !(f >= 0)) return null;
    for (let c = 0; c < S.length; c++) if (f >= S[c].a && f <= S[c].b) return { c, on: true };
    for (let c = 0; c < S.length; c++) if (S[c].a > f) return { c, on: false };
    return { c: 0, on: false }; // past the last one: the first, next lap
  }

  function nearest(pts, x, y) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      const d = (pts[i] - x) * (pts[i] - x) + (pts[i + 1] - y) * (pts[i + 1] - y);
      if (d < bd) (bd = d), (best = i / 2);
    }
    return { i: best, d: Math.sqrt(bd) };
  }

  function create(canvas, o) {
    const g = canvas.getContext('2d');
    let cmp = null, pts = null, labels = [], W = 0, H = 0, dpr = 1;
    let f = -1, cars = [], preview = -1, drag = false;
    const base = document.createElement('canvas'), bg = base.getContext('2d');

    /** Fit the centreline to the canvas (north up) and place the corner numbers outside each turn. */
    function layout() {
      W = canvas.clientWidth;
      H = canvas.clientHeight;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = base.width = Math.round(W * dpr);
      canvas.height = base.height = Math.round(H * dpr);
      if (!cmp || !W || !H) return (pts = null);
      const X = cmp.centre.x, Y = cmp.centre.y, n = cmp.n;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < n; i++) (x0 = Math.min(x0, X[i])), (x1 = Math.max(x1, X[i])), (y0 = Math.min(y0, Y[i])), (y1 = Math.max(y1, Y[i]));
      const k = Math.min((W - PAD * 2) / Math.max(1, x1 - x0), (H - PAD * 2) / Math.max(1, y1 - y0));
      const ox = (W - (x1 - x0) * k) / 2, oy = (H - (y1 - y0) * k) / 2;
      pts = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) (pts[i * 2] = ox + (X[i] - x0) * k), (pts[i * 2 + 1] = H - oy - (Y[i] - y0) * k);
      labels = [];
      const off = Math.max(1, Math.round(15 / cmp.step));
      // the circuit's numbers when the data knows the track (cmp.turns), else the app's own
      const S = spans(cmp), inSpan = (i) => S.findIndex((s) => i >= s.a && i <= s.b);
      const list = cmp.turns && cmp.turns.length
        ? cmp.turns.map((c) => ({ apex: c.apex, dir: c.dir, text: c.label, name: c.name, complex: inSpan(c.apex) }))
        : cmp.corners.map((c, j) => ({ apex: c.apex, dir: c.dir, text: String(j + 1), complex: c.complex }));
      list.forEach((c) => {
        const a = Math.max(0, c.apex - off), b = Math.min(n - 1, c.apex + off);
        const tx = pts[b * 2] - pts[a * 2], ty = pts[b * 2 + 1] - pts[a * 2 + 1], l = Math.hypot(tx, ty) || 1;
        // canvas y points down, so (ty, -tx) is the left of travel; the number goes on the outside
        const nx = (ty / l) * -c.dir, ny = (-tx / l) * -c.dir;
        const px = pts[c.apex * 2], py = pts[c.apex * 2 + 1];
        let x = px + nx * 13, y = py + ny * 13;
        for (let t = 0; t < 3 && labels.some((q) => Math.hypot(q.x - x, q.y - y) < 17); t++) (x += nx * 9), (y += ny * 9);
        labels.push({ x: Math.max(9, Math.min(W - 9, x)), y: Math.max(9, Math.min(H - 9, y)), text: c.text, name: c.name || '', complex: c.complex });
      });
      paintBase();
    }

    function path(c, a, b) {
      c.beginPath();
      for (let i = a; i <= b; i++) i === a ? c.moveTo(pts[i * 2], pts[i * 2 + 1]) : c.lineTo(pts[i * 2], pts[i * 2 + 1]);
    }

    /** The parts that only change with the comparison or the size. */
    function paintBase() {
      bg.setTransform(dpr, 0, 0, dpr, 0, 0);
      bg.clearRect(0, 0, W, H);
      bg.lineJoin = bg.lineCap = 'round';
      // no panel behind it: a dark casing keeps the line readable over the scene
      path(bg, 0, cmp.n - 1);
      bg.strokeStyle = 'rgba(20, 23, 28, .75)';
      bg.lineWidth = 9;
      bg.stroke();
      bg.strokeStyle = Th.text2;
      bg.globalAlpha = 0.55;
      bg.lineWidth = 3;
      bg.stroke();
      bg.globalAlpha = 1;
      // start line, across the track
      const b = Math.min(cmp.n - 1, Math.max(1, Math.round(10 / cmp.step)));
      const tx = pts[b * 2] - pts[0], ty = pts[b * 2 + 1] - pts[1], l = Math.hypot(tx, ty) || 1;
      bg.beginPath();
      bg.moveTo(pts[0] - (ty / l) * 6, pts[1] + (tx / l) * 6);
      bg.lineTo(pts[0] + (ty / l) * 6, pts[1] - (tx / l) * 6);
      bg.strokeStyle = Th.text;
      bg.lineWidth = 2;
      bg.lineCap = 'butt';
      bg.stroke();
    }

    function dot(x, y, r, fill, ring) {
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      if (fill) (g.fillStyle = fill), g.fill();
      if (ring) (g.strokeStyle = ring), (g.lineWidth = 2), g.stroke();
    }
    const at = (j) => {
      const i = Math.max(0, Math.min(cmp.n - 2, Math.floor(j))), r = Math.max(0, Math.min(1, j - i));
      return [pts[i * 2] + (pts[i * 2 + 2] - pts[i * 2]) * r, pts[i * 2 + 1] + (pts[i * 2 + 3] - pts[i * 2 + 1]) * r];
    };

    function draw() {
      if (!pts) return;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, canvas.width, canvas.height);
      g.drawImage(base, 0, 0);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.lineJoin = g.lineCap = 'round';
      const cur = complexAt(cmp, f);
      if (cur) {
        const s = spans(cmp)[cur.c];
        path(g, s.a, s.b);
        g.strokeStyle = Th.butter;
        g.globalAlpha = cur.on ? 1 : 0.4;
        g.lineWidth = 4;
        g.stroke();
        g.globalAlpha = 1;
      }
      g.font = '700 11px ' + FONT;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      labels.forEach((q) => {
        const hot = cur && cur.on && q.complex === cur.c;
        dot(q.x, q.y, 8, hot ? Th.butter : Th.deep, hot ? null : Th.line);
        g.fillStyle = hot ? Th.ink : Th.text2;
        g.fillText(q.text, q.x, q.y + 0.5);
      });
      // the other laps under the reference
      for (let k = cars.length - 1; k >= 0; k--) {
        const c = cars[k], p = at(c.j);
        if (c.ref) dot(p[0], p[1], 5.5, c.color, Th.deep);
        else dot(p[0], p[1], 4, c.color, Th.deep);
      }
      if (preview >= 0) {
        const p = at(preview);
        dot(p[0], p[1], 7, null, Th.text);
        dot(p[0], p[1], 2.5, Th.text);
      }
    }

    const local = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const show = (i) => {
      if (i === preview) return;
      preview = i;
      canvas.style.cursor = i >= 0 ? 'pointer' : '';
      o.onPreview(i);
    };
    const onMove = (e) => {
      if (!pts) return;
      const p = local(e), q = nearest(pts, p.x, p.y);
      show(drag || q.d <= HIT ? q.i : -1);
      // the corner's name, where the data has one, as the only tooltip
      const lb = labels.find((l) => Math.hypot(l.x - p.x, l.y - p.y) <= 10);
      const tip = (lb && lb.name) || '';
      if (canvas.title !== tip) canvas.title = tip;
    };
    const onDown = (e) => {
      if (!pts || e.button !== 0) return;
      drag = true;
      canvas.setPointerCapture(e.pointerId);
      onMove(e);
      e.preventDefault();
    };
    const onUp = () => {
      if (!drag) return;
      drag = false;
      const i = preview;
      show(-1);
      if (i >= 0) o.onPick(i);
    };
    const onLeave = () => !drag && show(-1);
    const onCancel = () => ((drag = false), show(-1));
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);
    canvas.addEventListener('pointerleave', onLeave);

    return {
      set(c) {
        cmp = c;
        preview = -1;
        layout();
        draw();
      },
      resize() {
        layout();
        draw();
      },
      update(fi, cs) {
        f = fi;
        cars = cs || [];
        draw();
      },
      /** Drop a preview without picking it (Esc). */
      cancel() {
        if (preview < 0 && !drag) return false;
        onCancel();
        return true;
      },
      current: () => (cmp ? complexAt(cmp, f) : null),
      destroy() {
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onCancel);
        canvas.removeEventListener('pointerleave', onLeave);
      },
    };
  }

  IST.Review.TrackMap = { create, spans, complexAt, nearest };
})();
