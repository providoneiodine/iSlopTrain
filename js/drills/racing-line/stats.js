/*
 * Draw the Line: what the results screen and the Stats page say about
 * your sessions. coach() gives the results screen's tips, analyze() the
 * Stats page breakdowns, notes and in-sim advice (shapes in
 * js/core/analysis.js). Both are called on the drill definition.
 */
(function () {
  'use strict';
  const U = IST.util, RL = IST.RacingLine;
  const { SCENARIOS, SCEN_LABELS, ERR_LABELS, ERR_ORDER, ADVICE } = RL;

  const coach = function (s, result) {
    const tips = [];
    const errs = s.errs || {};
    let worst = null;
    for (const k in errs) {
      const e = errs[k];
      if (e[1] >= 2 && (!worst || e[1] / e[0] > worst.r)) worst = { k, r: e[1] / e[0], e };
    }
    if (worst) tips.push('Most common mistake: ' + ERR_LABELS[worst.k].toLowerCase() + ' (' + worst.e[1] + ' of ' + worst.e[0] + ' corners). ' + ADVICE[worst.k]);
    if (U.isNum(s.placement) && s.placement >= 0.85 && s.trials >= 5) tips.push('Corners placed right almost every time. The level will keep tightening the pass mark.');
    const auto = !result || !result.settings || result.settings.level === 'auto';
    if (auto && U.isNum(s.nextLevel) && U.isNum(s.startLevel) && s.nextLevel !== s.startLevel)
      tips.push(s.nextLevel > s.startLevel ? 'Level up: ' + s.startLevel + ' → ' + s.nextLevel + '.' : 'Level eased: ' + s.startLevel + ' → ' + s.nextLevel + '.');
    return tips;
  };

  const analyze = function (results, A) {
    results = results.filter((r) => r.summary && r.summary.mode === 'draw'); // not the old multiple-choice sessions
    const recent = results.slice(-10);
    const out = { breakdowns: [], notes: [], insim: [] };
    if (!recent.length) return out;
    const sub = 'Last ' + recent.length + ' session' + (recent.length === 1 ? '' : 's');
    const byScen = A.sumTallies(recent, 'byScen');
    if (Object.keys(byScen).length) {
      out.breakdowns.push({ title: 'Lines passed, by complex', subtitle: sub, pct: true, minN: 3, nLabel: 'lines', items: A.items(byScen, SCENARIOS.map((s) => s.id), SCEN_LABELS) });
    }
    const errs = A.sumTallies(recent, 'errs');
    if (Object.keys(errs).length) {
      // share of the corners where each mistake was possible that you made it: higher is worse
      const items = A.items(errs, ERR_ORDER, ERR_LABELS).map((i) => Object.assign(i, { tag: undefined }));
      const judged = items.filter((i) => i.n >= A.MIN_N);
      if (judged.length >= 2) {
        const hi = judged.reduce((a, b) => (b.value > a.value ? b : a));
        if (hi.value >= 0.1) hi.tag = 'most common';
      }
      out.breakdowns.push({ title: 'Mistakes in your lines', subtitle: sub + ' · share of the corners where each was possible', pct: true, nLabel: 'corners', items });
      const rate = (keys) => {
        const e = keys.reduce((a, k) => (errs[k] ? [a[0] + errs[k][0], a[1] + errs[k][1]] : a), [0, 0]);
        return e[0] >= 8 ? { r: e[1] / e[0], e } : null;
      };
      const push = (id, keys, min, what) => {
        const x = rate(keys);
        if (x && x.r >= min) out.insim.push({ id, score: 0.3 + x.r, evidence: 'Drew ' + what + ' in ' + x.e[1] + ' of ' + x.e[0] + ' corners' });
      };
      push('LINE_EARLY', ['early'], 0.18, 'an early turn-in');
      push('LINE_LATE', ['late'], 0.2, 'a late turn-in');
      push('LINE_WIDTH', ['entry', 'apex', 'exit'], 0.15, 'a line that leaves track unused');
      push('LINE_PRIORITY', ['priority'], 0.2, 'the wrong corner prioritised');
    }
    const lv = A.values(results, 'level').filter(U.isNum);
    if (lv.length >= 2 && lv[lv.length - 1] - lv[0] >= 1) out.notes.push({ tone: 'good', text: 'Draw the Line: level ' + lv[0].toFixed(1) + ' → ' + lv[lv.length - 1].toFixed(1) + '.' });
    const acc = A.mean(A.values(recent, 'accuracy').slice(-5));
    if (acc != null && acc < 0.4 && recent.length >= 3) out.notes.push({ tone: 'bad', text: 'Draw the Line: ' + Math.round(acc * 100) + '% of lines passed lately. Watch the ideal\'s replay before the next one.' });
    return out;
  };

  Object.assign(RL, { coach, analyze });
})();
