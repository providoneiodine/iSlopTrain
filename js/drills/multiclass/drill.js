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
 * Variants (from level 2): you noticed late (radio, a dash setting, a
 * fight in your own class, a wandering mind: a few seconds to decide, near
 * the braking zone), two GTs nose to tail, or you're catching a GT limping
 * to the pits with a prototype closing behind.
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
 * each answer the answer cards stay up and the looped run-up becomes a
 * replay of the clicked card: from your seat (with a mirror), the top-down
 * view with both cars' lines and a gap trace, pausing at closing, braking,
 * turn-in, the pass and any conflict.
 *
 * Split across js/drills/multiclass/ (content.js lists the files). This
 * one holds the definition, session state, input and results.
 */
(function () {
  'use strict';
  const U = IST.util, Sym = IST.Symbols, TL = IST.TrafficLab, MC = IST.Multiclass;
  const MAX_LEVEL = TL.MAX_LEVEL;
  const { COL, BUDGET, REVEAL, PREF, RULE_IDS, shuffle, optText, GRADES, gradeOf, tagOf, explain } = MC;

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
      'Sometimes you notice late, catch a car limping to the pits, or meet two GTs racing each other. ' +
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

    coach: MC.coach,
    analyze: MC.analyze,

    create(ctx) {
      const S = ctx.settings, def = this;
      const VIEW = IST.View.get(), SEAT = IST.View.seat(VIEW), cockpit = S.cockpit !== false ? IST.View.cockpit(VIEW, S.style) : null;
      const rnd = U.rng(U.randomSeed());
      const auto = !S.level || S.level === 'auto';
      const startLevel = def.levelFor(S, ctx.history);
      const timeLimit = Number(S.timeLimit) || 0;
      // a late call brings its own few seconds; the setting can only make it shorter
      const limitFor = (q) => (q && q.timeLimit ? (timeLimit ? Math.min(timeLimit, q.timeLimit) : q.timeLimit) : timeLimit);
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
        q.me = q.role === 'fast' ? 'F' : 'S'; // first: the explanations are written from your seat
        q.opts.forEach((o) => {
          Object.assign(o, optText(q, o.id));
          o.grade = gradeOf(o);
          o.credit = GRADES[o.grade].credit;
          o.note = explain(q, o);
          o.tag = tagOf(o);
        });
        q.order = shuffle(q.opts.map((_, i) => i), rnd);
        q.brief = MC.brief(q);
        q.views = {};
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
          scen: q.spec.id, variant: q.variant, role: q.role, rules: q.rules, sit: q.sit, level: q.level, correct: correct ? 1 : 0, good: good ? 1 : 0, credit,
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
      function startReplay(oi) {
        st.mode = 'replay';
        st.rp = MC.replay.start(st.q, oi);
      }
      const skipPhase = () => MC.replay.skip(st.rp);
      function updateReplay(dt) {
        if (MC.replay.step(st.rp, dt) && J.audio) J.audio.tick();
      }

      const scene = MC.createScene({ S, VIEW, SEAT, cockpit });
      const screens = MC.createScreens({ st, rows, S, ctx, limit: () => limitFor(st.q), scene, act: { startReplay, skipPhase, advance, wantsReplay } });

      // ------------------------------------------------------------- input
      const nOpts = () => (st.q ? st.q.opts.length : 4);
      const gridCols = () => screens.quizLayout(ctx.W, ctx.H).cols;
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
          // the answer cards stay up: move between them like in the question, each move replays that answer
          const n = nOpts(), cols = gridCols(), k = st.q.order.indexOf(st.rp.oi);
          const to = a === 'left' ? k - 1 : a === 'right' ? k + 1 : a === 'up' ? k - cols : a === 'down' ? k + cols : null;
          if (to != null) startReplay(st.q.order[(to + n * 2) % n]);
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
        else if (b.panel != null && (st.mode === 'replay' || st.mode === 'reveal')) startReplay(st.q.order[b.panel]);
        else if (b.act) b.act();
      }
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerdown', onDown);

      return {
        debug: () => ({ st, rows, lure, bySit, byRole, byRules }),

        update(dt, clock) {
          pump();
          if (st.mode === 'loading' && st.next) startQuestion();
          if (st.mode === 'question' && limitFor(st.q) && clock - st.tMode > limitFor(st.q) * 1000) answer(-1);
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
          if (st.mode === 'rules') screens.renderRules(g, W, H);
          else if (st.mode === 'loading' || !st.q) {
            screens.header(g, W, 'Class Traffic', null);
            const dots = '.'.repeat(1 + (Math.floor(ts / 300) % 3));
            Sym.text(g, 'Setting up the traffic' + dots, W / 2, H / 2, { align: 'center', size: 18, weight: 620, color: COL.text2 });
            if (!rows.length) Sym.text(g, 'Read the gap, the closing speed and the distance to the braking zone, then pick the responsible move.', W / 2, H / 2 + 30, { align: 'center', size: 14, color: COL.dim });
          } else screens.renderQuiz(g, W, H, ts); // the replay is drawn inside the quiz screen
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
