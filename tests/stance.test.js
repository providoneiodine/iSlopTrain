/*
 * The lap viewer's cars lean the way the real car did: nose down under
 * braking, onto the outside wheels in a corner, from ride heights when the
 * file has them and from g when it doesn't. And a car's name picks the model
 * for its class.
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
