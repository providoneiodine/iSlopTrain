/*
 * Two-Point Focus: a Useful-Field-of-View-style drill set in a corner approach.
 *
 * Fixate the far apex board. For a brief, masked moment, a symbol (▲/▼)
 * appears on the board AND a yellow marshal flag appears on the verge of the
 * approach road (left or right), where the near point of steering lives.
 * Report both. Exposure adapts. This trains the far point + near point split
 * of skilled steering.
 */
(function () {
  'use strict';
  const U = IST.util, Sym = IST.Symbols;
  const BOARD = IST.View.BOARD; // board size, kerb position and visibility rule shared with Apex Snap
  const BAND = 0.15; // the board stays a little more central than in Apex Snap, leaving room for flags on both sides
  const SCENES_PER_FRAME = 6; // scene picks tried per frame before trying again next frame
  const MASK_MS = 260;
  const FLAG_M = 1.1; // flag cloth width, metres
  const NEAR_MAX = 60; // flags stand at most this far ahead (m): the near road, not the next straight
  const VERGE = 1.4; // flag pole stands this far outside the road edge (m)
  const ECC = { near: [0.17, 0.3], wide: [0.3, 0.44] }; // flag distance from the board, share of screen width

  IST.registerDrill({
    id: 'two-point',
    name: 'Two-Point Focus',
    category: 'Core',
    usesView: true, // FOV, horizon and cockpit from IST.View; flags stand on the verge, placed clear of the cockpit
    tagline: 'Eyes far, attention wide.',
    description: 'Keep your eyes on the ringed apex board. Report its symbol (↑/↓) and which side of the road the yellow flag was on (←/→).',
    research: [
      { point: 'Steering uses a far point viewed directly and the near road seen peripherally.', source: 'Land & Horwood (1995), Nature 377; Salvucci & Gray (2004), Perception 33(10).' },
      { point: 'Lane keeping works on peripheral vision alone.', source: 'Summala, Nieminen & Punto (1996), Human Factors 38(3).' },
      { point: 'Same format as UFOV training, linked to fewer crashes in older drivers.', source: 'Ball & Owsley (1993); Ball et al. (2010), J. Am. Geriatr. Soc. 58(11).' },
      { point: 'Pressure narrows attention.', source: 'Easterbrook (1959), Psychological Review 66(3).' },
    ],
    settings: [
      { key: 'trials', label: 'Trials', type: 'number', default: 40, min: 10, max: 150, step: 5 },
      { key: 'distractors', label: 'Distractors', type: 'select', default: 'low', options: [['none', 'None'], ['low', 'Low (3)'], ['high', 'High (6)']] },
      { key: 'ecc', label: 'Flag spread', type: 'select', default: 'near', options: [['near', 'Near'], ['wide', 'Wide']] },
      { key: 'elevation', label: 'Elevation', type: 'select', default: 'rolling', options: [['flat', 'Flat'], ['rolling', 'Rolling'], ['hilly', 'Hilly']] },
      { key: 'style', label: 'Style', type: 'select', default: 'realistic', options: [['realistic', 'Realistic'], ['minimal', 'Minimal']] },
      { key: 'cockpit', label: 'Cockpit', type: 'bool', default: true, hint: 'Draw the cockpit over the road. Set it up on the View screen.' },
      { key: 'feedback', label: 'Feedback', type: 'select', default: 'every', options: [['every', 'Every trial'], ['none', 'Summary only']] },
      { key: 'carryOver', label: 'Continue from last level', type: 'bool', default: true },
      { key: 'startExposure', label: 'Start flash', type: 'number', unit: 'ms', default: 350, min: 30, max: 1000, step: 10 },
      { key: 'minTargetPx', label: 'Min board size', type: 'number', unit: 'px', default: 26, min: 12, max: 80, step: 2 },
    ],
    metrics: [
      { key: 'threshold', label: 'Exposure threshold', unit: 'ms', digits: 0, better: 'lower', primary: true, hint: 'Shortest flash with both right ~71% of the time.' },
      { key: 'bothAcc', label: 'Both correct', pct: true, digits: 0, better: 'higher' },
      { key: 'centralAcc', label: 'Apex symbol correct', pct: true, digits: 0, better: 'higher' },
      { key: 'periphAcc', label: 'Flag side correct', pct: true, digits: 0, better: 'higher' },
      { key: 'early', label: 'Early presses', digits: 0, better: 'lower' },
      ...IST.Juice.METRICS,
      { key: 'trials', label: 'Trials', digits: 0 },
    ],
    coach(s) {
      const tips = [];
      if (U.isNum(s.periphAcc) && U.isNum(s.centralAcc)) {
        if (s.periphAcc < s.centralAcc - 0.15)
          tips.push('Missing flags: attention is narrowing. Take in the whole screen.');
        if (s.centralAcc < s.periphAcc - 0.15)
          tips.push('Missing the apex symbol: keep your eyes on the board.');
      }
      if (U.isNum(s.threshold) && s.threshold < 70 && s.bothAcc > 0.7) tips.push('Near the floor. Add distractors or widen the flags.');
      return tips;
    },

    analyze(results, A) {
      const recent = results.slice(-10);
      const out = { breakdowns: [], notes: [], insim: [] };
      const c = A.mean(A.values(recent, 'centralAcc')), p = A.mean(A.values(recent, 'periphAcc'));
      if (c == null || p == null) return out;
      const n = recent.reduce((s, r) => s + ((r.summary && r.summary.trials) || 0), 0);
      const side = A.sumTallies(recent, 'byFlagSide');
      const sub = 'Last ' + recent.length + ' session' + (recent.length === 1 ? '' : 's');
      out.breakdowns.push(
        { title: 'Far vs peripheral', subtitle: sub, items: [{ label: 'Apex symbol', value: c, n }, { label: 'Flag side', value: p, n }], pct: true },
        { title: 'Flag side', subtitle: sub, items: A.items(side, ['L', 'R'], { L: 'Left', R: 'Right' }), pct: true }
      );
      const r = (x) => Math.round(x * 100) + '%';
      if (n >= 20) {
        if (p < c - 0.12) out.insim.push({ id: 'TUNNEL', score: 0.35 + (c - p), evidence: 'Peripheral flags ' + r(p) + ' vs apex symbol ' + r(c) });
        else if (c < p - 0.12) out.insim.push({ id: 'GAZE_DRIFT', score: 0.35 + (p - c), evidence: 'Apex symbol ' + r(c) + ' vs peripheral flags ' + r(p) });
        else out.notes.push({ tone: 'good', text: 'Two-Point Focus: far (' + r(c) + ') and peripheral (' + r(p) + ') balanced.' });
      }
      if (side.L && side.R && side.L[0] >= A.MIN_N && side.R[0] >= A.MIN_N) {
        const d = A.acc(side.L) - A.acc(side.R);
        if (Math.abs(d) >= 0.12) out.insim.push({ id: d < 0 ? 'SIDE_LEFT' : 'SIDE_RIGHT', score: 0.25 + Math.abs(d), evidence: 'Left flags ' + r(A.acc(side.L)) + ' vs right ' + r(A.acc(side.R)) });
      }
      return out;
    },

    create(ctx) {
      const S = ctx.settings;
      const rnd = U.rng(U.randomSeed());
      const track = IST.Track.generate({ rng: U.rng(U.randomSeed()), vmax: 60, minLength: 40000, minStraight: 30, elevation: S.elevation });
      const R = new IST.TrackRenderer(track, { theme: S.style, decor: false });
      const V = IST.View.get(), SEAT = IST.View.seat(V), cockpit = S.cockpit !== false ? IST.View.cockpit(V, S.style) : null;
      const th = R.theme, HW = track.HALF_W;
      let start = S.startExposure;
      if (S.carryOver) {
        for (let i = ctx.history.length - 1; i >= 0; i--) {
          const t = ctx.history[i].summary && ctx.history[i].summary.threshold;
          if (t > 0) {
            start = U.clamp(t * 1.5, 50, 1000);
            break;
          }
        }
      }
      const stair = new IST.Staircase({ start, min: 17, max: 1000, factor: 1.3, nDown: 2 });
      const NDIST = { none: 0, low: 3, high: 6 }[S.distractors] || 0;
      const trials = [];
      let tr = null, early = 0, lastTs = performance.now(), noScene = 0;
      // game feel: chain on "both right"; silent under "summary only" feedback
      const J = new IST.Juice({ history: ctx.history, live: S.feedback === 'every' });
      const bestThr = ctx.history.reduce((b, r) => (r.summary && r.summary.threshold > 0 ? Math.min(b, r.summary.threshold) : b), Infinity);
      let pbPace = false;

      function pickScene(W, H) {
        for (let k = 0; k < 60; k++) {
          const ci = 1 + Math.floor(rnd() * (track.corners.length - 2));
          const c = track.corners[ci], prev = track.corners[ci - 1];
          const lo = Math.max(prev.endPos + 5, c.apexPos - 300), hi = c.apexPos - 100;
          if (hi <= lo) continue;
          const pos = lo + rnd() * (hi - lo);
          const cam = { pos, x: track.lateralAt(pos) * HW, heading: rnd() * 6.28 };
          IST.View.apply(R, W, H, V);
          R.prepare(W, H, cam);
          // the board must be readable by the shared rule: on screen, clear of crests, HUD and cockpit
          const b = IST.View.boardVisible(R, c.apexPos, c.dir * HW * BOARD.KERB, { minPx: S.minTargetPx, band: BAND, cockpit, seat: SEAT, steer: IST.Cockpit.steerAt(track, pos) });
          if (b) return { c, cam, pr: b.pr };
        }
        return null; // no readable scene: never run a trial on a board you can't see
      }

      // flag geometry at a trackside spot: ground point, cloth centre and size (px); null if off screen
      function flagAt(pos, x, W, H) {
        const pr = R.project(pos, x, 0);
        if (!pr) return null;
        const size = U.clamp(FLAG_M * pr.s, W * 0.02, W * 0.05);
        const cy = pr.y - size * 1.25; // cloth on top of a pole 1.6 cloths tall
        if (pr.y > pr.clip + 0.5 || pr.x < size || pr.x > W - size || cy - size < H * 0.08 || pr.y > H) return null;
        return { pos, x, gx: pr.x, gy: pr.y, cx: pr.x + size * 0.5, cy, size };
      }
      function clearOf(f, steer) {
        if (!cockpit) return true;
        return cockpit.hidden([f.gx - 2, f.cy - f.size * 0.35, f.gx + f.size, f.gy], steer) <= BOARD.HIDE_AT;
      }

      // yellow target + mirror (mask only) on opposite verges at the same distance, white distractors
      function placeFlags(sc, W, H, side) {
        IST.View.apply(R, W, H, V);
        R.prepare(W, H, sc.cam);
        if (cockpit) cockpit.frameFor(R, SEAT);
        const steer = IST.Cockpit.steerAt(track, sc.cam.pos);
        const bx = sc.pr.x, by = sc.pr.y;
        const ecc = ECC[S.ecc] || ECC.near;
        const want = ecc[0] + rnd() * (ecc[1] - ecc[0]);
        const maxPos = Math.min(sc.c.apexPos - 15, sc.cam.pos + NEAR_MAX); // near road, short of the board
        let best = null;
        for (let pos = sc.cam.pos + 5; pos < maxPos; pos += 1.5) {
          const t = flagAt(pos, side * (HW + VERGE), W, H), m = flagAt(pos, -side * (HW + VERGE), W, H);
          if (!t || !m || !clearOf(t, steer) || !clearOf(m, steer)) continue;
          const e = Math.min(Math.hypot(t.cx - bx, t.cy - by), Math.hypot(m.cx - bx, m.cy - by)) / W;
          if (e < 0.12) continue;
          const miss = e < ecc[0] ? ecc[0] - e : e > ecc[1] ? e - ecc[1] : 0;
          const score = miss * 10 + Math.abs(e - want);
          if (!best || score < best.score) best = { score, miss, t, m };
        }
        if (!best || best.miss > 0.06) return null;
        const dist = [];
        const sep = (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy);
        for (let k = 0; k < 400 && dist.length < NDIST; k++) {
          const pos = sc.cam.pos + 5 + rnd() * (maxPos - sc.cam.pos - 5);
          const d = flagAt(pos, (rnd() < 0.5 ? -1 : 1) * (HW + VERGE + rnd() * 3), W, H);
          if (!d || !clearOf(d, steer)) continue;
          if (sep(d, best.t) < d.size * 2.2 || sep(d, best.m) < d.size * 1.5) continue;
          if (Math.hypot(d.cx - bx, d.cy - by) < d.size * 3) continue;
          if (dist.some((o) => sep(d, o) < d.size * 1.8)) continue;
          dist.push(d);
        }
        return { target: best.t, mirror: best.m, dist };
      }

      function newTrial(clock) {
        const W = ctx.W, H = ctx.H;
        const side = rnd() < 0.5 ? -1 : 1;
        let sc = null, fl = null;
        for (let k = 0; k < SCENES_PER_FRAME && !fl; k++) {
          sc = pickScene(W, H);
          if (sc) fl = placeFlags(sc, W, H, side);
        }
        if (!fl) {
          // no scene with the board and both flags in view: try again next frame, never
          // show a trial whose board or flag can't be seen
          noScene++;
          return;
        }
        noScene = 0;
        const { target, mirror, dist } = fl;
        tr = {
          phase: 'fixate', t0: clock,
          fix: trials.length === 0 ? 2600 : 700 + rnd() * 600,
          c: sc.c, cam: sc.cam,
          dir: rnd() < 0.5 ? 'up' : 'down',
          side, target, mirror, dist,
          exposure: stair.value,
          ansC: null, ansP: null, rt: null,
        };
      }

      function finishTrial(timeout) {
        const okC = tr.ansC === tr.dir;
        const okP = tr.ansP === (tr.side < 0 ? 'left' : 'right');
        trials.push({ exposure: tr.exposure, okC, okP, both: okC && okP, timeout, rt: tr.rt, side: tr.side, dist: tr.dist.length });
        stair.update(okC && okP);
        if (okC && okP) {
          const bonus = U.clamp(Math.round((350 - tr.exposure) / 25), 0, 12) + tr.dist.length;
          J.hit({ bonus, label: tr.exposure < 90 ? 'ELITE' : tr.exposure < 160 ? 'SHARP' : null });
        } else J.miss({ label: timeout ? 'TOO SLOW' : !okC && !okP ? 'BOTH MISSED' : !okC ? 'APEX MISSED' : 'FLAG MISSED' });
        if (!pbPace && isFinite(bestThr) && trials.length >= 6 && stair.value < bestThr) {
          pbPace = true;
          J.callout('PB PACE', '#f6d98f', 'flash ' + Math.round(stair.value) + ' ms, best was ' + Math.round(bestThr));
        }
        tr.okC = okC;
        tr.okP = okP;
        tr.phase = 'feedback';
        tr.fbTs = lastTs;
      }

      function drawBoard(g, pr) {
        const size = IST.View.boardSize(pr, S.minTargetPx);
        const cy = pr.y - size / 2; // bottom edge rests on the kerb
        g.globalAlpha = 0.35;
        g.fillStyle = '#000';
        g.beginPath();
        g.ellipse(pr.x, pr.y, size * 0.6, Math.max(1, size * 0.07), 0, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 1;
        Sym.board(g, pr.x, cy, size, tr.phase === 'stim' ? tr.dir : 'mask', th);
        if (tr.phase === 'fixate') Sym.ring(g, pr.x, cy, size * 0.95 + 3 * Math.sin(performance.now() / 140), '#ffb000', 2.5);
        tr.boardScr = { x: pr.x, y: cy, size };
      }

      // marshal flag on its pole, pole foot on the verge at the projected ground point
      function flagSize(pr) {
        return U.clamp(FLAG_M * pr.s, ctx.W * 0.02, ctx.W * 0.05);
      }
      function drawFlag(g, pr, color) {
        const size = flagSize(pr), pole = Math.max(2, size * 0.08);
        Sym.flag(g, pr.x + pole + size / 2, pr.y - size * 1.25, size, color);
      }
      function drawNoise(g, pr) {
        const size = flagSize(pr);
        Sym.noise(g, pr.x + size * 0.5, pr.y - size * 1.25, size * 1.35, rnd);
      }

      return {
        debug: () => ({ tr, trials, stair, R, board: () => IST.View.board(R, tr.c.apexPos, tr.c.dir * HW * BOARD.KERB, { minPx: S.minTargetPx, band: BAND }) }), // for dev tools / automated checks

        update(dt, clock, ts) {
          lastTs = ts;
          if (!tr) return newTrial(clock);
          switch (tr.phase) {
            case 'fixate':
              if (clock - tr.t0 >= tr.fix) tr.phase = 'arm';
              break;
            case 'mask':
              if (ts - tr.maskTs >= MASK_MS) {
                tr.phase = 'respond';
                if (tr.ansC && tr.ansP) finishTrial(false);
              }
              break;
            case 'respond':
              if (ts - tr.onsetTs > 6000) finishTrial(true);
              break;
            case 'feedback':
              if (ts - tr.fbTs >= (S.feedback === 'every' ? 750 : 250)) {
                if (trials.length >= S.trials) ctx.finish();
                else newTrial(clock);
              }
              break;
          }
        },

        onAction(a, t) {
          if (!tr) return;
          const open = tr.phase === 'stim' || tr.phase === 'mask' || tr.phase === 'respond';
          if (!open) {
            if (tr.phase === 'fixate' && a !== 'confirm') early++;
            return;
          }
          if ((a === 'up' || a === 'down') && !tr.ansC) tr.ansC = a;
          if ((a === 'left' || a === 'right') && !tr.ansP) tr.ansP = a;
          if (tr.ansC && tr.ansP && tr.rt == null) tr.rt = t - tr.onsetTs;
          if (tr.ansC && tr.ansP && tr.phase === 'respond') finishTrial(false);
        },

        onPause() {
          if (tr && tr.phase !== 'feedback') tr = null;
          J.pause();
        },
        onResume() {
          J.resume();
        },
        destroy() {
          J.destroy();
        },

        render(g, W, H, ts, paused) {
          if (!tr) {
            g.fillStyle = '#000';
            g.fillRect(0, 0, W, H);
            // ~1 s without a scene where the board and flags are both in clear view
            if (noScene > 60) {
              Sym.text(g, 'No clear view of an apex board with these View settings', W / 2, H / 2 - 12, { align: 'center', size: 18, weight: 720 });
              Sym.text(g, 'Try a different FOV, horizon or seat on the View screen, or turn the cockpit off.', W / 2, H / 2 + 16, { align: 'center', size: 14, alpha: 0.75 });
            }
            return;
          }
          if (!paused) {
            if (tr.phase === 'arm') {
              tr.phase = 'stim';
              tr.onsetTs = ts;
            }
            if (tr.phase === 'stim' && ts - tr.onsetTs >= tr.exposure) {
              tr.phase = 'mask';
              tr.maskTs = ts;
            }
          }
          IST.View.apply(R, W, H, V);
          const sprites = [{ pos: tr.c.apexPos, x: tr.c.dir * HW * BOARD.KERB, draw: drawBoard }];
          if (tr.phase === 'stim') {
            for (const d of tr.dist) sprites.push({ pos: d.pos, x: d.x, draw: (g2, pr) => drawFlag(g2, pr, '#eef0f4') });
            sprites.push({ pos: tr.target.pos, x: tr.target.x, draw: (g2, pr) => drawFlag(g2, pr, '#f5c400') });
          } else if (tr.phase === 'mask') {
            for (const f of [tr.target, tr.mirror].concat(tr.dist)) sprites.push({ pos: f.pos, x: f.x, draw: drawNoise });
          }
          R.render(g, W, H, tr.cam, sprites);
          if (cockpit) {
            cockpit.frameFor(R, SEAT);
            cockpit.draw(g, IST.Cockpit.steerAt(track, tr.cam.pos), IST.Cockpit.dash(track.speedAt(tr.cam.pos)));
          }

          // response prompt / feedback
          const by = H - Math.max(40, H * 0.06);
          const fs = Math.max(16, Math.min(22, W * 0.016));
          if (tr.phase === 'mask' || tr.phase === 'respond' || tr.phase === 'feedback') {
            const fb = tr.phase === 'feedback' && S.feedback === 'every';
            const cTxt = 'APEX  ' + (tr.ansC ? (tr.ansC === 'up' ? '↑' : '↓') : '↑ / ↓');
            const pTxt = 'FLAG  ' + (tr.ansP ? (tr.ansP === 'left' ? '←' : '→') : '← / →');
            const cCol = fb ? (tr.okC ? '#30d158' : '#ff453a') : tr.ansC ? '#ffffff' : '#c3c9d4';
            const pCol = fb ? (tr.okP ? '#30d158' : '#ff453a') : tr.ansP ? '#ffffff' : '#c3c9d4';
            g.fillStyle = 'rgba(0,0,0,.55)';
            Sym.roundRect(g, W / 2 - fs * 11, by - fs * 1.6, fs * 22, fs * 2.4, 10);
            g.fill();
            Sym.text(g, cTxt, W / 2 - fs * 0.8, by, { align: 'right', size: fs, weight: 720, color: cCol });
            Sym.text(g, pTxt, W / 2 + fs * 0.8, by, { align: 'left', size: fs, weight: 720, color: pCol });
            if (fb && !(tr.okC && tr.okP)) {
              const truth = 'was ' + (tr.dir === 'up' ? '↑' : '↓') + ' and ' + (tr.side < 0 ? '←' : '→');
              Sym.text(g, truth, W / 2, by - fs * 2.1, { align: 'center', size: fs * 0.8, weight: 420, color: '#c3c9d4' });
            }
          }

          Sym.text(g, 'Trial ' + Math.min(S.trials, trials.length + 1) + ' / ' + S.trials, 18, 30, { size: 16, alpha: 0.75 });
          Sym.text(g, 'flash ' + Math.round(tr.exposure) + ' ms', W - 18, 30, { size: 14, weight: 420, align: 'right', alpha: 0.6 });
          if (trials.length === 0 && tr.phase === 'fixate') {
            Sym.text(g, 'Eyes on the ringed board', W / 2, H * 0.16, { align: 'center', size: Math.max(22, W * 0.02), weight: 820 });
            Sym.text(g, '↑/↓ symbol  ·  ←/→ flag side', W / 2, H * 0.16 + 32, { align: 'center', size: 15, weight: 340, alpha: 0.85 });
          }
          // chain block top-left under the trial counter: boards and flags stay right of 15% width and below
          // 8% height; callouts at the very top
          J.render(g, W, H, { x: 62, y: 44, size: 28, side: 1, callY: 34, vignette: false });
        },

        result() {
          const n = trials.length;
          const frac = (k) => (n ? trials.filter((t) => t[k]).length / n : null);
          const side = (s) => {
            const a = trials.filter((t) => t.side === s);
            return [a.length, a.filter((t) => t.okP).length];
          };
          return {
            detail: {
              // [exposure ms, apex ok, flag ok, flag side, distractors, rt ms]
              trials: trials.map((t) => [Math.round(t.exposure), t.okC ? 1 : 0, t.okP ? 1 : 0, t.side, t.dist, t.rt == null ? -1 : Math.round(t.rt)]),
            },
            summary: {
              byFlagSide: { L: side(-1), R: side(1) },
              threshold: n >= 6 ? stair.threshold() : null,
              bothAcc: frac('both'),
              centralAcc: frac('okC'),
              periphAcc: frac('okP'),
              early,
              ...J.summary(),
              trials: n,
            },
          };
        },
      };
    },
  });
})();
