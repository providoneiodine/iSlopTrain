/*
 * Two-Point Focus: a Useful-Field-of-View-style drill set in a corner approach.
 *
 * Fixate the far apex board. For a brief, masked moment, a symbol (▲/▼)
 * appears on the board AND a yellow marshal flag appears somewhere in the
 * near-field periphery (left or right). Report both. Exposure adapts.
 * This trains the far point + near point split of skilled steering.
 */
(function () {
  'use strict';
  const U = IST.util, Sym = IST.Symbols;
  const BOARD_M = 2.4; // board edge, metres
  const BOARD_KERB = 1.07; // board stands on the inside kerb at the apex (half-widths), so fixating it = fixating the apex
  const MASK_MS = 260;

  IST.registerDrill({
    id: 'two-point',
    name: 'Two-Point Focus',
    category: 'Core',
    tagline: 'Eyes far, attention wide.',
    description: 'Keep your eyes on the ringed apex board. Report its symbol (↑/↓) and which side the yellow flag was on (←/→).',
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
      { key: 'fov', label: 'FOV (horizontal)', type: 'number', unit: '°', default: 70, min: 30, max: 120, step: 1 },
      { key: 'style', label: 'Style', type: 'select', default: 'realistic', options: [['realistic', 'Realistic'], ['minimal', 'Minimal']] },
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
      const R = new IST.TrackRenderer(track, { theme: S.style, fov: S.fov, decor: false });
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
      let tr = null, early = 0, lastTs = performance.now();
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
          R.prepare(W, H, cam);
          const pr = R.project(c.apexPos, c.dir * HW * BOARD_KERB, 0);
          const boardY = pr ? pr.y - Math.max(S.minTargetPx, BOARD_M * pr.s) / 2 : 0;
          if (pr && pr.x > W * 0.15 && pr.x < W * 0.85 && pr.y <= pr.clip + 0.5 && boardY > H * 0.08) return { c, cam, pr };
        }
        const c = track.corners[1];
        const cam = { pos: c.apexPos - 150, x: 0, heading: 0 };
        R.prepare(W, H, cam);
        return { c, cam, pr: R.project(c.apexPos, c.dir * HW * BOARD_KERB, 0) };
      }

      function newTrial(clock) {
        const W = ctx.W, H = ctx.H;
        const sc = pickScene(W, H);
        const size = Math.max(26, W * 0.032);
        const side = rnd() < 0.5 ? -1 : 1;
        const ecc = (S.ecc === 'wide' ? 0.36 : 0.25) + (rnd() - 0.5) * 0.06;
        const target = { fx: 0.5 + side * ecc, fy: 0.64 + rnd() * 0.18 };
        const mirror = { fx: 0.5 - side * ecc, fy: target.fy };
        const bx = sc.pr ? sc.pr.x / W : 0.5, by = sc.pr ? sc.pr.y / H : 0.45;
        const dist = [];
        for (let k = 0; k < 400 && dist.length < NDIST; k++) {
          const d = { fx: 0.06 + rnd() * 0.88, fy: 0.52 + rnd() * 0.38 };
          const px = (a, b) => Math.hypot((a.fx - b.fx) * W, (a.fy - b.fy) * H);
          if (px(d, target) < size * 2.2) continue;
          if (px(d, { fx: bx, fy: by }) < size * 3) continue;
          if (dist.some((o) => px(d, o) < size * 1.8)) continue;
          dist.push(d);
        }
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
        const size = Math.max(S.minTargetPx, BOARD_M * pr.s);
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

      return {
        debug: () => ({ tr, trials, stair }), // for dev tools / automated checks

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
          R.render(g, W, H, tr.cam, [{ pos: tr.c.apexPos, x: tr.c.dir * HW * BOARD_KERB, draw: drawBoard }]);

          const size = Math.max(26, W * 0.032);
          const P = (p) => [p.fx * W, p.fy * H];
          if (tr.phase === 'stim') {
            for (const d of tr.dist) Sym.flag(g, P(d)[0], P(d)[1], size, '#eef0f4');
            Sym.flag(g, P(tr.target)[0], P(tr.target)[1], size, '#f5c400');
          } else if (tr.phase === 'mask') {
            for (const p of [tr.target, tr.mirror].concat(tr.dist)) Sym.noise(g, P(p)[0], P(p)[1], size * 1.35, rnd);
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
            Sym.text(g, cTxt, W / 2 - fs * 0.8, by, { align: 'right', size: fs, weight: 700, color: cCol });
            Sym.text(g, pTxt, W / 2 + fs * 0.8, by, { align: 'left', size: fs, weight: 700, color: pCol });
            if (fb && !(tr.okC && tr.okP)) {
              const truth = 'was ' + (tr.dir === 'up' ? '↑' : '↓') + ' and ' + (tr.side < 0 ? '←' : '→');
              Sym.text(g, truth, W / 2, by - fs * 2.1, { align: 'center', size: fs * 0.8, weight: 400, color: '#c3c9d4' });
            }
          }

          Sym.text(g, 'Trial ' + Math.min(S.trials, trials.length + 1) + ' / ' + S.trials, 18, 30, { size: 16, alpha: 0.75 });
          Sym.text(g, 'flash ' + Math.round(tr.exposure) + ' ms', W - 18, 30, { size: 14, weight: 400, align: 'right', alpha: 0.6 });
          if (trials.length === 0 && tr.phase === 'fixate') {
            Sym.text(g, 'Eyes on the ringed board', W / 2, H * 0.16, { align: 'center', size: Math.max(22, W * 0.02), weight: 850 });
            Sym.text(g, '↑/↓ symbol  ·  ←/→ flag side', W / 2, H * 0.16 + 32, { align: 'center', size: 15, weight: 350, alpha: 0.85 });
          }
          // chain block top-left under the trial counter: boards stay right of 15% width and below 8% height,
          // flags in the lower half; callouts at the very top
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
