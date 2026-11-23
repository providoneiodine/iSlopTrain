/*
 * Draw the Line: turning your strokes into a line. Strokes are pointer
 * positions projected onto the track (s along the centreline, n across it);
 * st.raw holds the drawn lateral position per sample (NaN where nothing is
 * drawn, later strokes overwrite earlier ones), st.preview what it will be
 * read as, and st.cov whether it's complete enough to judge.
 *
 * createSketch(st) works on the drill's state: st.q (the question), st.raw,
 * st.strokes, st.area (the drawing area and its view, set by the drawing
 * screen) and st.mode.
 */
(function () {
  'use strict';
  const LL = IST.LineLab, RL = IST.RacingLine;
  const DS = LL.DS, OFF = RL.OFF;

  RL.createSketch = function (st) {
    function toTrack(x, y, hint, range) {
      const A = st.area, V = A.V;
      const w = V.unmap(x - A.x, y - A.y);
      if (hint == null) {
        hint = Math.round((V.i0 + V.i1) / 2);
        range = Math.ceil((V.i1 - V.i0) / 2);
      }
      return LL.project(st.q.geo, w[0], w[1], hint, range);
    }
    function writeSeg(p, q) {
      const raw = st.raw, V = st.area.V;
      const ia = Math.round(p.s / DS), ib = Math.round(q.s / DS);
      const lo = Math.max(V.i0, Math.min(ia, ib)), hi = Math.min(V.i1, Math.max(ia, ib));
      for (let i = lo; i <= hi; i++) raw[i] = ia === ib ? q.n : p.n + ((q.n - p.n) * (i - ia)) / (ib - ia);
    }
    function rebuild() {
      st.raw.fill(NaN);
      st.strokes.forEach((sk) => {
        if (sk.length === 1) writeSeg(sk[0], sk[0]);
        for (let k = 1; k < sk.length; k++) writeSeg(sk[k - 1], sk[k]);
      });
      refit();
    }
    function refit() {
      st.cov = coverage();
      const f = LL.fitDrawn(st.q.geo, st.raw);
      st.preview = f ? f.n : null;
    }
    /** Is the drawing complete enough to judge? */
    function coverage() {
      const q = st.q, raw = st.raw, win = LL.windowOf(q.geo);
      const V = { i0: Math.round(win.sA / DS), i1: Math.round(win.sB / DS) };
      const a = Math.round(q.sStart / DS), b = Math.round(q.sStop / DS);
      let first = -1, last = -1, prev = -1, maxGap = 0, off = 0;
      for (let i = V.i0; i <= V.i1; i++) {
        if (isNaN(raw[i])) continue;
        if (first < 0) first = i;
        last = i;
        if (prev >= 0 && i >= a && prev <= b) maxGap = Math.max(maxGap, i - prev);
        prev = i;
        if (Math.abs(raw[i]) > OFF) off++;
      }
      const r = { ok: false, off: off * DS };
      if (first < 0) r.msg = 'Draw your line from the arrow to the straight';
      else if (first > a) r.msg = 'Start your line further back, on the approach';
      else if (last < b) r.msg = 'Carry your line on onto the straight';
      else if (maxGap * DS > 30) r.msg = 'Fill the gap in your line';
      else r.ok = true;
      return r;
    }
    function undo() {
      if (st.mode !== 'draw' || !st.strokes.length) return;
      st.strokes.pop();
      rebuild();
    }
    function clearAll() {
      if (st.mode !== 'draw') return;
      st.strokes = [];
      rebuild();
    }

    return { toTrack, writeSeg, refit, coverage, undo, clearAll };
  };
})();
