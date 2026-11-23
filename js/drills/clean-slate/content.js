/*
 * Clean Slate: timings, burst and distraction ladders, labels and colours.
 * Plain data, no drawing or state.
 *
 * Files in js/drills/clean-slate/ load in this order and share the drill's
 * private namespace IST.CleanSlate:
 *   content.js  this file
 *   stats.js    the session summary (recovery, chaining, post-error shift),
 *               coach tips and the Stats page breakdowns
 *   view.js     drawing: the lane, rows, chain counter, distractions, effects, HUD
 *   drill.js    the drill definition, the row engine (staircase, bursts,
 *               scoring) and input
 */
(function () {
  'use strict';
  const Sym = IST.Symbols;
  const CS = (IST.CleanSlate = {});
  const DIRS = Sym.DIRS;
  const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' };
  const PERP = { up: ['left', 'right'], down: ['left', 'right'], left: ['up', 'down'], right: ['up', 'down'] };

  const APPROACH = 1600; // default ms from entering the lane to the hit line (setting: approach)
  const APPROACH_OPTS = [['2200', 'Slow (2.2 s)'], ['1600', 'Normal (1.6 s)'], ['1200', 'Fast (1.2 s)'], ['900', 'Very fast (0.9 s)']];
  const BEAT = 850; // ms between rows
  const RUSH_BEAT = 480; // ms between rows during a rush burst
  const HW = 150; // hit window half-width (ms)
  const PERFECT = 45, GREAT = 95; // timing grades (ms from the line)
  const ORANGE_BASE = 0.15; // share of orange (flipped) rows on normal play
  const WARMUP = 12; // rows before the first burst while the reveal settles
  const REC_WIN = 10; // rows measured after each burst
  const CURVE = 8; // positions shown on the recovery curve
  const CLEAN_RUN = 3; // consecutive clean answers = recovered
  const SLOW_X = 1.25; // a clean answer is also no slower than 1.25x baseline median
  const TARGET = 0.88; // staircase target accuracy
  const LEAD_MIN = 200; // the most is the approach time: revealed as it enters the lane
  const MIN_BURSTS = 3;
  const MAX_LEVEL = 6;

  const COL = { blue: '#3d9bff', orange: '#ff9a3d', flank: '#aeb6c4', look: '#7f9cc0', mask: '#363c48' };

  const BURST_LEVELS = [
    null,
    { types: ['squeeze'], len: [3, 3], gap: [24, 32], dbl: 0, sq: 0.6 },
    { types: ['squeeze', 'rush'], len: [3, 4], gap: [22, 30], dbl: 0, sq: 0.58 },
    { types: ['squeeze', 'rush', 'clutter'], len: [4, 5], gap: [20, 28], dbl: 0, sq: 0.55 },
    { types: ['squeeze', 'rush', 'clutter', 'flip'], len: [4, 5], gap: [18, 26], dbl: 0.2, sq: 0.52 },
    { types: ['squeeze', 'rush', 'clutter', 'flip'], len: [5, 6], gap: [16, 24], dbl: 0.35, sq: 0.5 },
    { types: ['squeeze', 'rush', 'clutter', 'flip'], len: [5, 7], gap: [15, 22], dbl: 0.5, sq: 0.48 },
  ];
  const BURST_LABELS = { squeeze: 'Squeeze', rush: 'Rush', clutter: 'Clutter', flip: 'Flip', double: 'Double hit' };

  const DIST_LEVELS = [
    { rate: 0, types: [] },
    { rate: 0.25, types: ['pop'], soa: [-200, 0] },
    { rate: 0.3, types: ['pop', 'word'], soa: [-200, 50] },
    { rate: 0.35, types: ['pop', 'word', 'decoy'], soa: [-150, 80] },
    { rate: 0.4, types: ['pop', 'word', 'decoy', 'chirp', 'jitter'], soa: [-120, 100] },
    { rate: 0.45, types: ['pop', 'word', 'decoy', 'chirp', 'jitter', 'fakebuzz'], soa: [-100, 120] },
    { rate: 0.5, types: ['pop', 'word', 'decoy', 'chirp', 'jitter', 'fakebuzz', 'glitch'], soa: [-80, 150], multi: 0.4 },
  ];
  const DIST_LABELS = { none: 'No distraction', pop: 'Flash', word: 'Taunt word', decoy: 'Decoy arrow', chirp: 'Chirp', jitter: 'Drifting row', fakebuzz: 'Fake error buzz', glitch: 'HUD glitch' };
  const DIST_DUR = { pop: 140, word: 650, decoy: 260, glitch: 380, chirp: 0, fakebuzz: 0, jitter: 0 };
  const WORDS = ['SLOW', 'AGAIN?', 'WRONG', 'MISS', 'TOO LATE', 'HURRY', 'LOSING IT', '−0.4', 'PUSH', 'NOPE', 'FOCUS?', 'PRESSURE'];
  const POP_COLORS = ['#ffffff', '#f5c400', '#ff5a4f'];

  const levelOpts = (withOff) =>
    [['auto', 'Auto (adapts)']].concat(withOff ? [['off', 'Off']] : []).concat([1, 2, 3, 4, 5, 6].map((n) => [String(n), String(n)]));

  Object.assign(CS, {
    DIRS, OPP, PERP, APPROACH, APPROACH_OPTS, BEAT, RUSH_BEAT, HW, PERFECT, GREAT, ORANGE_BASE, WARMUP, REC_WIN, CURVE, CLEAN_RUN, SLOW_X, TARGET,
    LEAD_MIN, MIN_BURSTS, MAX_LEVEL, COL, BURST_LEVELS, BURST_LABELS, DIST_LEVELS, DIST_LABELS, DIST_DUR, WORDS, POP_COLORS, levelOpts,
  });
})();
