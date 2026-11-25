/*
 * The lap viewer's follow cameras: the car you follow holds still on screen
 * at any speed however uneven the frames are, a drag keeps it in view from
 * every side, and one Apex camera covers a whole corner sequence.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const W = 1280, H = 720;

/** A lap line as Scene stores it: a 300 m straight into a 150 m radius left-hander, a point every metre. */
function line(n) {
  const P = new Float32Array(n * 3);
  let x = 0, z = 0, hdg = 0;
  for (let i = 0; i < n; i++) {
    P.set([x, 0.12, z], i * 3);
    if (i > 300) hdg += 1 / 150;
    x += Math.cos(hdg);
    z -= Math.sin(hdg);
  }
  return P;
}

function setup() {
  const { Review } = load();
  const n = 1200, P = line(n);
  const scene = { base: [P], centre: P, fenceH: 3.5 };
  const w = new Float32Array(n).fill(6);
  // a chicane (two apexes 80 m apart) and a lone corner far from it
  const corners = [{ apex: 350, dir: 1, complex: 0 }, { apex: 430, dir: -1, complex: 0 }, { apex: 1000, dir: 1, complex: 1 }];
  const cmp = { n, step: 1, corners, complexes: [{ corners: [0, 1] }, { corners: [2] }], centre: { w } };
  const cam = Review.Camera.create();
  cam.size = 2000;
  const rigAt = (mode, f) => Review.Rigs.rig(mode, { pose: Review.Rigs.pose(scene, 0, f), f, cmp, scene, user: cam.user });
  /** Where the car is drawn, px, after following it to f for dt seconds. */
  const frame = (mode, f, dt) => {
    cam.follow(rigAt(mode, f), dt);
    const p = Review.Rigs.pose(scene, 0, f).p;
    return Review.M3.project(cam.matrices(W, H).vp, p[0], p[1], p[2], W, H);
  };
  const settle = (mode, f) => {
    let p;
    for (let i = 0; i < 400; i++) p = frame(mode, f, 1 / 60);
    return p;
  };
  return { Review, cam, frame, settle, rigAt };
}

test('the followed car holds still on screen at speed, through dropped and uneven frames', () => {
  ['chase', 'top', 'side'].forEach((mode) => {
    const { cam, frame, settle } = setup();
    cam.setMode(mode);
    const home = settle(mode, 20);
    // 300 km/h down the straight: steady frames, then every few a long one or a short one
    let f = 20, worst = 0;
    for (let k = 0; k < 150; k++) {
      const dt = k % 7 === 3 ? 1 / 20 : k % 5 === 1 ? 1 / 144 : 1 / 60;
      f += 83 * dt;
      const p = frame(mode, f, dt);
      worst = Math.max(worst, Math.hypot(p.x - home.x, p.y - home.y));
    }
    assert.ok(worst < 1, mode + ': the car moved ' + worst.toFixed(2) + ' px on screen');
  });
});

test('through a corner the camera swings round smoothly: no jump between frames', () => {
  const { cam, frame, settle } = setup();
  cam.setMode('chase');
  let prev = settle('chase', 280), f = 280, worst = 0;
  for (let k = 0; k < 240; k++) {
    const dt = k % 7 === 3 ? 1 / 30 : 1 / 60;
    f += 60 * dt;
    const p = frame('chase', f, dt);
    worst = Math.max(worst, Math.hypot(p.x - prev.x, p.y - prev.y));
    prev = p;
  }
  assert.ok(worst < 6, 'the car jumped ' + worst.toFixed(1) + ' px in one frame');
});

test('dragging the chase or side camera keeps the car in view from every side, zoomed in or out', () => {
  ['chase', 'side'].forEach((mode) => {
    const { Review, cam, settle } = setup();
    cam.setMode(mode);
    const [lo, hi] = Review.Rigs.LIMITS[mode];
    for (const zoom of [0.2, 1, 6]) {
      for (let yaw = -3; yaw <= 3; yaw += 0.75) {
        for (const pitch of [lo, 0, hi]) {
          Object.assign(cam.user, { zoom, yaw, pitch });
          const p = settle(mode, 500), at = mode + ' yaw ' + yaw + ' pitch ' + pitch + ' zoom ' + zoom;
          assert.ok(p.w > 0, at + ': the car is behind the camera');
          assert.ok(Math.abs(p.x - W / 2) < W * 0.2 && Math.abs(p.y - H / 2) < H * 0.4, at + ': the car is at ' + Math.round(p.x) + ', ' + Math.round(p.y));
          assert.ok(cam.view.eye[1] > 0.3, at + ': the camera is under the road');
        }
      }
    }
  });
});

test('turning the top-down camera turns the view round the car, which stays where it was', () => {
  const { cam, settle } = setup();
  cam.setMode('top');
  const home = settle('top', 500);
  assert.ok(Math.abs(home.x - W / 2) < 1 && home.y > H / 2, 'the car sits below the centre');
  for (const yaw of [-2.5, -1, 1, 2.5]) {
    cam.user.yaw = yaw;
    const p = settle('top', 500);
    assert.ok(Math.hypot(p.x - home.x, p.y - home.y) < 1, 'yaw ' + yaw + ' moved the car to ' + Math.round(p.x) + ', ' + Math.round(p.y));
  }
});

test('one Apex camera per corner sequence: it stays put through a chicane and frames the car', () => {
  const { Review, cam, frame, rigAt } = setup();
  assert.ok(!Review.Rigs.MODES.some((m) => m[0] === 'complex'), 'the Complex camera is part of Apex now');
  cam.setMode('trackside');
  const a = rigAt('trackside', 340), b = rigAt('trackside', 440), c = rigAt('trackside', 990);
  assert.equal(a.key, b.key, 'no cut between the apexes of a chicane');
  assert.deepEqual(a.eye, b.eye, 'the camera stays put through the chicane');
  assert.notEqual(a.key, c.key, 'the next corner has its own camera');
  // through the chicane and out of it the car stays near the middle of the picture
  for (let f = 250; f < 520; f += 2) {
    const p = frame('trackside', f, 1 / 60);
    assert.ok(p.w > 0 && Math.hypot(p.x - W / 2, p.y - H / 2) < 100, 'at ' + f + ' m the car is at ' + Math.round(p.x) + ', ' + Math.round(p.y));
  }
});

test('satellite ground under a part lap: the stretch it never drove sits at a whole lap’s height', () => {
  const IST = load();
  // a 2 km straight climbing 1 in 20; the part lap drove only the first 500 m
  const N = 2001, whole = { x: new Float32Array(N), y: new Float32Array(N), z: new Float32Array(N), step: 1 };
  for (let i = 0; i < N; i++) (whole.x[i] = i), (whole.z[i] = i / 20);
  const n = 501, C = new Float32Array(n * 3), w = new Float32Array(n).fill(6);
  const S = { toGL: (x, y, z) => [x, z, -y], centre: C };
  for (let i = 0; i < n; i++) C.set(S.toGL(i, 0, i / 20), i * 3);
  const alone = IST.Review.MapLayer.terrain(S, { centre: { w }, step: 1 }, 1);
  const helped = IST.Review.MapLayer.terrain(S, { centre: { w }, step: 1, ground: whole }, 1);
  // at 1500 m the road is 75 m up: on its own the part lap can only guess from its own 0..25 m
  assert.ok(alone(1500, 0) < 30, 'without a whole lap the far ground is a guess (' + alone(1500, 0).toFixed(1) + ' m)');
  assert.ok(Math.abs(helped(1500, 0) - (75 - 0.4)) < 0.5, 'with one it is just under the road (' + helped(1500, 0).toFixed(1) + ' m)');
  assert.ok(Math.abs(helped(250, 0) - (12.5 - 0.4)) < 0.5, 'and the stretch it did drive is unchanged');
});
