/*
 * The folder watch offers a new .ibt only once iRacing has finished writing it,
 * and never offers what was already there or what it offered before.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

// arrays from the sandbox are another realm's: copy them before comparing
const W = () => {
  const tr = load().Review.Watch.tracker;
  return { tracker: (ms, known) => { const t = tr(ms, known); return { scan: (e, now) => [...t.scan(e, now)] }; } };
};
const f = (name, size, mtime) => ({ name, size, mtime: mtime || size });

test('files already in the folder are the baseline, not offered', () => {
  const t = W().tracker(8000);
  assert.deepEqual(t.scan([f('old.ibt', 100)], 0), []);
  assert.deepEqual(t.scan([f('old.ibt', 100)], 20000), []);
});

test('a file still growing is held until its size stops changing', () => {
  const t = W().tracker(8000);
  t.scan([], 0);
  assert.deepEqual(t.scan([f('a.ibt', 10)], 1000), []);
  assert.deepEqual(t.scan([f('a.ibt', 20)], 7000), []);
  assert.deepEqual(t.scan([f('a.ibt', 30)], 14000), [], 'still growing');
  assert.deepEqual(t.scan([f('a.ibt', 30)], 20000), []);
  assert.deepEqual(t.scan([f('a.ibt', 30)], 22000), ['a.ibt'], 'settled 8 s');
  assert.deepEqual(t.scan([f('a.ibt', 30)], 40000), [], 'offered once');
});

test('an empty file is never offered, and one deleted mid-write is forgotten', () => {
  const t = W().tracker(1000);
  t.scan([], 0);
  t.scan([f('e.ibt', 0), f('d.ibt', 5)], 1);
  assert.deepEqual(t.scan([f('e.ibt', 0)], 5000), []);
  assert.deepEqual(t.scan([f('d.ibt', 5)], 6000), [], 'reappearing restarts the wait');
  assert.deepEqual(t.scan([f('d.ibt', 5)], 7000), ['d.ibt']);
});

test('after a reload, files recorded while the app was closed are offered', () => {
  const t = W().tracker(1000, ['old.ibt']);
  t.scan([f('old.ibt', 9), f('new.ibt', 9)], 0);
  assert.deepEqual(t.scan([f('old.ibt', 9), f('new.ibt', 9)], 2000), ['new.ibt']);
});
