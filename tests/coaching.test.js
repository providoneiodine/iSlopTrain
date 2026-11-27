/*
 * Coaching checks on made-up laps: a downshift blip is not a throttle pickup, a lift both
 * laps make is not a fault, and part throttle is reported one run at a time with its cause.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

/** A lap on a 1 m grid, 40 m/s unless f(i) says otherwise; f(i) returns { brake, throttle, steer, speed } overrides. */
function lap(n, f) {
  const L = { t: new Float64Array(n), speed: new Float64Array(n), brake: new Float64Array(n), throttle: new Float64Array(n), steer: new Float64Array(n) };
  for (let i = 0; i < n; i++) {
    const o = f(i) || {};
    L.speed[i] = o.speed || 40;
    L.t[i] = i ? L.t[i - 1] + 1 / L.speed[i] : 0;
    L.brake[i] = o.brake || 0;
    L.throttle[i] = o.throttle == null ? 1 : o.throttle;
    L.steer[i] = o.steer || 0;
  }
  return L;
}

test('a downshift blip under braking is not the throttle pickup', () => {
  const C = load().Review.Coaching;
  // braking 10..60 m with a 3 m blip at 30 m, then off pedals, then the real pickup at 90 m
  const L = lap(400, (i) => (i >= 10 && i <= 60 ? { brake: 0.6, throttle: i >= 30 && i <= 32 ? 0.7 : 0, speed: 40 - (i - 10) * 0.2 } : i < 90 ? { throttle: i < 10 ? 1 : 0, speed: 30 } : { throttle: 0.6 }));
  const m = C.measure(L, 5, 399, 70, 1, null);
  assert.equal(m.iThr, 90);
});

test('a lift the comparison lap makes at the same place is not a pump', () => {
  const C = load().Review.Coaching;
  const dip = (i) => (i >= 150 && i <= 165 ? 0.2 : 0.6);
  const brakeZone = (i) => (i >= 10 && i <= 60 ? { brake: 0.6, throttle: 0 } : i < 90 ? { throttle: 0 } : null);
  const R = lap(400, (i) => brakeZone(i) || { throttle: dip(i) });
  const L = lap(400, (i) => brakeZone(i) || { throttle: dip(i) });
  assert.equal(C.measure(L, 5, 399, 70, 1, R).pumps, 0);
  const alone = C.measure(L, 5, 399, 70, 1, null);
  assert.equal(alone.pumps, 1);
});

test('part throttle comes as separate runs, and one with far more lock is the car pushing', () => {
  const C = load().Review.Coaching;
  const R = lap(600, () => ({ throttle: 1, steer: 0.1 }));
  // two lifts where the comparison lap is flat: the second with three times its lock
  const L = lap(600, (i) => (i >= 100 && i <= 140 ? { throttle: 0.4, steer: 0.1, speed: 38 } : i >= 300 && i <= 340 ? { throttle: 0.3, steer: 0.6, speed: 37 } : { throttle: 1, steer: 0.1, speed: i > 140 ? 39 : 40 }));
  const m = C.measure(L, 0, 599, 50, 1, R);
  assert.equal(m.parts.length, 2);
  assert.equal(m.parts[0].line, false);
  assert.equal(m.parts[1].line, true);
  assert.ok(m.parts.every((p) => p.cost > 0));
});
