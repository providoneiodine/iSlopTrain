/*
 * The Lap Viewer marks a wet session: rain over the 3D view and a Wet chip only
 * when a compared lap really ran wet, never for a dry or "mostly dry" track.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

test('dry laps show no rain; a wet or rained-on lap does, and says which', () => {
  const K = load().Review.Conditions;
  // dry, mostly dry (iRacing 0.1), and a file with no conditions at all
  assert.equal(K.wet([{ wetness: 0, precip: 0 }, { wetness: 0.1 }, {}]), null);
  const W = K.wet([{ wetness: 0, precip: 0 }, { wetness: 0.35, precip: 0 }]);
  assert.deepEqual(W.laps, [false, true]);
  assert.equal(W.rain, false);
  assert.equal(W.level, 0.35);
  // rain falling on a track not yet wet still counts
  assert.equal(K.wet([{ wetness: 0, precip: 0.3 }]).rain, true);
});
