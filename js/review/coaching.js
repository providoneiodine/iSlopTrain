/*
 * The Coaching tab's analysis: per corner and per lap, the time lost against the quickest lap through
 * that corner (the reference included, though it is never coached itself), and what the lap did
 * differently there in grip used, balance and the pedals. IST.Review.Coaching.report(cmp) -> { alone, laps, rows, focus, drills, ideal, spread }.
 */
(function () {
  'use strict';
  IST.Review = IST.Review || {};
  const KB = () => IST.Review.CoachKB;
  const DEG = Math.PI / 180;

  // which pattern explains a phase best when several match, root causes first
  const ORDER = ['off', 'lock', 'trail', 'entryUs', 'cliff', 'overslow', 'softPeak', 'lift', 'unusedIn', 'exitOs', 'overdrive', 'pump', 'lateThrottle', 'partThrottle', 'unusedOut'];
  const NEAR = 150; // m: how far either side of a stretch's start its braking may begin

  /** Mean of a channel over [i0, i1], skipping gaps; NaN when the file has no such channel. */
  function avg(a, i0, i1, f) {
    if (!a) return NaN;
    let s = 0, n = 0;
    for (let i = Math.max(0, i0); i <= Math.min(a.length - 1, i1); i++) {
      const v = f ? f(a[i]) : a[i];
      if (isFinite(v)) (s += v), n++;
    }
    return n ? s / n : NaN;
  }

  /**
   * What lap L did on [a, b]. The braking zone is the one starting nearest the stretch's start (its
   * first corner), turn-in is where steering passes 30 % of its peak in that corner, and the first
   * corner's slowest point (iMin1) ends the entry measures; iRef is the reference's slowest point.
   */
  function measure(L, a, b, iRef, step, R) {
    const { t, speed, brake, throttle, steer } = L, back = Math.round(NEAR / step);
    let iMin = a;
    for (let i = a; i <= Math.min(b, iRef + back); i++) if (speed[i] < speed[iMin]) iMin = i;
    const m = { iMin, minV: speed[iMin], braked: false, coast: 0, lift: 0, tPeak: 0, peak: 0, release: NaN, tThr: NaN, ramp: NaN, half: NaN, pumps: 0,
      brakeTurn: NaN, trailIn: NaN, gripIn: NaN, gripOut: NaN, gripMin: NaN, usIn: NaN, ev: {} };
    if (!brake || !throttle) return m;
    let iB = -1;
    for (let i = Math.max(0, a - back); i <= Math.min(b, a + back); i++) if (brake[i] > 0.1) { iB = i; break; }
    let iEnd = -1, iMin1 = iMin;
    if (iB >= 0) {
      while (iB > 0 && brake[iB - 1] > 0.05) iB--;
      iEnd = iB;
      while (iEnd < b && brake[iEnd + 1] > 0.02) iEnd++;
      iMin1 = iEnd;
      for (let i = iEnd; i <= Math.min(b, iEnd + back); i++) if (speed[i] < speed[iMin1]) iMin1 = i;
      let pk = 0;
      for (let i = iB; i <= iEnd; i++) pk = Math.max(pk, brake[i]);
      let i90 = iB, i50 = iB;
      while (i90 < iEnd && brake[i90] < 0.9 * pk) i90++;
      for (let i = iB; i <= iEnd; i++) if (brake[i] >= 0.5 * pk) i50 = i;
      Object.assign(m, { braked: true, peak: pk, tPeak: t[i90] - t[iB], release: t[iEnd] - t[i50] });
      let iL = iB;
      while (iL > Math.max(0, iB - back) && throttle[iL - 1] < 0.9) iL--;
      m.lift = t[iB] - t[iL];
      // turn-in, and how much brake was still on there and for how long after
      if (steer) {
        let top = 0;
        for (let i = iB; i <= iMin1; i++) top = Math.max(top, Math.abs(steer[i]));
        let iT = iB;
        while (iT < iMin1 && Math.abs(steer[iT]) < 0.3 * top) iT++;
        // trailing ends where the brake first drops away after turn-in, not at a later dab for the next corner
        let iOff = iT;
        while (iOff < iMin1 && brake[iOff] > 0.03) iOff++;
        if (top > 0) (m.brakeTurn = brake[iT]), (m.trailIn = brake[iT] > 0.03 ? t[iOff] - t[iT] : -(t[iT] - t[Math.min(iEnd, iT)]));
      }
      m.usIn = avg(L.us, iB, iMin1, (u) => Math.max(0, u) / DEG);
    }
    // throttle back on, to half, then flat out
    let iThr = -1, iFull = -1;
    for (let i = Math.max(iEnd, a); i <= b; i++) if (throttle[i] > 0.15) { iThr = i; break; }
    if (iThr >= 0) {
      let top = throttle[iThr];
      for (let i = iThr; i <= b; i++) {
        if (throttle[i] > 0.95) { iFull = i; break; }
        // a real lift soon after the pickup; easing between the corners of a complex later on is not one
        if (throttle[i] < top - 0.3 && t[i] - t[iThr] < 2) (m.pumps++, (top = throttle[i]));
        top = Math.max(top, throttle[i]);
      }
      for (let i = iThr; i <= b; i++) if (throttle[i] >= 0.5) { m.half = t[i] - t[iThr]; break; }
      m.tThr = t[iThr] - t[iMin];
      if (iFull >= 0) m.ramp = t[iFull] - t[iThr];
    }
    const c1 = iFull >= 0 ? iFull : b;
    for (let i = Math.max(1, iB >= 0 ? iB : a); i <= c1; i++) if (brake[i] < 0.03 && throttle[i] < 0.05) m.coast += t[i] - t[i - 1];
    // off full throttle where the reference was flat (and neither was braking), and where that starts
    m.part = 0;
    m.partAt = -1;
    if (R && R !== L && R.throttle) {
      for (let i = Math.max(a + 1, iThr >= 0 ? iThr : a); i <= b; i++) {
        if (R.throttle[i] > 0.95 && throttle[i] < 0.9 && brake[i] < 0.03 && R.brake[i] < 0.03) {
          m.part += t[i] - t[i - 1];
          if (m.partAt < 0) m.partAt = i;
        }
      }
    }
    // grip used: braking to the first apex, the slowest moment itself, and the drive out
    const g0 = iB >= 0 ? iB : a, w = Math.round(15 / step);
    m.gripIn = avg(L.gripUse, g0, iMin1);
    m.gripMin = avg(L.gripUse, iMin1 - w, iMin1 + w);
    m.gripOut = avg(L.gripUse, iMin, c1);
    (L.events || []).forEach((e) => {
      if (e.iPeak < a || e.iPeak > b) return;
      const k = e.kind === 'spin' || e.kind === 'counter' ? 'os' : e.kind;
      const ph = e.iPeak > iMin ? 'exit' : 'entry';
      (m.ev[k + ':' + ph] = (m.ev[k + ':' + ph] || 0) + 1), (m.ev[k] = (m.ev[k] || 0) + 1);
    });
    return m;
  }

  const s1 = (x) => x.toFixed(1) + ' s', s2 = (x) => x.toFixed(2) + ' s';
  const kmh = (v) => Math.round(v * 3.6) + ' km/h', pc = (x) => Math.round(x * 100) + ' %';
  const ok = (...x) => x.every((v) => isFinite(v));

  /**
   * Patterns lap m shows against the reference r: [{ id, ev }]. ph: this lap's time lost on entry
   * and exit, so a difference that cost nothing is not called a fault. Without a reference only
   * what happened (an off, a lock, a slide, a lift on exit) is reported.
   */
  function match(m, r, ph, single, step) {
    const rl = (ph && ph.label) || 'the comparison lap';
    const out = [], add = (id, ...ev) => out.push({ id, ev: ev.filter(Boolean).join('; ') });
    const inLost = !r || ph.entry > 0.03, outLost = !r || ph.exit > 0.03;
    if (m.ev.off && (!r || (!r.ev.off && ph.entry + ph.exit > 0.03))) add('off', 'Left the track here', r && ok(m.minV, r.minV) && m.minV > r.minV + 1 ? 'slowest point ' + kmh(m.minV) + ', ' + kmh(m.minV - r.minV) + ' faster than ' + rl : '');
    if (m.ev['lock:entry'] && (!r || !r.ev.lock)) add('lock', 'Locked a wheel on the way in', r && m.peak > r.peak + 0.05 ? 'peak brake ' + pc(m.peak) + ' (' + rl + ': ' + pc(r.peak) + ')' : '');
    if (m.ev['os:exit'] && (!r || !r.ev['os:exit'])) add('exitOs', 'Rear slid or spun up on the way out', r && ok(m.half, r.half) && m.half < r.half - 0.1 ? 'reached half throttle in ' + s1(m.half) + ' (' + rl + ': ' + s1(r.half) + ')' : '');
    if (m.pumps >= (r ? r.pumps + 1 : 2)) add('pump', 'Lifted ' + m.pumps + (m.pumps === 1 ? ' time' : ' times') + ' after picking up the throttle');
    if (!r) {
      if (m.ev['us:entry']) add('entryUs', 'Understeer flagged before the apex');
      return out;
    }
    const usWorse = ok(m.usIn, r.usIn) && m.usIn > r.usIn + 0.5;
    const usTxt = usWorse ? 'understeer averaged ' + m.usIn.toFixed(1) + '° on entry (' + rl + ': ' + r.usIn.toFixed(1) + '°)' : '';
    const gripTxt = (a, b, where) => (ok(a, b) ? pc(a) + ' of the grip used ' + where + ' (' + rl + ': ' + pc(b) + ')' : '');
    if (inLost) {
      // released before the car had turned, where the comparison lap carried brake into the corner
      // turn-in can only be timed on a single corner; inside a complex the steering never settles
      if (single && m.braked && r.braked && ok(m.trailIn, r.trailIn, m.brakeTurn, r.brakeTurn) && r.trailIn > 0.15 && r.trailIn - m.trailIn > Math.max(0.25, 0.3 * r.trailIn) && m.brakeTurn <= r.brakeTurn + 0.05) {
        add('trail', 'Brake fully off ' + (m.trailIn >= 0 ? s1(m.trailIn) + ' after' : s1(-m.trailIn) + ' before') + ' turn-in (' + rl + ': ' + s1(r.trailIn) + ' after)',
          ok(m.brakeTurn, r.brakeTurn) ? pc(m.brakeTurn) + ' brake at turn-in (' + rl + ': ' + pc(r.brakeTurn) + ')' : '', usTxt);
      }
      if (usWorse && m.ev['us:entry']) add('entryUs', usTxt);
      if (m.braked && r.braked && ok(m.release, r.release) && m.peak > 0.4 && m.release < 0.12 && r.release > m.release + 0.15) add('cliff', 'Brake from half to off in ' + s2(m.release) + ' (' + rl + ': ' + s2(r.release) + ')', usTxt);
      // slower at the apex with grip to spare: under-driven, not a different line
      if (r.minV - m.minV > 1 && (!ok(m.gripMin, r.gripMin) || m.gripMin < r.gripMin - 0.05)) add('overslow', 'Slowest point ' + kmh(m.minV) + ', ' + rl + ': ' + kmh(r.minV), gripTxt(m.gripMin, r.gripMin, 'there'));
      if (m.braked && r.braked && r.peak > 0.6 && m.tPeak - r.tPeak > 0.15 && m.tPeak > 0.3) add('softPeak', 'Peak brake ' + pc(m.peak) + ' after ' + s2(m.tPeak) + ' (' + rl + ': ' + pc(r.peak) + ' after ' + s2(r.tPeak) + ')');
      if (m.braked && r.braked && m.lift - r.lift > 0.15 && m.lift > 0.25) add('lift', s1(m.lift) + ' off the throttle before braking (' + rl + ': ' + s1(r.lift) + ')');
      if (ok(m.gripIn, r.gripIn) && m.gripIn < r.gripIn - 0.08) add('unusedIn', gripTxt(m.gripIn, r.gripIn, 'from braking to the apex'), m.coast - r.coast > 0.15 ? s1(m.coast) + ' with neither pedal (' + rl + ': ' + s1(r.coast) + ')' : '');
    }
    if (outLost) {
      // a lift and rebuild already explains a slow climb to full; then only a late pickup counts
      const lifted = out.some((f) => f.id === 'pump');
      if (ok(m.tThr, r.tThr) && (m.tThr - r.tThr > 0.2 || (!lifted && ((ok(m.half, r.half) && m.half - r.half > 0.3) || (ok(m.ramp, r.ramp) && m.ramp - r.ramp > Math.max(0.3, 0.25 * r.ramp)))))) {
        const late = m.tThr - r.tThr > 0.2, slowHalf = ok(m.half, r.half) && m.half - r.half > 0.3;
        add('lateThrottle', late ? 'Throttle back on ' + s1(m.tThr - r.tThr) + ' later than ' + rl + ', from the slowest point' : slowHalf ? 'Throttle took ' + s1(m.half) + ' to reach half (' + rl + ': ' + s1(r.half) + ')' : 'Throttle took ' + s1(m.ramp) + ' to reach full (' + rl + ': ' + s1(r.ramp) + ')', gripTxt(m.gripOut, r.gripOut, 'on the way out'));
      } else if (ok(m.gripOut, r.gripOut) && m.gripOut < r.gripOut - 0.08) add('unusedOut', gripTxt(m.gripOut, r.gripOut, 'on the way out'));
    }
    if (ph.entry + ph.exit > 0.03 && m.part > 0.25) add('partThrottle', s1(m.part) + ' below full throttle where ' + rl + ' was flat out, from ' + (m.partAt * step / 1000).toFixed(2) + ' km');
    return out;
  }

  const lerp = (a, i) => (a ? a[Math.max(0, Math.min(a.length - 1, i))] : 0);

  /**
   * The stretches between braking zones (Versus.sectors), split into one piece per corner: a
   * complex is cut where the reference is fastest between two apexes, so each corner is judged
   * on its own braking, apex and exit.
   */
  function corners(cmp) {
    const R = cmp.laps[0], out = [];
    IST.Review.Versus.sectors(cmp).forEach((S) => {
      const ap = (cmp.corners || []).map((c) => c.apex).filter((x) => x >= S.a && x < S.b).sort((p, q) => p - q);
      const cuts = [S.a];
      for (let k = 1; k < ap.length; k++) {
        let top = ap[k - 1];
        for (let i = ap[k - 1]; i <= ap[k]; i++) if (R.speed[i] > R.speed[top]) top = i;
        cuts.push(top);
      }
      cuts.push(S.b);
      for (let k = 0; k < cuts.length - 1; k++) {
        const a = cuts[k], b = cuts[k + 1];
        if (b - a < 5) continue;
        const known = IST.Review.Corners && cmp.turns && IST.Review.Corners.nameSpan(cmp, a, b);
        const name = cuts.length === 2 ? S.name : known || S.name + ' (' + (k + 1) + ')';
        // two detected apexes inside one named turn stay one corner
        const prev = out[out.length - 1];
        if (prev && prev.stretch === S.name && prev.name === name) prev.b = b;
        else out.push({ a, b, name, single: ap.length <= 1 || cuts.length > 2, stretch: S.name });
      }
    });
    return out;
  }

  /**
   * Every lap's corners, each against the lap that was fastest through that corner (among the
   * laps in `used`): { sec, laps[k][j]: { lost, entry, exit, time, m, found }, best[j] }.
   */
  function analyse(cmp, used, coached) {
    const L0 = cmp.laps, n = L0.length;
    used = used || L0.map((_, k) => k);
    coached = coached || used.filter((k) => k > 0);
    const alone = !coached.length;
    if (alone) coached = [0];
    const sec = corners(cmp);
    const T = (L, i) => lerp(L.t, i);
    const best = sec.map((s) => used.reduce((p, k) => (T(L0[k], s.b) - T(L0[k], s.a) < T(L0[p], s.b) - T(L0[p], s.a) ? k : p), used[0]));
    const laps = L0.map(() => []);
    sec.forEach((s, j) => {
      const B = L0[best[j]];
      let iRef = s.a;
      const end = Math.min(s.b, s.a + Math.round((s.b - s.a) * 0.7) + 5);
      for (let i = s.a; i <= end; i++) if (B.speed[i] < B.speed[iRef]) iRef = i;
      // full-throttle metres out of the corner, and where the best lap is flat again
      let straight = 0, iFull = -1;
      if (B.throttle) for (let i = iRef; i <= s.b; i++) if (B.throttle[i] > 0.95) ((straight += cmp.step), iFull < 0 && (iFull = i));
      Object.assign(s, { iRef, straight, iFull: iFull < 0 ? s.b : Math.min(s.b, iFull + Math.round(50 / cmp.step)) });
      const mB = measure(B, s.a, s.b, iRef, cmp.step, B);
      const label = best[j] === 0 ? 'ref lap' : 'lap ' + B.lap.lapNo;
      const tB = T(B, s.b) - T(B, s.a), eB = T(B, iRef) - T(B, s.a);
      for (let k = 0; k < n; k++) {
        const L = L0[k], m = k === best[j] ? mB : measure(L, s.a, s.b, iRef, cmp.step, B);
        const time = T(L, s.b) - T(L, s.a), lost = time - tB, entry = T(L, iRef) - T(L, s.a) - eB, exit = lost - entry;
        const found = (k === best[j] && !alone) || !coached.includes(k) ? [] : match(m, alone ? null : mB, { entry, exit, label }, s.single, cmp.step).map((f) => {
          const ph = KB().PATTERNS[f.id].phase;
          return Object.assign(f, { cost: Math.max(0, ph === 'entry' ? entry : ph === 'exit' ? exit : lost) });
        });
        if (!alone && coached.includes(k) && k !== best[j] && entry < -0.03 && exit > -entry + 0.03) found.push({ id: 'overdrive', ev: 'Gained ' + s2(-entry) + ' in, lost ' + s2(exit) + ' out, against ' + label, cost: lost });
        // the corner itself, braking to back on full throttle; the straight after varies with traffic and tow
        const core = T(L, s.iFull) - T(L, s.a);
        laps[k][j] = { lost, entry, exit, time, core, m, found };
      }
      s.label = label;
    });
    return { sec, laps, best, coached, alone, step: cmp.step };
  }

  const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
  const median = (a) => {
    const s = a.slice().sort((p, q) => p - q), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const sd = (a) => {
    const u = mean(a);
    return Math.sqrt(mean(a.map((x) => (x - u) * (x - u))));
  };

  /**
   * The tab's content: corners ranked by time left a lap against your own best there (weighted
   * towards exits onto long straights), each with the pattern that repeats most, a focus, and up
   * to three drills.
   */
  function report(cmp) {
    if (!cmp || !cmp.laps.length || !cmp.laps[0].brake || !cmp.laps[0].throttle) return { missing: true };
    const N = cmp.laps.length - 1;
    // laps far off the pace (a spin, a slow lap) would drown out the habits, so they sit out
    // the reference is the target and never coached itself; it may be someone else's much faster lap
    const part = (L) => L.lap.kind && L.lap.kind !== 'full';
    const quick = Math.min.apply(null, cmp.laps.slice(1).filter((L) => !part(L)).map((L) => L.lap.time).concat(Infinity));
    const slow = (L) => part(L) || L.lap.time > quick * 1.07;
    const own = cmp.laps.map((_, k) => k).slice(1).filter((k) => !slow(cmp.laps[k]));
    const used = [0].concat(own), dropped = N - own.length;
    const A = analyse(cmp, used, own), alone = A.alone, coached = A.coached;
    const rows = A.sec.map((s, j) => {
      const ks = alone ? [0] : coached.filter((k) => k !== A.best[j]);
      const per = ks.map((k) => A.laps[k][j]);
      const lost = alone ? 0 : median(per.map((p) => p.lost));
      const spread = coached.length >= 3 ? sd(coached.map((k) => A.laps[k][j].core)) : 0;
      const tally = {};
      per.forEach((p) => p.found.forEach((f) => {
        const T = tally[f.id] || (tally[f.id] = { id: f.id, n: 0, cost: 0, ev: [] });
        T.n++;
        T.cost += f.cost;
        if (T.ev.length < 3) T.ev.push(f.ev);
      }));
      if (coached.length >= 3 && spread > 0.1 && spread > 0.4 * Math.abs(lost)) {
        const v = coached.map((k) => A.laps[k][j].m.minV);
        tally.inconsistent = { id: 'inconsistent', n: ks.length, cost: spread, ev: ['From braking to full throttle, time here varies by ' + s2(spread) + ' (standard deviation) across ' + coached.length + ' laps; slowest point from ' + kmh(Math.min.apply(null, v)) + ' to ' + kmh(Math.max.apply(null, v))] };
      }
      // a pattern counts once it shows in a third of the laps; the costliest leads
      const need = Math.max(1, Math.ceil(ks.length / 3));
      const pats = Object.values(tally).filter((T) => T.n >= need).sort((p, q) => q.cost - p.cost || q.n - p.n || ORDER.indexOf(p.id) - ORDER.indexOf(q.id));
      const exitStraight = s.straight >= 400;
      const weight = Math.max(0, lost) * (exitStraight && pats[0] && KB().PATTERNS[pats[0].id].phase !== 'entry' ? 1.25 : 1);
      const score = alone ? pats.reduce((x, T) => x + ORDER.length - Math.max(0, ORDER.indexOf(T.id)), 0) : weight;
      return { a: s.a, b: s.b, name: s.name, stretch: s.stretch, best: s.label, lost, spread, pats, n: ks.length, exitStraight, score };
    });
    const ranked = rows.filter((r) => r.pats.length && (alone || r.lost > 0.02)).sort((p, q) => q.score - p.score).slice(0, 3);
    const focus = ranked[0] ? { row: ranked[0], pat: ranked[0].pats[0] } : null;
    // drills for the leading patterns, at most one per pattern and three in all
    const drills = [], seen = new Set();
    ranked.forEach((r) => r.pats.slice(0, 2).forEach((T) => KB().PATTERNS[T.id].drills.forEach((d) => {
      if (seen.has(d) || drills.length >= 3 || drills.some((x) => x.for.id === T.id)) return;
      seen.add(d);
      drills.push({ id: d, for: { id: T.id, name: r.name } });
    })));
    // your own best stretches added up, against your fastest lap
    const lapTimes = coached.map((k) => cmp.laps[k].lap.time);
    const k0 = coached.reduce((p, k) => (cmp.laps[k].lap.time < cmp.laps[p].lap.time ? k : p), coached[0]);
    const ideal = alone ? NaN : cmp.laps[k0].lap.time + A.sec.reduce((x, s, j) => x + Math.min.apply(null, coached.map((k) => A.laps[k][j].time)) - A.laps[k0][j].time, 0);
    return { alone, laps: coached.length, rows: ranked, focus, drills, ideal, bestLap: cmp.laps[k0].lap.time, spread: coached.length >= 3 ? sd(lapTimes) : NaN, dropped, all: rows };
  }

  IST.Review.Coaching = { measure, match, corners, analyse, report };
})();
