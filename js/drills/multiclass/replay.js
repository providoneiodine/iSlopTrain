/*
 * Class Traffic: the replay timeline. A run's record (TrafficLab.run)
 * is sampled at 60 Hz; events() picks the moments worth pausing on (closing,
 * braking, turn-in, apex, the pass, any conflict, track-out) and the replay
 * state steps through them, holding at each.
 */
(function () {
  'use strict';
  const U = IST.util, LL = IST.LineLab, TL = IST.TrafficLab, MC = IST.Multiclass;
  const DS = LL.DS, CARLEN = TL.CARLEN, PRIO = MC.PRIO, HOLD = MC.HOLD;

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

  /** Replay state for option oi of question q. */
  function start(q, oi) {
    const o = q.opts[oi];
    return { oi, o, t: 0, ev: events(q, o), ei: 0, hold: 500, cur: null, curAt: 0, done: false };
  }

  /** Skip the hold at the current event, or jump to the next one. */
  function skip(rp) {
    if (rp.done) return;
    if (rp.hold > 0 && rp.cur) {
      rp.hold = 0;
      return;
    }
    const e = rp.ev[rp.ei];
    if (e) rp.t = Math.max(rp.t, e.t - 0.02);
  }

  /** Advance by dt ms. Returns true when it reaches an event (the drill plays a tick). */
  function step(rp, dt) {
    if (!rp || rp.done) return false;
    if (rp.hold > 0) {
      rp.hold -= dt;
      if (rp.hold > 0) return false;
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
      return true;
    }
    return false;
  }

  MC.replay = { at, timeAtPos, events, start, skip, step };
})();
