/*
 * Clean Slate: recovering from a run of errors.
 *
 * Core task, rhythm-game style: rows of arrows scroll down a lane to a hit
 * line on a steady beat. Each row shows grey pattern masks until it crosses
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
 */
(function () {
  'use strict';
  const U = IST.util, Sym = IST.Symbols;
  const DIRS = Sym.DIRS;
  const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' };
  const PERP = { up: ['left', 'right'], down: ['left', 'right'], left: ['up', 'down'], right: ['up', 'down'] };

  const APPROACH = 1600; // ms from entering the lane to the hit line
  const BEAT = 850; // ms between rows
  const RUSH_BEAT = 480; // ms between rows during a rush burst
  const HW = 150; // hit window half-width (ms)
  const PERFECT = 45, GREAT = 95; // timing grades (ms from the line)
  const ORANGE_BASE = 0.15; // share of orange (flipped) rows on normal play
  const WARMUP = 12; // rows before the first burst while the reveal settles
  const REC_WIN = 10; // rows measured after each burst
  const CURVE = 8; // positions shown on the recovery curve
  const CLEAN_RUN = 3; // consecutive clean answers = recovered
  const SLOW_X = 1.25; // a clean answer is also no slower than 1.25x baseline median
  const TARGET = 0.88; // staircase target accuracy
  const LEAD_MIN = 200, LEAD_MAX = APPROACH;
  const MIN_BURSTS = 3;
  const MAX_LEVEL = 6;

  const COL = { blue: '#3d9bff', orange: '#ff9a3d', flank: '#aeb6c4', look: '#7f9cc0', mask: '#363c48' };

  const BURST_LEVELS = [
    null,
    { types: ['squeeze'], len: [3, 3], gap: [24, 32], dbl: 0, sq: 0.6 },
    { types: ['squeeze', 'rush'], len: [3, 4], gap: [22, 30], dbl: 0, sq: 0.58 },
    { types: ['squeeze', 'rush', 'clutter'], len: [4, 5], gap: [20, 28], dbl: 0, sq: 0.55 },
    { types: ['squeeze', 'rush', 'clutter', 'flip'], len: [4, 5], gap: [18, 26], dbl: 0.2, sq: 0.52 },
    { types: ['squeeze', 'rush', 'clutter', 'flip'], len: [5, 6], gap: [16, 24], dbl: 0.35, sq: 0.5 },
    { types: ['squeeze', 'rush', 'clutter', 'flip'], len: [5, 7], gap: [15, 22], dbl: 0.5, sq: 0.48 },
  ];
  const BURST_LABELS = { squeeze: 'Squeeze', rush: 'Rush', clutter: 'Clutter', flip: 'Flip', double: 'Double hit' };

  const DIST_LEVELS = [
    { rate: 0, types: [] },
    { rate: 0.25, types: ['pop'], soa: [-200, 0] },
    { rate: 0.3, types: ['pop', 'word'], soa: [-200, 50] },
    { rate: 0.35, types: ['pop', 'word', 'decoy'], soa: [-150, 80] },
    { rate: 0.4, types: ['pop', 'word', 'decoy', 'chirp', 'jitter'], soa: [-120, 100] },
    { rate: 0.45, types: ['pop', 'word', 'decoy', 'chirp', 'jitter', 'fakebuzz'], soa: [-100, 120] },
    { rate: 0.5, types: ['pop', 'word', 'decoy', 'chirp', 'jitter', 'fakebuzz', 'glitch'], soa: [-80, 150], multi: 0.4 },
  ];
  const DIST_LABELS = { none: 'No distraction', pop: 'Flash', word: 'Taunt word', decoy: 'Decoy arrow', chirp: 'Chirp', jitter: 'Drifting row', fakebuzz: 'Fake error buzz', glitch: 'HUD glitch' };
  const DIST_DUR = { pop: 140, word: 650, decoy: 260, glitch: 380, chirp: 0, fakebuzz: 0, jitter: 0 };
  const WORDS = ['SLOW', 'AGAIN?', 'WRONG', 'MISS', 'TOO LATE', 'HURRY', 'LOSING IT', '−0.4', 'PUSH', 'NOPE', 'FOCUS?', 'PRESSURE'];
  const POP_COLORS = ['#ffffff', '#f5c400', '#ff5a4f'];

  // Chain tiers, sounds and colour helpers are shared with the other drills (components/juice.js).
  const TIERS = IST.Juice.TIERS, tierOf = IST.Juice.tierOf, makeAudio = IST.Juice.makeAudio, hex = IST.Juice.hex;

  const levelOpts = (withOff) =>
    [['auto', 'Auto (adapts)']].concat(withOff ? [['off', 'Off']] : []).concat([1, 2, 3, 4, 5, 6].map((n) => [String(n), String(n)]));

  const DEF = {
    id: 'clean-slate',
    name: 'Clean Slate',
    tab: 'mind',
    category: 'Recovery',
    tagline: 'Make a mistake, then make the next one count.',
    description:
      'Rows of arrows scroll down to the hit line on a steady beat. When a row is revealed, find the BLUE arrow and press its direction as the row hits the line. ' +
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
      for (let i = history.length - 1; i >= 0; i--) {
        const s = history[i].summary;
        if (s && U.isNum(s[nextKey]) && s[nextKey] > 0) return s[nextKey];
        if (s && U.isNum(s[key]) && s[key] > 0) return s[key];
      }
      return 1;
    },

    coach(s, result, hist) {
      const tips = [];
      const pc = (x) => Math.round(Math.abs(x) * 100);
      if (s.bursts < MIN_BURSTS) tips.push('Only ' + s.bursts + ' burst' + (s.bursts === 1 ? '' : 's') + ' measured. Run 3+ minutes for a reliable recovery score.');
      if (U.isNum(s.recovery) && s.bursts) {
        if (s.recovery < 0.5) tips.push('Straight back to normal after bursts. Clean slate.');
        else if (s.recovery <= 1) tips.push('Back to normal within ~' + U.fmt(s.recovery, 1) + ' rows after a burst. Clean slate.');
        else if (s.recovery >= 3) tips.push('~' + U.fmt(s.recovery, 1) + ' rows to get back to normal after a burst. When it goes wrong: breathe out, find the next blue arrow, and hit it on the beat like the first row of the session.');
      }
      if (s.style === 'hesitant') tips.push('After errors you pressed ~' + Math.round(s.pes) + ' ms later (hesitant). In the car that\'s the tentative lap after an off. Stay on the beat.');
      else if (s.style === 'rushing') tips.push('After errors you pressed earlier or lost accuracy (rushing). That\'s chasing the time back. Wait for the line.');
      else if (s.style === 'steady') tips.push('Steady after errors: the next answer looked like any other.');
      if (U.isNum(s.chainRate) && s.chainRate >= 0.08 && s.pairs)
        tips.push('Errors chained: ' + pc(s.pairs.afterErr[1] / s.pairs.afterErr[0]) + '% chance of an error right after one vs ' + pc(s.pairs.afterOk[1] / s.pairs.afterOk[0]) + '% otherwise.');
      if (U.isNum(s.distCost)) {
        if (s.distCost >= 0.08) tips.push('Distractions cost ' + pc(s.distCost) + ' pts. Keep your eyes on the lane and let the rest pass.');
        else if (s.distCost <= 0.02 && s.distractLevel) tips.push('Distractions didn\'t land this run.');
      }
      if (U.isNum(s.resetGain)) tips.push(s.resetGain >= 0.5 ? 'The reset press helped: ' + U.fmt(s.resetGain, 1) + ' rows quicker.' : 'The reset press made no clear difference this run.');
      const prevBest = (hist || []).slice(0, -1).reduce((m, r) => Math.max(m, (r.summary && r.summary.bestChain) || 0), 0);
      if (s.bestChain > prevBest && prevBest > 0) tips.push('New best chain: ' + s.bestChain + '.');
      const S = (result && result.settings) || {};
      if (S.burst === 'auto' && U.isNum(s.nextBurstLevel) && s.nextBurstLevel !== s.burstLevel)
        tips.push(s.nextBurstLevel > s.burstLevel ? 'Burst level up next run: ' + s.burstLevel + ' → ' + s.nextBurstLevel + '.' : 'Burst level eased next run: ' + s.burstLevel + ' → ' + s.nextBurstLevel + '.');
      if (S.distract === 'auto' && U.isNum(s.nextDistractLevel) && s.nextDistractLevel !== s.distractLevel)
        tips.push(s.nextDistractLevel > s.distractLevel ? 'Distraction level up next run: ' + s.distractLevel + ' → ' + s.nextDistractLevel + '.' : 'Distraction level eased next run: ' + s.distractLevel + ' → ' + s.nextDistractLevel + '.');
      return tips;
    },

    analyze(results, A) {
      const out = { breakdowns: [], notes: [], insim: [] };
      const name = this.name;
      const withCurve = results.filter((r) => r.summary && r.summary.curve);
      if (!withCurve.length) return out;
      const recent = results.slice(-10);
      const sub = 'Last ' + recent.length + ' session' + (recent.length === 1 ? '' : 's');
      const pc = (x) => Math.round(x * 100) + '%';

      // recovery curve: recent 5 sessions vs the 10 before them
      const pool = (rs) => {
        const n = new Array(CURVE).fill(0), ok = n.slice(), rt = n.slice(), rtN = n.slice();
        let bN = 0, bOk = 0;
        for (const r of rs) {
          const c = r.summary.curve;
          for (let i = 0; i < CURVE; i++) {
            n[i] += c.n[i] || 0;
            ok[i] += c.ok[i] || 0;
            rt[i] += c.rt[i] || 0;
            rtN[i] += c.rtN[i] || 0;
          }
          bN += r.summary.baseN || 0;
          bOk += r.summary.baseOk || 0;
        }
        return {
          acc: n.map((x, i) => (x >= 3 ? ok[i] / x : null)),
          rt: rtN.map((x, i) => (x >= 3 ? rt[i] / x : null)),
          base: bN ? bOk / bN : null,
          bursts: rs.reduce((s, r) => s + (r.summary.bursts || 0), 0),
        };
      };
      const rec5 = withCurve.slice(-5), early = withCurve.slice(-15, -5);
      const pr = pool(rec5), pe = early.length ? pool(early) : null;
      const labels = Array.from({ length: CURVE }, (_, i) => '+' + (i + 1));
      const series = (key) => {
        const s = [{ label: 'Last ' + rec5.length + ' sessions (' + pr.bursts + ' bursts)', values: pr[key] }];
        if (pe && pe.bursts >= 3) s.push({ label: 'Earlier ' + early.length + ' sessions', values: pe[key], muted: true });
        return s;
      };
      out.breakdowns.push({
        type: 'curve', title: 'Accuracy after a burst', subtitle: 'rows after the burst · flatter is better', pct: true, xTitle: 'Row',
        labels, series: series('acc'), baseline: pr.base, baselineLabel: 'baseline',
      });
      out.breakdowns.push({
        type: 'curve', title: 'Speed after a burst', subtitle: 'reveal-to-press time vs your baseline · 100% = normal', pct: true, xTitle: 'Row',
        labels, series: series('rt'), baseline: 1, baselineLabel: 'normal',
      });

      // recovery by burst type (mean rows, lower is better)
      const bb = A.sumTallies(recent, 'byBurst');
      const bItems = ['squeeze', 'rush', 'clutter', 'flip', 'double'].filter((k) => bb[k] && bb[k][0]).map((k) => ({ label: BURST_LABELS[k], value: bb[k][1] / bb[k][0], n: bb[k][0] }));
      if (bItems.length) {
        const judged = bItems.filter((i) => i.n >= MIN_BURSTS);
        if (judged.length >= 2) {
          const hi = judged.reduce((a, b) => (b.value > a.value ? b : a)), lo = judged.reduce((a, b) => (b.value < a.value ? b : a));
          if (hi.value - lo.value >= 1) hi.tag = 'slowest';
        }
        out.breakdowns.push({ title: 'Rows to recover by burst', subtitle: sub + ' · lower is better', items: bItems, fmt: (v) => U.fmt(v, 1), minN: MIN_BURSTS, nLabel: 'bursts' });
      }

      // chaining
      const pairs = A.sumTallies(recent, 'pairs');
      if (pairs.afterErr && pairs.afterErr[0]) {
        out.breakdowns.push({
          title: 'Error rate', subtitle: sub + ' · normal rows · lower is better', pct: true, nLabel: 'rows',
          items: [
            { label: 'After a correct answer', value: A.acc(pairs.afterOk), n: pairs.afterOk[0] },
            { label: 'After an error', value: A.acc(pairs.afterErr), n: pairs.afterErr[0] },
          ],
        });
      }
      const byCol = A.sumTallies(recent, 'byColor');
      if (byCol.blue && byCol.orange) {
        out.breakdowns.push({ title: 'Accuracy by colour', subtitle: sub + ' · normal rows', pct: true, nLabel: 'rows', items: A.items(byCol, ['blue', 'orange'], { blue: 'Blue (press it)', orange: 'Orange (press opposite)' }) });
      }

      // distractions
      const bd = A.sumTallies(recent, 'byDist');
      if (Object.keys(bd).some((k) => k !== 'none')) {
        out.breakdowns.push({ title: 'Accuracy by distraction', subtitle: sub + ' · normal rows', pct: true, nLabel: 'rows', items: A.items(bd, ['none', 'pop', 'word', 'decoy', 'chirp', 'jitter', 'fakebuzz', 'glitch'], DIST_LABELS) });
      }
      const br = A.sumTallies(recent, 'byReset');
      if (br.press && br.none && br.press[0] && br.none[0]) {
        out.breakdowns.push({
          title: 'Rows to recover by reset cue', subtitle: sub + ' · lower is better',
          items: [
            { label: 'Pressed reset', value: br.press[1] / br.press[0], n: br.press[0] },
            { label: 'No press', value: br.none[1] / br.none[0], n: br.none[0] },
          ],
          fmt: (v) => U.fmt(v, 1), minN: MIN_BURSTS, nLabel: 'bursts',
        });
      }

      // notes + in-sim
      const recov = A.mean(A.values(results, 'recovery').slice(-5));
      if (recov != null && recov >= 3) {
        out.notes.push({ tone: 'bad', text: name + ': ~' + U.fmt(recov, 1) + ' rows to get back to normal after a run of errors.' });
        out.insim.push({ id: 'ERROR_CHAIN', score: 0.3 + Math.min(0.4, recov / 15), evidence: '~' + U.fmt(recov, 1) + ' rows to recover after a burst' });
      }
      const chainR = A.mean(A.values(results, 'chainRate').slice(-5));
      if (chainR != null && chainR >= 0.08) {
        out.notes.push({ tone: 'bad', text: name + ': errors chain. A second error is ' + Math.round(chainR * 100) + ' pts more likely straight after one.' });
        out.insim.push({ id: 'ERROR_CHAIN', score: 0.35 + chainR, evidence: 'Error after error +' + Math.round(chainR * 100) + ' pts' });
      }
      const styles = recent.slice(-5).map((r) => r.summary && r.summary.style).filter(Boolean);
      const count = (k) => styles.filter((x) => x === k).length;
      const pesM = A.mean(A.values(recent.slice(-5), 'pes'));
      if (styles.length >= 2 && count('hesitant') > styles.length / 2) out.insim.push({ id: 'HESITANT', score: 0.4, evidence: 'Hesitant after errors in ' + count('hesitant') + ' of ' + styles.length + ' sessions' + (pesM != null ? ' (+' + Math.round(pesM) + ' ms)' : '') });
      if (styles.length >= 2 && count('rushing') > styles.length / 2) out.insim.push({ id: 'RUSHING', score: 0.4, evidence: 'Rushing after errors in ' + count('rushing') + ' of ' + styles.length + ' sessions' });
      const dc = A.mean(A.values(results, 'distCost').slice(-5));
      if (dc != null && dc >= 0.08) {
        out.notes.push({ tone: 'bad', text: name + ': distractions cost ' + Math.round(dc * 100) + ' pts of accuracy.' });
        out.insim.push({ id: 'DISTRACT', score: 0.25 + dc, evidence: 'Distractions cost ' + pc(dc) + ' accuracy' });
      }
      ['burstLevel', 'distractLevel'].forEach((k) => {
        const lv = A.values(results, k).filter((v) => U.isNum(v) && v > 0);
        if (lv.length >= 2 && lv[lv.length - 1] > lv[0]) out.notes.push({ tone: 'good', text: name + ': ' + (k === 'burstLevel' ? 'burst' : 'distraction') + ' level ' + lv[0] + ' → ' + lv[lv.length - 1] + '.' });
      });
      const bests = A.values(results, 'bestChain').filter(U.isNum);
      if (bests.length >= 2 && bests[bests.length - 1] > Math.max.apply(null, bests.slice(0, -1))) out.notes.push({ tone: 'good', text: name + ': new best chain (' + bests[bests.length - 1] + ').' });
      return out;
    },

    create(ctx) {
      const S = ctx.settings;
      const rnd = U.rng(U.randomSeed());
      const hist = ctx.history;
      const bLevel = DEF.levelFor(S.burst, hist, 'nextBurstLevel', 'burstLevel');
      const dLevel = DEF.levelFor(S.distract, hist, 'nextDistractLevel', 'distractLevel');
      const BL = BURST_LEVELS[bLevel], DL = DIST_LEVELS[dLevel];
      const audio = S.sound && IST.Juice.mode() === 'full' ? makeAudio() : null; // Data → Game feel: Silent mutes it too
      const distTypes = DL.types.filter((t) => audio || (t !== 'chirp' && t !== 'fakebuzz'));
      const allTimeBest = hist.reduce((m, r) => Math.max(m, (r.summary && r.summary.bestChain) || 0), 0);
      const endMs = S.duration * 1000;

      // reveal lead: start from last session's value, a little easier
      let lead = 800;
      for (let i = hist.length - 1; i >= 0; i--) {
        const s = hist[i].summary;
        if (s && U.isNum(s.lead)) {
          lead = U.clamp(s.lead * 1.1, LEAD_MIN, LEAD_MAX);
          break;
        }
      }
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
          if (inLane && v > 0.62) continue; // never on top of the hit zone
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
          arriveT, spawnT: arriveT - APPROACH, revealT: arriveT - ld, resolved: false, ticked: false,
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
          addFx({ k: 'judge', dur: 600, text: r.judge, sub: '+' + pts, color: r.judge === 'PERFECT' ? '#f6d98f' : T.c });
          addFx({ k: 'burst', dur: 380, x: r.hitX, color: r.orange ? COL.orange : COL.blue });
          if (ti > prevTier) {
            addFx({ k: 'tier', dur: 900, text: '×' + T.m, color: T.c });
            addFx({ k: 'ring', dur: 700, color: T.c, n: 14 + ti * 3 });
            if (audio) audio.tier(ti);
          } else if (audio) audio.ok(chain, r.judge === 'PERFECT');
          if (!newBestShown && allTimeBest >= 10 && chain === allTimeBest + 1) {
            newBestShown = true;
            addFx({ k: 'call', dur: 1400, text: 'NEW BEST CHAIN', color: '#f6d98f' });
            if (audio) audio.best();
          }
          if (r.ph === 'base') okRTs.push(rt);
        } else {
          if (chain >= 5) {
            brokenN++;
            addFx({ k: 'call', dur: 900, text: 'CHAIN BROKEN · ' + chain, color: '#ff453a', small: true });
          }
          brokenChain = chain;
          breakT = now;
          chain = 0;
          errRun++;
          const pen = Math.min(160, 20 * Math.pow(2, errRun - 1));
          score -= pen;
          errT = now;
          addFx({ k: 'judge', dur: 700, text: why === 'early' ? 'EARLY' : why === 'miss' ? 'MISS' : 'WRONG', sub: '−' + pen, color: '#ff453a' });
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

      // ------------------------------------------------------------ summary
      function summarize() {
        const T = trials;
        let base = T.filter((t) => t.ph === 'base' && t.i >= WARMUP);
        if (base.length < 20) base = T.filter((t) => t.ph === 'base');
        const accOf = (arr) => (arr.length ? arr.filter((t) => t.ok).length / arr.length : null);
        const rtsOf = (arr) => arr.filter((t) => t.ok && U.isNum(t.rt)).map((t) => t.rt);
        const baseAcc = accOf(base);
        const bRTs = rtsOf(base);
        const baseRT = bRTs.length ? U.median(bRTs) : null;
        const clean = (t) => t.ok && U.isNum(t.rt) && (baseRT == null || t.rt <= baseRT * SLOW_X);
        const tally = (o, k, v) => {
          const e = (o[k] = o[k] || [0, 0]);
          e[0]++;
          e[1] += v;
        };

        const z = () => new Array(CURVE).fill(0);
        const curve = { n: z(), ok: z(), rt: z(), rtN: z() };
        const recs = [], postAll = [], byBurst = {}, byReset = {};
        for (const b of bursts) {
          if (b.interrupted) continue;
          const post = T.filter((t) => t.ph === 'rec' && t.bid === b.id).sort((a, c) => a.pos - c.pos);
          if (post.length < CLEAN_RUN + 1) continue; // session ended mid-window
          let k = -1;
          for (let j = 0; j + CLEAN_RUN <= post.length; j++) {
            if (post.slice(j, j + CLEAN_RUN).every(clean)) {
              k = j;
              break;
            }
          }
          const r = k < 0 ? post.length : k; // never recovered: the whole window
          b.recovery = r;
          recs.push(r);
          tally(byBurst, b.double ? 'double' : b.type, r);
          if (S.resetCue) tally(byReset, b.reset ? 'press' : 'none', r);
          for (const t of post) {
            postAll.push(t);
            if (t.pos >= CURVE) continue;
            curve.n[t.pos]++;
            if (t.ok) curve.ok[t.pos]++;
            if (t.ok && U.isNum(t.rt) && baseRT) {
              curve.rt[t.pos] += t.rt / baseRT;
              curve.rtN[t.pos]++;
            }
          }
        }
        curve.rt = curve.rt.map((x) => Math.round(x * 1000) / 1000);
        const recovery = recs.length ? U.mean(recs) : null;
        const recCost = recs.length && baseAcc != null ? baseAcc - accOf(postAll) : null;
        const pRTs = rtsOf(postAll);
        const postSlow = pRTs.length >= 4 && baseRT ? U.median(pRTs) / baseRT - 1 : null;

        // error chaining on consecutive normal rows ([n, errors])
        const pairs = { afterOk: [0, 0], afterErr: [0, 0] };
        for (let j = 1; j < T.length; j++) {
          const a = T[j - 1], c = T[j];
          if (a.ph !== 'base' || c.ph !== 'base' || a.i < WARMUP / 2) continue;
          const e = pairs[a.ok ? 'afterOk' : 'afterErr'];
          e[0]++;
          if (!c.ok) e[1]++;
        }
        const er = (e) => (e[0] ? e[1] / e[0] : null);
        const chainRate = pairs.afterErr[0] >= 5 && pairs.afterOk[0] >= 10 ? er(pairs.afterErr) - er(pairs.afterOk) : null;
        const postErrAcc = pairs.afterErr[0] >= 5 ? 1 - er(pairs.afterErr) : null;

        // robust post-error shift: RT(n+1) - RT(n-1) around errors with correct neighbours
        const pesD = [];
        for (let j = 1; j < T.length - 1; j++) {
          const a = T[j - 1], e = T[j], c = T[j + 1];
          if (e.ok || e.ph !== 'base' || a.ph !== 'base' || c.ph !== 'base') continue;
          if (a.ok && c.ok && U.isNum(a.rt) && U.isNum(c.rt)) pesD.push(c.rt - a.rt);
        }
        const pes = pesD.length >= 4 ? U.mean(pesD) : null;
        let style = null;
        if (pes != null && pes >= 40) style = 'hesitant';
        else if ((pes != null && pes <= -25) || (postErrAcc != null && baseAcc != null && postErrAcc < baseAcc - 0.12 && (pes == null || pes < 20))) style = 'rushing';
        else if (pes != null) style = 'steady';

        // distraction and colour on normal rows
        const byDist = {}, byColor = {};
        for (const t of base) {
          for (const k of t.dist || ['none']) tally(byDist, k, t.ok ? 1 : 0);
          tally(byColor, t.orange ? 'orange' : 'blue', t.ok ? 1 : 0);
        }
        const dArr = base.filter((t) => t.dist), nArr = base.filter((t) => !t.dist);
        const distCost = dLevel && dArr.length >= 10 && nArr.length >= 10 ? accOf(nArr) - accOf(dArr) : null;
        const dR = rtsOf(dArr), nR = rtsOf(nArr);
        const distRT = dLevel && dR.length >= 6 && nR.length >= 6 ? U.median(dR) - U.median(nR) : null;

        const mean = (o) => (o && o[0] ? o[1] / o[0] : null);
        const resetGain = byReset.press && byReset.none && byReset.press[0] >= 2 && byReset.none[0] >= 2 ? mean(byReset.none) - mean(byReset.press) : null;

        const hits = T.filter((t) => t.ok && U.isNum(t.off));
        const perfectRate = hits.length ? hits.filter((t) => t.judge === 'PERFECT').length / hits.length : null;
        const timing = hits.length ? U.mean(hits.map((t) => Math.abs(t.off))) : null;

        let nextBurstLevel = bLevel;
        if (recs.length >= MIN_BURSTS && recovery != null) {
          if (recovery <= 1.5 && (recCost == null || recCost <= 0.1)) nextBurstLevel = Math.min(MAX_LEVEL, bLevel + 1);
          else if (recovery >= 4 || (recCost != null && recCost >= 0.3)) nextBurstLevel = Math.max(1, bLevel - 1);
        }
        let nextDistractLevel = dLevel || null;
        if (dLevel && dArr.length >= 15 && distCost != null) {
          if (distCost <= 0.04 && (distRT == null || distRT <= 30)) nextDistractLevel = Math.min(MAX_LEVEL, dLevel + 1);
          else if (distCost >= 0.15 || (distRT != null && distRT >= 90)) nextDistractLevel = Math.max(1, dLevel - 1);
        }

        const lastLeads = base.slice(-30).map((t) => t.lead);
        return {
          recovery, recCost, postSlow, chainRate, postErrAcc, pes, style,
          bestChain, score: Math.round(score), brokenChains: brokenN, perfectRate, timing,
          burstLevel: bLevel, nextBurstLevel, distractLevel: dLevel, nextDistractLevel,
          distCost, distRT, resetGain,
          baseAcc, baseRT, lead: lastLeads.length ? U.median(lastLeads) : Math.round(lead),
          bursts: recs.length, burstsTotal: bursts.length, trials: T.length, stray,
          baseN: base.length, baseOk: base.filter((t) => t.ok).length,
          curve, byBurst, byDist, byColor, pairs, byReset,
        };
      }

      // ------------------------------------------------------------ drawing
      function layout(W, H) {
        const laneW = Math.min(W * 0.5, 680, H * 0.95);
        const laneX = (W - laneW) / 2;
        const topY = H * 0.06, hitY = H * 0.8;
        return { laneW, laneX, topY, hitY, speed: (hitY - topY) / APPROACH };
      }
      const rowY = (L, r) => L.hitY - (r.arriveT - now) * L.speed;
      function slotX(L, r, j) {
        const gap = L.laneW / (r.n + 1);
        const drift = r.jx && now >= r.revealT ? r.jx * L.laneW * 0.16 * U.clamp((now - r.revealT) / 400, 0, 1) : 0;
        return L.laneX + gap * (j + 1) + drift;
      }
      const sizeOf = (L, r, H) => Math.min((L.laneW / (r.n + 1)) * 0.74, H * 0.075);

      function drawLane(g, W, H, L) {
        const ti = tierOf(chain), T = TIERS[ti];
        g.fillStyle = '#0c0e12';
        g.fillRect(L.laneX, 0, L.laneW, H);
        g.fillStyle = '#1d2129';
        g.fillRect(L.laneX - 2, 0, 2, H);
        g.fillRect(L.laneX + L.laneW, 0, 2, H);
        // beat lines scroll with the rows
        g.fillStyle = 'rgba(255,255,255,0.035)';
        for (let t = lastArrive + BEAT; t > now - 400; t -= BEAT) {
          const y = L.hitY - (t - now) * L.speed - BEAT * L.speed * 0.5;
          if (y > 0 && y < H) g.fillRect(L.laneX, y, L.laneW, 1);
        }
        // reveal line
        const ry = L.hitY - lead * L.speed;
        if (ry > L.topY) {
          g.fillStyle = 'rgba(159,203,239,0.22)';
          for (let x = L.laneX; x < L.laneX + L.laneW; x += 14) g.fillRect(x, ry, 7, 1);
          Sym.text(g, 'REVEAL', L.laneX + L.laneW + 8, ry + 4, { size: 10, weight: 600, color: '#5d7590', shadow: false });
        }
        // hit window band + line
        const hw = HW * L.speed, pw = PERFECT * L.speed;
        g.fillStyle = U.rgb(hex(T.c), 0.06);
        g.fillRect(L.laneX, L.hitY - hw, L.laneW, hw * 2);
        g.fillStyle = U.rgb(hex(T.c), 0.08);
        g.fillRect(L.laneX, L.hitY - pw, L.laneW, pw * 2);
        const fp = (now - hitFlashT) / 220;
        const lineCol = fp < 1 ? U.rgb(U.mix(hex(T.c), [255, 255, 255], 1 - fp), 1) : T.c;
        g.fillStyle = lineCol;
        if (ti >= 1 || fp < 1) {
          g.shadowColor = T.c;
          g.shadowBlur = fp < 1 ? 18 : 6 + ti * 2;
        }
        g.fillRect(L.laneX, L.hitY - 1.5, L.laneW, 3);
        g.shadowBlur = 0;
        g.fillStyle = '#6c7484';
        g.fillRect(L.laneX - 12, L.hitY - hw, 6, 1);
        g.fillRect(L.laneX - 12, L.hitY + hw, 6, 1);
        g.fillRect(L.laneX - 7, L.hitY - hw, 1, hw * 2);
      }

      function drawRow(g, L, H, r) {
        const y = rowY(L, r);
        if (y < -60 || y > H + 60) return;
        const s = sizeOf(L, r, H);
        if (r.resolved && r.ok) return; // hit rows vanish into the burst
        const missed = r.resolved && !r.ok;
        const revealed = now >= r.revealT;
        const fade = missed ? U.clamp(1 - (now - r.resT) / 500, 0, 1) : 1;
        if (fade <= 0) return;
        g.globalAlpha = fade;
        if (r.noise && revealed) {
          for (const n of r.noise) {
            const q = s * n[2];
            g.fillStyle = 'rgba(200,205,215,' + (0.1 + n[3] * 0.2).toFixed(2) + ')';
            g.fillRect(L.laneX + L.laneW * (0.5 + n[0]) - q / 2, y + n[1] * s * 1.4 - q / 2, q, q);
          }
        }
        const glow = tierOf(chain) >= 2 && !missed;
        for (let j = 0; j < r.n; j++) {
          const x = slotX(L, r, j), yy = y + r.offs[j] * s;
          if (!revealed) {
            Sym.mask(g, x, yy, s, COL.mask);
            continue;
          }
          if (j === r.tgt) {
            const c = missed ? '#ff453a' : r.orange ? COL.orange : COL.blue;
            if (glow) {
              g.shadowColor = c;
              g.shadowBlur = 14;
            }
            // after an error, show the arrow you should have pressed
            Sym.arrow(g, x, yy, s, missed ? r.ans : r.dir, c);
            g.shadowBlur = 0;
          } else {
            Sym.arrow(g, x, yy, s, r.fl, missed ? 'rgba(174,182,196,.35)' : j === r.look ? COL.look : COL.flank);
          }
        }
        g.globalAlpha = 1;
      }

      function activeDist() {
        const out = [];
        for (const r of notes) {
          if (!r.dist || r.resolved) continue;
          for (const d of r.dist) {
            if (!d.dur) continue;
            const t0 = r.revealT + d.soa;
            if (now >= t0 && now <= t0 + d.dur) out.push(d);
          }
        }
        return out;
      }
      function drawDist(g, W, H, unit, list) {
        let glitch = false;
        for (const d of list) {
          const x = d.u * W, y = d.v * H;
          if (d.type === 'pop') {
            g.fillStyle = d.color;
            const s = unit * 0.55;
            if (d.shape === 0) {
              g.beginPath();
              g.arc(x, y, s / 2, 0, Math.PI * 2);
              g.fill();
            } else if (d.shape === 1) g.fillRect(x - s / 2, y - s / 2, s, s);
            else {
              g.beginPath();
              g.moveTo(x, y - s / 2);
              g.lineTo(x + s / 2, y + s / 2);
              g.lineTo(x - s / 2, y + s / 2);
              g.closePath();
              g.fill();
            }
          } else if (d.type === 'word') {
            Sym.text(g, d.word, x, y, { align: 'center', baseline: 'middle', size: Math.max(18, unit * 0.42), weight: 850, color: d.shape ? '#ff6b5e' : '#f5c400' });
          } else if (d.type === 'decoy') {
            Sym.arrow(g, x, y, unit * 0.8, d.dir, d.shape === 2 ? COL.blue : COL.flank);
          } else if (d.type === 'glitch') glitch = true;
        }
        return glitch;
      }

      function drawChain(g, W, H, L, glitch) {
        const ti = tierOf(chain), T = TIERS[ti];
        const hx = W / 2, hy = H * 0.34;
        const base = U.clamp(H * 0.14, 50, 130);
        const pp = (now - chainPopT) / 220;
        const scale = pp < 1 ? 1 + 0.16 * (1 - pp) : 1;
        const alpha = chain ? (pp < 1 ? 0.55 + 0.35 * (1 - pp) : 0.55) : 0.25;
        let col = T.c, gx = 0;
        if (glitch) {
          col = '#ff453a';
          gx = (Math.random() - 0.5) * 16;
        }
        g.save();
        g.translate(hx + gx, hy);
        g.scale(scale, scale);
        if (ti >= 1) {
          g.shadowColor = T.c;
          g.shadowBlur = 10 + ti * 4;
        }
        Sym.text(g, glitch ? chain + '?' : String(chain), 0, 0, { align: 'center', baseline: 'middle', size: base, weight: 900, color: col, alpha: glitch ? 0.9 : alpha, shadow: false });
        g.shadowBlur = 0;
        g.restore();
        const ly = hy + base * 0.62;
        Sym.text(g, 'CHAIN  ×' + T.m, hx, ly, { align: 'center', size: 13, weight: 700, color: ti ? T.c : '#8a93a6', alpha: 0.8, shadow: false });
        const next = TIERS[ti + 1];
        const bw = Math.min(200, L.laneW * 0.5), by = ly + 10;
        g.fillStyle = 'rgba(255,255,255,0.06)';
        g.fillRect(hx - bw / 2, by, bw, 4);
        g.fillStyle = T.c;
        g.fillRect(hx - bw / 2, by, bw * U.clamp(next ? (chain - T.at) / (next.at - T.at) : 1, 0, 1), 4);
        if (next) Sym.text(g, String(next.at), hx + bw / 2 + 8, by + 6, { size: 11, weight: 500, color: '#6c7484', shadow: false });
        const bp = (now - breakT) / 650;
        if (bp < 1 && brokenChain >= 5) {
          Sym.text(g, String(brokenChain), hx, hy + bp * base * 0.9, { align: 'center', baseline: 'middle', size: base * (1 - bp * 0.3), weight: 900, color: '#ff453a', alpha: 1 - bp, shadow: false });
        }
      }

      function drawHud(g, W, H) {
        Sym.text(g, Math.round(score).toLocaleString(), W - 18, 34, { align: 'right', size: 22, weight: 800, color: score < 0 ? '#ff6b5e' : '#eef0f4' });
        Sym.text(g, 'Best chain ' + Math.max(allTimeBest, bestChain), W - 18, 54, { align: 'right', size: 13, weight: 500, color: '#8a93a6' });
        Sym.text(g, U.fmtTime(Math.max(0, S.duration - now / 1000)), 18, 34, { size: 20, weight: 700, alpha: 0.8 });
        Sym.text(g, 'Burst ' + bLevel + ' · Distraction ' + dLevel + (S.resetCue ? ' · Reset: Space' : ''), 18, H - 16, { size: 12, weight: 500, alpha: 0.45 });
        Sym.text(g, 'Esc', W - 18, H - 16, { size: 12, align: 'right', alpha: 0.45 });
      }

      function drawFx(g, W, H, L) {
        const hy = H * 0.34;
        for (let j = fx.length - 1; j >= 0; j--) {
          const f = fx[j];
          const p = (now - f.t0) / f.dur;
          if (p >= 1) {
            fx.splice(j, 1);
            continue;
          }
          const a = 1 - p;
          if (f.k === 'judge') {
            const x = L.laneX + L.laneW + 16, y = L.hitY - 6 - p * 18;
            Sym.text(g, f.text, x, y, { size: 20, weight: 900, color: f.color, alpha: Math.min(1, a * 1.5) });
            Sym.text(g, f.sub, x, y + 20, { size: 14, weight: 700, color: f.color, alpha: a });
          } else if (f.k === 'burst') {
            const r = 10 + p * 46;
            g.globalAlpha = a;
            Sym.ring(g, f.x, L.hitY, r, f.color, 3);
            g.fillStyle = f.color;
            for (let i = 0; i < 8; i++) {
              const ang = (i / 8) * Math.PI * 2;
              g.fillRect(f.x + Math.cos(ang) * r * 1.2 - 2, L.hitY + Math.sin(ang) * r * 1.2 - 2, 4, 4);
            }
            g.globalAlpha = 1;
          } else if (f.k === 'tier') {
            const s = 1 + 0.6 * U.smooth(Math.min(1, p * 3));
            Sym.text(g, f.text, W / 2 + U.clamp(H * 0.14, 50, 130) * 0.9, hy - 30 - p * 20, { align: 'left', baseline: 'middle', size: 30 * s, weight: 900, color: f.color, alpha: a });
          } else if (f.k === 'ring') {
            const r = 30 + p * Math.min(W, H) * 0.2;
            g.fillStyle = f.color;
            g.globalAlpha = a;
            for (let i = 0; i < f.n; i++) {
              const ang = (i / f.n) * Math.PI * 2;
              g.fillRect(W / 2 + Math.cos(ang) * r - 3, hy + Math.sin(ang) * r * 0.6 - 3, 6, 6);
            }
            g.globalAlpha = 1;
          } else if (f.k === 'call') {
            const y = H * 0.5;
            Sym.text(g, f.text, W / 2, y, { align: 'center', size: f.small ? 22 : 30, weight: 900, color: f.color, alpha: Math.min(1, a * 1.6) });
            if (f.sub) Sym.text(g, f.sub, W / 2, y + 26, { align: 'center', size: 16, weight: 700, color: f.color, alpha: a });
          } else if (f.k === 'reset') {
            g.globalAlpha = a * 0.7;
            Sym.ring(g, W / 2, L.hitY, 30 + p * L.laneW * 0.5, '#9fcbef', 3);
            g.globalAlpha = 1;
          }
        }
      }

      let lastLayout = layout(ctx.W || 1280, ctx.H || 720);
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
          r.hitX = slotX(lastLayout, r, r.tgt);
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
          const L = (lastLayout = layout(W, H));
          const ti = tierOf(chain), T = TIERS[ti];
          g.fillStyle = '#07080a';
          g.fillRect(0, 0, W, H);
          if (ti >= 1) {
            const grd = g.createRadialGradient(W / 2, L.hitY, 0, W / 2, L.hitY, Math.max(W, H) * 0.7);
            grd.addColorStop(0, U.rgb(hex(T.c), 0.05 + ti * 0.012));
            grd.addColorStop(1, 'rgba(0,0,0,0)');
            g.fillStyle = grd;
            g.fillRect(0, 0, W, H);
          }
          const ep = (now - errT) / 320;
          g.save();
          if (ep < 1) g.translate((Math.random() - 0.5) * 12 * (1 - ep), (Math.random() - 0.5) * 8 * (1 - ep));
          drawLane(g, W, H, L);
          const dl = activeDist();
          const glitch = dl.some((d) => d.type === 'glitch');
          drawChain(g, W, H, L, glitch);
          for (const r of notes) drawRow(g, L, H, r);
          const unit = Math.min(L.laneW / 6 * 0.74, H * 0.075);
          drawDist(g, W, H, unit, dl);
          drawFx(g, W, H, L);
          g.restore();

          if (now < 1200 + APPROACH - 800 && !trials.length) {
            const y = H * 0.52;
            Sym.text(g, 'Press the BLUE arrow\'s direction as its row hits the line', W / 2, y, { align: 'center', size: Math.max(17, Math.min(26, W * 0.018)), weight: 700, color: COL.blue });
            Sym.text(g, 'ORANGE arrow: press the opposite way', W / 2, y + 30, { align: 'center', size: 16, weight: 600, color: COL.orange });
            Sym.text(g, 'Build the chain. When it breaks, make the next one count.', W / 2, y + 56, { align: 'center', size: 15, weight: 400, color: '#a1a9b7' });
          }
          if (ep < 1) {
            g.fillStyle = 'rgba(255,40,30,' + (0.24 * (1 - ep)).toFixed(3) + ')';
            g.fillRect(0, 0, W, H);
          }
          drawHud(g, W, H);
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
