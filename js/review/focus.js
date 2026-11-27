/*
 * One corner at a time: the window a corner comparison loops over, every lap's clock
 * restarted at its start, and how each lap's balance differs from the reference's.
 * Pure functions, no DOM.
 *
 *   IST.Review.Focus.span(cmp, sec)         { a0, a, b1 }: loop start (before anyone brakes or lifts), the reference's braking point, loop end (the next braking point)
 *   IST.Review.Focus.timeOn(cmp, k, w, T)   lap k's own time when the reference's is T, both counted from a0
 *   IST.Review.Focus.lost(cmp, k, w, i)     s lap k lost (+) or gained (−) from a0 to grid index i
 *   IST.Review.Focus.brakeGap(cmp, k, w)    m lap k starts braking after (+) or before (−) the reference, or NaN
 *   IST.Review.Focus.balance(cmp, k, w)     [{ phase: 'entry' | 'mid' | 'exit', diff (° wheel, + more understeer), n }]
 *   IST.Review.Focus.turns(cmp, w)          [{ s, e, apex, dir (+1 left), name }]: the reference's turns, from its steering
 *   IST.Review.Focus.line(cmp, k, w)        the line habit behind lap k's loss, or null: { id, turn, prev?, ev, cue, sources }
 *
 * sec is a stretch from Versus.sectors. Laps stay on the reference's distance grid, so a later
 * braking point still shows as later; only the time they carried in from earlier corners is removed.
 */
(function () {
  'use strict';
  IST.Review = IST.Review || {};
  const DEG = 180 / Math.PI;
  const PHASES = [null, 'entry', 'mid', 'exit'];

  /** Where a lap first brakes or lifts after being flat out between from and to, else -1. */
  function onset(L, from, to) {
    let on = !L.throttle;
    for (let i = from; i <= to; i++) {
      const brk = L.brake && L.brake[i] > 0.05;
      if (!on) on = !brk && L.throttle[i] >= 0.9;
      else if (brk || (L.throttle && L.throttle[i] < 0.6)) return i;
    }
    return -1;
  }

  function span(cmp, sec) {
    const R = cmp.laps[0], m = (x) => Math.round(x / cmp.step), n = cmp.n;
    const cx = (cmp.complexes || []).find((c) => {
      const ap = cmp.corners[c.corners[0]].apex;
      return ap > sec.a && ap < sec.b;
    });
    if (!cx) return { a0: sec.a, a: sec.a, b1: sec.b };
    const first = cmp.corners[cx.corners[0]].apex;
    // the earliest lap to brake or lift sets the start, so lift and coast or an early brake is inside the loop
    const prev = (cmp.corners || []).reduce((p, c) => (c.apex < sec.a ? Math.max(p, c.apex) : p), 0);
    const lo = Math.max(0, prev, sec.a - m(200));
    let a0 = sec.a;
    cmp.laps.forEach((L) => {
      const i = onset(L, lo, first);
      if (i >= 0) a0 = Math.min(a0, i);
    });
    const v = R.speed ? R.speed[a0] : 50;
    a0 = Math.max(lo, a0 - Math.max(m(30), Math.min(m(90), m(v * 0.8))));
    // on to the next braking point, as the chip counts it: flat-out bends (Eau Rouge) and the straight belong to this corner
    const b1 = Math.min(sec.b, n - 1);
    return { a0, a: sec.a, b1 };
  }

  const timeOn = (cmp, k, w, T) => cmp.laps[k].t[w.a0] + (T - cmp.laps[0].t[w.a0]);
  const lost = (cmp, k, w, i) => cmp.laps[k].delta[i] - cmp.laps[k].delta[w.a0];

  function brakeGap(cmp, k, w) {
    const R = cmp.laps[0], L = cmp.laps[k], end = Math.min(w.b1, w.a + Math.round(150 / cmp.step));
    const at = (X) => {
      if (X.brake) for (let i = w.a0; i <= end; i++) if (X.brake[i] > 0.05) return i;
      return -1;
    };
    const r = at(R), l = L ? at(L) : -1;
    return r >= 0 && l >= 0 ? (l - r) * cmp.step : NaN;
  }

  function balance(cmp, k, w) {
    const R = cmp.laps[0], L = cmp.laps[k];
    if (!k || !R.us || !L || !L.us || !R.phase) return null;
    const acc = [null, { s: 0, n: 0 }, { s: 0, n: 0 }, { s: 0, n: 0 }];
    for (let i = w.a0; i <= w.b1; i++) {
      const p = acc[Math.round(R.phase[i])], d = L.us[i] - R.us[i];
      if (p && isFinite(d)) (p.s += d), p.n++;
    }
    const min = Math.max(3, Math.round(15 / cmp.step)); // a phase under ~15 m says nothing
    return acc.map((p, q) => (p && p.n >= min ? { phase: PHASES[q], diff: (p.s / p.n) * DEG, n: p.n } : null)).filter(Boolean);
  }

  /**
   * The reference's turns inside the loop: runs of steering one way (past 8° of wheel for 20 m or more),
   * so a chicane the corner finder sees as one corner is still a right, a left and a right.
   */
  function turns(cmp, w) {
    const R = cmp.laps[0], src = R.steer || R.latG, m = (x) => Math.max(1, Math.round(x / cmp.step));
    if (!src) return [];
    const lim = R.steer ? 8 / DEG : 2, out = [];
    let cur = null;
    for (let i = w.a0; i <= w.b1; i++) {
      const v = src[i], d = v > lim ? 1 : v < -lim ? -1 : 0;
      if (d && cur && cur.dir === d && i - cur.e <= m(15)) cur.e = i;
      else if (d) out.push((cur = { s: i, e: i, dir: d }));
    }
    const R2 = out.filter((t) => t.e - t.s >= m(20));
    R2.forEach((t) => {
      t.apex = t.s;
      for (let i = t.s; i <= t.e; i++) if (R.off[i] * t.dir > R.off[t.apex] * t.dir) t.apex = i;
      t.name = (IST.Review.Corners && cmp.turns && IST.Review.Corners.nameSpan(cmp, t.s, t.e)) || null;
    });
    // unnamed and two the same way: "the second right-hander"
    const ORD = ['first', 'second', 'third', 'fourth', 'fifth'];
    R2.forEach((t) => {
      const same = R2.filter((x) => x.dir === t.dir);
      if (!t.name && same.length > 1) t.nth = ORD[same.indexOf(t)] || '';
    });
    return R2;
  }

  const side = (d) => (d > 0 ? 'left' : 'right');
  const what = (t) => (t.name ? t.name + ', the ' : 'the ') + (t.nth ? t.nth + ' ' : '') + side(t.dir) + '-hander';
  const m1 = (x) => x.toFixed(1) + ' m';

  /**
   * Where lap k's line differs from the reference's in the turn that cost it most: set up from the
   * turn before (ran wide out of it, so the next starts off the outside edge), not using the width
   * on the way in, wide of the apex, or not using the exit. Gaps under 0.8 m are left alone: a GPS
   * lap's position is good to about that.
   */
  function line(cmp, k, w) {
    const R = cmp.laps[0], L = cmp.laps[k], m = (x) => Math.max(1, Math.round(x / cmp.step));
    if (!k || !L || !R.off || !L.off) return null;
    const T = turns(cmp, w);
    if (!T.length) return null;
    const most = (X, d, a, b) => {
      let v = -Infinity;
      for (let i = Math.max(w.a0, a); i <= Math.min(w.b1, b); i++) v = Math.max(v, X.off[i] * d);
      return v;
    };
    T.forEach((t, j) => {
      const prev = T[j - 1], next = T[j + 1];
      const a = prev ? Math.round((prev.e + t.s) / 2) : t.s - m(80), b = next ? Math.round((t.e + next.s) / 2) : t.e + m(100);
      Object.assign(t, { a, b, cost: lost(cmp, k, w, Math.min(w.b1, b)) - lost(cmp, k, w, Math.max(w.a0, a)) });
      // metres the lap came up short of the reference: outside before the apex, at the apex, outside after it
      t.entry = most(R, -t.dir, a, t.apex) - most(L, -t.dir, a, t.apex);
      t.apexGap = (R.off[t.apex] - L.off[t.apex]) * t.dir;
      t.exit = most(R, -t.dir, t.apex, b) - most(L, -t.dir, t.apex, b);
    });
    const t = T.reduce((p, x) => (x.cost > p.cost ? x : p));
    if (t.cost < 0.03) return null;
    const prev = T[T.indexOf(t) - 1], GAP = 0.8, out = { turn: t, sources: ['driver61', 'kasdorpBasics'] };
    if (t.entry >= GAP && prev && prev.dir !== t.dir && prev.exit <= -GAP) {
      return Object.assign(out, { id: 'setup', prev,
        ev: 'Ran ' + m1(-prev.exit) + ' wider than the ref out of ' + what(prev) + ', so ' + what(t) + ' started ' + m1(t.entry) + ' in from the ref’s line' + (t.apexGap >= GAP ? ' and missed its apex by ' + m1(t.apexGap) : ''),
        cue: 'Give a little away in ' + what(prev) + ': keep it tighter on the way out so the car is back on the ' + side(prev.dir) + ' edge before ' + what(t) + '. The corner onto the longer straight comes first; the one before it only sets it up.' });
    }
    if (t.entry >= GAP) return Object.assign(out, { id: 'entryWidth', ev: 'Turned into ' + what(t) + ' ' + m1(t.entry) + ' in from the ref’s line' + (t.apexGap >= GAP ? ', then ' + m1(t.apexGap) + ' wide of its apex' : ''),
      cue: 'Use the whole road on the way in: be right at the ' + side(-t.dir) + ' edge when the steering starts, so the arc is wider and the car carries more speed through.' });
    if (t.apexGap >= GAP) return Object.assign(out, { id: 'apex', ev: m1(t.apexGap) + ' wide of the ref’s apex in ' + what(t),
      cue: 'A missed apex usually means too much speed in or turning before the car had slowed: arrive a touch slower and let the car rotate before asking it to reach the inside.' });
    if (t.exit >= GAP) return Object.assign(out, { id: 'exitWidth', ev: 'Finished ' + what(t) + ' ' + m1(t.exit) + ' short of the ref’s exit line',
      cue: 'Use the exit: unwind the wheel and let the car run out to the ' + side(-t.dir) + ' edge as the throttle goes down, rather than holding a tight line.' });
    return null;
  }

  IST.Review.Focus = { span, timeOn, lost, brakeGap, balance, turns, line };
})();
