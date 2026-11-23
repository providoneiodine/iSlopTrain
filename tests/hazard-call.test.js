/*
 * Call the Hazard promises the player: a call is credited only for a live
 * hazard (wreck, yellow, spin) ahead, a wall call is a false call, every
 * live hazard you let pass uncalled is counted as missed, and "seen, not
 * stared" never credits a call made while the eyes were on the hazard board.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const IST = require('./harness').load();
const U = IST.util, HL = IST.HazardLayer;

/** Drive a lap past every hazard; decide(hz) says whether to press Confirm for the nearest open one. */
function lap(decide) {
  const vmax = 60;
  const track = IST.Track.generate({ rng: U.rng(7), vmax, minLength: 9000, leadIn: 60, minStraight: 14, maxStraight: 55, elevation: 'flat', mix: 'mixed', aLat: 15, aBrake: 13, aAccel: 6, aero: 0.35 });
  let missed = 0;
  const layer = new HL({ track, rnd: U.rng(3), level: 4, audio: false, framing: 'approach', boardThrough: () => null, call: true, onMissed: () => missed++ });
  const results = [];
  let pos = 0, ts = 0;
  while (pos < track.lastCornerEnd) {
    ts += 1000 / 60;
    pos += track.speedAt(pos) / 60;
    layer.update(1000 / 60, ts, ts, pos);
    const open = layer.list.filter((h) => h.win === 1 && h.calledTs == null).sort((a, b) => a.anchor - b.anchor)[0];
    if (open && decide(open)) results.push(layer.call(ts));
  }
  return { layer, missed, results, s: layer.callSummary() };
}

test('calling only live hazards credits every one, with no false calls', () => {
  const { s, missed, results } = lap((hz) => hz.live);
  assert.ok(s.live >= 3 && s.walls >= 1, 'track should have both kinds of hazard');
  assert.equal(s.called, s.live);
  assert.equal(missed, 0);
  assert.equal(s.wallCalls + s.noneCalls, 0);
  assert.ok(results.every((r) => r.kind === 'live'));
});

test('calling walls is a false call, and the live hazards still count as missed', () => {
  const { s, missed, results } = lap((hz) => !hz.live);
  assert.ok(results.length >= 1 && results.every((r) => r.kind === 'wall'));
  assert.equal(s.wallCalls, results.length);
  assert.equal(s.called, 0);
  assert.equal(missed, s.live);
});

test('a call with nothing ahead is a false call', () => {
  const { layer } = lap(() => false);
  assert.equal(layer.call(1e9).kind, 'none');
  assert.equal(layer.callSummary().noneCalls, 1);
});

test('"seen, not stared" excludes calls made with the eyes on the hazard board', () => {
  const def = IST.getDrill('eyes-off-wall-call');
  const row = (called, outcome) => ({ hz: 'wreck', live: true, probe: true, called, outcome, framing: 'approach' });
  const H = [row(true, 'apex'), row(true, 'hazard'), row(false, 'apex'), row(false, 'hazard')];
  const T = H.map((h) => ({ correct: h.outcome === 'apex' }));
  const calls = { live: 4, called: 2, walls: 0, wallCalls: 0, noneCalls: 0, callRT: null, callByHz: {} };
  const s = def.hazardSummary(T, H, 1, calls);
  assert.equal(s.seenRate, 1 / 4);
  assert.deepEqual({ ...s.callGrid }, { seen: 1, looked: 1, missed: 1, missedCap: 1 });
});
