/*
 * Analysis engine for the Stats page: trends, personal bests, consistency,
 * weak-spot detection and in-sim recommendations.
 *
 * Generic analysis works for any drill from its metric definitions. A drill
 * can add domain-specific breakdowns and advice by defining
 *   analyze(results, A) -> { breakdowns: [...], notes: [...], insim: [...] }
 * where A is this module (helpers + tip library).
 *
 * Shapes:
 *   breakdown = { title, subtitle?, items: [{ label, value, n, tag? }], pct: true }
 *   note      = { tone: 'good'|'bad'|'info', text, drill? }
 *   insim     = { id (TIPS key), score (priority), evidence, drill? }
 */
(function () {
  'use strict';
  const U = IST.util;
  const A = {};

  A.MIN_N = 6; // minimum targets in a bucket before we judge it

  A.CAT_LABELS = {
    kink: 'Kinks', sweeper: 'Sweepers', medium: 'Medium corners', tight: 'Tight corners', hairpin: 'Hairpins',
    tightening: 'Decreasing radius', opening: 'Increasing radius', chicane: 'Chicanes', esses: 'Esses', double: 'Double apex', familiar: 'Familiar corners',
  };

  // In-sim advice library. `train` = drill that trains it.
  A.TIPS = {
    EARLY_SNAP: { title: 'Move your eyes at the apex', text: 'Say "next" as you clip each apex and look to the next corner on that word. 5 focused laps, then compare sectors.', train: 'apex-snap' },
    HAIRPIN: { title: 'Hairpins: look across early', text: 'Eyes (and head) to the apex kerb before turn-in, then the exit.', train: 'apex-snap' },
    CHICANE: { title: 'Chicanes: see apex two from apex one', text: 'At the first apex, your eyes should already be on the second. Drill one chicane in hotlap.', train: 'apex-snap' },
    ESSES: { title: 'Esses: stay one corner ahead', text: 'Late hands mean your eyes were on the bend you were already in.', train: 'apex-snap' },
    DOUBLE: { title: 'Double apex: look for the second', text: 'Glance at apex one, then commit your eyes to apex two early.', train: 'apex-snap' },
    TIGHTENING: { title: 'Decreasing radius: hold the late apex', text: 'Find the late apex early and keep your eyes there through entry.', train: 'apex-snap' },
    OPENING: { title: 'Increasing radius: eyes to the exit', text: 'Look to the exit kerb as soon as you clip the early apex.', train: 'apex-snap' },
    FAST: { title: 'Fast corners: look further', text: 'Pick a point well past the apex. Low eyes at speed make steering twitchy.', train: 'apex-snap' },
    SLOW: { title: 'Slow corners: keep your eyes moving', text: 'Apex, exit, next braking point, while the car is still rotating.', train: 'apex-snap' },
    TIGHT: { title: 'Tight corners: eyes before the car', text: 'Pick the apex before releasing the brake, then move straight to the exit.', train: 'apex-snap' },
    CREST: { title: 'Blind crests: look where the road will be', text: 'Learn a reference beyond each crest and hold your eyes there until the apex appears.', train: 'apex-snap' },
    DIR_LEFT: { title: 'Weaker on left-handers', text: 'Check monitor centring, FOV symmetry and head-tracking centre.', train: 'apex-snap' },
    DIR_RIGHT: { title: 'Weaker on right-handers', text: 'Check monitor centring, FOV symmetry and head-tracking centre.', train: 'apex-snap' },
    TUNNEL: { title: 'Widen your attention', text: 'On straights, eyes far, and name what you see in your periphery without looking.', train: 'two-point' },
    GAZE_DRIFT: { title: 'Keep your eyes up', text: 'Don\'t drop your eyes to the near kerb. Let peripheral vision place the car.', train: 'two-point' },
    SIDE_LEFT: { title: 'Left periphery is weaker', text: 'Check monitor centring. Use the spotter for that side.', train: 'two-point' },
    SIDE_RIGHT: { title: 'Right periphery is weaker', text: 'Check monitor centring. Use the spotter for that side.', train: 'two-point' },
    LOAD: { title: 'Short HUD glances, on straights only', text: 'Move the relative closer to your line of sight. Never check it in braking or at turn-in.', train: 'apex-race' },
    THREATS: { title: 'Trust the spotter', text: 'On "car left/right", hold your line and keep your eyes on the apex.', train: 'apex-race' },
    NOISE: { title: 'Ignore radio and dash noise', text: 'Decide which info you act on. Turn off non-essential dash warnings.', train: 'apex-race' },
    TARGET_FIX: { title: 'Look where you want to go', text: 'At walled corners, pick the apex before the braking board and say "apex" as you brake. The wall stays in your periphery; your hands follow your eyes.', train: 'eyes-off-wall' },
    SUDDEN: { title: 'Let incidents register peripherally', text: 'When a car goes off ahead, look only if it\'s on your line. Otherwise eyes stay on the apex and the spotter fills in the rest.', train: 'eyes-off-wall' },
    HAZ_MISS: { title: 'Notice hazards without looking', text: 'A wreck, a waved yellow or a spinning car is big, bright or moving: it registers in your periphery. Call it ("yellow!") and keep your eyes on the apex.', train: 'eyes-off-wall-call' },
    HAZ_LOOK: { title: 'Call it, don\'t check it', text: 'If you have to look to be sure, the hazard already has your eyes. Trust the first peripheral read, call it, and stay on the apex. Look only if it\'s on your line.', train: 'eyes-off-wall-call' },
    IRONIC: { title: 'Say what to do, not what to avoid', text: '"Brake at the 100", "hit the apex", not "don\'t lock up" or "don\'t touch the wall". Naming the thing you want to avoid pulls your eyes to it.', train: 'eyes-off-wall' },
    ERROR_CHAIN: { title: 'One mistake, then a normal corner', text: 'After a mistake, breathe out on the next straight, name the next brake board and drive it like any other lap. The time isn\'t lost until the second mistake.', train: 'clean-slate' },
    HESITANT: { title: 'Don\'t back off after a mistake', text: 'After an off or a lock-up, drive the next corner at your normal reference, not a "safe" one. The tentative lap costs more than the mistake did.', train: 'clean-slate' },
    RUSHING: { title: 'Don\'t chase the time back', text: 'After a mistake the urge is to brake later to make it up. Hit your normal brake point; the next clean lap gets the time back.', train: 'clean-slate' },
    DISTRACT: { title: 'Let the noise pass', text: 'Decide what you act on (spotter, flags, the car ahead) and let chat, radio and dash pings pass without a glance.', train: 'clean-slate' },
    LINE_EARLY: { title: 'Turn in later than feels natural', text: 'If you wait at the exit for the car to come back to you, you turned in early. Move the turn-in reference a car length later and find the apex before you steer.', train: 'racing-line' },
    LINE_LATE: { title: 'Don\'t over-delay the apex', text: 'A very late apex costs entry speed that the exit can\'t use. If you are waiting on the throttle at the apex, turn in a little earlier.', train: 'racing-line' },
    LINE_WIDTH: { title: 'Use all the track', text: 'Outside edge at turn-in, kerb at the apex, out to the exit kerb. Every metre of width you leave tightens the arc and slows the corner.', train: 'racing-line' },
    LINE_PRIORITY: { title: 'Prioritise the corner onto the straight', text: 'In a complex, set up the last corner before a long straight even if the one before it gets slower. Exit speed is carried all the way down the straight.', train: 'racing-line' },
    MC_DIVE: { title: 'Pass where the speed gap does it for you', text: 'In class traffic, judge on the straight whether you\'ll be clear before the braking zone. If not, sit behind and use the exit: a dive at a car that is turning in is the classic multiclass crash.', train: 'multiclass' },
    MC_PREDICT: { title: 'Be predictable when you\'re being caught', text: 'Stay on your normal line and braking point. Moving across to "help", braking early, or covering a side the faster car has already committed to is what causes the contact. If you cover the inside, do it once, early, before it commits.', train: 'multiclass' },
    MC_ROOM: { title: 'Leave room for a car alongside', text: 'If the faster car will be alongside at the braking zone, ease off early or turn in behind it. Holding your line only works if it will be clear first.', train: 'multiclass' },
    MC_MIRROR: { title: 'Mirror before you pull out', text: 'Catching a slower car with a prototype behind is how big multiclass crashes start. Check the mirror before every pass on a straight; if it\'s close, let it through first.', train: 'multiclass' },
    MC_PATIENCE: { title: 'Don\'t give away time you don\'t need to', text: 'If it will be past before the braking zone anyway, your normal line is the most useful thing you can give it. Lift only when it would otherwise be stuck behind you.', train: 'multiclass' },
    STARTS_JUMP: { title: 'Starts: react, don\'t predict', text: 'Practise standing starts. Go on lights-out, not on a rhythm.', train: 'start-lights' },
    STARTS_SLOW: { title: 'Warm up before starts', text: 'Run Start Lights before qualifying and races.', train: 'start-lights' },
    CONSISTENCY: { title: 'Same routine every session', text: 'Warm up the same way each time and judge the trend, not single sessions.', train: null },
  };

  // ------------------------------------------------------------ helpers
  A.acc = (e) => (e && e[0] ? e[1] / e[0] : null);
  A.values = (results, key) => results.map((r) => (r.summary && U.isNum(r.summary[key]) ? r.summary[key] : null));
  A.mean = (vals) => {
    const v = vals.filter(U.isNum);
    return v.length ? U.mean(v) : null;
  };
  A.sumTallies = function (results, key) {
    const out = {};
    for (const r of results) {
      const t = r.summary && r.summary[key];
      if (!t) continue;
      for (const k in t) {
        const e = (out[k] = out[k] || [0, 0]);
        e[0] += t[k][0];
        e[1] += t[k][1];
      }
    }
    return out;
  };
  A.total = (tally) => Object.values(tally).reduce((a, e) => [a[0] + e[0], a[1] + e[1]], [0, 0]);

  A.rolling = function (values, w) {
    const out = [];
    for (let i = 0; i < values.length; i++) {
      const win = values.slice(Math.max(0, i - w + 1), i + 1).filter(U.isNum);
      out.push(win.length && U.isNum(values[i]) ? U.mean(win) : null);
    }
    return out;
  };

  A.pb = function (values, better) {
    let best = null, idx = -1;
    values.forEach((v, i) => {
      if (!U.isNum(v)) return;
      if (best === null || (better === 'lower' ? v < best : v > best)) {
        best = v;
        idx = i;
      }
    });
    return { value: best, idx };
  };

  /** Recent block vs the block before it (k = up to 5 sessions each). */
  A.trend = function (values, better) {
    const v = values.filter(U.isNum);
    const n = v.length;
    if (n < 4) return { n, enough: false };
    const k = Math.min(5, Math.floor(n / 2));
    const recent = U.mean(v.slice(-k)), prior = U.mean(v.slice(-2 * k, -k));
    const first = U.mean(v.slice(0, Math.min(3, n))), last = U.mean(v.slice(-Math.min(3, n)));
    const pct = prior !== 0 ? (recent - prior) / Math.abs(prior) : 0;
    const total = first !== 0 ? (last - first) / Math.abs(first) : 0;
    const good = better === 'lower' ? pct < 0 : pct > 0;
    const totalGood = better === 'lower' ? total < 0 : total > 0;
    return { n, k, enough: true, recent, prior, pct, good, flat: Math.abs(pct) < 0.03, first, last, total, totalGood };
  };

  A.cv = function (values) {
    const v = values.filter(U.isNum).slice(-10);
    if (v.length < 5) return null;
    const m = U.mean(v);
    return m ? U.sd(v) / Math.abs(m) : null;
  };

  A.fmt = (m, v) => (U.isNum(v) ? (m.pct ? U.fmt(v * 100, m.digits) + '%' : U.fmt(v, m.digits) + (m.unit ? ' ' + m.unit : '')) : '–');
  A.pctTxt = (x) => Math.round(Math.abs(x) * 100) + '%';
  A.dayKey = (t) => {
    const d = new Date(t);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  A.shortDate = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

  /** Bucket list -> breakdown items; weakest bucket with enough data gets a tag. */
  A.items = function (tally, order, labels) {
    const keys = order || Object.keys(tally);
    const items = keys
      .filter((k) => tally[k] && tally[k][0] > 0)
      .map((k) => ({ key: k, label: (labels && labels[k]) || k, value: A.acc(tally[k]), n: tally[k][0] }));
    const judged = items.filter((i) => i.n >= A.MIN_N);
    if (judged.length >= 2) {
      const worst = judged.reduce((a, b) => (b.value < a.value ? b : a));
      const best = judged.reduce((a, b) => (b.value > a.value ? b : a));
      if (best.value - worst.value >= 0.1) worst.tag = 'weakest';
    }
    return items;
  };

  // ------------------------------------------------------------ reports
  A.drillReport = function (def, results) {
    const pm = IST.primaryMetric(def);
    const values = A.values(results, pm.key);
    const rep = {
      def, results, pm, values,
      pb: A.pb(values, pm.better),
      trend: A.trend(values, pm.better),
      cv: A.cv(values),
      notes: [], insim: [], breakdowns: [],
    };
    const t = rep.trend;
    const name = def.name;
    if (results.length && results.length < 4) {
      rep.notes.push({ tone: 'info', drill: def.id, text: name + ': ' + (4 - results.length) + ' more session' + (4 - results.length === 1 ? '' : 's') + ' for trends.' });
    }
    if (t.enough && !t.flat) {
      rep.notes.push({
        tone: t.good ? 'good' : 'bad', drill: def.id,
        text: name + ': ' + pm.label.toLowerCase() + ' ' + A.pctTxt(t.pct) + (t.good ? ' better' : ' worse') + ' (' + A.fmt(pm, t.prior) + ' → ' + A.fmt(pm, t.recent) + ').',
      });
    } else if (t.enough && t.n >= 10) {
      rep.notes.push({ tone: 'info', drill: def.id, text: name + ': plateau. Raise the difficulty.' });
    }
    if (t.enough && t.n >= 8 && t.totalGood && Math.abs(t.total) >= 0.05) {
      rep.notes.push({ tone: 'good', drill: def.id, text: name + ': ' + A.pctTxt(t.total) + ' better since you started (' + A.fmt(pm, t.first) + ' → ' + A.fmt(pm, t.last) + ').' });
    }
    if (rep.pb.idx === values.length - 1 && values.filter(U.isNum).length >= 2) {
      rep.notes.push({ tone: 'good', drill: def.id, text: name + ': new PB (' + A.fmt(pm, rep.pb.value) + ').' });
    }
    if (rep.cv != null && rep.cv > 0.25) {
      rep.notes.push({ tone: 'bad', drill: def.id, text: name + ': inconsistent (±' + Math.round(rep.cv * 100) + '%).' });
      rep.insim.push({ id: 'CONSISTENCY', score: 0.2 + rep.cv * 0.3, evidence: '±' + Math.round(rep.cv * 100) + '% between sessions', drill: def.id });
    }
    if (def.analyze && results.length) {
      const extra = def.analyze(results, A) || {};
      rep.breakdowns = extra.breakdowns || [];
      rep.notes = rep.notes.concat((extra.notes || []).map((n) => Object.assign({ drill: def.id }, n)));
      rep.insim = rep.insim.concat((extra.insim || []).map((n) => Object.assign({ drill: def.id }, n)));
    }
    return rep;
  };

  /** Merge in-sim advice across drills: one entry per tip, highest priority wins, evidence combined. */
  A.mergeInsim = function (reports) {
    const byId = {};
    for (const r of reports) {
      for (const s0 of r.insim) {
        const s = Object.assign({}, s0, { evidence: r.def.name + ': ' + s0.evidence });
        const e = byId[s.id];
        if (!e) byId[s.id] = { id: s.id, score: s.score, evidence: [s.evidence], drills: [s.drill] };
        else {
          e.score = Math.max(e.score, s.score) + 0.05;
          e.evidence.push(s.evidence);
          if (e.drills.indexOf(s.drill) < 0) e.drills.push(s.drill);
        }
      }
    }
    return Object.values(byId).sort((a, b) => b.score - a.score);
  };

  A.overview = function (allResults) {
    const sessions = allResults.length;
    const ms = allResults.reduce((s, r) => s + (r.durationMs || 0), 0);
    const days = new Set(allResults.map((r) => A.dayKey(r.date)));
    // streak: consecutive days ending today (or yesterday) with at least one session
    const allDays = new Set(IST.drills.flatMap((d) => IST.Storage.getResults(d.id)).map((r) => A.dayKey(r.date)));
    let streak = 0;
    const d = new Date();
    if (!allDays.has(A.dayKey(d.getTime()))) d.setDate(d.getDate() - 1);
    while (allDays.has(A.dayKey(d.getTime()))) {
      streak++;
      d.setDate(d.getDate() - 1);
    }
    return { sessions, minutes: ms / 60000, activeDays: days.size, streak };
  };

  IST.Analysis = A;
})();
