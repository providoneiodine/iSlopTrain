/*
 * Draw the Line: palette, the corner complexes, and the words: what
 * the ideal line does, and each placement mistake in your line. No drawing
 * or session state; questionGen builds a question (complex + ideal line).
 *
 * Files in js/drills/racing-line/ load in this order and share the drill's
 * private namespace IST.RacingLine:
 *   content.js  this file
 *   ui.js       canvas widgets (panel, outline, button, wrapped text)
 *   sketch.js   your strokes -> a drawn line, and whether it is complete
 *   replay.js   replay timeline: stepping through braking, turn-in, apex, track-out
 *   scene.js    top-down map, in-car view, speed trace
 *   screens.js  drawing, result and replay screens
 *   stats.js    coach tips and the Stats page breakdowns
 *   drill.js    the drill definition, session state, grading and input
 */
(function () {
  'use strict';
  const LL = IST.LineLab;
  const DS = LL.DS;
  const RL = (IST.RacingLine = {});
  const COL = { ideal: '#5fd38a', pick: '#ff8a4d', quiz: '#f6d98f', dim: '#8a93a6', text: '#e8ecf2', bg: '#0c100e', panel: '#131915', panelHi: '#1a231d', bad: '#ff6b5e', ink: '#ffffff' };
  const PH = {
    brake: { label: 'Braking', short: 'B', color: '#ff6b5e' },
    turnin: { label: 'Turn-in', short: 'T', color: '#f6d98f' },
    apex: { label: 'Apex', short: 'A', color: '#6fd3ff' },
    exit: { label: 'Track-out', short: 'X', color: '#c69bff' },
    end: { label: 'End of the straight', short: '■', color: '#e8ecf2' },
  };
  const HOLD = 2000; // ms paused at each phase in the replay
  const BUDGET = 7; // ms per frame spent on background work
  const OFF = 1.12; // drawn this far out (× half width) = off the road
  /** Pass mark per level (s lost to the ideal). */
  const PASS = [null].concat(LL.BANDS.slice(1).map((b) => b[0]));

  // dir +1 = right-hander; each is mirrored at random
  const SCENARIOS = [
    { id: 'hairpin', name: 'Hairpin onto the straight', items: [['s', 260], ['c', 1, 16, 175], ['s', 520]] },
    { id: 'ninety', name: 'Right angle onto the straight', items: [['s', 240], ['c', -1, 32, 90], ['s', 480]] },
    { id: 'tighten', name: 'Tightening corner', items: [['s', 240], ['c', 1, 55, 120, 'tighten'], ['s', 450]] },
    { id: 'double', name: 'Double apex', items: [['s', 220], ['c', 1, 45, 85], ['s', 25], ['c', 1, 32, 95], ['s', 480]] },
    { id: 'ess', name: 'S-bend onto the straight', items: [['s', 220], ['c', -1, 70, 60], ['s', 10], ['c', 1, 38, 85], ['s', 500]] },
    { id: 'chicane', name: 'Chicane', items: [['s', 260], ['c', 1, 28, 50], ['s', 5], ['c', -1, 28, 55], ['s', 420]] },
    { id: 'chute', name: 'Two corners, short chute', items: [['s', 300], ['c', 1, 30, 90], ['s', 70], ['c', -1, 25, 90], ['s', 400]] },
    { id: 'sweepHair', name: 'Sweeper into a hairpin', items: [['s', 200], ['c', -1, 120, 60], ['s', 90], ['c', 1, 18, 170], ['s', 480]] },
    { id: 'esses', name: 'Esses', items: [['s', 200], ['c', 1, 75, 50], ['s', 8], ['c', -1, 70, 55], ['s', 8], ['c', 1, 50, 65], ['s', 450]] },
  ];
  const SCEN_LABELS = {};
  SCENARIOS.forEach((s) => (SCEN_LABELS[s.id] = s.name));
  const ERR_LABELS = {};
  Object.keys(LL.FLAWS).forEach((k) => (ERR_LABELS[k] = LL.FLAWS[k].label));
  const ERR_ORDER = ['early', 'late', 'entry', 'apex', 'exit', 'priority'];
  const ADVICE = {
    early: 'Look for the apex before you turn: an early turn-in feels fast but runs out of road on the exit.',
    late: "Don't over-delay the turn-in. A very late apex costs entry speed that the exit can't use.",
    entry: 'Use all the track on the way in: the turn-in point is on the outside edge.',
    apex: 'Clip the apex. Every metre you leave on the inside tightens the arc.',
    exit: 'Let it run out to the exit kerb: the wider exit arc gets you on the throttle earlier.',
    priority: 'In a complex, look past it first: the corner that leads onto the straight gets priority, and the one before is compromised for it.',
  };

  const kmh = (v) => Math.round(v * 3.6);
  const sec = (t) => (t >= 0 ? '+' : '−') + Math.abs(t).toFixed(2) + ' s';
  const T = (ci) => 'T' + (ci + 1);

  // ------------------------------------------------------------ questions
  function* questionGen(rnd, recent) {
    const pool = SCENARIOS.filter((s) => recent.indexOf(s.id) < 0);
    const spec = pool[Math.floor(rnd() * pool.length)];
    const geo = LL.build(spec, { mirror: rnd() < 0.5, rnd });
    const ideal = yield* LL.solveGen(geo);
    yield* LL.priorityGen(geo, ideal);
    const C = geo.corners;
    const q = { spec, geo, ideal, views: {}, sStart: C[0].startPos - 30, sStop: C[C.length - 1].endPos + 40 };
    ideal.name = 'Ideal line';
    ideal.note = describeIdeal(q);
    return q;
  }

  /** Corner j was sacrificed if the ideal is clearly slower there than corner j's own fastest line. */
  function sacrifices(q) {
    return (q.ideal.prio || [])
      .map((p) => ({ ci: p.ci, dv: (p.corners[p.ci].vMin - q.ideal.corners[p.ci].vMin) * 3.6, loss: p.loss }))
      .filter((x) => x.dv >= 3 && x.loss >= 0.05);
  }

  function describeIdeal(q) {
    const I = q.ideal, geo = q.geo;
    const sac = sacrifices(q);
    if (sac.length) {
      const s = sac[0];
      return 'Gives up ' + Math.round(s.dv) + ' km/h at ' + T(s.ci) + ' to set up ' + T(s.ci + 1) + ', so the car leaves the complex faster onto the ' + Math.round(geo.exitLen / 10) * 10 + ' m straight.';
    }
    const c = geo.corners.length - 1, f = I.corners[c], cc = geo.corners[c];
    const frac = (f.ia * DS - cc.startPos) / (cc.endPos - cc.startPos);
    return (frac > 0.55 ? 'Late apex' : frac < 0.45 ? 'Early apex' : 'Mid-corner apex') + ' at ' + T(c) + ' and the full width on exit: the earliest full throttle onto the straight.';
  }

  /** One placement issue in words. */
  function issueText(r, is) {
    switch (is.kind) {
      case 'early':
        return is.turn ? 'Turned in ' + Math.round(-r.dTurn) + ' m early' + (r.dApex < -4 ? ', apex ' + Math.round(-r.dApex) + ' m early' : '') : 'Apex ' + Math.max(3, Math.round(-r.dApex)) + ' m early';
      case 'late':
        return is.turn ? 'Turned in ' + Math.round(r.dTurn) + ' m late' + (r.dApex > 4 ? ', apex ' + Math.round(r.dApex) + ' m late' : '') : 'Apex ' + Math.max(3, Math.round(r.dApex)) + ' m late';
      case 'entry':
        return 'Turned in ' + r.entry.toFixed(1) + ' m in from the outside edge';
      case 'apex':
        return 'Missed the apex by ' + r.apexIn.toFixed(1) + ' m';
      case 'exit':
        return 'Left ' + r.exit.toFixed(1) + ' m of road unused on the exit';
      case 'priority':
        return (r.dv >= 2.5 ? 'Carried ' + Math.round(r.dv) + ' km/h more than the ideal here' : 'Quicker than the ideal here') + ', and paid for it at ' + T(r.ci + 1);
    }
    return '';
  }

  function cornerText(r) {
    if (!r.issues.length) return r.cost > 0.05 ? 'Right places, a little off the ideal arc' : 'On the ideal line';
    return r.issues.map((is) => issueText(r, is)).join(' · ');
  }

  /** Headline for your line: where the most time went, and why. */
  function describeUser(q, L) {
    const V = L.verdict;
    if (!V.some((r) => r.issues.length)) return L.loss < 0.03 ? 'Every corner placed like the ideal.' : 'Every corner in the right place; the small loss is in the shape of the arcs between them.';
    const worst = V.reduce((a, b) => (b.cost > a.cost ? b : a));
    const head = 'Most time lost at ' + T(worst.ci) + ' (' + sec(worst.cost) + ')';
    if (worst.issues.length) {
      const is = worst.issues[0];
      return head + ': ' + issueText(worst, is).toLowerCase() + '. ' + ADVICE[is.kind];
    }
    const prev = V[worst.ci - 1];
    if (prev && prev.issues.length) {
      const is = prev.issues[0];
      return head + ', set up at ' + T(prev.ci) + ': ' + issueText(prev, is).toLowerCase() + '. ' + ADVICE[is.kind];
    }
    const any = V.find((r) => r.issues.length);
    return head + '. Elsewhere, ' + T(any.ci) + ': ' + issueText(any, any.issues[0]).toLowerCase() + '.';
  }

  Object.assign(RL, {
    COL, PH, HOLD, BUDGET, OFF, PASS, SCENARIOS, SCEN_LABELS, ERR_LABELS, ERR_ORDER, ADVICE,
    kmh, sec, T, questionGen, sacrifices, describeIdeal, issueText, cornerText, describeUser,
  });
})();
