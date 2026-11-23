/*
 * Eyes Off the Wall: holding the apex while a threat competes for your eyes.
 *
 * Built on the Apex Snap engine. On hazard corners a barrier sits on the
 * outside (where you'd go if you overcooked it), with a wall, wreck, waved
 * yellow or spinning car on it. The barrier carries its own masked board.
 * On probe trials both boards flash different arrows for the same brief,
 * masked exposure, so the arrow you report shows where your eyes were:
 *   apex arrow   -> eyes held the apex (hit)
 *   hazard arrow -> eyes were captured by the threat
 *
 * Trains the opposite of target fixation ("look at the wall, hit the wall"):
 * stimulus-driven capture by threat (Theeuwes et al., 1998; Eysenck et al.,
 * 2007) and ironic effects of "don't" instructions (Wegner et al., 1998;
 * Binsch et al., 2010). Optional compare mode alternates approach and
 * avoidance cues so you see the ironic effect in your own data.
 *
 * Threat level (1-6) adapts between sessions; the flash staircase adapts
 * within a session as in Apex Snap. Corners without hazards are interleaved,
 * so "threat cost" compares like with like.
 */
(function () {
  'use strict';
  const U = IST.util, HL = IST.HazardLayer, BASE = IST.ApexSnap.BASE;
  const MIN_PROBES = 8;
  const LEVEL_UP = { capture: 0.12, cost: 0.08 };
  const LEVEL_DOWN = { capture: 0.3, cost: 0.25 };

  // corrected capture: wrong-arrow answers are guesses; a guess hits the hazard arrow
  // as often as each of the other two non-apex arrows, so subtract half of them
  const corrected = (hazard, other, n) => (n ? Math.max(0, hazard - other / 2) / n : null);

  const settings = [];
  BASE.settings.forEach((f) => {
    if (f.key === 'flags') return; // marshal lights would compete with the hazards
    settings.push(f.key === 'duration' ? Object.assign({}, f, { default: 240 }) : f);
    if (f.key === 'feedback') {
      settings.push(
        { key: 'threat', label: 'Threat level', type: 'select', default: 'auto', options: [['auto', 'Auto (adapts)']].concat([1, 2, 3, 4, 5, 6].map((n) => [String(n), String(n)])), hint: 'More hazards, more sudden, closer to the edge.' },
        { key: 'framing', label: 'Self-talk', type: 'select', default: 'approach', options: [['approach', '"Eyes: apex"'], ['compare', 'Compare with "Don\'t look at the wall"']], hint: 'Compare alternates the two cues every 40 s.' },
        { key: 'audio', label: 'Impact sound', type: 'bool', default: true, hint: 'Threat level 5+.' }
      );
    }
  });

  const DEF = Object.assign({}, BASE, {
    id: 'eyes-off-wall',
    name: 'Eyes Off the Wall',
    tab: 'mind',
    category: 'Pressure',
    hazardMode: true,
    tagline: 'Hold the apex when the wall is right there.',
    description:
      'Apex Snap with threats on the outside of corners: walls, wrecks, yellow flags and spinning cars. ' +
      'The hazard has its own board. When both flash, press the arrow you saw: it shows where your eyes were. ' +
      'Threat level rises as your eyes stop getting pulled.',
    research: [
      { point: 'Sudden new objects pull the eyes, often without you noticing.', source: 'Theeuwes, Kramer, Hahn & Irwin (1998), Psychological Science 9(5).' },
      { point: 'Anxiety shifts attention from goals to threats and salient stimuli.', source: 'Eysenck, Derakshan, Santos & Calvo (2007), Emotion 7(2).' },
      { point: '"Don\'t overshoot" under load made golfers overshoot.', source: 'Wegner, Ansfield & Pilloff (1998), Psychological Science 9(3).' },
      { point: 'Told to avoid the keeper, penalty takers\' misses came with shorter final fixations on the open goal.', source: 'Binsch, Oudejans, Bakker & Savelsbergh (2010), Human Movement Science 29(2).' },
      { point: 'Naming what to avoid, not just the word "don\'t", drives the effect.', source: 'Binsch et al. (2010), Int. J. Sport Psychol.' },
      { point: 'Anxious performers fixate the target for less time.', source: 'Wilson, Vine & Wood (2009), J. Sport Exerc. Psychol. 31(2).' },
      { point: 'Practising under pressure improves performance under pressure (g ≈ 0.67).', source: 'Low, Sandercock, Freeman, Winter, Butt & Maynard (2021), Sport, Exercise, and Performance Psychology.' },
      { point: 'Rider coaching: target fixation is a survival reaction to train out. Look where you want to go.', source: 'Code (1993), A Twist of the Wrist II.' },
      { point: 'Brief masked flashes reward eyes already in place.', source: 'Posner (1980); Breitmeyer & Ögmen (2006), Visual Masking.' },
    ],
    settings,
    metrics: [
      { key: 'captureRate', label: 'Eyes captured', pct: true, digits: 0, better: 'lower', primary: true, hint: 'Hazard probes where you read the hazard board, corrected for guessing.' },
      { key: 'hazardCost', label: 'Threat cost', pct: true, digits: 0, better: 'lower', hint: 'Apex accuracy on clean corners minus on hazard corners (points).' },
      { key: 'level', label: 'Threat level', digits: 0, better: 'higher' },
      { key: 'hazardAcc', label: 'Apex, hazard corners', pct: true, digits: 0, better: 'higher' },
      { key: 'cleanAcc', label: 'Apex, clean corners', pct: true, digits: 0, better: 'higher' },
      { key: 'ironic', label: '"Don\'t look" effect', pct: true, digits: 0, better: 'lower', hint: 'Capture under "Don\'t look at the wall" minus under "Eyes: apex" (compare mode).' },
      { key: 'threshold', label: 'Flash threshold', unit: 'ms', digits: 0, better: 'lower', hint: 'Shortest flash read ~71% of the time.' },
      { key: 'earlyAcc', label: 'Snap score', pct: true, digits: 0, better: 'higher', hint: 'Accuracy on flashes just after the previous apex.' },
      { key: 'falseAlarms', label: 'False presses', digits: 0, better: 'lower' },
      { key: 'probes', label: 'Hazard probes', digits: 0 },
      ...IST.Juice.METRICS,
      { key: 'trials', label: 'Targets', digits: 0 },
    ],

    /** Threat level for a new run: fixed by setting, or the last run's recommendation. */
    levelFor(S, history) {
      if (S.threat && S.threat !== 'auto') return U.clamp(Number(S.threat) || 1, 1, HL.MAX_LEVEL);
      for (let i = history.length - 1; i >= 0; i--) {
        const s = history[i].summary;
        if (s && U.isNum(s.nextLevel)) return s.nextLevel;
        if (s && U.isNum(s.level)) return s.level;
      }
      return 1;
    },

    /** Hazard metrics from the per-target rows (T from Apex Snap, H parallel hazard info). */
    hazardSummary(T, H, level) {
      const idx = T.map((_, i) => i);
      const hzI = idx.filter((i) => H[i].hz), clean = idx.filter((i) => !H[i].hz);
      const probes = idx.filter((i) => H[i].probe);
      const count = (arr, o) => arr.filter((i) => H[i].outcome === o).length;
      const acc = (arr) => (arr.length ? arr.filter((i) => T[i].correct).length / arr.length : null);
      const capOf = (arr) => corrected(count(arr, 'hazard'), count(arr, 'other'), arr.length);
      const tally = (arr, keyFn, hitFn) => {
        const o = {};
        for (const i of arr) {
          const k = keyFn(i);
          const e = (o[k] = o[k] || [0, 0]);
          e[0]++;
          if (hitFn(i)) e[1]++;
        }
        return o;
      };
      const isHit = (i) => T[i].correct, isCap = (i) => H[i].outcome === 'hazard';

      const nP = probes.length;
      const captureRate = nP ? capOf(probes) : null;
      const hazardAcc = acc(hzI), cleanAcc = acc(clean);
      const hazardCost = hzI.length >= 4 && clean.length >= 4 ? cleanAcc - hazardAcc : null;
      const pa = probes.filter((i) => H[i].framing === 'approach'), pv = probes.filter((i) => H[i].framing === 'avoid');
      const ironic = pa.length >= 4 && pv.length >= 4 ? capOf(pv) - capOf(pa) : null;

      let nextLevel = level;
      if (nP >= MIN_PROBES && captureRate != null) {
        if (captureRate <= LEVEL_UP.capture && (hazardCost == null || hazardCost <= LEVEL_UP.cost)) nextLevel = Math.min(HL.MAX_LEVEL, level + 1);
        else if (captureRate >= LEVEL_DOWN.capture || (hazardCost != null && hazardCost >= LEVEL_DOWN.cost)) nextLevel = Math.max(1, level - 1);
      }

      return {
        level, nextLevel,
        probes: nP,
        captureRate,
        captureRaw: nP ? count(probes, 'hazard') / nP : null,
        hazardAcc, cleanAcc, hazardCost, ironic,
        gaze: { apex: count(probes, 'apex'), hazard: count(probes, 'hazard'), other: count(probes, 'other'), none: count(probes, 'none') },
        byCorner: { clean: [clean.length, clean.filter(isHit).length], hazard: [hzI.length, hzI.filter(isHit).length] },
        byHz: tally(hzI, (i) => H[i].hz, isHit),
        capByHz: tally(probes, (i) => H[i].hz, isCap),
        byPop: tally(hzI, (i) => (H[i].pop ? 'sudden' : 'present'), isHit),
        capByFrame: tally(probes, (i) => H[i].framing, isCap),
      };
    },

    coach(s, result) {
      const tips = [];
      const pc = (x) => Math.round(x * 100);
      if (s.probes < MIN_PROBES) tips.push('Only ' + s.probes + ' hazard probes. Run 4+ minutes for a reliable capture score.');
      if (U.isNum(s.captureRate) && s.probes >= MIN_PROBES) {
        if (s.captureRate >= 0.25) tips.push('The hazard took your eyes on ~' + pc(s.captureRate) + '% of probes. Pick the apex before the hazard registers, and hold it.');
        else if (s.captureRate <= 0.1) tips.push('Eyes held the apex. The hazards stayed in your periphery.');
      }
      if (U.isNum(s.hazardCost) && s.hazardCost >= 0.15)
        tips.push('Hazard corners cost ' + pc(s.hazardCost) + ' pts of apex accuracy. Get your eyes to the apex before the hazard comes into view.');
      if (U.isNum(s.ironic)) {
        if (s.ironic >= 0.08) tips.push('"Don\'t look at the wall" raised capture by ' + pc(s.ironic) + ' pts. Tell yourself where to look ("apex", "exit"), not what to avoid.');
        else tips.push('Avoidance cues didn\'t pull your eyes this run (' + (s.ironic >= 0 ? '+' : '−') + pc(Math.abs(s.ironic)) + ' pts).');
      }
      if (s.gaze && s.probes >= MIN_PROBES && s.gaze.other / s.probes > 0.3) tips.push('Many wrong arrows. Press only what you saw.');
      const auto = !result || !result.settings || result.settings.threat === 'auto';
      if (auto && U.isNum(s.nextLevel) && s.nextLevel !== s.level)
        tips.push(s.nextLevel > s.level ? 'Threat level up next run: ' + s.level + ' → ' + s.nextLevel + '.' : 'Threat level eased next run: ' + s.level + ' → ' + s.nextLevel + '.');
      if (s.trials < 12) tips.push('Short run. Aim for 4 minutes.');
      return tips;
    },

    analyze(results, A) {
      const recent = results.slice(-10);
      const out = { breakdowns: [], notes: [], insim: [] };
      const name = this.name, sub = 'Last ' + recent.length + ' session' + (recent.length === 1 ? '' : 's');
      const pc = (x) => Math.round(x * 100) + '%';

      // where the eyes were on probes
      const gz = { apex: 0, hazard: 0, other: 0, none: 0 };
      for (const r of recent) {
        const g = r.summary && r.summary.gaze;
        if (g) for (const k in gz) gz[k] += g[k] || 0;
      }
      const nP = gz.apex + gz.hazard + gz.other + gz.none;
      if (!nP) return out;
      out.breakdowns.push({
        title: 'Where your eyes were', subtitle: sub + ' · hazard probes', pct: true,
        items: [
          { label: 'Apex', value: gz.apex / nP, n: nP },
          { label: 'Hazard board', value: gz.hazard / nP, n: nP },
          { label: 'Neither / no answer', value: (gz.other + gz.none) / nP, n: nP },
        ],
      });
      const corner = A.sumTallies(recent, 'byCorner');
      out.breakdowns.push({ title: 'Apex accuracy', subtitle: sub, pct: true, items: A.items(corner, ['clean', 'hazard'], { clean: 'Clean corners', hazard: 'Hazard corners' }) });
      const byHz = A.sumTallies(recent, 'byHz');
      out.breakdowns.push({ title: 'Apex accuracy by hazard', subtitle: sub, pct: true, items: A.items(byHz, ['wall', 'wreck', 'yellow', 'spin'], HL.TYPE_LABELS) });
      // capture by hazard: higher is worse, so tag the highest bucket instead of the lowest
      const capItems = A.items(A.sumTallies(recent, 'capByHz'), ['wall', 'wreck', 'yellow', 'spin'], HL.TYPE_LABELS).map((i) => Object.assign(i, { tag: undefined }));
      const judged = capItems.filter((i) => i.n >= A.MIN_N);
      if (judged.length >= 2) {
        const hi = judged.reduce((a, b) => (b.value > a.value ? b : a)), lo = judged.reduce((a, b) => (b.value < a.value ? b : a));
        if (hi.value - lo.value >= 0.1) hi.tag = 'pulls most';
      }
      out.breakdowns.push({ title: 'Hazard board read', subtitle: sub + ' · lower is better', pct: true, items: capItems });
      const pop = A.sumTallies(recent, 'byPop');
      if (pop.sudden && pop.present) out.breakdowns.push({ title: 'Hazard onset', subtitle: sub, pct: true, items: A.items(pop, ['present', 'sudden'], { present: 'Already there', sudden: 'Sudden' }) });
      const fr = A.sumTallies(recent, 'capByFrame');
      if (fr.avoid && fr.avoid[0]) {
        out.breakdowns.push({
          title: 'Hazard board read by self-talk', subtitle: sub + ' · lower is better', pct: true,
          items: A.items(fr, ['approach', 'avoid'], { approach: '"Eyes: apex"', avoid: '"Don\'t look at the wall"' }).map((i) => Object.assign(i, { tag: undefined })),
        });
      }

      // capture
      const capVals = A.values(results, 'captureRate');
      const cap = A.mean(capVals.slice(-5));
      if (cap != null && cap >= 0.2) {
        out.notes.push({ tone: 'bad', text: name + ': hazards took your eyes on ~' + pc(cap) + ' of probes.' });
        out.insim.push({ id: 'TARGET_FIX', score: 0.45 + cap, evidence: 'Eyes on the hazard ~' + pc(cap) + ' of probes' });
      }
      const levels = A.values(results, 'level').filter(U.isNum);
      if (levels.length >= 2 && levels[levels.length - 1] > levels[0]) {
        out.notes.push({ tone: 'good', text: name + ': threat level ' + levels[0] + ' → ' + levels[levels.length - 1] + '.' });
      }
      const cost = A.mean(A.values(results, 'hazardCost').slice(-5));
      if (cost != null && cost >= 0.15) {
        out.notes.push({ tone: 'bad', text: name + ': hazard corners cost ' + Math.round(cost * 100) + ' pts of apex accuracy.' });
        out.insim.push({ id: 'TARGET_FIX', score: 0.3 + cost, evidence: 'Hazard corners ' + Math.round(cost * 100) + ' pts below clean corners' });
      }
      if (pop.sudden && pop.present && pop.sudden[0] >= A.MIN_N && pop.present[0] >= A.MIN_N) {
        const gap = A.acc(pop.present) - A.acc(pop.sudden);
        if (gap >= 0.12) out.insim.push({ id: 'SUDDEN', score: 0.3 + gap, evidence: 'Sudden ' + pc(A.acc(pop.sudden)) + ' vs already there ' + pc(A.acc(pop.present)) });
      }
      const iron = A.mean(A.values(recent, 'ironic'));
      if (iron != null) {
        if (iron >= 0.08) {
          out.notes.push({ tone: 'bad', text: name + ': "don\'t look at the wall" raised capture by ' + Math.round(iron * 100) + ' pts.' });
          out.insim.push({ id: 'IRONIC', score: 0.35 + iron, evidence: '"Don\'t look" cue +' + Math.round(iron * 100) + ' pts capture' });
        } else if (iron <= 0.02) {
          out.notes.push({ tone: 'good', text: name + ': avoidance cues aren\'t pulling your eyes.' });
        }
      }
      return out;
    },
  });

  IST.registerDrill(DEF);
})();
