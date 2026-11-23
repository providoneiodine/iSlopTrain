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
 *
 * Split across js/drills/racing-line/ (content.js lists the files). This
 * one holds the definition, session state, grading and input.
 */
(function () {
  'use strict';
  const U = IST.util, Sym = IST.Symbols, UI = IST.CanvasUI, LL = IST.LineLab, RL = IST.RacingLine;
  const MAX_LEVEL = LL.MAX_LEVEL;
  const { COL, BUDGET, PASS, sec, questionGen, describeIdeal, describeUser } = RL;

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
      // sessions from the old multiple-choice version don't count
      const drawn = history.filter((r) => r.summary && r.summary.mode === 'draw');
      return IST.Analysis.latest(drawn, 'nextLevel') || 1;
    },

    coach: RL.coach,
    analyze: RL.analyze,

    create(ctx) {
      const S = ctx.settings, def = this;
      const VIEW = IST.View.get(), SEAT = IST.View.seat(VIEW), cockpit = S.cockpit !== false ? IST.View.cockpit(VIEW, S.style) : null;
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
      const { toTrack, writeSeg, refit, coverage, undo, clearAll } = RL.createSketch(st);

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
            const did = r.issues.some((is) => is.kind === k);
            IST.Analysis.count(errs, k, did);
            if (did) made[k] = (made[k] || 0) + 1;
          });
        });
        IST.Analysis.count(byScen, q.spec.id, pass);
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
        st.mode = 'replay';
        st.rp = RL.replay.start(st.q, li);
      }
      function cycle() {
        startReplay(1 - st.rp.li);
      }
      const skipPhase = () => RL.replay.skip(st.rp);
      function updateReplay(dt) {
        if (RL.replay.step(st.rp, dt) && J.audio) J.audio.tick();
      }
      function backToResult() {
        st.mode = 'result';
        st.rp = null;
      }

      const scene = RL.createScene({ S, VIEW, SEAT, cockpit });
      const screens = RL.createScreens({ st, rows, S, scene, act: { undo, clearAll, submit, startReplay, cycle, skipPhase, advance, backToResult } });

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
      const hit = (x, y) => UI.hit(st.buttons, x, y);
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
          UI.backdrop(g, W, H);
          if (st.mode === 'loading' || !st.q) {
            screens.header(g, W, 'Draw the Line', null);
            const dots = '.'.repeat(1 + (Math.floor(ts / 300) % 3));
            Sym.text(g, 'Working out the fastest line' + dots, W / 2, H / 2, { align: 'center', size: 18, weight: 620, color: COL.text2 });
            if (!rows.length) Sym.text(g, 'Drag to draw the line you would drive, from the start mark to the finish. Space to submit.', W / 2, H / 2 + 30, { align: 'center', size: 14, color: COL.dim });
          } else if (st.mode === 'replay') screens.renderReplay(g, W, H, ts);
          else if (st.mode === 'result') screens.renderResult(g, W, H);
          else screens.renderDraw(g, W, H, ts);
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
