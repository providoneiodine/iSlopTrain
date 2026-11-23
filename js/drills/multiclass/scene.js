/*
 * Class Traffic: the scene both cars are drawn in. A top-down map of
 * the complex with both cars and their paths, and the in-car view from your
 * car: the other car ahead, alongside or in the mirror, the cockpit, speed
 * and a sim-style relative timing box.
 *
 * createScene(env) binds the run's view settings: env = { S (drill
 * settings), VIEW, SEAT, CP (cockpit or null) }.
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
      // cars: the other one first, yours on top
      const cars = [
        { s: opts.sS, lat: opts.lS, color: COL.slow, me: q.me === 'S' },
        { s: opts.sF, lat: opts.lF, color: COL.fast, me: q.me === 'F' },
      ].sort((a, b) => (a.me ? 1 : 0) - (b.me ? 1 : 0));
      cars.forEach((c) => drawCarTop(g, V, carAt(geo, V, c.s, c.lat), c.color, c.me));
      if (opts.mark) {
        const p = carAt(geo, V, opts.mark.s, opts.mark.lat);
        Sym.ring(g, p.x, p.y, 12 + 3 * Math.sin(performance.now() / 120), opts.mark.color, 2.5);
      }
      g.restore();
      // legend: colour keys like the menu's step-tab squares
      g.fillStyle = COL.fast;
      g.fillRect(x + 12, y + h - 19, 8, 8);
      const lw = caps(g, 'Prototype', x + 25, y + h - 11, { size: 9.5, color: COL.text2 });
      g.fillStyle = COL.slow;
      g.fillRect(x + 25 + lw + 14, y + h - 19, 8, 8);
      caps(g, 'GT', x + 25 + lw + 27, y + h - 11, { size: 9.5, color: COL.text2 });
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

    function drawMirror(g, x, y, w, h, other) {
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
      if (other && other.dz > 1 && other.dz < 220) {
        const f = w * 1.1, sc = f / Math.max(3, other.dz);
        const cw = CARW * sc, cx = x + w / 2 + other.dx * sc, by = hz + 1.1 * sc;
        drawFrontCar(g, cx, Math.min(y + h + cw * 0.3, by), cw, other.color, true);
      }
      g.restore();
      g.lineWidth = 2;
      g.strokeStyle = 'rgba(255,255,255,0.25)';
      Sym.roundRect(g, x, y, w, h, h * 0.3);
      g.stroke();
    }

    /**
     * Relative timing box (the sim overlay): the two cars in track order with the gap
     * in seconds, live as the run-up plays, and the closing speed underneath.
     */
    function drawRelative(g, q, w, h, P) {
      const me = q.me, ds = P.sF - P.sS;
      const gapS = (Math.abs(ds) - CARLEN) / Math.max(1, ds > 0 ? P.vS : P.vF); // seconds, nose to tail
      const along = Math.abs(ds) < CARLEN;
      const rowsR = [
        { me: me === 'F', name: 'Prototype', num: '7', color: COL.fast, s: P.sF },
        { me: me === 'S', name: 'GT', num: '91', color: COL.slow, s: P.sS },
      ].sort((a, b) => b.s - a.s);
      const rh = U.clamp(h * 0.055, 18, 24), bw = U.clamp(w * 0.34, 190, 270), bh = rh * 2 + 46;
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
        let gtxt = '';
        if (!r.me) gtxt = along ? 'ALONGSIDE' : (i === 0 ? '+' : '−') + Math.max(0, gapS).toFixed(2);
        if (gtxt) Sym.text(g, gtxt, bx + bw - 10, y + rh * 0.7, { align: 'right', size: fs, weight: 720, color: along ? COL.warn : i === 0 ? COL.fast : COL.slow, shadow: false });
      });
      const close = kmh(ds < 0 ? P.vF - P.vS : P.vS - P.vF); // the car behind faster = closing
      caps(g, (close >= 0 ? 'Closing ' : 'Pulling away ') + Math.abs(close) + ' km/h', bx + 10, by + bh - 9, { size: 9.5, color: close > 0 ? COL.warn : COL.dim });
    }

    /**
     * In-car view from your car: sF/lF etc. are both cars' positions. The other car
     * is drawn ahead on the road, in the mirror when behind, or as a nose at the
     * screen edge when alongside.
     */
    function renderPOV(g, q, x, y, w, h, ts, P) {
      const geo = q.geo;
      if (!q.R) q.R = new IST.TrackRenderer(geo, { theme: S.style });
      const R = q.R, me = q.me;
      const mine = me === 'F' ? { s: P.sF, l: P.lF, plan: P.fp, v: P.vF } : { s: P.sS, l: P.lS, plan: P.sp, v: P.vS };
      const oth = me === 'F' ? { s: P.sS, l: P.lS, v: P.vS, color: COL.slow, plan: P.sp } : { s: P.sF, l: P.lF, v: P.vF, color: COL.fast, plan: P.fp };
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
      const dz = oth.s - mine.s;
      if (dz > 2) {
        const pr = R.project(oth.s, oth.l, 0);
        if (pr) {
          const maxDz = R.drawDist * LL.SEG;
          pr.fog = R.theme.fogAmt * Math.pow(U.clamp((pr.dz / maxDz - 0.22) / 0.78, 0, 1), 1.5);
          const braking = P.braking != null ? P.braking : TL.vAt(oth.plan, oth.s + 6) < oth.v - 0.4;
          IST.RaceLayer.drawCar(g, pr, { color: oth.color }, braking);
        }
      }
      if (CP) {
        CP.frameFor(R, SEAT);
        CP.draw(g, IST.Cockpit.steerFrom(lat, IST.Cockpit.segCurv(geo), mine.s), IST.Cockpit.dash(mine.v));
      }
      // alongside: the other car's nose / tail in your periphery (over the cockpit, like the HUD)
      if (Math.abs(dz) < CARLEN + 1.5) {
        const left = oth.l < mine.l, ov = U.clamp(1 - Math.abs(dz) / (CARLEN + 1.5), 0.15, 1);
        const ww = w * 0.13 * ov, y0 = h * 0.45, y1 = h * 0.72;
        g.fillStyle = oth.color;
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
      const mw = U.clamp(w * 0.3, 140, 300), mh = mw * 0.28;
      drawMirror(g, (w - mw) / 2, 10, mw, mh, dz < -CARLEN ? { dz: -dz, dx: oth.l - mine.l, color: oth.color } : null);
      // speed
      Sym.text(g, kmh(mine.v) + '', w / 2, h - 34, { align: 'center', size: Math.max(26, Math.min(42, h * 0.08)), weight: 820 });
      Sym.text(g, 'km/h', w / 2, h - 14, { align: 'center', size: 12, weight: 700, alpha: 0.75 });
      if (P.hud) P.hud(g, w, h);
      drawRelative(g, q, w, h, P);
      g.restore();
    }

    return { renderMap, renderPOV };
  };
})();
