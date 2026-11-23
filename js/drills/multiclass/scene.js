/*
 * Class Traffic: the scene the cars are drawn in. A top-down map of the
 * complex with the cars and their paths, the in-car view from your car (the
 * others ahead, alongside or in the mirror, the cockpit, speed and a
 * sim-style relative timing box) and, stacked on the relative as a matching
 * panel, the approach strip: the run to the braking board and T1
 * straightened out, with every car on it and where the prototype reaches the GT.
 *
 * createScene(env) binds the run's view settings: env = { S (drill
 * settings), VIEW, SEAT, CP (cockpit or null) }.
 *
 * Positions come in as P = { sF, lF, vF, sS, lS, vS, fp, sp, xs: [{ s, l, v, color, name, num }] }.
 */
(function () {
  'use strict';
  const U = IST.util, Sym = IST.Symbols, LL = IST.LineLab, TL = IST.TrafficLab, MC = IST.Multiclass;
  const DS = LL.DS, CARLEN = TL.CARLEN, CARW = TL.CARW;
  const { COL, LEADUP, kmh } = MC;
  const { box, caps } = MC.ui;

  MC.createScene = function (env) {
    const { S, VIEW, SEAT, CP } = env;

    /** Screen position + heading of a car at track position s and lateral lat (m) in top-down view V. */
    function carAt(geo, V, s, lat) {
      const f = U.clamp(s / DS, 0, geo.N - 1), i = Math.min(geo.N - 1, Math.floor(f)), u = f - i;
      const wx = (k) => geo.cx[k] + lat * geo.nx[k], wy = (k) => geo.cy[k] + lat * geo.ny[k];
      const p0 = V.map(wx(i), wy(i)), p1 = V.map(wx(i + 1), wy(i + 1));
      return { x: p0[0] + (p1[0] - p0[0]) * u, y: p0[1] + (p1[1] - p0[1]) * u, a: Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) };
    }
    function drawCarTop(g, V, p, color, me) {
      const L = Math.max(13, CARLEN * V.scale), Wd = Math.max(7, CARW * V.scale);
      g.save();
      g.translate(p.x, p.y);
      g.rotate(p.a);
      Sym.roundRect(g, -L / 2, -Wd / 2, L, Wd, Math.min(3, Wd / 3));
      g.fillStyle = color;
      g.fill();
      g.lineWidth = me ? 2.2 : 1.2;
      g.strokeStyle = me ? '#ffffff' : 'rgba(0,0,0,0.6)';
      g.stroke();
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(L * 0.02, -Wd * 0.32, L * 0.22, Wd * 0.64);
      g.restore();
    }

    function viewFor(q, key, w, h, from, to) {
      const k = key + ':' + Math.round(w) + 'x' + Math.round(h);
      if (!q.views[k]) q.views[k] = LL.fitView(q.geo, w, h, 18, { sA: Math.max(0, from), sB: Math.min(q.geo.sEnd, to) });
      return q.views[k];
    }

    function mapWindow(q) {
      const C = q.geo.corners;
      return [q.sF0 - 30 - LEADUP * q.vF0, C[C.length - 1].endPos + 70]; // room for the looped run-up
    }

    /** All cars in P as { s, l, v, color, name, num, me, id }. */
    function carsOf(q, P) {
      const out = [
        { id: 'F', s: P.sF, l: P.lF, v: P.vF, color: COL.fast, name: 'Prototype', num: '7', me: q.me === 'F' },
        { id: 'S', s: P.sS, l: P.lS, v: P.vS, color: COL.slow, name: 'GT', num: '91', me: q.me === 'S' },
      ];
      (P.xs || []).forEach((x, k) => out.push(Object.assign({ id: 'X' + k, me: false }, x)));
      return out;
    }

    function renderMap(g, q, x, y, w, h, opts) {
      const geo = q.geo;
      box(g, x, y, w, h, { fill: COL.deep });
      g.save();
      g.beginPath();
      g.rect(x + 1, y + 1, w - 2, h - 2);
      g.clip();
      g.translate(x, y);
      const win = mapWindow(q);
      const V = viewFor(q, 'map', w, h, win[0], win[1]);
      LL.drawTrack(g, geo, V, { bg: COL.deep, fontSize: 11 });
      // braking boards before T1
      geo.boards.forEach((b) => {
        if (b.pos < win[0]) return;
        const p = carAt(geo, V, b.pos, b.x);
        g.fillStyle = '#f2f2f2';
        g.fillRect(p.x - 2, p.y - 2, 4, 4);
      });
      if (opts.paths) opts.paths.forEach((pp) => LL.drawLine(g, geo, V, pp.plan.sim, { from: pp.from, color: pp.color, width: pp.width || 2.5, alpha: pp.alpha == null ? 0.9 : pp.alpha, dash: pp.dash }));
      if (opts.trails) opts.trails.forEach((tr) => LL.drawLine(g, geo, V, tr.plan.sim, { from: tr.from, to: tr.to, color: tr.color, width: 3.2 }));
      // where the prototype reaches the GT if both hold their pace
      if (opts.catchS != null) {
        const p = carAt(geo, V, opts.catchS, opts.catchL || 0);
        g.setLineDash([3, 3]);
        Sym.ring(g, p.x, p.y, 9, COL.quiz, 2);
        g.setLineDash([]);
        if (w >= 300) caps(g, 'Reaches here', p.x + 12, p.y - 8, { size: 9, color: COL.quiz });
      }
      // cars: the others first, yours on top
      carsOf(q, opts).sort((a, b) => (a.me ? 1 : 0) - (b.me ? 1 : 0)).forEach((c) => drawCarTop(g, V, carAt(geo, V, c.s, c.l), c.color, c.me));
      if (opts.mark) {
        const p = carAt(geo, V, opts.mark.s, opts.mark.lat);
        Sym.ring(g, p.x, p.y, 12 + 3 * Math.sin(performance.now() / 120), opts.mark.color, 2.5);
      }
      g.restore();
      // legend: colour keys like the menu's step-tab squares
      let lx = x + 12;
      const key = (color, label) => {
        g.fillStyle = color;
        g.fillRect(lx, y + h - 19, 8, 8);
        lx += 13 + caps(g, label, lx + 13, y + h - 11, { size: 9.5, color: COL.text2 }) + 14;
      };
      key(COL.fast, 'Prototype');
      key(COL.slow, 'GT');
      (opts.xs || []).forEach((c) => key(c.color, c.name));
    }

    /** Front view of a car in a mirror. */
    function drawFrontCar(g, cx, by, w, color, lights) {
      const h = w * 0.5;
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(cx - w * 0.52, by - h * 0.06, w * 1.04, h * 0.1);
      g.fillStyle = '#111';
      g.fillRect(cx - w * 0.5, by - h * 0.45, w * 0.18, h * 0.45);
      g.fillRect(cx + w * 0.32, by - h * 0.45, w * 0.18, h * 0.45);
      g.fillStyle = color;
      Sym.roundRect(g, cx - w * 0.4, by - h * 0.85, w * 0.8, h * 0.72, h * 0.15);
      g.fill();
      g.fillStyle = '#1a1d22';
      Sym.roundRect(g, cx - w * 0.24, by - h * 1.02, w * 0.48, h * 0.3, h * 0.08);
      g.fill();
      if (lights) {
        g.shadowColor = 'rgba(255,255,220,0.9)';
        g.shadowBlur = Math.max(3, w * 0.12);
      }
      g.fillStyle = '#fffbe0';
      g.fillRect(cx - w * 0.34, by - h * 0.5, w * 0.16, h * 0.1);
      g.fillRect(cx + w * 0.18, by - h * 0.5, w * 0.16, h * 0.1);
      g.shadowBlur = 0;
    }

    /** others: cars behind you, { dz (m behind), dx (m to the side), color }. */
    function drawMirror(g, x, y, w, h, others) {
      g.save();
      Sym.roundRect(g, x - 3, y - 3, w + 6, h + 6, h * 0.35);
      g.fillStyle = '#05070a';
      g.fill();
      Sym.roundRect(g, x, y, w, h, h * 0.3);
      g.clip();
      const sky = g.createLinearGradient(0, y, 0, y + h);
      sky.addColorStop(0, '#5e7b9a');
      sky.addColorStop(0.45, '#9fb3c6');
      sky.addColorStop(0.46, '#4a5a3e');
      sky.addColorStop(1, '#3a4630');
      g.fillStyle = sky;
      g.fillRect(x, y, w, h);
      // road receding behind
      const hz = y + h * 0.46;
      g.fillStyle = '#3b3e46';
      g.beginPath();
      g.moveTo(x + w * 0.47, hz);
      g.lineTo(x + w * 0.53, hz);
      g.lineTo(x + w * 1.1, y + h);
      g.lineTo(x - w * 0.1, y + h);
      g.closePath();
      g.fill();
      // far cars first
      others.filter((o) => o.dz > 1 && o.dz < 220).sort((a, b) => b.dz - a.dz).forEach((o) => {
        const f = w * 1.1, sc = f / Math.max(3, o.dz);
        const cw = CARW * sc, cx = x + w / 2 + o.dx * sc, by = hz + 1.1 * sc;
        drawFrontCar(g, cx, Math.min(y + h + cw * 0.3, by), cw, o.color, true);
      });
      g.restore();
      g.lineWidth = 2;
      g.strokeStyle = 'rgba(255,255,255,0.25)';
      Sym.roundRect(g, x, y, w, h, h * 0.3);
      g.stroke();
    }

    /**
     * Relative timing box (the sim overlay): the cars in track order with the gap
     * in seconds, live as the run-up plays, and the closing speed underneath.
     * Returns its rectangle.
     */
    function drawRelative(g, q, w, h, P) {
      const ds = P.sF - P.sS;
      const all = carsOf(q, P), mine = all.find((c) => c.me);
      const rowsR = all.slice().sort((a, b) => b.s - a.s);
      const rh = U.clamp(h * 0.055, 18, 24), bw = U.clamp(w * 0.34, 190, 270), bh = rh * rowsR.length + 46;
      const bx = w - bw - 12, by = h - bh - 12;
      g.fillStyle = 'rgba(12,14,18,0.5)';
      g.fillRect(bx + 3, by + 3, bw, bh);
      g.fillStyle = 'rgba(31,35,42,0.9)';
      g.fillRect(bx, by, bw, bh);
      g.strokeStyle = COL.line;
      g.lineWidth = 1;
      g.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
      g.fillStyle = COL.mint;
      g.fillRect(bx, by, bw, 3);
      caps(g, 'Relative', bx + 10, by + 16, { size: 9.5, color: COL.dim });
      const fs = rh * 0.6;
      rowsR.forEach((r, i) => {
        const y = by + 24 + i * rh;
        if (r.me) {
          g.fillStyle = 'rgba(255,255,255,0.08)';
          g.fillRect(bx + 1, y, bw - 2, rh);
        }
        g.fillStyle = r.color;
        g.fillRect(bx + 10, y + rh * 0.2, 4, rh * 0.6);
        Sym.text(g, 'P' + (i + 1), bx + 22, y + rh * 0.7, { size: fs, weight: 720, color: COL.text2, shadow: false });
        Sym.text(g, '#' + r.num, bx + 22 + rh * 1.5, y + rh * 0.7, { size: fs, weight: 620, color: COL.text2, shadow: false });
        Sym.text(g, r.me ? 'YOU' : r.name, bx + 22 + rh * 3.1, y + rh * 0.7, { size: fs, weight: r.me ? 820 : 520, color: r.me ? COL.text : COL.text2, shadow: false });
        if (!r.me) {
          const d = r.s - mine.s, along = Math.abs(d) < CARLEN;
          const gs = (Math.abs(d) - CARLEN) / Math.max(1, d > 0 ? mine.v : r.v); // seconds, nose to tail
          const gtxt = along ? 'ALONGSIDE' : (d > 0 ? '+' : '−') + Math.max(0, gs).toFixed(2);
          Sym.text(g, gtxt, bx + bw - 10, y + rh * 0.7, { align: 'right', size: fs, weight: 720, color: along ? COL.warn : r.color, shadow: false });
        }
      });
      const close = kmh(ds < 0 ? P.vF - P.vS : P.vS - P.vF); // the car behind faster = closing
      caps(g, (close >= 0 ? 'Closing ' : 'Pulling away ') + Math.abs(close) + ' km/h', bx + 10, by + bh - 9, { size: 9.5, color: close > 0 ? COL.warn : COL.dim });
      return [bx, by, bw, bh];
    }

    /**
     * The approach strip, styled as a twin of the relative box and stacked on it:
     * from just behind the last car to T1's apex, straightened. The braking zone
     * shaded from the board to turn-in, every car on it (the prototype above the
     * line, GTs on it), and a ghost where the prototype reaches the GT if both
     * hold their pace. Returns its rectangle.
     */
    function drawStrip(g, q, x, y, w, h, P, catchS) {
      const X = q.X, all = carsOf(q, P), mine = all.find((c) => c.me);
      const s0 = Math.min.apply(null, all.map((c) => c.s)) - 25, s1 = Math.max(X.apS + 30, s0 + 120);
      const px = (s) => x + 12 + ((U.clamp(s, s0, s1) - s0) / (s1 - s0)) * (w - 24);
      g.fillStyle = 'rgba(12,14,18,0.5)';
      g.fillRect(x + 3, y + 3, w, h);
      g.fillStyle = 'rgba(31,35,42,0.9)';
      g.fillRect(x, y, w, h);
      g.strokeStyle = COL.line;
      g.lineWidth = 1;
      g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      g.fillStyle = COL.mint;
      g.fillRect(x, y, w, 3);
      caps(g, 'Approach', x + 10, y + 16, { size: 9.5, color: COL.dim });
      const dist = Math.max(0, Math.round(X.bS - mine.s));
      g.font = '720 13px ' + Sym.FONT;
      const dw = g.measureText(dist + ' m').width;
      Sym.text(g, dist + ' m', x + w - 10, y + 17, { align: 'right', size: 13, weight: 720, color: COL.text, shadow: false });
      caps(g, 'to the board', x + w - 18 - dw, y + 16, { align: 'right', size: 9.5, color: COL.dim });
      const ly = y + h - 22;
      // braking zone shaded from the board to turn-in
      g.fillStyle = 'rgba(245,176,154,0.22)';
      g.fillRect(px(X.bS), ly - 7, px(X.tiS) - px(X.bS), 14);
      g.fillStyle = 'rgba(255,255,255,0.3)';
      g.fillRect(x + 12, ly, w - 24, 1);
      const tick = (s, label, col) => {
        const xx = px(s);
        g.fillStyle = col;
        g.fillRect(xx - 0.5, ly - 8, 1.5, 16);
        caps(g, label, xx, y + h - 6, { align: 'center', size: 9, color: col });
      };
      tick(X.bS, 'Board', COL.text2);
      tick(X.apS, 'T1', COL.dim);
      if (catchS != null) {
        const cx = px(catchS);
        g.setLineDash([2, 2]);
        g.strokeStyle = COL.quiz;
        g.lineWidth = 1.2;
        g.strokeRect(cx - 7, ly - 18, 14, 8);
        g.setLineDash([]);
      }
      all.forEach((c) => {
        const cx = px(c.s), cy = c.id === 'F' ? ly - 18 : ly - 4;
        g.fillStyle = c.color;
        g.fillRect(cx - 7, cy, 14, 8);
        if (c.me) {
          g.strokeStyle = '#ffffff';
          g.lineWidth = 1.5;
          g.strokeRect(cx - 7.5, cy - 0.5, 15, 9);
        }
      });
      if (catchS != null) caps(g, 'Meets', px(catchS), ly - 22, { align: 'center', size: 8.5, color: COL.quiz });
      return [x, y, w, h];
    }

    /**
     * In-car view from your car. The others are drawn ahead on the road, in the
     * mirror when behind, or as a nose at the screen edge when alongside.
     * P.strip: draw the approach strip (with P.catchS, the meeting point).
     */
    function renderPOV(g, q, x, y, w, h, ts, P) {
      const geo = q.geo;
      if (!q.R) q.R = new IST.TrackRenderer(geo, { theme: S.style });
      const R = q.R;
      const all = carsOf(q, P), mineC = all.find((c) => c.me), others = all.filter((c) => !c.me);
      const plans = { F: P.fp, S: P.sp };
      const mine = Object.assign({ plan: plans[mineC.id] }, mineC);
      const lat = (s) => TL.latAt(mine.plan, s);
      const dn = (lat(mine.s + 3) - lat(Math.max(0, mine.s - 3))) / 6;
      const cam = { pos: mine.s, x: mine.l, heading: 0, yaw: Math.atan(dn) };
      box(g, x, y, w, h, { fill: COL.deep });
      g.save();
      g.beginPath();
      g.rect(x + 1, y + 1, w - 2, h - 2);
      g.clip();
      g.translate(x, y);
      IST.View.apply(R, w, h, VIEW);
      R.prepare(w, h, cam);
      R.draw(g, []);
      // cars ahead, far ones first
      others.filter((c) => c.s - mine.s > 2).sort((a, b) => b.s - a.s).forEach((c) => {
        const pr = R.project(c.s, c.l, 0);
        if (!pr) return;
        const maxDz = R.drawDist * LL.SEG;
        pr.fog = R.theme.fogAmt * Math.pow(U.clamp((pr.dz / maxDz - 0.22) / 0.78, 0, 1), 1.5);
        const plan = plans[c.id] || (q.extra[+c.id.slice(1)] || {}).plan;
        const braking = c.id === 'F' || c.id === 'S' ? (P.braking != null ? P.braking : plan && TL.vAt(plan, c.s + 6) < c.v - 0.4) : plan && TL.vAt(plan, c.s + 6) < c.v - 0.4;
        IST.RaceLayer.drawCar(g, pr, { color: c.color }, braking);
      });
      if (CP) {
        CP.frameFor(R, SEAT);
        CP.draw(g, IST.Cockpit.steerFrom(lat, IST.Cockpit.segCurv(geo), mine.s), IST.Cockpit.dash(mine.v));
      }
      // alongside: the other car's nose / tail in your periphery (over the cockpit, like the HUD)
      const side = others.filter((c) => Math.abs(c.s - mine.s) < CARLEN + 1.5).sort((a, b) => Math.abs(a.s - mine.s) - Math.abs(b.s - mine.s))[0];
      if (side) {
        const dz = side.s - mine.s, left = side.l < mine.l, ov = U.clamp(1 - Math.abs(dz) / (CARLEN + 1.5), 0.15, 1);
        const ww = w * 0.13 * ov, y0 = h * 0.45, y1 = h * 0.72;
        g.fillStyle = side.color;
        g.beginPath();
        if (left) {
          g.moveTo(0, y0);
          g.lineTo(ww, y0 + h * 0.05);
          g.lineTo(ww * 0.9, y1);
          g.lineTo(0, y1 + h * 0.02);
        } else {
          g.moveTo(w, y0);
          g.lineTo(w - ww, y0 + h * 0.05);
          g.lineTo(w - ww * 0.9, y1);
          g.lineTo(w, y1 + h * 0.02);
        }
        g.closePath();
        g.fill();
        Sym.text(g, 'CAR ' + (left ? 'LEFT' : 'RIGHT'), left ? 16 : w - 16, y0 - 10, { align: left ? 'left' : 'right', size: 16, weight: 820, color: COL.text });
      }
      // mirror
      const mw = U.clamp(w * 0.3, 140, 300), mh = mw * 0.28, mx = (w - mw) / 2;
      drawMirror(g, mx, 10, mw, mh, others.filter((c) => c.s < mine.s - CARLEN).map((c) => ({ dz: mine.s - c.s, dx: c.l - mine.l, color: c.color })));
      // speed
      Sym.text(g, kmh(mine.v) + '', w / 2, h - 34, { align: 'center', size: Math.max(26, Math.min(42, h * 0.08)), weight: 820 });
      Sym.text(g, 'km/h', w / 2, h - 14, { align: 'center', size: 12, weight: 720, alpha: 0.75 });
      if (P.hud) P.hud(g, w, h);
      const rel = drawRelative(g, q, w, h, P);
      // the approach strip sits on top of the relative, same width and style: one place to look for the numbers
      if (P.strip) drawStrip(g, q, rel[0], rel[1] - 8 - 76, rel[2], 76, P, P.catchS);
      g.restore();
    }

    return { renderMap, renderPOV };
  };
})();
