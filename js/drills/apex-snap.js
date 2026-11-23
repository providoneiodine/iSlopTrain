/*
 * Apex Snap: the core look-ahead drill.
 *
 * You ride a lap on the racing line. Every apex has a target board showing a
 * neutral mask. After you pass an apex, the board on the NEXT apex briefly
 * shows an arrow at a random moment before turn-in, then the mask returns.
 * The flash is adaptively shortened below the time it takes to notice and
 * then make a saccade, so you can only read it reliably if your eyes are
 * ALREADY on the next apex. That is the reflex being trained:
 *   "clip the apex -> eyes to the next apex".
 *
 * Optional dual task: trackside marshal lights flash in the near periphery
 * (press Confirm), so attention stays wide while gaze stays far.
 */
(function () {
  'use strict';
  const U = IST.util, Sym = IST.Symbols;
  const DIRS = Sym.DIRS;
  const GRIP = {
    // aero: extra grip with speed (see Track.generate); GT3 ~ modest, prototype ~ lots
    road: { aLat: 9, aBrake: 9, aAccel: 4, aero: 0 },
    gt: { aLat: 15, aBrake: 13, aAccel: 6, aero: 0.35 },
    proto: { aLat: 24, aBrake: 22, aAccel: 9, aero: 0.6 },
  };
  // The board stands directly on the inside kerb at the apex (no post, no offset),
  // so the point you fixate to read it IS the apex, not a sign beside it (IST.View.BOARD).
  const INTRO_MS = 3500;
  const RESP_MS = 1600; // response window after the flash ends
  const FLAG_ON_MS = 650;
  const FLAG_RESP_MS = 1500;

  const BASE = {
    id: 'apex-snap',
    name: 'Apex Snap',
    category: 'Core',
    usesView: true, // in-car view settings (IST.View): FOV, horizon, seat, cockpit
    tagline: 'Eyes to the next apex.',
    description: 'After each apex, the next apex board briefly flashes an arrow. Press the matching arrow. The flash shortens as you improve.',
    research: [
      { point: 'Drivers look at the next bend 1–2 s before entering it.', source: 'Land & Lee (1994), Nature 369.' },
      { point: 'Racing drivers aim gaze at the apex well before turn-in.', source: 'Land & Tatler (2001), Current Biology 11(15).' },
      { point: 'Experienced drivers look further ahead.', source: 'Lehtonen et al. (2014), Accid. Anal. Prev. 70.' },
      { point: 'Flashes shorter than an eye movement (~200 ms) reward eyes already in place.', source: 'Posner (1980); Breitmeyer & Ögmen (2006), Visual Masking.' },
      { point: 'Consistent cue → response repetition builds automaticity.', source: 'Schneider & Shiffrin (1977), Psychological Review 84(1).' },
      { point: 'Adaptive difficulty maximises learning.', source: 'Levitt (1971); Guadagnoli & Lee (2004), J. Motor Behavior 36(2).' },
      { point: 'Less frequent feedback improves retention.', source: 'Winstein & Schmidt (1990), JEP: LMC 16(4).' },
    ],
    settings: [
      { key: 'duration', label: 'Duration', type: 'number', unit: 's', default: 180, min: 30, max: 900, step: 30 },
      { key: 'speed', label: 'Top speed', type: 'number', unit: 'km/h', default: 220, min: 100, max: 340, step: 10 },
      { key: 'grip', label: 'Car', type: 'select', default: 'gt', options: [['road', 'Road'], ['gt', 'GT'], ['proto', 'Prototype']] },
      { key: 'layout', label: 'Track', type: 'select', default: 'mixed', options: [['mixed', 'Mixed'], ['technical', 'Technical'], ['fast', 'Fast']] },
      { key: 'elevation', label: 'Elevation', type: 'select', default: 'rolling', options: [['flat', 'Flat'], ['rolling', 'Rolling'], ['hilly', 'Hilly']] },
      { key: 'familiar', label: 'Familiar corners', type: 'select', default: 'rare', options: [['off', 'Off'], ['rare', 'Rare'], ['often', 'Often'], ['silly', 'Silly']], hint: 'Rare nods to famous corner complexes.' },
      { key: 'style', label: 'Style', type: 'select', default: 'realistic', options: [['realistic', 'Realistic'], ['minimal', 'Minimal']] },
      { key: 'flags', label: 'Marshal lights', type: 'bool', default: false, hint: 'Confirm when one flashes.' },
      { key: 'feedback', label: 'Feedback', type: 'select', default: 'every', options: [['every', 'Every target'], ['none', 'Summary only']] },
      { key: 'carryOver', label: 'Continue from last level', type: 'bool', default: true },
      { key: 'startExposure', label: 'Start flash', type: 'number', unit: 'ms', default: 450, min: 50, max: 1500, step: 25 },
      { key: 'minTargetPx', label: 'Min board size', type: 'number', unit: 'px', default: 22, min: 10, max: 80, step: 2 },
      { key: 'seed', label: 'Track seed (0 = random)', type: 'number', default: 0, min: 0, max: 999999, step: 1 },
    ],
    metrics: [
      { key: 'threshold', label: 'Flash threshold', unit: 'ms', digits: 0, better: 'lower', primary: true, hint: 'Shortest flash read ~71% of the time.' },
      { key: 'earlyAcc', label: 'Snap score', pct: true, digits: 0, better: 'higher', hint: 'Accuracy on flashes just after the previous apex.' },
      { key: 'midAcc', label: 'Mid accuracy', pct: true, digits: 0, better: 'higher' },
      { key: 'lateAcc', label: 'Late accuracy', pct: true, digits: 0, better: 'higher' },
      { key: 'accuracy', label: 'Accuracy', pct: true, digits: 0, better: 'higher' },
      { key: 'previewTime', label: 'Look-ahead', unit: 's', digits: 2, better: 'higher', hint: 'Time from flash to apex on hits.' },
      { key: 'rt', label: 'Response', unit: 'ms', digits: 0, better: 'lower' },
      { key: 'falseAlarms', label: 'False presses', digits: 0, better: 'lower' },
      { key: 'flagHit', label: 'Marshal lights', pct: true, digits: 0, better: 'higher' },
      { key: 'flagRT', label: 'Marshal response', unit: 'ms', digits: 0, better: 'lower' },
      { key: 'trials', label: 'Targets', digits: 0 },
    ],
    coach(s) {
      const tips = [];
      if (s.trials < 12) tips.push('Short run. Aim for 3+ minutes.');
      if (U.isNum(s.earlyAcc) && U.isNum(s.lateAcc) && s.lateAcc - s.earlyAcc > 0.2)
        tips.push('Missing early flashes: move your eyes the moment you clip the apex.');
      if (s.falseAlarms > Math.max(3, s.trials * 0.25)) tips.push('Too many guesses. Only press what you saw.');
      if (U.isNum(s.flagHit) && s.flagHit < 0.7) tips.push('Missed marshal lights: eyes far, attention wide.');
      if (U.isNum(s.accuracy) && s.accuracy >= 0.65 && U.isNum(s.threshold) && s.threshold < 130)
        tips.push('Strong. Raise speed, add marshal lights, or use summary-only feedback.');
      return tips;
    },

    /** Stats-page analysis: weak spots by timing, corner type, direction, speed and crests. */
    analyze(results, A) {
      const recent = results.slice(-10);
      const out = { breakdowns: [], notes: [], insim: [] };
      const phase = A.sumTallies(recent, 'byPhase'), cat = A.sumTallies(recent, 'byCat'), dir = A.sumTallies(recent, 'byDir');
      const speed = A.sumTallies(recent, 'bySpeed'), blind = A.sumTallies(recent, 'blind');
      const overall = A.acc(A.total(phase));
      if (overall == null) return out;
      const name = this.name;
      const pc = (e) => Math.round(A.acc(e) * 100) + '%';
      const sub = 'Last ' + recent.length + ' session' + (recent.length === 1 ? '' : 's');

      const catItems = A.items(cat, null, A.CAT_LABELS).sort((a, b) => a.value - b.value);
      out.breakdowns.push(
        { title: 'Flash timing', subtitle: sub, items: A.items(phase, ['early', 'mid', 'late'], { early: 'Early', mid: 'Mid', late: 'Late' }), pct: true },
        { title: 'Corner type', subtitle: sub, items: catItems, pct: true },
        { title: 'Direction', subtitle: sub, items: A.items(dir, ['L', 'R'], { L: 'Left', R: 'Right' }), pct: true },
        { title: 'Speed', subtitle: sub, items: A.items(speed, ['slow', 'medium', 'fast'], { slow: 'Under 120 km/h', medium: '120–190 km/h', fast: 'Over 190 km/h' }), pct: true }
      );
      if (blind.blind && blind.blind[0]) {
        out.breakdowns.push({ title: 'Crests', subtitle: sub, items: A.items(blind, ['clear', 'blind'], { clear: 'Clear view', blind: 'Blind crest' }), pct: true });
      }

      const e = phase.early, l = phase.late;
      if (e && l && e[0] >= A.MIN_N && l[0] >= A.MIN_N) {
        const gap = A.acc(l) - A.acc(e);
        if (gap > 0.12) {
          out.notes.push({ tone: 'bad', text: name + ': early flashes ' + pc(e) + ' vs late ' + pc(l) + '.' });
          out.insim.push({ id: 'EARLY_SNAP', score: 0.5 + gap, evidence: 'Early ' + pc(e) + ' vs late ' + pc(l) });
        } else if (A.acc(e) >= 0.75) {
          out.notes.push({ tone: 'good', text: name + ': early flashes ' + pc(e) + '.' });
        }
      }

      const TIP_FOR = { hairpin: 'HAIRPIN', chicane: 'CHICANE', esses: 'ESSES', double: 'DOUBLE', tightening: 'TIGHTENING', opening: 'OPENING', sweeper: 'FAST', kink: 'FAST', tight: 'TIGHT' };
      for (const it of catItems) {
        if (it.n < A.MIN_N) continue;
        const gap = overall - it.value;
        if (gap >= 0.12 && TIP_FOR[it.key]) {
          out.insim.push({ id: TIP_FOR[it.key], score: 0.3 + gap, evidence: it.label + ': ' + Math.round(it.value * 100) + '% vs ' + Math.round(overall * 100) + '% overall' });
        }
      }
      const strong = catItems.filter((i) => i.n >= A.MIN_N && i.value - overall >= 0.1).pop();
      if (strong) out.notes.push({ tone: 'good', text: name + ': ' + strong.label.toLowerCase() + ' ' + Math.round(strong.value * 100) + '% vs ' + Math.round(overall * 100) + '% overall.' });

      if (dir.L && dir.R && dir.L[0] >= A.MIN_N && dir.R[0] >= A.MIN_N) {
        const d = A.acc(dir.L) - A.acc(dir.R);
        if (Math.abs(d) >= 0.12) {
          out.insim.push({ id: d < 0 ? 'DIR_LEFT' : 'DIR_RIGHT', score: 0.3 + Math.abs(d), evidence: 'Left ' + pc(dir.L) + ' vs right ' + pc(dir.R) });
        }
      }
      if (speed.fast && speed.fast[0] >= A.MIN_N && overall - A.acc(speed.fast) >= 0.12) {
        out.insim.push({ id: 'FAST', score: 0.3 + overall - A.acc(speed.fast), evidence: 'Over 190 km/h: ' + pc(speed.fast) + ' vs ' + Math.round(overall * 100) + '% overall' });
      }
      if (speed.slow && speed.slow[0] >= A.MIN_N && overall - A.acc(speed.slow) >= 0.12) {
        out.insim.push({ id: 'SLOW', score: 0.25 + overall - A.acc(speed.slow), evidence: 'Under 120 km/h: ' + pc(speed.slow) + ' vs ' + Math.round(overall * 100) + '% overall' });
      }
      if (blind.blind && blind.clear && blind.blind[0] >= A.MIN_N && A.acc(blind.clear) - A.acc(blind.blind) >= 0.12) {
        out.insim.push({ id: 'CREST', score: 0.3 + A.acc(blind.clear) - A.acc(blind.blind), evidence: 'Blind ' + pc(blind.blind) + ' vs clear ' + pc(blind.clear) });
      }
      const pt = A.trend(A.values(results, 'previewTime'), 'higher');
      if (pt.enough && pt.good && !pt.flat) {
        out.notes.push({ tone: 'good', text: name + ': look-ahead ' + pt.prior.toFixed(2) + ' → ' + pt.recent.toFixed(2) + ' s.' });
      }
      return out;
    },

    create(ctx) {
      const S = ctx.settings;
      const raceMode = !!this.raceMode; // set on the Race Mode variant below
      const def = this;
      const hazardMode = !!this.hazardMode; // set on Eyes Off the Wall (drills/eyes-off-wall.js)
      const callMode = hazardMode && !!this.callMode; // Call the Hazard: Confirm on live hazards
      const seed = S.seed > 0 ? Math.floor(S.seed) : U.randomSeed();
      const G = GRIP[S.grip] || GRIP.gt;
      const vmax = S.speed / 3.6;
      const track = IST.Track.generate(Object.assign({ rng: U.rng(seed), vmax, minLength: vmax * S.duration * 0.9 + 2500, leadIn: 60, minStraight: 14, maxStraight: 55, elevation: S.elevation, mix: S.layout, familiar: S.familiar || 'rare' }, G));
      const R = new IST.TrackRenderer(track, { theme: S.style });
      const V = IST.View.get(), SEAT = IST.View.seat(V), cockpit = IST.View.cockpit(V, S.style);
      const BOARD = IST.View.BOARD;
      const th = R.theme, HW = track.HALF_W, SEG = track.SEG;
      const rnd = U.rng(U.randomSeed());

      const lastThreshold = (hist) => {
        for (let i = hist.length - 1; i >= 0; i--) {
          const t = hist[i].summary && hist[i].summary.threshold;
          if (t > 0) return t;
        }
        return null;
      };
      // baseline from the standard drill: the "load cost" metric in Race Mode, and the
      // starting flash for a first run of a variant
      const baseline = raceMode || hazardMode ? lastThreshold(IST.Storage.getResults('apex-snap')) : null;
      let start = S.startExposure;
      if (S.carryOver) {
        const t = lastThreshold(ctx.history) || baseline;
        if (t) start = U.clamp(t * 1.5, 60, 1200);
      }
      const race = raceMode
        ? new IST.RaceLayer({
            track, rnd: U.rng(U.randomSeed()), vmax,
            intensity: S.intensity, relative: S.relative, traffic: S.traffic,
            dash: S.dash, radio: S.radio, audio: S.audio, relPos: S.relPos,
          })
        : null;
      const stair = new IST.Staircase({ start, min: 33, max: 1500, factor: 1.35, nDown: 2 });
      // game feel: chain + grades; silent under "summary only" feedback
      const J = new IST.Juice({ history: ctx.history, live: S.feedback === 'every' });
      const bestThr = ctx.history.reduce((b, r) => (r.summary && r.summary.threshold > 0 ? Math.min(b, r.summary.threshold) : b), Infinity);
      let pbPace = false;

      const st = {
        pos: 0, heading: 0, lat: track.lateralAt(0), v: 0, steer: 0,
        planCorner: -1, plan: null, trials: [], fa: 0, fb: null, faUntil: 0,
        flag: null, nextFlagAt: 6000 + rnd() * 4000, flagRTs: [], flagMiss: 0, flagFA: 0,
        hzTrials: [], hfb: null, // hazard mode: per-trial hazard info (parallel to trials), capture feedback
      };

      const boardX = (c) => c.dir * HW * BOARD.KERB;
      // camera on the racing line, turned partly along it (yaw vs the track from the
      // line's drift); 60 % because a driver's head counter-rotates toward the apex
      const camAt = (pos) => ({ pos, x: track.lateralAt(pos) * HW, heading: st.heading, yaw: 0.6 * track.lineYawAt(pos) });
      const boardSize = (pr) => IST.View.boardSize(pr, S.minTargetPx);
      /*
       * Boards (apex and hazard) are readable by the shared rule (IST.View.board) in the
       * prepared frame, with the wheel turned as it is at that spot. A flash must stay
       * readable for its whole exposure, so a crest, the A-pillar or the board fading as
       * you reach it can't swallow it mid-flash: later frames are checked by projecting
       * from where the car will be.
       */
      function boardAt(pos, x) {
        if (!R.ready) return null;
        return IST.View.boardVisible(R, pos, x, { minPx: S.minTargetPx, cockpit, seat: SEAT, steer: IST.Cockpit.steerAt(track, R.cam.pos) });
      }
      /** Does test() hold in every frame over the next exposure (+120 ms)? Restores this frame after. */
      function holdsFor(exposure, test) {
        const t0 = track.timeAt(st.pos), span = exposure + 120;
        let ok = true;
        for (let t = 40; ok && t <= span; t += 40) {
          R.prepare(R.W, R.H, camAt(track.posAtTime(t0 + t / 1000)));
          ok = test();
        }
        R.prepare(R.W, R.H, camAt(st.pos));
        return ok;
      }
      /** Screen board at (pos, x) now, if it stays readable for the whole exposure; else null. */
      function boardThrough(pos, x, exposure) {
        const now = boardAt(pos, x);
        return now && holdsFor(exposure, () => !!boardAt(pos, x)) ? now : null;
      }
      const hz = hazardMode
        ? new IST.HazardLayer({
            track, rnd: U.rng(U.randomSeed()), level: this.levelFor(S, ctx.history),
            audio: S.audio, framing: S.framing, boardThrough,
            call: callMode,
            onMissed: () => J.miss({ label: 'MISSED HAZARD' }),
          })
        : null;

      /** Blind apex: terrain blocks the line of sight to the board from 150 m out (crest). */
      function isBlind(c) {
        if (c._blind !== undefined) return c._blind;
        const from = Math.max(0, c.apexPos - 150);
        const eye = track.heightAt(from) + R.camH, tgt = track.heightAt(c.apexPos) + BOARD.M / 2;
        let blind = false;
        for (let p = from + 10; p < c.apexPos - 5; p += 5) {
          const lineH = eye + ((tgt - eye) * (p - from)) / (c.apexPos - from);
          if (track.heightAt(p) > lineH + 0.2) {
            blind = true;
            break;
          }
        }
        return (c._blind = blind);
      }
      /** Is corner ci's apex board readable in the prepared frame? */
      const readable = (ci) => !!boardAt(track.corners[ci].apexPos, boardX(track.corners[ci]));
      /** Positions in [from, to] (5 m steps) where the apex board is readable. */
      function readableSpan(ci, from, to) {
        const out = [];
        if (!R.ready) return out;
        for (let p = from; p <= to; p += 5) {
          R.prepare(R.W, R.H, camAt(p));
          if (readable(ci)) out.push(p);
        }
        R.prepare(R.W, R.H, camAt(st.pos)); // restore this frame
        return out;
      }

      /** outcome: 'apex' (hit) | 'hazard' (read the hazard board) | 'other' (wrong arrow) | 'none' (no answer) */
      function resolve(p, correct, rt, timeout, outcome) {
        p.state = 'done';
        const c = track.corners[p.corner];
        const f = U.clamp((p.posAtOnset - p.wStart) / Math.max(1, p.wEnd - p.wStart), 0, 1);
        if (hz) {
          const H = p.hazard;
          st.hzTrials.push({
            hz: H ? H.type : null, probe: !!p.probe, pop: !!(H && H.pop), framing: p.framing, ref: H || null,
            outcome: outcome || (timeout ? 'none' : correct ? 'apex' : 'other'),
          });
          if (H && p.probe) H.probeOutcome = st.hzTrials[st.hzTrials.length - 1].outcome;
          if (outcome === 'hazard') {
            hz.captured();
            if (S.feedback === 'every') st.hfb = { hazard: H, captured: true, until: performance.now() + 450 };
          }
        }
        st.trials.push({
          exposure: p.exposure, correct, rt, timeout, f,
          previewDist: c.apexPos - p.posAtOnset,
          previewTime: track.timeAt(c.apexPos) - track.timeAt(p.posAtOnset),
          radius: c.radius,
          cat: c.cat || c.type,
          dir: c.dir,
          blind: isBlind(c),
          kmh: track.speedAt(p.posAtOnset) * 3.6,
        });
        stair.update(correct);
        if (S.feedback === 'every') st.fb = { corner: p.corner, correct, until: performance.now() + 450 };
        if (correct) {
          // early flash = eyes moved straight after the apex; shorter flashes pay more
          const snap = f < 1 / 3;
          const bonus = (snap ? 8 : 0) + U.clamp(Math.round((300 - p.exposure) / 25), 0, 10);
          // call mode: a live hazard already called while the eyes held the apex
          const seen = callMode && p.probe && p.hazard && p.hazard.live && p.hazard.calledTs != null;
          J.hit({ bonus, label: seen ? 'SEEN' : snap ? 'SNAP!' : p.exposure < 100 ? 'ELITE FLASH' : null, color: seen || snap ? '#f6d98f' : null });
        } else {
          const looked = callMode && outcome === 'hazard' && p.hazard.live && p.hazard.calledTs != null;
          J.miss({ label: timeout ? 'MISSED' : looked ? 'CALLED BY LOOKING' : outcome === 'hazard' ? 'EYES ON THE WALL' : 'WRONG' });
        }
        if (!pbPace && isFinite(bestThr) && st.trials.length >= 6 && stair.value < bestThr) {
          pbPace = true;
          J.callout('PB PACE', '#f6d98f', 'flash ' + Math.round(stair.value) + ' ms, best was ' + Math.round(bestThr));
        }
      }

      function updateFlags(clock, ts) {
        const f = st.flag;
        if (f && f.onTs != null) {
          if (!f.done && ts - f.onTs > FLAG_RESP_MS) {
            f.done = true;
            st.flagMiss++;
          }
          if (f.done && ts - f.onTs > FLAG_ON_MS) st.flag = null;
        }
        if (!st.flag && clock >= st.nextFlagAt) {
          const tNow = track.timeAt(st.pos);
          const m = track.marshals.find((mm) => {
            if (mm.pos <= st.pos) return false;
            const dt = track.timeAt(mm.pos) - tNow;
            return dt > 0.9 && dt < 1.7;
          });
          if (m) {
            st.flag = { post: m, onTs: null, done: false };
            st.nextFlagAt = clock + 5000 + rnd() * 7000;
          } else st.nextFlagAt = clock + 250;
        }
      }

      function drawApexBoard(g, pr, i, ts) {
        const size = boardSize(pr);
        const cy = pr.y - size / 2; // bottom edge rests on the kerb
        const p = st.plan;
        const content = p && p.corner === i && p.state === 'shown' ? p.dir : 'mask';
        const fade = Sym.boardFade(pr.dz);
        if (fade <= 0) return;
        const a = (1 - pr.fog * 0.55) * fade;
        g.globalAlpha = a * 0.35 * Math.min(1, fade / 0.75); // shadow goes as the board breaks
        g.fillStyle = '#000';
        g.beginPath();
        g.ellipse(pr.x, pr.y, size * 0.6, Math.max(1, size * 0.07), 0, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 1;
        Sym.trackBoard(g, pr, pr.x, cy, size * 0.6, i, (L) => Sym.board(L, pr.x, cy, size, content, th));
        if (st.fb && st.fb.corner === i && ts < st.fb.until) Sym.ring(g, pr.x, cy, size * 0.85, st.fb.correct ? '#30d158' : '#ff453a', Math.max(2, size * 0.1));
      }

      function drawMarshal(g, pr, m, ts) {
        const s = pr.s;
        const top = pr.y - 2.4 * s;
        const box = Math.max(4, 0.9 * s);
        g.fillStyle = '#2c2f36';
        g.fillRect(pr.x - Math.max(1, 0.06 * s), top, Math.max(2, 0.12 * s), 2.4 * s);
        g.fillStyle = '#16181c';
        g.fillRect(pr.x - box / 2, top - box, box, box);
        const f = st.flag;
        const lit = f && f.post === m && f.onTs != null && ts - f.onTs < FLAG_ON_MS;
        g.beginPath();
        g.arc(pr.x, top - box / 2, box * 0.34, 0, Math.PI * 2);
        if (lit) {
          g.shadowColor = 'rgba(255,170,0,.9)';
          g.shadowBlur = box;
        }
        g.fillStyle = lit ? '#ffb000' : '#3a3216';
        g.fill();
        g.shadowBlur = 0;
      }

      return {
        debug: () => ({ st, stair, track, race, hz, R, boardAt, boardX }), // for dev tools / automated checks

        update(dt, clock, ts) {
          const v = track.speedAt(st.pos);
          st.v = v;
          const ds = (v * dt) / 1000;
          st.heading += track.curvatureAt(st.pos) * ds;
          st.pos += ds;
          st.lat = track.lateralAt(st.pos);
          if (cockpit) st.steer += (IST.Cockpit.steerAt(track, st.pos) - st.steer) * (1 - Math.exp(-dt / 70));

          // open a new target window whenever the next apex changes
          const ci = track.nextCornerIndex(st.pos);
          if (ci !== st.planCorner && clock >= INTRO_MS * 0.8) {
            const old = st.plan;
            if (old && (old.state === 'shown' || old.state === 'masked')) resolve(old, false, null, true);
            st.planCorner = ci;
            st.plan = null;
            if (ci >= 0) {
              const c = track.corners[ci];
              const wStart = Math.max(st.pos, ci > 0 ? track.corners[ci - 1].apexPos : 0);
              // window closes at turn-in; in chicanes/esses (apexes close together) allow it
              // to run halfway to the apex so the "apex -> next apex" flick is still trained
              let wEnd = c.startPos;
              if (wEnd - wStart < 40) wEnd = Math.max(wEnd, (c.startPos + c.apexPos) / 2);
              // onset only where the board is actually readable. Hairpins and tight
              // corners often only swing into view after turn-in, so the window may run
              // on past it, up to a point that still leaves time to react before the apex.
              const latest = c.apexPos - Math.max(25, track.speedAt(c.apexPos) * 0.7);
              const span = wEnd - wStart > 12 ? readableSpan(ci, wStart, Math.max(wEnd, latest)) : [];
              const inWin = span.filter((q) => q <= wEnd);
              const pool = inWin.length ? inWin : span;
              if (pool.length) {
                st.plan = {
                  corner: ci, wStart, wEnd, latest: Math.max(wEnd, latest),
                  onsetPos: Math.min(pool[(rnd() * pool.length) | 0] + rnd() * 5, Math.max(wEnd, latest)),
                  dir: DIRS[(rnd() * 4) | 0],
                  state: 'planned',
                };
                if (hz) hz.plan(st.plan, ci, st.pos);
              }
            }
          }

          const p = st.plan;
          if (p) {
            if (p.state === 'planned' && st.pos >= p.onsetPos) {
              if (st.pos > p.latest) p.state = 'cancelled';
              else {
                const c = track.corners[p.corner];
                const apex = boardThrough(c.apexPos, boardX(c), stair.value);
                if (apex) {
                  p.state = 'armed';
                  p.exposure = stair.value;
                  p.posAtOnset = st.pos;
                  if (hz) {
                    hz.arm(p, R.W, apex);
                    p.framing = hz.framingAt(clock);
                  }
                }
              }
            } else if ((p.state === 'shown' || p.state === 'masked') && ts - p.onsetTs > p.exposure + RESP_MS) {
              resolve(p, false, null, true);
            }
          }

          // familiar complex: no label, just a barely-audible ding as it starts
          for (const ic of track.familiars) {
            if (!ic.dinged && st.pos >= ic.startPos && st.pos < ic.endPos) {
              ic.dinged = true;
              J.ding();
            }
          }

          if (S.flags) updateFlags(clock, ts);
          if (race) race.update(dt, clock, ts, st.pos, v);
          if (hz) hz.update(dt, clock, ts, st.pos);
          if (clock >= S.duration * 1000 || st.pos > track.lastCornerEnd + 50) ctx.finish();
        },

        onAction(a, t) {
          if (DIRS.indexOf(a) >= 0) {
            const p = st.plan;
            if (p && (p.state === 'shown' || p.state === 'masked')) {
              const outcome = a === p.dir ? 'apex' : p.probe && a === p.decoy ? 'hazard' : 'other';
              resolve(p, a === p.dir, t - p.onsetTs, false, outcome);
            }
            else {
              st.fa++;
              st.faUntil = performance.now() + 600;
              J.miss({ label: 'GUESS' }); // pressing without a target breaks the chain
            }
          } else if (a === 'confirm' && callMode) {
            const c = hz.call(t);
            if (c.kind === 'live') {
              // called after the flash already showed the eyes on its board: no credit
              if (c.hz.probeOutcome === 'hazard') J.callout('CALLED BY LOOKING', '#ffb000');
              else J.bonus(10, 'CALLED');
            } else J.miss({ label: c.kind === 'wall' ? 'JUST A WALL' : 'NOTHING THERE' });
          } else if (a === 'confirm' && (S.flags || race)) {
            const f = st.flag;
            if (f && f.onTs != null && !f.done) {
              f.done = true;
              st.flagRTs.push(t - f.onTs);
              J.bonus(15, 'LIGHT');
            } else if (race && race.onConfirm(t)) {
              J.bonus(15, 'THREAT');
            } else {
              st.flagFA++;
              if (race) race.falseConfirm();
            }
          }
        },

        onPause() {
          const p = st.plan;
          if (p && p.state !== 'done') p.state = 'cancelled';
          if (st.flag && !st.flag.done) st.flag = null;
          if (race) race.pause();
          if (hz) hz.pause();
          J.pause();
        },
        onResume() {
          if (race) race.resume();
          if (hz) hz.resume();
          J.resume();
        },
        destroy() {
          if (race) race.destroy();
          if (hz) hz.destroy();
          J.destroy();
        },

        render(g, W, H, ts, paused) {
          const p = st.plan;
          if (p && !paused) {
            if (p.state === 'armed') {
              p.state = 'shown';
              p.onsetTs = ts;
            }
            if (p.state === 'shown' && ts - p.onsetTs >= p.exposure) p.state = 'masked';
          }
          if (st.flag && st.flag.onTs == null && !paused) st.flag.onTs = ts;

          const sprites = [];
          const far = st.pos + R.drawDist * SEG;
          // boards on the next two apexes only (less clutter, fewer overlaps in chicanes)
          const first = track.nextCornerIndex(st.pos);
          for (let i = first; i >= 0 && i < Math.min(track.corners.length, first + 2); i++) {
            const c = track.corners[i];
            if (c.apexPos > far) break;
            sprites.push({ pos: c.apexPos, x: boardX(c), draw: (g2, pr) => drawApexBoard(g2, pr, i, ts) });
          }
          if (S.flags) {
            for (const m of track.marshals) {
              if (m.pos <= st.pos) continue;
              if (m.pos > far) break;
              sprites.push({ pos: m.pos, x: m.side * (HW + 4.5), draw: (g2, pr) => drawMarshal(g2, pr, m, ts) });
            }
          }
          if (race) sprites.push.apply(sprites, race.sprites(st.pos, far, HW));
          if (hz) sprites.push.apply(sprites, hz.sprites(st.pos, far, ts, st.plan, st.hfb, boardSize, th));
          IST.View.apply(R, W, H, V);
          R.render(g, W, H, camAt(st.pos), sprites);
          if (cockpit) {
            cockpit.frameFor(R, SEAT);
            cockpit.draw(g, st.steer, IST.Cockpit.dash(st.v));
          }
          if (race) race.renderHUD(g, W, H, ts);
          if (hz) hz.renderHUD(g, W, H, ts, ctx.clock(), S.feedback === 'every');

          // HUD
          const n = st.trials.length, hits = st.trials.filter((x) => x.correct).length;
          Sym.text(g, U.fmtTime(S.duration - ctx.clock() / 1000), 18, 32, { size: 20, weight: 820, alpha: 0.85 });
          Sym.text(g, Math.round(st.v * 3.6) + ' km/h', W - 18, 32, { size: 20, weight: 820, align: 'right', alpha: 0.85 });
          Sym.text(g, 'flash ' + Math.round(stair.value) + ' ms  ·  ' + hits + '/' + n, W - 18, 54, { size: 13, weight: 420, align: 'right', alpha: 0.6 });
          if (ctx.clock() < INTRO_MS) {
            const a = U.clamp((INTRO_MS - ctx.clock()) / 600, 0, 1);
            const iy = H * 0.22;
            Sym.text(g, 'Eyes on the next apex', W / 2, iy, { align: 'center', size: Math.max(24, W * 0.024), weight: 820, alpha: a });
            const extra = race
              ? '  ·  Confirm: car alongside' + (S.flags ? ' / marshal light' : '')
              : S.flags ? '  ·  Confirm: marshal light' : '';
            const sub = callMode
              ? 'Confirm: call wrecks, yellows, spins (not walls)  ·  eyes stay on the apex'
              : hz ? 'Walls and wrecks will pull at your eyes  ·  press the arrow you saw' : 'Arrow keys' + extra;
            Sym.text(g, sub, W / 2, iy + 32, { align: 'center', size: 15, weight: 340, alpha: a * 0.9 });
          }
          if (performance.now() < st.faUntil && S.feedback === 'every') Sym.text(g, 'no target', W / 2, H * 0.08, { align: 'center', size: 14, color: '#ff453a' });
          // chain block top-right, clear of the road, the radio box (top-left) and the dash (top-centre)
          J.render(g, W, H, { x: W - 58, y: 66, size: 30, side: -1, callY: H * 0.3, vignette: false });
        },

        result() {
          const T = st.trials;
          const acc = (a) => (a.length ? a.filter((x) => x.correct).length / a.length : null);
          const hits = T.filter((x) => x.correct);
          const nFlags = st.flagRTs.length + st.flagMiss;
          // fine-grained breakdowns ([n, hits]) for the Stats page
          const tally = (keyFn) => {
            const o = {};
            for (const x of T) {
              const k = keyFn(x);
              if (k == null) continue;
              const e = (o[k] = o[k] || [0, 0]);
              e[0]++;
              if (x.correct) e[1]++;
            }
            return o;
          };
          // call mode: calls can come after the flash, so read them off the hazards now
          for (const x of st.hzTrials) {
            x.live = !!(x.ref && x.ref.live);
            x.called = !!(x.ref && x.ref.calledTs != null);
          }
          const out = {
            seed,
            detail: {
              // compact per-target rows: [exposure ms, correct, window %, look-ahead cs, dir, blind, rt ms, km/h, category]
              trials: T.map((x) => [Math.round(x.exposure), x.correct ? 1 : 0, Math.round(x.f * 100), Math.round(x.previewTime * 100), x.dir, x.blind ? 1 : 0, x.rt == null ? -1 : Math.round(x.rt), Math.round(x.kmh), x.cat]),
            },
            summary: {
              byCat: tally((x) => x.cat),
              byDir: tally((x) => (x.dir < 0 ? 'L' : 'R')),
              byPhase: tally((x) => (x.f < 1 / 3 ? 'early' : x.f < 2 / 3 ? 'mid' : 'late')),
              bySpeed: tally((x) => (x.kmh < 120 ? 'slow' : x.kmh < 190 ? 'medium' : 'fast')),
              blind: tally((x) => (x.blind ? 'blind' : 'clear')),
              threshold: T.length >= 4 ? stair.threshold() : null,
              accuracy: acc(T),
              earlyAcc: acc(T.filter((x) => x.f < 1 / 3)),
              midAcc: acc(T.filter((x) => x.f >= 1 / 3 && x.f < 2 / 3)),
              lateAcc: acc(T.filter((x) => x.f >= 2 / 3)),
              previewTime: hits.length ? U.mean(hits.map((x) => x.previewTime)) : null,
              rt: hits.length ? U.median(hits.map((x) => x.rt)) : null,
              falseAlarms: st.fa,
              trials: T.length,
              flagHit: S.flags && nFlags ? st.flagRTs.length / nFlags : null,
              flagRT: S.flags && st.flagRTs.length ? U.median(st.flagRTs) : null,
              falseConfirms: S.flags && !race ? st.flagFA : null,
              ...J.summary(),
              ...(race ? race.summary() : {}),
              ...(hz ? def.hazardSummary(T, st.hzTrials, hz.level, callMode ? hz.callSummary() : null) : {}),
              loadCost: race && baseline && T.length >= 4 ? stair.threshold() - baseline : null,
            },
          };
          // per-target hazard rows: [hazard type or '', probe, outcome a/h/o/n, sudden, framing a/v(, called)]
          if (hz) out.detail.hazards = st.hzTrials.map((x) => [x.hz || '', x.probe ? 1 : 0, x.outcome[0], x.pop ? 1 : 0, x.framing === 'avoid' ? 'v' : 'a'].concat(callMode ? [x.called ? 1 : 0] : []));
          return out;
        },
      };
    },
  };

  // ------------------------------------------------------------ Race Mode
  const RACE_SETTINGS = [
    { key: 'intensity', label: 'Intensity', type: 'select', default: 'race', options: [['light', 'Light'], ['race', 'Race'], ['chaos', 'Chaos']] },
    { key: 'traffic', label: 'Traffic', type: 'bool', default: true },
    { key: 'relative', label: 'Relative', type: 'bool', default: true },
    { key: 'relPos', label: 'Relative position', type: 'select', default: 'right', options: [['right', 'Bottom right'], ['left', 'Bottom left']] },
    { key: 'dash', label: 'Dash', type: 'bool', default: true },
    { key: 'radio', label: 'Radio', type: 'bool', default: true },
    { key: 'audio', label: 'Audio', type: 'bool', default: true },
  ];

  const RACE = {
    id: 'apex-race',
    name: 'Apex Snap: Race Mode',
    category: 'Core · Race',
    raceMode: true,
    tagline: 'Apex Snap with race distractions.',
    description: 'Apex Snap with traffic, a relative box, dash, radio and spotter. Press Confirm only for threats: a car alongside or a marshal light.',
    research: BASE.research.concat([
      { point: 'Train with the information sources of competition.', source: 'Pinder et al. (2011), J. Sport Exerc. Psychol. 33(1).' },
      { point: 'Load pulls attention to salient distractors.', source: 'Eysenck et al. (2007), Emotion 7(2).' },
      { point: 'Training under pressure protects performance under pressure.', source: 'Oudejans & Pijpers (2009), Q. J. Exp. Psychol. 62(8).' },
      { point: 'Long glances away from the road raise crash risk.', source: 'Klauer et al. (2006), NHTSA DOT HS 810 594.' },
    ]),
    settings: BASE.settings
      .map((f) => (f.key === 'flags' ? Object.assign({}, f, { default: true }) : f))
      .filter((f) => f.key !== 'seed')
      .concat(RACE_SETTINGS),
    metrics: BASE.metrics
      .filter((m) => m.key !== 'falseConfirms')
      .concat([
        { key: 'loadCost', label: 'Load cost', unit: 'ms', digits: 0, better: 'lower', hint: 'Threshold here minus your latest Apex Snap threshold.' },
        { key: 'threatHit', label: 'Threats caught', pct: true, digits: 0, better: 'higher' },
        { key: 'threatRT', label: 'Threat response', unit: 'ms', digits: 0, better: 'lower' },
        { key: 'falseConfirms', label: 'Reacted to noise', digits: 0, better: 'lower' },
      ]),
    coach(s) {
      const tips = [];
      if (U.isNum(s.loadCost) && s.loadCost > 60)
        tips.push('Clutter costs ' + Math.round(s.loadCost) + ' ms. Look through the car ahead; check the relative only on straights.');
      if (U.isNum(s.threatHit) && s.threatHit < 0.7)
        tips.push('Missed cars alongside. Listen for the spotter; keep your eyes far.');
      if (s.falseConfirms >= 3) tips.push('Reacted to noise. Radio and dash warnings are not threats.');
      return tips.concat(BASE.coach(s));
    },
    analyze(results, A) {
      const out = BASE.analyze.call(this, results, A);
      const recent = results.slice(-5);
      const lcVals = A.values(results, 'loadCost');
      const lc = A.mean(lcVals.slice(-5));
      if (lc != null) {
        if (lc > 50) out.insim.push({ id: 'LOAD', score: 0.4 + Math.min(0.5, lc / 400), evidence: 'Load cost ~' + Math.round(lc) + ' ms' });
        const t = A.trend(lcVals, 'lower');
        if (t.enough && t.good && !t.flat) out.notes.push({ tone: 'good', text: this.name + ': load cost ' + Math.round(t.prior) + ' → ' + Math.round(t.recent) + ' ms.' });
      }
      const th = A.mean(A.values(recent, 'threatHit'));
      if (th != null && th < 0.75) out.insim.push({ id: 'THREATS', score: 0.35 + (0.75 - th), evidence: 'Cars alongside caught ' + Math.round(th * 100) + '%' });
      const fc = A.mean(A.values(recent, 'falseConfirms'));
      if (fc != null && fc >= 2) out.insim.push({ id: 'NOISE', score: 0.25 + Math.min(0.3, fc * 0.03), evidence: 'Noise reactions ' + fc.toFixed(1) + '/session' });
      return out;
    },
  };

  BASE.metrics.splice(BASE.metrics.length - 1, 0, { key: 'falseConfirms', label: 'False confirms', digits: 0, better: 'lower' });
  BASE.metrics.splice(BASE.metrics.length - 1, 0, ...IST.Juice.METRICS);
  RACE.metrics.splice(RACE.metrics.length, 0, ...IST.Juice.METRICS);

  IST.registerDrill(BASE);
  IST.registerDrill(Object.assign({}, BASE, RACE));
  IST.ApexSnap = { BASE }; // shared engine for variants in other tabs (e.g. Eyes Off the Wall)
})();
