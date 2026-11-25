/*
 * The lap viewer's cars lean the way the real car did: nose down under
 * braking, onto the outside wheels in a corner, from ride heights when the
 * file has them and from g when it doesn't. A car's name picks the model
 * for its class. Its wheels turn at their own speed, so a locked one stops,
 * and they show tyre temperature only when the file has it.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const N = 400, G0 = 9.80665;
const lap = (ch) => Object.assign({ x: new Float32Array(N) }, ch);
const fill = (fn) => Float32Array.from({ length: N }, (_, i) => fn(i));

test('from ride heights: a lower nose is dive, a lower right side is roll to the right', () => {
  const { Stance } = load().Review;
  // level until 200 m, then the front drops 10 mm, the rear rises 10 mm and the right side drops 8 mm
  const on = (i) => (i >= 200 ? 1 : 0);
  const L = lap({
    rhF: fill((i) => 0.06 - 0.01 * on(i)), rhR: fill((i) => 0.07 + 0.01 * on(i)),
    rhLt: fill((i) => 0.065 + 0.004 * on(i)), rhRt: fill((i) => 0.065 - 0.004 * on(i)),
    // g channels saying the opposite: measured ride heights win
    longG: fill(() => 5), latG: fill(() => -5),
  });
  const flat = Stance.at(L, 100, 'gt'), s = Stance.at(L, 300, 'gt');
  assert.ok(s.measured);
  assert.ok(s.dive - flat.dive > 0.005, 'nose down');
  assert.ok(s.roll - flat.roll > 0.003, 'leaning right');
  assert.ok(Math.abs(s.heave - flat.heave) < 1e-4, 'the mean height did not change');
});

test('without ride heights: braking dives and a left-hander rolls the body right', () => {
  const { Stance } = load().Review;
  const L = lap({ longG: fill((i) => (i < 200 ? -1.2 * G0 : 0.4 * G0)), latG: fill((i) => (i < 200 ? 1.5 * G0 : -1.5 * G0)) });
  const brake = Stance.at(L, 100, 'gt'), drive = Stance.at(L, 300, 'gt');
  assert.ok(!brake.measured);
  assert.ok(brake.dive > 0 && drive.dive < 0, 'dive under braking, squat on power');
  assert.ok(brake.roll > 0 && drive.roll < 0, 'roll away from the turn');
  assert.ok(Math.abs(Stance.at(L, 100, 'road').roll) > Math.abs(brake.roll), 'a road car rolls more than a GT car');
  assert.deepEqual({ ...Stance.at(lap({}), 100, 'gt') }, { dive: 0, roll: 0, heave: 0, measured: false });
});

test('ride-height buzz at speed barely moves the body, while a real change still shows', () => {
  const { Stance } = load().Review;
  // 250 km/h, the front ride height buzzing ±6 mm every other metre, then a steady 10 mm dive
  const L = lap({
    speed: fill(() => 70), rhF: fill((i) => 0.06 + (i % 2 ? 0.006 : -0.006) - (i >= 200 ? 0.01 : 0)), rhR: fill(() => 0.07),
  });
  let swing = 0;
  for (let j = 100; j < 110; j += 0.25) swing = Math.max(swing, Math.abs(Stance.at(L, j, 'gt', 1).dive - Stance.at(L, j + 0.25, 'gt', 1).dive));
  assert.ok(swing < 0.0003, 'the nose ticked by ' + swing.toFixed(5) + ' rad between frames');
  assert.ok(Stance.at(L, 300, 'gt', 1).dive - Stance.at(L, 100, 'gt', 1).dive > 0.003, 'the dive is still there');
});

test('each wheel turns at its own speed: a locked wheel stops while the others roll on', () => {
  const { Stance } = load().Review;
  const radii = { f: 0.33, r: 0.34 }, v = 50;
  // 50 m/s throughout; the left front locks from 200 m to 260 m under braking
  const ws = fill(() => v);
  const L = lap({
    t: fill((i) => i / v), speed: fill(() => v), brake: fill((i) => (i >= 180 && i < 280 ? 0.9 : 0)), throttle: fill((i) => (i < 180 ? 1 : 0)),
    wsLF: fill((i) => (i >= 200 && i < 260 ? 0 : v)), wsRF: ws, wsLR: ws, wsRR: ws,
  });
  const a = Stance.wheels(L, 205, 1, radii), b = Stance.wheels(L, 255, 1, radii);
  assert.ok(Math.abs(b.LF.rot - a.LF.rot) < 0.01, 'the locked wheel did not turn');
  assert.ok(Math.abs(b.RF.rot - a.RF.rot - 50 / 0.33) < 0.5, 'the free front rolled 50 m');
  assert.ok(Math.abs(b.RR.rot - a.RR.rot - 50 / 0.34) < 0.5, 'a rear, on its own radius, too');
  assert.equal(b.LF.lock, 1);
  assert.equal(b.RF.lock, 0);
  assert.equal(Stance.wheels(L, 100, 1, radii).LF.lock, 0, 'not flagged before it locks');
});

test('without wheel speeds or tyre temperatures the wheels roll with the road and show no heat', () => {
  const { Stance } = load().Review;
  const radii = { f: 0.33, r: 0.33 }, base = { t: fill((i) => i / 40), speed: fill(() => 40) };
  const check = (L, why) => {
    const a = Stance.wheels(L, 100, 1, radii), b = Stance.wheels(L, 133, 1, radii);
    Stance.WHEELS.forEach((w) => {
      assert.ok(Math.abs(b[w].rot - a[w].rot - 100) < 0.5, why + ': ' + w + ' rolled 33 m');
      assert.equal(b[w].lock + b[w].spin, 0, why + ': no lock or spin without a wheel speed');
      assert.equal(b[w].temp, null);
    });
  };
  check(lap(base), 'a Garage 61 style file');
  // wheel speeds in another unit (here rpm) can't be told apart from a lock: not used
  const rpm = fill(() => 1157);
  check(lap(Object.assign({ wsLF: rpm, wsRF: rpm, wsLR: rpm, wsRR: rpm, brake: fill(() => 1) }, base)), 'wheel speeds in rpm');
  // one temperature per tyre fills all three bands; inner / mid / outer are kept apart
  const one = Stance.wheels(lap(Object.assign({ tLF: fill(() => 92) }, base)), 100, 1, radii);
  assert.deepEqual([...one.LF.temp], [92, 92, 92]);
  assert.equal(one.RF.temp, null);
  const three = Stance.wheels(lap(Object.assign({ tLF_i: fill(() => 105), tLF_m: fill(() => 95), tLF_o: fill(() => 80) }, base)), 100, 1, radii);
  assert.deepEqual([...three.LF.temp], [105, 95, 80]);
  assert.ok(Stance.heat(40) < 0 && Stance.heat(78) === 0 && Stance.heat(100) > 0 && Stance.heat(NaN) === 0, 'cold, in the window, hot, unknown');
});

test('a car name picks its class of model', () => {
  const { Cars } = load().Review;
  const kinds = {
    'Toyota GR86': 'road', 'Mazda MX-5 Cup': 'road', '': 'road',
    'BMW M4 GT3': 'gt', 'Porsche 911 GT3 Cup (992)': 'gt', 'Aston Martin Vantage GT4': 'gt',
    'Dallara P217': 'lmp', 'Ligier JS P320': 'lmp',
    'Porsche 963 GTP': 'gtp', 'Cadillac V-Series.R GTP': 'gtp', 'BMW M Hybrid V8': 'gtp',
    'FIA F4': 'formula', 'Dallara IR18': 'formula', 'Super Formula SF23': 'formula',
  };
  for (const name in kinds) assert.equal(Cars.kindOf(name), kinds[name], name);
  Cars.KINDS.forEach((k) => assert.ok(Cars.model(k).tris.length > 100, k));
});

test('a crash turns the whole car to the attitude in the file; normal driving is left alone', () => {
  const { Stance } = load().Review;
  const calm = lap({ crash: fill(() => 0), bodyYaw: fill(() => 0.05), bodyRoll: fill(() => 0.03), bodyPitch: fill(() => 0) });
  assert.equal(Stance.crash(calm, 100), null);
  assert.equal(Stance.crash(lap({}), 100), null, 'no attitude channels: never a crash');
  // on its roof, pointing back the way it came
  const L = lap({ crash: fill(() => 1), bodyYaw: fill(() => Math.PI), bodyRoll: fill(() => Math.PI), bodyPitch: fill(() => 0) });
  const fwd = [1, 0, 0], left = [0, 0, -1], up = [0, 1, 0];
  const road = { p: [0, 0, 0], f: fwd, u: up, l: left }, box = { front: 2.3, rear: -2.3, width: 2, height: 1.2 };
  const T = Stance.tumble(fwd, left, road, road, Stance.crash(L, 100), box);
  assert.ok(T.body.f[0] < -0.99, 'nose points backwards');
  assert.ok(T.body.u[1] < -0.99, 'roof down');
  assert.equal(T.road, T.body, 'the wheels go with the body');
  assert.ok(Math.abs(T.body.p[1] - box.height) < 1e-6, 'lifted so the roof rests on the road, not under it');
  assert.equal(T.ground, road, 'the shadow stays on the road');
});
