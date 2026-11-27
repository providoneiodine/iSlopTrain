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

/** A braking corner: brake from 10 m, turn-in at 75 m, slowest at 150 m, then throttle; brake(i) shapes the pedal. */
function corner(brake) {
  return lap(400, (i) => ({
    speed: i < 150 ? 50 - 0.2 * i : 20 + 0.2 * (i - 150),
    brake: i >= 10 && i <= 110 ? brake(i) : 0,
    throttle: i < 10 ? 1 : i < 160 ? 0 : 1,
    steer: i >= 75 && i <= 200 ? 0.5 : 0,
  }));
}
// a clean trace: peak at once, then an even release to nothing just past turn-in
const clean = (i) => (i < 15 ? 0.9 * (i - 9) / 6 : 0.9 * (110 - i) / 95);

test('brake pressure building into the turn is flagged, a clean peak-then-release is not', () => {
  const C = load().Review.Coaching;
  const ph = { entry: 0.1, exit: 0.1, label: 'ref lap' };
  const R = C.measure(corner(clean), 0, 399, 150, 1, null);
  // eases to 45 % and squeezes back up to 70 % before turn-in
  const again = C.measure(corner((i) => (i < 45 ? 0.6 : i < 52 ? 0.45 : i < 72 ? 0.7 : 0.7 * (110 - i) / 38)), 0, 399, 150, 1, null);
  assert.ok(C.match(again, R, ph, true, 1).some((f) => f.id === 'lateBuild'));
  // the peak comes in the last third of the zone
  const lateTop = C.measure(corner((i) => (i < 85 ? 0.3 + 0.6 * (i - 10) / 75 : 0.9 * (110 - i) / 25)), 0, 399, 150, 1, null);
  assert.ok(C.match(lateTop, R, ph, true, 1).some((f) => f.id === 'lateBuild'));
  const same = C.measure(corner(clean), 0, 399, 150, 1, null);
  assert.ok(!C.match(same, R, ph, true, 1).some((f) => f.id === 'lateBuild' || f.id === 'brakeAfterTurn'));
});

test('brake added again after turn-in is its own check, and trail braking is not judged then', () => {
  const C = load().Review.Coaching;
  const ph = { entry: 0.1, exit: 0.1, label: 'ref lap' };
  const R = C.measure(corner(clean), 0, 399, 150, 1, null);
  // releases to 30 % by turn-in, then back up to 50 % while turning
  const m = C.measure(corner((i) => (i < 15 ? 0.9 : i < 80 ? 0.9 - 0.6 * (i - 15) / 65 : i < 100 ? 0.5 : 0.5 * (110 - i) / 10)), 0, 399, 150, 1, null);
  const ids = C.match(m, R, ph, true, 1).map((f) => f.id);
  assert.ok(ids.includes('brakeAfterTurn'), ids.join());
  assert.ok(!ids.includes('trail'));
});
