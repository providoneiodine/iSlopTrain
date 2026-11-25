/*
 * Review: the 3D lap viewer page (#screen-review).
 *
 *   IST.Review.open({ pick, demo, files })   show the page; optionally open the
 *                                            file picker, load the demo, or load files
 *   IST.Review.close()
 *
 * Layout: header, then the 3D stage (WebGL canvas + a 2D overlay, overlay.js,
 * with the Layers drawer folded into its right edge), the lanes box, the
 * trace strip, and a side column
 * with the lap list and the values at the cursor. One cursor (an index on
 * the reference lap's distance grid) is shared by the stage, the traces and
 * the readout. The 3D view also keeps it fractional (cursorF) so playback and
 * following cameras move smoothly between metres. Cars sit where each lap
 * was at the reference's time at the cursor, so their spacing is the gap.
 *
 * Loaded sessions stay in memory while the app is open, so leaving and
 * coming back keeps them. Telemetry is never saved or uploaded. With the Map
 * option on, each session's track is looked up (mapdata.js: where the track
 * is goes to OpenStreetMap and Esri) for the true centreline and satellite
 * ground; until then, or if nothing is found, the track is estimated from
 * the laps.
 *
 * The lanes box picks which trace lanes show; the Layers drawer (L) picks
 * the 3D line colour, the fence and the event markers. Both remember their
 * choices in this browser (localStorage, per viewer); the drawer always
 * starts closed.
 */
(function () {
  'use strict';
  const U = IST.util, h = U.h, Th = IST.Theme, M = IST.Review.M3;
  const Cmp = IST.Review.Compare, Tr = IST.Review.Traces, Ly = IST.Review.Layers;
  const COLORS = [Th.butter, Th.sky, Th.lilac, Th.peach, Th.text];
  const MAX_LAPS = COLORS.length;
  const ACCEPT = '.ibt,.ld,.ldx,.csv,.tsv,.txt';
  const COARSE_HIDE = 350, COARSE_SHOW = 450; // m from the camera to what it looks at

  const state = {
    sessions: [], laps: [], refId: null, sel: [], errors: [], warnings: [],
    opts: { inputs: 'all', lean: false, cars: true, exag: 1, map: true, paint: 'lap', fence: 'inputs', absTint: true, attScale: 1, motion: 3,
      markers: new Set(Ly.MARKERS.filter((m) => m.def).map((m) => m.key)) },
    lanes: { on: new Set(Tr.DEFAULT.on), picks: Tr.DEFAULT.picks.slice(), tyreMode: 'temp', tyreBand: 'avg', abs: true, labels: {}, folded: true },
    drawer: false,
    condOpen: false,
    cursor: -1, cursorF: -1, camMode: 'orbit', playing: false, playT: 0, rate: 1, loading: null,
    partialsOpen: new Set(), // sessions whose partials footer is unfolded
  };
  // ------------------------------------------------------- remembered choices
  const LANES_KEY = 'ist.review.lanes', LAYERS_KEY = 'ist.review.layers';
  function restore() {
    try {
      const l = JSON.parse(localStorage.getItem(LANES_KEY) || 'null');
      if (l) {
        if (Array.isArray(l.on)) state.lanes.on = new Set(l.on);
        if (Array.isArray(l.picks)) state.lanes.picks = l.picks.filter((p) => Tr.PICKS[p]);
        ['tyreMode', 'tyreBand', 'abs', 'folded'].forEach((k) => l[k] != null && (state.lanes[k] = l[k]));
      }
      const o = JSON.parse(localStorage.getItem(LAYERS_KEY) || 'null');
      if (o) {
        ['lean', 'cars', 'exag', 'map', 'paint', 'fence', 'absTint', 'attScale', 'motion'].forEach((k) => o[k] != null && (state.opts[k] = o[k]));
        if (Array.isArray(o.markers)) state.opts.markers = new Set(o.markers);
      }
    } catch (e) {
      /* private window or blocked storage: defaults */
    }
  }
  function saveLanes() {
    try {
      const l = state.lanes;
      localStorage.setItem(LANES_KEY, JSON.stringify({ on: [...l.on], picks: l.picks, tyreMode: l.tyreMode, tyreBand: l.tyreBand, abs: l.abs, folded: l.folded }));
    } catch (e) {
      /* not kept */
    }
  }
  function saveLayers() {
    try {
      const o = state.opts;
      localStorage.setItem(LAYERS_KEY, JSON.stringify({ lean: o.lean, cars: o.cars, exag: o.exag, map: o.map, paint: o.paint, fence: o.fence, absTint: o.absTint, attScale: o.attScale, motion: o.motion, markers: [...o.markers] }));
    } catch (e) {
      /* not kept */
    }
  }
  restore();
  const markerOn = (k) => state.opts.markers.has(k);
  /** Event kinds the 3D view marks, from the marker toggles. */
  const markerKinds = () => new Set([].concat(...Ly.MARKERS.filter((m) => m.kinds && markerOn(m.key)).map((m) => m.kinds)));
  const hasCh = (cmp, k) => cmp.laps.some((L) => L[k]);
  /** Attitude arrows asked for and drawable (needs body velocities). */
  const attitudeOn = () => markerOn('attitude') && !!(V && V.cmp) && hasCh(V.cmp, 'vx') && hasCh(V.cmp, 'vy');

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

  // bumped by Clear and Done: a load still reading when either happens is dropped when it
  // finishes, so it can't reappear (or ask about another track) on a page that moved on
  let loadGen = 0, loadSeq = 0;
  async function loadFiles(files) {
    state.undo = null;
    const gen = loadGen, seq = ++loadSeq;
    state.loading = { p: 0, label: 'Starting' };
    render();
    let res;
    try {
      res = await IST.Telemetry.load(files, (p, label) => {
        if (gen !== loadGen || seq !== loadSeq) return;
        state.loading = { p, label };
        updateProgress();
      });
    } catch (e) {
      res = { sessions: [], errors: [{ file: 'Telemetry', message: (e && e.message) || String(e) }] };
    }
    if (gen !== loadGen) return;
    // files added while these were still reading: the bar stays up until the last load ends
    if (seq === loadSeq) state.loading = null;
    res.errors.forEach((e) => state.errors.push(e));
    // a file with no usable lap is reported, not kept: an empty session would otherwise
    // set the track for the analysis and turn every later file into a "different track"
    const usable = res.sessions.filter((s) => {
      if (s.laps.length) return true;
      state.errors.push({ file: s.file, message: 'No laps to show: the recording is too short, or has no lap or distance channel.' });
      return false;
    });
    // the same file again (Try a demo twice, or re-opening one) would only double its laps
    const seen = new Set(state.sessions.map(sessionKey));
    const dups = [];
    const fresh = usable.filter((s) => {
      const k = sessionKey(s);
      if (seen.has(k)) return dups.push(s.file), false;
      seen.add(k);
      return true;
    });
    // one track per analysis: laps from another circuit can't share a distance grid or a map
    const base = state.sessions[0] || fresh[0];
    const other = fresh.filter((s) => !sameTrack(s, base));
    fresh.filter((s) => sameTrack(s, base)).forEach(addSession);
    render();
    if (dups.length) flash('Already loaded: ' + dups.join(', '));
    if (other.length) askNewSession(other);
  }
  /** What makes two loads the same recording: the file name and every lap time. */
  const sessionKey = (s) => s.file + '|' + s.laps.map((l) => Math.round(l.time * 1000)).join(',');

  const trackName = (s) => String(s.meta.track || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  /** Same circuit and layout: the same name, or (with no name to go on) the same lap length within 3 %. */
  function sameTrack(a, b) {
    if (a === b) return true;
    const na = trackName(a), nb = trackName(b);
    const la = a.trackLen || 0, lb = b.trackLen || 0;
    const lenOk = !(la && lb) || Math.abs(la - lb) / Math.max(la, lb) < 0.03;
    return na && nb ? na === nb && lenOk : lenOk;
  }
  const trackLabel = (s) => (s.meta.track || 'an unnamed track') + (s.trackLen ? ' (' + (s.trackLen / 1000).toFixed(2) + ' km)' : '');

  /** Files from another track: offer a fresh analysis with them, or leave them out. */
  function askNewSession(other) {
    const group = other.filter((s) => sameTrack(s, other[0]));
    const cur = state.sessions[0];
    const App = IST.App;
    const names = group.map((s) => s.file).join(', ');
    const fresh = () => {
      App.closeModal();
      clearAll();
      group.forEach(addSession);
      render();
    };
    App.openModal(h('div', null,
      h('h2', null, 'Different track'),
      h('p', null, h('b', null, names), ' ' + (group.length > 1 ? 'are' : 'is') + ' from ' + trackLabel(group[0]) + ', but the laps loaded now are from ' + trackLabel(cur) + '.'),
      h('p', { class: 'muted' }, 'Laps can only be compared on the same track and layout. Start a new analysis with the new file' + (group.length > 1 ? 's' : '') + ', or keep the current laps and leave ' + (group.length > 1 ? 'them' : 'it') + ' out.'),
      other.length > group.length ? h('p', { class: 'muted small' }, (other.length - group.length) + ' more file(s) from yet another track were left out.') : null,
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn primary', onclick: fresh }, 'Start new analysis'),
        h('button', { class: 'btn', onclick: () => App.closeModal() }, 'Keep current laps'))));
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
    if (state.opts.map) findMap(s);
    // pick the fastest full lap as the reference, and the next fastest to compare
    // (and swap a partial reference for a complete lap once one arrives)
    const cur = state.refId && byId(state.refId);
    if (!cur || !complete(cur.lap)) {
      const full = state.laps.filter((x) => complete(x.lap)).sort((a, b) => a.lap.time - b.lap.time);
      if (cur && !full.length) return;
      const any = full.length ? full : state.laps.slice().sort((a, b) => b.lap.len - a.lap.len);
      if (any[0]) {
        state.refId = any[0].id;
        state.sel = [any[0].id].concat(full[1] ? [full[1].id] : []);
      }
    }
  }

  /** Look the session's track up on the map (once), then redraw if it's on screen. */
  function findMap(s) {
    if (s.mapState) return;
    const lap = s.laps.filter((l) => l.kind === 'full').sort((a, b) => a.time - b.time)[0] || s.laps.slice().sort((a, b) => b.len - a.len)[0];
    const gps = s.posSource === 'gps' && originRef;
    if (!lap || (!gps && s.posSource !== 'world')) return (s.mapState = 'none');
    s.mapState = 'loading';
    // GPS laps already know where they are: show the imagery now, the centre when it arrives
    if (gps) s.map = { geo: IST.Review.Track.geo(originRef.lat, originRef.lon), lines: [], halfWidth: 0, how: 'gps' };
    IST.Review.MapData.lookup({ origin: gps ? originRef : null, track: s.meta.track, x: lap.x, y: lap.y }).then((m) => {
      s.map = m;
      s.mapState = m ? 'ok' : 'none';
    }, (e) => {
      s.mapState = 'error';
      s.mapError = e && e.message;
    }).then(() => {
      if (V && V.cmp && V.cmp.laps[0].entry.s === s) rebuild(true);
      else mapStatus();
    });
  }
  const refSession = () => (byId(state.refId) || {}).s;

  function loadDemo() {
    const text = IST.Review.Demo.csv(7);
    const file = new File([text], 'demo-session.csv', { type: 'text/csv' });
    loadFiles([file]);
  }

  // ------------------------------------------------------------- selection
  const byId = (id) => state.laps.find((x) => x.id === id);
  const bestFull = () => {
    const f = state.laps.filter((x) => complete(x.lap));
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
    const m = state.opts.map && ref.s.map;
    const cmp = Cmp.build(ref.lap, others.map((o) => o.lap), COLORS, m && m.lines.length ? { lines: m.lines, halfWidth: m.halfWidth } : null);
    cmp.laps.forEach((L, k) => (L.entry = k === 0 ? ref : others[k - 1]));
    return cmp;
  }

  // ------------------------------------------------------------------ view
  function open(o) {
    o = o || {};
    IST.App.show('screen-review');
    render();
    if (o.pick) picker();
    else if (o.demo) loadDemo();
    else if (o.files) loadFiles(o.files);
  }

  function close() {
    loadGen++;
    state.loading = null;
    teardown();
    IST.App.exitToMenu();
    syncCard();
  }

  /** The Review tab's card: with laps still in memory, its first action goes back to them. */
  function syncCard() {
    const card = document.getElementById('review-card');
    if (!card) return;
    const openBtn = card.querySelector('#btn-review-open');
    let resume = card.querySelector('#btn-review-resume');
    const n = state.laps.length;
    if (n && !resume) {
      resume = h('button', { class: 'btn primary', id: 'btn-review-resume', onclick: () => open() });
      openBtn.before(resume);
    }
    if (resume) {
      resume.classList.toggle('hidden', !n);
      resume.textContent = 'Resume: ' + n + (n === 1 ? ' lap' : ' laps') + ' loaded';
    }
    openBtn.classList.toggle('primary', !n);
  }

  function teardown() {
    if (!V) return;
    cancelAnimationFrame(V.raf);
    V.detach && V.detach();
    V.ro && V.ro.disconnect();
    V.traces && V.traces.destroy();
    V.scene && V.scene.dispose();
    V.R && V.R.destroy();
    window.removeEventListener('keydown', V.onKey, true);
    if (V.popAway) document.removeEventListener('pointerdown', V.popAway, true);
    V = null;
  }

  function header() {
    const has = state.sessions.length > 0;
    return h('div', { class: 'res-head' },
      h('div', null, h('span', { class: 'tag rv-tag' }, 'Telemetry'), h('h1', null, 'Lap Viewer')),
      h('div', { class: 'view-head-actions' },
        has ? h('button', { class: 'btn ghost', onclick: clearWithUndo, title: 'Forget every loaded file (you can undo it)' }, 'Clear') : null,
        h('button', { class: 'btn', onclick: openGarage61, title: 'Import laps from your Garage 61 account' }, 'Garage 61'),
        h('button', { class: 'btn', onclick: picker }, has ? 'Add files' : 'Open files'),
        h('button', { class: 'btn primary', onclick: close }, 'Done')));
  }

  /** The Garage 61 import panel; laps it brings back load like dropped files. */
  function openGarage61() {
    const s = state.sessions[0];
    const ctx = s ? { track: s.meta.track || '', car: s.meta.car || '' } : {};
    const p = IST.Review.Garage61.panel(ctx, (files) => {
      IST.App.closeModal();
      if (root().classList.contains('hidden')) return; // left the page meanwhile
      loadFiles(files);
    });
    IST.App.openModal(p.el, p.dispose);
  }

  function clearAll() {
    loadGen++;
    Object.assign(state, { loading: null, sessions: [], laps: [], refId: null, sel: [], errors: [], warnings: [], cursor: -1, cursorF: -1, playing: false, partialsOpen: new Set(), undo: null });
    originRef = null;
    render();
  }

  /** The header's Clear: forget everything, but keep it until the next load so Undo can bring it back. */
  function clearWithUndo() {
    const keep = { sessions: state.sessions, laps: state.laps, refId: state.refId, sel: state.sel, errors: state.errors, warnings: state.warnings, partialsOpen: state.partialsOpen, originRef };
    clearAll();
    state.undo = keep;
    render();
  }
  function undoClear() {
    const u = state.undo;
    if (!u) return;
    loadGen++;
    originRef = u.originRef;
    Object.assign(state, { sessions: u.sessions, laps: u.laps, refId: u.refId, sel: u.sel, errors: u.errors, warnings: u.warnings, partialsOpen: u.partialsOpen, undo: null, loading: null });
    render();
  }

  function render() {
    teardown();
    const r = root();
    r.innerHTML = '';
    // the viewer fills the window (stage over traces, side column beside); the other states scroll
    r.classList.toggle('rv-fit', !state.loading && state.laps.length > 0);
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
    const u = state.undo, files = u ? u.sessions.length : 0;
    return h('div', null,
      u ? h('div', { class: 'rv-undo', role: 'status' },
        h('span', null, 'Cleared ' + files + (files === 1 ? ' file' : ' files') + ' (' + u.laps.length + (u.laps.length === 1 ? ' lap' : ' laps') + ').'),
        h('button', { class: 'btn small', onclick: undoClear }, 'Undo')) : null,
      state.errors.length ? errorList() : null,
      dropTarget(h('div', { class: 'rv-drop' },
        h('div', { class: 'rv-drop-title' }, 'Drop telemetry files here'),
        h('p', { class: 'muted' }, 'Read in this browser. Telemetry is never uploaded or saved.'),
        h('p', { class: 'muted small' }, 'With Map on, the track’s location is sent to OpenStreetMap and Esri for its outline and satellite imagery.'),
        h('div', { class: 'card-actions rv-drop-actions' },
          h('button', { class: 'btn primary', onclick: picker }, 'Open files'),
          h('button', { class: 'btn', onclick: openGarage61 }, 'Import from Garage 61'),
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
  /** A view checkbox; after(): what the change needs (default: a full rebuild). */
  function check(label, key, title, after) {
    const input = h('input', { type: 'checkbox', checked: state.opts[key] });
    input.addEventListener('change', () => {
      state.opts[key] = input.checked;
      saveLayers();
      (after || (() => rebuild(true)))();
    });
    return h('label', { class: 'view-check', title: title || null }, input, label);
  }

  function mapCheck() {
    const input = h('input', { type: 'checkbox', checked: state.opts.map });
    input.addEventListener('change', () => {
      state.opts.map = input.checked;
      saveLayers();
      if (input.checked) state.sessions.forEach(findMap);
      rebuild(true);
    });
    return h('label', { class: 'view-check', title: 'Satellite ground and the true track centre, looked up by the track’s location (OpenStreetMap, Esri)' }, input, 'Map');
  }

  /** The line under the 3D view saying where the track and ground came from. */
  function mapStatus() {
    const el = V && V.stage.querySelector('.rv-map-status');
    if (!el || !V.cmp) return;
    const s = refSession(), src = V.cmp.centre.source;
    let text = '';
    if (!state.opts.map) text = 'Map off · track edges estimated from the laps';
    else if (!s || (s.mapState === 'loading' && !s.map)) text = 'Looking the track up…';
    else if (s.mapState === 'loading') text = 'Looking up the track centre…' + (V.noImagery ? ' · imagery unavailable' : '') + ' · ' + IST.Review.MapData.ATTRIB;
    else if (s.mapState === 'error' && s.map) text = 'Track centre lookup failed' + (s.mapError ? ' (' + s.mapError + ')' : '') + ' · centre estimated from the laps · ' + IST.Review.MapData.ATTRIB;
    else if (s.mapState === 'error') text = 'Map lookup failed' + (s.mapError ? ' (' + s.mapError + ')' : '') + ' · track estimated from the laps';
    else if (s.mapState !== 'ok') text = s.posSource === 'reckoned' || s.posSource === 'none' ? 'No position in this file to place it on a map · track estimated from the laps' : 'Track not found on the map · edges estimated from the laps';
    else text = (src === 'map' ? 'Centre: OpenStreetMap' : 'No track outline on the map · centre estimated from the laps') + (V.noImagery ? ' · imagery unavailable' : '') + ' · ' + IST.Review.MapData.ATTRIB;
    el.textContent = text;
  }

  const HINTS = {
    orbit: 'Drag to orbit · right-drag to pan · wheel to zoom · hover a line to scrub',
    follow: 'Drag to turn the camera · wheel for distance · scrub on the traces, with ← → or Play',
  };

  function viewer() {
    const layersBtn = h('button', { class: 'btn small rv-layers-btn' + (state.drawer ? ' on' : ''), 'aria-expanded': String(state.drawer), title: 'Line colour, fence and markers in the 3D view (L)', onclick: () => setDrawer(!state.drawer) }, 'Layers');
    const drawer = h('div', { class: 'rv-drawer' + (state.drawer ? '' : ' hidden'), role: 'dialog', 'aria-label': '3D layers' });
    const legend = h('div', { class: 'rv-legend' });
    const gl = h('canvas', { class: 'rv-gl', tabindex: 0, 'aria-label': '3D track view' });
    const overlay = h('canvas', { class: 'rv-overlay', 'aria-hidden': 'true' });
    const traces = h('canvas', { class: 'rv-traces' });
    const play = h('button', { class: 'btn small', onclick: () => setPlaying(!state.playing), title: 'Play the reference lap (Space)' }, state.playing ? 'Pause' : 'Play');
    const camSeg = seg(IST.Review.Rigs.MODES.map((m, i) => [m[0], m[1], m[2] + ' (' + (i + 1) + ')']), state.camMode || 'orbit', (m) => setCam(m));
    const hint = h('div', { class: 'rv-hint' }, HINTS.orbit);
    const stage = dropTarget(h('div', { class: 'rv-stage' }, gl, overlay,
      h('div', { class: 'rv-toolbar' },
        camSeg,
        h('div', { class: 'rv-toolbar-row' }, play, seg([[0.5, '½×'], [1, '1×'], [2, '2×'], [4, '4×']], state.rate, (r) => (state.rate = r))),
        h('div', { class: 'rv-toolbar-end' }, layersBtn)),
      hint,
      h('div', { class: 'rv-map-status', title: '' }),
      legend,
      drawer));
    gl.addEventListener('pointerdown', () => state.drawer && setDrawer(false));
    const inputs = h('select', { 'aria-label': 'Whose fence, paint and markers to draw' });
    inputs.addEventListener('input', () => {
      state.opts.inputs = inputs.value;
      V.fences = whose();
      restyle();
    });

    const lapsPanel = h('div', { class: 'view-panel rv-laps' });
    const readout = h('div', { class: 'view-panel rv-readout' });
    const condPanel = h('div', { class: 'view-panel rv-cond hidden' });
    const lanesBox = h('div', { class: 'rv-lanebar', role: 'toolbar', 'aria-label': 'Trace lanes' });
    const tracesWrap = h('div', { class: 'rv-traces-wrap' }, traces);
    V = { glEl: gl, overlay, tracesEl: traces, tracesWrap, stage, play, camSeg, hint, inputs, lapsPanel, readout, condPanel, lanesBox, drawer, layersBtn, legend, dirty: true };
    return h('div', { class: 'rv-layout' },
      h('div', { class: 'rv-main' }, stage,
        h('div', { class: 'rv-traces-box' }, lanesBox, tracesWrap),
        keyLegend()),
      h('div', { class: 'rv-side' },
        condPanel, lapsPanel, readout,
        state.errors.length || state.warnings.length
          ? h('div', { class: 'view-panel rv-notes' }, h('h2', null, 'Notes'),
            state.errors.map((e) => h('p', { class: 'rv-msg rv-err' }, h('b', null, e.file), ' · ' + e.message)),
            state.warnings.map((w) => h('p', { class: 'rv-msg' }, w)))
          : null));
  }

  /** One line under the traces: the keyboard shortcuts, then how to zoom the traces. */
  function keyLegend() {
    const n = IST.Review.Rigs.MODES.length;
    const key = (k, what) => h('span', { class: 'rv-key-item' }, k.map((x) => h('kbd', null, x)), ' ' + what);
    const zoom = 'Drag across the traces to zoom both views to that stretch · shift-drag to pan · wheel to zoom · double-click for the whole lap';
    return h('div', { class: 'rv-traces-hint rv-keys', 'aria-label': 'Keyboard shortcuts' },
      key(['Space'], 'play'), key(['1–' + n], 'camera'), key(['C'], 'next camera'), key(['L'], 'layers'),
      key(['←', '→'], '10 m, with Shift 100 m'), key(['Esc'], 'close'),
      h('span', { class: 'rv-keys-zoom', title: zoom }, 'Traces: drag to zoom · double-click for the whole lap'));
  }

  /**
   * The Conditions panel: the compared laps' track conditions, folded to one line that
   * says whether they differ. Hidden when no lap has any. Never touches the analysis.
   */
  function conditions() {
    const P = V.condPanel, cmp = V.cmp;
    const C = IST.Review.Conditions.compare(cmp.laps.map((L) => L.lap.cond));
    P.innerHTML = '';
    P.classList.toggle('hidden', !C.rows.length);
    if (!C.rows.length) return;
    const many = cmp.laps.length > 1;
    const verdict = !many ? '' : C.differs ? C.differs + (C.differs === 1 ? ' difference' : ' differences') : 'Same for these laps';
    const det = h('details', { class: 'rv-cond-box', open: state.condOpen },
      h('summary', null, h('span', { class: 'rv-cond-title' }, 'Conditions'),
        verdict ? h('span', { class: 'rv-cond-verdict' + (C.differs ? ' warn' : '') }, verdict) : null));
    det.addEventListener('toggle', () => (state.condOpen = det.open));
    const tb = h('table', { class: 'rv-cond-table' },
      many ? h('tr', null, h('th', null, ''), cmp.laps.map((L, k) => h('th', null, h('i', { class: 'rv-swatch', style: 'background:' + COLORS[k] }), (k ? '' : 'Ref ') + L.lap.lapNo))) : null,
      C.rows.map((r) => h('tr', { class: r.differs ? 'differs' : '', title: r.differs && r.apart ? r.apart + ' apart' : '' },
        h('td', null, r.label), r.values.map((v) => h('td', null, v)))));
    det.append(tb);
    if (C.differs) det.append(h('p', { class: 'hint' }, 'Grip and balance change with conditions, so part of the gap between these laps may be the track, not the driving.'));
    P.append(det);
  }

  /** Options for the Inputs select: all laps, off, or one lap; keeps the choice if it still exists. */
  function inputOptions() {
    const sel = V.inputs, cmp = V.cmp;
    const opts = [['all', 'All laps'], ['none', 'None']].concat(cmp.laps.map((L, k) => ['lap' + k, (k ? 'Lap ' : 'Ref · Lap ') + L.lap.lapNo]));
    if (!opts.some((o) => o[0] === state.opts.inputs)) state.opts.inputs = 'all';
    sel.innerHTML = '';
    opts.forEach(([v, l]) => sel.append(h('option', { value: v, selected: v === state.opts.inputs }, l)));
    return whose();
  }
  /** Per lap: does the Whose choice include it. */
  function whose() {
    const o = state.opts.inputs;
    return V.cmp.laps.map((_, k) => o === 'all' || o === 'lap' + k);
  }

  function lapList() {
    const P = V.lapsPanel;
    P.innerHTML = '';
    P.append(h('h2', null, 'Laps'), h('p', { class: 'hint' }, 'Tick up to ' + MAX_LAPS + ' to compare. Ref sets the lap the others are timed against.'));
    // the files and laps scroll under the fixed heading when the list is long
    const body = h('div', { class: 'rv-laps-list' });
    P.append(body);
    const best = bestFull();
    state.sessions.forEach((s) => {
      const entries = state.laps.filter((x) => x.s === s);
      const meta = [s.meta.track, s.meta.car, s.meta.driver].filter(Boolean).join(' · ');
      // in-car settings at the start of the first timed lap
      const first = entries.map((x) => x.lap).find(complete) || (entries[0] && entries[0].lap);
      const set = first ? [['absSet', 'ABS ', 0], ['tcSet', 'TC ', 0], ['bb', 'BB ', 1]].filter(([k]) => first[k]).map(([k, n, d]) => n + first[k][0].toFixed(d) + (k === 'bb' ? ' %' : '')).join(' · ') : '';
      body.append(h('div', { class: 'rv-file' },
        h('div', { class: 'rv-file-name', title: s.file }, s.file),
        h('div', { class: 'rv-file-meta muted' }, (meta ? meta + ' · ' : '') + s.format),
        set ? h('div', { class: 'rv-file-meta muted', title: 'In-car settings at the start of the first timed lap' }, set) : null));
      // complete laps are the list; out, in, pit and cut-short laps fold into a footer
      const list = h('ul', { class: 'rv-lap-list' }), rest = h('ul', { class: 'rv-lap-list' });
      let partials = 0;
      entries.forEach((x) => {
        const done = complete(x.lap);
        if (!done) partials++;
        const k = selIndex(x.id);
        const on = k >= 0;
        const isRef = x.id === state.refId;
        const tag = x.lap.pit ? 'pit' : x.lap.kind !== 'full' ? x.lap.kind : null;
        const d = done && isFinite(best) ? x.lap.time - best : NaN;
        const box = h('input', { type: 'checkbox', checked: on, disabled: isRef, 'aria-label': 'Compare lap ' + x.lap.lapNo });
        box.addEventListener('change', () => toggle(x.id));
        (done ? list : rest).append(h('li', { class: 'rv-lap' + (on ? ' on' : '') + (isRef ? ' ref' : '') },
          h('label', { class: 'rv-lap-main' },
            box,
            h('i', { class: 'rv-swatch', style: on ? 'background:' + COLORS[k] : '' }),
            h('span', { class: 'rv-lap-no' }, 'Lap ' + x.lap.lapNo),
            tag ? h('span', { class: 'rv-lap-tag' }, tag) : null,
            h('span', { class: 'rv-lap-time' }, Cmp.fmtLap(x.lap.time)),
            h('span', { class: 'rv-lap-d' + (d === 0 ? ' best' : '') }, isFinite(d) ? (d === 0 ? 'best' : '+' + d.toFixed(3)) : '')),
          h('button', { class: 'rv-ref' + (isRef ? ' on' : ''), title: 'Use as reference', onclick: () => setRef(x.id) }, 'Ref')));
      });
      if (list.children.length) body.append(list);
      if (partials) {
        const open = state.partialsOpen.has(s) || (!list.children.length);
        const box = h('details', { class: 'rv-partials', open: open || null },
          h('summary', null, partials + (partials === 1 ? ' partial' : ' partials')), rest);
        box.addEventListener('toggle', () => (box.open ? state.partialsOpen.add(s) : state.partialsOpen.delete(s)));
        body.append(box);
      }
    });
  }
  /** A lap to compare: start line to start line, not through the pits. */
  const complete = (lap) => lap.kind === 'full' && !lap.pit;
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
    P.append(h('h2', null, 'At cursor' + (i >= 0 ? ' · ' + Math.round(i * cmp.step) + ' m' : '')));
    if (i < 0) return P.append(h('p', { class: 'hint' }, 'Hover a line in the 3D view or the traces.'));
    const onMap = cmp.centre.source === 'map';
    const row = (L) => h('tr', null,
      h('td', { title: 'Lap ' + L.lap.lapNo }, h('i', { class: 'rv-swatch', style: 'background:' + L.color }), 'L' + L.lap.lapNo),
      h('td', null, Math.round(L.speed[i] * 3.6)),
      h('td', null, L.throttle ? Math.round(L.throttle[i] * 100) : '–'),
      h('td', null, L.brake ? Math.round(L.brake[i] * 100) : '–'),
      h('td', null, L.gear ? Math.round(L.gear[i]) : '–'),
      onMap ? h('td', { title: 'From the track centre' }, Math.abs(L.off[i]) < 0.05 ? '0.0' : Math.abs(L.off[i]).toFixed(1) + (L.off[i] > 0 ? ' L' : ' R')) : null,
      h('td', { class: 'delta ' + (L === cmp.laps[0] ? 'flat' : L.delta[i] > 0.005 ? 'bad' : L.delta[i] < -0.005 ? 'good' : 'flat') }, L === cmp.laps[0] ? 'ref' : U.signedSec(L.delta[i]).replace(' s', '')));
    P.append(h('table', { class: 'grid rv-table' },
      h('thead', null, h('tr', null, [['Lap'], ['km/h', 'Speed'], ['Thr', 'Throttle pedal, %'], ['Brk', 'Brake pedal, %'], ['G', 'Gear']]
        .concat(onMap ? [['Ctr m', 'Distance from the track centre, metres, to the left (L) or right (R)']] : [], [['Δ s', 'Time behind (+) or ahead (−) of the reference lap at this point, seconds']])
        .map(([x, tip]) => h('th', null, U.term(x, tip))))),
      h('tbody', null, cmp.laps.map(row))));
    // the other lanes on screen, a column per lap
    const BASIC = new Set(['speed', 'delta', 'throttle', 'brake', 'gear']);
    const more = V.traces.values(i).filter((r) => !BASIC.has(r.key));
    if (more.length) {
      P.append(h('table', { class: 'grid rv-table rv-table-more' },
        h('thead', null, h('tr', null, h('th', null, 'Lane'), cmp.laps.map((L) => h('th', null, h('i', { class: 'rv-swatch', style: 'background:' + L.color }), 'L' + L.lap.lapNo)))),
        h('tbody', null, more.map((r) => {
          const lane = Tr.LANES.find((l) => l.key === r.key);
          const name = [r.label, r.unit && !r.label.endsWith(' ' + r.unit) ? h('span', { class: 'muted' }, ' ' + r.unit) : null];
          return h('tr', null, h('td', null, U.term(name, lane && lane.title)), r.vals.map((v) => h('td', null, v)));
        }))));
    }
    const tg = tyreGrid(cmp.laps[0], i);
    if (tg) P.append(tg);
  }

  /** Tyres at the cursor for the reference lap: inner / mid / outer heat strips, mean and pressure. */
  function tyreGrid(L, i) {
    const bands = !!L.tLF_i;
    if (!bands && !L.tLF && !L.pLF) return null;
    const heat = (t) => {
      if (!isFinite(t)) return 'transparent';
      const f = Math.max(0, Math.min(1, (t - 60) / 50));
      const c = f < 0.5 ? Ly.mix(Ly.rgb(Th.sky), Ly.rgb(Th.butter), f * 2) : Ly.mix(Ly.rgb(Th.butter), Ly.rgb(Th.rose), (f - 0.5) * 2);
      return 'rgb(' + c.map((x) => Math.round(x * 255)).join(',') + ')';
    };
    const tyre = (w) => {
      const left = w[0] === 'L';
      // as seen from above: the outer edge of a left tyre is on the left
      const order = left ? ['o', 'm', 'i'] : ['i', 'm', 'o'];
      const cells = bands ? order.map((b) => {
        const t = L['t' + w + '_' + b][i];
        return h('i', { style: 'background:' + heat(t), title: { i: 'Inner', m: 'Middle', o: 'Outer' }[b] + ' ' + Math.round(t) + ' °C' });
      }) : [h('i', { style: 'background:' + heat(L['t' + w] ? L['t' + w][i] : NaN) })];
      const mean = L['t' + w] ? Math.round(L['t' + w][i]) + '°' : '–';
      return h('div', { class: 'rv-tyre' },
        h('div', { class: 'rv-tyre-name' }, w),
        L['t' + w] || bands ? h('div', { class: 'rv-tyre-heat' }, cells) : null,
        h('div', { class: 'rv-tyre-val' }, mean, L['p' + w] ? h('span', { class: 'muted' }, ' · ' + Math.round(L['p' + w][i]) + ' kPa') : null));
    };
    return h('div', { class: 'rv-tyres' },
      h('h2', null, 'Tyres · ref lap'),
      h('div', { class: 'rv-tyre-grid' }, ['LF', 'RF', 'LR', 'RR'].map(tyre)));
  }

  // ------------------------------------------------------------- lanes box
  const GROUPS = [['driving', 'Driving'], ['car', 'Car'], ['tyres', 'Tyres'], ['chassis', 'Chassis']];
  const PRESET_NAMES = [['basic', 'Basic', 'Speed, delta, pedals, steering and gear'], ['handling', 'Handling', 'The basics plus balance, yaw rate, sideslip and lateral g'],
    ['tyres', 'Tyres', 'Front and rear tyre lanes, wheel slip and brake'], ['all', 'All', 'Every lane this file has']];

  /** Lane label notes from the reference session's balance calibration. */
  function lanesLabels() {
    const s = refSession(), c = s && s.calib;
    state.lanes.labels = {};
    if (!c) return;
    if (c.rFromAy) state.lanes.labels.balance = 'Balance (from lateral g)';
    if (c.Gspread > 0.5) state.lanes.labels.balance = 'Balance (calibration uncertain)';
  }

  function lanesChanged() {
    saveLanes();
    if (!V) return;
    V.traces.setLanes(state.lanes);
    lanesBox();
    readout();
  }

  /**
   * Lanes: one line on top of the traces (a Lanes button with the count, what's on, and
   * the presets) and a foldout that opens upward over the 3D view with the full set,
   * a row per group. The traces stay in sight underneath, so each toggle shows at once;
   * Esc, Done or a press outside folds it away.
   */
  function lanesBox() {
    const P = V.lanesBox, cmp = V.cmp, L = state.lanes;
    const focusKey = document.activeElement && P.contains(document.activeElement) ? document.activeElement.dataset.k : null;
    P.innerHTML = '';
    const avail = (k) => Tr.available(cmp, k);
    const chip = (k, label, title, on, onclick, disabled) =>
      h('button', { class: 'seg-b' + (on ? ' on' : ''), 'data-k': k, 'aria-pressed': String(!!on), disabled: disabled || null, title: disabled ? 'Not in this file' : title, onclick }, label);
    const shown = Tr.LANES.filter((l) => !l.virtual && L.on.has(l.key) && avail(l.key));
    const tyresOk = avail('tyreTemp') || avail('tyrePress');
    const names = shown.map((l) => l.label).concat(tyresOk ? L.picks.map((k) => Tr.PICK_NAME[k] + (L.tyreMode === 'press' ? ' kPa' : ' °C')) : []);
    const open = !!V.lanesOpen;

    // the line
    P.append(
      h('button', { class: 'rv-lanes-toggle' + (open ? ' on' : ''), 'data-k': 'toggle', 'aria-expanded': String(open), 'aria-controls': 'rv-lanes-panel', title: open ? 'Fold the lane picker away (Esc)' : 'Choose which traces to show',
        onclick: () => setLanesOpen(!open) }, 'Lanes', h('span', { class: 'rv-lanes-n' }, String(names.length))),
      h('span', { class: 'rv-lanes-sum', title: names.join(', ') }, names.join(' · ') || 'None'),
      h('div', { class: 'seg rv-presets', role: 'group', 'aria-label': 'Lane presets' },
        PRESET_NAMES.map(([k, label, title]) => h('button', { class: 'seg-b', 'data-k': 'p-' + k, title, onclick: () => applyPreset(k) }, label))));

    // the foldout
    const rows = GROUPS.map(([g, name]) => {
      const chips = [];
      Tr.LANES.filter((l) => l.group === g && !l.virtual).forEach((l) => {
        chips.push(chip(l.key, l.label, l.title, L.on.has(l.key), () => {
          L.on.has(l.key) ? L.on.delete(l.key) : L.on.add(l.key);
          lanesChanged();
        }, !avail(l.key)));
        if (l.key === 'brake' && avail('abs')) chips.push(chip('abs', 'ABS on brake', 'Shade the brake lane where ABS acts, with a dashed line for the force it removed', L.abs, () => ((L.abs = !L.abs), lanesChanged())));
      });
      let extra = null;
      if (g === 'tyres') {
        const tOk = avail('tyreTemp'), pOk = avail('tyrePress');
        if (L.tyreMode === 'temp' && !tOk && pOk) L.tyreMode = 'press';
        extra = h('div', { class: 'rv-tyre-ctl' },
          tyrePicker(tyresOk),
          h('div', { class: 'seg', role: 'group', 'aria-label': 'Tyre value' },
            chip('temp', 'Temp', 'Surface temperature, °C', L.tyreMode === 'temp', () => ((L.tyreMode = 'temp'), lanesChanged()), !tOk),
            chip('press', 'Pressure', 'Hot pressure, kPa', L.tyreMode === 'press', () => ((L.tyreMode = 'press'), lanesChanged()), !pOk)),
          L.tyreMode === 'temp' ? h('div', { class: 'seg', role: 'group', 'aria-label': 'Tyre band' },
            [['avg', 'Avg', 'Mean of inner, middle and outer'], ['i', 'Inner', 'Inner edge'], ['m', 'Mid', 'Middle'], ['o', 'Outer', 'Outer edge']].map(([k, lab, t]) =>
              chip('b-' + k, lab, t, L.tyreBand === k, () => ((L.tyreBand = k), lanesChanged()), !tyresOk || (k !== 'avg' && !avail('tyreBands'))))) : null);
      }
      return h('div', { class: 'rv-lanes-row' },
        h('span', { class: 'rv-lanes-group' }, name),
        h('div', { class: 'rv-lanes-cells' }, h('div', { class: 'seg rv-chips', role: 'group', 'aria-label': name + ' lanes' }, chips), extra));
    });
    P.append(h('div', { class: 'rv-lanes-panel' + (open ? '' : ' hidden'), id: 'rv-lanes-panel', role: 'dialog', 'aria-label': 'Choose trace lanes' },
      h('div', { class: 'rv-lanes-panel-head' },
        h('span', { class: 'rv-lanes-panel-title' }, 'Trace lanes'),
        h('span', { class: 'muted' }, 'Changes show on the traces as you pick'),
        h('button', { class: 'btn small', 'data-k': 'done', onclick: () => setLanesOpen(false) }, 'Done')),
      rows));
    if (focusKey) {
      const el = P.querySelector('[data-k="' + focusKey + '"]');
      if (el) el.focus();
    }
  }
  function setLanesOpen(open) {
    if (!V) return;
    V.lanesOpen = open;
    lanesBox();
    if (open && !V.popAway) {
      // fold away on a press anywhere outside the bar and its panel
      V.popAway = (e) => !e.target.closest('.rv-lanebar') && setLanesOpen(false);
      document.addEventListener('pointerdown', V.popAway, true);
    } else if (!open && V.popAway) {
      document.removeEventListener('pointerdown', V.popAway, true);
      V.popAway = null;
    }
  }

  /** Top-down car: four wheels and the four edges between them. Click to add or remove a tyre lane. */
  function tyrePicker(enabled) {
    const L = state.lanes;
    const btn = (k, cls) => h('button', {
      class: 'rv-pick ' + cls + (L.picks.indexOf(k) >= 0 ? ' on' : ''), 'aria-pressed': String(L.picks.indexOf(k) >= 0), disabled: enabled ? null : true,
      title: enabled ? Tr.PICK_NAME[k] + (k.length === 2 ? ' tyre' : ' (mean of two)') : 'Not in this file', 'aria-label': Tr.PICK_NAME[k] + ' tyre lane',
      onclick: () => {
        const at = L.picks.indexOf(k);
        at >= 0 ? L.picks.splice(at, 1) : L.picks.push(k);
        lanesChanged();
      },
    });
    return h('div', { class: 'rv-picker', role: 'group', 'aria-label': 'Tyre lanes' },
      btn('LF', 'w lf'), btn('front', 'e ef'), btn('RF', 'w rf'),
      btn('left', 'e el'), h('i', { class: 'rv-pick-body' }), btn('right', 'e er'),
      btn('LR', 'w lr'), btn('rear', 'e eb'), btn('RR', 'w rr'));
  }

  function applyPreset(k) {
    const p = Tr.PRESETS[k];
    state.lanes.on = new Set(p.on);
    state.lanes.picks = p.picks.slice();
    lanesChanged();
  }

  // ---------------------------------------------------------- layers drawer
  const paintOk = (k) => {
    const d = Ly.PAINTS.find((x) => x.key === k);
    return !!d && V && V.cmp && d.needs.every((c) => hasCh(V.cmp, c)) && (!d.cmp || V.cmp.laps.length > 1);
  };
  const fenceOk = (k) => {
    const d = Ly.FENCES.find((x) => x.key === k);
    return !!d && V && V.cmp && d.needs.every((c) => hasCh(V.cmp, c)) && (!d.cmp || V.cmp.laps.length > 1);
  };

  /**
   * The one lap the Delta fence draws (several gaps stacked on the lines would be unreadable):
   * the lap picked in Whose, or with Whose on all laps the first one compared. -1 when Whose
   * is the reference or none.
   */
  function deltaLap() {
    const cmp = V && V.cmp, o = state.opts.inputs;
    if (!cmp || cmp.laps.length < 2) return -1;
    if (o === 'all') return 1;
    const k = o.startsWith('lap') ? +o.slice(3) : 0;
    return k > 0 && k < cmp.laps.length ? k : -1;
  }

  function setDrawer(open) {
    state.drawer = open;
    if (!V) return;
    V.drawer.classList.toggle('hidden', !open);
    // below the toolbar, however many rows it wraps to, so the Layers button stays reachable
    const bar = V.stage.querySelector('.rv-toolbar');
    if (bar) V.drawer.style.top = bar.offsetTop + bar.offsetHeight + 8 + 'px';
    V.stage.classList.toggle('rv-drawer-open', open);
    V.layersBtn.classList.toggle('on', open);
    V.layersBtn.setAttribute('aria-expanded', String(open));
    dirty();
  }

  function layersChanged() {
    saveLayers();
    restyle();
  }

  /** The scene's layer options from the page state. */
  function layerOpts() {
    const o = state.opts;
    return {
      fences: V.fences, lean: o.lean, fenceH: V.closeUp ? 3.5 : 0, closeUp: V.closeUp,
      paint: paintOk(o.paint) ? o.paint : 'lap', fence: fenceOk(o.fence) ? o.fence : 'inputs', absTint: o.absTint, markers: markerKinds(), gears: markerOn('gears'),
      attitude: attitudeOn(), attScale: o.attScale, deltaLap: deltaLap(),
    };
  }

  /**
   * A Layers change: swap the scene's layer meshes (cached per choice) and the legend.
   * The comparison, the static scene, the map tiles and the panels stay as they are.
   */
  function restyle() {
    if (!V || !V.cmp) return;
    V.markerKinds = markerKinds();
    legend();
    if (V.scene) {
      V.closeUp = V.cam.mode !== 'orbit';
      V.scene.setLayers(layerOpts());
    }
    dirty();
  }

  function drawerBody() {
    const D = V.drawer, cmp = V.cmp, o = state.opts;
    D.innerHTML = '';
    V.stage.classList.toggle('rv-drawer-open', state.drawer);
    const radio = (name, d, cur, ok, onPick, swatch) => {
      const input = h('input', { type: 'radio', name, value: d.key, checked: d.key === cur, disabled: ok ? null : true });
      input.addEventListener('change', () => onPick(d.key));
      return h('label', { class: 'view-check rv-radio' + (ok ? '' : ' off'), title: ok ? d.title : 'Not in this file' }, input,
        swatch ? h('i', { class: 'rv-grad', style: 'background:' + swatch }) : null, d.label);
    };
    const cur = (list, k, ok) => (ok(k) ? k : list[0].key);
    // 1. line colour
    D.append(h('h2', null, 'Line colour'),
      h('div', { class: 'rv-radios' }, Ly.PAINTS.map((d) => radio('rv-paint', d, cur(Ly.PAINTS, o.paint, paintOk), paintOk(d.key), (k) => ((o.paint = k), layersChanged()),
        d.legend ? d.legend.css : 'linear-gradient(90deg, ' + Th.butter + ' 33%, ' + Th.sky + ' 33% 66%, ' + Th.lilac + ' 66%)'))));
    // 2. fence
    const absOk = hasCh(cmp, 'absActive');
    const absBox = h('input', { type: 'checkbox', checked: o.absTint, disabled: absOk ? null : true });
    absBox.addEventListener('change', () => ((o.absTint = absBox.checked), layersChanged()));
    D.append(h('h2', null, 'Fence'),
      h('div', { class: 'rv-radios' }, Ly.FENCES.map((d) => radio('rv-fence', d, cur(Ly.FENCES, o.fence, fenceOk), fenceOk(d.key), (k) => ((o.fence = k), layersChanged())))),
      h('label', { class: 'rv-field', title: 'Whose fence, line colour and markers to draw: every lap or one' }, h('span', null, 'Whose'), V.inputs),
      check('Steering lean', 'lean', 'Lean the fences toward the steering input', restyle),
      h('label', { class: 'view-check' + (absOk ? '' : ' off'), title: absOk ? 'Stripe the brake fence darker where ABS was cutting force' : 'Not in this file' }, absBox, 'ABS tint'));
    // 3. markers
    const kindsIn = new Set();
    cmp.laps.forEach((L) => (L.events || []).forEach((e) => kindsIn.add(e.kind)));
    D.append(h('h2', null, 'Markers'),
      h('div', { class: 'rv-radios' }, Ly.MARKERS.map((m) => {
        const ok = m.kinds ? m.kinds.some((k) => kindsIn.has(k)) : (m.needs || []).every((c) => hasCh(cmp, c));
        const box = h('input', { type: 'checkbox', checked: markerOn(m.key), disabled: ok ? null : true });
        box.addEventListener('change', () => {
          box.checked ? o.markers.add(m.key) : o.markers.delete(m.key);
          layersChanged();
        });
        return h('label', { class: 'view-check' + (ok ? '' : ' off'), title: ok ? m.title : m.kinds ? 'None on these laps' : 'Not in this file' }, box,
          h('i', { class: 'rv-glyph' + (m.kinds && !m.pip ? ' bar' : ''), style: 'background:' + (m.color || Th.butter) }), m.label);
      })));
    if (hasCh(cmp, 'vx') && hasCh(cmp, 'vy')) {
      const att = h('select', { 'aria-label': 'Attitude angle scale' }, [[1, '×1 (true)'], [2, '×2'], [4, '×4']].map(([v, l]) => h('option', { value: v, selected: v === o.attScale }, l)));
      att.addEventListener('input', () => ((o.attScale = +att.value), layersChanged()));
      D.append(h('label', { class: 'rv-field', title: 'Exaggerate the drawn slip angle (arrows and the yawed cars). Real slip is a few degrees' }, h('span', null, 'Attitude angle'), att));
    }
    // 4. view
    const elev = h('select', { 'aria-label': 'Elevation scale' }, [[1, '×1'], [2, '×2'], [4, '×4'], [8, '×8']].map(([v, l]) => h('option', { value: v, selected: v === o.exag }, l)));
    elev.addEventListener('input', () => {
      o.exag = +elev.value;
      saveLayers();
      rebuild(true);
    });
    const motion = h('select', { 'aria-label': 'Body motion scale' }, [[0, 'Off'], [1, '×1 (true)'], [3, '×3'], [6, '×6']].map(([v, l]) => h('option', { value: v, selected: v === o.motion }, l)));
    motion.addEventListener('input', () => ((o.motion = +motion.value), saveLayers(), dirty()));
    D.append(h('h2', null, 'View'),
      check('Cars', 'cars', 'A car for each lap where it was at the reference’s time, with the gap', dirty),
      h('label', { class: 'rv-field', title: 'How far the cars’ bodies dive, squat, roll and heave on their wheels. From ride heights when the file has them, else estimated from g. Real movement is a degree or two' }, h('span', null, 'Body motion'), motion),
      mapCheck(),
      h('label', { class: 'rv-field' }, h('span', null, 'Elevation'), elev),
      h('button', { class: 'btn ghost small rv-fit-btn', onclick: () => { V.traces.zoom(); frameAll(); } }, 'Fit view'));
  }

  /** Bottom-right key for what the line colour and the fence mean right now. */
  function legend() {
    const E = V.legend, o = state.opts;
    E.innerHTML = '';
    const item = (cls, text, style, title) => h('span', { title: title || null }, h('i', { class: 'rv-key ' + cls, style: style || null }), text);
    const paint = paintOk(o.paint) ? Ly.PAINTS.find((x) => x.key === o.paint) : null;
    if (paint && paint.legend) {
      E.append(h('span', { class: 'rv-legend-grad' }, h('b', null, paint.legend.lo), h('i', { class: 'rv-grad wide', style: 'background:' + paint.legend.css }), h('b', null, paint.legend.hi)));
    }
    const fence = fenceOk(o.fence) ? o.fence : 'inputs';
    if (fence === 'inputs') {
      E.append(item('rv-key-thr', 'Throttle'), item('rv-key-brk', 'Brake'));
      if (o.absTint && hasCh(V.cmp, 'absActive')) E.append(item('rv-key-abs', 'ABS'));
    } else if (fence === 'balance') E.append(item('', 'Understeer', 'background:' + Th.sky), item('', 'Oversteer', 'background:' + Th.peach));
    else if (fence === 'grip') E.append(item('', 'Grip used', 'background:' + Th.butter), item('', 'Over 100 %', 'background:' + Th.rose));
    else if (fence === 'delta') {
      const k = deltaLap(), L = k > 0 ? V.cmp.laps[k] : null;
      if (!L) E.append(h('span', { class: 'rv-legend-note' }, 'Delta: pick a lap other than the reference in Whose'));
      else {
        let big = 0.05;
        for (let i = 0; i < V.cmp.n; i++) big = Math.max(big, Math.abs(L.delta[i]));
        const end = L.delta[V.cmp.n - 1];
        E.append(h('span', { class: 'rv-legend-grad', title: 'Fence height: Lap ' + L.lap.lapNo + '’s gap to the reference, full height = ' + big.toFixed(3) + ' s. Fill: gaining (mint) or losing (rose) time there' },
          h('b', null, 'L' + L.lap.lapNo + ' gap 0–' + big.toFixed(2) + ' s · gaining'),
          h('i', { class: 'rv-grad wide', style: 'background:linear-gradient(90deg, ' + Th.mint + ', #a1a9b7, ' + Th.rose + ')' }), h('b', null, 'losing')),
          h('span', { class: 'rv-legend-note' }, (end >= 0 ? '+' : '−') + Math.abs(end).toFixed(3) + ' s at the line'));
        if (V.cmp.laps.length > 2 && state.opts.inputs === 'all') {
          E.append(h('span', { class: 'rv-legend-note', title: 'With 3 or more laps the Delta fence shows one: pick which in Layers → Whose' }, 'one lap at a time: choose in Whose'));
        }
      }
    }
    if (fence !== 'none' || paint) E.append(item('rv-key-cap', 'Lap colour', null, paint ? 'Painted lines keep an edge in their lap’s colour' : 'Each fence is edged in its lap’s colour'));
    if (markerOn('gears')) E.append(item('rv-key-gear', 'Gear change'));
    if (attitudeOn()) {
      E.append(h('span', { class: 'rv-legend-grad', title: 'Attitude wedges: slip angle against this session’s usual at that lateral g' + (o.attScale > 1 ? ' (drawn ×' + o.attScale + ')' : '') },
        h('b', null, 'Less rotation'), h('i', { class: 'rv-grad wide', style: 'background:linear-gradient(90deg, ' + Th.sky + ', #a1a9b7 35% 50%, ' + Th.peach + ' 75%, ' + Th.rose + ')' }), h('b', null, 'More')));
    }
  }

  // ---------------------------------------------------------------- 3D life
  function start() {
    V.R = IST.Review.GL.create(V.glEl);
    V.texCache = new Map(); // map tile textures, kept across scene rebuilds (freed with the GL context)
    V.cam = IST.Review.Camera.create();
    V.ov = IST.Review.Overlay.create();
    V.traces = IST.Review.Traces.create(V.tracesEl, { onCursor: setCursor, onRange: frameRange, onReset: frameAll, fit: () => (V ? V.tracesWrap.clientHeight - 2 : 0) });
    if (!V.R) {
      V.stage.append(h('div', { class: 'rv-nogl' }, 'WebGL isn’t available in this browser, so the 3D view is off. The traces still work.'));
    } else {
      V.detach = V.cam.attach(V.glEl, dirty);
      V.glEl.addEventListener('pointermove', hover);
      V.carMesh = V.R.dynamic('tris');
      V.shadowMesh = V.R.dynamic('tris');
    }
    // capture phase, as on Stats: a modal is still open here, so the Esc that closes it doesn't also leave the page
    V.onKey = onKey;
    window.addEventListener('keydown', onKey, true);
    if (window.ResizeObserver) {
      V.ro = new ResizeObserver(() => {
        if (V && V.R) V.R.resize();
        if (V) V.traces.draw();
        dirty();
      });
      V.ro.observe(V.stage);
      V.ro.observe(V.tracesWrap);
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
    V.fences = inputOptions();
    lanesLabels();
    lapList();
    lanesBox();
    drawerBody();
    legend();
    V.traces.set(V.cmp, state.lanes);
    V.traces.setCursor(state.cursor);
    readout();
    conditions();
    mapStatus();
    if (V.R) {
      if (V.scene) V.scene.dispose();
      // close-up cameras sit a few metres off the road: low fences there, tall ones for the overview
      V.closeUp = V.cam.mode !== 'orbit';
      const map = state.opts.map && V.cmp.laps[0].entry.s.map;
      V.scene = IST.Review.Scene.build(V.R, V.cmp, Object.assign({ exag: state.opts.exag, map: !!map }, layerOpts()));
      V.markerKinds = markerKinds();
      V.noImagery = false;
      if (map) {
        IST.Review.MapLayer.build(V.R, V.scene, V.cmp, map.geo, (err) => {
          if (err && V) (V.noImagery = true), mapStatus();
          dirty();
        }, { texCache: V.texCache });
      }
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
    if (V.scene && V.closeUp !== (mode !== 'orbit')) restyle();
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
    const cmp = V.cmp, f = Math.max(0, state.cursorF), T = timeAt(cmp.laps[0].t, f), attitude = attitudeOn();
    return cmp.laps.map((L, k) => {
      const j = k ? indexAt(L.t, T) : f;
      let pose = IST.Review.Rigs.pose(V.scene, k, j), slip = NaN;
      if (attitude) {
        // yaw the car by its slip angle so it points where its nose did, not down its path
        slip = Ly.nose(L, Math.round(j));
        if (isFinite(slip)) {
          const a = Math.max(-80, Math.min(80, (slip * 180) / Math.PI * state.opts.attScale)) * (Math.PI / 180), c = Math.cos(a), s2 = Math.sin(a);
          const F = pose.fwd, Lf = pose.left;
          pose = { p: pose.p, fwd: [F[0] * c + Lf[0] * s2, 0, F[2] * c + Lf[2] * s2], left: [Lf[0] * c - F[0] * s2, 0, Lf[2] * c - F[2] * s2] };
        }
      }
      return Object.assign({ k, j, pose, gapM: (f - j) * cmp.step, slip }, stance(L, k, j, pose));
    });
  }

  const carKinds = new WeakMap(); // comparison lap -> car type, from its session's car name
  function kindOf(L) {
    if (!carKinds.has(L)) {
      const e = state.laps.find((x) => x.lap === L.lap);
      carKinds.set(L, IST.Review.Cars.kindOf(e && e.s.meta.car));
    }
    return carKinds.get(L);
  }
  /**
   * The car's axes on the road (tilted to the slope of its line) and its body's on top
   * (dive, roll and heave from Stance, drawn at the Body motion scale), plus what the
   * model shows: front wheel angle and brake lights.
   */
  function stance(L, k, j, pose) {
    const M = IST.Review.M3.v, P = V.scene.base[k], n = V.cmp.n, kind = kindOf(L), m = IST.Review.Cars.model(kind);
    // slope between the axles, as drawn (so it follows the Elevation scale)
    const half = m.wheelbase / 2 / V.cmp.step, a = Math.max(0, j - half), b = Math.min(n - 1, j + half);
    const ya = IST.Review.Rigs.pose(V.scene, k, a).p[1], yb = IST.Review.Rigs.pose(V.scene, k, b).p[1];
    const f = M.norm([pose.fwd[0], (yb - ya) / Math.max(0.5, (b - a) * V.cmp.step), pose.fwd[2]]);
    const l = pose.left, u = M.norm(M.cross(f, l));
    const p = [pose.p[0], pose.p[1] - V.scene.lift(k) + 0.02, pose.p[2]];
    const road = { p, f, u, l };
    const g = state.opts.motion, lim = (x, m2) => Math.max(-m2, Math.min(m2, x));
    const st = g ? IST.Review.Stance.at(L, j, kind) : { dive: 0, roll: 0, heave: 0 };
    const dv = lim(st.dive * g, 0.14), rl = lim(st.roll * g, 0.2), hv = lim(st.heave * g, 0.05);
    const cd = Math.cos(dv), sd = Math.sin(dv), cr = Math.cos(rl), sr = Math.sin(rl);
    const bf = M.add(M.scale(f, cd), M.scale(u, -sd)), u1 = M.add(M.scale(u, cd), M.scale(f, sd));
    const body = { p: M.add(p, M.scale(u, hv)), f: bf, l: M.add(M.scale(l, cr), M.scale(u1, sr)), u: M.add(M.scale(u1, cr), M.scale(l, -sr)) };
    const i = Math.max(0, Math.min(n - 1, Math.round(j)));
    return { kind, road, body, steer: L.steer ? lim(L.steer[i] / 13, 0.6) : 0, braking: !!L.brake && L.brake[i] > 0.03 };
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
    // close up, the coarse satellite layer is only a blur beside the sharp corridor:
    // stop drawing it (with a gap between the two distances so it doesn't flicker)
    if (m.dist < COARSE_HIDE) V.hideCoarse = true;
    else if (m.dist > COARSE_SHOW) V.hideCoarse = false;
    const items = (V.hideCoarse ? V.scene.items.filter((it) => !it.coarse) : V.scene.items).concat(V.scene.layerItems);
    if (state.opts.cars && C.length) {
      const Vt = IST.Review.GL.Verts();
      const Sh = IST.Review.GL.Verts(), Cars = IST.Review.Cars;
      C.forEach((c) => {
        const md = Cars.model(c.kind);
        Cars.emit(Vt, md, c.road, c.body, IST.Review.GL.rgb(V.cmp.laps[c.k].color), { steer: c.steer, brake: c.braking });
        Cars.shadow(Sh, md, c.road);
      });
      V.carMesh.set(Vt.data());
      V.shadowMesh.set(Sh.data());
      items.push({ mesh: V.carMesh, lit: true }, { mesh: V.shadowMesh, lit: false, blend: true, lift: 4 });
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
      vp: m.vp, scene: V.scene, cmp: V.cmp, cursorF: state.cursorF, cars: state.opts.cars ? C : [], gaps: C.map((c) => c.gapM), range: V.range,
      gears: markerOn('gears'), tags: markerOn('tags'), attitude: attitudeOn(), fences: V.fences, markers: V.markerKinds, chipsBeside: V.cam.mode === 'top', dt,
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
    if (root().classList.contains('hidden') || !V || e.ctrlKey || e.metaKey || e.altKey) return;
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
    else if (e.code === 'KeyL') setDrawer(!state.drawer);
    else if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && V.cmp) {
      e.preventDefault();
      const d = Math.round((e.shiftKey ? 100 : 10) / V.cmp.step) * (e.code === 'ArrowLeft' ? -1 : 1);
      setCursor(Math.max(0, Math.min(V.cmp.n - 1, Math.max(0, state.cursor) + d)));
    } else if (e.code === 'Escape') {
      if (V.lanesOpen) setLanesOpen(false);
      else if (state.drawer) setDrawer(false);
      else close();
    }
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
