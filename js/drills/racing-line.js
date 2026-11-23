/*
 * Pick the Line: a racing-line quiz (Mind tab).
 *
 * Each question is a corner complex seen from above with 4 or 6 candidate
 * lines. One is the minimum-time line for that complex (IST.LineLab: a
 * point-mass lap-time model with a friction ellipse, power limit and drag,
 * optimised over the whole complex and the straight after it). The others
 * are realistic mistakes built from it: early or late turn-in, narrow
 * entry, missed apex, narrow exit, and, in complexes, taking the wrong
 * corner's fastest line (compromising the corner that leads onto the
 * straight). Every wrong line's time loss is computed, and the level picks
 * how close the wrong lines are (2-down / 1-up, ~71 % correct).
 *
 * After each answer an analysis replays any of the lines from the driver's
 * seat (Apex Snap's renderer) next to the top-down view and a speed trace,
 * pausing at braking, turn-in, apex and track-out with what the line is
 * doing there and the gap to the ideal. Left / right switches line.
 *
 * Built for retrieval practice with corrective feedback (Roediger &
 * Karpicke, 2006; Butler & Roediger, 2008) and contrasting cases (Schwartz
 * & Bransford, 1998), with the in-car view as perspective-matched imagery
 * (Holmes & Collins, 2001).
 */
(function () {
  'use strict';
  const U = IST.util, Sym = IST.Symbols, LL = IST.LineLab;
  const MAX_LEVEL = LL.MAX_LEVEL, HW = LL.HW;
  const COL = { ideal: '#5fd38a', pick: '#ff8a4d', quiz: '#f6d98f', dim: '#8a93a6', text: '#e8ecf2', bg: '#0c100e', panel: '#131915', panelHi: '#1a231d', bad: '#ff6b5e' };
  const PH = {
    brake: { label: 'Braking', short: 'B', color: '#ff6b5e' },
    turnin: { label: 'Turn-in', short: 'T', color: '#f6d98f' },
    apex: { label: 'Apex', short: 'A', color: '#6fd3ff' },
    exit: { label: 'Track-out', short: 'X', color: '#c69bff' },
    end: { label: 'End of the straight', short: '■', color: '#e8ecf2' },
  };
  const HOLD = 2000; // ms paused at each phase in the replay
  const REVEAL = 1500; // ms showing the answers before the replay starts
  const BUDGET = 7; // ms per frame spent building the next question

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
  const FLAW_LABELS = {};
  Object.keys(LL.FLAWS).forEach((k) => (FLAW_LABELS[k] = LL.FLAWS[k].label));
  const FLAW_ORDER = ['early', 'late', 'entry', 'apex', 'exit', 'priority'];

  const kmh = (v) => Math.round(v * 3.6);
  const sec = (t) => (t >= 0 ? '+' : '−') + Math.abs(t).toFixed(2) + ' s';
  const T = (ci) => 'T' + (ci + 1);

  function shuffle(a, rnd) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ------------------------------------------------------------ questions
  function* questionGen(level, nOpts, rnd, recent) {
    const pool = SCENARIOS.filter((s) => recent.indexOf(s.id) < 0);
    for (let tries = 0; tries < 4; tries++) {
      const spec = pool[Math.floor(rnd() * pool.length)];
      for (let attempt = 0; attempt < 3; attempt++) {
        // jittered variants first; the plain layout is the fallback
        const geo = LL.build(spec, { mirror: rnd() < 0.5, rnd: attempt < 2 ? rnd : null });
        const ideal = yield* LL.solveGen(geo);
        yield* LL.priorityGen(geo, ideal);
        yield;
        const ds = LL.distractors(geo, ideal, level, nOpts - 1, rnd);
        if (ds.beaten || ds.length < Math.min(3, nOpts - 1)) continue;
        return prepare(spec, geo, ideal, ds, level, rnd);
      }
    }
    return null;
  }

  function prepare(spec, geo, ideal, ds, level, rnd) {
    const lines = [ideal].concat(ds);
    const q = { spec, geo, ideal, lines, level, views: {}, minGap: Math.min.apply(null, ds.map((d) => d.loss)) };
    lines.forEach((L) => {
      L.name = L.isIdeal ? 'Ideal line' : FLAW_LABELS[L.flaw] + ' · ' + T(L.ci);
      L.note = describe(q, L);
    });
    q.order = shuffle(lines.map((_, i) => i), rnd);
    return q;
  }

  /** Corner j was sacrificed if the ideal is clearly slower there than corner j's own fastest line. */
  function sacrifices(q) {
    return (q.ideal.prio || [])
      .map((p) => ({ ci: p.ci, dv: (p.corners[p.ci].vMin - q.ideal.corners[p.ci].vMin) * 3.6, loss: p.loss }))
      .filter((x) => x.dv >= 3 && x.loss >= 0.05);
  }

  /** What the line does wrong, measured against the ideal. */
  function describe(q, L) {
    const I = q.ideal, geo = q.geo;
    if (L.isIdeal) {
      const sac = sacrifices(q);
      if (sac.length) {
        const s = sac[0];
        return 'Gives up ' + Math.round(s.dv) + ' km/h at ' + T(s.ci) + ' to set up ' + T(s.ci + 1) + ', so the car leaves the complex faster onto the ' + Math.round(geo.exitLen / 10) * 10 + ' m straight.';
      }
      const c = geo.corners.length - 1, f = I.corners[c], cc = geo.corners[c];
      const frac = (f.ia * LL.DS - cc.startPos) / (cc.endPos - cc.startPos);
      return (frac > 0.55 ? 'Late apex' : frac < 0.45 ? 'Early apex' : 'Mid-corner apex') + ' at ' + T(c) + ' and the full width on exit: the earliest full throttle onto the straight.';
    }
    const ci = L.ci, fi = I.corners[ci], fl = L.corners[ci];
    const dApex = Math.abs(fi.ia - fl.ia) * LL.DS;
    const at = (n, i) => Math.abs(n[U.clamp(i, 0, n.length - 1)]);
    switch (L.flaw) {
      case 'early':
        return 'Turns in early at ' + T(ci) + ': the apex comes ' + Math.max(2, Math.round(dApex)) + ' m too soon, the car runs out of road on the exit and the throttle has to wait.';
      case 'late':
        return 'Turns in late at ' + T(ci) + ': the apex is ' + Math.max(2, Math.round(dApex)) + ' m late. A slow, tight entry, and the exit is no better for it.';
      case 'entry':
        return 'Turns in to ' + T(ci) + ' ' + Math.max(1, (at(I.n, fi.ti) - at(L.n, fi.ti)) * HW).toFixed(1) + ' m in from the outside edge. Less width, a tighter arc, a slower corner.';
      case 'apex':
        return 'Misses the ' + T(ci) + ' apex by ' + Math.max(1, (at(I.n, fi.ia) - at(L.n, fi.ia)) * HW).toFixed(1) + ' m. The arc is tighter than it needs to be.';
      case 'exit':
        return 'Stays ' + Math.max(1, (at(I.n, fi.to) - at(L.n, fi.to)) * HW).toFixed(1) + ' m inside the ' + T(ci) + ' exit kerb. The tighter exit arc delays full throttle.';
      case 'priority': {
        const dv = (fl.vMin - fi.vMin) * 3.6;
        return 'Takes ' + T(ci) + "'s own fastest line" + (dv >= 1 ? ' (' + Math.round(dv) + ' km/h quicker there)' : '') + ', which leaves the car badly placed for ' + T(ci + 1) + '. The time is lost on the way out of the complex.';
      }
    }
    return '';
  }

  // ----------------------------------------------------------- definition
  IST.registerDrill({
    id: 'racing-line',
    name: 'Pick the Line',
    tab: 'mind',
    category: 'Racecraft',
    tagline: 'Spot the fastest line through a corner complex.',
    description:
      'A corner complex from above with several lines through it. Pick the fastest to the end of the straight. ' +
      'Wrong lines are real mistakes (early turn-in, missed apex, the wrong corner prioritised…) with their time loss worked out by a lap-time model, ' +
      'and they get closer to the ideal as you level up. After each answer, replay any line from the driver\'s seat, paused at braking, turn-in, apex and track-out.',
    research: [
      { point: 'The corner before a long straight matters most: exit speed is carried all the way down it.', source: 'Lopez (2001), Going Faster! Mastering the Art of Race Driving. Bentley Publishers.' },
      { point: 'In a combination, compromise the earlier corner to set up the one that leads onto the straight.', source: 'Bentley (1998), Speed Secrets. Motorbooks International.' },
      { point: 'Quasi-steady-state lap simulation shows how the racing line changes lap time.', source: 'Brayshaw & Harrison (2005), Proc. IMechE Part D 219(6).' },
      { point: 'Minimum-time lines balance a short path against low curvature; they can be found numerically.', source: 'Kapania, Subosits & Gerdes (2016), J. Dyn. Sys., Meas., Control 138(9).' },
      { point: 'Being tested on material beats re-studying it for long-term retention.', source: 'Roediger & Karpicke (2006), Psychological Science 17(3).' },
      { point: 'Feedback after multiple-choice tests stops the wrong options being learned as true.', source: 'Butler & Roediger (2008), Memory & Cognition 36(3).' },
      { point: 'Comparing contrasting cases side by side helps learners see the features that matter.', source: 'Schwartz & Bransford (1998), Cognition and Instruction 16(4).' },
      { point: 'Imagery works best from the performer\'s own viewpoint and in real time (PETTLEP).', source: 'Holmes & Collins (2001), J. Appl. Sport Psychol. 13(1).' },
      { point: 'Adaptive difficulty holds you at a challenge point (~71 % correct).', source: 'Levitt (1971); Guadagnoli & Lee (2004), J. Motor Behavior 36(2).' },
    ],
    settings: [
      { key: 'questions', label: 'Questions', type: 'number', default: 10, min: 3, max: 40, step: 1 },
      { key: 'choices', label: 'Lines per question', type: 'select', default: '6', options: [['6', '6'], ['4', '4']] },
      { key: 'level', label: 'Level', type: 'select', default: 'auto', options: [['auto', 'Auto (adapts)']].concat([1, 2, 3, 4, 5, 6].map((n) => [String(n), String(n)])), hint: 'Higher levels hide smaller mistakes.' },
      { key: 'replay', label: 'Replay analysis', type: 'select', default: 'always', options: [['always', 'After every answer'], ['wrong', 'Only when wrong'], ['off', 'Off']] },
      { key: 'timeLimit', label: 'Time limit', type: 'select', default: '0', options: [['0', 'None'], ['30', '30 s'], ['20', '20 s'], ['10', '10 s']] },
      { key: 'fov', label: 'FOV (horizontal)', type: 'number', unit: '°', default: 70, min: 30, max: 120, step: 1, hint: 'In-car replay. Match your sim.' },
      { key: 'style', label: 'Replay style', type: 'select', default: 'realistic', options: [['realistic', 'Realistic'], ['minimal', 'Minimal']] },
    ],
    metrics: [
      { key: 'level', label: 'Line level', digits: 1, better: 'higher', primary: true, hint: 'Average level over the second half of the session. Higher levels put the wrong lines closer to the ideal.' },
      { key: 'accuracy', label: 'Fastest line found', pct: true, digits: 0, better: 'higher' },
      { key: 'gap', label: 'Closest call', unit: 's', digits: 2, better: 'lower', hint: 'Median gap between the ideal and the closest wrong line, on questions you got right.' },
      { key: 'timeLost', label: 'Time lost per pick', unit: 's', digits: 2, better: 'lower', hint: 'Average time the picked line loses to the ideal (0 when right).' },
      { key: 'decision', label: 'Decision time', unit: 's', digits: 1, better: 'lower' },
      ...IST.Juice.METRICS,
      { key: 'trials', label: 'Questions', digits: 0 },
    ],

    levelFor(S, history) {
      if (S.level && S.level !== 'auto') return U.clamp(Number(S.level) || 1, 1, MAX_LEVEL);
      for (let i = history.length - 1; i >= 0; i--) {
        const s = history[i].summary;
        if (s && U.isNum(s.nextLevel)) return s.nextLevel;
      }
      return 1;
    },

    coach(s, result) {
      const tips = [];
      const lure = s.lure || {};
      let worst = null;
      for (const k in lure) {
        const e = lure[k];
        if (e[1] >= 2 && (!worst || e[1] / e[0] > worst.r)) worst = { k, r: e[1] / e[0], e };
      }
      if (worst) {
        const txt = {
          early: 'Look for the apex before you turn: an early turn-in feels fast but costs the exit.',
          late: 'Don\'t over-delay the turn-in. A very late apex costs entry speed that the exit can\'t use.',
          entry: 'Use all the track on the way in: the turn-in point is on the outside edge.',
          apex: 'Clip the apex. Every metre you leave on the inside tightens the arc.',
          exit: 'Let it run out to the exit kerb: the wider exit arc gets you on the throttle earlier.',
          priority: 'In a complex, look past it first: the corner that leads onto the straight gets priority, and the one before is compromised for it.',
        };
        tips.push('Most picked mistake: ' + FLAW_LABELS[worst.k].toLowerCase() + ' (' + worst.e[1] + ' of ' + worst.e[0] + '). ' + txt[worst.k]);
      }
      if (U.isNum(s.accuracy) && s.accuracy >= 0.85 && s.trials >= 6) tips.push('Sharp reading. The level will keep closing the gaps.');
      if (U.isNum(s.decision) && s.decision > 20) tips.push('Slow decisions. Check the straight after the complex first, then the turn-in points, then the apexes.');
      const auto = !result || !result.settings || result.settings.level === 'auto';
      if (auto && U.isNum(s.nextLevel) && U.isNum(s.startLevel) && s.nextLevel !== s.startLevel)
        tips.push(s.nextLevel > s.startLevel ? 'Level up: ' + s.startLevel + ' → ' + s.nextLevel + '.' : 'Level eased: ' + s.startLevel + ' → ' + s.nextLevel + '.');
      return tips;
    },

    analyze(results, A) {
      const recent = results.slice(-10);
      const out = { breakdowns: [], notes: [], insim: [] };
      const sub = 'Last ' + recent.length + ' session' + (recent.length === 1 ? '' : 's');
      const byScen = A.sumTallies(recent, 'byScen');
      if (Object.keys(byScen).length) {
        out.breakdowns.push({ title: 'Fastest line found, by complex', subtitle: sub, pct: true, minN: 3, nLabel: 'questions', items: A.items(byScen, SCENARIOS.map((s) => s.id), SCEN_LABELS) });
      }
      const lure = A.sumTallies(recent, 'lure');
      if (Object.keys(lure).length) {
        // share of the times each mistake was on offer that you picked it: higher is worse
        const items = A.items(lure, FLAW_ORDER, FLAW_LABELS).map((i) => Object.assign(i, { tag: undefined }));
        const judged = items.filter((i) => i.n >= A.MIN_N);
        if (judged.length >= 2) {
          const hi = judged.reduce((a, b) => (b.value > a.value ? b : a));
          if (hi.value >= 0.1) hi.tag = 'falls for most';
        }
        out.breakdowns.push({ title: 'Wrong lines you picked', subtitle: sub + ' · share of the times each was on offer', pct: true, nLabel: 'times shown', items });
        const rate = (keys) => {
          const e = keys.reduce((a, k) => (lure[k] ? [a[0] + lure[k][0], a[1] + lure[k][1]] : a), [0, 0]);
          return e[0] >= 8 ? { r: e[1] / e[0], e } : null;
        };
        const push = (id, keys, min, what) => {
          const x = rate(keys);
          if (x && x.r >= min) out.insim.push({ id, score: 0.3 + x.r, evidence: 'Picked ' + what + ' ' + x.e[1] + ' of ' + x.e[0] + ' times it was offered' });
        };
        push('LINE_EARLY', ['early'], 0.18, 'an early turn-in');
        push('LINE_LATE', ['late'], 0.2, 'a late turn-in');
        push('LINE_WIDTH', ['entry', 'apex', 'exit'], 0.15, 'a line that leaves track unused');
        push('LINE_PRIORITY', ['priority'], 0.2, 'the wrong corner\'s line');
      }
      const lv = A.values(results, 'level').filter(U.isNum);
      if (lv.length >= 2 && lv[lv.length - 1] - lv[0] >= 1) out.notes.push({ tone: 'good', text: 'Pick the Line: level ' + lv[0].toFixed(1) + ' → ' + lv[lv.length - 1].toFixed(1) + '.' });
      const acc = A.mean(A.values(recent, 'accuracy').slice(-5));
      if (acc != null && acc < 0.5 && recent.length >= 3) out.notes.push({ tone: 'bad', text: 'Pick the Line: fastest line found ' + Math.round(acc * 100) + '% of the time lately. Try the replays on the lines you pick.' });
      return out;
    },

    create(ctx) {
      const S = ctx.settings, def = this;
      const rnd = U.rng(U.randomSeed());
      const nOpts = Number(S.choices) === 4 ? 4 : 6;
      const auto = !S.level || S.level === 'auto';
      const startLevel = def.levelFor(S, ctx.history);
      const timeLimit = Number(S.timeLimit) || 0;
      const J = new IST.Juice({ history: ctx.history });
      const canvas = document.getElementById('stage');

      const st = {
        mode: 'loading', level: startLevel, streak: 0, q: null, next: null, gen: null,
        sel: 0, hover: -1, pick: -1, tMode: 0, rp: null, buttons: [], recent: [], done: false,
      };
      const rows = [];
      const lure = {}, byScen = {};

      function queue() {
        st.next = null;
        st.gen = questionGen(st.level, nOpts, rnd, st.recent);
      }
      function pump() {
        if (!st.gen) return;
        const t0 = performance.now();
        while (performance.now() - t0 < BUDGET) {
          const r = st.gen.next();
          if (r.done) {
            st.gen = null;
            if (r.value) st.next = r.value;
            else queue(); // no usable variant: try other complexes
            return;
          }
        }
      }
      queue();

      function startQuestion() {
        st.q = st.next;
        st.next = null;
        st.mode = 'question';
        st.tMode = ctx.clock();
        st.sel = 0;
        st.pick = -1;
        st.rp = null;
        st.recent.push(st.q.spec.id);
        if (st.recent.length > 3) st.recent.shift();
      }

      function answer(i) {
        const q = st.q;
        const L = i >= 0 ? q.lines[q.order[i]] : null;
        const correct = !!(L && L.isIdeal);
        const dec = (ctx.clock() - st.tMode) / 1000;
        st.pick = i;
        st.mode = 'reveal';
        st.tMode = ctx.clock();
        // tallies
        q.lines.forEach((x) => {
          if (x.isIdeal) return;
          const e = (lure[x.flaw] = lure[x.flaw] || [0, 0]);
          e[0]++;
          if (x === L) e[1]++;
        });
        const sc = (byScen[q.spec.id] = byScen[q.spec.id] || [0, 0]);
        sc[0]++;
        if (correct) sc[1]++;
        rows.push({
          scen: q.spec.id, mirror: q.geo.mirror ? 1 : 0, level: q.level, correct: correct ? 1 : 0,
          pick: L ? (L.isIdeal ? 'ideal' : L.flaw) : 'timeout', ci: L && !L.isIdeal ? L.ci : null,
          loss: L ? +L.loss.toFixed(3) : +Math.max.apply(null, q.lines.map((x) => x.loss)).toFixed(3),
          gap: +q.minGap.toFixed(3), dec: +dec.toFixed(2),
        });
        if (correct) {
          const quick = dec < 5 ? 8 : dec < 10 ? 4 : 0;
          J.hit({ base: 10, bonus: q.level * 4 + quick, label: quick === 8 ? 'QUICK READ' : 'FASTEST LINE', color: COL.ideal });
        } else {
          J.miss({ label: L ? sec(L.loss) : 'TIME' });
        }
        if (auto) {
          if (correct && ++st.streak >= 2) {
            st.level = Math.min(MAX_LEVEL, st.level + 1);
            st.streak = 0;
          } else if (!correct) {
            st.level = Math.max(1, st.level - 1);
            st.streak = 0;
          }
        }
        if (rows.length < S.questions) queue();
      }

      const wantsReplay = () => S.replay === 'always' || (S.replay === 'wrong' && rows.length && !rows[rows.length - 1].correct);

      function advance() {
        if (rows.length >= S.questions) {
          st.done = true;
          ctx.finish();
          return;
        }
        if (st.next) startQuestion();
        else st.mode = 'loading';
      }

      // ------------------------------------------------------------ replay
      function startReplay(li) {
        const q = st.q, L = q.lines[li];
        const picked = st.pick >= 0 ? q.lines[q.order[st.pick]] : null;
        let ghost = q.ideal;
        if (L.isIdeal) {
          ghost = picked && !picked.isIdeal ? picked : q.lines.filter((x) => !x.isIdeal).reduce((a, b) => (b.loss < a.loss ? b : a));
        }
        const brake = L.ph.find((p) => p.kind === 'brake');
        const s0 = Math.max(0, Math.min(q.geo.corners[0].startPos - 150, brake ? brake.s - 70 : Infinity));
        st.mode = 'replay';
        st.rp = {
          li, line: L, ghost, s0, s: s0, t: LL.timeAt(L.sim, s0), t0: LL.timeAt(L.sim, s0), gt0: LL.timeAt(ghost.sim, s0),
          phases: L.ph.filter((p) => p.s > s0 + 1), pi: 0, hold: 600, cur: null, curAt: 0, done: false,
        };
      }
      function replayLines() {
        // cycle in panel order so the numbers match the quiz
        return st.q.order.slice();
      }
      function cycle(dir) {
        const ord = replayLines();
        const k = ord.indexOf(st.rp.li);
        startReplay(ord[(k + dir + ord.length) % ord.length]);
      }
      function skipPhase() {
        const rp = st.rp;
        if (rp.done) return;
        if (rp.hold > 0 && rp.cur) {
          rp.hold = 0;
          return;
        }
        const ph = rp.phases[rp.pi];
        if (ph) {
          rp.t = LL.timeAt(rp.line.sim, Math.max(rp.s, ph.s - 0.5));
        }
      }
      function updateReplay(dt) {
        const rp = st.rp;
        if (!rp || rp.done) return;
        if (rp.hold > 0) {
          rp.hold -= dt;
          if (rp.hold > 0) return;
          rp.hold = 0;
        }
        rp.t += dt / 1000;
        let s = LL.posAtTime(rp.line.sim, rp.t);
        const ph = rp.phases[rp.pi];
        if (ph && s >= ph.s) {
          s = ph.s;
          rp.t = LL.timeAt(rp.line.sim, s);
          rp.cur = ph;
          rp.curAt = performance.now();
          rp.pi++;
          if (ph.kind === 'end') {
            rp.done = true;
            rp.hold = Infinity;
          } else rp.hold = HOLD;
          if (J.audio) J.audio.tick();
        }
        rp.s = s;
      }

      // ------------------------------------------------------------- input
      function gridDims(W, H) {
        const cols = nOpts === 6 ? (W / H >= 1.15 ? 3 : 2) : 2;
        return { cols, rows: Math.ceil(nOpts / cols) };
      }
      function onAct(a) {
        if (st.mode === 'question') {
          const { cols } = gridDims(ctx.W, ctx.H);
          if (a === 'left') st.sel = (st.sel + nOpts - 1) % nOpts;
          else if (a === 'right') st.sel = (st.sel + 1) % nOpts;
          else if (a === 'up') st.sel = (st.sel - cols + nOpts) % nOpts;
          else if (a === 'down') st.sel = (st.sel + cols) % nOpts;
          else if (a === 'confirm') answer(st.sel);
        } else if (st.mode === 'reveal') {
          if (a === 'confirm' || a === 'right' || a === 'left') leaveReveal(a !== 'confirm' || wantsReplay());
        } else if (st.mode === 'replay') {
          if (a === 'left') cycle(-1);
          else if (a === 'right') cycle(1);
          else if (a === 'up') skipPhase();
          else if (a === 'down') startReplay(st.rp.li);
          else if (a === 'confirm') advance();
        }
      }
      function leaveReveal(replay) {
        if (replay) {
          const q = st.q, picked = st.pick >= 0 ? q.order[st.pick] : 0;
          startReplay(picked);
        } else advance();
      }

      const ptr = (e) => [e.offsetX, e.offsetY];
      const hit = (x, y) => st.buttons.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
      function onMove(e) {
        const [x, y] = ptr(e);
        const b = hit(x, y);
        canvas.style.cursor = b ? 'pointer' : '';
        if (st.mode === 'question' && b && b.panel != null) st.sel = b.panel;
      }
      function onDown(e) {
        const [x, y] = ptr(e);
        const b = hit(x, y);
        if (!b) return;
        e.preventDefault();
        if (b.panel != null && st.mode === 'question') answer(b.panel);
        else if (b.act) b.act();
      }
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerdown', onDown);

      // ------------------------------------------------------------ drawing
      function view(q, key, w, h, pad) {
        const k = key + ':' + Math.round(w) + 'x' + Math.round(h);
        return q.views[k] || (q.views[k] = LL.fitView(q.geo, w, h, pad));
      }

      function drawPanel(g, q, i, x, y, w, h) {
        const L = q.lines[q.order[i]];
        const reveal = st.mode !== 'question';
        const sel = !reveal && i === st.sel, picked = reveal && i === st.pick;
        g.save();
        Sym.roundRect(g, x, y, w, h, 10);
        g.fillStyle = sel ? COL.panelHi : COL.panel;
        g.fill();
        g.save();
        g.clip();
        g.translate(x, y);
        const V = view(q, 'p', w, h, 22);
        LL.drawTrack(g, q.geo, V, { bg: sel ? COL.panelHi : COL.panel, fontSize: 11 });
        if (reveal && !L.isIdeal) LL.drawLine(g, q.geo, V, q.ideal.sim, { color: COL.ideal, width: 2, alpha: 0.5 });
        LL.drawLine(g, q.geo, V, L.sim, { color: reveal ? (L.isIdeal ? COL.ideal : COL.pick) : COL.quiz, width: sel ? 3.5 : 3, glow: sel ? 10 : 0 });
        g.restore();
        // number badge
        Sym.roundRect(g, x + 8, y + 8, 24, 24, 6);
        g.fillStyle = sel ? COL.quiz : 'rgba(255,255,255,0.12)';
        g.fill();
        Sym.text(g, String(i + 1), x + 20, y + 20.5, { align: 'center', baseline: 'middle', size: 14, weight: 900, color: sel ? '#141a16' : COL.text, shadow: false });
        if (reveal) {
          const tag = L.isIdeal ? 'FASTEST' : sec(L.loss);
          const sub = L.isIdeal ? 'Ideal line' : FLAW_LABELS[L.flaw] + ' · ' + T(L.ci);
          g.fillStyle = 'rgba(8,10,9,0.78)';
          g.fillRect(x, y + h - 40, w, 40);
          Sym.text(g, tag, x + 12, y + h - 22, { size: 15, weight: 900, color: L.isIdeal ? COL.ideal : COL.pick, baseline: 'middle' });
          Sym.text(g, sub, x + 12, y + h - 8, { size: 11, weight: 600, color: COL.dim, baseline: 'alphabetic' });
          if (picked) Sym.text(g, 'YOUR PICK', x + w - 12, y + 20, { align: 'right', baseline: 'middle', size: 12, weight: 900, color: L.isIdeal ? COL.ideal : COL.bad });
        }
        // outline
        Sym.roundRect(g, x, y, w, h, 10);
        g.lineWidth = sel || picked || (reveal && L.isIdeal) ? 3 : 1;
        g.strokeStyle = picked ? (L.isIdeal ? COL.ideal : COL.bad) : reveal && L.isIdeal ? COL.ideal : sel ? COL.quiz : 'rgba(255,255,255,0.1)';
        g.stroke();
        g.restore();
        st.buttons.push({ x, y, w, h, panel: i });
      }

      function header(g, W, title, sub) {
        const q = st.q;
        Sym.text(g, 'Q ' + Math.min(S.questions, rows.length + (st.mode === 'question' ? 1 : 0)) + ' / ' + S.questions, 18, 28, { size: 16, weight: 800, alpha: 0.85 });
        Sym.text(g, 'Level ' + (q ? q.level : st.level), 18, 48, { size: 13, weight: 600, color: COL.dim });
        if (title) Sym.text(g, title, W / 2, 28, { align: 'center', size: Math.max(17, Math.min(24, W * 0.018)), weight: 850 });
        if (sub) Sym.text(g, sub, W / 2, 50, { align: 'center', size: 13, weight: 400, color: '#b9c1ce' });
      }

      function button(g, x, y, label, act, o) {
        o = o || {};
        g.font = '800 13px ' + Sym.FONT;
        const w = Math.max(o.min || 0, g.measureText(label).width + 22), h = 28;
        Sym.roundRect(g, x - (o.right ? w : 0), y, w, h, 7);
        g.fillStyle = o.primary ? COL.quiz : 'rgba(255,255,255,0.1)';
        g.fill();
        Sym.text(g, label, x - (o.right ? w : 0) + w / 2, y + h / 2 + 0.5, { align: 'center', baseline: 'middle', size: 13, weight: 800, color: o.primary ? '#141a16' : COL.text, shadow: false });
        st.buttons.push({ x: x - (o.right ? w : 0), y, w, h, act });
        return w;
      }

      function renderQuiz(g, W, H) {
        const q = st.q;
        header(g, W, q.spec.name, st.mode === 'question' ? 'Which line is fastest to the end of the straight?' : null);
        const top = 66, bot = 34;
        const { cols, rows: rr } = gridDims(W, H);
        const gap = 12, gx = 16, gw = W - 32, gh = H - top - bot;
        const pw = (gw - gap * (cols - 1)) / cols, phh = (gh - gap * (rr - 1)) / rr;
        for (let i = 0; i < nOpts; i++) {
          const c = i % cols, r = Math.floor(i / cols);
          drawPanel(g, q, i, gx + c * (pw + gap), top + r * (phh + gap), pw, phh);
        }
        const fade = U.clamp((ctx.clock() - st.tMode) / 250, 0, 1);
        if (st.mode === 'question') {
          if (fade < 1) {
            g.fillStyle = 'rgba(12,16,14,' + (1 - fade).toFixed(3) + ')';
            g.fillRect(0, top, W, gh);
          }
          Sym.text(g, '← ↑ ↓ →  choose   ·   Space  lock in   ·   or click a line', W / 2, H - 12, { align: 'center', size: 13, color: COL.dim });
          if (timeLimit) {
            const left = 1 - (ctx.clock() - st.tMode) / (timeLimit * 1000);
            g.fillStyle = 'rgba(255,255,255,0.1)';
            g.fillRect(W / 2 - 120, 58, 240, 3);
            g.fillStyle = left < 0.25 ? COL.bad : COL.quiz;
            g.fillRect(W / 2 - 120, 58, 240 * U.clamp(left, 0, 1), 3);
          }
        } else {
          const picked = st.pick >= 0 ? q.lines[q.order[st.pick]] : null;
          const msg = !picked ? 'Out of time' : picked.isIdeal ? 'Fastest line!' : 'Not quite: ' + sec(picked.loss) + ' to the ideal';
          Sym.text(g, msg, W / 2, 50, { align: 'center', size: 14, weight: 800, color: picked && picked.isIdeal ? COL.ideal : COL.bad });
          Sym.text(g, 'Space  ' + (wantsReplay() ? 'replay' : 'next') + '   ·   ← →  replay any line', W / 2, H - 12, { align: 'center', size: 13, color: COL.dim });
        }
      }

      function lineColor(L) {
        return L.isIdeal ? COL.ideal : COL.pick;
      }

      function drawRibbon(g, R, L, from, color, alpha, width) {
        const geo = st.q.geo;
        let prev = null;
        g.save();
        g.strokeStyle = color;
        g.globalAlpha = alpha;
        g.lineCap = 'round';
        for (let s = from + 2.5; s < from + 420; s += 2.5) {
          const n = LL.sampleAt(L.n, L.sim, Math.min(s, geo.sEnd));
          const p = R.project(s, n * HW, 0.03);
          if (!p) {
            prev = null;
            continue;
          }
          if (prev) {
            g.lineWidth = U.clamp(width * p.s, 1, 9);
            g.beginPath();
            g.moveTo(prev.x, prev.y);
            g.lineTo(p.x, p.y);
            g.stroke();
          }
          prev = p;
        }
        g.restore();
      }

      function drawPost(g, pr, ph, active, ts) {
        const s = pr.s, size = Math.max(5, 0.95 * s), hgt = 2.1 * s;
        if (size < 4 || pr.y < 0) return;
        const P = PH[ph.kind];
        g.globalAlpha = 1 - pr.fog * 0.5;
        g.fillStyle = '#d5d7db';
        g.fillRect(pr.x - Math.max(1, 0.06 * s), pr.y - hgt, Math.max(1.5, 0.12 * s), hgt);
        const by = pr.y - hgt - size;
        if (active) {
          const pulse = 0.5 + 0.5 * Math.sin(ts / 120);
          g.shadowColor = P.color;
          g.shadowBlur = 10 + pulse * 14;
        }
        Sym.roundRect(g, pr.x - size / 2, by, size, size, size * 0.18);
        g.fillStyle = P.color;
        g.fill();
        g.shadowBlur = 0;
        if (size >= 9) Sym.text(g, P.short, pr.x, by + size / 2 + 0.5, { align: 'center', baseline: 'middle', size: Math.round(size * 0.62), weight: 900, color: '#101215', shadow: false });
        g.globalAlpha = 1;
      }

      function renderPOV(g, x, y, w, h, ts) {
        const q = st.q, rp = st.rp, L = rp.line, geo = q.geo;
        if (!q.R) q.R = new IST.TrackRenderer(geo, { theme: S.style, fov: S.fov });
        const R = q.R;
        const s = rp.s;
        const n = LL.sampleAt(L.n, L.sim, s);
        const dn = (LL.sampleAt(L.n, L.sim, s + 3) - LL.sampleAt(L.n, L.sim, Math.max(0, s - 3))) / 6;
        const cam = { pos: s, x: n * HW, heading: 0, yaw: Math.atan(dn * HW) };
        const gs = LL.posAtTime(rp.ghost.sim, rp.gt0 + (rp.t - rp.t0));
        const sprites = [];
        rp.line.ph.forEach((ph) => {
          if (ph.kind === 'end' || ph.s < s + 2) return;
          const c = geo.corners[ph.ci];
          const side = ph.kind === 'apex' ? c.dir : -c.dir;
          const active = rp.cur === ph && rp.hold > 0;
          sprites.push({ pos: ph.s, x: side * (HW + 1.6), draw: (g2, pr) => drawPost(g2, pr, ph, active, ts) });
        });
        if (gs > s + 4) {
          const gn = LL.sampleAt(rp.ghost.n, rp.ghost.sim, gs);
          const braking = LL.sampleAt(rp.ghost.sim.v, rp.ghost.sim, gs + 4) < LL.sampleAt(rp.ghost.sim.v, rp.ghost.sim, gs) - 0.3;
          sprites.push({ pos: gs, x: gn * HW, draw: (g2, pr) => IST.RaceLayer.drawCar(g2, Object.assign({}, pr, { fog: Math.max(pr.fog, 0.55) }), { color: lineColor(rp.ghost) }, braking) });
        }
        g.save();
        Sym.roundRect(g, x, y, w, h, 10);
        g.clip();
        g.translate(x, y);
        // road first, then the lines painted on it, then posts and the ghost car (far to near)
        R.prepare(w, h, cam);
        R.draw(g, []);
        if (!L.isIdeal) drawRibbon(g, R, q.ideal, s, COL.ideal, 0.45, 0.22);
        drawRibbon(g, R, L, s, lineColor(L), 0.85, 0.3);
        const maxDz = R.drawDist * LL.SEG, fogAmt = R.theme.fogAmt;
        sprites.sort((a, b) => b.pos - a.pos).forEach((sp) => {
          const pr = R.project(sp.pos, sp.x, 0);
          if (!pr) return;
          pr.fog = fogAmt * Math.pow(U.clamp((pr.dz / maxDz - 0.22) / 0.78, 0, 1), 1.5);
          sp.draw(g, pr, R);
        });
        // HUD
        const v = LL.sampleAt(L.sim.v, L.sim, s);
        Sym.text(g, kmh(v) + '', w / 2, h - 34, { align: 'center', size: Math.max(28, Math.min(44, h * 0.08)), weight: 900 });
        Sym.text(g, 'km/h', w / 2, h - 14, { align: 'center', size: 12, weight: 700, alpha: 0.75 });
        const dt = LL.timeAt(L.sim, s) - LL.timeAt(q.ideal.sim, s);
        if (!L.isIdeal) Sym.text(g, sec(dt) + ' vs ideal', w - 14, 26, { align: 'right', size: 18, weight: 900, color: dt > 0.005 ? COL.bad : COL.ideal });
        else {
          const gd = LL.timeAt(rp.ghost.sim, s) - LL.timeAt(L.sim, s);
          Sym.text(g, 'ghost ' + sec(gd), w - 14, 26, { align: 'right', size: 16, weight: 800, color: COL.pick });
        }
        Sym.text(g, L.name, 14, 26, { size: 16, weight: 900, color: lineColor(L) });
        if (!L.isIdeal) Sym.text(g, 'green car / line: ideal', 14, 46, { size: 12, color: COL.dim });
        else Sym.text(g, 'orange car: ' + rp.ghost.name, 14, 46, { size: 12, color: COL.dim });
        // phase banner while paused
        if (rp.cur && rp.hold > 0) {
          const P = PH[rp.cur.kind];
          const age = (performance.now() - rp.curAt) / 180;
          const sc = 1 + 0.25 * Math.max(0, 1 - age);
          const label = rp.cur.kind === 'end' ? P.label : T(rp.cur.ci) + ' · ' + P.label;
          Sym.text(g, label.toUpperCase(), w / 2, h * 0.2, { align: 'center', baseline: 'middle', size: Math.round(Math.max(20, Math.min(34, w * 0.04)) * sc), weight: 900, color: P.color });
        }
        g.restore();
        Sym.roundRect(g, x, y, w, h, 10);
        g.lineWidth = 1;
        g.strokeStyle = 'rgba(255,255,255,0.12)';
        g.stroke();
      }

      function renderTop(g, x, y, w, h, ts) {
        const q = st.q, rp = st.rp, L = rp.line, geo = q.geo;
        g.save();
        Sym.roundRect(g, x, y, w, h, 10);
        g.fillStyle = COL.panel;
        g.fill();
        g.clip();
        g.translate(x, y);
        const V = view(q, 'top', w, h, 26);
        LL.drawTrack(g, geo, V, { bg: COL.panel, fontSize: 12 });
        if (!L.isIdeal) LL.drawLine(g, geo, V, q.ideal.sim, { color: COL.ideal, width: 2.5, alpha: 0.7 });
        else LL.drawLine(g, geo, V, rp.ghost.sim, { color: COL.pick, width: 2, alpha: 0.45, dash: [6, 5] });
        LL.drawLine(g, geo, V, L.sim, { color: lineColor(L), width: 3.2 });
        // phase markers
        L.ph.forEach((ph) => {
          if (ph.kind === 'end' || ph.s < rp.s0) return;
          const p = LL.pointAt(geo, V, L.sim, ph.s), P = PH[ph.kind];
          const active = rp.cur === ph && rp.hold > 0, past = ph.s <= rp.s + 0.1;
          if (active) {
            Sym.ring(g, p[0], p[1], 11 + 3 * Math.sin(ts / 120), P.color, 2.5);
          }
          g.beginPath();
          g.arc(p[0], p[1], 7.5, 0, Math.PI * 2);
          g.fillStyle = P.color;
          g.globalAlpha = past || active ? 1 : 0.55;
          g.fill();
          g.globalAlpha = 1;
          Sym.text(g, P.short, p[0], p[1] + 0.5, { align: 'center', baseline: 'middle', size: 10, weight: 900, color: '#101215', shadow: false });
        });
        // cars: this line (filled), ghost (ring)
        const gs = LL.posAtTime(rp.ghost.sim, rp.gt0 + (rp.t - rp.t0));
        const gp = LL.pointAt(geo, V, rp.ghost.sim, Math.min(gs, geo.sEnd));
        Sym.ring(g, gp[0], gp[1], 5.5, lineColor(rp.ghost), 2.5);
        const cp = LL.pointAt(geo, V, L.sim, rp.s);
        g.beginPath();
        g.arc(cp[0], cp[1], 6, 0, Math.PI * 2);
        g.fillStyle = '#ffffff';
        g.fill();
        g.lineWidth = 2;
        g.strokeStyle = lineColor(L);
        g.stroke();
        g.restore();
        Sym.roundRect(g, x, y, w, h, 10);
        g.lineWidth = 1;
        g.strokeStyle = 'rgba(255,255,255,0.12)';
        g.stroke();
      }

      function renderTrace(g, x, y, w, h) {
        const q = st.q, rp = st.rp, L = rp.line, other = L.isIdeal ? rp.ghost : q.ideal;
        const s0 = rp.s0, s1 = q.geo.sEnd;
        const i0 = Math.round(s0 / LL.DS), i1 = q.geo.iEnd;
        let lo = Infinity, hi = -Infinity;
        for (const X of [L, other]) for (let i = i0; i <= i1; i++) {
          lo = Math.min(lo, X.sim.v[i]);
          hi = Math.max(hi, X.sim.v[i]);
        }
        lo = Math.floor((lo * 3.6 - 10) / 20) * 20;
        hi = Math.ceil((hi * 3.6 + 5) / 20) * 20;
        const px = (s) => x + 44 + ((s - s0) / (s1 - s0)) * (w - 56);
        const py = (v) => y + h - 18 - ((v * 3.6 - lo) / (hi - lo)) * (h - 30);
        g.save();
        Sym.roundRect(g, x, y, w, h, 10);
        g.fillStyle = COL.panel;
        g.fill();
        for (let v = lo; v <= hi; v += hi - lo > 160 ? 50 : 20) {
          const yy = py(v / 3.6);
          g.fillStyle = 'rgba(255,255,255,0.06)';
          g.fillRect(x + 44, yy, w - 56, 1);
          Sym.text(g, String(v), x + 38, yy + 4, { align: 'right', size: 10, color: COL.dim, shadow: false });
        }
        Sym.text(g, 'km/h', x + 38, y + h - 5, { align: 'right', size: 10, color: COL.dim, shadow: false });
        // phase ticks for this line
        L.ph.forEach((ph) => {
          if (ph.s < s0 || ph.kind === 'end') return;
          const P = PH[ph.kind], xx = px(ph.s);
          g.fillStyle = P.color;
          g.globalAlpha = 0.35;
          g.fillRect(xx, y + 10, 1, h - 28);
          g.globalAlpha = 1;
          Sym.text(g, P.short, xx, y + h - 5, { align: 'center', size: 10, weight: 900, color: P.color, shadow: false });
        });
        const trace = (X, color, width, alpha) => {
          g.beginPath();
          for (let i = i0; i <= i1; i += 2) {
            const xx = px(i * LL.DS), yy = py(X.sim.v[i]);
            if (i === i0) g.moveTo(xx, yy);
            else g.lineTo(xx, yy);
          }
          g.globalAlpha = alpha;
          g.strokeStyle = color;
          g.lineWidth = width;
          g.stroke();
          g.globalAlpha = 1;
        };
        trace(other, lineColor(other), 1.6, 0.6);
        trace(L, lineColor(L), 2.4, 1);
        const cx = px(rp.s);
        g.fillStyle = '#ffffff';
        g.fillRect(cx, y + 8, 1.5, h - 26);
        g.restore();
      }

      function captionFor(q, L, ph) {
        const I = q.ideal;
        if (!ph) return { title: L.name + (L.isIdeal ? '' : '  ' + sec(L.loss)), text: L.note, color: lineColor(L) };
        const P = PH[ph.kind];
        const vI = LL.sampleAt(I.sim.v, I.sim, ph.s), v = LL.sampleAt(L.sim.v, L.sim, ph.s);
        const dt = LL.timeAt(L.sim, ph.s) - LL.timeAt(I.sim, ph.s);
        let nums;
        if (ph.kind === 'apex') nums = 'Minimum ' + kmh(ph.vMin) + ' km/h' + (L.isIdeal ? '' : ' · ideal ' + kmh(I.corners[ph.ci].vMin));
        else nums = kmh(v) + ' km/h' + (L.isIdeal ? '' : ' · ideal ' + kmh(vI));
        if (!L.isIdeal) nums += ' · ' + sec(dt);
        let text;
        const flawHere = !L.isIdeal && ph.ci === L.ci && (LL.FLAWS[L.flaw].phase === ph.kind || (L.flaw === 'early' || L.flaw === 'late') && ph.kind === 'apex');
        if (ph.kind === 'end') text = L.isIdeal ? L.note : L.note + ' ' + sec(L.loss) + ' by the end of the straight.';
        else if (flawHere) text = L.note;
        else text = phaseNote(q, L, ph);
        return { title: (ph.kind === 'end' ? P.label : T(ph.ci) + ' · ' + P.label) + '   ' + nums, text, color: P.color };
      }

      function phaseNote(q, L, ph) {
        const geo = q.geo, c = geo.corners[ph.ci], d = c.dir;
        const n = LL.sampleAt(L.n, L.sim, ph.s);
        const fromOut = Math.max(0, (1 - -d * n) * HW - 1), fromIn = Math.max(0, (1 - d * n) * HW - 1);
        const edge = (m, side) => (m < 0.6 ? 'on the ' + side + ' edge' : m.toFixed(1) + ' m in from the ' + side + ' edge');
        if (ph.kind === 'brake') return 'Hard on the brakes, in a straight line before the turn-in.';
        if (ph.kind === 'turnin') return 'Steering starts ' + edge(fromOut, 'outside') + '.';
        if (ph.kind === 'apex') {
          const frac = (ph.s - c.startPos) / (c.endPos - c.startPos);
          const where = frac > 0.55 ? 'late' : frac < 0.45 ? 'early' : 'mid-corner';
          const sac = L.isIdeal ? sacrifices(q).find((x) => x.ci === ph.ci) : null;
          return 'Apex ' + edge(fromIn, 'inside') + ', ' + where + ' (' + Math.round(U.clamp(frac, 0, 1) * 100) + '% through the bend).' + (sac ? ' ' + T(ph.ci) + ' is sacrificed: ' + Math.round(sac.dv) + ' km/h slower than its own fastest line, to set up ' + T(ph.ci + 1) + '.' : '');
        }
        if (ph.kind === 'exit') return 'Track-out ' + edge(fromOut, 'outside') + ', back on full throttle.';
        return '';
      }

      function renderReplay(g, W, H, ts) {
        const q = st.q, rp = st.rp, L = rp.line;
        header(g, W, q.spec.name, null);
        const top = 64, hint = 40, capH = 62, gap = 10;
        const traceH = U.clamp(H * 0.17, 80, 150);
        const mainH = Math.max(140, H - top - hint - capH - traceH - gap * 3);
        const tdW = U.clamp(W * 0.36, 220, 560);
        renderTop(g, 16, top, tdW, mainH, ts);
        renderPOV(g, 16 + tdW + gap, top, W - 32 - tdW - gap, mainH, ts);
        // caption
        const cy = top + mainH + gap;
        const cap = captionFor(q, L, rp.hold > 0 || rp.done ? rp.cur : null);
        Sym.roundRect(g, 16, cy, W - 32, capH, 10);
        g.fillStyle = 'rgba(255,255,255,0.05)';
        g.fill();
        g.fillStyle = cap.color;
        g.fillRect(16, cy + 10, 3, capH - 20);
        Sym.text(g, cap.title, 30, cy + 22, { size: 15, weight: 850, color: cap.color });
        wrapText(g, cap.text, 30, cy + 43, W - 64, 13, 16, '#cfd5df', 2);
        renderTrace(g, 16, cy + capH + gap, W - 32, traceH);
        // controls
        const by = H - hint + 6;
        const k = replayLines().indexOf(rp.li);
        let bx = 16;
        bx += button(g, bx, by, '◀', () => cycle(-1)) + 6;
        g.font = '800 13px ' + Sym.FONT;
        const lbl = 'Line ' + (k + 1) + ' / ' + nOpts + (st.pick >= 0 && st.q.order[st.pick] === rp.li ? '  (your pick)' : '');
        Sym.text(g, lbl, bx + 4, by + 19, { size: 13, weight: 800, color: lineColor(L) });
        bx += g.measureText(lbl).width + 14;
        bx += button(g, bx, by, '▶', () => cycle(1)) + 14;
        button(g, bx, by, rp.done ? 'Replay ↓' : rp.hold > 0 ? 'Continue ↑' : 'Next phase ↑', () => (rp.done ? startReplay(rp.li) : skipPhase()));
        const last = rows.length >= S.questions;
        button(g, W - 16, by, last ? 'Finish  (Space)' : 'Next question  (Space)', advance, { primary: true, right: true });
      }

      function wrapText(g, text, x, y, maxW, size, lh, color, maxLines) {
        g.font = '500 ' + size + 'px ' + Sym.FONT;
        const words = (text || '').split(' ');
        let line = '', n = 0;
        for (let i = 0; i < words.length; i++) {
          const t = line ? line + ' ' + words[i] : words[i];
          if (g.measureText(t).width > maxW && line) {
            Sym.text(g, line, x, y + n * lh, { size, weight: 500, color, shadow: false });
            line = words[i];
            if (++n >= maxLines) return;
          } else line = t;
        }
        if (line) Sym.text(g, line, x, y + n * lh, { size, weight: 500, color, shadow: false });
      }

      return {
        debug: () => ({ st, rows, lure, byScen }),

        update(dt, clock) {
          pump();
          if (st.mode === 'loading' && st.next) startQuestion();
          if (st.mode === 'question' && timeLimit && clock - st.tMode > timeLimit * 1000) answer(-1);
          if (st.mode === 'reveal' && clock - st.tMode > REVEAL) {
            if (wantsReplay()) leaveReveal(true);
            else if (clock - st.tMode > REVEAL + 1600) leaveReveal(false);
          }
          if (st.mode === 'replay') updateReplay(dt);
        },

        onAction(a) {
          onAct(a);
        },
        onPause() {
          J.pause();
        },
        onResume() {
          J.resume();
        },
        destroy() {
          canvas.removeEventListener('pointermove', onMove);
          canvas.removeEventListener('pointerdown', onDown);
          canvas.style.cursor = '';
          J.destroy();
        },

        render(g, W, H, ts) {
          st.buttons = [];
          g.fillStyle = COL.bg;
          g.fillRect(0, 0, W, H);
          if (st.mode === 'loading' || !st.q) {
            header(g, W, 'Pick the Line', null);
            const dots = '.'.repeat(1 + (Math.floor(ts / 300) % 3));
            Sym.text(g, 'Working out the fastest line' + dots, W / 2, H / 2, { align: 'center', size: 18, weight: 600, color: '#cfd5df' });
            if (!rows.length) Sym.text(g, 'Pick the fastest line to the end of the straight. Arrows to choose, Space to lock in.', W / 2, H / 2 + 30, { align: 'center', size: 14, color: COL.dim });
          } else if (st.mode === 'replay') renderReplay(g, W, H, ts);
          else renderQuiz(g, W, H);
          J.render(g, W, H, { x: W - 54, y: 14, size: 24, side: -1, callY: H * 0.42, vignette: st.mode === 'reveal' });
        },

        result() {
          const n = rows.length;
          const half = rows.slice(Math.floor(n / 2));
          const ok = rows.filter((r) => r.correct);
          return {
            detail: { rows },
            summary: {
              level: half.length ? U.mean(half.map((r) => r.level)) : null,
              startLevel,
              nextLevel: st.level,
              accuracy: n ? ok.length / n : null,
              gap: ok.length ? U.median(ok.map((r) => r.gap)) : null,
              timeLost: n ? U.mean(rows.map((r) => (r.correct ? 0 : r.loss))) : null,
              decision: n ? U.median(rows.map((r) => r.dec)) : null,
              ...J.summary(),
              trials: n,
              lure,
              byScen,
            },
          };
        },
      };
    },
  });
})();
