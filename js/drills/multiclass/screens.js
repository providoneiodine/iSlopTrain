/*
 * Class Traffic: the three screens. The rule-set picker, the quiz
 * (in-car view and map of the run-up on a loop, the question panel with the
 * numbers you decide from and the answers, then the verdict), and the replay
 * of any option with captions and a gap trace.
 *
 * createScreens(v) binds the running drill: v = { st, rows, S, ctx,
 * timeLimit, scene, act: { cycle, startReplay, skipPhase, advance,
 * wantsReplay } }. Screens read the state and call back through act; they
 * don't change the session themselves.
 */
(function () {
  'use strict';
  const U = IST.util, Sym = IST.Symbols, LL = IST.LineLab, TL = IST.TrafficLab, MC = IST.Multiclass;
  const CARLEN = TL.CARLEN, CARW = TL.CARW;
  const { COL, LEADUP, DECIDE_HOLD, RULE_IDS, EV, GRADES, kmh, m1 } = MC;
  const { wrapText, box, caps, capsWidth, chip, chipWidth, keycap, countLines } = MC.ui;
  const { at } = MC.replay;

  MC.createScreens = function (v) {
    const { st, rows, S, ctx, timeLimit, scene } = v;
    const { cycle, startReplay, skipPhase, advance, wantsReplay } = v.act;
    const nOpts = () => (st.q ? st.q.opts.length : 4);
    const button = (g, x, y, label, act, o) => MC.ui.button(g, st.buttons, x, y, label, act, o);

    function header(g, W, title, sub) {
      const q = st.q;
      if (st.mode !== 'rules') {
        // like a card's .tag, then the context in the page's caps label style
        const qs = 'Q ' + Math.min(S.questions, rows.length + (st.mode === 'question' ? 1 : 0)) + ' / ' + S.questions;
        const tw = capsWidth(g, qs, 11) + 14;
        g.fillStyle = COL.mint;
        g.fillRect(16, 16, tw, 20);
        caps(g, qs, 23, 26.5, { size: 11, color: COL.ink, baseline: 'middle' });
        caps(g, 'Level ' + (q ? q.level : st.level) + (st.rules ? '  ·  ' + TL.RULES[st.rules].short : ''), 16 + tw + 12, 26.5, { size: 11, color: COL.dim, baseline: 'middle' });
      }
      if (title) Sym.text(g, title, W / 2, 30, { align: 'center', size: Math.max(17, Math.min(24, W * 0.018)), weight: 720, shadow: false });
      if (sub) Sym.text(g, sub, W / 2, 52, { align: 'center', size: 13, weight: 420, color: COL.text2, shadow: false });
    }

    // rules picker: three cards, like the menu's
    function renderRules(g, W, H) {
      header(g, W, 'Class Traffic: pick the rules', 'Blue flags and overtaking. The physics is the same; what the slower car owes the faster one changes.');
      const n = 3, gap = 18, narrow = W < 760;
      const cw = narrow ? Math.min(560, W - 32) : Math.min(340, (W - 32 - gap * 2) / 3), ch = narrow ? Math.min(150, (H - 170) / 3 - gap) : Math.min(250, H - 200);
      const x0 = narrow ? (W - cw) / 2 : (W - (cw * 3 + gap * 2)) / 2, y0 = narrow ? 76 : Math.max(80, (H - ch) / 2 - 10);
      const accents = [COL.mint, COL.fast, COL.lilac];
      for (let i = 0; i < n; i++) {
        const R = TL.RULES[RULE_IDS[i]], sel = i === st.ruleSel;
        let x = narrow ? x0 : x0 + i * (cw + gap), y = narrow ? y0 + i * (ch + gap) : y0;
        if (sel) {
          x -= 2;
          y -= 2;
        }
        box(g, x, y, cw, ch, { accent: accents[i], shadow: sel ? 6 : 4, line: sel ? COL.quiz : COL.line });
        if (sel) {
          g.lineWidth = 2;
          g.strokeStyle = COL.quiz;
          g.strokeRect(x + 1, y + 1, cw - 2, ch - 2);
        }
        keycap(g, i + 1, x + 16, y + 18, 24, sel);
        Sym.text(g, R.name, x + 50, y + 36, { size: 18, weight: 720, color: COL.text, shadow: false });
        const lines = wrapText(g, R.text, x + 16, y + 64, cw - 32, 13, 18, COL.text2, narrow ? 3 : 7);
        wrapText(g, R.like, x + 16, y + 72 + lines * 18, cw - 32, 12, 16, COL.dim, 2);
        st.buttons.push({ x, y, w: cw, h: ch, rule: i });
      }
      Sym.text(g, '← →  choose   ·   Space  start   ·   or click a rule set   ·   Info on the menu card explains the differences', W / 2, H - 14, { align: 'center', size: 13, color: COL.dim, shadow: false });
    }

    /** The numbers you decide from, as tiles: label, value, small print. */
    function situationTiles(q) {
      const fast = q.role === 'fast', gap = q.gap, tg = (gap + CARLEN) / q.vF0;
      const brake = Math.round((fast ? q.X.bF - q.sF0 : q.X.bS - q.sS0) / 10) * 10;
      const out = [
        { k: fast ? 'GAP AHEAD' : 'GAP BEHIND', v: Math.round(gap) + ' m', s: tg.toFixed(2) + ' s' },
        { k: 'CLOSING', v: '+' + kmh(q.vF0 - q.vS0), s: 'km/h' },
        { k: 'BRAKING ZONE', v: brake + ' m', s: 'ahead' },
      ];
      if (!fast) out.push(q.type === 'behind' ? { k: 'MIRROR', v: 'Behind', s: 'right on you' } : { k: 'MIRROR', v: 'Pulled out', s: 'to your ' + q.side });
      return out;
    }

    /**
     * Quiz layout. Wide screens: the scene (in-car view over the map) on the left and
     * a question panel on the right with the answers as one readable column. Narrow
     * screens: the scene as a strip on top and the panel under it, answers in two columns.
     */
    function quizLayout(W, H) {
      const top = 58, pad = 16, gap = 12, hint = 28, bodyH = H - top - hint;
      if (W >= 900 && W / H >= 1.15) {
        const pw = Math.round(U.clamp(W * 0.37, 380, 560)), px = W - pad - pw, sw = px - gap - pad;
        const povH = Math.round((bodyH - gap) * 0.6);
        return {
          side: true, cols: 1,
          pov: [pad, top, sw, povH], map: [pad, top + povH + gap, sw, bodyH - povH - gap],
          panel: [px, top, pw, bodyH],
        };
      }
      // the scene takes whatever the panel doesn't need (answers top out at 118 px tall)
      const cols = W < 560 ? 1 : 2, rows = Math.ceil(nOpts() / cols);
      const sh = Math.round(U.clamp(bodyH - gap - (215 + rows * 126), 170, 440)), povW = Math.round((W - pad * 2 - gap) * 0.58);
      return {
        side: false, cols,
        pov: [pad, top, povW, sh], map: [pad + povW + gap, top, W - pad * 2 - povW - gap, sh],
        panel: [pad, top + sh + gap, W - pad * 2, bodyH - sh - gap],
      };
    }

    function drawAnswer(g, q, i, x, y, w, h) {
      const o = q.opts[q.order[i]];
      const reveal = st.mode !== 'question';
      const sel = !reveal && i === st.sel, picked = reveal && i === st.pick;
      const faded = reveal && !o.correct && !picked;
      const accent = picked ? (o.correct ? COL.good : COL.bad) : reveal && o.correct ? COL.good : sel ? COL.quiz : null;
      const big = h >= 84, ls = big ? 17 : 15, ss = big ? 14 : 12.5, lh = ss + 5;
      // the selected answer lifts like a hovered menu card
      if (sel) {
        x -= 2;
        y -= 2;
      }
      box(g, x, y, w, h, { fill: sel ? COL.panel2 : faded ? COL.deep : COL.panel, line: accent || COL.line, shadow: faded ? 2 : sel ? 6 : 4, accent, side: accent ? 5 : 0 });
      const bs = big ? 28 : 24, bx = x + 16, by = y + 12;
      keycap(g, i + 1, bx, by, bs, sel);
      const tx = bx + bs + 12, tw = w - (tx - x) - 14;
      // verdict chip beside the label if there's room, otherwise on its own line under it
      let drop = 0;
      if (reveal) {
        const cs = big ? 10.5 : 9.5, ch = Math.round(cs + 11);
        const cw = chipWidth(g, o.tag.text, cs);
        g.font = '720 ' + ls + 'px ' + Sym.FONT;
        const lw = g.measureText(o.label).width;
        if (tx + lw + 14 + cw <= x + w - 12) chip(g, o.tag.kind, o.tag.text, x + w - 12, by + bs / 2 - ch / 2, o.tag.color, { right: true, size: cs });
        else {
          chip(g, o.tag.kind, o.tag.text, tx, by + bs + 4, o.tag.color, { size: cs });
          drop = ch + 6;
        }
      }
      Sym.text(g, o.label, tx, by + bs / 2 + ls * 0.36, { size: ls, weight: 720, color: faded ? COL.dim : COL.text, shadow: false });
      // body text: the largest size (down to 11 px) at which all of it fits the row
      const body = reveal ? o.note : o.sub;
      let fs = ss, flh = lh, fty = 0, fl = 1;
      for (const size of [ss, ss - 1, ss - 2, 11]) {
        fs = Math.max(11, size);
        flh = fs + 4;
        fty = by + bs + 5 + drop + fs * 0.8;
        fl = Math.max(1, Math.floor((y + h - 7 - (picked ? 11 : 0) - fty) / flh) + 1);
        if (countLines(g, body, tw, fs) <= fl) break;
      }
      wrapText(g, body, tx, fty, tw, fs, flh, reveal && !faded ? COL.text2 : COL.dim, fl, 420);
      if (picked) caps(g, 'Your pick', x + w - 14, y + h - 10, { align: 'right', size: 9.5, color: accent });
      st.buttons.push({ x, y, w, h, panel: i });
    }

    function renderPanel(g, q, x, y, w, h, cols) {
      const fast = q.role === 'fast', reveal = st.mode !== 'question', pad = 18;
      box(g, x, y, w, h, { accent: COL.mint });
      let cy = y + pad + 4;
      // who you are, under which rules
      chip(g, fast ? 'fast' : 'slow', fast ? 'You: Prototype' : 'You: GT', x + pad, cy, fast ? COL.fast : COL.slow, { size: 10.5 });
      caps(g, TL.RULES[q.rules].name, x + w - pad, cy + 11, { align: 'right', size: 10.5, color: COL.dim, baseline: 'middle' });
      cy += 36;
      // the question, or the verdict
      const qs = U.clamp(w * 0.042, 18, 23);
      if (!reveal) {
        Sym.text(g, fast ? 'A GT is ahead of you.' : 'A prototype is closing on you.', x + pad, cy + qs * 0.62, { size: qs * 0.72, weight: 420, color: COL.text2, shadow: false });
        cy += qs * 1.05;
        Sym.text(g, 'What\'s the responsible move?', x + pad, cy + qs * 0.85, { size: qs, weight: 720, color: COL.text, shadow: false });
        cy += qs * 1.4;
        // what "best" means here, spelled out
        const rule = fast ? (q.rules === 'pointby' ? ', passing only where point-by allows' : '') : q.rules !== 'hold' ? ', without holding the prototype up' : '';
        const crit = 'Best = the fastest move for you with no contact risk' + rule + '. Safe answers close to it earn partial credit.';
        const cl = wrapText(g, crit, x + pad, cy + 4, w - pad * 2, 12.5, 16, COL.dim, 2, 420);
        cy += cl * 16 + 4;
        if (timeLimit) {
          const left = U.clamp(1 - (ctx.clock() - st.tMode) / (timeLimit * 1000), 0, 1);
          g.fillStyle = COL.deep;
          g.fillRect(x + pad, cy, w - pad * 2, 5);
          g.fillStyle = left < 0.25 ? COL.bad : COL.quiz;
          g.fillRect(x + pad, cy, (w - pad * 2) * left, 5);
          cy += 11;
        }
      } else {
        const o = st.pick >= 0 ? q.opts[q.order[st.pick]] : null, gr = o ? o.grade : 'risky';
        const vc = gr === 'best' || gr === 'close' ? COL.good : gr === 'risky' ? COL.bad : COL.warn;
        Sym.text(g, !o ? 'Out of time' : GRADES[gr].title, x + pad, cy + qs * 0.9, { size: qs * 1.1, weight: 720, color: vc, shadow: false });
        caps(g, 'Credit ' + Math.round((o ? o.credit : 0) * 100) + '%', x + w - pad, cy + qs * 0.9, { align: 'right', size: 11, color: vc });
        cy += qs * 1.35;
        const why = !o ? 'The best call: ' + q.best.label + '.'
          : gr === 'best' ? 'The fastest move with no risk under these rules.'
          : gr === 'close' ? 'Safe and allowed, only ' + o.cost.toFixed(2) + ' s off the best: ' + q.best.label + '.'
          : gr === 'safe' ? 'Safe, but ' + o.cost.toFixed(2) + ' s slower than the best: ' + q.best.label + '.'
          : gr === 'held' ? 'Safe, but these rules say let it by. Best: ' + q.best.label + '.'
          : 'Too risky or not allowed. The best call: ' + q.best.label + '.';
        const wl = wrapText(g, why, x + pad, cy + 12, w - pad * 2, 13.5, 18, COL.text2, 2, 420);
        cy += 10 + wl * 18;
      }
      // the numbers you decide from, in the menu card's stat strip style
      const T = situationTiles(q), tg = 8, tw = (w - pad * 2 - tg * (T.length - 1)) / T.length, th = 58;
      T.forEach((t, k) => {
        const tx = x + pad + k * (tw + tg);
        box(g, tx, cy, tw, th, { fill: COL.deep, shadow: 0 });
        caps(g, t.k, tx + 10, cy + 16, { size: 9, color: COL.dim });
        g.font = '720 20px ' + Sym.FONT;
        const vw = g.measureText(t.v).width;
        const vs = vw > tw - 20 ? Math.max(12, (20 * (tw - 20)) / vw) : 20;
        Sym.text(g, t.v, tx + 10, cy + 39, { size: vs, weight: 720, color: COL.text, shadow: false });
        Sym.text(g, t.s, tx + 10, cy + 52, { size: 11, weight: 420, color: COL.dim, shadow: false });
      });
      cy += th + 16;
      // answers: as tall as the panel allows, so the text can be read at a glance
      const n = q.opts.length, rows = Math.ceil(n / cols), gap = 10;
      const aw = (w - pad * 2 - gap * (cols - 1) - 4) / cols;
      const ah = Math.min(118, (y + h - pad - 4 - cy - gap * (rows - 1)) / rows);
      for (let i = 0; i < n; i++) {
        const c = i % cols, r = Math.floor(i / cols);
        drawAnswer(g, q, i, x + pad + c * (aw + gap), cy + r * (ah + gap), aw, ah);
      }
    }

    function renderQuiz(g, W, H, ts) {
      const q = st.q, fast = q.role === 'fast';
      header(g, W, null, null);
      const L = quizLayout(W, H);
      const sel = st.mode === 'question' ? q.opts[q.order[st.sel]] : st.pick >= 0 ? q.opts[q.order[st.pick]] : q.best;
      // the last couple of seconds before the decision, looped with a hold on the decision frame
      const cyc = (ts / 1000) % (LEADUP + DECIDE_HOLD), tt = Math.min(0, cyc - LEADUP), live = tt < 0;
      const at0 = (plan, s0) => {
        const s = LL.posAtTime(plan.sim, LL.timeAt(plan.sim, s0) + tt);
        return { s, l: TL.latAt(plan, s), v: TL.vAt(plan, s) };
      };
      const cf = at0(sel.fp, q.sF0), cs = at0(sel.sp, q.sS0);
      const P = {
        sF: cf.s, lF: cf.l, vF: cf.v, sS: cs.s, lS: cs.l, vS: cs.v,
        fp: sel.fp, sp: sel.sp, braking: false,
        hud: (g2, w) => {
          if (live) {
            g2.fillStyle = COL.bad;
            g2.globalAlpha = 0.6 + 0.4 * Math.sin(ts / 140);
            g2.fillRect(14, 16, 8, 8);
            g2.globalAlpha = 1;
            caps(g2, 'Closing in  ' + (-tt).toFixed(1) + ' s', 28, 21, { size: 10.5, color: COL.text, baseline: 'middle' });
          } else chip(g2, 'hard', 'Decide now', 12, 11, COL.quiz, { size: 10.5 });
          void w;
        },
      };
      scene.renderPOV(g, q, L.pov[0], L.pov[1], L.pov[2], L.pov[3], ts, P);
      scene.renderMap(g, q, L.map[0], L.map[1], L.map[2], L.map[3], {
        sF: P.sF, lF: P.lF, sS: P.sS, lS: P.lS,
        paths: [{ plan: fast ? sel.fp : sel.sp, from: fast ? q.sF0 : q.sS0, color: fast ? COL.fast : COL.slow, dash: [7, 5], alpha: 0.85 }],
      });
      if (L.map[2] >= 560) Sym.text(g, 'Dashed: your path for the highlighted answer', L.map[0] + L.map[2] - 12, L.map[1] + L.map[3] - 12, { align: 'right', size: 11, weight: 600, color: COL.dim });
      renderPanel(g, q, L.panel[0], L.panel[1], L.panel[2], L.panel[3], L.cols);
      if (st.mode === 'question') {
        const fade = U.clamp((ctx.clock() - st.tMode) / 250, 0, 1);
        if (fade < 1) {
          g.fillStyle = 'rgba(12,16,14,' + (1 - fade).toFixed(3) + ')';
          g.fillRect(0, 56, W, H - 56);
        }
        Sym.text(g, (L.cols === 1 ? '↑ ↓' : '← ↑ ↓ →') + '  choose   ·   Space  lock in   ·   or click an answer', W / 2, H - 10, { align: 'center', size: 13, color: COL.dim });
      } else {
        Sym.text(g, 'Space  ' + (wantsReplay() ? 'replay' : 'next') + '   ·   ← →  replay any answer', W / 2, H - 10, { align: 'center', size: 13, color: COL.dim });
      }
    }

    function relation(q, p) {
      const ds = p.sF - p.sS, gapLat = Math.abs(p.lF - p.lS) - CARW;
      if (Math.abs(ds) < CARLEN) {
        const inside = (p.lF - p.lS) * q.X.dir > 0 ? 'inside' : 'outside';
        return 'Side by side: prototype on the ' + inside + ', ' + Math.max(0, gapLat).toFixed(1) + ' m between the cars.';
      }
      const g = Math.abs(ds) - CARLEN, t = g / Math.max(1, ds > 0 ? p.vS : p.vF);
      return ds > 0 ? 'Prototype ' + m1(g) + ' m ahead of the GT (' + t.toFixed(2) + ' s).' : 'Prototype ' + m1(g) + ' m behind the GT (' + t.toFixed(2) + ' s).';
    }

    function captionFor(q, o, e, p) {
      if (!e) return { title: o.label + '   ' + o.tag.text, text: o.note, color: o.tag.color };
      const E = EV[e.kind];
      const nums = 'Prototype ' + kmh(p.vF) + ' km/h · GT ' + kmh(p.vS) + ' km/h';
      const T = e.ci >= 0 && (e.kind === 'apex' || e.kind === 'exit') ? 'T' + (e.ci + 1) + ' · ' : e.kind === 'turnin' ? 'T1 · ' : '';
      let text = relation(q, p);
      if (e.kind === 'end') text = o.note;
      else if (e.kind === 'contact' || e.kind === 'squeeze' || e.kind === 'cut' || e.kind === 'hard') text = o.note;
      else if (e.kind === 'turnin') text = relation(q, p) + (Math.abs(p.sF - p.sS) < CARLEN ? ' Whoever turns in now has to leave room.' : '');
      return { title: T + E.label + '   ' + nums, text, color: E.color };
    }

    function renderTrace(g, x, y, w, h, o, t) {
      const R = o.r.rec, tEnd = st.rp.ev[st.rp.ev.length - 1].t;
      const lim = 40;
      const px = (tt) => x + 44 + (tt / Math.max(0.1, tEnd)) * (w - 56);
      const py = (d) => y + h / 2 - (U.clamp(d, -lim, lim) / lim) * (h / 2 - 10);
      box(g, x, y, w, h);
      g.save();
      // alongside band
      g.fillStyle = 'rgba(246,217,143,0.12)';
      g.fillRect(x + 44, py(CARLEN), w - 56, py(-CARLEN) - py(CARLEN));
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(x + 44, py(0), w - 56, 1);
      Sym.text(g, 'ahead', x + 38, y + 16, { align: 'right', size: 10, color: COL.dim, shadow: false });
      Sym.text(g, 'behind', x + 38, y + h - 8, { align: 'right', size: 10, color: COL.dim, shadow: false });
      Sym.text(g, 'side by side', x + 50, py(0) - 4, { size: 10, color: 'rgba(246,217,143,0.7)', shadow: false });
      st.rp.ev.forEach((e) => {
        if (e.kind === 'end') return;
        const xx = px(e.t), E = EV[e.kind];
        g.fillStyle = E.color;
        g.globalAlpha = 0.4;
        g.fillRect(xx, y + 8, 1, h - 16);
        g.globalAlpha = 1;
      });
      g.beginPath();
      for (let i = 0; i < R.n; i += 3) {
        if (R.t[i] > tEnd) break;
        const xx = px(R.t[i]), yy = py(R.sF[i] - R.sS[i]);
        if (i === 0) g.moveTo(xx, yy);
        else g.lineTo(xx, yy);
      }
      g.strokeStyle = COL.fast;
      g.lineWidth = 2.2;
      g.stroke();
      g.fillStyle = '#ffffff';
      g.fillRect(px(t), y + 6, 1.5, h - 12);
      Sym.text(g, 'Prototype vs GT (m)', x + w - 10, y + 16, { align: 'right', size: 10, weight: 700, color: COL.dim, shadow: false });
      g.restore();
    }

    function renderReplay(g, W, H, ts) {
      const q = st.q, rp = st.rp, o = rp.o, R = o.r.rec;
      header(g, W, q.role === 'fast' ? 'You\'re in the prototype' : 'You\'re in the GT', null);
      const p = at(R, rp.t);
      const top = 64, hint = 40, capH = 62, gap = 10;
      const traceH = U.clamp(H * 0.15, 70, 130);
      const mainH = Math.max(140, H - top - hint - capH - traceH - gap * 3);
      const tdW = U.clamp(W * 0.36, 220, 560);
      scene.renderMap(g, q, 16, top, tdW, mainH, {
        sF: p.sF, lF: p.lF, sS: p.sS, lS: p.lS,
        paths: [
          { plan: o.fp, from: q.sF0, color: COL.fast, width: 2, alpha: 0.35, dash: [5, 5] },
          { plan: o.sp, from: q.sS0, color: COL.slow, width: 2, alpha: 0.35, dash: [5, 5] },
        ],
        trails: [
          { plan: o.fp, from: q.sF0, to: p.sF, color: COL.fast },
          { plan: o.sp, from: q.sS0, to: p.sS, color: COL.slow },
        ],
        mark: rp.cur && rp.hold > 0 && (rp.cur.kind === 'contact' || rp.cur.kind === 'squeeze' || rp.cur.kind === 'cut' || rp.cur.kind === 'hard') ? { s: (p.sF + p.sS) / 2, lat: (p.lF + p.lS) / 2, color: EV[rp.cur.kind].color } : null,
      });
      const i1 = Math.min(R.n - 1, p.i + 8);
      scene.renderPOV(g, q, 16 + tdW + gap, top, W - 32 - tdW - gap, mainH, ts, {
        sF: p.sF, lF: p.lF, vF: p.vF, sS: p.sS, lS: p.lS, vS: p.vS, fp: o.fp, sp: o.sp,
        braking: q.me === 'F' ? R.vS[i1] < p.vS - 0.3 : R.vF[i1] < p.vF - 0.3,
        hud: (g2, w, h) => {
          Sym.text(g2, o.label, 14, h - 40, { size: 15, weight: 820, color: q.me === 'F' ? COL.fast : COL.slow });
          Sym.text(g2, o.tag.text, 14, h - 20, { size: 12, weight: 720, color: o.tag.color });
          if (rp.cur && rp.hold > 0) {
            const E = EV[rp.cur.kind];
            const age = (performance.now() - rp.curAt) / 180, sc = 1 + 0.25 * Math.max(0, 1 - age);
            Sym.text(g2, E.label.toUpperCase(), w / 2, h * 0.3, { align: 'center', baseline: 'middle', size: Math.round(Math.max(20, Math.min(34, w * 0.04)) * sc), weight: 820, color: E.color });
          }
        },
      });
      const cy = top + mainH + gap;
      const cap = captionFor(q, o, rp.hold > 0 || rp.done ? rp.cur : null, p);
      box(g, 16, cy, W - 32, capH, { accent: cap.color, side: 5 });
      Sym.text(g, cap.title, 32, cy + 22, { size: 15, weight: 720, color: cap.color, shadow: false });
      wrapText(g, cap.text, 32, cy + 43, W - 66, 13, 16, COL.text2, 2);
      renderTrace(g, 16, cy + capH + gap, W - 32, traceH, o, rp.t);
      // controls
      const by = H - hint + 6;
      const k = q.order.indexOf(rp.oi);
      let bx = 16;
      bx += button(g, bx, by, '◀', () => cycle(-1)) + 6;
      g.font = '720 13px ' + Sym.FONT;
      const lbl = 'Option ' + (k + 1) + ' / ' + q.opts.length + (st.pick >= 0 && q.order[st.pick] === rp.oi ? '  (your pick)' : '');
      Sym.text(g, lbl, bx + 4, by + 19, { size: 13, weight: 720, color: o.tag.color });
      bx += g.measureText(lbl).width + 14;
      bx += button(g, bx, by, '▶', () => cycle(1)) + 14;
      button(g, bx, by, rp.done ? 'Replay ↓' : rp.hold > 0 ? 'Continue ↑' : 'Next event ↑', () => (rp.done ? startReplay(rp.oi) : skipPhase()));
      const last = rows.length >= S.questions;
      button(g, W - 16, by, last ? 'Finish  (Space)' : 'Next question  (Space)', advance, { primary: true, right: true });
    }

    return { header, renderRules, renderQuiz, renderReplay, quizLayout };
  };
})();
