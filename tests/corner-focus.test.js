/*
 * Corner comparison: the loop starts before anyone brakes or lifts and ends after the exit,
 * each lap's clock restarts there (so time carried in from earlier corners is gone), and the
 * balance difference says which way the lap differs from the reference.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const DEG = Math.PI / 180;

/** Two laps at 50 m/s with a corner at 1000 m; the rival is 0.5 s down before it and brakes 20 m later. */
function cmp() {
  const n = 2001, step = 1;
  const lap = (brakeAt, carry) => {
    const L = { t: new Float32Array(n), delta: new Float32Array(n), speed: new Float32Array(n).fill(50), throttle: new Float32Array(n).fill(1), brake: new Float32Array(n), us: new Float32Array(n), phase: new Float32Array(n) };
    for (let i = 1; i < n; i++) L.t[i] = L.t[i - 1] + step / 50 + (i === 400 ? carry : 0) + (i > 1000 && i <= 1100 ? 0.001 * !!carry : 0);
    L.brake.fill(0.8, brakeAt, 1000);
    L.throttle.fill(0, brakeAt, 1060);
    L.phase.fill(1, 900, 1000).fill(2, 1000, 1060).fill(3, 1060, 1200);
    return L;
  };
  const R = lap(900, 0), K = lap(920, 0.5);
  for (let i = 0; i < n; i++) K.delta[i] = K.t[i] - R.t[i];
  K.us.fill(3 * DEG, 900, 1000); // more understeer on entry only
  return { n, step, laps: [R, K], corners: [{ start: 880, apex: 1000, end: 1300 }], complexes: [{ corners: [0] }] };
}

test('the loop starts before the earliest braking point and runs on to the next one', () => {
  const { Review } = load();
  const c = cmp(), w = Review.Focus.span(c, { a: 900, b: 2000, name: 'T1' });
  assert.ok(w.a0 < 900 && w.a0 > 700, 'starts a little before the reference brakes: ' + w.a0);
  assert.equal(w.b1, 2000, 'ends where the next stretch starts braking');
});

test('time carried into the corner is removed: the cars start level', () => {
  const { Review } = load();
  const c = cmp(), w = Review.Focus.span(c, { a: 900, b: 2000, name: 'T1' });
  assert.ok(Math.abs(Review.Focus.lost(c, 1, w, w.a0)) < 1e-6);
  assert.ok(Math.abs(Review.Focus.lost(c, 1, w, w.b1) - 0.1) < 0.002, 'only the 0.1 s lost in the corner counts');
  assert.ok(Math.abs(Review.Focus.timeOn(c, 1, w, c.laps[0].t[w.a0]) - c.laps[1].t[w.a0]) < 1e-6);
  assert.equal(Review.Focus.brakeGap(c, 1, w), 20);
});

test('balance difference: more understeer on entry, the same elsewhere', () => {
  const { Review } = load();
  const c = cmp(), w = Review.Focus.span(c, { a: 900, b: 2000, name: 'T1' });
  const b = Review.Focus.balance(c, 1, w);
  const by = Object.fromEntries(b.map((p) => [p.phase, p.diff]));
  assert.ok(Math.abs(by.entry - 3) < 0.01, 'entry +3° wheel: ' + by.entry);
  assert.ok(Math.abs(by.mid) < 0.01 && Math.abs(by.exit) < 0.01);
  delete c.laps[0].us;
  assert.equal(Review.Focus.balance(c, 1, w), null, 'no balance without it in both laps');
});

/**
 * A left then a right onto the straight. The rival runs 2 m wider than the reference out of the left,
 * so it starts the right 1.5 m off the reference's line and loses its time there.
 */
function chicane() {
  const n = 1201, step = 1, mk = () => ({ t: new Float32Array(n), delta: new Float32Array(n), steer: new Float32Array(n), off: new Float32Array(n), speed: new Float32Array(n).fill(40) });
  const R = mk(), K = mk();
  for (let i = 0; i < n; i++) {
    R.steer[i] = K.steer[i] = i >= 300 && i < 400 ? 0.5 : i >= 500 && i < 600 ? -0.5 : 0;
    // the reference: inside of the left (+4 m), back to +3 for the right, inside of the right (−5 m)
    R.off[i] = i < 350 ? 4 * Math.min(1, Math.max(0, (i - 250) / 100)) : i < 450 ? 4 - (i - 350) / 25 : i < 500 ? 0 + (i - 450) * 0.06 : i < 550 ? 3 - (i - 500) * 0.16 : -5 + (i - 550) * 0.1;
    K.off[i] = i >= 380 && i < 560 ? R.off[i] - (i < 470 ? 2 : 1.5) : R.off[i];
    R.t[i] = i / 40;
    K.t[i] = i / 40 + (i > 500 ? Math.min(0.2, (i - 500) * 0.002) : 0);
    K.delta[i] = K.t[i] - R.t[i];
  }
  return { n, step, laps: [R, K], corners: [], complexes: [] };
}

test('line: running wide out of the first turn is named as the set-up for the second', () => {
  const { Review } = load();
  const c = chicane(), w = { a0: 200, a: 250, b1: 800 };
  const T = Review.Focus.turns(c, w);
  assert.equal(T.map((t) => (t.dir > 0 ? 'L' : 'R')).join(''), 'LR');
  const f = Review.Focus.line(c, 1, w);
  assert.equal(f && f.id, 'setup');
  assert.equal(f.turn.dir, -1, 'the right-hander is where the time went');
  assert.match(f.cue, /left edge/);
});
