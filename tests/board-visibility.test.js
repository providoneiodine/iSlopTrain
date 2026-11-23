/*
 * Flash drills promise the player that a missed flash means the eyes were
 * elsewhere, not that the board couldn't be seen: every arrow is shown on a
 * board that is readable (on screen, clear of the HUD band, crests and the
 * cockpit, not fading as you reach it) for every frame it is on, by the one
 * rule in IST.View.board. That holds for Apex Snap's apex boards, Eyes Off
 * the Wall's hazard boards on probe flashes, and Two-Point's apex board.
 *
 * Headless, the cockpit mask reads as empty, so this covers the geometry
 * (screen, crests, fade), not cockpit occlusion.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, mockContext2D } = require('./harness');

const W = 1280, H = 720, DT = 1000 / 60;

function settingsFor(def, over) {
  const s = {};
  def.settings.forEach((f) => (s[f.key] = f.default));
  return Object.assign(s, over);
}

/**
 * Apex Snap family: answer three flashes in four right, so the staircase holds the
 * flash long (around its start) and late flashes run on toward the board.
 */
function answer(inst, p, ts, n) {
  if (p.answered) return;
  p.answered = true;
  inst.onAction(n % 4 === 3 ? (p.dir === 'up' ? 'down' : 'up') : p.dir, ts + 1);
}

/** Step a drill on a simulated clock; check(inst) runs after every rendered frame. */
function play(drillId, over, check, limitMs) {
  const IST = load();
  const def = IST.getDrill(drillId);
  let clock = 0, finished = false;
  const ctx = { def, settings: settingsFor(def, over), history: [], W, H, clock: () => clock, frameInterval: () => DT, finish: () => (finished = true) };
  const inst = def.create(ctx);
  const g = mockContext2D({ width: W, height: H });
  for (let ts = 0; !finished && clock < limitMs; ts += DT) {
    clock += DT;
    inst.update(DT, clock, ts);
    if (finished) break;
    inst.render(g, W, H, ts, false);
    check(inst, IST, ts);
  }
  return inst;
}

test('Apex Snap: every arrow is on a readable apex board for every frame it shows', () => {
  let frames = 0;
  const flashes = new Set();
  // long flashes at a high speed: the case where a late flash runs on toward the board
  play('apex-snap', { duration: 180, speed: 300, startExposure: 700, carryOver: false }, (inst, IST, ts) => {
    const { st, track, boardAt, boardX } = inst.debug();
    const p = st.plan;
    if (p && p.state === 'masked') answer(inst, p, ts, flashes.size);
    if (!p || p.state !== 'shown') return;
    const c = track.corners[p.corner];
    frames++;
    flashes.add(p);
    assert.ok(boardAt(c.apexPos, boardX(c)), 'arrow shown on a board that is not readable (corner ' + p.corner + ')');
  }, 200 * 1000);
  assert.ok(flashes.size >= 10, 'too few flashes to judge: ' + flashes.size);
  assert.ok(frames > flashes.size, 'flashes should last several frames');
});

test('Eyes Off the Wall: a probe arrow is on a readable hazard board for every frame it shows', () => {
  const probes = new Set();
  let n = 0;
  play('eyes-off-wall', { duration: 240, threat: '4', startExposure: 500, carryOver: false }, (inst, IST, ts) => {
    const { st, hz, boardAt } = inst.debug();
    const p = st.plan;
    if (p && p.state === 'masked') answer(inst, p, ts, n++);
    if (!p || p.state !== 'shown') return;
    if (p.probe) {
      probes.add(p);
      assert.ok(boardAt(p.hazard.anchor, hz.boardX(p.hazard)), 'probe shown on a hazard board that is not readable');
    }
  }, 260 * 1000);
  assert.ok(probes.size >= 3, 'too few probe flashes to judge: ' + probes.size);
});

test('Two-Point Focus: every trial flashes on a readable apex board', () => {
  const trials = new Set();
  play('two-point', { trials: 20 }, (inst) => {
    const { tr, board } = inst.debug();
    if (!tr || tr.phase !== 'stim') return;
    trials.add(tr);
    const b = board();
    assert.equal(b.why, null, 'trial shown on a board that is not readable: ' + b.why);
  }, 10 * 60 * 1000);
  assert.ok(trials.size >= 10, 'too few trials to judge: ' + trials.size);
});
