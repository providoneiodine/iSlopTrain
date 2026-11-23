/*
 * Draw the Line: the replay timeline. A replay drives one line (yours
 * or the ideal) along its own speed profile with the other as a ghost, and
 * holds at each of its phases: braking, turn-in, apex, track-out.
 */
(function () {
  'use strict';
  const LL = IST.LineLab, RL = IST.RacingLine, HOLD = RL.HOLD;

  /** Replay state for line li of the question (0 = yours, 1 = the ideal). */
  function start(q, li) {
    const L = q.lines[li], ghost = q.lines[1 - li];
    const brake = L.ph.find((p) => p.kind === 'brake');
    const s0 = Math.max(0, Math.min(q.geo.corners[0].startPos - 150, brake ? brake.s - 70 : Infinity));
    return {
      li, line: L, ghost, s0, s: s0, t: LL.timeAt(L.sim, s0), t0: LL.timeAt(L.sim, s0), gt0: LL.timeAt(ghost.sim, s0),
      phases: L.ph.filter((p) => p.s > s0 + 1), pi: 0, hold: 600, cur: null, curAt: 0, done: false,
    };
  }

  /** Skip the hold at the current phase, or jump to the next one. */
  function skip(rp) {
    if (rp.done) return;
    if (rp.hold > 0 && rp.cur) {
      rp.hold = 0;
      return;
    }
    const ph = rp.phases[rp.pi];
    if (ph) rp.t = LL.timeAt(rp.line.sim, Math.max(rp.s, ph.s - 0.5));
  }

  /** Advance by dt ms. Returns true when it reaches a phase (the drill plays a tick). */
  function step(rp, dt) {
    if (!rp || rp.done) return false;
    if (rp.hold > 0) {
      rp.hold -= dt;
      if (rp.hold > 0) return false;
      rp.hold = 0;
    }
    rp.t += dt / 1000;
    let s = LL.posAtTime(rp.line.sim, rp.t);
    const ph = rp.phases[rp.pi];
    if (ph && s >= ph.s) {
      s = ph.s;
      rp.t = LL.timeAt(rp.line.sim, s);
      rp.cur = ph;
      rp.curAt = performance.now();
      rp.pi++;
      if (ph.kind === 'end') {
        rp.done = true;
        rp.hold = Infinity;
      } else rp.hold = HOLD;
      rp.s = s;
      return true;
    }
    rp.s = s;
    return false;
  }

  RL.replay = { start, skip, step };
})();
