/*
 * Class Traffic: responsible decisions in multiclass traffic (Mind tab).
 *
 * Each question is a long straight into a corner complex with two cars on
 * it: a prototype closing on a GT. You are one of them (alternating, or
 * chosen in settings) and pick what you'd do:
 *
 *   prototype: pass on the straight, out-brake it on the inside, go round
 *              the outside, or follow and pass on the exit;
 *   GT:        hold your line, ease off and let it by, leave room, move
 *              across, move over under braking, cover the inside.
 *
 * Every option is driven, not scripted (IST.TrafficLab): both cars on
 * their own paths at the speed IST.LineLab's lap-time model gives each car
 * there, the one behind following the one in front, and contact, squeezes,
 * cut-offs and forced hard braking detected from where the cars actually
 * are. The responsible call is the fastest option with no contact risk
 * that the chosen rule set allows (and, where the rules say the slower car
 * must give way, that doesn't hold the faster one up). The level sets how
 * close the call is: how much room a pass on the straight leaves.
 *
 * A rule set (blue flags and overtaking) is picked before the run. After
 * each answer, any option replays from your seat (with a mirror) beside the
 * top-down view and a gap trace, pausing at closing, braking, turn-in, the
 * pass and any conflict.
 */
(function () {
  'use strict';
  const U = IST.util, Sym = IST.Symbols, LL = IST.LineLab, TL = IST.TrafficLab;
  const HW = LL.HW, DS = LL.DS, MAX_LEVEL = TL.MAX_LEVEL, CARLEN = TL.CARLEN, CARW = TL.CARW;
  // the main page's palette (css/style.css :root): slate structure, pastel meaning
  const COL = {
    text: '#eef0f4', text2: '#c9cfd9', dim: '#a1a9b7', ink: '#1f232a',
    bg: '#272c34', deep: '#1f232a', panel: '#323842', panel2: '#3c434f', line: '#4a525f', lineStrong: '#5d6675',
    quiz: '#f6d98f', mint: '#a6e3c4', lilac: '#c4b4ef', peach: '#f5b09a',
    fast: '#9fcbef', slow: '#f5b09a', good: '#a6e3c4', warn: '#f6d98f', bad: '#f09ca6',
  };
  const BUDGET = 8; // ms per frame spent building the next question
  const LEADUP = 2.2, DECIDE_HOLD = 1.6; // s of looped run-up to the decision frame, and the hold on it
  const HOLD = 1900; // ms paused at each event in the replay
  const REVEAL = 1500;
  const PREF = 'multiclass.rules';
  const RULE_IDS = ['hold', 'yield', 'pointby'];

  const EV = {
    close: { label: 'Closing', color: '#c4b4ef' },
    brake: { label: 'Braking', color: '#f5b09a' },
    turnin: { label: 'GT turns in', color: '#f6d98f' },
    apex: { label: 'Apex', color: '#9fcbef' },
    pass: { label: 'Pass complete', color: '#a6e3c4' },
    contact: { label: 'Contact', color: '#f09ca6' },
    squeeze: { label: 'Squeezed', color: '#f6d98f' },
    cut: { label: 'Cut across', color: '#f6d98f' },
    hard: { label: 'Hard braking', color: '#f6d98f' },
    exit: { label: 'Track-out', color: '#c4b4ef' },
    end: { label: 'End of the straight', color: '#eef0f4' },
  };
  const PRIO = { contact: 9, squeeze: 8, cut: 8, hard: 7, pass: 6, turnin: 5, brake: 4, apex: 3, close: 2, exit: 2, end: 10 };

  const SITS = {
    'f-straight': 'Faster car: the pass on the straight is on',
    'f-dive': 'Faster car: out-brake it',
    'f-outside': 'Faster car: round the outside',
    'f-follow': 'Faster car: wait for the exit',
    's-clear': 'Slower car: it\'ll clear before braking',
    's-committed': 'Slower car: it\'ll be alongside into the corner',
    's-behind': 'Slower car: stuck behind you',
  };
  const SIT_ORDER = Object.keys(SITS);
  const OPT_LABELS = {
    straight: 'Pass on the straight', dive: 'Out-brake on the inside', outside: 'Round the outside', follow: 'Follow it through',
    hold: 'Hold your line', letby: 'Ease off, let it by', room: 'Leave room', across: 'Move across', brakeMove: 'Move over under braking', defend: 'Cover the inside',
  };
  const OPT_ORDER = TL.FAST.concat(TL.SLOW);

  const kmh = (v) => Math.round(v * 3.6);
  const sec = (t) => (t >= 0 ? '+' : '−') + Math.abs(t).toFixed(2) + ' s';
  const m1 = (x) => (Math.abs(x) < 9.95 ? Math.abs(x).toFixed(1) : String(Math.round(Math.abs(x))));

  function shuffle(a, rnd) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---------------------------------------------------------------- texts
  function optText(q, id) {
    const side = q.side, T1 = 'T1';
    const pb = q.rules === 'pointby';
    switch (id) {
      case 'straight': return { label: 'Pass on the straight', sub: 'Pull out now, get clear and back on the racing line before braking.' };
      case 'dive': return { label: 'Out-brake it on the inside', sub: 'Pull out to the ' + side + ', stay there and brake later into ' + T1 + '.' };
      case 'outside': return { label: 'Round the outside', sub: 'Follow it in, then carry more speed on a wider line through ' + T1 + '.' };
      case 'follow': return { label: 'Follow it through, pass later', sub: 'Tuck in behind through the corner and use the straight after it.' };
      case 'hold': return { label: 'Hold your line', sub: 'Normal line, normal braking point. Let it choose where to pass.' };
      case 'letby': return pb
        ? { label: 'Point it by, ease off', sub: 'Point it by on the ' + side + ' and lift, staying on your line.' }
        : { label: 'Ease off, stay on your line', sub: 'Lift on the straight so it can get by before the braking zone.' };
      case 'room': return { label: 'Leave room on the inside', sub: 'Brake a little early and turn in late, behind it.' };
      case 'across': return { label: 'Move ' + side + ' to let it by', sub: 'Move off your line on the straight and ease off.' };
      case 'brakeMove': return { label: 'Move over under braking', sub: 'Brake, then move ' + side + ' so it can go round the outside.' };
      case 'defend': return { label: 'Cover the inside', sub: 'Move ' + side + ' before the braking zone and defend.' };
    }
    return { label: id, sub: '' };
  }

  /** Short verdict for a card, and its colour. */
  /*
   * Grades. The best call (fastest for you, no risk, allowed) gets full credit; a safe,
   * allowed answer close behind it still earns most of it, a slower safe one some.
   * Holding the faster car up where the rules say let it by, and anything risky, earn
   * little or nothing.
   */
  const CLOSE = 0.15; // s off the best call that still counts as a good call
  const GRADES = {
    best: { credit: 1, title: 'Responsible call' },
    close: { credit: 0.75, title: 'Good call' },
    safe: { credit: 0.4, title: 'Safe, but slow' },
    held: { credit: 0.25, title: 'Holds it up' },
    risky: { credit: 0, title: 'Not the call' },
  };
  function gradeOf(o) {
    if (o.correct) return 'best';
    if (!o.ok) return 'risky';
    if (o.held) return 'held';
    return o.cost <= CLOSE ? 'close' : 'safe';
  }

  function tagOf(o) {
    if (o.correct) return { text: 'Responsible', color: COL.good, kind: 'ok' };
    if (o.grade === 'close') return { text: 'Good call ' + sec(o.cost), color: COL.good, kind: 'near' };
    if (o.risk.level === 'contact') return { text: 'Contact', color: COL.bad, kind: 'contact' };
    if (o.offline) return { text: 'Unpredictable', color: COL.warn, kind: 'offline' };
    if (o.legal === false) return { text: 'Not allowed', color: COL.warn, kind: 'illegal' };
    if (o.risk.level === 'tight') return o.risk.why === 'squeeze' ? { text: 'Squeezed', color: COL.warn, kind: 'squeeze' } : o.risk.why === 'cut' ? { text: 'Cut across', color: COL.warn, kind: 'cut' } : { text: 'Hard braking', color: COL.warn, kind: 'hard' };
    if (o.held) return { text: 'Holds it up', color: COL.warn, kind: 'held' };
    return { text: 'Slower ' + sec(o.cost), color: COL.lilac, kind: 'slower' };
  }

  function explain(q, o) {
    const X = q.X, rk = o.risk, fast = q.role === 'fast';
    const where = (s) => TL.where(X, s);
    const me = q.me, other = fast ? 'the GT' : 'the prototype', Other = fast ? 'The GT' : 'The prototype';
    let risk = '';
    if (rk.level === 'contact') risk = 'Contact ' + where(rk.s) + (rk.gap < 0.1 ? ': the cars touch.' : ': only ' + rk.gap.toFixed(1) + ' m between the cars.');
    else if (rk.why === 'squeeze') risk = 'Squeezed ' + where(rk.s) + ': only ' + rk.gap.toFixed(1) + ' m between the cars.';
    else if (rk.why === 'cut') {
      const room = rk.clear < 1 ? 'with no room' : m1(rk.clear) + ' m in front';
      risk = rk.ahead === me ? 'You moved across ' + room + ' of ' + other + ' ' + where(rk.s) + ': it had to brake.' : Other + ' cut across ' + room + ' of you ' + where(rk.s) + ': you had to brake.';
    } else if (rk.why === 'hard') risk = (rk.who === me ? 'You' : Other) + ' had to brake harder than the car can ' + where(rk.s) + '.';
    if (fast) {
      if (o.legal === false) return 'Not allowed under point-by rules: passes only on a straight, when pointed by.' + (risk ? ' ' + risk : '');
      if (risk) return risk;
      const pass = o.r.pass ? 'Past ' + where(o.r.pass.s) : 'Stays behind it to the end of the straight';
      return pass + ', ' + sec(o.loss) + ' on a clear run' + (o.correct ? '. The fastest call with no risk.' : o.cost <= CLOSE ? ': safe, and only ' + o.cost.toFixed(2) + ' s off the best call.' : ': ' + sec(o.cost) + ' slower than the best call.');
    }
    if (o.offline) {
      const why = o.id === 'brakeMove' ? 'Moving off your line under braking: the prototype can\'t predict it.' : o.id === 'defend' ? 'Defending against a faster class is a move it can\'t predict, and it costs you.' : 'Moving off your line on the straight: the prototype can\'t know which side to take.';
      return why + (rk.level === 'contact' ? ' ' + risk : '');
    }
    if (risk) return (o.id === 'hold' && rk.level === 'contact' ? 'It was alongside: holding your line turns in on it. ' : '') + risk;
    const pass = o.r.pass ? 'It passes ' + where(o.r.pass.s) : 'It stays behind you';
    if (o.held) return pass + ' but you hold it up ' + o.other.toFixed(2) + ' s: under ' + TL.RULES[q.rules].name.toLowerCase() + ' rules you must let it by.';
    return pass + '; you lose ' + Math.max(0, o.loss).toFixed(2) + ' s' + (o.correct ? '. The least it can cost you, safely.' : o.cost <= CLOSE ? ': safe, and only ' + o.cost.toFixed(2) + ' s more than the best call.' : ', ' + o.cost.toFixed(2) + ' s more than the best call.');
  }

  // ----------------------------------------------------------- definition
  IST.registerDrill({
    id: 'multiclass',
    name: 'Class Traffic',
    tab: 'mind',
    category: 'Racecraft',
    usesView: true, // in-car pane: FOV, horizon and cockpit from IST.View
    tagline: 'Make the responsible call in multiclass traffic, from both sides of the speed gap.',
    description:
      'A prototype closing on a GT down a long straight into a corner. You\'re one of them: pick the pass, or how to be passed. ' +
      'Every option is driven by a two-car lap-time model, so contact, squeezes and time lost are worked out, not scripted. ' +
      'The best call is the fastest one for you with no contact risk that your rule set allows; a safe answer within 0.15 s of it still earns 75 % credit, a slower safe one 40 %. Pick the blue-flag rules before each run; the level closes the margins.',
    research: [
      { point: 'Projecting where the other car will be (level 3 situation awareness) is what lets you act before a conflict.', source: 'Endsley (1995), Human Factors 37(1).' },
      { point: 'Drivers judge closing from time-to-contact; that is why gaps are shown in seconds as well as metres.', source: 'Lee (1976), Perception 5(4).' },
      { point: 'Video-based decision training with feedback improves anticipation and transfers to play.', source: 'Williams, Ward, Knowles & Smeeton (2002), J. Exp. Psychol.: Applied 8(4).' },
      { point: 'Being tested on material beats re-studying it for long-term retention.', source: 'Roediger & Karpicke (2006), Psychological Science 17(3).' },
      { point: 'Feedback after multiple-choice tests stops the wrong options being learned as true.', source: 'Butler & Roediger (2008), Memory & Cognition 36(3).' },
      { point: 'Car following after the Intelligent Driver Model: the gap a driver keeps grows with the closing speed.', source: 'Treiber, Hennecke & Helbing (2000), Physical Review E 62(2).' },
      { point: 'Quasi-steady-state lap simulation gives each car\'s speed on its own line.', source: 'Brayshaw & Harrison (2005), Proc. IMechE Part D 219(6).' },
      { point: 'Adaptive difficulty holds you at a challenge point (~71 % correct).', source: 'Levitt (1971); Guadagnoli & Lee (2004), J. Motor Behavior 36(2).' },
    ],
    pointer: true, // answers can be clicked: never hide the cursor
    info: [
      {
        title: 'Rule sets',
        intro: 'You pick one before each run (or fix it in Settings). The physics is the same under all three; what changes is what the slower car owes the faster one and where the faster one may pass.',
        items: RULE_IDS.map((id) => [TL.RULES[id].name, TL.RULES[id].text + ' ' + TL.RULES[id].like]),
        outro: [
          'In every set: don\'t move off your line under braking or at turn-in, and leave racing room for a car that is alongside when you turn in. When you\'re the faster car, the slower one holds its normal line: don\'t count on being waved by.',
          'Real series differ in detail and change their rules between seasons and events. These are simplified styles, not any series\' exact wording: check your sporting regulations and driver briefing.',
        ],
      },
    ],
    settings: [
      { key: 'questions', label: 'Questions', type: 'number', default: 10, min: 3, max: 40, step: 1 },
      { key: 'rules', label: 'Rule set', type: 'select', default: 'ask', options: [['ask', 'Choose before each run']].concat(RULE_IDS.map((id) => [id, TL.RULES[id].name])), hint: 'Blue flags and overtaking. See Info for the differences.' },
      { key: 'role', label: 'Your car', type: 'select', default: 'mixed', options: [['mixed', 'Alternate'], ['fast', 'Prototype (faster)'], ['slow', 'GT (slower)']] },
      { key: 'level', label: 'Level', type: 'select', default: 'auto', options: [['auto', 'Auto (adapts)']].concat([1, 2, 3, 4, 5, 6].map((n) => [String(n), String(n)])), hint: 'Higher levels make the call closer.' },
      { key: 'replay', label: 'Replay analysis', type: 'select', default: 'always', options: [['always', 'After every answer'], ['wrong', 'Only when wrong'], ['off', 'Off']] },
      { key: 'timeLimit', label: 'Time limit', type: 'select', default: '0', options: [['0', 'None'], ['30', '30 s'], ['20', '20 s'], ['10', '10 s']] },
      { key: 'style', label: 'In-car style', type: 'select', default: 'realistic', options: [['realistic', 'Realistic'], ['minimal', 'Minimal']] },
      { key: 'cockpit', label: 'Cockpit', type: 'bool', default: true, hint: 'Draw the cockpit over the in-car view. Set it up on the View screen.' },
    ],
    metrics: [
      { key: 'level', label: 'Traffic level', digits: 1, better: 'higher', primary: true, hint: 'Average level over the second half of the session. Higher levels make the call closer.' },
      { key: 'callScore', label: 'Call score', pct: true, digits: 0, better: 'higher', hint: 'Average credit per question: best call 100 %, a safe call within 0.15 s of it 75 %, a slower safe call 40 %, holding the faster car up 25 %, a risky call 0.' },
      { key: 'accuracy', label: 'Best calls', pct: true, digits: 0, better: 'higher' },
      { key: 'riskRate', label: 'Risky picks', pct: true, digits: 0, better: 'lower', hint: 'Picks that ended in contact, a squeeze, a cut-off, hard braking or a move the other car couldn\'t predict.' },
      { key: 'timeLost', label: 'Time given away', unit: 's', digits: 2, better: 'lower', hint: 'Average time a safe pick cost over the responsible call (0 when right).' },
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
        'f-follow': 'If you won\'t be clear before braking, sit behind and use the exit. A dive at a car that is turning in is the classic multiclass crash.',
        's-clear': 'If it will be past before the braking zone, do nothing: your normal line is the most useful thing you can give it.',
        's-committed': 'If it will be alongside into the corner, make room: ease off early so it clears, or brake a touch early and turn in behind it.',
        's-behind': 'Stuck behind you: under give-way and point-by rules, let it by on the straight if there is room before braking; otherwise wait for the next straight.',
      };
      if (worst && worst.r < 0.7) tips.push(SITS[worst.k] + ': ' + worst.e[1] + ' of ' + worst.e[0] + ' right. ' + txt[worst.k]);
      if (U.isNum(s.riskRate) && s.riskRate >= 0.25) tips.push('A quarter of your picks were risky. When in doubt, the predictable option is the safe one: hold your line, or wait behind.');
      if (U.isNum(s.accuracy) && s.accuracy >= 0.85 && s.trials >= 6) tips.push('Sharp reading. The level will keep closing the margins.');
      const auto = !result || !result.settings || result.settings.level === 'auto';
      if (auto && U.isNum(s.nextLevel) && U.isNum(s.startLevel) && s.nextLevel !== s.startLevel)
        tips.push(s.nextLevel > s.startLevel ? 'Level up: ' + s.startLevel + ' → ' + s.nextLevel + '.' : 'Level eased: ' + s.startLevel + ' → ' + s.nextLevel + '.');
      return tips;
    },

    analyze(results, A) {
      const recent = results.slice(-10);
      const out = { breakdowns: [], notes: [], insim: [] };
      const sub = 'Last ' + recent.length + ' session' + (recent.length === 1 ? '' : 's');
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
        push('MC_PREDICT', ['across', 'brakeMove', 'defend'], 0.12, 'a move off your line');
        push('MC_ROOM', ['hold'], 0.25, 'holding your line with a car alongside or stuck behind');
        push('MC_PATIENCE', ['letby', 'room'], 0.25, 'giving away time you didn\'t need to');
      }
      const lv = A.values(results, 'level').filter(U.isNum);
      if (lv.length >= 2 && lv[lv.length - 1] - lv[0] >= 1) out.notes.push({ tone: 'good', text: 'Class Traffic: level ' + lv[0].toFixed(1) + ' → ' + lv[lv.length - 1].toFixed(1) + '.' });
      const rr = A.mean(A.values(recent, 'riskRate').slice(-5));
      if (rr != null && rr > 0.25 && recent.length >= 3) out.notes.push({ tone: 'bad', text: 'Class Traffic: ' + Math.round(rr * 100) + '% of recent picks were risky. Watch the replays of those.' });
      return out;
    },

    create(ctx) {
      const S = ctx.settings, def = this;
      const VIEW = IST.View.get(), SEAT = IST.View.seat(VIEW), CP = S.cockpit !== false ? IST.View.cockpit(VIEW, S.style) : null;
      const rnd = U.rng(U.randomSeed());
      const auto = !S.level || S.level === 'auto';
      const startLevel = def.levelFor(S, ctx.history);
      const timeLimit = Number(S.timeLimit) || 0;
      const J = new IST.Juice({ history: ctx.history });
      const canvas = document.getElementById('stage');
      let lastRules = 'hold';
      try {
        lastRules = IST.Storage.getPref(PREF, 'hold');
      } catch (e) {
        /* default */
      }

      const st = {
        mode: S.rules && S.rules !== 'ask' ? 'loading' : 'rules',
        rules: S.rules && S.rules !== 'ask' ? S.rules : null,
        ruleSel: Math.max(0, RULE_IDS.indexOf(lastRules)),
        level: startLevel, streak: 0, q: null, next: null, gen: null,
        sel: 0, pick: -1, tMode: 0, rp: null, buttons: [], recent: [],
        role: S.role === 'fast' || S.role === 'slow' ? S.role : rnd() < 0.5 ? 'fast' : 'slow',
      };
      const rows = [];
      const lure = {}, bySit = {}, byRole = {}, byRules = {};

      // --------------------------------------------------------- questions
      function* nextGen() {
        const role = st.role;
        for (let tries = 0; tries < 5; tries++) {
          const pool = TL.SCENARIOS.filter((s) => s.lv <= Math.max(2, st.level) && st.recent.indexOf(s.id) < 0);
          const spec = pool[Math.floor(rnd() * pool.length)] || TL.SCENARIOS[0];
          const cx = yield* TL.complexGen(spec, rnd);
          while (!st.rules) yield; // the line can be solved while the rules are being picked
          for (let k = 0; k < 2; k++) {
            const q = yield* TL.questionGen(cx, st.level, role, st.rules, rnd);
            if (q) return prepare(q);
          }
        }
        return null;
      }
      function queue() {
        st.next = null;
        st.gen = nextGen();
      }
      function pump() {
        if (!st.gen) return;
        const t0 = performance.now();
        while (performance.now() - t0 < BUDGET) {
          const r = st.gen.next();
          if (r.done) {
            st.gen = null;
            if (r.value) st.next = r.value;
            else queue();
            return;
          }
        }
      }
      queue();

      function prepare(q) {
        q.opts.forEach((o) => {
          Object.assign(o, optText(q, o.id));
          o.grade = gradeOf(o);
          o.credit = GRADES[o.grade].credit;
          o.note = explain(q, o);
          o.tag = tagOf(o);
        });
        q.order = shuffle(q.opts.map((_, i) => i), rnd);
        q.views = {};
        q.me = q.role === 'fast' ? 'F' : 'S';
        return q;
      }

      function startQuestion() {
        st.q = st.next;
        st.next = null;
        st.mode = 'question';
        st.tMode = ctx.clock();
        st.sel = 0;
        st.pick = -1;
        st.rp = null;
        st.recent.push(st.q.spec.id);
        if (st.recent.length > 2) st.recent.shift();
      }

      function chooseRules(i) {
        st.rules = RULE_IDS[i];
        try {
          IST.Storage.setPref(PREF, st.rules);
        } catch (e) {
          /* not saved */
        }
        st.mode = 'loading';
      }

      function answer(i) {
        const q = st.q;
        const o = i >= 0 ? q.opts[q.order[i]] : null;
        const correct = !!(o && o.correct);
        const credit = o ? o.credit : 0, good = credit >= GRADES.close.credit; // good calls count for the level too
        const dec = (ctx.clock() - st.tMode) / 1000;
        st.pick = i;
        st.mode = 'reveal';
        st.tMode = ctx.clock();
        q.opts.forEach((x) => {
          if (x.correct) return;
          const e = (lure[x.id] = lure[x.id] || [0, 0]);
          e[0]++;
          if (x === o) e[1]++;
        });
        const bump = (t, k) => {
          const e = (t[k] = t[k] || [0, 0]);
          e[0]++;
          if (good) e[1]++;
        };
        bump(bySit, q.sit);
        bump(byRole, q.role);
        bump(byRules, q.rules);
        const risky = !!(o && (o.risk.level !== 'safe' || o.offline || o.legal === false));
        rows.push({
          scen: q.spec.id, role: q.role, rules: q.rules, sit: q.sit, level: q.level, correct: correct ? 1 : 0, good: good ? 1 : 0, credit,
          pick: o ? o.id : 'timeout', best: q.best.id, risky: risky ? 1 : 0,
          cost: o && !risky ? +o.cost.toFixed(3) : null, lead: +q.lead.toFixed(1), dec: +dec.toFixed(2),
        });
        if (correct) {
          const quick = dec < 6 ? 8 : dec < 12 ? 4 : 0;
          J.hit({ base: 10, bonus: q.level * 4 + quick, label: quick === 8 ? 'QUICK READ' : 'RESPONSIBLE', color: COL.good });
        } else if (good) J.hit({ base: 6, bonus: q.level * 2, label: 'GOOD CALL', color: COL.good });
        else J.miss({ label: o ? o.tag.text.split(' ')[0].toUpperCase() : 'TIME' });
        if (auto) {
          if (good && ++st.streak >= 2) {
            st.level = Math.min(MAX_LEVEL, st.level + 1);
            st.streak = 0;
          } else if (!good) {
            st.level = Math.max(1, st.level - 1);
            st.streak = 0;
          }
        }
        if (S.role !== 'fast' && S.role !== 'slow') st.role = st.role === 'fast' ? 'slow' : 'fast';
        if (rows.length < S.questions) queue();
      }

      const wantsReplay = () => S.replay === 'always' || (S.replay === 'wrong' && rows.length && !rows[rows.length - 1].good);

      function advance() {
        if (rows.length >= S.questions) {
          ctx.finish();
          return;
        }
        if (st.next) startQuestion();
        else st.mode = 'loading';
      }

      // ------------------------------------------------------------ replay
      /** Index into the run's record at time t. */
      function at(R, t) {
        const f = U.clamp(t / TL.DT, 0, R.n - 1);
        const i = Math.min(R.n - 2, Math.floor(f)), u = f - i;
        const L = (a) => a[i] + (a[i + 1] - a[i]) * u;
        return { sF: L(R.sF), vF: L(R.vF), lF: L(R.lF), sS: L(R.sS), vS: L(R.vS), lS: L(R.lS), i };
      }
      function timeAtPos(R, key, s) {
        const a = R[key];
        for (let i = 1; i < R.n; i++) if (a[i] >= s) return R.t[i - 1] + ((s - a[i - 1]) / Math.max(1e-6, a[i] - a[i - 1])) * TL.DT;
        return null;
      }

      function events(q, o) {
        if (o.events) return o.events;
        const r = o.r, R = r.rec, X = q.X, me = q.me;
        const mine = me === 'F' ? o.fp : o.sp, keyS = me === 'F' ? 'sF' : 'sS', keyV = me === 'F' ? 'vF' : 'vS';
        const E = [];
        const add = (kind, t, ci) => {
          if (t != null && isFinite(t) && t > 0.15) E.push({ kind, t, ci: ci == null ? 0 : ci });
        };
        // closing: the faster car first within 1 s of the slower one
        for (let i = 0; i < R.n; i++) {
          if (R.sS[i] - R.sF[i] - CARLEN < R.vF[i] * 0.6 && i > 6) {
            add('close', R.t[i]);
            break;
          }
        }
        for (let i = 6; i < R.n; i++) {
          if ((R[keyV][i - 6] - R[keyV][i]) / (6 * TL.DT) > 6) {
            add('brake', R.t[i - 6]);
            break;
          }
        }
        add('turnin', timeAtPos(R, 'sS', o.sp.corners[0].ti * DS));
        add('apex', timeAtPos(R, keyS, mine.corners[0].ia * DS));
        if (r.pass) add('pass', r.pass.t);
        if (r.contact) add('contact', r.contact.t);
        else if (o.risk.why === 'squeeze') add('squeeze', timeAtPos(R, 'sS', o.risk.s));
        else if (o.risk.why === 'cut') add('cut', r.cut.t);
        else if (o.risk.why === 'hard') add('hard', (r.hard[0] || r.hard[1]).t);
        const last = mine.corners.length - 1, lc = mine.corners[last];
        if (lc.to != null) add('exit', timeAtPos(R, keyS, lc.to * DS), last);
        const tEnd = timeAtPos(R, keyS, q.geo.sEnd);
        E.sort((a, b) => a.t - b.t);
        // merge events closer than 0.35 s, keeping the more important one
        const out = [];
        E.forEach((e) => {
          const p = out[out.length - 1];
          if (p && e.t - p.t < 0.35) {
            if (PRIO[e.kind] > PRIO[p.kind]) out[out.length - 1] = e;
          } else out.push(e);
        });
        out.push({ kind: 'end', t: tEnd != null ? tEnd : R.t[R.n - 1], ci: -1 });
        return (o.events = out);
      }

      function startReplay(oi) {
        const q = st.q, o = q.opts[oi];
        st.mode = 'replay';
        st.rp = { oi, o, t: 0, ev: events(q, o), ei: 0, hold: 500, cur: null, curAt: 0, done: false };
      }
      function cycle(dir) {
        const ord = st.q.order, k = ord.indexOf(st.rp.oi);
        startReplay(ord[(k + dir + ord.length) % ord.length]);
      }
      function skipPhase() {
        const rp = st.rp;
        if (rp.done) return;
        if (rp.hold > 0 && rp.cur) {
          rp.hold = 0;
          return;
        }
        const e = rp.ev[rp.ei];
        if (e) rp.t = Math.max(rp.t, e.t - 0.02);
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
        const e = rp.ev[rp.ei];
        if (e && rp.t >= e.t) {
          rp.t = e.t;
          rp.cur = e;
          rp.curAt = performance.now();
          rp.ei++;
          if (e.kind === 'end') {
            rp.done = true;
            rp.hold = Infinity;
          } else rp.hold = HOLD;
          if (J.audio) J.audio.tick();
        }
      }

      // ------------------------------------------------------------- input
      const nOpts = () => (st.q ? st.q.opts.length : 4);
      const gridCols = () => quizLayout(ctx.W, ctx.H).cols;
      function onAct(a) {
        if (st.mode === 'rules') {
          if (a === 'left' || a === 'up') st.ruleSel = (st.ruleSel + 2) % 3;
          else if (a === 'right' || a === 'down') st.ruleSel = (st.ruleSel + 1) % 3;
          else if (a === 'confirm') chooseRules(st.ruleSel);
        } else if (st.mode === 'question') {
          const n = nOpts(), cols = gridCols();
          if (a === 'left') st.sel = (st.sel + n - 1) % n;
          else if (a === 'right') st.sel = (st.sel + 1) % n;
          else if (a === 'up') st.sel = (st.sel - cols + n * 2) % n;
          else if (a === 'down') st.sel = (st.sel + cols) % n;
          else if (a === 'confirm') answer(st.sel);
        } else if (st.mode === 'reveal') {
          if (a === 'confirm' || a === 'right' || a === 'left') leaveReveal(a !== 'confirm' || wantsReplay());
        } else if (st.mode === 'replay') {
          if (a === 'left') cycle(-1);
          else if (a === 'right') cycle(1);
          else if (a === 'up') skipPhase();
          else if (a === 'down') startReplay(st.rp.oi);
          else if (a === 'confirm') advance();
        }
      }
      function leaveReveal(replay) {
        if (replay) startReplay(st.pick >= 0 ? st.q.order[st.pick] : st.q.opts.indexOf(st.q.best));
        else advance();
      }

      const ptr = (e) => [e.offsetX, e.offsetY];
      const hit = (x, y) => st.buttons.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
      function onMove(e) {
        const [x, y] = ptr(e);
        const b = hit(x, y);
        canvas.style.cursor = b ? 'pointer' : '';
        if (b && b.panel != null && st.mode === 'question') st.sel = b.panel;
        if (b && b.rule != null && st.mode === 'rules') st.ruleSel = b.rule;
      }
      function onDown(e) {
        const [x, y] = ptr(e);
        const b = hit(x, y);
        if (!b) return;
        e.preventDefault();
        if (b.rule != null && st.mode === 'rules') chooseRules(b.rule);
        else if (b.panel != null && st.mode === 'question') answer(b.panel);
        else if (b.act) b.act();
      }
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerdown', onDown);

      // ----------------------------------------------------------- drawing
      function wrapText(g, text, x, y, maxW, size, lh, color, maxLines, weight) {
        g.font = (weight || 500) + ' ' + size + 'px ' + Sym.FONT;
        const words = (text || '').split(' ');
        let line = '', n = 0;
        for (let i = 0; i < words.length; i++) {
          const t = line ? line + ' ' + words[i] : words[i];
          if (g.measureText(t).width > maxW && line) {
            Sym.text(g, line, x, y + n * lh, { size, weight: weight || 500, color, shadow: false });
            line = words[i];
            if (++n >= maxLines) return n;
          } else line = t;
        }
        if (line) Sym.text(g, line, x, y + n * lh, { size, weight: weight || 500, color, shadow: false });
        return n + 1;
      }

      // ------------------------------------------------------- theme (css/style.css)
      // Square slate blocks, 1 px border, hard offset shadow, pastel meaning, caps labels.
      function box(g, x, y, w, h, o) {
        o = o || {};
        const d = o.shadow == null ? 4 : o.shadow;
        if (d) {
          g.fillStyle = 'rgba(12,14,18,0.5)';
          g.fillRect(x + d, y + d, w, h);
        }
        g.fillStyle = o.fill || COL.panel;
        g.fillRect(x, y, w, h);
        g.lineWidth = 1;
        g.strokeStyle = o.line || COL.line;
        g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        if (o.accent) {
          g.fillStyle = o.accent;
          if (o.side) g.fillRect(x, y, o.side, h);
          else g.fillRect(x, y, w, o.accentH || 4);
        }
      }
      const spaced = (g, px) => {
        if ('letterSpacing' in g) g.letterSpacing = px + 'px';
      };
      /** Uppercase, letter-spaced label (the page's h2 / .tag type). Returns its width. */
      function caps(g, text, x, y, o) {
        o = o || {};
        const t = String(text).toUpperCase(), size = o.size || 10.5, weight = o.weight || 720;
        spaced(g, o.spacing == null ? size * 0.13 : o.spacing);
        g.font = weight + ' ' + size + 'px ' + Sym.FONT;
        const w = g.measureText(t).width;
        Sym.text(g, t, x, y, Object.assign({ size, weight, shadow: false }, o));
        spaced(g, 0);
        return w;
      }
      function capsWidth(g, text, size, weight) {
        spaced(g, size * 0.13);
        g.font = (weight || 720) + ' ' + size + 'px ' + Sym.FONT;
        const w = g.measureText(String(text).toUpperCase()).width;
        spaced(g, 0);
        return w;
      }

      /** Small line icons drawn in the chip's ink cell, one per verdict (and role). */
      function glyph(g, kind, cx, cy, r, color) {
        g.save();
        g.strokeStyle = color;
        g.fillStyle = color;
        g.lineWidth = Math.max(1.4, r * 0.32);
        g.lineCap = 'square';
        g.lineJoin = 'miter';
        g.beginPath();
        if (kind === 'ok') {
          g.moveTo(cx - r * 0.85, cy);
          g.lineTo(cx - r * 0.2, cy + r * 0.65);
          g.lineTo(cx + r * 0.9, cy - r * 0.7);
          g.stroke();
        } else if (kind === 'near') {
          g.arc(cx, cy, r, 0, Math.PI * 2);
          g.moveTo(cx - r * 0.5, cy);
          g.lineTo(cx - r * 0.1, cy + r * 0.4);
          g.lineTo(cx + r * 0.55, cy - r * 0.4);
          g.stroke();
        } else if (kind === 'contact') {
          // impact burst
          for (let k = 0; k < 8; k++) {
            const a = (k / 8) * Math.PI * 2, rr = k % 2 ? r * 0.5 : r;
            const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
            if (k) g.lineTo(px, py);
            else g.moveTo(px, py);
          }
          g.closePath();
          g.fill();
        } else if (kind === 'squeeze') {
          // two arrows closing in
          g.moveTo(cx - r, cy - r * 0.6);
          g.lineTo(cx - r * 0.2, cy);
          g.lineTo(cx - r, cy + r * 0.6);
          g.moveTo(cx + r, cy - r * 0.6);
          g.lineTo(cx + r * 0.2, cy);
          g.lineTo(cx + r, cy + r * 0.6);
          g.stroke();
        } else if (kind === 'cut') {
          // swerve across a lane line
          g.moveTo(cx - r, cy + r * 0.8);
          g.lineTo(cx - r * 0.2, cy + r * 0.8);
          g.lineTo(cx + r * 0.3, cy - r * 0.8);
          g.lineTo(cx + r, cy - r * 0.8);
          g.stroke();
        } else if (kind === 'hard') {
          // brake disc
          g.arc(cx, cy, r * 0.85, 0, Math.PI * 2);
          g.stroke();
          g.beginPath();
          g.arc(cx, cy, r * 0.25, 0, Math.PI * 2);
          g.fill();
        } else if (kind === 'offline') {
          // weave: no telling which way
          g.moveTo(cx - r, cy);
          g.bezierCurveTo(cx - r * 0.5, cy - r * 1.1, cx - r * 0.1, cy - r * 1.1, cx, cy);
          g.bezierCurveTo(cx + r * 0.1, cy + r * 1.1, cx + r * 0.5, cy + r * 1.1, cx + r, cy);
          g.stroke();
        } else if (kind === 'illegal') {
          g.arc(cx, cy, r * 0.85, 0, Math.PI * 2);
          g.moveTo(cx - r * 0.6, cy + r * 0.6);
          g.lineTo(cx + r * 0.6, cy - r * 0.6);
          g.stroke();
        } else if (kind === 'held') {
          // hourglass
          g.moveTo(cx - r * 0.7, cy - r);
          g.lineTo(cx + r * 0.7, cy - r);
          g.lineTo(cx - r * 0.7, cy + r);
          g.lineTo(cx + r * 0.7, cy + r);
          g.closePath();
          g.fill();
        } else if (kind === 'slower') {
          // stopwatch
          g.arc(cx, cy + r * 0.15, r * 0.78, 0, Math.PI * 2);
          g.moveTo(cx, cy + r * 0.15);
          g.lineTo(cx + r * 0.4, cy - r * 0.25);
          g.moveTo(cx - r * 0.25, cy - r);
          g.lineTo(cx + r * 0.25, cy - r);
          g.stroke();
        } else if (kind === 'fast' || kind === 'slow') {
          // chevrons: two for the faster class, one for the slower
          const n = kind === 'fast' ? 2 : 1;
          for (let k = 0; k < n; k++) {
            const ox = (k - (n - 1) / 2) * r * 0.75;
            g.moveTo(cx + ox - r * 0.35, cy - r * 0.75);
            g.lineTo(cx + ox + r * 0.35, cy);
            g.lineTo(cx + ox - r * 0.35, cy + r * 0.75);
          }
          g.stroke();
        }
        g.restore();
      }

      function chipWidth(g, text, size) {
        const h = Math.round(size + 11), sk = Math.round(h * 0.34);
        return sk + h + 2 + capsWidth(g, text, size) + 12 + sk * 0.6;
      }

      /**
       * Livery chip: a slanted pastel plate with a hard shadow and an ink cell carrying
       * the icon, like a class number panel on a car. Returns its width.
       */
      function chip(g, kind, text, x, y, color, o) {
        o = o || {};
        const size = o.size || 10.5, h = Math.round(size + 11), sk = Math.round(h * 0.34), cell = h + 2;
        const w = chipWidth(g, text, size);
        const x0 = o.right ? x - w : x;
        const plate = (x1, x2) => {
          g.beginPath();
          g.moveTo(x1 + sk, y);
          g.lineTo(x2, y);
          g.lineTo(x2 - sk, y + h);
          g.lineTo(x1, y + h);
          g.closePath();
        };
        g.save();
        g.translate(2, 2);
        plate(x0, x0 + w);
        g.fillStyle = 'rgba(12,14,18,0.55)';
        g.fill();
        g.restore();
        plate(x0, x0 + w);
        g.fillStyle = color;
        g.fill();
        plate(x0, x0 + sk + cell);
        g.fillStyle = COL.ink;
        g.fill();
        glyph(g, kind, x0 + sk * 0.5 + cell / 2, y + h / 2, h * 0.27, color);
        caps(g, text, x0 + sk + cell + 6, y + h / 2 + 0.5, { size, color: COL.ink, baseline: 'middle' });
        return w;
      }

      /** Key-cap number: the key you'd press, raised when it's the one selected. */
      function keycap(g, n, x, y, s, on) {
        g.fillStyle = on ? '#b89a52' : '#2a2f37';
        g.fillRect(x, y + 3, s, s);
        g.fillStyle = on ? COL.quiz : COL.panel2;
        g.fillRect(x, y, s, s);
        g.strokeStyle = on ? COL.quiz : COL.lineStrong;
        g.lineWidth = 1;
        g.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
        Sym.text(g, String(n), x + s / 2, y + s / 2 + 1, { align: 'center', baseline: 'middle', size: Math.round(s * 0.52), weight: 820, color: on ? COL.ink : COL.text, shadow: false });
      }

      function button(g, x, y, label, act, o) {
        o = o || {};
        g.font = '720 13px ' + Sym.FONT;
        const w = Math.max(o.min || 0, g.measureText(label).width + 26), h = 30;
        const x0 = x - (o.right ? w : 0);
        box(g, x0, y, w, h, { fill: o.primary ? COL.peach : COL.panel2, line: o.primary ? COL.peach : COL.lineStrong, shadow: 2 });
        Sym.text(g, label, x0 + w / 2, y + h / 2 + 0.5, { align: 'center', baseline: 'middle', size: 13, weight: 720, color: o.primary ? COL.ink : COL.text, shadow: false });
        st.buttons.push({ x: x0, y, w, h, act });
        return w;
      }

      function header(g, W, title, sub) {
        const q = st.q;
        if (st.mode !== 'rules') {
          // like a card's .tag, then the context in the page's caps label style
          const qs = 'Q ' + Math.min(S.questions, rows.length + (st.mode === 'question' ? 1 : 0)) + ' / ' + S.questions;
          const tw = capsWidth(g, qs, 11) + 14;
          g.fillStyle = COL.mint;
          g.fillRect(16, 16, tw, 20);
          caps(g, qs, 23, 26.5, { size: 11, color: COL.ink, baseline: 'middle' });
          caps(g, 'Level ' + (q ? q.level : st.level) + (st.rules ? '  ·  ' + TL.RULES[st.rules].short : ''), 16 + tw + 12, 26.5, { size: 11, color: COL.dim, baseline: 'middle' });
        }
        if (title) Sym.text(g, title, W / 2, 30, { align: 'center', size: Math.max(17, Math.min(24, W * 0.018)), weight: 720, shadow: false });
        if (sub) Sym.text(g, sub, W / 2, 52, { align: 'center', size: 13, weight: 420, color: COL.text2, shadow: false });
      }

      // rules picker: three cards, like the menu's
      function renderRules(g, W, H) {
        header(g, W, 'Class Traffic: pick the rules', 'Blue flags and overtaking. The physics is the same; what the slower car owes the faster one changes.');
        const n = 3, gap = 18, narrow = W < 760;
        const cw = narrow ? Math.min(560, W - 32) : Math.min(340, (W - 32 - gap * 2) / 3), ch = narrow ? Math.min(150, (H - 170) / 3 - gap) : Math.min(250, H - 200);
        const x0 = narrow ? (W - cw) / 2 : (W - (cw * 3 + gap * 2)) / 2, y0 = narrow ? 76 : Math.max(80, (H - ch) / 2 - 10);
        const accents = [COL.mint, COL.fast, COL.lilac];
        for (let i = 0; i < n; i++) {
          const R = TL.RULES[RULE_IDS[i]], sel = i === st.ruleSel;
          let x = narrow ? x0 : x0 + i * (cw + gap), y = narrow ? y0 + i * (ch + gap) : y0;
          if (sel) {
            x -= 2;
            y -= 2;
          }
          box(g, x, y, cw, ch, { accent: accents[i], shadow: sel ? 6 : 4, line: sel ? COL.quiz : COL.line });
          if (sel) {
            g.lineWidth = 2;
            g.strokeStyle = COL.quiz;
            g.strokeRect(x + 1, y + 1, cw - 2, ch - 2);
          }
          keycap(g, i + 1, x + 16, y + 18, 24, sel);
          Sym.text(g, R.name, x + 50, y + 36, { size: 18, weight: 720, color: COL.text, shadow: false });
          const lines = wrapText(g, R.text, x + 16, y + 64, cw - 32, 13, 18, COL.text2, narrow ? 3 : 7);
          wrapText(g, R.like, x + 16, y + 72 + lines * 18, cw - 32, 12, 16, COL.dim, 2);
          st.buttons.push({ x, y, w: cw, h: ch, rule: i });
        }
        Sym.text(g, '← →  choose   ·   Space  start   ·   or click a rule set   ·   Info on the menu card explains the differences', W / 2, H - 14, { align: 'center', size: 13, color: COL.dim, shadow: false });
      }

      /** Screen position + heading of a car at track position s and lateral lat (m) in top-down view V. */
      function carAt(geo, V, s, lat) {
        const f = U.clamp(s / DS, 0, geo.N - 1), i = Math.min(geo.N - 1, Math.floor(f)), u = f - i;
        const wx = (k) => geo.cx[k] + lat * geo.nx[k], wy = (k) => geo.cy[k] + lat * geo.ny[k];
        const p0 = V.map(wx(i), wy(i)), p1 = V.map(wx(i + 1), wy(i + 1));
        return { x: p0[0] + (p1[0] - p0[0]) * u, y: p0[1] + (p1[1] - p0[1]) * u, a: Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) };
      }
      function drawCarTop(g, V, p, color, me) {
        const L = Math.max(13, CARLEN * V.scale), Wd = Math.max(7, CARW * V.scale);
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.a);
        Sym.roundRect(g, -L / 2, -Wd / 2, L, Wd, Math.min(3, Wd / 3));
        g.fillStyle = color;
        g.fill();
        g.lineWidth = me ? 2.2 : 1.2;
        g.strokeStyle = me ? '#ffffff' : 'rgba(0,0,0,0.6)';
        g.stroke();
        g.fillStyle = 'rgba(0,0,0,0.55)';
        g.fillRect(L * 0.02, -Wd * 0.32, L * 0.22, Wd * 0.64);
        g.restore();
      }

      function viewFor(q, key, w, h, from, to) {
        const k = key + ':' + Math.round(w) + 'x' + Math.round(h);
        if (!q.views[k]) q.views[k] = LL.fitView(q.geo, w, h, 18, { sA: Math.max(0, from), sB: Math.min(q.geo.sEnd, to) });
        return q.views[k];
      }

      function mapWindow(q) {
        const C = q.geo.corners;
        return [q.sF0 - 30 - LEADUP * q.vF0, C[C.length - 1].endPos + 70]; // room for the looped run-up
      }

      function renderMap(g, x, y, w, h, opts) {
        const q = st.q, geo = q.geo, X = q.X;
        box(g, x, y, w, h, { fill: COL.deep });
        g.save();
        g.beginPath();
        g.rect(x + 1, y + 1, w - 2, h - 2);
        g.clip();
        g.translate(x, y);
        const win = mapWindow(q);
        const V = viewFor(q, 'map', w, h, win[0], win[1]);
        LL.drawTrack(g, geo, V, { bg: COL.deep, fontSize: 11 });
        // braking boards before T1
        geo.boards.forEach((b) => {
          if (b.pos < win[0]) return;
          const p = carAt(geo, V, b.pos, b.x);
          g.fillStyle = '#f2f2f2';
          g.fillRect(p.x - 2, p.y - 2, 4, 4);
        });
        if (opts.paths) opts.paths.forEach((pp) => LL.drawLine(g, geo, V, pp.plan.sim, { from: pp.from, color: pp.color, width: pp.width || 2.5, alpha: pp.alpha == null ? 0.9 : pp.alpha, dash: pp.dash }));
        if (opts.trails) opts.trails.forEach((tr) => LL.drawLine(g, geo, V, tr.plan.sim, { from: tr.from, to: tr.to, color: tr.color, width: 3.2 }));
        // cars: the other one first, yours on top
        const cars = [
          { s: opts.sS, lat: opts.lS, color: COL.slow, me: q.me === 'S' },
          { s: opts.sF, lat: opts.lF, color: COL.fast, me: q.me === 'F' },
        ].sort((a, b) => (a.me ? 1 : 0) - (b.me ? 1 : 0));
        cars.forEach((c) => drawCarTop(g, V, carAt(geo, V, c.s, c.lat), c.color, c.me));
        if (opts.mark) {
          const p = carAt(geo, V, opts.mark.s, opts.mark.lat);
          Sym.ring(g, p.x, p.y, 12 + 3 * Math.sin(performance.now() / 120), opts.mark.color, 2.5);
        }
        g.restore();
        // legend: colour keys like the menu's step-tab squares
        g.fillStyle = COL.fast;
        g.fillRect(x + 12, y + h - 19, 8, 8);
        const lw = caps(g, 'Prototype', x + 25, y + h - 11, { size: 9.5, color: COL.text2 });
        g.fillStyle = COL.slow;
        g.fillRect(x + 25 + lw + 14, y + h - 19, 8, 8);
        caps(g, 'GT', x + 25 + lw + 27, y + h - 11, { size: 9.5, color: COL.text2 });
      }

      /** Front view of a car in a mirror. */
      function drawFrontCar(g, cx, by, w, color, lights) {
        const h = w * 0.5;
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(cx - w * 0.52, by - h * 0.06, w * 1.04, h * 0.1);
        g.fillStyle = '#111';
        g.fillRect(cx - w * 0.5, by - h * 0.45, w * 0.18, h * 0.45);
        g.fillRect(cx + w * 0.32, by - h * 0.45, w * 0.18, h * 0.45);
        g.fillStyle = color;
        Sym.roundRect(g, cx - w * 0.4, by - h * 0.85, w * 0.8, h * 0.72, h * 0.15);
        g.fill();
        g.fillStyle = '#1a1d22';
        Sym.roundRect(g, cx - w * 0.24, by - h * 1.02, w * 0.48, h * 0.3, h * 0.08);
        g.fill();
        if (lights) {
          g.shadowColor = 'rgba(255,255,220,0.9)';
          g.shadowBlur = Math.max(3, w * 0.12);
        }
        g.fillStyle = '#fffbe0';
        g.fillRect(cx - w * 0.34, by - h * 0.5, w * 0.16, h * 0.1);
        g.fillRect(cx + w * 0.18, by - h * 0.5, w * 0.16, h * 0.1);
        g.shadowBlur = 0;
      }

      function drawMirror(g, x, y, w, h, other) {
        g.save();
        Sym.roundRect(g, x - 3, y - 3, w + 6, h + 6, h * 0.35);
        g.fillStyle = '#05070a';
        g.fill();
        Sym.roundRect(g, x, y, w, h, h * 0.3);
        g.clip();
        const sky = g.createLinearGradient(0, y, 0, y + h);
        sky.addColorStop(0, '#5e7b9a');
        sky.addColorStop(0.45, '#9fb3c6');
        sky.addColorStop(0.46, '#4a5a3e');
        sky.addColorStop(1, '#3a4630');
        g.fillStyle = sky;
        g.fillRect(x, y, w, h);
        // road receding behind
        const hz = y + h * 0.46;
        g.fillStyle = '#3b3e46';
        g.beginPath();
        g.moveTo(x + w * 0.47, hz);
        g.lineTo(x + w * 0.53, hz);
        g.lineTo(x + w * 1.1, y + h);
        g.lineTo(x - w * 0.1, y + h);
        g.closePath();
        g.fill();
        if (other && other.dz > 1 && other.dz < 220) {
          const f = w * 1.1, sc = f / Math.max(3, other.dz);
          const cw = CARW * sc, cx = x + w / 2 + other.dx * sc, by = hz + 1.1 * sc;
          drawFrontCar(g, cx, Math.min(y + h + cw * 0.3, by), cw, other.color, true);
        }
        g.restore();
        g.lineWidth = 2;
        g.strokeStyle = 'rgba(255,255,255,0.25)';
        Sym.roundRect(g, x, y, w, h, h * 0.3);
        g.stroke();
      }

      /**
       * Relative timing box (the sim overlay): the two cars in track order with the gap
       * in seconds, live as the run-up plays, and the closing speed underneath.
       */
      function drawRelative(g, w, h, P) {
        const q = st.q, me = q.me, ds = P.sF - P.sS;
        const gapS = (Math.abs(ds) - CARLEN) / Math.max(1, ds > 0 ? P.vS : P.vF); // seconds, nose to tail
        const along = Math.abs(ds) < CARLEN;
        const rowsR = [
          { me: me === 'F', name: 'Prototype', num: '7', color: COL.fast, s: P.sF },
          { me: me === 'S', name: 'GT', num: '91', color: COL.slow, s: P.sS },
        ].sort((a, b) => b.s - a.s);
        const rh = U.clamp(h * 0.055, 18, 24), bw = U.clamp(w * 0.34, 190, 270), bh = rh * 2 + 46;
        const bx = w - bw - 12, by = h - bh - 12;
        g.fillStyle = 'rgba(12,14,18,0.5)';
        g.fillRect(bx + 3, by + 3, bw, bh);
        g.fillStyle = 'rgba(31,35,42,0.9)';
        g.fillRect(bx, by, bw, bh);
        g.strokeStyle = COL.line;
        g.lineWidth = 1;
        g.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
        g.fillStyle = COL.mint;
        g.fillRect(bx, by, bw, 3);
        caps(g, 'Relative', bx + 10, by + 16, { size: 9.5, color: COL.dim });
        const fs = rh * 0.6;
        rowsR.forEach((r, i) => {
          const y = by + 24 + i * rh;
          if (r.me) {
            g.fillStyle = 'rgba(255,255,255,0.08)';
            g.fillRect(bx + 1, y, bw - 2, rh);
          }
          g.fillStyle = r.color;
          g.fillRect(bx + 10, y + rh * 0.2, 4, rh * 0.6);
          Sym.text(g, 'P' + (i + 1), bx + 22, y + rh * 0.7, { size: fs, weight: 720, color: COL.text2, shadow: false });
          Sym.text(g, '#' + r.num, bx + 22 + rh * 1.5, y + rh * 0.7, { size: fs, weight: 620, color: COL.text2, shadow: false });
          Sym.text(g, r.me ? 'YOU' : r.name, bx + 22 + rh * 3.1, y + rh * 0.7, { size: fs, weight: r.me ? 820 : 520, color: r.me ? COL.text : COL.text2, shadow: false });
          let gtxt = '';
          if (!r.me) gtxt = along ? 'ALONGSIDE' : (i === 0 ? '+' : '−') + Math.max(0, gapS).toFixed(2);
          if (gtxt) Sym.text(g, gtxt, bx + bw - 10, y + rh * 0.7, { align: 'right', size: fs, weight: 720, color: along ? COL.warn : i === 0 ? COL.fast : COL.slow, shadow: false });
        });
        const close = kmh(ds < 0 ? P.vF - P.vS : P.vS - P.vF); // the car behind faster = closing
        caps(g, (close >= 0 ? 'Closing ' : 'Pulling away ') + Math.abs(close) + ' km/h', bx + 10, by + bh - 9, { size: 9.5, color: close > 0 ? COL.warn : COL.dim });
      }

      /**
       * In-car view from your car: sF/lF etc. are both cars' positions. The other car
       * is drawn ahead on the road, in the mirror when behind, or as a nose at the
       * screen edge when alongside.
       */
      function renderPOV(g, x, y, w, h, ts, P) {
        const q = st.q, geo = q.geo;
        if (!q.R) q.R = new IST.TrackRenderer(geo, { theme: S.style });
        const R = q.R, me = q.me;
        const mine = me === 'F' ? { s: P.sF, l: P.lF, plan: P.fp, v: P.vF } : { s: P.sS, l: P.lS, plan: P.sp, v: P.vS };
        const oth = me === 'F' ? { s: P.sS, l: P.lS, v: P.vS, color: COL.slow, plan: P.sp } : { s: P.sF, l: P.lF, v: P.vF, color: COL.fast, plan: P.fp };
        const lat = (s) => TL.latAt(mine.plan, s);
        const dn = (lat(mine.s + 3) - lat(Math.max(0, mine.s - 3))) / 6;
        const cam = { pos: mine.s, x: mine.l, heading: 0, yaw: Math.atan(dn) };
        box(g, x, y, w, h, { fill: COL.deep });
        g.save();
        g.beginPath();
        g.rect(x + 1, y + 1, w - 2, h - 2);
        g.clip();
        g.translate(x, y);
        IST.View.apply(R, w, h, VIEW);
        R.prepare(w, h, cam);
        R.draw(g, []);
        const dz = oth.s - mine.s;
        if (dz > 2) {
          const pr = R.project(oth.s, oth.l, 0);
          if (pr) {
            const maxDz = R.drawDist * LL.SEG;
            pr.fog = R.theme.fogAmt * Math.pow(U.clamp((pr.dz / maxDz - 0.22) / 0.78, 0, 1), 1.5);
            const braking = P.braking != null ? P.braking : TL.vAt(oth.plan, oth.s + 6) < oth.v - 0.4;
            IST.RaceLayer.drawCar(g, pr, { color: oth.color }, braking);
          }
        }
        if (CP) {
          CP.frameFor(R, SEAT);
          CP.draw(g, IST.Cockpit.steerFrom(lat, IST.Cockpit.segCurv(geo), mine.s), IST.Cockpit.dash(mine.v));
        }
        // alongside: the other car's nose / tail in your periphery (over the cockpit, like the HUD)
        if (Math.abs(dz) < CARLEN + 1.5) {
          const left = oth.l < mine.l, ov = U.clamp(1 - Math.abs(dz) / (CARLEN + 1.5), 0.15, 1);
          const ww = w * 0.13 * ov, y0 = h * 0.45, y1 = h * 0.72;
          g.fillStyle = oth.color;
          g.beginPath();
          if (left) {
            g.moveTo(0, y0);
            g.lineTo(ww, y0 + h * 0.05);
            g.lineTo(ww * 0.9, y1);
            g.lineTo(0, y1 + h * 0.02);
          } else {
            g.moveTo(w, y0);
            g.lineTo(w - ww, y0 + h * 0.05);
            g.lineTo(w - ww * 0.9, y1);
            g.lineTo(w, y1 + h * 0.02);
          }
          g.closePath();
          g.fill();
          Sym.text(g, 'CAR ' + (left ? 'LEFT' : 'RIGHT'), left ? 16 : w - 16, y0 - 10, { align: left ? 'left' : 'right', size: 16, weight: 820, color: COL.text });
        }
        // mirror
        const mw = U.clamp(w * 0.3, 140, 300), mh = mw * 0.28;
        drawMirror(g, (w - mw) / 2, 10, mw, mh, dz < -CARLEN ? { dz: -dz, dx: oth.l - mine.l, color: oth.color } : null);
        // speed
        Sym.text(g, kmh(mine.v) + '', w / 2, h - 34, { align: 'center', size: Math.max(26, Math.min(42, h * 0.08)), weight: 820 });
        Sym.text(g, 'km/h', w / 2, h - 14, { align: 'center', size: 12, weight: 700, alpha: 0.75 });
        if (P.hud) P.hud(g, w, h);
        drawRelative(g, w, h, P);
        g.restore();
      }

      /** The numbers you decide from, as tiles: label, value, small print. */
      function situationTiles(q) {
        const fast = q.role === 'fast', gap = q.gap, tg = (gap + CARLEN) / q.vF0;
        const brake = Math.round((fast ? q.X.bF - q.sF0 : q.X.bS - q.sS0) / 10) * 10;
        const out = [
          { k: fast ? 'GAP AHEAD' : 'GAP BEHIND', v: Math.round(gap) + ' m', s: tg.toFixed(2) + ' s' },
          { k: 'CLOSING', v: '+' + kmh(q.vF0 - q.vS0), s: 'km/h' },
          { k: 'BRAKING ZONE', v: brake + ' m', s: 'ahead' },
        ];
        if (!fast) out.push(q.type === 'behind' ? { k: 'MIRROR', v: 'Behind', s: 'right on you' } : { k: 'MIRROR', v: 'Pulled out', s: 'to your ' + q.side });
        return out;
      }

      /**
       * Quiz layout. Wide screens: the scene (in-car view over the map) on the left and
       * a question panel on the right with the answers as one readable column. Narrow
       * screens: the scene as a strip on top and the panel under it, answers in two columns.
       */
      function quizLayout(W, H) {
        const top = 58, pad = 16, gap = 12, hint = 28, bodyH = H - top - hint;
        if (W >= 900 && W / H >= 1.15) {
          const pw = Math.round(U.clamp(W * 0.37, 380, 560)), px = W - pad - pw, sw = px - gap - pad;
          const povH = Math.round((bodyH - gap) * 0.6);
          return {
            side: true, cols: 1,
            pov: [pad, top, sw, povH], map: [pad, top + povH + gap, sw, bodyH - povH - gap],
            panel: [px, top, pw, bodyH],
          };
        }
        // the scene takes whatever the panel doesn't need (answers top out at 118 px tall)
        const cols = W < 560 ? 1 : 2, rows = Math.ceil(nOpts() / cols);
        const sh = Math.round(U.clamp(bodyH - gap - (215 + rows * 126), 170, 440)), povW = Math.round((W - pad * 2 - gap) * 0.58);
        return {
          side: false, cols,
          pov: [pad, top, povW, sh], map: [pad + povW + gap, top, W - pad * 2 - povW - gap, sh],
          panel: [pad, top + sh + gap, W - pad * 2, bodyH - sh - gap],
        };
      }

      function countLines(g, text, maxW, size) {
        g.font = '420 ' + size + 'px ' + Sym.FONT;
        let line = '', n = 1;
        for (const word of (text || '').split(' ')) {
          const t = line ? line + ' ' + word : word;
          if (g.measureText(t).width > maxW && line) {
            n++;
            line = word;
          } else line = t;
        }
        return n;
      }

      function drawAnswer(g, q, i, x, y, w, h) {
        const o = q.opts[q.order[i]];
        const reveal = st.mode !== 'question';
        const sel = !reveal && i === st.sel, picked = reveal && i === st.pick;
        const faded = reveal && !o.correct && !picked;
        const accent = picked ? (o.correct ? COL.good : COL.bad) : reveal && o.correct ? COL.good : sel ? COL.quiz : null;
        const big = h >= 84, ls = big ? 17 : 15, ss = big ? 14 : 12.5, lh = ss + 5;
        // the selected answer lifts like a hovered menu card
        if (sel) {
          x -= 2;
          y -= 2;
        }
        box(g, x, y, w, h, { fill: sel ? COL.panel2 : faded ? COL.deep : COL.panel, line: accent || COL.line, shadow: faded ? 2 : sel ? 6 : 4, accent, side: accent ? 5 : 0 });
        const bs = big ? 28 : 24, bx = x + 16, by = y + 12;
        keycap(g, i + 1, bx, by, bs, sel);
        const tx = bx + bs + 12, tw = w - (tx - x) - 14;
        // verdict chip beside the label if there's room, otherwise on its own line under it
        let drop = 0;
        if (reveal) {
          const cs = big ? 10.5 : 9.5, ch = Math.round(cs + 11);
          const cw = chipWidth(g, o.tag.text, cs);
          g.font = '720 ' + ls + 'px ' + Sym.FONT;
          const lw = g.measureText(o.label).width;
          if (tx + lw + 14 + cw <= x + w - 12) chip(g, o.tag.kind, o.tag.text, x + w - 12, by + bs / 2 - ch / 2, o.tag.color, { right: true, size: cs });
          else {
            chip(g, o.tag.kind, o.tag.text, tx, by + bs + 4, o.tag.color, { size: cs });
            drop = ch + 6;
          }
        }
        Sym.text(g, o.label, tx, by + bs / 2 + ls * 0.36, { size: ls, weight: 720, color: faded ? COL.dim : COL.text, shadow: false });
        // body text: the largest size (down to 11 px) at which all of it fits the row
        const body = reveal ? o.note : o.sub;
        let fs = ss, flh = lh, fty = 0, fl = 1;
        for (const size of [ss, ss - 1, ss - 2, 11]) {
          fs = Math.max(11, size);
          flh = fs + 4;
          fty = by + bs + 5 + drop + fs * 0.8;
          fl = Math.max(1, Math.floor((y + h - 7 - (picked ? 11 : 0) - fty) / flh) + 1);
          if (countLines(g, body, tw, fs) <= fl) break;
        }
        wrapText(g, body, tx, fty, tw, fs, flh, reveal && !faded ? COL.text2 : COL.dim, fl, 420);
        if (picked) caps(g, 'Your pick', x + w - 14, y + h - 10, { align: 'right', size: 9.5, color: accent });
        st.buttons.push({ x, y, w, h, panel: i });
      }

      function renderPanel(g, q, x, y, w, h, cols) {
        const fast = q.role === 'fast', reveal = st.mode !== 'question', pad = 18;
        box(g, x, y, w, h, { accent: COL.mint });
        let cy = y + pad + 4;
        // who you are, under which rules
        chip(g, fast ? 'fast' : 'slow', fast ? 'You: Prototype' : 'You: GT', x + pad, cy, fast ? COL.fast : COL.slow, { size: 10.5 });
        caps(g, TL.RULES[q.rules].name, x + w - pad, cy + 11, { align: 'right', size: 10.5, color: COL.dim, baseline: 'middle' });
        cy += 36;
        // the question, or the verdict
        const qs = U.clamp(w * 0.042, 18, 23);
        if (!reveal) {
          Sym.text(g, fast ? 'A GT is ahead of you.' : 'A prototype is closing on you.', x + pad, cy + qs * 0.62, { size: qs * 0.72, weight: 420, color: COL.text2, shadow: false });
          cy += qs * 1.05;
          Sym.text(g, 'What\'s the responsible move?', x + pad, cy + qs * 0.85, { size: qs, weight: 720, color: COL.text, shadow: false });
          cy += qs * 1.4;
          // what "best" means here, spelled out
          const rule = fast ? (q.rules === 'pointby' ? ', passing only where point-by allows' : '') : q.rules !== 'hold' ? ', without holding the prototype up' : '';
          const crit = 'Best = the fastest move for you with no contact risk' + rule + '. Safe answers close to it earn partial credit.';
          const cl = wrapText(g, crit, x + pad, cy + 4, w - pad * 2, 12.5, 16, COL.dim, 2, 420);
          cy += cl * 16 + 4;
          if (timeLimit) {
            const left = U.clamp(1 - (ctx.clock() - st.tMode) / (timeLimit * 1000), 0, 1);
            g.fillStyle = COL.deep;
            g.fillRect(x + pad, cy, w - pad * 2, 5);
            g.fillStyle = left < 0.25 ? COL.bad : COL.quiz;
            g.fillRect(x + pad, cy, (w - pad * 2) * left, 5);
            cy += 11;
          }
        } else {
          const o = st.pick >= 0 ? q.opts[q.order[st.pick]] : null, gr = o ? o.grade : 'risky';
          const vc = gr === 'best' || gr === 'close' ? COL.good : gr === 'risky' ? COL.bad : COL.warn;
          Sym.text(g, !o ? 'Out of time' : GRADES[gr].title, x + pad, cy + qs * 0.9, { size: qs * 1.1, weight: 720, color: vc, shadow: false });
          caps(g, 'Credit ' + Math.round((o ? o.credit : 0) * 100) + '%', x + w - pad, cy + qs * 0.9, { align: 'right', size: 11, color: vc });
          cy += qs * 1.35;
          const why = !o ? 'The best call: ' + q.best.label + '.'
            : gr === 'best' ? 'The fastest move with no risk under these rules.'
            : gr === 'close' ? 'Safe and allowed, only ' + o.cost.toFixed(2) + ' s off the best: ' + q.best.label + '.'
            : gr === 'safe' ? 'Safe, but ' + o.cost.toFixed(2) + ' s slower than the best: ' + q.best.label + '.'
            : gr === 'held' ? 'Safe, but these rules say let it by. Best: ' + q.best.label + '.'
            : 'Too risky or not allowed. The best call: ' + q.best.label + '.';
          const wl = wrapText(g, why, x + pad, cy + 12, w - pad * 2, 13.5, 18, COL.text2, 2, 420);
          cy += 10 + wl * 18;
        }
        // the numbers you decide from, in the menu card's stat strip style
        const T = situationTiles(q), tg = 8, tw = (w - pad * 2 - tg * (T.length - 1)) / T.length, th = 58;
        T.forEach((t, k) => {
          const tx = x + pad + k * (tw + tg);
          box(g, tx, cy, tw, th, { fill: COL.deep, shadow: 0 });
          caps(g, t.k, tx + 10, cy + 16, { size: 9, color: COL.dim });
          g.font = '720 20px ' + Sym.FONT;
          const vw = g.measureText(t.v).width;
          const vs = vw > tw - 20 ? Math.max(12, (20 * (tw - 20)) / vw) : 20;
          Sym.text(g, t.v, tx + 10, cy + 39, { size: vs, weight: 720, color: COL.text, shadow: false });
          Sym.text(g, t.s, tx + 10, cy + 52, { size: 11, weight: 420, color: COL.dim, shadow: false });
        });
        cy += th + 16;
        // answers: as tall as the panel allows, so the text can be read at a glance
        const n = q.opts.length, rows = Math.ceil(n / cols), gap = 10;
        const aw = (w - pad * 2 - gap * (cols - 1) - 4) / cols;
        const ah = Math.min(118, (y + h - pad - 4 - cy - gap * (rows - 1)) / rows);
        for (let i = 0; i < n; i++) {
          const c = i % cols, r = Math.floor(i / cols);
          drawAnswer(g, q, i, x + pad + c * (aw + gap), cy + r * (ah + gap), aw, ah);
        }
      }

      function renderQuiz(g, W, H, ts) {
        const q = st.q, fast = q.role === 'fast';
        header(g, W, null, null);
        const L = quizLayout(W, H);
        const sel = st.mode === 'question' ? q.opts[q.order[st.sel]] : st.pick >= 0 ? q.opts[q.order[st.pick]] : q.best;
        // the last couple of seconds before the decision, looped with a hold on the decision frame
        const cyc = (ts / 1000) % (LEADUP + DECIDE_HOLD), tt = Math.min(0, cyc - LEADUP), live = tt < 0;
        const at0 = (plan, s0) => {
          const s = LL.posAtTime(plan.sim, LL.timeAt(plan.sim, s0) + tt);
          return { s, l: TL.latAt(plan, s), v: TL.vAt(plan, s) };
        };
        const cf = at0(sel.fp, q.sF0), cs = at0(sel.sp, q.sS0);
        const P = {
          sF: cf.s, lF: cf.l, vF: cf.v, sS: cs.s, lS: cs.l, vS: cs.v,
          fp: sel.fp, sp: sel.sp, braking: false,
          hud: (g2, w) => {
            if (live) {
              g2.fillStyle = COL.bad;
              g2.globalAlpha = 0.6 + 0.4 * Math.sin(ts / 140);
              g2.fillRect(14, 16, 8, 8);
              g2.globalAlpha = 1;
              caps(g2, 'Closing in  ' + (-tt).toFixed(1) + ' s', 28, 21, { size: 10.5, color: COL.text, baseline: 'middle' });
            } else chip(g2, 'hard', 'Decide now', 12, 11, COL.quiz, { size: 10.5 });
            void w;
          },
        };
        renderPOV(g, L.pov[0], L.pov[1], L.pov[2], L.pov[3], ts, P);
        renderMap(g, L.map[0], L.map[1], L.map[2], L.map[3], {
          sF: P.sF, lF: P.lF, sS: P.sS, lS: P.lS,
          paths: [{ plan: fast ? sel.fp : sel.sp, from: fast ? q.sF0 : q.sS0, color: fast ? COL.fast : COL.slow, dash: [7, 5], alpha: 0.85 }],
        });
        if (L.map[2] >= 560) Sym.text(g, 'Dashed: your path for the highlighted answer', L.map[0] + L.map[2] - 12, L.map[1] + L.map[3] - 12, { align: 'right', size: 11, weight: 600, color: COL.dim });
        renderPanel(g, q, L.panel[0], L.panel[1], L.panel[2], L.panel[3], L.cols);
        if (st.mode === 'question') {
          const fade = U.clamp((ctx.clock() - st.tMode) / 250, 0, 1);
          if (fade < 1) {
            g.fillStyle = 'rgba(12,16,14,' + (1 - fade).toFixed(3) + ')';
            g.fillRect(0, 56, W, H - 56);
          }
          Sym.text(g, (L.cols === 1 ? '↑ ↓' : '← ↑ ↓ →') + '  choose   ·   Space  lock in   ·   or click an answer', W / 2, H - 10, { align: 'center', size: 13, color: COL.dim });
        } else {
          Sym.text(g, 'Space  ' + (wantsReplay() ? 'replay' : 'next') + '   ·   ← →  replay any answer', W / 2, H - 10, { align: 'center', size: 13, color: COL.dim });
        }
      }

      function relation(q, p) {
        const ds = p.sF - p.sS, gapLat = Math.abs(p.lF - p.lS) - CARW;
        if (Math.abs(ds) < CARLEN) {
          const inside = (p.lF - p.lS) * q.X.dir > 0 ? 'inside' : 'outside';
          return 'Side by side: prototype on the ' + inside + ', ' + Math.max(0, gapLat).toFixed(1) + ' m between the cars.';
        }
        const g = Math.abs(ds) - CARLEN, t = g / Math.max(1, ds > 0 ? p.vS : p.vF);
        return ds > 0 ? 'Prototype ' + m1(g) + ' m ahead of the GT (' + t.toFixed(2) + ' s).' : 'Prototype ' + m1(g) + ' m behind the GT (' + t.toFixed(2) + ' s).';
      }

      function captionFor(q, o, e, p) {
        if (!e) return { title: o.label + '   ' + o.tag.text, text: o.note, color: o.tag.color };
        const E = EV[e.kind];
        const nums = 'Prototype ' + kmh(p.vF) + ' km/h · GT ' + kmh(p.vS) + ' km/h';
        const T = e.ci >= 0 && (e.kind === 'apex' || e.kind === 'exit') ? 'T' + (e.ci + 1) + ' · ' : e.kind === 'turnin' ? 'T1 · ' : '';
        let text = relation(q, p);
        if (e.kind === 'end') text = o.note;
        else if (e.kind === 'contact' || e.kind === 'squeeze' || e.kind === 'cut' || e.kind === 'hard') text = o.note;
        else if (e.kind === 'turnin') text = relation(q, p) + (Math.abs(p.sF - p.sS) < CARLEN ? ' Whoever turns in now has to leave room.' : '');
        return { title: T + E.label + '   ' + nums, text, color: E.color };
      }

      function renderTrace(g, x, y, w, h, o, t) {
        const R = o.r.rec, tEnd = st.rp.ev[st.rp.ev.length - 1].t;
        const lim = 40;
        const px = (tt) => x + 44 + (tt / Math.max(0.1, tEnd)) * (w - 56);
        const py = (d) => y + h / 2 - (U.clamp(d, -lim, lim) / lim) * (h / 2 - 10);
        box(g, x, y, w, h);
        g.save();
        // alongside band
        g.fillStyle = 'rgba(246,217,143,0.12)';
        g.fillRect(x + 44, py(CARLEN), w - 56, py(-CARLEN) - py(CARLEN));
        g.fillStyle = 'rgba(255,255,255,0.12)';
        g.fillRect(x + 44, py(0), w - 56, 1);
        Sym.text(g, 'ahead', x + 38, y + 16, { align: 'right', size: 10, color: COL.dim, shadow: false });
        Sym.text(g, 'behind', x + 38, y + h - 8, { align: 'right', size: 10, color: COL.dim, shadow: false });
        Sym.text(g, 'side by side', x + 50, py(0) - 4, { size: 10, color: 'rgba(246,217,143,0.7)', shadow: false });
        st.rp.ev.forEach((e) => {
          if (e.kind === 'end') return;
          const xx = px(e.t), E = EV[e.kind];
          g.fillStyle = E.color;
          g.globalAlpha = 0.4;
          g.fillRect(xx, y + 8, 1, h - 16);
          g.globalAlpha = 1;
        });
        g.beginPath();
        for (let i = 0; i < R.n; i += 3) {
          if (R.t[i] > tEnd) break;
          const xx = px(R.t[i]), yy = py(R.sF[i] - R.sS[i]);
          if (i === 0) g.moveTo(xx, yy);
          else g.lineTo(xx, yy);
        }
        g.strokeStyle = COL.fast;
        g.lineWidth = 2.2;
        g.stroke();
        g.fillStyle = '#ffffff';
        g.fillRect(px(t), y + 6, 1.5, h - 12);
        Sym.text(g, 'Prototype vs GT (m)', x + w - 10, y + 16, { align: 'right', size: 10, weight: 700, color: COL.dim, shadow: false });
        g.restore();
      }

      function renderReplay(g, W, H, ts) {
        const q = st.q, rp = st.rp, o = rp.o, R = o.r.rec;
        header(g, W, q.role === 'fast' ? 'You\'re in the prototype' : 'You\'re in the GT', null);
        const p = at(R, rp.t);
        const top = 64, hint = 40, capH = 62, gap = 10;
        const traceH = U.clamp(H * 0.15, 70, 130);
        const mainH = Math.max(140, H - top - hint - capH - traceH - gap * 3);
        const tdW = U.clamp(W * 0.36, 220, 560);
        renderMap(g, 16, top, tdW, mainH, {
          sF: p.sF, lF: p.lF, sS: p.sS, lS: p.lS,
          paths: [
            { plan: o.fp, from: q.sF0, color: COL.fast, width: 2, alpha: 0.35, dash: [5, 5] },
            { plan: o.sp, from: q.sS0, color: COL.slow, width: 2, alpha: 0.35, dash: [5, 5] },
          ],
          trails: [
            { plan: o.fp, from: q.sF0, to: p.sF, color: COL.fast },
            { plan: o.sp, from: q.sS0, to: p.sS, color: COL.slow },
          ],
          mark: rp.cur && rp.hold > 0 && (rp.cur.kind === 'contact' || rp.cur.kind === 'squeeze' || rp.cur.kind === 'cut' || rp.cur.kind === 'hard') ? { s: (p.sF + p.sS) / 2, lat: (p.lF + p.lS) / 2, color: EV[rp.cur.kind].color } : null,
        });
        const i1 = Math.min(R.n - 1, p.i + 8);
        renderPOV(g, 16 + tdW + gap, top, W - 32 - tdW - gap, mainH, ts, {
          sF: p.sF, lF: p.lF, vF: p.vF, sS: p.sS, lS: p.lS, vS: p.vS, fp: o.fp, sp: o.sp,
          braking: q.me === 'F' ? R.vS[i1] < p.vS - 0.3 : R.vF[i1] < p.vF - 0.3,
          hud: (g2, w, h) => {
            Sym.text(g2, o.label, 14, h - 40, { size: 15, weight: 820, color: q.me === 'F' ? COL.fast : COL.slow });
            Sym.text(g2, o.tag.text, 14, h - 20, { size: 12, weight: 720, color: o.tag.color });
            if (rp.cur && rp.hold > 0) {
              const E = EV[rp.cur.kind];
              const age = (performance.now() - rp.curAt) / 180, sc = 1 + 0.25 * Math.max(0, 1 - age);
              Sym.text(g2, E.label.toUpperCase(), w / 2, h * 0.3, { align: 'center', baseline: 'middle', size: Math.round(Math.max(20, Math.min(34, w * 0.04)) * sc), weight: 820, color: E.color });
            }
          },
        });
        const cy = top + mainH + gap;
        const cap = captionFor(q, o, rp.hold > 0 || rp.done ? rp.cur : null, p);
        box(g, 16, cy, W - 32, capH, { accent: cap.color, side: 5 });
        Sym.text(g, cap.title, 32, cy + 22, { size: 15, weight: 720, color: cap.color, shadow: false });
        wrapText(g, cap.text, 32, cy + 43, W - 66, 13, 16, COL.text2, 2);
        renderTrace(g, 16, cy + capH + gap, W - 32, traceH, o, rp.t);
        // controls
        const by = H - hint + 6;
        const k = q.order.indexOf(rp.oi);
        let bx = 16;
        bx += button(g, bx, by, '◀', () => cycle(-1)) + 6;
        g.font = '720 13px ' + Sym.FONT;
        const lbl = 'Option ' + (k + 1) + ' / ' + q.opts.length + (st.pick >= 0 && q.order[st.pick] === rp.oi ? '  (your pick)' : '');
        Sym.text(g, lbl, bx + 4, by + 19, { size: 13, weight: 720, color: o.tag.color });
        bx += g.measureText(lbl).width + 14;
        bx += button(g, bx, by, '▶', () => cycle(1)) + 14;
        button(g, bx, by, rp.done ? 'Replay ↓' : rp.hold > 0 ? 'Continue ↑' : 'Next event ↑', () => (rp.done ? startReplay(rp.oi) : skipPhase()));
        const last = rows.length >= S.questions;
        button(g, W - 16, by, last ? 'Finish  (Space)' : 'Next question  (Space)', advance, { primary: true, right: true });
      }

      return {
        debug: () => ({ st, rows, lure, bySit, byRole, byRules }),

        update(dt, clock) {
          pump();
          if (st.mode === 'loading' && st.next) startQuestion();
          if (st.mode === 'question' && timeLimit && clock - st.tMode > timeLimit * 1000) answer(-1);
          if (st.mode === 'reveal' && clock - st.tMode > REVEAL) {
            if (wantsReplay()) leaveReveal(true);
            else if (clock - st.tMode > REVEAL + 1800) leaveReveal(false);
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
          // the page's faint 32 px blueprint grid
          g.fillStyle = 'rgba(255,255,255,0.025)';
          for (let gx = 0; gx < W; gx += 32) g.fillRect(gx, 0, 1, H);
          for (let gy = 0; gy < H; gy += 32) g.fillRect(0, gy, W, 1);
          if (st.mode === 'rules') renderRules(g, W, H);
          else if (st.mode === 'loading' || !st.q) {
            header(g, W, 'Class Traffic', null);
            const dots = '.'.repeat(1 + (Math.floor(ts / 300) % 3));
            Sym.text(g, 'Setting up the traffic' + dots, W / 2, H / 2, { align: 'center', size: 18, weight: 600, color: COL.text2 });
            if (!rows.length) Sym.text(g, 'Read the gap, the closing speed and the distance to the braking zone, then pick the responsible move.', W / 2, H / 2 + 30, { align: 'center', size: 14, color: COL.dim });
          } else if (st.mode === 'replay') renderReplay(g, W, H, ts);
          else renderQuiz(g, W, H, ts);
          if (st.mode !== 'rules') J.render(g, W, H, { x: W - 54, y: 14, size: 24, side: -1, callY: H * 0.42, vignette: st.mode === 'reveal' });
        },

        result() {
          const n = rows.length;
          const half = rows.slice(Math.floor(n / 2));
          const costs = rows.filter((r) => r.cost != null).map((r) => r.cost);
          return {
            detail: { rows },
            summary: {
              level: half.length ? U.mean(half.map((r) => r.level)) : null,
              startLevel,
              nextLevel: st.level,
              accuracy: n ? rows.filter((r) => r.correct).length / n : null,
              callScore: n ? U.mean(rows.map((r) => r.credit)) : null,
              riskRate: n ? rows.filter((r) => r.risky).length / n : null,
              timeLost: costs.length ? U.mean(costs) : null,
              decision: n ? U.median(rows.map((r) => r.dec)) : null,
              ...J.summary(),
              trials: n,
              lure,
              bySit,
              byRole,
              byRules,
            },
          };
        },
      };
    },
  });
})();
