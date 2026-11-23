/*
 * Warm-up: Start Lights. Five lights come on one per second, then go out
 * after an unpredictable hold. React to lights-out.
 */
(function () {
  'use strict';
  const U = IST.util, Sym = IST.Symbols;
  const RESPOND = ['confirm', 'up', 'down', 'left', 'right'];

  IST.registerDrill({
    id: 'start-lights',
    name: 'Start Lights',
    category: 'Warm-up',
    tab: 'reflex', // menu tab: 'vision' (default) | 'mind' | 'reflex'
    tagline: 'React to lights-out.',
    description:
      'Five lights, random hold. Press any input when they go out.',
    research: [
      {
        point: 'Reaction drills are a standard driver warm-up.',
        source: 'Cotterill (2010), Int. Rev. Sport Exerc. Psychol. 3(2).',
      },
      {
        point: 'A random hold stops you timing the start.',
        source: 'Niemi & Näätänen (1981), Psychological Bulletin 89(1).',
      },
      {
        point: 'Under 100 ms counts as a jump start.',
        source: 'Pain & Hibbs (2007), J. Sports Sciences 25(1).',
      },
    ],
    settings: [
      { key: 'trials', label: 'Starts', type: 'number', default: 8, min: 3, max: 30, step: 1 },
      { key: 'holdMax', label: 'Max hold', type: 'number', unit: 'ms', default: 3000, min: 500, max: 5000, step: 100 },
    ],
    metrics: [
      { key: 'median', label: 'Median reaction', unit: 'ms', digits: 0, better: 'lower', primary: true },
      { key: 'best', label: 'Best reaction', unit: 'ms', digits: 0, better: 'lower' },
      { key: 'mean', label: 'Mean reaction', unit: 'ms', digits: 0, better: 'lower' },
      { key: 'sd', label: 'Spread (SD)', unit: 'ms', digits: 0, better: 'lower' },
      { key: 'jumps', label: 'Jump starts', digits: 0, better: 'lower' },
      ...IST.Juice.METRICS,
      { key: 'valid', label: 'Valid starts', digits: 0 },
    ],
    coach(s) {
      const tips = [];
      if (s.jumps >= 2) tips.push('Jump starts: react to the lights, not a rhythm.');
      if (U.isNum(s.median) && s.median > 320) tips.push('Slow today. Watch the whole gantry, finger ready.');
      if (U.isNum(s.sd) && s.sd > 60) tips.push('Inconsistent starts. Same routine every time.');
      if (U.isNum(s.median) && s.median <= 250 && s.jumps === 0) tips.push('Sharp and clean.');
      return tips;
    },

    analyze(results, A) {
      const recent = results.slice(-10);
      const out = { breakdowns: [], notes: [], insim: [] };
      const jumps = recent.reduce((s, r) => s + ((r.summary && r.summary.jumps) || 0), 0);
      const valid = recent.reduce((s, r) => s + ((r.summary && r.summary.valid) || 0), 0);
      const rts = recent.flatMap((r) => (r.detail && r.detail.rts) || []);
      if (rts.length) {
        out.breakdowns.push({ type: 'histogram', title: 'Reaction times', subtitle: rts.length + ' starts', values: rts, bin: 20, unit: 'ms' });
      }
      const rate = jumps + valid ? jumps / (jumps + valid) : 0;
      if (jumps + valid >= 10 && rate > 0.12) out.insim.push({ id: 'STARTS_JUMP', score: 0.3 + rate, evidence: Math.round(rate * 100) + '% jump starts (' + jumps + ' of ' + (jumps + valid) + ')' });
      const meds = A.values(recent, 'median').filter(U.isNum);
      const med = meds.length ? U.median(meds) : null;
      if (med != null && med > 300) out.insim.push({ id: 'STARTS_SLOW', score: 0.2 + Math.min(0.3, (med - 300) / 300), evidence: 'Median reaction ' + Math.round(med) + ' ms' });
      // readiness: is today's start much slower than your norm?
      const all = A.values(results, 'median').filter(U.isNum);
      if (all.length >= 6) {
        const prev = all.slice(0, -1), last = all[all.length - 1];
        const m = U.mean(prev), sd = U.sd(prev);
        if (sd > 0 && last > m + 2 * sd) out.notes.push({ tone: 'bad', text: 'Start Lights: slower than usual (' + Math.round(last) + ' vs ~' + Math.round(m) + ' ms). Possible fatigue.' });
      }
      return out;
    },

    create(ctx) {
      const S = ctx.settings;
      const rnd = U.rng(U.randomSeed());
      const trials = [];
      let tr = null;
      // game feel: chain of clean starts, graded by reaction time
      const J = new IST.Juice({ history: ctx.history });
      const bestEver = ctx.history.reduce((b, r) => (r.summary && r.summary.best > 0 ? Math.min(b, r.summary.best) : b), Infinity);
      let bestNow = bestEver;
      const GRADES = [[180, 'LIGHTNING', 20, '#f6d98f'], [215, 'SHARP', 12, '#9fcbef'], [260, 'GOOD', 5, null]];
      function scoreStart(rt) {
        const gr = GRADES.find((x) => rt < x[0]);
        J.hit({ bonus: gr ? gr[2] : 0, label: gr ? gr[1] : null, color: gr ? gr[3] : null });
        if (rt < bestNow) {
          if (isFinite(bestNow)) J.callout('NEW BEST START', '#f6d98f', Math.round(rt) + ' ms');
          bestNow = rt;
        }
      }

      const newTrial = (clock) => {
        tr = { phase: 'ready', t0: clock, hold: 200 + rnd() * Math.max(0, S.holdMax - 200), lights: 0, msg: '', rt: null };
      };
      const toResult = (clock, msg, rt) => {
        tr.phase = 'result';
        tr.t0 = clock;
        tr.msg = msg;
        tr.rt = rt;
      };
      const valid = () => trials.filter((t) => !t.jump && U.isNum(t.rt)).map((t) => t.rt);

      return {
        debug: () => ({ tr, trials }), // for dev tools / automated checks

        update(dt, clock, ts) {
          if (!tr) return newTrial(clock);
          const e = clock - tr.t0;
          if (tr.phase === 'ready' && e >= (trials.length === 0 ? 2500 : 1000)) {
            tr.phase = 'build';
            tr.t0 = clock;
          } else if (tr.phase === 'build') {
            tr.lights = Math.min(5, Math.floor(e / 1000) + 1);
            if (e >= 4000 + tr.hold) tr.phase = 'arm';
          } else if (tr.phase === 'out' && ts - tr.outTs > 1500) {
            trials.push({ rt: null, miss: true });
            toResult(clock, 'Too slow', null);
            J.miss({ label: 'TOO SLOW' });
          } else if (tr.phase === 'result' && e > 1600) {
            if (trials.length >= S.trials) ctx.finish();
            else newTrial(clock);
          }
        },

        onAction(a, t) {
          if (!tr || RESPOND.indexOf(a) < 0) return;
          if (tr.phase === 'build' || tr.phase === 'arm') {
            trials.push({ rt: null, jump: true });
            toResult(ctx.clock(), 'JUMP START', null);
            J.miss({ label: 'JUMP' });
          } else if (tr.phase === 'out') {
            const rt = t - tr.outTs;
            if (rt < 100) {
              trials.push({ rt, jump: true });
              toResult(ctx.clock(), 'JUMP START', null);
              J.miss({ label: 'JUMP' });
            } else {
              trials.push({ rt });
              toResult(ctx.clock(), '', rt);
              scoreStart(rt);
            }
          }
        },

        onPause() {
          if (tr && tr.phase !== 'result') tr = null;
          J.pause();
        },
        onResume() {
          J.resume();
        },
        destroy() {
          J.destroy();
        },

        render(g, W, H, ts, paused) {
          if (tr && tr.phase === 'arm' && !paused) {
            tr.phase = 'out';
            tr.outTs = ts;
          }
          g.fillStyle = '#07080a';
          g.fillRect(0, 0, W, H);

          const unit = Math.min(W * 0.085, H * 0.11, 120);
          const gap = unit * 0.32;
          const total = 5 * unit + 4 * gap;
          const x0 = (W - total) / 2, y0 = H * 0.2;
          const lit = tr && tr.phase === 'build' ? tr.lights : 0;
          g.fillStyle = '#121418';
          g.fillRect(x0 - gap, y0 - unit * 0.35, total + gap * 2, unit * 0.22);
          for (let i = 0; i < 5; i++) {
            const x = x0 + i * (unit + gap);
            Sym.roundRect(g, x, y0, unit, unit * 2.2, unit * 0.16);
            g.fillStyle = '#15171c';
            g.fill();
            g.lineWidth = 2;
            g.strokeStyle = '#2a2e37';
            g.stroke();
            for (let r = 0; r < 2; r++) {
              const cx = x + unit / 2, cy = y0 + unit * (0.6 + r * 1.0), rad = unit * 0.36;
              g.beginPath();
              g.arc(cx, cy, rad, 0, Math.PI * 2);
              if (i < lit) {
                g.shadowColor = 'rgba(255,40,30,.9)';
                g.shadowBlur = unit * 0.6;
                g.fillStyle = '#ff2b1f';
              } else {
                g.shadowBlur = 0;
                g.fillStyle = '#2a0d0c';
              }
              g.fill();
              g.shadowBlur = 0;
            }
          }

          const v = valid();
          const ty = y0 + unit * 2.2 + H * 0.16;
          if (!tr || tr.phase === 'ready') {
            Sym.text(g, 'React when the lights go out', W / 2, ty, { align: 'center', size: Math.max(18, W * 0.018), weight: 350, color: '#cfd5df' });
          } else if (tr.phase === 'result') {
            if (tr.msg) Sym.text(g, tr.msg, W / 2, ty, { align: 'center', size: Math.max(36, W * 0.04), weight: 900, color: '#ff453a' });
            else Sym.text(g, Math.round(tr.rt) + ' ms', W / 2, ty, { align: 'center', size: Math.max(48, W * 0.06), weight: 900, color: '#ffffff' });
            if (v.length)
              Sym.text(g, 'Best ' + Math.round(Math.min.apply(null, v)) + ' ms   ·   Median ' + Math.round(U.median(v)) + ' ms', W / 2, ty + Math.max(36, W * 0.03), { align: 'center', size: 16, weight: 400, color: '#8a93a6' });
          }
          Sym.text(g, 'Start ' + Math.min(S.trials, trials.length + (tr && tr.phase !== 'result' ? 1 : 0)) + ' / ' + S.trials, 18, 30, { size: 16, alpha: 0.7 });
          Sym.text(g, 'Esc', W - 18, 30, { size: 13, align: 'right', alpha: 0.45 });
          J.render(g, W, H, { x: W / 2, y: H * 0.74, size: U.clamp(H * 0.06, 34, 54), side: 1, callY: Math.max(36, H * 0.07) });
        },

        result() {
          const v = valid();
          return {
            detail: { rts: v.map((x) => Math.round(x)) },
            summary: {
              median: v.length ? U.median(v) : null,
              best: v.length ? Math.min.apply(null, v) : null,
              mean: v.length ? U.mean(v) : null,
              sd: v.length > 1 ? U.sd(v) : null,
              jumps: trials.filter((t) => t.jump).length,
              ...J.summary(),
              valid: v.length,
            },
          };
        },
      };
    },
  });
})();
