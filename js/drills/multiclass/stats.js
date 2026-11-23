/*
 * Class Traffic: what the results screen and the Stats page say about
 * your sessions. coach() gives the results screen's tips, analyze() the
 * Stats page breakdowns, notes and in-sim advice (shapes in
 * js/core/analysis.js). Both are called on the drill definition.
 */
(function () {
  'use strict';
  const U = IST.util, TL = IST.TrafficLab, MC = IST.Multiclass;
  const { RULE_IDS, SITS, SIT_ORDER, OPT_LABELS, OPT_ORDER } = MC;

  const coach = function (s, result) {
    const tips = [];
    const bySit = s.bySit || {};
    let worst = null;
    for (const k in bySit) {
      const e = bySit[k];
      if (e[0] >= 2 && (!worst || e[1] / e[0] < worst.r)) worst = { k, r: e[1] / e[0], e };
    }
    const txt = {
      'f-straight': 'When the speed gap gets you clear before the braking zone, take it there: it costs nothing and risks nothing.',
      'f-dive': 'Out-braking only works if you\'re clearly ahead before it turns in.',
      'f-outside': 'Round the outside works only where your extra grip carries you clear before its track-out.',
      'f-follow': 'If you\'ll only reach it at the apex, lift early and get it on the exit (slow in, fast out). A dive at a car that is turning in is the classic multiclass crash.',
      's-clear': 'If it will be past before the braking zone, do nothing: your normal line is the most useful thing you can give it.',
      's-committed': 'If it will be alongside into the corner, make room: ease off early so it clears, or brake a touch early and turn in behind it.',
      's-marginal': 'If it\'s right behind and lining up a late dive but hasn\'t committed, one early move to cover the inside, done before braking, tells it to wait for the exit. Once it has pulled out to that side, don\'t move across.',
      's-behind': 'Stuck behind you: under give-way and point-by rules, let it by on the straight if there is room before braking; otherwise wait for the next straight.',
      's-late': 'Noticed late: the predictable move still wins. Hold your line unless it\'s already alongside, then make room. Then check the mirror more often on long straights.',
      's-traffic': 'Catching a slow car: check the mirror before you pull out. If the prototype is close, it gets the passing lane first; pull out behind it.',
      'f-late': 'Noticed late: don\'t force a pass you haven\'t set up. Follow it in and use the exit.',
      'f-pair': 'Two GTs fighting won\'t be predictable. Pass both cleanly on a straight or wait; never dive into the middle of their battle.',
    };
    if (worst && worst.r < 0.7) tips.push(SITS[worst.k] + ': ' + worst.e[1] + ' of ' + worst.e[0] + ' right. ' + txt[worst.k]);
    if (U.isNum(s.riskRate) && s.riskRate >= 0.25) tips.push('A quarter of your picks were risky. When in doubt, the predictable option is the safe one: hold your line, or wait behind.');
    if (U.isNum(s.accuracy) && s.accuracy >= 0.85 && s.trials >= 6) tips.push('Sharp reading. The level will keep closing the margins.');
    const auto = !result || !result.settings || result.settings.level === 'auto';
    if (auto && U.isNum(s.nextLevel) && U.isNum(s.startLevel) && s.nextLevel !== s.startLevel)
      tips.push(s.nextLevel > s.startLevel ? 'Level up: ' + s.startLevel + ' → ' + s.nextLevel + '.' : 'Level eased: ' + s.startLevel + ' → ' + s.nextLevel + '.');
    return tips;
  };

  const analyze = function (results, A) {
    const recent = results.slice(-10);
    const out = { breakdowns: [], notes: [], insim: [] };
    const sub = A.lastN(recent);
    const bySit = A.sumTallies(recent, 'bySit');
    if (Object.keys(bySit).length) out.breakdowns.push({ title: 'Responsible calls, by situation', subtitle: sub, pct: true, minN: 3, nLabel: 'questions', items: A.items(bySit, SIT_ORDER, SITS) });
    const byRules = A.sumTallies(recent, 'byRules');
    const ruleLabels = {};
    RULE_IDS.forEach((id) => (ruleLabels[id] = TL.RULES[id].name));
    if (Object.keys(byRules).length > 1) out.breakdowns.push({ title: 'Responsible calls, by rule set', subtitle: sub, pct: true, minN: 3, nLabel: 'questions', items: A.items(byRules, RULE_IDS, ruleLabels) });
    const lure = A.sumTallies(recent, 'lure');
    if (Object.keys(lure).length) {
      const items = A.items(lure, OPT_ORDER, OPT_LABELS).map((i) => Object.assign(i, { tag: undefined }));
      out.breakdowns.push({ title: 'Wrong calls you picked', subtitle: sub + ' · share of the times each was wrong and on offer', pct: true, nLabel: 'times shown', items });
      const rate = (keys) => {
        const e = keys.reduce((a, k) => (lure[k] ? [a[0] + lure[k][0], a[1] + lure[k][1]] : a), [0, 0]);
        return e[0] >= 6 ? { r: e[1] / e[0], e } : null;
      };
      const push = (id, keys, min, what) => {
        const x = rate(keys);
        if (x && x.r >= min) out.insim.push({ id, score: 0.35 + x.r, evidence: 'Picked ' + what + ' ' + x.e[1] + ' of ' + x.e[0] + ' times it was wrong' });
      };
      push('MC_DIVE', ['dive', 'outside', 'straight'], 0.2, 'a pass that wasn\'t on');
      push('MC_PREDICT', ['across', 'brakeMove', 'early', 'defend'], 0.12, 'a move off your line or braking point');
      push('MC_MIRROR', ['overtake'], 0.25, 'pulling out to pass with a prototype closing');
      push('MC_ROOM', ['hold'], 0.25, 'holding your line with a car alongside or stuck behind');
      push('MC_PATIENCE', ['letby', 'room'], 0.25, 'giving away time you didn\'t need to');
    }
    const lv = A.values(results, 'level').filter(U.isNum);
    if (lv.length >= 2 && lv[lv.length - 1] - lv[0] >= 1) out.notes.push({ tone: 'good', text: 'Class Traffic: level ' + lv[0].toFixed(1) + ' → ' + lv[lv.length - 1].toFixed(1) + '.' });
    const rr = A.mean(A.values(recent, 'riskRate').slice(-5));
    if (rr != null && rr > 0.25 && recent.length >= 3) out.notes.push({ tone: 'bad', text: 'Class Traffic: ' + Math.round(rr * 100) + '% of recent picks were risky. Watch the replays of those.' });
    return out;
  };

  Object.assign(MC, { coach, analyze });
})();
