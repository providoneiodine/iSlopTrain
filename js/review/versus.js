/*
 * Driver vs driver: who drove which lap, and the live battle against the reference.
 * Pure functions, no DOM.
 *
 *   IST.Review.Versus.driverKey(session)        same driver across files (name, else the file)
 *   IST.Review.Versus.drivers(sessions)         [{ key, name, sessions }] in load order
 *   IST.Review.Versus.battle(cmp, k, f)         lap k against the reference at grid index f
 *   IST.Review.Versus.sectors(cmp)              [{ a, b, name }] stretches between braking zones
 *   IST.Review.Versus.sectorAt(cmp, k, f)       lap k's time lost on the stretch f is in, so far
 *   IST.Review.Versus.worst(cmp, k)             the stretch that cost lap k the most
 *
 * A stretch runs from where the reference starts braking (or lifts) for a corner or a
 * complex of corners, through it and down the following straight, to the next such point.
 */
(function () {
  'use strict';
  IST.Review = IST.Review || {};

  const clean = (s) => String((s && s.meta && s.meta.driver) || '').trim();
  /** A file with no driver name counts as its own driver. */
  const driverKey = (s) => clean(s).toLowerCase().replace(/\s+/g, ' ') || 'file:' + s.file;
  const fileStem = (f) => String(f || 'Unknown').replace(/\.[^.]+$/, '');

  function drivers(sessions) {
    const out = [], at = new Map();
    sessions.forEach((s) => {
      const key = driverKey(s);
      if (!at.has(key)) {
        at.set(key, out.length);
        out.push({ key, name: clean(s) || fileStem(s.file), sessions: [] });
      }
      out[at.get(key)].sessions.push(s);
    });
    return out;
  }

  const lerp = (a, f) => {
    const i = Math.max(0, Math.min(a.length - 2, Math.floor(f)));
    return a[i] + (a[i + 1] - a[i]) * Math.max(0, Math.min(1, f - i));
  };

  /**
   * delta: s lap k is behind (+) or ahead (−) of the reference at f; gapM: metres behind (+)
   * when the reference is at f, the spacing of the cars on screen.
   */
  function battle(cmp, k, f) {
    const L = cmp.laps[k], R = cmp.laps[0];
    if (!L || !k || cmp.n < 2) return null;
    f = Math.max(0, Math.min(cmp.n - 1, f));
    // where lap k was when the reference reached f
    const T = lerp(R.t, f), t = L.t;
    let lo = 0, hi = t.length - 1, j;
    if (T <= t[0]) j = 0;
    else if (T >= t[hi]) j = hi;
    else {
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (t[m] <= T) lo = m;
        else hi = m;
      }
      j = lo + (T - t[lo]) / Math.max(1e-6, t[hi] - t[lo]);
    }
    return { delta: lerp(L.delta, f), gapM: (f - j) * cmp.step };
  }

  const made = new WeakMap();
  function sectors(cmp) {
    if (made.has(cmp)) return made.get(cmp);
    const R = cmp.laps[0], out = [], cuts = [];
    (cmp.complexes || []).forEach((cx) => {
      const first = cmp.corners[cx.corners[0]];
      // the brake pedal going down on the way in; a corner taken on a lift starts at its top speed
      let a = first.start;
      if (R.brake) for (let i = first.start; i < first.apex; i++) if (R.brake[i] > 0.05) { a = i; break; }
      const n0 = cx.corners[0] + 1, n1 = cx.corners[cx.corners.length - 1] + 1;
      if (!cuts.length || a > cuts[cuts.length - 1].a) cuts.push({ a, name: n0 === n1 ? 'T' + n0 : 'T' + n0 + '–' + n1 });
    });
    if (cuts.length && cuts[0].a > 0) out.push({ a: 0, b: cuts[0].a, name: 'Run to ' + cuts[0].name.split('–')[0] });
    cuts.forEach((c, i) => out.push({ a: c.a, b: i < cuts.length - 1 ? cuts[i + 1].a : cmp.n - 1, name: c.name }));
    made.set(cmp, out);
    return out;
  }
  const lost = (L, a, b) => lerp(L.delta, b) - lerp(L.delta, a);

  /** -> { name, lost (from the stretch's start to f), prev: { name, lost (all of the one before) } } */
  function sectorAt(cmp, k, f) {
    const L = cmp.laps[k], S = sectors(cmp);
    if (!L || !k || !S.length) return null;
    f = Math.max(0, Math.min(cmp.n - 1, f));
    let i = S.length - 1;
    while (i > 0 && f < S[i].a) i--;
    const x = lost(L, S[i].a, f);
    if (!isFinite(x)) return null;
    const p = i > 0 ? { name: S[i - 1].name, lost: lost(L, S[i - 1].a, S[i - 1].b) } : null;
    return { name: S[i].name, lost: x, prev: p && isFinite(p.lost) ? p : null };
  }

  function worst(cmp, k) {
    const L = cmp.laps[k];
    let best = null;
    if (L && k) sectors(cmp).forEach((s) => {
      const x = lost(L, s.a, s.b);
      if (isFinite(x) && (!best || x > best.lost)) best = { name: s.name, lost: x };
    });
    return best;
  }

  IST.Review.Versus = { driverKey, drivers, battle, sectors, sectorAt, worst };
})();
