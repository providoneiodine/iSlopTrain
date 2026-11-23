/*
 * Clean Slate: recovering from a run of errors.
 *
 * Core task, rhythm-game style: rows of arrows scroll along a lane to a hit
 * line on a steady beat. By default they rise to a hit line near the top of
 * the screen, so your eyes stay up where they'd be in the car; a setting
 * flips it to a falling lane, and another sets how long a row is in view. Each row shows grey pattern masks until it crosses
 * the reveal line, then turns into arrows: one is BLUE (press its
 * direction) or ORANGE (press the opposite way), the rest are flankers
 * that point the same way or not (Eriksen & Eriksen, 1974). Press as the
 * row crosses the hit window (±150 ms). Too early or wrong = error;
 * passing the window = miss.
 *
 * A weighted up/down staircase (Kaernbach, 1991) moves the reveal line
 * (how long before the hit line you can read the row) so you are ~88 %
 * right on normal rows.
 *
 * Without warning the drill throws a burst of 3-7 rows you will mostly
 * fail (squeeze: late reveal; rush: double tempo; clutter: seven arrows,
 * a lookalike, all flankers against you; flip: mostly orange; double hit:
 * a second burst before you've recovered). Straight after a burst the
 * reveal snaps back to its pre-burst value, so any dip afterwards is you,
 * not the task.
 *
 * Metrics: rows to recover (3 clean answers in a row), recovery cost,
 * error chaining (P(err | err) - P(err | ok)), and post-error shift with
 * the robust pre/post comparison of Dutilh et al. (2012), labelled
 * hesitant / rushing / steady.
 *
 * Two ladders adapt between sessions: burst level (1-6) and distraction
 * level (0-6: peripheral pops, taunt words, decoy arrows, chirps, a
 * drifting row, fake error buzzes, HUD glitches). Distractions land on
 * normal rows only, so their cost is measured against distraction-free ones.
 *
 * The chain (streak, multiplier tiers, timing grades, rising tones) is the
 * reward that offsets the sting of errors; errors in a row cost 1, 2, 4, 8x
 * (capped).
 *
 * Split across js/drills/clean-slate/ (content.js lists the files). This
 * one holds the definition, the row engine and input.
 */
(function () {
  'use strict';
  const U = IST.util, CS = IST.CleanSlate, TH = IST.Theme;
  const { DIRS, OPP, PERP, APPROACH, APPROACH_OPTS, BEAT, RUSH_BEAT, HW, PERFECT, GREAT, ORANGE_BASE, WARMUP, REC_WIN, CLEAN_RUN, SLOW_X, TARGET } = CS;
  const { LEAD_MIN, MAX_LEVEL, COL, BURST_LEVELS, DIST_LEVELS, DIST_DUR, WORDS, POP_COLORS, levelOpts } = CS;

  // Chain tiers, sounds and colour helpers are shared with the other drills (components/juice.js).
  const TIERS = IST.Juice.TIERS, tierOf = IST.Juice.tierOf, makeAudio = IST.Juice.makeAudio;

  const DEF = {
    id: 'clean-slate',
    name: 'Clean Slate',
    tab: 'mind',
    category: 'Recovery',
    tagline: 'Make a mistake, then make the next one count.',
    description:
      'Rows of arrows scroll to the hit line on a steady beat. When a row is revealed, find the BLUE arrow and press its direction as the row hits the line. ' +
      'ORANGE arrow: press the opposite way. Ignore the grey arrows and anything else on screen. ' +
      'Build a chain: the multiplier climbs at 5, 10, 20, 35, 50, 75 and 100. ' +
      'Without warning you get a short run of rows you will mostly fail (late reveal, double tempo, clutter, mostly orange). ' +
      'Errors in a row cost more each time. What counts is how fast you are back to normal afterwards. ' +
      'Burst and distraction levels climb as your recovery gets quicker.',
    research: [
      { point: 'People slow down after errors, and the next answer is often worse, not better.', source: 'Rabbitt (1966), J. Exp. Psychol. 71(2); Notebaert et al. (2009), Cognition 111(2).' },
      { point: 'Post-error slowing is measured fairly by comparing the trials just before and after each error.', source: 'Dutilh, van Ravenzwaaij, Nieuwenhuis, van der Maas, Forstmann & Wagenmakers (2012), J. Math. Psychol. 56(3).' },
      { point: 'Flanker arrows are a standard test of ignoring conflicting information.', source: 'Eriksen & Eriksen (1974), Perception & Psychophysics 16(1).' },
      { point: 'Switching between rules (blue vs orange) carries a reliable cost.', source: 'Monsell (2003), Trends in Cognitive Sciences 7(3).' },
      { point: 'A weighted up/down staircase holds any target accuracy, here ~88 %.', source: 'Kaernbach (1991), Perception & Psychophysics 49(3).' },
      { point: 'Anxiety pulls attention towards irrelevant and threatening stimuli.', source: 'Eysenck, Derakshan, Santos & Calvo (2007), Emotion 7(2).' },
      { point: 'Irrelevant distractors still cost performance, especially when the task is easy.', source: 'Forster & Lavie (2008), J. Exp. Psychol. Applied 14(1).' },
      { point: 'Training under mild pressure protects against choking under high pressure.', source: 'Oudejans & Pijpers (2010), Psychol. Sport Exerc. 11(1).' },
      { point: 'Practising under pressure improves performance under pressure (g ≈ 0.67).', source: 'Low, Sandercock, Freeman, Winter, Butt & Maynard (2021), Sport, Exercise, and Performance Psychology.' },
    ],
    settings: [
      { key: 'duration', label: 'Duration', type: 'number', unit: 's', default: 180, min: 60, max: 900, step: 30 },
      { key: 'burst', label: 'Burst level', type: 'select', default: 'auto', options: levelOpts(false), hint: 'Longer bursts, more types, double hits from 4.' },
      { key: 'distract', label: 'Distraction level', type: 'select', default: 'auto', options: levelOpts(true), hint: 'Flashes, taunt words, decoy arrows, sounds, drifting rows, fake error buzzes, HUD glitches.' },
      { key: 'approach', label: 'Approach speed', type: 'select', default: String(APPROACH), options: APPROACH_OPTS, hint: 'How long a row takes to travel the lane. The reveal line still adapts within it.' },
      { key: 'hitTop', label: 'Hit line at the top', type: 'bool', default: true, hint: 'Rows rise to a hit line near the top of the screen, keeping your eyes up as in the car. Off: rows fall to the bottom.' },
      { key: 'sound', label: 'Sound', type: 'bool', default: true, hint: 'Chain tones, beat ticks, error buzz, sound distractions.' },
      { key: 'resetCue', label: 'Reset cue', type: 'bool', default: false, hint: 'Press Confirm (Space / A) the moment you let a bad run go. Compares recovery with and without it.' },
    ],
    metrics: [
      { key: 'recovery', label: 'Recovery', unit: 'rows', digits: 1, better: 'lower', primary: true, hint: 'Rows after a burst before 3 clean answers in a row (correct, normal speed). 0 = straight back.' },
      { key: 'recCost', label: 'Recovery cost', pct: true, digits: 0, better: 'lower', hint: 'Baseline accuracy minus accuracy in the 10 rows after a burst (points).' },
      { key: 'postSlow', label: 'Post-burst slowdown', pct: true, digits: 0, better: 'lower', hint: 'Median correct time after bursts vs baseline.' },
      { key: 'chainRate', label: 'Error chaining', pct: true, digits: 0, better: 'lower', hint: 'Chance of an error right after an error, minus right after a correct answer (normal rows).' },
      { key: 'pes', label: 'Post-error shift', unit: 'ms', digits: 0, hint: 'Row after an error vs the row before it. + = hesitant (later), − = rushing (earlier). Near 0 is the goal.' },
      { key: 'postErrAcc', label: 'Accuracy after an error', pct: true, digits: 0, better: 'higher' },
      { key: 'bestChain', label: 'Best chain', digits: 0, better: 'higher' },
      { key: 'score', label: 'Score', digits: 0, better: 'higher' },
      { key: 'perfectRate', label: 'Perfect hits', pct: true, digits: 0, better: 'higher', hint: 'Correct answers within ' + PERFECT + ' ms of the line.' },
      { key: 'timing', label: 'Timing error', unit: 'ms', digits: 0, better: 'lower', hint: 'Mean distance from the line on correct answers.' },
      { key: 'burstLevel', label: 'Burst level', digits: 0, better: 'higher' },
      { key: 'distractLevel', label: 'Distraction level', digits: 0, better: 'higher' },
      { key: 'distCost', label: 'Distraction cost', pct: true, digits: 0, better: 'lower', hint: 'Accuracy without distractions minus with them (points).' },
      { key: 'distRT', label: 'Distraction time cost', unit: 'ms', digits: 0, better: 'lower' },
      { key: 'resetGain', label: 'Reset cue gain', unit: 'rows', digits: 1, better: 'higher', hint: 'Recovery without the reset press minus with it.' },
      { key: 'baseAcc', label: 'Baseline accuracy', pct: true, digits: 0 },
      { key: 'lead', label: 'Reveal lead', unit: 'ms', digits: 0, better: 'lower', hint: 'How long before the hit line rows are revealed. Shorter = less time to read.' },
      { key: 'baseRT', label: 'Baseline time', unit: 'ms', digits: 0, hint: 'Median time from reveal to a correct press.' },
      { key: 'bursts', label: 'Bursts measured', digits: 0 },
      { key: 'trials', label: 'Rows', digits: 0 },
    ],

    /** Ladder level for a new run: fixed by setting, or the last run's recommendation. */
    levelFor(setting, history, nextKey, key) {
      if (setting === 'off') return 0;
      if (setting && setting !== 'auto') return U.clamp(Number(setting) || 1, 1, MAX_LEVEL);
      return IST.Analysis.latest(history, nextKey, key) || 1;
    },

    coach: CS.coach,
    analyze: CS.analyze,

    create(ctx) {
      const S = ctx.settings;
      const rnd = U.rng(U.randomSeed());
      const hist = ctx.history;
      const bLevel = DEF.levelFor(S.burst, hist, 'nextBurstLevel', 'burstLevel');
      const dLevel = DEF.levelFor(S.distract, hist, 'nextDistractLevel', 'distractLevel');
      const BL = BURST_LEVELS[bLevel], DL = DIST_LEVELS[dLevel];
      const audio = S.sound && IST.Juice.mode() === 'full' ? makeAudio() : null; // Data → Game feel: Silent mutes it too
      const distTypes = DL.types.filter((t) => audio || (t !== 'chirp' && t !== 'fakebuzz'));
      const allTimeBest = IST.Analysis.best(hist, 'bestChain', 'higher') || 0;
      const endMs = S.duration * 1000;
      const APP = Number(S.approach) || APPROACH, LEAD_MAX = APP;
      const hitTop = S.hitTop !== false;

      // reveal lead: start from last session's value, a little easier
      const lastLead = IST.Analysis.latest(hist, 'lead');
      let lead = lastLead ? U.clamp(lastLead * 1.1, LEAD_MIN, LEAD_MAX) : 800;
      let baseSteps = 0, descending = true;
      const stair = (ok) => {
        // fast descent until the first error, then the weighted up/down walk
        if (descending) {
          if (ok) {
            lead = U.clamp(lead / 1.08, LEAD_MIN, LEAD_MAX);
            return;
          }
          descending = false;
        }
        const step = baseSteps++ < 20 ? 1.15 : 1.08;
        lead = U.clamp(ok ? lead / Math.pow(step, (1 - TARGET) / TARGET) : lead * step, LEAD_MIN, LEAD_MAX);
      };

      const notes = [], trials = [], bursts = [];
      let pending = null, rec = null, now = 0, lastTs = 0, spawned = 0, stopped = false, queued = null;
      let lastArrive = 1400; // first row arrives one beat after this, ~1.4 s of lane fill-in
      let nextBurstAt = WARMUP + rnd.int(0, 8);
      let chain = 0, bestChain = 0, score = 0, errRun = 0, stray = 0, brokenN = 0, newBestShown = false;
      let chainPopT = -1e9, breakT = -1e9, brokenChain = 0, errT = -1e9, hitFlashT = -1e9;
      const fx = [];
      const okRTs = [];
      const baseRTnow = () => (okRTs.length >= 6 ? U.median(okRTs.slice(-40)) : lead);
      const addFx = (o) => fx.push(Object.assign({ t0: now }, o));

      // ------------------------------------------------- burst scheduling
      // Row kinds are assigned when a row is spawned (rows are in flight
      // ahead of the player), so the burst/recovery bookkeeping lives here.
      const canFit = () => endMs - lastArrive >= (BL.len[1] + REC_WIN + 2) * BEAT;
      function startBurst(double, frozen) {
        const id = bursts.length;
        const type = rnd.pick(BL.types);
        bursts.push({ id, type, len: rnd.int(BL.len[0], BL.len[1]), double, interrupted: false, reset: false, run: 0, recovered: null });
        pending = { id, type, left: bursts[id].len, frozen: frozen || lead };
      }
      function nextKind(i) {
        if (!pending && !rec && i >= nextBurstAt && canFit()) startBurst(false);
        if (pending) {
          const f = pending.frozen, bt = pending.type;
          const k = { ph: 'burst', bt, bid: pending.id, lead: f * (bt === 'squeeze' ? BL.sq : bt === 'rush' ? 0.85 : bt === 'clutter' ? 0.85 : 0.9), beat: bt === 'rush' ? RUSH_BEAT : BEAT };
          if (--pending.left === 0) {
            const b = bursts[pending.id];
            rec = { id: b.id, pos: 0, frozen: f, dblAt: !b.double && BL.dbl && rnd() < BL.dbl ? rnd.int(2, 4) : 0 };
            pending = null;
          }
          return k;
        }
        if (rec) {
          const k = { ph: 'rec', bid: rec.id, pos: rec.pos, lead: rec.frozen, beat: BEAT };
          rec.pos++;
          if (rec.dblAt && rec.pos >= rec.dblAt) {
            bursts[rec.id].interrupted = true;
            const f = rec.frozen;
            rec = null;
            startBurst(true, f);
          } else if (rec.pos >= REC_WIN) {
            rec = null;
            nextBurstAt = i + 1 + rnd.int(BL.gap[0] - REC_WIN, BL.gap[1] - REC_WIN);
          }
          return k;
        }
        return { ph: 'base', lead, beat: BEAT };
      }

      // ------------------------------------------------------------ rows
      function makeDist(type) {
        let u = 0.1, v = 0.4;
        for (let k = 0; k < 24; k++) {
          u = rnd.range(0.04, 0.96);
          v = rnd.range(0.1, 0.9);
          const inLane = Math.abs(u - 0.5) < 0.22;
          if (type === 'decoy' && inLane) continue; // decoys stay out of the lane
          if (inLane && (hitTop ? v < 0.38 : v > 0.62)) continue; // never on top of the hit zone
          break;
        }
        return {
          type, u, v, soa: rnd.range(DL.soa[0], DL.soa[1]), dur: DIST_DUR[type], fired: false,
          word: rnd.pick(WORDS), dir: rnd.pick(DIRS), shape: rnd.int(0, 2), color: rnd.pick(POP_COLORS),
        };
      }
      function makeRow() {
        const i = spawned;
        const k = nextKind(i);
        const clutter = k.bt === 'clutter';
        const orange = rnd() < (k.bt === 'flip' ? 0.65 : ORANGE_BASE);
        const n = clutter ? 7 : 5;
        const tgt = rnd.int(0, n - 1);
        const dir = rnd.pick(DIRS);
        const cong = clutter ? false : rnd() < 0.5;
        // flankers point the same way as the coloured arrow, or not
        const ans = orange ? OPP[dir] : dir;
        const fl = cong ? dir : rnd() < 0.7 ? OPP[dir] : rnd.pick(PERP[dir]);
        let look = -1;
        if (clutter) {
          look = rnd.int(0, n - 2);
          if (look >= tgt) look++;
        }
        const offs = Array.from({ length: n }, () => (clutter ? rnd.range(-0.3, 0.3) : 0));
        const noise = clutter ? Array.from({ length: 18 }, () => [rnd.range(-0.48, 0.48), rnd.range(-0.7, 0.7), rnd.range(0.15, 0.5), rnd()]) : null;
        let dist = null, jx = 0;
        if (DL.rate && distTypes.length && k.ph !== 'burst' && i >= 4 && rnd() < DL.rate) {
          const pool = distTypes.slice();
          const m = DL.multi && rnd() < DL.multi ? 2 : 1;
          dist = [];
          for (let j = 0; j < m && pool.length; j++) dist.push(makeDist(pool.splice(rnd.int(0, pool.length - 1), 1)[0]));
          if (dist.some((d) => d.type === 'jitter')) jx = rnd() < 0.5 ? -1 : 1;
        }
        const arriveT = lastArrive + k.beat;
        const ld = U.clamp(k.lead, LEAD_MIN, LEAD_MAX);
        spawned++;
        return Object.assign({}, k, {
          i, n, tgt, dir, orange, ans, cong, fl, look, offs, noise, dist, jx, lead: ld,
          arriveT, spawnT: arriveT - APP, revealT: arriveT - ld, resolved: false, ticked: false,
        });
      }

      function resolve(r, ok, tc, why) {
        r.resolved = true;
        r.resT = now;
        r.ok = ok;
        r.why = why || null;
        const rt = ok ? tc - r.revealT : null;
        const off = ok ? tc - r.arriveT : null;
        r.judge = ok ? (Math.abs(off) <= PERFECT ? 'PERFECT' : Math.abs(off) <= GREAT ? 'GREAT' : 'GOOD') : null;
        trials.push({
          i: r.i, ph: r.ph, bt: r.bt || null, bid: r.bid == null ? null : r.bid, pos: r.pos == null ? null : r.pos,
          cong: r.cong, orange: r.orange, lead: Math.round(r.lead), rt: U.isNum(rt) ? Math.round(rt) : null, off: U.isNum(off) ? Math.round(off) : null,
          ok, why: r.why, judge: r.judge, dist: r.dist ? r.dist.map((d) => d.type) : null, chain,
        });

        if (ok) {
          const prevTier = tierOf(chain);
          chain++;
          errRun = 0;
          bestChain = Math.max(bestChain, chain);
          const ti = tierOf(chain), T = TIERS[ti];
          const pts = T.m * (10 + (r.judge === 'PERFECT' ? 10 : r.judge === 'GREAT' ? 5 : 0));
          score += pts;
          chainPopT = now;
          hitFlashT = now;
          addFx({ k: 'judge', dur: 600, text: r.judge, sub: '+' + pts, color: r.judge === 'PERFECT' ? TH.gold : T.c });
          addFx({ k: 'burst', dur: 380, x: r.hitX, color: r.orange ? COL.orange : COL.blue });
          if (ti > prevTier) {
            addFx({ k: 'tier', dur: 900, text: '×' + T.m, color: T.c });
            addFx({ k: 'ring', dur: 700, color: T.c, n: 14 + ti * 3 });
            if (audio) audio.tier(ti);
          } else if (audio) audio.ok(chain, r.judge === 'PERFECT');
          if (!newBestShown && allTimeBest >= 10 && chain === allTimeBest + 1) {
            newBestShown = true;
            addFx({ k: 'call', dur: 1400, text: 'NEW BEST CHAIN', color: TH.gold });
            if (audio) audio.best();
          }
          if (r.ph === 'base') okRTs.push(rt);
        } else {
          if (chain >= 5) {
            brokenN++;
            addFx({ k: 'call', dur: 900, text: 'CHAIN BROKEN · ' + chain, color: TH.miss, small: true });
          }
          brokenChain = chain;
          breakT = now;
          chain = 0;
          errRun++;
          const pen = Math.min(160, 20 * Math.pow(2, errRun - 1));
          score -= pen;
          errT = now;
          addFx({ k: 'judge', dur: 700, text: why === 'early' ? 'EARLY' : why === 'miss' ? 'MISS' : 'WRONG', sub: '−' + pen, color: TH.miss });
          if (audio) audio.err(errRun);
        }

        if (r.ph === 'base') stair(ok);
        else if (r.ph === 'rec') {
          const b = bursts[r.bid];
          const clean = ok && rt <= baseRTnow() * SLOW_X;
          b.run = clean ? b.run + 1 : 0;
          if (!b.interrupted && b.recovered == null && b.run >= CLEAN_RUN) {
            b.recovered = r.pos + 1 - CLEAN_RUN;
            const bonus = Math.round(150 / (1 + b.recovered) / 10) * 10;
            score += bonus;
            addFx({ k: 'call', dur: 1300, text: b.recovered === 0 ? 'CLEAN SLATE' : 'RECOVERED · ' + b.recovered, sub: '+' + bonus, color: '#9fe3b0' });
            if (audio) audio.recovered();
          }
        }
      }

      // ------------------------------------------------------------ run state
      // A live, read-only view of the run for the view and the summary (stats.js).
      const run = {
        notes, trials, bursts, fx,
        get now() { return now; },
        get chain() { return chain; },
        get lead() { return lead; },
        get lastArrive() { return lastArrive; },
        get hitFlashT() { return hitFlashT; },
        get chainPopT() { return chainPopT; },
        get breakT() { return breakT; },
        get brokenChain() { return brokenChain; },
        get errT() { return errT; },
        get score() { return score; },
        get bestChain() { return bestChain; },
        get brokenN() { return brokenN; },
        get stray() { return stray; },
      };
      const view = CS.createView(run, { S, bLevel, dLevel, allTimeBest, approach: APP, hitTop });
      const summarize = () => CS.summarize(run, { S, bLevel, dLevel });

      let lastLayout = view.layout(ctx.W || 1280, ctx.H || 720);
      const front = () => notes.find((r) => !r.resolved) || null;
      const clockAt = (t) => now + (t - lastTs); // input timestamp -> drill clock

      // ----------------------------------------------------------- instance
      return {
        debug: () => ({ notes, trials, bursts, pending, rec, lead, chain, score, bLevel, dLevel, now }),

        update(dt, clock, ts) {
          now = clock;
          lastTs = ts;
          if (clock < 1200) return; // intro
          // spawn rows that enter the lane this frame
          for (;;) {
            if (!queued) {
              if (stopped || (lastArrive + BEAT > endMs && !pending && !rec)) {
                stopped = true;
                break;
              }
              queued = makeRow();
            }
            if (queued.spawnT > clock) break;
            notes.push(queued);
            lastArrive = queued.arriveT;
            queued = null;
          }
          for (const r of notes) {
            if (r.resolved) continue;
            if (r.dist) {
              for (const d of r.dist) {
                if (d.fired || d.dur || now < r.revealT + d.soa) continue;
                d.fired = true;
                if (audio && d.type === 'chirp') audio.chirp();
                else if (audio && d.type === 'fakebuzz') audio.err(1);
              }
            }
            if (!r.ticked && now >= r.arriveT) {
              r.ticked = true;
              if (audio) audio.tick();
            }
          }
          const f = front();
          if (f && now > f.arriveT + HW) resolve(f, false, now, 'miss');
          // drop rows that are done and off their animation
          for (let j = notes.length - 1; j >= 0; j--) if (notes[j].resolved && now - notes[j].resT > 600) notes.splice(j, 1);
          if ((stopped && !queued && !notes.some((r) => !r.resolved) && now > lastArrive + 700) || now > endMs + 40000) ctx.finish();
        },

        onAction(a, t) {
          if (a === 'confirm') {
            if (!S.resetCue) return;
            const id = rec ? rec.id : pending ? pending.id : null;
            const b = id != null ? bursts[id] : null;
            if (b && !b.reset) {
              b.reset = true;
              addFx({ k: 'reset', dur: 600 });
              if (audio) audio.reset();
            }
            return;
          }
          if (DIRS.indexOf(a) < 0) return;
          const r = front();
          const tc = clockAt(t);
          if (!r || tc < r.revealT) {
            stray++;
            return;
          }
          if (tc < r.arriveT - HW) return resolve(r, false, tc, 'early');
          if (tc > r.arriveT + HW) return resolve(r, false, tc, 'miss');
          r.hitX = view.slotX(lastLayout, r, r.tgt);
          resolve(r, a === r.ans, tc, a === r.ans ? null : 'wrong');
        },

        onPause() {
          if (audio) audio.suspend();
        },
        onResume() {
          if (audio) audio.resume();
        },
        destroy() {
          if (audio) audio.close();
        },

        render(g, W, H) {
          lastLayout = view.render(g, W, H);
        },

        result() {
          const summary = summarize(); // first: fills in each burst's recovery
          return {
            summary,
            detail: {
              rows: trials.map((t) => [t.ph === 'base' ? 0 : t.ph === 'burst' ? 1 : 2, t.bt ? t.bt[0] : '', t.pos == null ? -1 : t.pos, t.ok ? 1 : 0, t.rt, t.off, t.lead, t.orange ? 1 : 0, t.dist ? t.dist.join('+') : '']),
              bursts: bursts.map((b) => ({ type: b.type, len: b.len, double: b.double, interrupted: b.interrupted, reset: b.reset, recovery: b.recovery == null ? null : b.recovery })),
            },
          };
        },
      };
    },
  };

  IST.registerDrill(DEF);
})();
