/*
 * Draw the Line: what the lines are drawn on. Profiles and gates on
 * the top-down view, phase markers, and the replay views: the top-down map
 * with both cars, the in-car view with the lines painted on the road and
 * marker posts at each phase, and the speed trace.
 *
 * createScene(env) binds the run's view settings: env = { S (drill
 * settings), VIEW, SEAT, CP (cockpit or null) }. Everything else comes in
 * as arguments: q (the question) and rp (the replay state).
 */
(function () {
  'use strict';
  const U = IST.util, Sym = IST.Symbols, LL = IST.LineLab, RL = IST.RacingLine;
  const HW = LL.HW, DS = LL.DS;
  const { COL, PH, kmh, sec, T } = RL;
  const { panel, outline } = RL.ui;

  RL.createScene = function (env) {
    const { S, VIEW, SEAT, CP } = env;

    /** The drawing view turns the complex to run up the screen; later views keep that orientation. */
    function view(q, key, w, h, pad) {
      const k = key + ':' + Math.round(w) + 'x' + Math.round(h);
      const o = key === 'draw' ? { upright: q.sStart } : q.rot != null ? { rot: q.rot } : null;
      return q.views[k] || (q.views[k] = LL.fitView(q.geo, w, h, pad, null, o));
    }

    /** Stroke a lateral profile n (NaN = gap); keep(i) picks samples. */
    function drawN(g, q, V, n, o) {
      const geo = q.geo;
      g.save();
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.strokeStyle = o.color;
      g.lineWidth = o.width;
      g.globalAlpha = o.alpha == null ? 1 : o.alpha;
      if (o.dash) g.setLineDash(o.dash);
      g.beginPath();
      let pen = false;
      for (let i = V.i0; i <= V.i1; i++) {
        const v = n[i];
        if (isNaN(v) || (o.keep && !o.keep(v, i))) {
          pen = false;
          continue;
        }
        const p = V.map(geo.cx[i] + v * HW * geo.nx[i], geo.cy[i] + v * HW * geo.ny[i]);
        if (!pen) {
          g.moveTo(p[0], p[1]);
          pen = true;
        } else g.lineTo(p[0], p[1]);
      }
      g.stroke();
      g.restore();
    }

    /** A dashed bar across the road at s, with a small label. */
    function gate(g, q, V, s, label) {
      const geo = q.geo, i = Math.round(s / DS);
      const a = V.map(geo.cx[i] - 1.15 * HW * geo.nx[i], geo.cy[i] - 1.15 * HW * geo.ny[i]);
      const b = V.map(geo.cx[i] + 1.15 * HW * geo.nx[i], geo.cy[i] + 1.15 * HW * geo.ny[i]);
      g.save();
      g.setLineDash([4, 4]);
      g.strokeStyle = 'rgba(255,255,255,0.55)';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(a[0], a[1]);
      g.lineTo(b[0], b[1]);
      g.stroke();
      g.restore();
      const ox = b[0] + (b[0] - a[0]) * 0.18, oy = b[1] + (b[1] - a[1]) * 0.18;
      Sym.text(g, label, U.clamp(ox, 24, V.w - 24), U.clamp(oy, 10, V.h - 6), { align: 'center', baseline: 'middle', size: 11, weight: 720, color: COL.dim, shadow: false });
    }

    function phaseDots(g, q, V, L, o) {
      const geo = q.geo;
      L.ph.forEach((ph) => {
        if (ph.kind === 'end' || ph.kind === 'brake' || ph.s < V.win.sA) return;
        const p = LL.pointAt(geo, V, L.sim, ph.s), P = PH[ph.kind];
        if (o.hollow) {
          Sym.ring(g, p[0], p[1], 5, P.color, 2);
          return;
        }
        g.beginPath();
        g.arc(p[0], p[1], 7, 0, Math.PI * 2);
        g.fillStyle = P.color;
        g.fill();
        Sym.text(g, P.short, p[0], p[1] + 0.5, { align: 'center', baseline: 'middle', size: 9, weight: 900, color: '#101215', shadow: false });
      });
    }

    function lineColor(L) {
      return L.isIdeal ? COL.ideal : COL.pick;
    }

    function drawRibbon(g, q, R, L, from, color, alpha, width) {
      const geo = q.geo;
      let prev = null;
      g.save();
      g.strokeStyle = color;
      g.globalAlpha = alpha;
      g.lineCap = 'round';
      for (let s = from + 2.5; s < from + 420; s += 2.5) {
        const n = LL.sampleAt(L.n, L.sim, Math.min(s, geo.sEnd));
        const p = R.project(s, n * HW, 0.03);
        if (!p) {
          prev = null;
          continue;
        }
        if (prev) {
          g.lineWidth = U.clamp(width * p.s, 1, 9);
          g.beginPath();
          g.moveTo(prev.x, prev.y);
          g.lineTo(p.x, p.y);
          g.stroke();
        }
        prev = p;
      }
      g.restore();
    }

    function drawPost(g, pr, ph, active, ts) {
      const s = pr.s, size = Math.max(5, 0.95 * s), hgt = 2.1 * s;
      if (size < 4 || pr.y < 0) return;
      const P = PH[ph.kind];
      g.globalAlpha = 1 - pr.fog * 0.5;
      g.fillStyle = '#d5d7db';
      g.fillRect(pr.x - Math.max(1, 0.06 * s), pr.y - hgt, Math.max(1.5, 0.12 * s), hgt);
      const by = pr.y - hgt - size;
      if (active) {
        const pulse = 0.5 + 0.5 * Math.sin(ts / 120);
        g.shadowColor = P.color;
        g.shadowBlur = 10 + pulse * 14;
      }
      Sym.roundRect(g, pr.x - size / 2, by, size, size, size * 0.18);
      g.fillStyle = P.color;
      g.fill();
      g.shadowBlur = 0;
      if (size >= 9) Sym.text(g, P.short, pr.x, by + size / 2 + 0.5, { align: 'center', baseline: 'middle', size: Math.round(size * 0.62), weight: 900, color: '#101215', shadow: false });
      g.globalAlpha = 1;
    }

    function renderPOV(g, q, rp, x, y, w, h, ts) {
      const L = rp.line, geo = q.geo;
      if (!q.R) q.R = new IST.TrackRenderer(geo, { theme: S.style });
      const R = q.R;
      const s = rp.s;
      const n = LL.sampleAt(L.n, L.sim, s);
      const dn = (LL.sampleAt(L.n, L.sim, s + 3) - LL.sampleAt(L.n, L.sim, Math.max(0, s - 3))) / 6;
      const cam = { pos: s, x: n * HW, heading: 0, yaw: Math.atan(dn * HW) };
      const gs = LL.posAtTime(rp.ghost.sim, rp.gt0 + (rp.t - rp.t0));
      const sprites = [];
      rp.line.ph.forEach((ph) => {
        if (ph.kind === 'end' || ph.s < s + 2) return;
        const c = geo.corners[ph.ci];
        const side = ph.kind === 'apex' ? c.dir : -c.dir;
        const active = rp.cur === ph && rp.hold > 0;
        sprites.push({ pos: ph.s, x: side * (HW + 1.6), draw: (g2, pr) => drawPost(g2, pr, ph, active, ts) });
      });
      if (gs > s + 4) {
        const gn = LL.sampleAt(rp.ghost.n, rp.ghost.sim, gs);
        const braking = LL.sampleAt(rp.ghost.sim.v, rp.ghost.sim, gs + 4) < LL.sampleAt(rp.ghost.sim.v, rp.ghost.sim, gs) - 0.3;
        sprites.push({ pos: gs, x: gn * HW, draw: (g2, pr) => IST.RaceLayer.drawCar(g2, Object.assign({}, pr, { fog: Math.max(pr.fog, 0.55) }), { color: lineColor(rp.ghost) }, braking) });
      }
      g.save();
      Sym.roundRect(g, x, y, w, h, 10);
      g.clip();
      g.translate(x, y);
      // road first, then the lines painted on it, then posts and the ghost car (far to near)
      IST.View.apply(R, w, h, VIEW);
      R.prepare(w, h, cam);
      R.draw(g, []);
      drawRibbon(g, q, R, rp.ghost, s, lineColor(rp.ghost), 0.45, 0.22);
      drawRibbon(g, q, R, L, s, lineColor(L), 0.85, 0.3);
      const maxDz = R.drawDist * LL.SEG, fogAmt = R.theme.fogAmt;
      sprites.sort((a, b) => b.pos - a.pos).forEach((sp) => {
        const pr = R.project(sp.pos, sp.x, 0);
        if (!pr) return;
        pr.fog = fogAmt * Math.pow(U.clamp((pr.dz / maxDz - 0.22) / 0.78, 0, 1), 1.5);
        sp.draw(g, pr, R);
      });
      const v = LL.sampleAt(L.sim.v, L.sim, s);
      if (CP) {
        CP.frameFor(R, SEAT);
        CP.draw(g, IST.Cockpit.steerFrom((p) => LL.sampleAt(L.n, L.sim, p) * HW, IST.Cockpit.segCurv(geo), s), IST.Cockpit.dash(v));
      }
      // HUD (over the cockpit)
      Sym.text(g, kmh(v) + '', w / 2, h - 34, { align: 'center', size: Math.max(28, Math.min(44, h * 0.08)), weight: 900 });
      Sym.text(g, 'km/h', w / 2, h - 14, { align: 'center', size: 12, weight: 720, alpha: 0.75 });
      const dt = LL.timeAt(q.user.sim, s) - LL.timeAt(q.ideal.sim, s);
      Sym.text(g, 'you ' + sec(dt) + ' vs ideal', w - 14, 26, { align: 'right', size: 18, weight: 900, color: dt > 0.005 ? COL.bad : COL.ideal });
      Sym.text(g, L.name, 14, 26, { size: 16, weight: 900, color: lineColor(L) });
      Sym.text(g, (L.isIdeal ? 'orange car / line: yours' : 'green car / line: ideal'), 14, 46, { size: 12, color: COL.dim });
      // phase banner while paused
      if (rp.cur && rp.hold > 0) {
        const P = PH[rp.cur.kind];
        const age = (performance.now() - rp.curAt) / 180;
        const sc = 1 + 0.25 * Math.max(0, 1 - age);
        const label = rp.cur.kind === 'end' ? P.label : T(rp.cur.ci) + ' · ' + P.label;
        Sym.text(g, label.toUpperCase(), w / 2, h * 0.2, { align: 'center', baseline: 'middle', size: Math.round(Math.max(20, Math.min(34, w * 0.04)) * sc), weight: 900, color: P.color });
      }
      g.restore();
      outline(g, x, y, w, h);
    }

    function renderTop(g, q, rp, x, y, w, h, ts) {
      const L = rp.line, geo = q.geo;
      g.save();
      panel(g, x, y, w, h);
      g.clip();
      g.translate(x, y);
      const V = view(q, 'top', w, h, 26);
      LL.drawTrack(g, geo, V, { bg: COL.panel, fontSize: 12 });
      LL.drawLine(g, geo, V, rp.ghost.sim, { color: lineColor(rp.ghost), width: 2.2, alpha: 0.6, dash: L.isIdeal ? [6, 5] : null });
      LL.drawLine(g, geo, V, L.sim, { color: lineColor(L), width: 3.2 });
      // phase markers
      L.ph.forEach((ph) => {
        if (ph.kind === 'end' || ph.s < rp.s0) return;
        const p = LL.pointAt(geo, V, L.sim, ph.s), P = PH[ph.kind];
        const active = rp.cur === ph && rp.hold > 0, past = ph.s <= rp.s + 0.1;
        if (active) Sym.ring(g, p[0], p[1], 11 + 3 * Math.sin(ts / 120), P.color, 2.5);
        g.beginPath();
        g.arc(p[0], p[1], 7.5, 0, Math.PI * 2);
        g.fillStyle = P.color;
        g.globalAlpha = past || active ? 1 : 0.55;
        g.fill();
        g.globalAlpha = 1;
        Sym.text(g, P.short, p[0], p[1] + 0.5, { align: 'center', baseline: 'middle', size: 10, weight: 900, color: '#101215', shadow: false });
      });
      // cars: this line (filled), the other (ring)
      const gs = LL.posAtTime(rp.ghost.sim, rp.gt0 + (rp.t - rp.t0));
      const gp = LL.pointAt(geo, V, rp.ghost.sim, Math.min(gs, geo.sEnd));
      Sym.ring(g, gp[0], gp[1], 5.5, lineColor(rp.ghost), 2.5);
      const cp = LL.pointAt(geo, V, L.sim, rp.s);
      g.beginPath();
      g.arc(cp[0], cp[1], 6, 0, Math.PI * 2);
      g.fillStyle = '#ffffff';
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = lineColor(L);
      g.stroke();
      g.restore();
      outline(g, x, y, w, h);
    }

    function renderTrace(g, q, rp, x, y, w, h) {
      const L = rp.line, other = rp.ghost;
      const s0 = rp.s0, s1 = q.geo.sEnd;
      const i0 = Math.round(s0 / DS), i1 = q.geo.iEnd;
      let lo = Infinity, hi = -Infinity;
      for (const X of [L, other]) for (let i = i0; i <= i1; i++) {
        lo = Math.min(lo, X.sim.v[i]);
        hi = Math.max(hi, X.sim.v[i]);
      }
      lo = Math.floor((lo * 3.6 - 10) / 20) * 20;
      hi = Math.ceil((hi * 3.6 + 5) / 20) * 20;
      const px = (s) => x + 44 + ((s - s0) / (s1 - s0)) * (w - 56);
      const py = (v) => y + h - 18 - ((v * 3.6 - lo) / (hi - lo)) * (h - 30);
      g.save();
      panel(g, x, y, w, h);
      for (let v = lo; v <= hi; v += hi - lo > 160 ? 50 : 20) {
        const yy = py(v / 3.6);
        g.fillStyle = 'rgba(255,255,255,0.06)';
        g.fillRect(x + 44, yy, w - 56, 1);
        Sym.text(g, String(v), x + 38, yy + 4, { align: 'right', size: 10, color: COL.dim, shadow: false });
      }
      Sym.text(g, 'km/h', x + 38, y + h - 5, { align: 'right', size: 10, color: COL.dim, shadow: false });
      L.ph.forEach((ph) => {
        if (ph.s < s0 || ph.kind === 'end') return;
        const P = PH[ph.kind], xx = px(ph.s);
        g.fillStyle = P.color;
        g.globalAlpha = 0.35;
        g.fillRect(xx, y + 10, 1, h - 28);
        g.globalAlpha = 1;
        Sym.text(g, P.short, xx, y + h - 5, { align: 'center', size: 10, weight: 900, color: P.color, shadow: false });
      });
      const trace = (X, color, width, alpha) => {
        g.beginPath();
        for (let i = i0; i <= i1; i += 2) {
          const xx = px(i * DS), yy = py(X.sim.v[i]);
          if (i === i0) g.moveTo(xx, yy);
          else g.lineTo(xx, yy);
        }
        g.globalAlpha = alpha;
        g.strokeStyle = color;
        g.lineWidth = width;
        g.stroke();
        g.globalAlpha = 1;
      };
      trace(other, lineColor(other), 1.6, 0.6);
      trace(L, lineColor(L), 2.4, 1);
      const cx = px(rp.s);
      g.fillStyle = '#ffffff';
      g.fillRect(cx, y + 8, 1.5, h - 26);
      g.restore();
    }

    return { view, drawN, gate, phaseDots, lineColor, renderPOV, renderTop, renderTrace };
  };
})();
