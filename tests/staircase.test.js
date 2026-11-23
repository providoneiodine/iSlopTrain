/*
 * The adaptive staircase is what keeps every threshold drill at the right
 * difficulty. If it drifts, every "threshold (ms)" in Stats is wrong.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const IST = require('./harness').load();
const { Staircase, util: U } = IST;

/**
 * A simulated athlete whose chance of a correct answer rises with the
 * stimulus (e.g. flash duration) along a logistic curve in log units,
 * passing 70.7 % exactly at `p707`.
 */
function observer(p707, rnd) {
  const slope = 4; // per log unit
  const bias = Math.log(0.707 / 0.293); // logit of 70.7 %
  return (value) => rnd() < 1 / (1 + Math.exp(-(slope * Math.log(value / p707) + bias)));
}

test('2-down/1-up finds the 70.7 % point of a simulated athlete', () => {
  const rnd = U.rng(42);
  const truth = 180; // ms
  const estimates = [];
  for (let run = 0; run < 30; run++) {
    const answer = observer(truth, rnd);
    const sc = new Staircase({ min: 20, max: 1000, start: 500 });
    for (let t = 0; t < 60; t++) sc.update(answer(sc.value)); // about one session's worth of trials
    estimates.push(sc.threshold());
  }
  const est = U.geomean(estimates);
  assert.ok(Math.abs(Math.log(est / truth)) < Math.log(1.15), `estimate ${est.toFixed(0)} ms vs true ${truth} ms`);
});

test('stays inside its bounds and moves the right way when higher is harder', () => {
  const sc = new Staircase({ min: 1, max: 6, start: 3, lowerIsHarder: false, factor: 1.5 });
  for (let i = 0; i < 20; i++) sc.update(true);
  assert.equal(sc.value, 6, 'a run of correct answers should push it to the hardest (highest) value');
  for (let i = 0; i < 20; i++) sc.update(false);
  assert.equal(sc.value, 1, 'a run of errors should push it to the easiest (lowest) value');
});
