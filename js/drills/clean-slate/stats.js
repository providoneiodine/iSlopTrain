/*
 * Clean Slate: what a session measured and what it means.
 *
 *   summarize(R, env)  the session summary saved with the result: recovery
 *                      after bursts, error chaining, post-error shift (Dutilh
 *                      et al., 2012), distraction cost and next run's levels.
 *                      R is the drill's live run state (trials, bursts, score,
 *                      ...); env = { S, bLevel, dLevel }. It also writes each
 *                      measured burst's recovery onto R.bursts.
 *   coach, analyze     the results screen's tips and the Stats page
 *                      breakdowns (see js/core/analysis.js for the shapes).
 */
(function () {
  'use strict';
  const U = IST.util, CS = IST.CleanSlate;
  const { WARMUP, CURVE, CLEAN_RUN, SLOW_X, MIN_BURSTS, MAX_LEVEL, BURST_LABELS, DIST_LABELS } = CS;

  function summarize(R, env) {
    const { S, bLevel, dLevel } = env;
    const T = R.trials;
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
    for (const b of R.bursts) {
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
      bestChain: R.bestChain, score: Math.round(R.score), brokenChains: R.brokenN, perfectRate, timing,
      burstLevel: bLevel, nextBurstLevel, distractLevel: dLevel, nextDistractLevel,
      distCost, distRT, resetGain,
      baseAcc, baseRT, lead: lastLeads.length ? U.median(lastLeads) : Math.round(R.lead),
      bursts: recs.length, burstsTotal: R.bursts.length, trials: T.length, stray: R.stray,
      baseN: base.length, baseOk: base.filter((t) => t.ok).length,
      curve, byBurst, byDist, byColor, pairs, byReset,
    };
  }

  const coach = function (s, result, hist) {
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
  };

  const analyze = function (results, A) {
    const out = { breakdowns: [], notes: [], insim: [] };
    const name = this.name;
    const withCurve = results.filter((r) => r.summary && r.summary.curve);
    if (!withCurve.length) return out;
    const recent = results.slice(-10);
    const sub = A.lastN(recent);
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
  };

  Object.assign(CS, { summarize, coach, analyze });
})();
