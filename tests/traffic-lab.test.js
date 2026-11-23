/*
 * Class Traffic marks one option per question as "the responsible call".
 * These tests check that the call it marks keeps the promises the drill's
 * Info screen makes: safe, allowed by the rule set, fastest of those, and
 * (where the rules say give way) not holding the faster car up.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const IST = require('./harness').load();
const { TrafficLab: TL, LineLab: LL, util: U } = IST;

const rnd = U.rng(7);
// building and solving the complex takes a few seconds; every question below reuses it
const cx = LL.run(TL.complexGen(TL.SCENARIOS.find((s) => s.id === 'ninety'), rnd));

function question(role, rules) {
  for (let i = 0; i < 6; i++) {
    const q = LL.run(TL.questionGen(cx, 2, role, rules, rnd));
    if (q) return q;
  }
  assert.fail(`no ${role}-car question could be built under "${rules}"`);
}

for (const [role, rules] of [['fast', 'hold'], ['slow', 'hold'], ['slow', 'yield'], ['fast', 'pointby']]) {
  test(`${role} car, "${rules}" rules: exactly one responsible call, and it is safe and allowed`, () => {
    const q = question(role, rules);
    const best = q.opts.filter((o) => o.correct);
    assert.equal(best.length, 1, `${best.length} options marked correct`);
    const b = best[0];
    assert.equal(b.risk.level, 'safe', `the call "${b.id}" carries risk (${b.risk.why})`);
    assert.ok(b.ok, `the call "${b.id}" isn't an acceptable option`);
    for (const o of q.opts.filter((x) => x.ok && !x.held)) {
      assert.ok(b.loss <= o.loss + 1e-9, `"${o.id}" is safe, allowed and faster than the call "${b.id}"`);
    }
    if (role === 'slow' && rules !== 'hold') assert.ok(!b.held, `the call "${b.id}" holds the faster car up`);
  });
}

test('cars on the same line never drive through each other', () => {
  const X = TL.setup(cx.geo, cx.ideal, TL.cars(U.rng(3)));
  // prototype starts 20 m behind the GT on the same racing line: it must follow, not merge into it
  const sS0 = X.bS - 400;
  const r = TL.run(X, { plan: X.freeF, s0: sS0 - TL.CARLEN - 20 }, { plan: X.freeS, s0: sS0 });
  assert.equal(r.contact, null, 'contact while following');
  assert.ok(r.minGap > TL.CONTACT, `closest approach ${r.minGap.toFixed(2)} m`);
  assert.ok(r.loss[0] > 0, 'the car stuck behind lost no time');
});
