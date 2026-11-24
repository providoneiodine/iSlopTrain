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

test('a prototype held up in the passing lane waits for the slow car instead of steering into it', () => {
  // the GT's pick can slow the prototype, but its move back to the line must not be blamed on you as contact
  const r2 = U.rng(11);
  let n = 0;
  for (let i = 0; i < 16 && n < 8; i++) {
    const q = LL.run(TL.questionGen(cx, 2, 'slow', 'hold', r2, { variant: 'traffic' }));
    if (!q) continue;
    n++;
    for (const o of q.opts) {
      const c = o.r.contact;
      const straight = c && TL.where(q.X, c.s) === 'on the straight';
      assert.ok(!(straight && c.who.indexOf('S') < 0), `"${o.id}": the prototype ran into the slow car on the straight`);
    }
  }
  assert.ok(n >= 4, 'too few traffic questions built');
});

// ------------------------------------------------ calibration (see traffic-lab.js header)
/** Asymptotic top speed (km/h) and peak deceleration from it (g). */
function limits(car) {
  let v = 30;
  for (let t = 0; t < 120; t += 0.01) {
    const a = Math.min(car.aTrac, car.power / v) - car.drag * v * v;
    if (a < 1e-4) break;
    v = Math.min(car.vMax, v + a * 0.01);
  }
  return { top: v * 3.6, brake: (LL.brkA(car, v) + car.drag * v * v) / 9.81, lat: (v2) => LL.latA(car, v2) / 9.81 };
}

test('class gaps match the published IMSA/WEC ranges the drill claims', () => {
  const P = limits(TL.PROTO), G = limits(TL.GT);
  assert.ok(P.top - G.top >= 25 && P.top - G.top <= 55, `top speed gap ${(P.top - G.top).toFixed(0)} km/h`);
  assert.ok(P.brake >= 2.7 && P.brake <= 3.4, `prototype peak braking ${P.brake.toFixed(2)} g (~3 g)`);
  assert.ok(G.brake >= 1.8 && G.brake <= 2.3, `GT peak braking ${G.brake.toFixed(2)} g (~2 g)`);
  assert.ok(P.lat(69) >= 2.9 && G.lat(61) <= 2.4, 'high-speed cornering: prototype ~3.2 g, GT ~2.2 g');
  // on a real complex the GT brakes within a few tens of metres of the prototype's point
  const X = TL.setup(cx.geo, cx.ideal, TL.cars(null));
  assert.ok(Math.abs(X.bF - X.bS) < 60, `braking points ${(X.bF - X.bS).toFixed(0)} m apart`);
});

for (const [role, variant, rules] of [['fast', 'late', 'hold'], ['slow', 'late', 'hold'], ['fast', 'pair', 'hold'], ['slow', 'traffic', 'hold'], ['slow', 'traffic', 'yield']]) {
  test(`${variant} (${role} car, "${rules}"): one responsible call, safe, and a plausible situation`, () => {
    let q = null;
    for (let i = 0; i < 12 && !q; i++) q = LL.run(TL.questionGen(cx, 3, role, rules, rnd, { variant }));
    assert.ok(q, `no ${variant} question could be built`);
    assert.equal(q.variant, variant);
    assert.equal(TL.plausible(q), null);
    const best = q.opts.filter((o) => o.correct);
    assert.equal(best.length, 1, `${best.length} options marked correct`);
    assert.equal(best[0].risk.level, 'safe');
    if (variant === 'late') assert.ok(q.timeLimit > 0, 'a late call has a time limit');
    if (variant !== 'late') assert.equal(q.extra.length, 1, 'a third car is on track');
  });
}

test('every generated situation passes the plausibility filter, and no option is a move drivers never make', () => {
  for (const role of ['fast', 'slow']) {
    for (let i = 0; i < 4; i++) {
      const q = LL.run(TL.questionGen(cx, 3, role, 'hold', rnd));
      if (!q) continue;
      assert.equal(TL.plausible(q), null);
      assert.ok(!q.opts.some((o) => o.id === 'brakeMove'), 'moving over under braking is offered');
    }
  }
});

test('covering the inside early is the call when a prototype lines up a late dive, and unpredictable once it has pulled out', () => {
  let q = null;
  for (let i = 0; i < 8 && !q; i++) q = LL.run(TL.questionGen(cx, 3, 'slow', 'hold', rnd, { variant: 'normal', type: 'marginal' }));
  assert.ok(q, 'no marginal-dive question could be built');
  const def = q.opts.find((o) => o.id === 'defend');
  assert.equal(def.offline, false, 'an early cover against an uncommitted dive is a legitimate move');
  assert.equal(def.risk.level, 'safe');
  assert.ok(def.loss < 0.5, `covering the inside cost the GT ${def.loss.toFixed(2)} s`);
  let c = null;
  for (let i = 0; i < 8 && !c; i++) c = LL.run(TL.questionGen(cx, 3, 'slow', 'hold', rnd, { variant: 'normal', type: 'committed' }));
  assert.ok(c, 'no committed question could be built');
  assert.equal(c.opts.find((o) => o.id === 'defend').offline, true, 'covering a side it has already taken');
});
