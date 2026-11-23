/*
 * LineLab is the ground truth for Draw the Line and Class Traffic: the
 * "ideal" line, the time each mistake costs and the corner-by-corner verdict
 * all come from it. These tests pin the claims the drills make to the player.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const IST = require('./harness').load();
const { LineLab: LL, util: U } = IST;

const RIGHT_ANGLE = { items: [['s', 260], ['c', 1, 32, 90], ['s', 480]] };
// solving the ideal takes a few seconds, so the tests share one
const geo = LL.build(RIGHT_ANGLE);
const ideal = LL.solveIdeal(geo);

const headingChange = (g) => ((g.th[Math.round(g.sEnd / g.DS)] + Math.PI / 2) * 180) / Math.PI;

test('a 90° right-hander turns the road 90° right, and mirroring turns it left', () => {
  assert.ok(Math.abs(headingChange(geo) - 90) < 2, `turned ${headingChange(geo).toFixed(1)}°`);
  const mirrored = LL.build(RIGHT_ANGLE, { mirror: true });
  assert.ok(Math.abs(headingChange(mirrored) + 90) < 2, `turned ${headingChange(mirrored).toFixed(1)}°`);
});

test('the speed profile never exceeds the car\'s top speed or cornering grip', () => {
  const { v, k, iStop } = ideal.sim;
  for (let i = 0; i <= iStop; i++) {
    assert.ok(v[i] <= LL.CAR.vMax + 1e-9, `over top speed at sample ${i}`);
    assert.ok(v[i] * v[i] * Math.abs(k[i]) <= LL.CAR.aLat * 1.001, `over lateral grip at sample ${i}`);
  }
});

test('the ideal line is faster than driving the centreline', () => {
  const centre = LL.simulate(geo, new Float64Array(geo.N + 1));
  assert.ok(ideal.time < centre - 0.1, `ideal ${ideal.time.toFixed(3)} s vs centreline ${centre.toFixed(3)} s`);
});

test('every wrong answer offered is genuinely slower, by the time it claims', () => {
  for (const level of [1, 3, 6]) {
    const lines = LL.distractors(geo, ideal, level, 3, U.rng(level));
    assert.ok(lines.length >= 2, `level ${level}: only ${lines.length} distractors`);
    for (const L of lines) {
      assert.ok(L.loss > 0, `level ${level} ${L.flaw}: not slower than the ideal`);
      assert.ok(Math.abs(L.time - ideal.time - L.loss) < 1e-9, `level ${level} ${L.flaw}: loss doesn't match its own lap time`);
    }
  }
});

test('the verdict finds nothing wrong with the ideal line itself', () => {
  const verdict = LL.judge(geo, ideal, ideal);
  const kinds = verdict.flatMap((r) => r.issues.map((is) => is.kind));
  assert.equal(kinds.length, 0, `ideal judged as [${kinds}]`);
  assert.ok(Math.abs(verdict[0].cost) < 1e-9);
});

test('the verdict names an early or late apex when the line has one', () => {
  for (const [flaw, expected] of [['early', 'early'], ['late', 'late']]) {
    const L = LL.lineFrom(geo, LL.applyFlaw(geo, ideal, flaw, 0, 1), ideal);
    const kinds = LL.judge(geo, ideal, L)[0].issues.map((is) => is.kind);
    assert.ok(kinds.includes(expected), `${flaw} line judged as [${kinds}]`);
    assert.ok(!kinds.includes(expected === 'early' ? 'late' : 'early'), `${flaw} line also judged the opposite way`);
  }
});
