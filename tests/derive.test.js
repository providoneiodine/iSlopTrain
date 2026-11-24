/*
 * The lap viewer's handling channels: the Balance lane says "understeer" or
 * "oversteer" only when the car really did, the same for left and right
 * corners, and the event markers (lockups, wheelspin, coasting, ABS) appear
 * where they happened and nowhere else.
 *
 * The drive is a single-track ("bicycle") model with a known steering ratio
 * and wheelbase (so a known steering gain G = SR x L), a known steering-wheel
 * offset, neutral in the linear range, then saturating the front (or the
 * rear) past 60 % of its grip.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const SR = 15, WB = 2.7, G = SR * WB, D0 = 3 * (Math.PI / 180), RATE = 60, R = 100, AYMAX = 20;
const DEG = Math.PI / 180;

/**
 * Straights and constant-radius circles with speed ramping up to the limit.
 * circles: [{ dir: +1 left / -1 right, end: 'front' | 'rear' }]
 */
function drive(circles) {
  const S = { t: [], speed: [], steer: [], yawRate: [], latG: [], vx: [], vy: [] };
  let t = 0;
  const push = (v, r, ay, sw, beta) => {
    S.t.push(t);
    S.speed.push(v);
    S.yawRate.push(r);
    S.latG.push(ay);
    S.steer.push(sw);
    S.vx.push(v * Math.cos(beta));
    S.vy.push(v * Math.sin(beta));
    t += 1 / RATE;
  };
  const straight = () => {
    for (let k = 0; k < 10 * RATE; k++) push(35, 0, 0, D0, 0);
  };
  straight();
  circles.forEach(({ dir, end }) => {
    const vMax = Math.sqrt(AYMAX * R), N = 120 * RATE;
    for (let k = 0; k < N; k++) {
      const v = 12 + (vMax - 12) * (k / N);
      const ay = (v * v) / R, band = ay / AYMAX;
      const sat = Math.max(0, band - 0.6) / 0.4; // 0 in the linear range, 1 at the limit
      // front saturating: extra lock for the same yaw; rear: less lock, and the car slides
      const extra = end === 'front' ? 25 * DEG * sat : end === 'rear' ? -12 * DEG * sat : 0;
      const beta = -dir * (0.5 * DEG * band + (end === 'rear' ? 5 * DEG * sat : 0));
      push(v, (dir * v) / R, dir * ay, D0 + dir * (SR * (WB / R) + extra), beta);
    }
    straight();
  });
  const n = S.t.length;
  const ch = {};
  for (const k in S) ch[k] = Float64Array.from(S[k]);
  return { S: { n, rate: RATE, ch, meta: {} }, t: ch.t };
}

const median = (a) => {
  const s = a.filter(isFinite).sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : NaN;
};
/** Derived values over the samples of a circle whose lateral g share is in [lo, hi). */
function where(S, D, dir, lo, hi, key) {
  const out = [];
  for (let i = 0; i < S.n; i++) {
    const a = S.ch.latG[i] * dir / AYMAX;
    if (a >= lo && a < hi) out.push(D.ch[key][i]);
  }
  return out;
}

test('balance: the steering gain and offset come from the drive itself, and the linear range reads neutral', () => {
  const T = load().Telemetry.lib();
  const { S, t } = drive([{ dir: 1, end: 'front' }, { dir: -1, end: 'front' }]);
  const D = T.derive(S, t);
  assert.ok(Math.abs(D.calib.G - G) / G < 0.05, 'steering gain ' + D.calib.G.toFixed(1) + ' vs ' + G);
  assert.ok(Math.abs(D.calib.d0 - D0) < 0.5 * DEG, 'steering offset recovered');
  [1, -1].forEach((dir) => {
    const lin = median(where(S, D, dir, 0.1, 0.35, 'us')) / DEG;
    assert.ok(Math.abs(lin) < 1, (dir > 0 ? 'left' : 'right') + ' linear range reads neutral (' + lin.toFixed(2) + '°)');
  });
});

test('balance: front saturation reads as understeer, the same in left and right corners', () => {
  const T = load().Telemetry.lib();
  const { S, t } = drive([{ dir: 1, end: 'front' }, { dir: -1, end: 'front' }]);
  const D = T.derive(S, t);
  const left = median(where(S, D, 1, 0.85, 1.01, 'us')), right = median(where(S, D, -1, 0.85, 1.01, 'us'));
  assert.ok(left > D.calib.thr && right > D.calib.thr, 'understeer past the front’s limit (' + (left / DEG).toFixed(1) + '°, ' + (right / DEG).toFixed(1) + '°)');
  assert.ok(Math.abs(left - right) < 1 * DEG, 'symmetric for left and right corners');
  assert.equal(median(where(S, D, 1, 0.9, 1.01, 'balState')), 1, 'state: understeer');
});

test('balance: rear saturation reads as oversteer, with the car more sideways than usual', () => {
  const T = load().Telemetry.lib();
  // two normal circles set what "usual" sideslip is; the third steps out
  const { S, t } = drive([{ dir: 1, end: 'none' }, { dir: -1, end: 'none' }, { dir: 1, end: 'rear' }]);
  const D = T.derive(S, t);
  const third = Math.floor(S.n * 0.68);
  const us = [], bx = [], st = [];
  for (let i = third; i < S.n; i++) {
    if (S.ch.latG[i] / AYMAX > 0.9) us.push(D.ch.us[i]), bx.push(D.ch.betaX[i]), st.push(D.ch.balState[i]);
  }
  assert.ok(median(us) < 0, 'less lock than the yaw needed: oversteer');
  assert.ok(median(bx) > 1.5 * DEG, 'sideslip excess ' + (median(bx) / DEG).toFixed(1) + '°');
  assert.equal(median(st), -1, 'state: oversteer');
});

test('countersteer: steering against the rotation is flagged as oversteer', () => {
  const T = load().Telemetry.lib();
  const { S, t } = drive([{ dir: 1, end: 'none' }, { dir: -1, end: 'none' }]);
  // half a second of slide on the first straight: yawing left, wheel turned right
  const a = 3 * RATE, b = a + 30;
  for (let i = a; i < b; i++) {
    S.ch.yawRate[i] = 0.4;
    S.ch.latG[i] = 6;
    S.ch.steer[i] = D0 - 30 * DEG;
  }
  const D = T.derive(S, t);
  const c = (b + a) >> 1;
  assert.equal(D.ch.counter[c], 1);
  assert.equal(D.ch.balState[c], -1);
  assert.equal(D.ch.counter[a - 60], 0, 'not on the straight before it');
});

test('no yaw rate or lateral g: no balance channel at all (the lane says "Not in this file")', () => {
  const IST = load();
  const T = IST.Telemetry.lib();
  const { S, t } = drive([{ dir: 1, end: 'front' }]);
  delete S.ch.yawRate;
  delete S.ch.latG;
  const D = T.derive(S, t);
  assert.equal(D.ch.us, undefined);
  assert.equal(D.ch.balState, undefined);
  const lap = { n: 10, us: null, speed: new Float32Array(10) };
  assert.equal(IST.Review.Traces.available({ laps: [lap] }, 'balance'), false);
});

// ------------------------------------------------------------------ events
/** A 1 km lap on a 1 m grid at 30 m/s, with every channel quiet. */
function quietLap() {
  const n = 1000, f = () => new Float32Array(n);
  const lap = { n, step: 1, t: f(), speed: f().fill(30), vx: f().fill(30), throttle: f().fill(0.6), brake: f(), absActive: f(), absCut: f(),
    wsLF: f().fill(30), wsRF: f().fill(30), wsLR: f().fill(30), wsRR: f().fill(30), coast: f() };
  for (let i = 0; i < n; i++) lap.t[i] = i / 30;
  return lap;
}
const kinds = (ev, k) => ev.filter((e) => e.kind === k);

test('lockups: a locked wheel under braking is one event, named by wheel; a twitch is not', () => {
  const T = load().Telemetry.lib();
  const lap = quietLap();
  for (let i = 100; i < 200; i++) (lap.brake[i] = 0.8), (lap.throttle[i] = 0);
  // two bursts 5 m apart (one lockup) and a 2 m blip (0.07 s, too short)
  for (let i = 120; i < 130; i++) lap.wsRF[i] = 20;
  for (let i = 135; i < 145; i++) lap.wsRF[i] = 20;
  for (let i = 180; i < 182; i++) lap.wsLF[i] = 20;
  const ev = kinds(T.events(lap), 'lock');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].wheel, 'RF');
  assert.ok(ev[0].i0 === 120 && ev[0].i1 === 144, 'from the first locked metre to the last');
});

test('wheelspin, coasting and ABS are marked where they happened', () => {
  const T = load().Telemetry.lib();
  const lap = quietLap();
  for (let i = 300; i < 320; i++) (lap.wsLR[i] = 36), (lap.throttle[i] = 1);
  for (let i = 500; i < 530; i++) lap.coast[i] = 1;
  for (let i = 700; i < 720; i++) (lap.absActive[i] = 1), (lap.brake[i] = 0.9);
  const ev = T.events(lap);
  const spin = kinds(ev, 'spin'), coast = kinds(ev, 'coast'), abs = kinds(ev, 'abs');
  assert.equal(spin.length, 1);
  assert.ok(spin[0].i0 === 300 && spin[0].wheel === 'LR');
  assert.equal(coast.length, 1);
  assert.ok(Math.abs(coast[0].dur - 29 / 30) < 1e-6, 'coasting time');
  assert.equal(abs.length, 1);
  assert.equal(ev.length, 3, 'nothing else on a quiet lap');
});
