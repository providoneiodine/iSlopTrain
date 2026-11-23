/*
 * Draw the Line: draw your racing line through a corner complex (Mind tab).
 *
 * Each question is a corner complex seen from above. You draw the line
 * you'd drive from the approach to the straight after it (several strokes
 * are fine: drawing over a part redraws it). Your drawing is read for what
 * you meant, not how steady your mouse is: hand jitter is smoothed out,
 * then the line is polished to the fastest one within a tolerance band
 * around what you drew (IST.LineLab.intentGen), so only where you put the
 * car - turn-in, apex, track-out, which corner gets priority - decides the
 * result.
 *
 * That line is run through the same lap-time model as the minimum-time
 * line (IST.LineLab: quasi-steady-state point mass, friction ellipse,
 * power limit, drag) and judged corner by corner: turn-in and apex too
 * early or late, road left unused at entry, apex or exit, carrying speed
 * through a corner the ideal compromises, and the time each corner cost.
 * The level sets how close to the ideal counts as a pass (2-down / 1-up).
 *
 * Afterwards a replay runs your line or the ideal from the driver's seat
 * (Apex Snap's renderer) next to the top-down view and a speed trace,
 * pausing at braking, turn-in, apex and track-out.
 *
 * Built on the generation effect (Slamecka & Graf, 1978) and retrieval
 * practice with corrective feedback (Roediger & Karpicke, 2006), comparing
 * your own line with the ideal (Schwartz & Bransford, 1998), and the
 * in-car view as perspective-matched imagery (Holmes & Collins, 2001).
 */
(function () {
  'use strict';
  const U = IST.util, Sym = IST.Symbols, LL = IST.LineLab;
  const MAX_LEVEL = LL.MAX_LEVEL, HW = LL.HW, DS = LL.DS;
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

  // ----------------------------------------------------------- definition
  IST.registerDrill({
    id: 'racing-line',
    name: 'Draw the Line',
    tab: 'mind',
    pointer: true, // drawn with the mouse: never hide the cursor
    category: 'Racecraft',
    usesView: true, // in-car pane: FOV, horizon and cockpit from IST.View
    tagline: 'Draw the fastest line through a corner complex.',
    description:
      'A corner complex from above: draw the line you would drive, from the approach to the straight. ' +
      'Your drawing is read for intent (mouse wobble is forgiven, where you put the car is not), run through a lap-time model and compared with the fastest line corner by corner: ' +
      'turn-in, apex, track-out and which corner gets priority, with the time each one cost. Then replay your line or the ideal from the driver\'s seat.',
    research: [
      { point: 'The corner before a long straight matters most: exit speed is carried all the way down it.', source: 'Lopez (2001), Going Faster! Mastering the Art of Race Driving. Bentley Publishers.' },
      { point: 'In a combination, compromise the earlier corner to set up the one that leads onto the straight.', source: 'Bentley (1998), Speed Secrets. Motorbooks International.' },
      { point: 'Quasi-steady-state lap simulation shows how the racing line changes lap time.', source: 'Brayshaw & Harrison (2005), Proc. IMechE Part D 219(6).' },
      { point: 'Minimum-time lines balance a short path against low curvature; they can be found numerically.', source: 'Kapania, Subosits & Gerdes (2016), J. Dyn. Sys., Meas., Control 138(9).' },
      { point: 'Producing an answer yourself is remembered better than reading or recognising it.', source: 'Slamecka & Graf (1978), J. Exp. Psychol.: Human Learning and Memory 4(6).' },
      { point: 'Being tested on material beats re-studying it for long-term retention.', source: 'Roediger & Karpicke (2006), Psychological Science 17(3).' },
      { point: 'Comparing contrasting cases side by side helps learners see the features that matter.', source: 'Schwartz & Bransford (1998), Cognition and Instruction 16(4).' },
      { point: 'Imagery works best from the performer\'s own viewpoint and in real time (PETTLEP).', source: 'Holmes & Collins (2001), J. Appl. Sport Psychol. 13(1).' },
      { point: 'Adaptive difficulty holds you at a challenge point (~71 % passed).', source: 'Levitt (1971); Guadagnoli & Lee (2004), J. Motor Behavior 36(2).' },
    ],
    settings: [
      { key: 'questions', label: 'Corners', type: 'number', default: 8, min: 3, max: 30, step: 1 },
      { key: 'level', label: 'Level', type: 'select', default: 'auto', options: [['auto', 'Auto (adapts)']].concat([1, 2, 3, 4, 5, 6].map((n) => [String(n), String(n) + ' (pass ≤ ' + PASS[n].toFixed(2) + ' s)'])), hint: 'Higher levels need a line closer to the ideal to pass.' },
      { key: 'tolerance', label: 'Drawing tolerance', type: 'select', default: '1', options: [['1.5', 'Loose (1.5 m)'], ['1', 'Normal (1 m)'], ['0.5', 'Strict (0.5 m)']], hint: 'How far from your drawing the line may move to find what you meant.' },
      { key: 'style', label: 'Replay style', type: 'select', default: 'realistic', options: [['realistic', 'Realistic'], ['minimal', 'Minimal']] },
      { key: 'cockpit', label: 'Cockpit', type: 'bool', default: true, hint: 'Draw the cockpit over the in-car replay. Set it up on the View screen.' },
    ],
    metrics: [
      { key: 'level', label: 'Line level', digits: 1, better: 'higher', primary: true, hint: 'Average level over the second half of the session. Higher levels need a line closer to the ideal to pass.' },
      { key: 'accuracy', label: 'Lines passed', pct: true, digits: 0, better: 'higher' },
      { key: 'placement', label: 'Corners placed right', pct: true, digits: 0, better: 'higher', hint: 'Corners with turn-in, apex and track-out all where the ideal puts them.' },
      { key: 'timeLost', label: 'Time lost per line', unit: 's', digits: 2, better: 'lower', hint: 'Average time your line loses to the ideal by the end of the straight.' },
      { key: 'decision', label: 'Drawing time', unit: 's', digits: 1, better: 'lower' },
      ...IST.Juice.METRICS,
      { key: 'trials', label: 'Lines', digits: 0 },
    ],

    levelFor(S, history) {
      if (S.level && S.level !== 'auto') return U.clamp(Number(S.level) || 1, 1, MAX_LEVEL);
      for (let i = history.length - 1; i >= 0; i--) {
        const r = history[i], s = r.summary;
        if (s && s.mode === 'draw' && U.isNum(s.nextLevel)) return s.nextLevel;
      }
      return 1;
    },

    coach(s, result) {
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
    },

    analyze(results, A) {
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
    },

    create(ctx) {
      const S = ctx.settings, def = this;
      const VIEW = IST.View.get(), SEAT = IST.View.seat(VIEW), CP = S.cockpit !== false ? IST.View.cockpit(VIEW, S.style) : null;
      const rnd = U.rng(U.randomSeed());
      const auto = !S.level || S.level === 'auto';
      const startLevel = def.levelFor(S, ctx.history);
      const tol = Number(S.tolerance);
      const tolM = isNaN(tol) ? 1 : U.clamp(tol, 0.3, 2);
      const J = new IST.Juice({ history: ctx.history });
      const canvas = document.getElementById('stage');
      const prevTouch = canvas.style.touchAction;
      canvas.style.touchAction = 'none';

      const st = {
        mode: 'loading', level: startLevel, streak: 0, q: null, next: null, gen: null, fit: null,
        strokes: [], cur: null, raw: null, preview: null, cov: null, area: null,
        tMode: 0, rp: null, buttons: [], recent: [], done: false,
      };
      const rows = [];
      const errs = {}, byScen = {};

      function queue() {
        st.next = null;
        st.gen = questionGen(rnd, st.recent);
      }
      function pump() {
        const t0 = performance.now();
        while (performance.now() - t0 < BUDGET) {
          // reading your line comes first; the next question builds in the background
          if (st.fit) {
            const r = st.fit.next();
            if (r.done) {
              st.fit = null;
              grade(r.value);
            }
            continue;
          }
          if (!st.gen) return;
          const r = st.gen.next();
          if (r.done) {
            st.gen = null;
            st.next = r.value;
            return;
          }
        }
      }
      queue();

      function startQuestion() {
        st.q = st.next;
        st.next = null;
        st.q.level = st.level;
        st.mode = 'draw';
        st.tMode = ctx.clock();
        st.strokes = [];
        st.cur = null;
        st.preview = null;
        st.rp = null;
        st.raw = new Float64Array(st.q.geo.N + 1).fill(NaN);
        st.cov = coverage();
        st.recent.push(st.q.spec.id);
        if (st.recent.length > 3) st.recent.shift();
        if (rows.length + 1 < S.questions) queue();
      }

      // ------------------------------------------------------- drawing input
      function toTrack(x, y, hint, range) {
        const A = st.area, V = A.V;
        const w = V.unmap(x - A.x, y - A.y);
        if (hint == null) {
          hint = Math.round((V.i0 + V.i1) / 2);
          range = Math.ceil((V.i1 - V.i0) / 2);
        }
        return LL.project(st.q.geo, w[0], w[1], hint, range);
      }
      function writeSeg(p, q) {
        const raw = st.raw, V = st.area.V;
        const ia = Math.round(p.s / DS), ib = Math.round(q.s / DS);
        const lo = Math.max(V.i0, Math.min(ia, ib)), hi = Math.min(V.i1, Math.max(ia, ib));
        for (let i = lo; i <= hi; i++) raw[i] = ia === ib ? q.n : p.n + ((q.n - p.n) * (i - ia)) / (ib - ia);
      }
      function rebuild() {
        st.raw.fill(NaN);
        st.strokes.forEach((sk) => {
          if (sk.length === 1) writeSeg(sk[0], sk[0]);
          for (let k = 1; k < sk.length; k++) writeSeg(sk[k - 1], sk[k]);
        });
        refit();
      }
      function refit() {
        st.cov = coverage();
        const f = LL.fitDrawn(st.q.geo, st.raw);
        st.preview = f ? f.n : null;
      }
      /** Is the drawing complete enough to judge? */
      function coverage() {
        const q = st.q, raw = st.raw, win = LL.windowOf(q.geo);
        const V = { i0: Math.round(win.sA / DS), i1: Math.round(win.sB / DS) };
        const a = Math.round(q.sStart / DS), b = Math.round(q.sStop / DS);
        let first = -1, last = -1, prev = -1, maxGap = 0, off = 0;
        for (let i = V.i0; i <= V.i1; i++) {
          if (isNaN(raw[i])) continue;
          if (first < 0) first = i;
          last = i;
          if (prev >= 0 && i >= a && prev <= b) maxGap = Math.max(maxGap, i - prev);
          prev = i;
          if (Math.abs(raw[i]) > OFF) off++;
        }
        const r = { ok: false, off: off * DS };
        if (first < 0) r.msg = 'Draw your line from the arrow to the straight';
        else if (first > a) r.msg = 'Start your line further back, on the approach';
        else if (last < b) r.msg = 'Carry your line on onto the straight';
        else if (maxGap * DS > 30) r.msg = 'Fill the gap in your line';
        else r.ok = true;
        return r;
      }
      function undo() {
        if (st.mode !== 'draw' || !st.strokes.length) return;
        st.strokes.pop();
        rebuild();
      }
      function clearAll() {
        if (st.mode !== 'draw') return;
        st.strokes = [];
        rebuild();
      }

      // ------------------------------------------------------------ grading
      function submit() {
        if (st.mode !== 'draw' || !st.cov || !st.cov.ok) return;
        const q = st.q, f = LL.fitDrawn(q.geo, st.raw);
        q.dec = (ctx.clock() - st.tMode) / 1000;
        q.drawn = Float64Array.from(st.raw);
        q.asDrawn = f.n;
        q.offTrack = st.cov.off;
        q.rot = st.area.V.rot;
        st.mode = 'grading';
        st.tMode = ctx.clock();
        st.fit = (function* () {
          const c = yield* LL.intentGen(q.geo, f.ctrl, tolM);
          // found a faster line than the ideal? polish it fully and make that the ideal
          if (LL.simulate(q.geo, LL.ctrlToN(q.geo, c)) < q.ideal.time - 0.015) {
            const c2 = Float64Array.from(c);
            yield* LL.optimizeGen(q.geo, c2, 1, LL.knots(q.geo).M, { step: 0.04 });
            const I = LL.lineFrom(q.geo, LL.ctrlToN(q.geo, c2), null, { isIdeal: true, ctrl: c2 });
            I.loss = I.dev = 0;
            I.prio = q.ideal.prio;
            I.name = q.ideal.name;
            q.ideal = I;
            I.note = describeIdeal(q);
          }
          return c;
        })();
      }

      function grade(ctrl) {
        const q = st.q, I = q.ideal;
        const L = LL.lineFrom(q.geo, LL.ctrlToN(q.geo, ctrl), I, { isUser: true, ctrl });
        L.name = 'Your line';
        L.loss = Math.max(0, L.loss); // matched (or nudged past) the ideal
        L.verdict = LL.judge(q.geo, I, L);
        L.note = describeUser(q, L);
        q.user = L;
        q.lines = [L, I];
        const pass = L.loss <= PASS[q.level];
        q.grade = L.loss <= 0.02 ? 'Spot on' : pass ? 'On the line' : L.loss <= PASS[q.level] * 2.5 ? 'Close' : 'Off the line';
        q.pass = pass;
        // tallies: each mistake counted once per corner where it was possible
        const made = {};
        L.verdict.forEach((r, ci) => {
          const possible = ['early', 'late', 'apex'];
          if (r.entry != null) possible.push('entry');
          if (r.exit != null) possible.push('exit');
          if (ci < L.verdict.length - 1) possible.push('priority');
          possible.forEach((k) => {
            const e = (errs[k] = errs[k] || [0, 0]);
            e[0]++;
            if (r.issues.some((is) => is.kind === k)) {
              e[1]++;
              made[k] = (made[k] || 0) + 1;
            }
          });
        });
        const sc = (byScen[q.spec.id] = byScen[q.spec.id] || [0, 0]);
        sc[0]++;
        if (pass) sc[1]++;
        rows.push({
          scen: q.spec.id, mirror: q.geo.mirror ? 1 : 0, level: q.level, pass: pass ? 1 : 0, loss: +L.loss.toFixed(3), tol: tolM,
          corners: L.verdict.length, placed: L.verdict.filter((r) => !r.issues.length).length, errs: made,
          cost: L.verdict.map((r) => +r.cost.toFixed(3)), off: Math.round(q.offTrack), dec: +q.dec.toFixed(2),
        });
        if (pass) {
          const spot = L.loss <= 0.02;
          J.hit({ base: 10, bonus: q.level * 4 + (spot ? 8 : 0), label: spot ? 'SPOT ON' : 'ON THE LINE', color: COL.ideal });
        } else J.miss({ label: sec(L.loss) });
        if (auto) {
          if (pass && ++st.streak >= 2) {
            st.level = Math.min(MAX_LEVEL, st.level + 1);
            st.streak = 0;
          } else if (!pass) {
            st.level = Math.max(1, st.level - 1);
            st.streak = 0;
          }
        }
        st.mode = 'result';
        st.tMode = ctx.clock();
      }

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
        const q = st.q, L = q.lines[li], ghost = q.lines[1 - li];
        const brake = L.ph.find((p) => p.kind === 'brake');
        const s0 = Math.max(0, Math.min(q.geo.corners[0].startPos - 150, brake ? brake.s - 70 : Infinity));
        st.mode = 'replay';
        st.rp = {
          li, line: L, ghost, s0, s: s0, t: LL.timeAt(L.sim, s0), t0: LL.timeAt(L.sim, s0), gt0: LL.timeAt(ghost.sim, s0),
          phases: L.ph.filter((p) => p.s > s0 + 1), pi: 0, hold: 600, cur: null, curAt: 0, done: false,
        };
      }
      function cycle() {
        startReplay(1 - st.rp.li);
      }
      function skipPhase() {
        const rp = st.rp;
        if (rp.done) return;
        if (rp.hold > 0 && rp.cur) {
          rp.hold = 0;
          return;
        }
        const ph = rp.phases[rp.pi];
        if (ph) rp.t = LL.timeAt(rp.line.sim, Math.max(rp.s, ph.s - 0.5));
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
      function onAct(a) {
        if (st.mode === 'draw') {
          if (a === 'confirm') submit();
          else if (a === 'down') undo();
        } else if (st.mode === 'result') {
          if (a === 'confirm') advance();
          else if (a === 'up') startReplay(0);
        } else if (st.mode === 'replay') {
          if (a === 'left' || a === 'right') cycle();
          else if (a === 'up') skipPhase();
          else if (a === 'down') startReplay(st.rp.li);
          else if (a === 'confirm') advance();
        }
      }

      const ptr = (e) => [e.offsetX, e.offsetY];
      const hit = (x, y) => st.buttons.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
      const inArea = (x, y) => st.area && x >= st.area.x && x <= st.area.x + st.area.w && y >= st.area.y && y <= st.area.y + st.area.h;
      function onMove(e) {
        const [x, y] = ptr(e);
        if (st.cur) {
          e.preventDefault();
          const last = st.cur[st.cur.length - 1];
          const p = toTrack(x, y, last.i, 12);
          if (Math.abs(p.n) < 3 && Math.abs(p.s - last.s) < 40) {
            st.cur.push(p);
            writeSeg(last, p);
          }
          return;
        }
        const b = hit(x, y);
        canvas.style.cursor = b ? 'pointer' : st.mode === 'draw' && inArea(x, y) ? 'crosshair' : '';
      }
      function onDown(e) {
        const [x, y] = ptr(e);
        const b = hit(x, y);
        if (b) {
          e.preventDefault();
          if (b.act) b.act();
          return;
        }
        if (st.mode !== 'draw' || !inArea(x, y)) return;
        const p = toTrack(x, y);
        if (Math.abs(p.n) > 2.5) return;
        e.preventDefault();
        st.cur = [p];
        st.strokes.push(st.cur);
        writeSeg(p, p);
        st.preview = null;
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch (err) {
          /* not supported */
        }
      }
      function onUp() {
        if (!st.cur) return;
        st.cur = null;
        refit();
      }
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointerup', onUp);
      canvas.addEventListener('pointercancel', onUp);

      // ------------------------------------------------------------ drawing
      /** The drawing view turns the complex to run up the screen; later views keep that orientation. */
      function view(q, key, w, h, pad) {
        const k = key + ':' + Math.round(w) + 'x' + Math.round(h);
        const o = key === 'draw' ? { upright: q.sStart } : q.rot != null ? { rot: q.rot } : null;
        return q.views[k] || (q.views[k] = LL.fitView(q.geo, w, h, pad, null, o));
      }

      /** Stroke a lateral profile n (NaN = gap); keep(i) picks samples. */
      function drawN(g, V, n, o) {
        const geo = st.q.geo;
        g.save();
        g.lineJoin = 'round';
        g.lineCap = 'round';
        g.strokeStyle = o.color;
        g.lineWidth = o.width;
        g.globalAlpha = o.alpha == null ? 1 : o.alpha;
        if (o.dash) g.setLineDash(o.dash);
        g.beginPath();
        let pen = false;
        for (let i = V.i0; i <= V.i1; i++) {
          const v = n[i];
          if (isNaN(v) || (o.keep && !o.keep(v, i))) {
            pen = false;
            continue;
          }
          const p = V.map(geo.cx[i] + v * HW * geo.nx[i], geo.cy[i] + v * HW * geo.ny[i]);
          if (!pen) {
            g.moveTo(p[0], p[1]);
            pen = true;
          } else g.lineTo(p[0], p[1]);
        }
        g.stroke();
        g.restore();
      }

      /** A dashed bar across the road at s, with a small label. */
      function gate(g, V, s, label) {
        const geo = st.q.geo, i = Math.round(s / DS);
        const a = V.map(geo.cx[i] - 1.15 * HW * geo.nx[i], geo.cy[i] - 1.15 * HW * geo.ny[i]);
        const b = V.map(geo.cx[i] + 1.15 * HW * geo.nx[i], geo.cy[i] + 1.15 * HW * geo.ny[i]);
        g.save();
        g.setLineDash([4, 4]);
        g.strokeStyle = 'rgba(255,255,255,0.55)';
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(a[0], a[1]);
        g.lineTo(b[0], b[1]);
        g.stroke();
        g.restore();
        const ox = b[0] + (b[0] - a[0]) * 0.18, oy = b[1] + (b[1] - a[1]) * 0.18;
        Sym.text(g, label, U.clamp(ox, 24, V.w - 24), U.clamp(oy, 10, V.h - 6), { align: 'center', baseline: 'middle', size: 11, weight: 700, color: COL.dim, shadow: false });
      }

      function header(g, W, title, sub, subColor) {
        const q = st.q;
        const shown = Math.min(S.questions, rows.length + (st.mode === 'draw' || st.mode === 'grading' ? 1 : 0));
        Sym.text(g, 'Line ' + Math.max(1, shown) + ' / ' + S.questions, 18, 28, { size: 16, weight: 800, alpha: 0.85 });
        const lv = q && q.level ? q.level : st.level;
        Sym.text(g, 'Level ' + lv + ' · pass ≤ ' + PASS[lv].toFixed(2) + ' s', 18, 48, { size: 13, weight: 600, color: COL.dim });
        if (title) Sym.text(g, title, W / 2, 28, { align: 'center', size: Math.max(17, Math.min(24, W * 0.018)), weight: 850 });
        if (sub) Sym.text(g, sub, W / 2, 50, { align: 'center', size: 13, weight: subColor ? 800 : 400, color: subColor || '#b9c1ce' });
      }

      function button(g, x, y, label, act, o) {
        o = o || {};
        g.font = '800 13px ' + Sym.FONT;
        const w = Math.max(o.min || 0, g.measureText(label).width + 22), h = 28;
        const bx = x - (o.right ? w : 0);
        Sym.roundRect(g, bx, y, w, h, 7);
        g.fillStyle = o.primary ? (o.disabled ? 'rgba(246,217,143,0.25)' : COL.quiz) : 'rgba(255,255,255,0.1)';
        g.fill();
        Sym.text(g, label, bx + w / 2, y + h / 2 + 0.5, { align: 'center', baseline: 'middle', size: 13, weight: 800, color: o.primary ? '#141a16' : COL.text, shadow: false });
        if (!o.disabled) st.buttons.push({ x: bx, y, w, h, act });
        return w;
      }

      function panel(g, x, y, w, h, fill) {
        Sym.roundRect(g, x, y, w, h, 10);
        g.fillStyle = fill || COL.panel;
        g.fill();
      }
      function outline(g, x, y, w, h, color) {
        Sym.roundRect(g, x, y, w, h, 10);
        g.lineWidth = 1;
        g.strokeStyle = color || 'rgba(255,255,255,0.12)';
        g.stroke();
      }

      function renderDraw(g, W, H, ts) {
        const q = st.q, grading = st.mode === 'grading';
        header(g, W, q.spec.name, 'Draw the fastest line to the end of the straight');
        const top = 64, bot = 46;
        const A = { x: 16, y: top, w: W - 32, h: H - top - bot };
        A.V = view(q, 'draw', A.w, A.h, 30);
        st.area = A;
        g.save();
        panel(g, A.x, A.y, A.w, A.h);
        g.clip();
        g.translate(A.x, A.y);
        LL.drawTrack(g, q.geo, A.V, { bg: COL.panel, fontSize: 13 });
        gate(g, A.V, q.sStart, 'start');
        gate(g, A.V, q.sStop, 'finish');
        // your strokes as drawn (red where off the road), then what they'll be read as
        drawN(g, A.V, st.raw, { color: COL.ink, width: 2, alpha: st.preview ? 0.4 : 0.85 });
        drawN(g, A.V, st.raw, { color: COL.bad, width: 2.5, alpha: 0.9, keep: (v) => Math.abs(v) > OFF });
        if (st.preview && !st.cur) {
          // only over the stretch you've drawn
          let a = -1, b = -1;
          for (let i = A.V.i0; i <= A.V.i1; i++) {
            if (isNaN(st.raw[i])) continue;
            if (a < 0) a = i;
            b = i;
          }
          drawN(g, A.V, st.preview, { color: COL.quiz, width: 3.2, keep: (v, i) => i >= a && i <= b });
        }
        g.restore();
        outline(g, A.x, A.y, A.w, A.h, st.cur ? 'rgba(246,217,143,0.45)' : null);
        if (grading) {
          g.fillStyle = 'rgba(12,16,14,0.55)';
          g.fillRect(A.x, A.y, A.w, A.h);
          const dots = '.'.repeat(1 + (Math.floor(ts / 300) % 3));
          Sym.text(g, 'Reading your line' + dots, W / 2, A.y + A.h / 2, { align: 'center', baseline: 'middle', size: 20, weight: 800 });
          return;
        }
        // controls
        const by = H - bot + 10;
        let bx = 16;
        bx += button(g, bx, by, 'Undo  ↓', undo) + 8;
        bx += button(g, bx, by, 'Clear', clearAll) + 14;
        const cov = st.cov;
        Sym.text(g, cov.ok ? (cov.off > 8 ? 'Parts of it leave the road: the car will be kept on the edge there.' : 'Draw over any part to redo it.') : cov.msg, bx, by + 19, { size: 13, weight: 600, color: cov.ok && cov.off <= 8 ? COL.dim : COL.quiz });
        button(g, W - 16, by, 'Submit  (Space)', submit, { primary: true, right: true, disabled: !cov.ok });
      }

      function phaseDots(g, V, L, o) {
        const geo = st.q.geo;
        L.ph.forEach((ph) => {
          if (ph.kind === 'end' || ph.kind === 'brake' || ph.s < V.win.sA) return;
          const p = LL.pointAt(geo, V, L.sim, ph.s), P = PH[ph.kind];
          if (o.hollow) {
            Sym.ring(g, p[0], p[1], 5, P.color, 2);
            return;
          }
          g.beginPath();
          g.arc(p[0], p[1], 7, 0, Math.PI * 2);
          g.fillStyle = P.color;
          g.fill();
          Sym.text(g, P.short, p[0], p[1] + 0.5, { align: 'center', baseline: 'middle', size: 9, weight: 900, color: '#101215', shadow: false });
        });
      }

      function renderResult(g, W, H) {
        const q = st.q, L = q.user, I = q.ideal;
        const pass = q.pass;
        header(g, W, q.spec.name, q.grade + '  ·  ' + sec(L.loss) + ' to the ideal', pass ? COL.ideal : L.loss <= PASS[q.level] * 2.5 ? COL.quiz : COL.bad);
        const top = 64, bot = 46, gap = 12;
        const wide = W / H >= 1.15;
        const listH = wide ? H - top - bot : U.clamp(64 + L.verdict.length * 40, 150, H * 0.42);
        const mapW = wide ? Math.max(260, (W - 32 - gap) * 0.6) : W - 32;
        const mapH = wide ? H - top - bot : H - top - bot - listH - gap;
        // map: ideal, your drawing, your line
        g.save();
        panel(g, 16, top, mapW, mapH);
        g.clip();
        g.translate(16, top);
        const V = view(q, 'res', mapW, mapH, 28);
        LL.drawTrack(g, q.geo, V, { bg: COL.panel, fontSize: 12 });
        LL.drawLine(g, q.geo, V, I.sim, { color: COL.ideal, width: 3, alpha: 0.85 });
        drawN(g, V, q.drawn, { color: COL.ink, width: 1.5, alpha: 0.35 });
        LL.drawLine(g, q.geo, V, L.sim, { color: COL.pick, width: 3, from: V.win.sA + 28, to: V.win.sB - 28 });
        phaseDots(g, V, I, { hollow: true });
        phaseDots(g, V, L, {});
        g.restore();
        outline(g, 16, top, mapW, mapH);
        Sym.text(g, 'green: ideal   orange: your line   faint: as drawn', 28, top + mapH - 12, { size: 11, color: COL.dim });
        // verdict list
        const lx = wide ? 16 + mapW + gap : 16, ly = wide ? top : top + mapH + gap, lw = wide ? W - 32 - mapW - gap : W - 32;
        panel(g, lx, ly, lw, listH, 'rgba(255,255,255,0.04)');
        let y = ly + 26;
        const tx = lx + 16, tw = lw - 32;
        L.verdict.forEach((r) => {
          const ok = !r.issues.length;
          const color = ok ? COL.ideal : r.cost > 0.04 ? COL.bad : COL.quiz;
          Sym.text(g, T(r.ci), tx, y, { size: 15, weight: 900, color });
          Sym.text(g, sec(r.cost), tx + tw, y, { align: 'right', size: 13, weight: 800, color: r.cost > 0.02 ? COL.bad : COL.dim });
          y += wrapText(g, cornerText(r), tx + 34, y, tw - 100, 13, 17, '#cfd5df', 3) * 17 + 12;
        });
        y += 4;
        g.fillStyle = 'rgba(255,255,255,0.08)';
        g.fillRect(tx, y - 12, tw, 1);
        y += wrapText(g, L.note, tx, y + 4, tw, 13, 17, COL.text, wide ? 6 : 3) * 17 + 8;
        if (q.offTrack > 8) wrapText(g, 'Parts of your drawing left the road; the car was kept on the edge there.', tx, y + 4, tw, 12, 16, COL.dim, 2);
        // controls
        const by = H - bot + 10;
        button(g, 16, by, 'Watch replay  ↑', () => startReplay(0));
        const last = rows.length >= S.questions;
        button(g, W - 16, by, last ? 'Finish  (Space)' : 'Next line  (Space)', advance, { primary: true, right: true });
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
        if (!q.R) q.R = new IST.TrackRenderer(geo, { theme: S.style });
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
        IST.View.apply(R, w, h, VIEW);
        R.prepare(w, h, cam);
        R.draw(g, []);
        drawRibbon(g, R, rp.ghost, s, lineColor(rp.ghost), 0.45, 0.22);
        drawRibbon(g, R, L, s, lineColor(L), 0.85, 0.3);
        const maxDz = R.drawDist * LL.SEG, fogAmt = R.theme.fogAmt;
        sprites.sort((a, b) => b.pos - a.pos).forEach((sp) => {
          const pr = R.project(sp.pos, sp.x, 0);
          if (!pr) return;
          pr.fog = fogAmt * Math.pow(U.clamp((pr.dz / maxDz - 0.22) / 0.78, 0, 1), 1.5);
          sp.draw(g, pr, R);
        });
        const v = LL.sampleAt(L.sim.v, L.sim, s);
        if (CP) {
          CP.frameFor(R, SEAT);
          CP.draw(g, IST.Cockpit.steerFrom((p) => LL.sampleAt(L.n, L.sim, p) * HW, IST.Cockpit.segCurv(geo), s), IST.Cockpit.dash(v));
        }
        // HUD (over the cockpit)
        Sym.text(g, kmh(v) + '', w / 2, h - 34, { align: 'center', size: Math.max(28, Math.min(44, h * 0.08)), weight: 900 });
        Sym.text(g, 'km/h', w / 2, h - 14, { align: 'center', size: 12, weight: 700, alpha: 0.75 });
        const dt = LL.timeAt(q.user.sim, s) - LL.timeAt(q.ideal.sim, s);
        Sym.text(g, 'you ' + sec(dt) + ' vs ideal', w - 14, 26, { align: 'right', size: 18, weight: 900, color: dt > 0.005 ? COL.bad : COL.ideal });
        Sym.text(g, L.name, 14, 26, { size: 16, weight: 900, color: lineColor(L) });
        Sym.text(g, (L.isIdeal ? 'orange car / line: yours' : 'green car / line: ideal'), 14, 46, { size: 12, color: COL.dim });
        // phase banner while paused
        if (rp.cur && rp.hold > 0) {
          const P = PH[rp.cur.kind];
          const age = (performance.now() - rp.curAt) / 180;
          const sc = 1 + 0.25 * Math.max(0, 1 - age);
          const label = rp.cur.kind === 'end' ? P.label : T(rp.cur.ci) + ' · ' + P.label;
          Sym.text(g, label.toUpperCase(), w / 2, h * 0.2, { align: 'center', baseline: 'middle', size: Math.round(Math.max(20, Math.min(34, w * 0.04)) * sc), weight: 900, color: P.color });
        }
        g.restore();
        outline(g, x, y, w, h);
      }

      function renderTop(g, x, y, w, h, ts) {
        const q = st.q, rp = st.rp, L = rp.line, geo = q.geo;
        g.save();
        panel(g, x, y, w, h);
        g.clip();
        g.translate(x, y);
        const V = view(q, 'top', w, h, 26);
        LL.drawTrack(g, geo, V, { bg: COL.panel, fontSize: 12 });
        LL.drawLine(g, geo, V, rp.ghost.sim, { color: lineColor(rp.ghost), width: 2.2, alpha: 0.6, dash: L.isIdeal ? [6, 5] : null });
        LL.drawLine(g, geo, V, L.sim, { color: lineColor(L), width: 3.2 });
        // phase markers
        L.ph.forEach((ph) => {
          if (ph.kind === 'end' || ph.s < rp.s0) return;
          const p = LL.pointAt(geo, V, L.sim, ph.s), P = PH[ph.kind];
          const active = rp.cur === ph && rp.hold > 0, past = ph.s <= rp.s + 0.1;
          if (active) Sym.ring(g, p[0], p[1], 11 + 3 * Math.sin(ts / 120), P.color, 2.5);
          g.beginPath();
          g.arc(p[0], p[1], 7.5, 0, Math.PI * 2);
          g.fillStyle = P.color;
          g.globalAlpha = past || active ? 1 : 0.55;
          g.fill();
          g.globalAlpha = 1;
          Sym.text(g, P.short, p[0], p[1] + 0.5, { align: 'center', baseline: 'middle', size: 10, weight: 900, color: '#101215', shadow: false });
        });
        // cars: this line (filled), the other (ring)
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
        outline(g, x, y, w, h);
      }

      function renderTrace(g, x, y, w, h) {
        const q = st.q, rp = st.rp, L = rp.line, other = rp.ghost;
        const s0 = rp.s0, s1 = q.geo.sEnd;
        const i0 = Math.round(s0 / DS), i1 = q.geo.iEnd;
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
        panel(g, x, y, w, h);
        for (let v = lo; v <= hi; v += hi - lo > 160 ? 50 : 20) {
          const yy = py(v / 3.6);
          g.fillStyle = 'rgba(255,255,255,0.06)';
          g.fillRect(x + 44, yy, w - 56, 1);
          Sym.text(g, String(v), x + 38, yy + 4, { align: 'right', size: 10, color: COL.dim, shadow: false });
        }
        Sym.text(g, 'km/h', x + 38, y + h - 5, { align: 'right', size: 10, color: COL.dim, shadow: false });
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
            const xx = px(i * DS), yy = py(X.sim.v[i]);
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
        const dt = LL.timeAt(q.user.sim, ph.s) - LL.timeAt(I.sim, ph.s);
        let nums;
        if (ph.kind === 'apex') nums = 'Minimum ' + kmh(ph.vMin) + ' km/h' + (L.isIdeal ? ' · yours ' + kmh(q.user.corners[ph.ci].vMin) : ' · ideal ' + kmh(I.corners[ph.ci].vMin));
        else nums = kmh(v) + ' km/h' + (L.isIdeal ? '' : ' · ideal ' + kmh(vI));
        nums += ' · you ' + sec(dt);
        let text;
        const r = !L.isIdeal && ph.ci >= 0 ? L.verdict[ph.ci] : null;
        const here = r ? r.issues.filter((is) => is.phase === ph.kind || (ph.kind === 'apex' && (is.kind === 'early' || is.kind === 'late'))) : [];
        if (ph.kind === 'end') text = L.note;
        else if (here.length) text = here.map((is) => issueText(r, is)).join(' · ') + '. ' + ADVICE[here[0].kind];
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
        let bx = 16;
        bx += button(g, bx, by, L.isIdeal ? '◀ ▶  Your line' : '◀ ▶  Ideal line', cycle) + 8;
        bx += button(g, bx, by, rp.done ? 'Replay ↓' : rp.hold > 0 ? 'Continue ↑' : 'Next phase ↑', () => (rp.done ? startReplay(rp.li) : skipPhase())) + 8;
        button(g, bx, by, 'Back to result', () => {
          st.mode = 'result';
          st.rp = null;
        });
        const last = rows.length >= S.questions;
        button(g, W - 16, by, last ? 'Finish  (Space)' : 'Next line  (Space)', advance, { primary: true, right: true });
      }

      /** Word-wrapped text; returns the number of lines drawn. */
      function wrapText(g, text, x, y, maxW, size, lh, color, maxLines) {
        g.font = '500 ' + size + 'px ' + Sym.FONT;
        const words = (text || '').split(' ');
        let line = '', n = 0;
        for (let i = 0; i < words.length; i++) {
          const t = line ? line + ' ' + words[i] : words[i];
          if (g.measureText(t).width > maxW && line) {
            Sym.text(g, line, x, y + n * lh, { size, weight: 500, color, shadow: false });
            line = words[i];
            if (++n >= maxLines) return n;
          } else line = t;
        }
        if (line) {
          Sym.text(g, line, x, y + n * lh, { size, weight: 500, color, shadow: false });
          n++;
        }
        return n;
      }

      return {
        debug: () => ({ st, rows, errs, byScen }),

        update(dt) {
          pump();
          if (st.mode === 'loading' && st.next) startQuestion();
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
          canvas.removeEventListener('pointerup', onUp);
          canvas.removeEventListener('pointercancel', onUp);
          canvas.style.cursor = '';
          canvas.style.touchAction = prevTouch;
          J.destroy();
        },

        render(g, W, H, ts) {
          st.buttons = [];
          g.fillStyle = COL.bg;
          g.fillRect(0, 0, W, H);
          if (st.mode === 'loading' || !st.q) {
            header(g, W, 'Draw the Line', null);
            const dots = '.'.repeat(1 + (Math.floor(ts / 300) % 3));
            Sym.text(g, 'Working out the fastest line' + dots, W / 2, H / 2, { align: 'center', size: 18, weight: 600, color: '#cfd5df' });
            if (!rows.length) Sym.text(g, 'Drag to draw the line you would drive, from the start mark to the finish. Space to submit.', W / 2, H / 2 + 30, { align: 'center', size: 14, color: COL.dim });
          } else if (st.mode === 'replay') renderReplay(g, W, H, ts);
          else if (st.mode === 'result') renderResult(g, W, H);
          else renderDraw(g, W, H, ts);
          J.render(g, W, H, { x: W - 54, y: 14, size: 24, side: -1, callY: H * 0.42, vignette: st.mode === 'result' && ctx.clock() - st.tMode < 600 });
        },

        result() {
          const n = rows.length;
          const half = rows.slice(Math.floor(n / 2));
          const corners = rows.reduce((a, r) => a + r.corners, 0), placed = rows.reduce((a, r) => a + r.placed, 0);
          return {
            detail: { rows },
            summary: {
              mode: 'draw',
              level: half.length ? U.mean(half.map((r) => r.level)) : null,
              startLevel,
              nextLevel: st.level,
              accuracy: n ? rows.filter((r) => r.pass).length / n : null,
              placement: corners ? placed / corners : null,
              timeLost: n ? U.mean(rows.map((r) => r.loss)) : null,
              decision: n ? U.median(rows.map((r) => r.dec)) : null,
              ...J.summary(),
              trials: n,
              errs,
              byScen,
            },
          };
        },
      };
    },
  });
})();
