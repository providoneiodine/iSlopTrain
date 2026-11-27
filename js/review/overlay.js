/*
 * The 2D labels drawn over the 3D view: car chips with the gap to the
 * reference, cursor posts, lap tags along each line, gear numbers and the
 * ends of a zoomed stretch.
 *
 *   const ov = IST.Review.Overlay.create()
 *   ov.draw(g, W, H, f)    f: { vp, scene, cmp, cursorF, cars, gaps, range, gears, tags, fences, markers, chipsBeside, dt, card }
 *           card: { ghost, arc, cue } balance cues on the info card (all on by default)
 *     markers: Set of event kinds (derive.js) to mark: a pip at each event's peak, and a
 *           label chip ("Entry US 14°") within LABEL_DIST of the camera or near the cursor
 *           gaps[k]: lap k's distance behind the reference (m), for the cursor posts
 *     attitude: add slip angle and yaw rate to the car chips (cars carry slip, j)
 *     cars: [{ k, j, pose, gapM, slip }] one per lap, at where that lap was at the
 *           reference's time (k = 0 is the reference, at the cursor)
 *
 * Labels never pop: each has an opacity that eases toward shown or hidden,
 * labels already showing win the space over new ones, and stacked car chips
 * slide rather than jump. Everything is placed from the same matrix as the
 * frame it's drawn on, at fractional positions, so it moves with the scene.
 */
(function () {
  'use strict';
  const POST_GAP = 25; // m
  const Th = IST.Theme, M = IST.Review.M3, FONT = IST.Symbols.FONT;
  const FADE = 9; // per second
  const LABEL_DIST = 350, NEAR_CURSOR = 60; // m
  const Ly = IST.Review.Layers;
  const DEG = Math.PI / 180, WR = 17; // steering wheel radius, px

  function diamond(g, x, y, r) {
    g.beginPath();
    g.moveTo(x, y - r);
    g.lineTo(x + r, y);
    g.lineTo(x, y + r);
    g.lineTo(x - r, y);
    g.closePath();
    g.fill();
  }

  /*
   * What the card shows for balance (the Layers drawer's "Info card" toggles):
   *   ghost: a hollow pointer on the rim at the lock the car is turning to, when there is more lock than that
   *   arc:   the path the held lock asks for (dashed) beside the path the car drives (solid)
   *   cue:   an outline on the input in use when the balance went off (brake, throttle, or the wheel mid-corner)
   */
  let CARD = { ghost: true, arc: true, cue: true };
  const BAL_LAT = 2.5, BAL_MIN = 2 * DEG, BAL_SHOW = 1.5 * DEG, BAL_TAU = 0.12; // lateral m/s², raw and shown thresholds, easing (s)
  const ARC_W = 30, ARC_MAX = 1.5; // steering arc box width (px), its widest sweep (rad)
  /** Arc sweep for a wheel angle: eases toward ARC_MAX so a hairpin's lock still fits the box. */
  const sweep = (a) => 1.2 * Math.tanh(a / (40 * DEG));

  /**
   * The lap's balance at j, eased per chip so it can't flicker: only while cornering and clear of noise.
   * us > 0 = more lock than the car's rotation needs, < 0 = the car turning more than the lock.
   */
  function balance(L, j, m, dt) {
    if (!L.us) return null;
    const raw = L.us[j], st = L.balState ? L.balState[j] : 0;
    const real = isFinite(raw) && (!L.latG || Math.abs(L.latG[j]) > BAL_LAT) && (st !== 0 || Math.abs(raw) > BAL_MIN);
    m.bal = (m.bal || 0) + ((real ? raw : 0) - (m.bal || 0)) * (1 - Math.exp(-dt / BAL_TAU));
    const us = m.bal, on = Math.abs(us) > BAL_SHOW;
    const phase = L.phase ? Math.round(L.phase[j]) : L.brake && L.brake[j] > 0.05 ? 1 : L.throttle && L.throttle[j] > 0.2 ? 3 : 2;
    return { us, on, strong: us > 0 ? st === 1 : st === -1, turn: L.latG && L.latG[j] < 0 ? -1 : 1, phase, col: us > 0 ? Th.sky : Th.peach };
  }

  /**
   * The steering wheel over a car's chip, turned by the lap's wheel angle (+ left). With more lock than the
   * car's rotation used, a hollow sky pointer marks the lock it was turning to. Oversteer gets no pointer:
   * the lock matching the rotation is more lock, and pointing there would read as "turn in more".
   */
  function wheel(g, L, j, cx, cy, R, b) {
    const s = L.steer[j];
    const at = (a) => -Math.PI / 2 - a; // wheel angle to canvas angle: 12 o'clock, anticlockwise for left
    g.fillStyle = Th.deep;
    g.beginPath();
    g.arc(cx, cy, R + 5, 0, Math.PI * 2);
    g.fill();
    // the rim: quiet, or outlined when the balance went off with neither pedal in use
    const cue = CARD.cue && b && b.on && b.phase === 2;
    g.strokeStyle = cue ? b.col : Th.dim;
    g.globalAlpha = cue && !b.strong ? 0.6 : 1;
    g.lineWidth = 3;
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.stroke();
    g.globalAlpha = 1;
    g.strokeStyle = Th.dim;
    // three spokes and the hub, turned with the wheel
    g.save();
    g.translate(cx, cy);
    g.rotate(-s);
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(-R, 0);
    g.lineTo(R, 0);
    g.moveTo(0, 0);
    g.lineTo(0, R);
    g.stroke();
    g.fillStyle = Th.dim;
    g.beginPath();
    g.arc(0, 0, R * 0.3, 0, Math.PI * 2);
    g.fill();
    g.restore();
    if (CARD.ghost && b && b.on && b.us > 0) {
      // faint arc from the held lock to the lock the rotation matches, then the hollow pointer there
      const need = s - Math.min(Math.PI, b.us) * b.turn;
      g.globalAlpha = b.strong ? 0.6 : 0.35;
      g.strokeStyle = Th.sky;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(cx, cy, R + 6, at(s), at(need), b.turn < 0);
      g.stroke();
      g.globalAlpha = 1;
      g.save();
      g.translate(cx, cy);
      g.rotate(-need);
      g.fillStyle = Th.deep;
      g.strokeStyle = Th.sky;
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(-3.5, -R - 10);
      g.lineTo(3.5, -R - 10);
      g.lineTo(0, -R - 2);
      g.closePath();
      g.fill();
      g.stroke();
      g.restore();
    }
    // top marker last, so it reads over the pointer's arc at the held lock
    g.save();
    g.translate(cx, cy);
    g.rotate(-s);
    g.strokeStyle = Th.butter;
    g.lineWidth = 3.5;
    g.beginPath();
    g.moveTo(0, -R - 3);
    g.lineTo(0, -R + 4);
    g.stroke();
    g.restore();
  }

  const clutchUsed = new WeakMap(); // lap -> whether its clutch moves at all in the lap
  const PW = 5, PG = 2, HOLD = 0.15; // pedal bar width and gap (px), lock / spin hold (s)

  /** How many pedal bars: throttle and brake, plus the clutch only when it moves during the lap. */
  function pedalCount(L) {
    if (!L.throttle && !L.brake) return 0;
    if (L.clutch && !clutchUsed.has(L)) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < L.clutch.length; i++) if (isFinite(L.clutch[i])) (lo = Math.min(lo, L.clutch[i])), (hi = Math.max(hi, L.clutch[i]));
      clutchUsed.set(L, hi - lo > 0.05);
    }
    return 2 + (L.clutch && clutchUsed.get(L) ? 1 : 0);
  }
  /** Width of the pedal block: the bars, then the steering arc when the lap has balance and it's on. */
  const pedalWidth = (L, n) => n * PW + (n - 1) * PG + 8 + (L.us && L.steer && CARD.arc ? ARC_W : 0);

  /** A path from the bottom of the box, turning through th (rad, + left) over a fixed length. */
  function arcPath(g, x0, y0, len, th) {
    th = Math.max(-ARC_MAX, Math.min(ARC_MAX, th));
    const N = 12, ds = len / N;
    let x = x0, y = y0, hd = 0;
    g.beginPath();
    g.moveTo(x, y);
    for (let q = 0; q < N; q++) {
      hd -= th / N;
      x += Math.sin(hd) * ds;
      y -= Math.cos(hd) * ds;
      g.lineTo(x, y);
    }
  }

  /**
   * Pedal bars beside the wheel, filling from the bottom: throttle mint, brake rose, clutch lilac. A butter
   * outline and cap mark a pedal past grip (lockup, wheelspin); a sky or peach outline marks the pedal in use
   * when the balance went off. Then the steering arc: dashed where the lock asks to go, solid where the car went.
   */
  function pedals(g, L, j, x, top, hgt, m, c, dt, b) {
    const n = pedalCount(L);
    if (!n) return;
    const wl = c.wheels ? Object.values(c.wheels) : [];
    const lock = wl.reduce((a, w) => Math.max(a, w.lock || 0), 0), spin = wl.reduce((a, w) => Math.max(a, w.spin || 0), 0);
    m.lockT = lock > 0.3 ? HOLD : Math.max(0, (m.lockT || 0) - dt);
    m.spinT = spin > 0.3 ? HOLD : Math.max(0, (m.spinT || 0) - dt);
    const bars = [[L.throttle, Th.mint, m.spinT > 0], [L.brake, Th.rose, m.lockT > 0]];
    if (n > 2) bars.push([null, Th.lilac, false, 1 - L.clutch[j]]);
    const cueBar = CARD.cue && b && b.on ? (b.phase === 1 ? 1 : b.phase === 3 ? 0 : -1) : -1;
    g.fillStyle = Th.deep;
    g.fillRect(x, top - 4, pedalWidth(L, n), hgt + 8);
    bars.forEach(([a, col, past, val], q) => {
      const raw = val != null ? val : a ? a[j] : 0;
      const v = isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0, bx = x + 4 + q * (PW + PG), fh = Math.round(v * hgt);
      g.fillStyle = Th.panel2;
      g.fillRect(bx, top, PW, hgt);
      g.fillStyle = col;
      g.fillRect(bx, top + hgt - fh, PW, fh);
      if (q === cueBar) {
        g.strokeStyle = b.col;
        g.globalAlpha = b.strong ? 1 : 0.6;
        g.lineWidth = 1.5;
        g.strokeRect(bx - 2, top - 2, PW + 4, hgt + 4);
        g.globalAlpha = 1;
      }
      if (past) {
        g.strokeStyle = Th.butter;
        g.lineWidth = 1;
        g.strokeRect(bx - 0.5, top - 0.5, PW + 1, hgt + 1);
        g.fillStyle = Th.butter;
        g.fillRect(bx, top + hgt - fh - 2, PW, 2);
      }
    });
    if (!b || !L.steer || !CARD.arc) return;
    // start on the side away from the turn so the bend has room; asked first, driven over it
    const s = L.steer[j], ax = x + n * PW + (n - 1) * PG + 8 + ARC_W / 2 + (s >= 0 ? 7 : -7), ay = top + hgt, len = hgt - 2;
    g.lineCap = 'round';
    g.setLineDash([2.5, 2.5]);
    g.strokeStyle = Th.dim;
    g.lineWidth = 1.5;
    // the driven arc keeps the lock ratio to the asked one, so the gap still shows at hairpin lock
    const need = b.on ? s - b.us * b.turn : s, thA = sweep(s), thD = Math.abs(s) > 3 * DEG ? thA * (need / s) : sweep(need);
    arcPath(g, ax, ay, len, thA);
    g.stroke();
    g.setLineDash([]);
    g.strokeStyle = b.on ? b.col : Th.text2;
    g.globalAlpha = b.on && !b.strong ? 0.7 : 1;
    g.lineWidth = 2.2;
    arcPath(g, ax, ay, len, thD);
    g.stroke();
    g.globalAlpha = 1;
    g.lineCap = 'butt';
    g.fillStyle = Th.butter;
    g.beginPath();
    g.arc(ax, ay, 2, 0, Math.PI * 2);
    g.fill();
  }

  function create() {
    const mem = new Map(); // label key -> { a: opacity, y: eased stack offset }
    const slot = (key) => {
      let m = mem.get(key);
      if (!m) mem.set(key, (m = { a: 0, y: 0, used: 0 }));
      return m;
    };
    let frameNo = 0;
    const SCR = { x: 0, y: 0 }, PAD = [0, 0, 0, 0];

    /*
     * Every label the current choices could show, each with its place in the scene. Built
     * once per scene and set of choices and reused, since a frame only has to place them.
     */
    let made = null;
    function labels(f, top) {
      const S = f.scene, cmp = f.cmp;
      if (made && made.S === S && made.cmp === cmp && made.top === top && made.tags === !!f.tags && made.gears === !!f.gears && made.fences === f.fences && made.markers === f.markers) return made.list;
      const list = [];
      const put = (key, li, p, text, kind, more) => list.push(Object.assign({ li, p, text, kind, m: slot(key), r: [0, 0, 0, 0], on: false, near: 0, far: false }, more));
      if (f.markers && f.markers.size) {
        cmp.laps.forEach((L, li) => {
          if (f.fences && !f.fences[li]) return;
          const P = S.base[li];
          (L.events || []).forEach((e) => {
            const mk = f.markers.has(e.kind) && Ly.markerFor(e.kind), i = e.iPeak;
            if (mk && mk.pip) put('e' + li + ':' + e.kind + ':' + e.i0, li, [P[i * 3], P[i * 3 + 1] + 0.4, P[i * 3 + 2]], Ly.eventLabel(e), 'event', { color: mk.color, e });
          });
        });
      }
      if (f.tags) {
        const every = Math.round(200 / cmp.step);
        cmp.laps.forEach((L, li) => {
          const P = S.base[li], off = Math.round((60 + li * 37) / cmp.step);
          for (let j = off; j < cmp.n; j += every) put('t' + li + ':' + j, li, [P[j * 3], P[j * 3 + 1] + 0.3, P[j * 3 + 2]], 'L' + L.lap.lapNo, 'tag');
        });
      }
      if (f.gears) {
        cmp.laps.forEach((L, li) => {
          if (f.fences && !f.fences[li]) return;
          const P = S.base[li];
          L.shifts.forEach((s) => put('g' + li + ':' + s.i, li, [P[s.i * 3], P[s.i * 3 + 1] + top, P[s.i * 3 + 2]], String(Math.round(s.to)), 'gear'));
        });
      }
      made = { S, cmp, top, tags: !!f.tags, gears: !!f.gears, fences: f.fences, markers: f.markers, list };
      return list;
    }

    function draw(g, W, H, f) {
      frameNo++;
      if (f.card) CARD = f.card;
      g.clearRect(0, 0, W, H);
      const S = f.scene, cmp = f.cmp, vp = f.vp, top = S.fenceH * 1.25;
      const k = 1 - Math.exp(-FADE * (f.dt || 0.016));
      const taken = [];
      const overlaps = (r) => taken.some((t) => r[0] < t[0] + t[2] && r[0] + r[2] > t[0] && r[1] < t[1] + t[3] && r[1] + r[3] > t[1]);
      const proj = (p, dy) => M.project(vp, p[0], p[1] + (dy || 0), p[2], W, H);
      const onScreen = (p, pad) => p.w > 0 && p.x > -pad && p.y > -pad && p.x < W + pad && p.y < H + pad;
      g.textBaseline = 'middle';

      // ---- zoomed stretch ends
      if (f.range) {
        const P = S.base[0];
        g.strokeStyle = Th.butter;
        g.lineWidth = 1.5;
        g.setLineDash([5, 4]);
        f.range.forEach((i) => {
          const b = proj([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]), t = proj([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], top * 1.4);
          if (b.w <= 0 || t.w <= 0) return;
          g.beginPath();
          g.moveTo(b.x, b.y);
          g.lineTo(t.x, t.y);
          g.stroke();
        });
        g.setLineDash([]);
      }

      // ---- cursor posts: every lap at the same distance as the reference. A lap more
      // than POST_GAP behind or ahead is left out: its car is far from the cursor, so a
      // post there reads as a second car rather than a comparison of lines.
      if (f.cursorF >= 0) {
        cmp.laps.forEach((L, li) => {
          if (li && f.gaps && Math.abs(f.gaps[li]) > POST_GAP) return;
          const q = IST.Review.Rigs.pose(S, li, f.cursorF);
          const b = proj(q.p), t = proj(q.p, top);
          if (b.w <= 0 || t.w <= 0) return;
          g.strokeStyle = L.color;
          g.globalAlpha = 0.7;
          g.lineWidth = 1.5;
          g.beginPath();
          g.moveTo(b.x, b.y);
          g.lineTo(t.x, t.y);
          g.stroke();
          g.globalAlpha = 1;
          g.fillStyle = L.color;
          g.fillRect(b.x - 3, b.y - 3, 6, 6);
        });
      }

      // ---- car chips: lap, gap, and a leader line to the car
      const i = Math.round(Math.max(0, f.cursorF));
      (f.cars || []).forEach((c) => {
        const L = cmp.laps[c.k];
        const roof = proj(c.pose.p, 1.4);
        if (!onScreen(roof, 60)) return;
        const isRef = c.k === 0;
        const tag = 'L' + L.lap.lapNo;
        const dl = L.delta[i] - (f.zero >= 0 ? L.delta[f.zero] : 0); // a corner comparison counts from its loop's start
        let main, sub;
        if (isRef) {
          main = 'REF';
          sub = Math.round(L.speed[i] * 3.6) + ' km/h' + (L.gear ? ' · G' + Math.round(L.gear[i]) : '');
        } else {
          const d = dl;
          main = (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(3) + 's';
          sub = Math.abs(c.gapM) < 0.5 ? 'level' : Math.abs(c.gapM).toFixed(1) + ' m ' + (c.gapM > 0 ? 'behind' : 'ahead');
        }
        if (f.attitude && isFinite(c.slip)) {
          // slip signed by the turn (+ = nose into the corner) and the yaw rate
          const j = Math.round(c.j), b = L.beta && isFinite(L.beta[j]) ? L.beta[j] : Math.abs(c.slip);
          sub += ' · β ' + ((b * 180) / Math.PI).toFixed(1) + '°' + (L.yawRate ? ' · ' + Math.round(Math.abs(L.yawRate[j]) * 180 / Math.PI) + '°/s' : '');
        }
        g.font = '800 11px ' + FONT;
        const tw = g.measureText(tag).width + 10;
        g.font = '800 12.5px ' + FONT;
        const mw = g.measureText(main).width;
        g.font = '500 11px ' + FONT;
        const sw = g.measureText(sub).width;
        const hh = 34, m = slot('car' + c.k);
        const jw = Math.round(Math.max(0, Math.min(cmp.n - 1, c.j)));
        const hasWheel = !!L.steer && isFinite(L.steer[jw]), np = pedalCount(L);
        const ww = hasWheel || np ? WR * 2 + 14 : 0; // room for the wheel and pedals above the chip
        // the chip is centred on the car, so its width holds while the digits change: it
        // grows at once and shrinks only when the text is a good deal narrower
        const fit = tw + Math.max(mw, sw) + 16;
        if (!(m.w >= fit && m.w < fit + 14)) m.w = Math.ceil(fit + 4);
        const w = m.w;
        // above the car, or beside it when looking straight down (so the road ahead stays clear);
        // stacked upward past chips already placed, easing toward that slot
        const beside = f.chipsBeside;
        const bx = beside ? roof.x + 26 : roof.x - w / 2, by = beside ? roof.y - hh / 2 : roof.y - 18 - hh;
        const dir = -1;
        let off = 0;
        const aw = np ? Math.max(w, (hasWheel ? tw / 2 + WR + 8 : 0) + pedalWidth(L, np)) : w; // the pedal block can reach past the chip
        while (off < 5 && overlaps([bx, by + dir * off * (hh + ww + 4) - ww, aw, hh + ww])) off++;
        const want = off * (hh + ww + 4);
        m.y = m.used === frameNo - 1 ? m.y + (want - m.y) * k : want;
        m.used = frameNo;
        const x = bx, y = by + dir * m.y;
        taken.push([x, y - ww, aw, hh + ww]);
        // leader
        g.strokeStyle = L.color;
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(roof.x, roof.y);
        if (beside) g.lineTo(x, y + hh / 2);
        else g.lineTo(roof.x, y + hh);
        g.stroke();
        // chip
        g.fillStyle = Th.shadow;
        g.fillRect(x + 2, y + 2, w, hh);
        g.fillStyle = Th.deep;
        g.fillRect(x, y, w, hh);
        g.fillStyle = L.color;
        g.fillRect(x, y, tw, hh);
        g.fillStyle = Th.ink;
        g.textAlign = 'center';
        g.font = '800 11px ' + FONT;
        g.fillText(tag, x + tw / 2, y + hh / 2 + 0.5);
        g.textAlign = 'left';
        g.font = '800 12.5px ' + FONT;
        g.fillStyle = isRef ? Th.butter : dl > 0.0005 ? Th.rose : dl < -0.0005 ? Th.mint : Th.text;
        g.fillText(main, x + tw + 8, y + 12);
        g.font = '500 11px ' + FONT;
        g.fillStyle = Th.dim;
        g.fillText(sub, x + tw + 8, y + 25);
        const bal = balance(L, jw, m, f.dt || 0.016);
        if (hasWheel) wheel(g, L, jw, x + tw / 2, y - WR - 8, WR, bal);
        if (np) pedals(g, L, jw, hasWheel ? x + tw / 2 + WR + 8 : x, y - WR * 2 - 6, WR * 2 - 4, m, c, f.dt || 0.016, bal);
      });

      // ---- event pips, and the fading labels: event chips, lap tags along the lines and gear numbers
      const cand = labels(f, top);
      const cur = f.cursorF >= 0 ? f.cursorF : -1e9, near = NEAR_CURSOR / cmp.step, far = S.size * 0.9, sp = SCR;
      for (let q = 0; q < cand.length; q++) {
        const c = cand[q], at = c.p;
        const cw = vp[3] * at[0] + vp[7] * at[1] + vp[11] * at[2] + vp[15];
        c.on = false;
        c.near = 0;
        if (cw <= 1e-6) continue;
        sp.x = ((vp[0] * at[0] + vp[4] * at[1] + vp[8] * at[2] + vp[12]) / cw * 0.5 + 0.5) * W;
        sp.y = (0.5 - (vp[1] * at[0] + vp[5] * at[1] + vp[9] * at[2] + vp[13]) / cw * 0.5) * H;
        if (!(sp.x > -10 && sp.y > -10 && sp.x < W + 10 && sp.y < H + 10)) continue;
        const r = c.r;
        if (c.kind === 'event') {
          g.fillStyle = '#111317';
          diamond(g, sp.x, sp.y, 6);
          g.fillStyle = c.color;
          diamond(g, sp.x, sp.y, 4);
          const close = Math.abs(c.e.iPeak - cur) < near || (cur >= c.e.i0 && cur <= c.e.i1);
          if (!c.text || !(cw < LABEL_DIST || close)) continue;
          c.near = close ? 1 : 0;
          if (!c.tw) (g.font = '700 10.5px ' + FONT), (c.tw = g.measureText(c.text).width + 14);
          (r[0] = sp.x - c.tw / 2), (r[1] = sp.y - 27), (r[2] = c.tw), (r[3] = 17);
        } else if (c.kind === 'tag') {
          // tags thin out with distance so the far track doesn't fill with them
          c.far = cw >= far;
          (r[0] = sp.x - 12), (r[1] = sp.y - 7.5), (r[2] = 24), (r[3] = 15);
        } else (r[0] = sp.x - 8.5), (r[1] = sp.y - 16), (r[2] = 17), (r[3] = 16);
        c.on = true;
      }
      // labels already showing keep their place; new ones fit round them
      cand.sort((a, b) => b.near - a.near || b.m.a - a.m.a);
      g.textAlign = 'center';
      for (let q = 0; q < cand.length; q++) {
        const c = cand[q], r = c.r;
        let want = false;
        if (c.on) {
          // gear numbers keep a clear gap round each, so a tight complex shows one or two, not a wall
          const G = c.kind === 'gear' ? 9 : 0;
          (PAD[0] = r[0] - G), (PAD[1] = r[1] - G), (PAD[2] = r[2] + 2 * G), (PAD[3] = r[3] + 2 * G);
          want = !c.far && !overlaps(PAD);
          if (want) taken.push(r);
        }
        c.m.a += ((want ? 1 : 0) - c.m.a) * k;
        if (c.m.a < 0.02 || !c.on) continue;
        const L = cmp.laps[c.li];
        g.globalAlpha = c.m.a;
        if (c.kind === 'event') {
          g.fillStyle = Th.deep;
          g.fillRect(r[0], r[1], r[2], r[3]);
          g.fillStyle = c.color;
          g.fillRect(r[0], r[1], 3, r[3]);
          g.fillStyle = Th.text;
          g.font = '700 10.5px ' + FONT;
          g.fillText(c.text, r[0] + r[2] / 2 + 1.5, r[1] + r[3] / 2 + 0.5);
        } else {
          if (c.kind === 'tag') {
            g.fillStyle = Th.deep;
            g.fillRect(r[0], r[1], r[2], r[3]);
            g.strokeStyle = L.color;
            g.lineWidth = 1.5;
            g.strokeRect(r[0] + 0.75, r[1] + 0.75, r[2] - 1.5, r[3] - 1.5);
            g.fillStyle = L.color;
            g.font = '800 10px ' + FONT;
          } else {
            g.fillStyle = L.color;
            g.fillRect(r[0], r[1], r[2], r[3]);
            g.fillStyle = Th.ink;
            g.font = '800 11px ' + FONT;
          }
          g.fillText(c.text, r[0] + r[2] / 2, r[1] + r[3] / 2 + 0.5);
        }
        g.globalAlpha = 1;
      }

      // forget labels that haven't been around for a while
      if (mem.size > 4000) mem.clear(), (made = null);
    }

    return { draw };
  }

  IST.Review.Overlay = { create };
})();
