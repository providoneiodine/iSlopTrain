/*
 * Review: the 3D lap viewer page (#screen-review).
 *
 *   IST.Review.open({ pick, demo, files })   show the page; optionally open the
 *                                            file picker, load the demo, or load files
 *   IST.Review.close()
 *
 * Layout: header, then the 3D stage (WebGL canvas + a 2D overlay, overlay.js)
 * with the trace strip under it, and a side column
 * with the lap list and the values at the cursor. One cursor (an index on
 * the reference lap's distance grid) is shared by the stage, the traces and
 * the readout. The 3D view also keeps it fractional (cursorF) so playback and
 * following cameras move smoothly between metres. Cars sit where each lap
 * was at the reference's time at the cursor, so their spacing is the gap.
 *
 * Loaded sessions stay in memory while the app is open, so leaving and
 * coming back keeps them. Nothing is saved or uploaded.
 */
(function () {
  'use strict';
  const U = IST.util, h = U.h, Th = IST.Theme, M = IST.Review.M3;
  const Cmp = IST.Review.Compare;
  const COLORS = [Th.butter, Th.sky, Th.lilac, Th.peach, Th.text];
  const MAX_LAPS = COLORS.length;
  const ACCEPT = '.ibt,.ld,.ldx,.csv,.tsv,.txt';
  const FONT = IST.Symbols.FONT;

  const state = {
    sessions: [], laps: [], refId: null, sel: [], errors: [], warnings: [],
    opts: { inputs: 'all', lean: false, cars: true, tags: true, gears: true, exag: 1 },
    cursor: -1, cursorF: -1, camMode: 'orbit', playing: false, playT: 0, rate: 1, loading: null,
  };
  let V = null; // live view (GL, camera, traces, DOM refs) while the page is open
  let originRef = null;
  const root = () => document.getElementById('screen-review');

  // ---------------------------------------------------------------- loading
  const picker = () => {
    const input = h('input', { type: 'file', multiple: true, accept: ACCEPT, class: 'hidden' });
    input.addEventListener('change', () => input.files.length && loadFiles(input.files));
    document.body.append(input);
    input.click();
    setTimeout(() => input.remove(), 60000);
  };

  async function loadFiles(files) {
    state.loading = { p: 0, label: 'Starting' };
    render();
    const res = await IST.Telemetry.load(files, (p, label) => {
      state.loading = { p, label };
      updateProgress();
    });
    state.loading = null;
    res.errors.forEach((e) => state.errors.push(e));
    res.sessions.forEach(addSession);
    render();
  }

  function addSession(s) {
    // line GPS sessions up on the first one's origin
    if (s.origin) {
      if (!originRef) originRef = s.origin;
      else {
        const kx = 6371008.8 * (Math.PI / 180) * Math.cos((originRef.lat * Math.PI) / 180), ky = 6371008.8 * (Math.PI / 180);
        const dx = (s.origin.lon - originRef.lon) * kx, dy = (s.origin.lat - originRef.lat) * ky;
        s.laps.forEach((l) => {
          for (let i = 0; i < l.n; i++) {
            l.x[i] += dx;
            l.y[i] += dy;
          }
        });
      }
    }
    const si = state.sessions.length;
    state.sessions.push(s);
    s.warnings.forEach((w) => state.warnings.push(s.file + ': ' + w));
    s.laps.forEach((l, k) => state.laps.push({ id: si + ':' + k, s, lap: l }));
    // pick the fastest full lap as the reference, and the next fastest to compare
    if (!state.refId) {
      const full = state.laps.filter((x) => x.lap.kind === 'full' && !x.lap.pit).sort((a, b) => a.lap.time - b.lap.time);
      const any = full.length ? full : state.laps.slice().sort((a, b) => b.lap.len - a.lap.len);
      if (any[0]) {
        state.refId = any[0].id;
        state.sel = [any[0].id].concat(full[1] ? [full[1].id] : []);
      }
    }
  }

  function loadDemo() {
    const text = IST.Review.Demo.csv(7);
    const file = new File([text], 'demo-session.csv', { type: 'text/csv' });
    loadFiles([file]);
  }

  // ------------------------------------------------------------- selection
  const byId = (id) => state.laps.find((x) => x.id === id);
  const bestFull = () => {
    const f = state.laps.filter((x) => x.lap.kind === 'full');
    return f.length ? Math.min.apply(null, f.map((x) => x.lap.time)) : NaN;
  };
  function toggle(id) {
    const i = state.sel.indexOf(id);
    if (i >= 0) {
      if (id === state.refId) return;
      state.sel.splice(i, 1);
    } else {
      if (state.sel.length >= MAX_LAPS) return flash('Up to ' + MAX_LAPS + ' laps at once. Untick one first.');
      state.sel.push(id);
    }
    rebuild();
  }
  function setRef(id) {
    state.refId = id;
    if (state.sel.indexOf(id) < 0) {
      if (state.sel.length >= MAX_LAPS) state.sel.pop();
      state.sel.push(id);
    }
    rebuild();
  }

  /** Comparison laps in colour order: reference first, then the order they were picked. */
  function comparison() {
    const ref = byId(state.refId);
    if (!ref) return null;
    const others = state.sel.filter((id) => id !== state.refId).map(byId).filter(Boolean);
    const cmp = Cmp.build(ref.lap, others.map((o) => o.lap), COLORS);
    cmp.laps.forEach((L, k) => (L.entry = k === 0 ? ref : others[k - 1]));
    return cmp;
  }

  // ------------------------------------------------------------------ view
  function open(o) {
    o = o || {};
    IST.App.show('screen-review');
    document.title = 'iSlopTrain Review';
    render();
    if (o.pick) picker();
    else if (o.demo) loadDemo();
    else if (o.files) loadFiles(o.files);
  }

  function close() {
    teardown();
    IST.App.exitToMenu ? IST.App.exitToMenu() : IST.App.show('screen-menu');
  }

  function teardown() {
    if (!V) return;
    cancelAnimationFrame(V.raf);
    V.detach && V.detach();
    V.ro && V.ro.disconnect();
    V.traces && V.traces.destroy();
    V.scene && V.scene.dispose();
    V.R && V.R.destroy();
    window.removeEventListener('keydown', V.onKey);
    V = null;
  }

  function header() {
    const has = state.sessions.length > 0;
    return h('div', { class: 'res-head' },
      h('div', null, h('span', { class: 'tag rv-tag' }, 'Telemetry'), h('h1', null, 'Lap Viewer')),
      h('div', { class: 'view-head-actions' },
        has ? h('button', { class: 'btn ghost', onclick: clearAll, title: 'Forget every loaded file' }, 'Clear') : null,
        h('button', { class: 'btn', onclick: picker }, has ? 'Add files' : 'Open files'),
        h('button', { class: 'btn primary', onclick: close }, 'Done')));
  }

  function clearAll() {
    Object.assign(state, { sessions: [], laps: [], refId: null, sel: [], errors: [], warnings: [], cursor: -1, cursorF: -1, playing: false });
    originRef = null;
    render();
  }

  function render() {
    teardown();
    const r = root();
    r.innerHTML = '';
    r.append(header());
    if (state.loading) return r.append(loadingBox());
    if (!state.laps.length) return r.append(emptyBox());
    r.append(viewer());
    start();
  }

  function dropTarget(el) {
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      el.classList.add('rv-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('rv-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('rv-over');
      if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
    });
    return el;
  }

  function emptyBox() {
    return h('div', null,
      state.errors.length ? errorList() : null,
      dropTarget(h('div', { class: 'rv-drop' },
        h('div', { class: 'rv-drop-title' }, 'Drop telemetry files here'),
        h('p', { class: 'muted' }, 'Read in this browser. Nothing is uploaded or saved.'),
        h('div', { class: 'card-actions rv-drop-actions' },
          h('button', { class: 'btn primary', onclick: picker }, 'Open files'),
          h('button', { class: 'btn ghost', onclick: loadDemo }, 'Try a demo session')),
        h('ul', { class: 'rv-formats-list' },
          h('li', null, h('b', null, 'iRacing .ibt'), h('span', { class: 'muted' }, ' · from Documents\\iRacing\\telemetry (Alt+L in the car to record)')),
          h('li', null, h('b', null, 'MoTeC .ld + .ldx'), h('span', { class: 'muted' }, ' · ACC, rFactor 2, Le Mans Ultimate. Drop both: the .ldx holds the lap markers')),
          h('li', null, h('b', null, 'CSV'), h('span', { class: 'muted' }, ' · MoTeC i2 export, Garage 61, SimHub and others. Columns are matched by name'))))));
  }

  function loadingBox() {
    const L = state.loading;
    return h('div', { class: 'rv-drop rv-loading' },
      h('div', { class: 'rv-drop-title' }, 'Reading telemetry…'),
      h('div', { class: 'rv-bar' }, h('div', { class: 'rv-bar-fill', id: 'rv-bar', style: 'width:' + Math.round(L.p * 100) + '%' })),
      h('p', { class: 'muted small', id: 'rv-bar-label' }, L.label));
  }
  function updateProgress() {
    const b = document.getElementById('rv-bar'), l = document.getElementById('rv-bar-label');
    if (b) b.style.width = Math.round(state.loading.p * 100) + '%';
    if (l) l.textContent = state.loading.label;
  }

  function errorList() {
    return h('div', { class: 'rv-msgs' },
      state.errors.map((e) => h('p', { class: 'rv-msg rv-err' }, h('b', null, e.file), ' · ' + e.message)));
  }

  // ---------------------------------------------------------------- viewer
  function seg(options, cur, onPick) {
    const el = h('div', { class: 'seg', role: 'group' });
    options.forEach(([v, label, title]) => {
      const b = h('button', { class: 'seg-b' + (v === cur ? ' on' : ''), title: title || null, onclick: () => {
        el.querySelectorAll('.seg-b').forEach((x) => x.classList.toggle('on', x === b));
        onPick(v);
      } }, label);
      el.append(b);
    });
    return el;
  }
  function check(label, key, title) {
    const input = h('input', { type: 'checkbox', checked: state.opts[key] });
    input.addEventListener('change', () => {
      state.opts[key] = input.checked;
      rebuild(true);
    });
    return h('label', { class: 'view-check', title: title || null }, input, label);
  }

  const HINTS = {
    orbit: 'Drag to orbit · right-drag to pan · wheel to zoom · hover a line to scrub',
    follow: 'Drag to turn the camera · wheel for distance · scrub on the traces, with ← → or Play',
  };

  function viewer() {
    const gl = h('canvas', { class: 'rv-gl', tabindex: 0, 'aria-label': '3D track view' });
    const overlay = h('canvas', { class: 'rv-overlay', 'aria-hidden': 'true' });
    const traces = h('canvas', { class: 'rv-traces' });
    const play = h('button', { class: 'btn small', onclick: () => setPlaying(!state.playing), title: 'Play the reference lap (Space)' }, state.playing ? 'Pause' : 'Play');
    const camSeg = seg(IST.Review.Rigs.MODES.map((m, i) => [m[0], m[1], m[2] + ' (' + (i + 1) + ')']), state.camMode || 'orbit', (m) => setCam(m));
    const hint = h('div', { class: 'rv-hint' }, HINTS.orbit);
    const stage = dropTarget(h('div', { class: 'rv-stage' }, gl, overlay,
      h('div', { class: 'rv-toolbar' },
        camSeg,
        h('div', { class: 'rv-toolbar-row' }, play, seg([[0.5, '½×'], [1, '1×'], [2, '2×'], [4, '4×']], state.rate, (r) => (state.rate = r)))),
      hint,
      h('div', { class: 'rv-legend' },
        h('span', null, h('i', { class: 'rv-key rv-key-thr' }), 'Throttle'),
        h('span', null, h('i', { class: 'rv-key rv-key-brk' }), 'Brake'),
        h('span', { title: 'Each fence is edged in its lap’s colour' }, h('i', { class: 'rv-key rv-key-cap' }), 'Lap colour'),
        h('span', null, h('i', { class: 'rv-key rv-key-gear' }), 'Gear change'))));
    const elev = h('select', { 'aria-label': 'Elevation scale' }, [[1, '×1'], [2, '×2'], [4, '×4'], [8, '×8']].map(([v, l]) => h('option', { value: v, selected: v === state.opts.exag }, l)));
    elev.addEventListener('input', () => {
      state.opts.exag = +elev.value;
      rebuild(true);
    });
    const inputs = h('select', { 'aria-label': 'Whose inputs to draw' });
    inputs.addEventListener('input', () => {
      state.opts.inputs = inputs.value;
      rebuild(true);
    });
    const opts = h('div', { class: 'view-preview-opts rv-opts' },
      h('label', { title: 'Throttle and brake fences, for every lap or one' }, 'Inputs ', inputs),
      check('Steering lean', 'lean', 'Lean the input fences toward the steering'),
      check('Cars', 'cars', 'A car for each lap where it was at the reference’s time, with the gap'),
      check('Lap tags', 'tags', 'Lap labels along each line'),
      check('Gear numbers', 'gears'),
      h('label', null, 'Elevation ', elev),
      h('button', { class: 'btn ghost small', onclick: () => { V.traces.zoom(); frameAll(); } }, 'Fit view'));

    const lapsPanel = h('div', { class: 'view-panel rv-laps' });
    const readout = h('div', { class: 'view-panel rv-readout' });
    V = { glEl: gl, overlay, tracesEl: traces, stage, play, camSeg, hint, inputs, lapsPanel, readout, dirty: true };
    return h('div', { class: 'rv-layout' },
      h('div', { class: 'rv-main' }, stage, opts, h('div', { class: 'rv-traces-wrap' }, traces),
        h('p', { class: 'rv-traces-hint' }, 'Drag across the traces to zoom both views to that stretch · shift-drag to pan · wheel to zoom · double-click for the whole lap')),
      h('div', { class: 'rv-side' },
        lapsPanel, readout,
        state.errors.length || state.warnings.length
          ? h('div', { class: 'view-panel rv-notes' }, h('h3', null, 'Notes'),
            state.errors.map((e) => h('p', { class: 'rv-msg rv-err' }, h('b', null, e.file), ' · ' + e.message)),
            state.warnings.map((w) => h('p', { class: 'rv-msg' }, w)))
          : null));
  }

  /** Options for the Inputs select: all laps, off, or one lap; keeps the choice if it still exists. */
  function inputOptions() {
    const sel = V.inputs, cmp = V.cmp;
    const opts = [['all', 'All laps'], ['none', 'Off']].concat(cmp.laps.map((L, k) => ['lap' + k, (k ? 'Lap ' : 'Ref · Lap ') + L.lap.lapNo]));
    if (!opts.some((o) => o[0] === state.opts.inputs)) state.opts.inputs = 'all';
    sel.innerHTML = '';
    opts.forEach(([v, l]) => sel.append(h('option', { value: v, selected: v === state.opts.inputs }, l)));
    const o = state.opts.inputs;
    return cmp.laps.map((_, k) => o === 'all' || o === 'lap' + k);
  }

  function lapList() {
    const P = V.lapsPanel;
    P.innerHTML = '';
    P.append(h('h3', null, 'Laps'), h('p', { class: 'hint' }, 'Tick up to ' + MAX_LAPS + ' to compare. Ref sets the lap the others are timed against.'));
    const best = bestFull();
    state.sessions.forEach((s) => {
      const entries = state.laps.filter((x) => x.s === s);
      const meta = [s.meta.track, s.meta.car, s.meta.driver].filter(Boolean).join(' · ');
      P.append(h('div', { class: 'rv-file' },
        h('div', { class: 'rv-file-name', title: s.file }, s.file),
        h('div', { class: 'rv-file-meta muted' }, (meta ? meta + ' · ' : '') + s.format)));
      const list = h('ul', { class: 'rv-lap-list' });
      entries.forEach((x) => {
        const k = selIndex(x.id);
        const on = k >= 0;
        const isRef = x.id === state.refId;
        const tag = x.lap.pit ? 'pit' : x.lap.kind !== 'full' ? x.lap.kind : null;
        const d = x.lap.kind === 'full' && isFinite(best) ? x.lap.time - best : NaN;
        const box = h('input', { type: 'checkbox', checked: on, disabled: isRef, 'aria-label': 'Compare lap ' + x.lap.lapNo });
        box.addEventListener('change', () => toggle(x.id));
        list.append(h('li', { class: 'rv-lap' + (on ? ' on' : '') + (isRef ? ' ref' : '') },
          h('label', { class: 'rv-lap-main' },
            box,
            h('i', { class: 'rv-swatch', style: on ? 'background:' + COLORS[k] : '' }),
            h('span', { class: 'rv-lap-no' }, 'Lap ' + x.lap.lapNo),
            tag ? h('span', { class: 'rv-lap-tag' }, tag) : null,
            h('span', { class: 'rv-lap-time' }, Cmp.fmtLap(x.lap.time)),
            h('span', { class: 'rv-lap-d' + (d === 0 ? ' best' : '') }, isFinite(d) ? (d === 0 ? 'best' : '+' + d.toFixed(3)) : '')),
          h('button', { class: 'rv-ref' + (isRef ? ' on' : ''), title: 'Use as reference', onclick: () => setRef(x.id) }, 'Ref')));
      });
      P.append(list);
    });
  }
  function selIndex(id) {
    // colour slot: the reference is 0, the rest in picked order
    if (id === state.refId) return 0;
    const others = state.sel.filter((x) => x !== state.refId);
    const i = others.indexOf(id);
    return i < 0 ? -1 : i + 1;
  }

  function readout() {
    const P = V.readout, cmp = V.cmp;
    P.innerHTML = '';
    const i = state.cursor;
    P.append(h('h3', null, 'At cursor' + (i >= 0 ? ' · ' + Math.round(i * cmp.step) + ' m' : '')));
    if (i < 0) return P.append(h('p', { class: 'hint' }, 'Hover a line in the 3D view or the traces.'));
    const row = (L) => h('tr', null,
      h('td', null, h('i', { class: 'rv-swatch', style: 'background:' + L.color }), 'Lap ' + L.lap.lapNo),
      h('td', null, Math.round(L.speed[i] * 3.6)),
      h('td', null, L.throttle ? Math.round(L.throttle[i] * 100) : '–'),
      h('td', null, L.brake ? Math.round(L.brake[i] * 100) : '–'),
      h('td', null, L.gear ? Math.round(L.gear[i]) : '–'),
      h('td', { class: 'delta ' + (L === cmp.laps[0] ? 'flat' : L.delta[i] > 0.005 ? 'bad' : L.delta[i] < -0.005 ? 'good' : 'flat') }, L === cmp.laps[0] ? 'ref' : U.signedSec(L.delta[i]).replace(' s', '')));
    P.append(h('table', { class: 'grid rv-table' },
      h('thead', null, h('tr', null, ['Lap', 'km/h', 'Thr', 'Brk', 'Gear', 'Δ s'].map((x) => h('th', null, x)))),
      h('tbody', null, cmp.laps.map(row))));
  }

  // ---------------------------------------------------------------- 3D life
  function start() {
    V.R = IST.Review.GL.create(V.glEl);
    V.cam = IST.Review.Camera.create();
    V.ov = IST.Review.Overlay.create();
    V.traces = IST.Review.Traces.create(V.tracesEl, { onCursor: setCursor, onRange: frameRange, onReset: frameAll });
    if (!V.R) {
      V.stage.append(h('div', { class: 'rv-nogl' }, 'WebGL isn’t available in this browser, so the 3D view is off. The traces still work.'));
    } else {
      V.detach = V.cam.attach(V.glEl, dirty);
      V.glEl.addEventListener('pointermove', hover);
      V.carMesh = V.R.dynamic('tris');
    }
    V.onKey = onKey;
    window.addEventListener('keydown', onKey);
    if (window.ResizeObserver) {
      V.ro = new ResizeObserver(() => {
        if (V && V.R) V.R.resize();
        if (V) V.traces.draw();
        dirty();
      });
      V.ro.observe(V.stage);
    }
    rebuild(false, true);
    if (state.camMode && state.camMode !== 'orbit') setCam(state.camMode);
    let last = performance.now();
    const loop = (ts) => {
      if (!V) return;
      const dt = Math.min(0.1, Math.max(0, (ts - last) / 1000));
      last = ts;
      if (state.playing) advance(dt);
      if (V.dirty || V.cam.mode !== 'orbit' || state.playing || V.cam.animating() || V.fading > 0) draw(dt);
      V.raf = requestAnimationFrame(loop);
    };
    V.raf = requestAnimationFrame(loop);
  }

  function rebuild(keepCam, first) {
    if (!V) return;
    const prevN = V.cmp && V.cmp.n;
    V.cmp = comparison();
    if (!V.cmp) return;
    if (V.cmp.n !== prevN) V.range = null;
    if (state.cursor >= V.cmp.n) state.cursor = state.cursorF = -1;
    lapList();
    readout();
    V.fences = inputOptions();
    V.traces.set(V.cmp);
    V.traces.setCursor(state.cursor);
    if (V.R) {
      if (V.scene) V.scene.dispose();
      // close-up cameras sit a few metres off the road: low fences there, tall ones for the overview
      V.closeUp = V.cam.mode !== 'orbit';
      V.scene = IST.Review.Scene.build(V.R, V.cmp, { exag: state.opts.exag, fences: V.fences, lean: state.opts.lean, fenceH: V.closeUp ? 3.5 : 0, closeUp: V.closeUp });
      if (first || !keepCam) {
        if (first || !V.framed) V.cam.frame(V.scene.size, V.glEl.clientWidth, V.glEl.clientHeight);
        V.framed = true;
      }
    }
    dirty();
  }

  // keep drawing a moment after a change so labels finish fading
  const dirty = () => V && ((V.dirty = true), (V.fading = 0.6));

  /** Fly the 3D view to the stretch of track between indices a and b (a drag on the traces). */
  function frameRange(a, b) {
    if (!V || !V.scene) return;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    V.scene.base.forEach((P) => {
      for (let i = a; i <= b; i++) {
        x0 = Math.min(x0, P[i * 3]);
        x1 = Math.max(x1, P[i * 3]);
        y0 = Math.min(y0, P[i * 3 + 1]);
        y1 = Math.max(y1, P[i * 3 + 1] + V.scene.fenceH);
        z0 = Math.min(z0, P[i * 3 + 2]);
        z1 = Math.max(z1, P[i * 3 + 2]);
      }
    });
    const extent = Math.max(40, x1 - x0, z1 - z0, (y1 - y0) * 1.5);
    setCam('orbit');
    V.cam.flyTo([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], V.cam.fitDist(extent, V.glEl.clientWidth, V.glEl.clientHeight));
    V.range = [a, b];
    dirty();
  }

  /** Back to the whole track. */
  function frameAll() {
    if (!V || !V.scene) return;
    setCam('orbit');
    V.cam.flyTo([0, 0, 0], V.cam.fitDist(V.scene.size, V.glEl.clientWidth, V.glEl.clientHeight));
    V.range = null;
    dirty();
  }

  function setCursor(i) {
    if (!V || !V.cmp) return;
    state.cursor = i;
    state.cursorF = i;
    if (state.playing) state.playT = V.cmp.laps[0].t[Math.max(0, i)];
    V.traces.setCursor(i);
    readout();
    dirty();
  }

  function setCam(mode) {
    if (!V) return;
    if (mode !== 'orbit' && state.cursor < 0) setCursor(0);
    state.camMode = mode;
    V.cam.setMode(mode);
    if (V.scene && V.closeUp !== (mode !== 'orbit')) rebuild(true);
    V.camSeg.querySelectorAll('.seg-b').forEach((x, k) => x.classList.toggle('on', IST.Review.Rigs.MODES[k][0] === mode));
    V.hint.textContent = mode === 'orbit' ? HINTS.orbit : HINTS.follow;
    dirty();
  }

  function setPlaying(on) {
    state.playing = on;
    if (on && V && V.cmp) {
      if (state.cursor < 0 || state.cursor >= V.cmp.n - 1) state.cursor = state.cursorF = 0;
      state.playT = timeAt(V.cmp.laps[0].t, state.cursorF);
    }
    if (V) V.play.textContent = on ? 'Pause' : 'Play';
  }

  /** Fractional grid index where times t reach T (t rises along the lap). */
  function indexAt(t, T) {
    const n = t.length;
    if (T <= t[0]) return 0;
    if (T >= t[n - 1]) return n - 1;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (t[m] <= T) lo = m;
      else hi = m;
    }
    return lo + (T - t[lo]) / Math.max(1e-6, t[hi] - t[lo]);
  }
  function timeAt(t, f) {
    const i = Math.max(0, Math.min(t.length - 2, Math.floor(f)));
    return t[i] + (t[i + 1] - t[i]) * (f - i);
  }

  function advance(dt) {
    const ref = V.cmp.laps[0];
    state.playT += dt * state.rate;
    if (state.playT >= ref.lap.time) state.playT = 0;
    // the 3D view follows the exact time; the traces and readout take whole metres
    state.cursorF = indexAt(ref.t, state.playT);
    const i = Math.round(state.cursorF);
    if (i !== state.cursor) {
      state.cursor = i;
      V.traces.setCursor(i);
      if ((V.readoutT = (V.readoutT || 0) + dt) > 0.1) {
        V.readoutT = 0;
        readout();
      }
    }
  }

  /** Each lap's car where it was when the reference reached the cursor. */
  function cars() {
    const cmp = V.cmp, f = Math.max(0, state.cursorF), T = timeAt(cmp.laps[0].t, f);
    return cmp.laps.map((L, k) => {
      const j = k ? indexAt(L.t, T) : f;
      return { k, j, pose: IST.Review.Rigs.pose(V.scene, k, j), gapM: (f - j) * cmp.step };
    });
  }

  function draw(dt) {
    dt = dt || 0.016;
    V.dirty = false;
    V.fading = Math.max(0, (V.fading || 0) - dt);
    const W = V.glEl.clientWidth, H = V.glEl.clientHeight;
    if (!V.R || !V.scene || !W || !H) return;
    V.R.resize();
    const C = state.cursorF >= 0 ? cars() : [];
    if (V.cam.mode !== 'orbit') {
      const f = Math.max(0, state.cursorF);
      const rig = IST.Review.Rigs.rig(V.cam.mode, { pose: IST.Review.Rigs.pose(V.scene, 0, f), f, cmp: V.cmp, scene: V.scene, user: V.cam.user });
      rig.cut = rig.key !== V.rigKey;
      V.rigKey = rig.key;
      V.cam.follow(rig, dt);
    } else V.rigKey = null;
    const m = V.cam.matrices(W, H);
    V.vp = m.vp;
    const items = V.scene.items.slice();
    if (state.opts.cars && C.length) {
      const Vt = IST.Review.GL.Verts();
      C.forEach((c) => IST.Review.Scene.car(Vt, { p: [c.pose.p[0], c.pose.p[1] - 0.1, c.pose.p[2]], fwd: c.pose.fwd, left: c.pose.left }, IST.Review.GL.rgb(V.cmp.laps[c.k].color)));
      V.carMesh.set(Vt.data());
      items.push({ mesh: V.carMesh, lit: true });
    }
    V.R.draw(m.vp, m.eye, items, { near: m.fog.near, far: m.fog.far, color: IST.Review.GL.rgb(Th.deep) });

    const c = V.overlay, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    V.ov.draw(g, W, H, {
      vp: m.vp, scene: V.scene, cmp: V.cmp, cursorF: state.cursorF, cars: state.opts.cars ? C : [], range: V.range,
      gears: state.opts.gears, tags: state.opts.tags, fences: V.fences, chipsBeside: V.cam.mode === 'top', dt,
    });
  }

  /** Hovering near a line moves the cursor there (orbit only: a following camera would chase the mouse). */
  function hover(e) {
    if (!V || !V.vp || V.cam.mode !== 'orbit' || V.cam.dragging() || state.playing) return;
    const r = V.glEl.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const W = r.width, H = r.height;
    let best = -1, bd = 26 * 26;
    const n = V.cmp.n, stepI = Math.max(1, Math.round(2 / V.cmp.step));
    V.scene.base.forEach((P) => {
      for (let i = 0; i < n; i += stepI) {
        const p = M.project(V.vp, P[i * 3], P[i * 3 + 1], P[i * 3 + 2], W, H);
        if (p.w <= 0) continue;
        const d = (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my);
        if (d < bd) (bd = d), (best = i);
      }
    });
    if (best >= 0 && best !== state.cursor) setCursor(best);
  }

  function onKey(e) {
    if (root().classList.contains('hidden') || !V) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (!document.getElementById('modal').classList.contains('hidden')) return;
    const modes = IST.Review.Rigs.MODES.map((m) => m[0]);
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (e.code === 'Space') {
      e.preventDefault();
      setPlaying(!state.playing);
    } else if (digit && modes[digit[1] - 1]) setCam(modes[digit[1] - 1]);
    else if (e.code === 'KeyC') setCam(modes[(modes.indexOf(V.cam.mode) + 1) % modes.length]);
    else if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && V.cmp) {
      e.preventDefault();
      const d = Math.round((e.shiftKey ? 100 : 10) / V.cmp.step) * (e.code === 'ArrowLeft' ? -1 : 1);
      setCursor(Math.max(0, Math.min(V.cmp.n - 1, Math.max(0, state.cursor) + d)));
    } else if (e.code === 'Escape') close();
  }

  let flashT = 0;
  function flash(msg) {
    if (!V) return;
    let el = V.stage.querySelector('.rv-flash');
    if (!el) V.stage.append((el = h('div', { class: 'rv-flash' })));
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(flashT);
    flashT = setTimeout(() => el.classList.add('hidden'), 2400);
  }

  IST.Review.open = open;
  IST.Review.close = close;
  IST.Review.state = state; // for dev tools
})();
