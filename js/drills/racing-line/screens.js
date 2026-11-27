/*
 * Draw the Line: the three screens. Drawing (the complex turned to run
 * up the screen, your strokes and what they'll be read as), the result (your
 * line against the ideal, corner by corner) and the replay (top-down, in-car
 * and speed trace, with a caption at each phase).
 *
 * createScreens(v) binds the running drill: v = { st, rows, S, scene, act:
 * { undo, clearAll, submit, startReplay, cycle, skipPhase, advance,
 * backToResult } }. Screens read the state and call back through act. The
 * only state they write is what input needs from the last frame: st.area
 * (the drawing area and its view) and st.buttons (hit boxes).
 */
(function () {
  'use strict';
  const U = IST.util, Sym = IST.Symbols, LL = IST.LineLab, RL = IST.RacingLine;
  const HW = LL.HW;
  const { COL, PH, OFF, PASS, ADVICE, kmh, sec, T, cornerText, issueText, sacrifices } = RL;
  const UI = IST.CanvasUI, { box, pane, caps, capsWidth, wrapText } = UI;

  RL.createScreens = function (v) {
    const { st, rows, S, scene } = v;
    const { undo, clearAll, submit, startReplay, cycle, skipPhase, advance, backToResult } = v.act;
    const button = (g, x, y, label, act, o) => UI.button(g, st.buttons, x, y, label, act, o);

    function header(g, W, title, sub, subColor) {
      const q = st.q;
      const shown = Math.min(S.questions, rows.length + (st.mode === 'draw' || st.mode === 'grading' ? 1 : 0));
      // like a card's .tag, then the context in the page's caps label style
      const n = 'Line ' + Math.max(1, shown) + ' / ' + S.questions;
      const tw = capsWidth(g, n, 11) + 14;
      g.fillStyle = COL.mint;
      g.fillRect(16, 16, tw, 20);
      caps(g, n, 23, 26.5, { size: 11, color: COL.ink, baseline: 'middle' });
      const lv = q && q.level ? q.level : st.level;
      caps(g, 'Level ' + lv + '  ·  pass ≤ ' + PASS[lv].toFixed(2) + ' s', 16 + tw + 12, 26.5, { size: 11, color: COL.dim, baseline: 'middle' });
      if (title) Sym.text(g, title, W / 2, 30, { align: 'center', size: Math.max(17, Math.min(24, W * 0.018)), weight: 720, shadow: false });
      if (sub) Sym.text(g, sub, W / 2, 52, { align: 'center', size: 13, weight: subColor ? 720 : 420, color: subColor || COL.text2, shadow: false });
    }

    function renderDraw(g, W, H, ts) {
      const q = st.q, grading = st.mode === 'grading';
      header(g, W, q.spec.name, 'Draw the fastest line to the end of the straight');
      const top = 64, bot = 46;
      const A = { x: 16, y: top, w: W - 32, h: H - top - bot };
      A.V = scene.view(q, 'draw', A.w, A.h, 30);
      st.area = A;
      // the border turns gold while a stroke is being drawn
      pane(g, A.x, A.y, A.w, A.h, { fill: COL.map, line: st.cur ? COL.quiz : null });
      g.translate(A.x, A.y);
      LL.drawTrack(g, q.geo, A.V, { bg: COL.map, fontSize: 13 });
      scene.gate(g, q, A.V, q.sStart, 'start');
      scene.gate(g, q, A.V, q.sStop, 'finish');
      // your strokes as drawn (red where off the road), then what they'll be read as
      scene.drawN(g, q, A.V, st.raw, { color: COL.drawn, width: 2, alpha: st.preview ? 0.4 : 0.85 });
      scene.drawN(g, q, A.V, st.raw, { color: COL.bad, width: 2.5, alpha: 0.9, keep: (v) => Math.abs(v) > OFF });
      if (st.preview && !st.cur) {
        // only over the stretch you've drawn
        let a = -1, b = -1;
        for (let i = A.V.i0; i <= A.V.i1; i++) {
          if (isNaN(st.raw[i])) continue;
          if (a < 0) a = i;
          b = i;
        }
        scene.drawN(g, q, A.V, st.preview, { color: COL.quiz, width: 3.2, keep: (v, i) => i >= a && i <= b });
      }
      g.restore();
      if (grading) {
        g.fillStyle = 'rgba(31,35,42,0.6)';
        g.fillRect(A.x, A.y, A.w, A.h);
        const dots = '.'.repeat(1 + (Math.floor(ts / 300) % 3));
        Sym.text(g, 'Reading your line' + dots, W / 2, A.y + A.h / 2, { align: 'center', baseline: 'middle', size: 20, weight: 820 });
        return;
      }
      // controls
      const by = H - bot + 10;
      let bx = 16;
      bx += button(g, bx, by, 'Undo  ↓', undo) + 8;
      bx += button(g, bx, by, 'Clear', clearAll) + 14;
      const cov = st.cov;
      Sym.text(g, cov.ok ? (cov.off > 8 ? 'Parts of it leave the road: the car will be kept on the edge there.' : 'Draw over any part to redo it.') : cov.msg, bx, by + 19, { size: 13, weight: 620, color: cov.ok && cov.off <= 8 ? COL.dim : COL.quiz });
      button(g, W - 16, by, 'Submit  (Space)', submit, { primary: true, right: true, disabled: !cov.ok });
    }

    function renderResult(g, W, H) {
      const q = st.q, L = q.user, I = q.ideal;
      const pass = q.pass;
      header(g, W, q.spec.name, q.grade + '  ·  ' + sec(L.loss) + ' to the ideal', pass ? COL.ideal : L.loss <= PASS[q.level] * 2.5 ? COL.quiz : COL.bad);
      const top = 64, bot = 46, gap = 12;
      const wide = W / H >= 1.15;
      const listH = wide ? H - top - bot : U.clamp(64 + L.verdict.length * 40, 150, H * 0.42);
      const mapW = wide ? Math.max(260, (W - 32 - gap) * 0.6) : W - 32;
      const mapH = wide ? H - top - bot : H - top - bot - listH - gap;
      // map: ideal, your drawing, your line
      pane(g, 16, top, mapW, mapH, { fill: COL.map });
      g.translate(16, top);
      const V = scene.view(q, 'res', mapW, mapH, 28);
      LL.drawTrack(g, q.geo, V, { bg: COL.map, fontSize: 12 });
      LL.drawLine(g, q.geo, V, I.sim, { color: COL.ideal, width: 3, alpha: 0.85 });
      scene.drawN(g, q, V, q.drawn, { color: COL.drawn, width: 1.5, alpha: 0.35 });
      LL.drawLine(g, q.geo, V, L.sim, { color: COL.pick, width: 3, from: V.win.sA + 28, to: V.win.sB - 28 });
      scene.phaseDots(g, q, V, I, { hollow: true });
      scene.phaseDots(g, q, V, L, {});
      g.restore();
      Sym.text(g, IST.Theme.names.ideal + ': ideal   ' + IST.Theme.names.pick + ': your line   faint: as drawn', 28, top + mapH - 12, { size: 11, color: COL.dim });
      // verdict list
      const lx = wide ? 16 + mapW + gap : 16, ly = wide ? top : top + mapH + gap, lw = wide ? W - 32 - mapW - gap : W - 32;
      box(g, lx, ly, lw, listH);
      let y = ly + 26;
      const tx = lx + 16, tw = lw - 32;
      L.verdict.forEach((r) => {
        const ok = !r.issues.length;
        const color = ok ? COL.ideal : r.cost > 0.04 ? COL.bad : COL.quiz;
        Sym.text(g, T(r.ci), tx, y, { size: 15, weight: 900, color });
        Sym.text(g, sec(r.cost), tx + tw, y, { align: 'right', size: 13, weight: 820, color: r.cost > 0.02 ? COL.bad : COL.dim });
        y += wrapText(g, cornerText(r), tx + 34, y, tw - 100, 13, 17, COL.text2, 3) * 17 + 12;
      });
      y += 4;
      g.fillStyle = COL.line;
      g.fillRect(tx, y - 12, tw, 1);
      y += wrapText(g, L.note, tx, y + 4, tw, 13, 17, COL.text, wide ? 6 : 3) * 17 + 8;
      if (q.offTrack > 8) wrapText(g, 'Parts of your drawing left the road; the car was kept on the edge there.', tx, y + 4, tw, 12, 16, COL.dim, 2);
      // controls
      const by = H - bot + 10;
      button(g, 16, by, 'Watch replay  ↑', () => startReplay(0));
      const last = rows.length >= S.questions;
      button(g, W - 16, by, last ? 'Finish  (Space)' : 'Next line  (Space)', advance, { primary: true, right: true });
    }

    function captionFor(q, L, ph) {
      const I = q.ideal;
      if (!ph) return { title: L.name + (L.isIdeal ? '' : '  ' + sec(L.loss)), text: L.note, color: scene.lineColor(L) };
      const P = PH[ph.kind];
      const vI = LL.sampleAt(I.sim.v, I.sim, ph.s), v = LL.sampleAt(L.sim.v, L.sim, ph.s);
      const dt = LL.timeAt(q.user.sim, ph.s) - LL.timeAt(I.sim, ph.s);
      let nums;
      if (ph.kind === 'apex') nums = 'Minimum ' + kmh(ph.vMin) + ' km/h' + (L.isIdeal ? ' · yours ' + kmh(q.user.corners[ph.ci].vMin) : ' · ideal ' + kmh(I.corners[ph.ci].vMin));
      else nums = kmh(v) + ' km/h' + (L.isIdeal ? '' : ' · ideal ' + kmh(vI));
      nums += ' · you ' + sec(dt);
      let text;
      const r = !L.isIdeal && ph.ci >= 0 ? L.verdict[ph.ci] : null;
      const here = r ? r.issues.filter((is) => is.phase === ph.kind || (ph.kind === 'apex' && (is.kind === 'early' || is.kind === 'late'))) : [];
      if (ph.kind === 'end') text = L.note;
      else if (here.length) text = here.map((is) => issueText(r, is)).join(' · ') + '. ' + ADVICE[here[0].kind];
      else text = phaseNote(q, L, ph);
      return { title: (ph.kind === 'end' ? P.label : T(ph.ci) + ' · ' + P.label) + '   ' + nums, text, color: P.color };
    }

    function phaseNote(q, L, ph) {
      const geo = q.geo, c = geo.corners[ph.ci], d = c.dir;
      const n = LL.sampleAt(L.n, L.sim, ph.s);
      const fromOut = Math.max(0, (1 - -d * n) * HW - 1), fromIn = Math.max(0, (1 - d * n) * HW - 1);
      const edge = (m, side) => (m < 0.6 ? 'on the ' + side + ' edge' : m.toFixed(1) + ' m in from the ' + side + ' edge');
      if (ph.kind === 'brake') return 'Hard on the brakes, in a straight line before the turn-in.';
      if (ph.kind === 'turnin') return 'Steering starts ' + edge(fromOut, 'outside') + '.';
      if (ph.kind === 'apex') {
        const frac = (ph.s - c.startPos) / (c.endPos - c.startPos);
        const where = frac > 0.55 ? 'late' : frac < 0.45 ? 'early' : 'mid-corner';
        const sac = L.isIdeal ? sacrifices(q).find((x) => x.ci === ph.ci) : null;
        return 'Apex ' + edge(fromIn, 'inside') + ', ' + where + ' (' + Math.round(U.clamp(frac, 0, 1) * 100) + '% through the bend).' + (sac ? ' ' + T(ph.ci) + ' is sacrificed: ' + Math.round(sac.dv) + ' km/h slower than its own fastest line, to set up ' + T(ph.ci + 1) + '.' : '');
      }
      if (ph.kind === 'exit') return 'Track-out ' + edge(fromOut, 'outside') + ', back on full throttle.';
      return '';
    }

    function renderReplay(g, W, H, ts) {
      const q = st.q, rp = st.rp, L = rp.line;
      header(g, W, q.spec.name, null);
      const top = 64, hint = 40, capH = 62, gap = 10;
      const traceH = U.clamp(H * 0.17, 80, 150);
      const mainH = Math.max(140, H - top - hint - capH - traceH - gap * 3);
      const tdW = U.clamp(W * 0.36, 220, 560);
      scene.renderTop(g, q, rp, 16, top, tdW, mainH, ts);
      scene.renderPOV(g, q, rp, 16 + tdW + gap, top, W - 32 - tdW - gap, mainH, ts);
      const cy = top + mainH + gap;
      const cap = captionFor(q, L, rp.hold > 0 || rp.done ? rp.cur : null);
      box(g, 16, cy, W - 32, capH, { accent: cap.color, side: 4 });
      Sym.text(g, cap.title, 30, cy + 22, { size: 15, weight: 720, color: cap.color, shadow: false });
      wrapText(g, cap.text, 30, cy + 43, W - 64, 13, 16, COL.text2, 2);
      scene.renderTrace(g, q, rp, 16, cy + capH + gap, W - 32, traceH);
      // controls
      const by = H - hint + 6;
      let bx = 16;
      bx += button(g, bx, by, L.isIdeal ? '◀ ▶  Your line' : '◀ ▶  Ideal line', cycle) + 8;
      bx += button(g, bx, by, rp.done ? 'Replay ↓' : rp.hold > 0 ? 'Continue ↑' : 'Next phase ↑', () => (rp.done ? startReplay(rp.li) : skipPhase())) + 8;
      button(g, bx, by, 'Back to result', backToResult);
      const last = rows.length >= S.questions;
      button(g, W - 16, by, last ? 'Finish  (Space)' : 'Next line  (Space)', advance, { primary: true, right: true });
    }

    return { header, renderDraw, renderResult, renderReplay };
  };
})();
