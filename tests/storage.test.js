/*
 * Saved history is the user's only copy of their training data. These
 * check the trimming rules don't lose more than they say, and that a bad
 * import can't wipe what's there.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, memoryStorage } = require('./harness');

test('keeps the latest 300 sessions per drill, with per-trial detail on the latest 50, across a reload', () => {
  const ls = memoryStorage();
  const S = load({ localStorage: ls }).Storage;
  for (let i = 0; i < 320; i++) S.addResult('apex-snap', { summary: { i }, detail: [i] });
  S.addResult('two-point', { summary: { i: 0 }, detail: [0] });

  const after = load({ localStorage: ls }).Storage; // fresh page load
  const list = after.getResults('apex-snap');
  assert.equal(list.length, 300);
  assert.equal(list[0].summary.i, 20, 'the oldest sessions should be the ones dropped');
  assert.equal(list[299].summary.i, 319);
  assert.equal(list.filter((r) => r.detail).length, 50);
  assert.ok(list[299].detail && !list[249].detail, 'detail should be kept on the newest sessions');
  assert.equal(after.getResults('two-point').length, 1, 'other drills are untouched');
});

test('a file that isn\'t an export is rejected without touching saved data', () => {
  const S = load().Storage;
  S.addResult('apex-snap', { summary: { i: 1 } });
  assert.throws(() => S.importJSON('{"hello": "world"}'));
  assert.throws(() => S.importJSON('not json'));
  assert.equal(S.getResults('apex-snap').length, 1);
});

test('an export imports back as the same data', () => {
  const a = load().Storage;
  a.addResult('apex-snap', { summary: { score: 9 } });
  a.setPref('gameFeel', 'silent');
  const b = load().Storage;
  b.importJSON(a.exportJSON());
  assert.equal(b.getResults('apex-snap')[0].summary.score, 9);
  assert.equal(b.getPref('gameFeel'), 'silent');
});

test('an export with a broken section still imports, and the rest of the app can read it', () => {
  const S = load().Storage;
  S.importJSON(JSON.stringify({ results: { 'apex-snap': [{ summary: { score: 1 } }, { date: 5 }, null], 'two-point': 'oops' }, prefs: null }));
  assert.equal(S.getResults('apex-snap').length, 1, 'sessions without a summary are dropped');
  assert.equal(S.getResults('two-point').length, 0);
  assert.equal(S.getPref('juice', 'full'), 'full', 'a missing prefs section reads as defaults');
  assert.equal(Object.keys(S.getBindings()).length, 0);
});
