/*
 * Every drill plays a short session end to end, headless: frames are stepped
 * on a simulated clock, drawn to a canvas that draws nothing, and driven by
 * scripted input. This is the net under refactoring the drills: a renamed or
 * misplaced function anywhere in a drill's update or render paths throws
 * here, long before anyone opens the page. It also checks the session ends
 * and hands the results screen and Stats a result they can read.
 *
 * It doesn't judge how well the bot plays or what anything looks like.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, mockContext2D, element } = require('./harness');

const W = 1280, H = 720, DT = 1000 / 60;
const SIM_LIMIT = 30 * 60 * 1000; // simulated ms before giving up on a session ending

/** Default settings, with the session-length ones at their minimum. */
function shortSettings(def) {
  const s = {};
  def.settings.forEach((f) => {
    s[f.key] = f.default;
    if (f.type === 'number' && ['duration', 'trials', 'questions'].includes(f.key)) s[f.key] = f.min;
  });
  return s;
}

/** Draw the Line needs a drawn line: trace the ideal across the drawing area with the pointer. */
function drawIdeal(IST, canvas, st) {
  const A = st.area, V = A.V, geo = st.q.geo, n = st.q.ideal.n, HW = IST.LineLab.HW;
  const pts = [];
  for (let i = V.i0; i <= V.i1; i += 2) {
    const p = V.map(geo.cx[i] + n[i] * HW * geo.nx[i], geo.cy[i] + n[i] * HW * geo.ny[i]);
    pts.push({ offsetX: p[0] + A.x, offsetY: p[1] + A.y });
  }
  canvas.dispatch('pointerdown', pts[0]);
  pts.slice(1).forEach((p) => canvas.dispatch('pointermove', p));
  canvas.dispatch('pointerup', pts[pts.length - 1]);
}

function playSession(drillId) {
  const IST = load();
  const def = IST.getDrill(drillId);
  const settings = shortSettings(def);
  let clock = 0, finished = false;
  const ctx = {
    def, settings, history: [], W, H,
    clock: () => clock,
    frameInterval: () => DT,
    finish: () => (finished = true),
  };
  const inst = def.create(ctx);
  const g = mockContext2D({ width: W, height: H });
  // answer, then step through any replay event by event ('up' skips to the next pause), switch option, step again
  const steps = Array(24).fill('up');
  const keys = ['confirm', ...steps, 'right', ...steps, 'left', 'down', 'confirm'];
  const stage = element(IST, 'stage');
  let k = 0;
  for (let ts = 0; !finished && clock < SIM_LIMIT; ts += DT) {
    clock += DT;
    inst.update(DT, clock, ts);
    if (finished) break;
    inst.render(g, W, H, ts, false);
    if (drillId === 'racing-line') {
      const st = inst.debug().st;
      if (st.mode === 'draw' && st.area && !st.strokes.length) drawIdeal(IST, stage, st); // again after an undo
    }
    if (Math.round(ts) % 200 < DT) inst.onAction(keys[k++ % keys.length], ts, 'test');
  }
  const result = Object.assign(inst.result(), { date: Date.now(), drill: def.id, settings, durationMs: Math.round(clock) });
  if (inst.destroy) inst.destroy();
  return { IST, def, finished, result };
}

const IST = load();
for (const def of IST.drills) {
  test(`${def.name}: a short session plays through, and the results and Stats pages can read it`, () => {
    const { IST: app, def: d, finished, result } = playSession(def.id);
    assert.ok(finished, 'the session never ended');
    const s = result.summary;
    assert.ok(s, 'no summary');
    const primary = app.primaryMetric(d).key;
    assert.ok(primary in s, `summary has no "${primary}" (the primary metric)`);
    // the results screen's tips and the Stats page read this session (and a history of them) without throwing
    const history = Array.from({ length: 6 }, () => result);
    if (d.coach) d.coach(s, result, history);
    app.Analysis.drillReport(d, history); // the Stats page's entry point (calls d.analyze)
  });
}
