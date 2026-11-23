/*
 * View screen: in-car view settings (cockpit, FOV, horizon, seat, paint) with a live
 * preview driving a generated track. Changes save as you make them; every drill that
 * uses the in-car view (IST.View) picks them up on its next run.
 */
(function () {
  'use strict';
  const U = IST.util, h = U.h, Sym = IST.Symbols;
  const BOARD_M = 2.4, BOARD_KERB = 1.07, HIDE_AT = 0.1;
  const HZ_SHOW_MS = 1400; // red horizon line after the slider is let go

  let raf = 0;

  function open() {
    const root = document.getElementById('screen-view');
    root.innerHTML = '';
    let V = IST.View.get();
    const pv = { aspect: 16 / 9, theme: 'realistic', mask: false, hzUntil: 0, hzHeld: false };

    // ---------------------------------------------------------------- controls
    const val = {};
    const slider = (key, label, unit, fmt, hint) => {
      const L = IST.View.LIMITS[key];
      const input = h('input', { type: 'range', min: L[0], max: L[1], step: 1, value: V[key], 'aria-label': label });
      val[key] = h('span', { class: 'view-val' });
      input.addEventListener('input', () => {
        V[key] = +input.value;
        commit();
      });
      return { input, row: h('label', { class: 'view-field' }, h('span', { class: 'field-l' }, label), val[key], input, hint ? h('span', { class: 'hint' }, hint) : null), fmt: fmt || ((v) => v + unit) };
    };
    const check = (key, label) => {
      const input = h('input', { type: 'checkbox', checked: V[key] });
      input.addEventListener('change', () => {
        V[key] = input.checked;
        commit();
      });
      return { input, row: h('label', { class: 'view-check' }, input, label) };
    };
    const select = (opts, cur, onChange) => {
      const el = h('select', null, opts.map((o) => h('option', { value: o[0], selected: String(o[0]) === String(cur) }, o[1])));
      el.addEventListener('input', () => onChange(el.value));
      return el;
    };
    const signed = (v, u) => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v) + u;

    const C = {
      cockpit: check('cockpit', 'Show cockpit'),
      wheel: check('wheel', 'Steering wheel'),
      fov: slider('fov', 'FOV', '°', null, 'Horizontal FOV on a 16:9 screen. Wider screens see more at the sides, taller ones more top and bottom.'),
      horizon: slider('horizon', 'Horizon', '%', null, 'Where the horizon sits, from the top of the screen.'),
      seatY: slider('seatY', 'Seat height', '', (v) => signed(v, ' cm')),
      seatZ: slider('seatZ', 'Seat fore / aft', '', (v) => signed(v, ' cm'), 'Forward brings the wheel, pillar and roof closer.'),
    };
    const body = select(Object.keys(IST.Cockpit.BODY).map((k) => [k, k[0].toUpperCase() + k.slice(1)]), V.body, (v) => {
      V.body = v;
      commit();
    });
    // the red line shows while the horizon slider is held and briefly after
    const hzIn = C.horizon.input;
    const hzShow = () => (pv.hzUntil = performance.now() + HZ_SHOW_MS);
    hzIn.addEventListener('input', hzShow);
    hzIn.addEventListener('pointerdown', () => ((pv.hzHeld = true), hzShow()));
    hzIn.addEventListener('focus', hzShow);
    window.addEventListener('pointerup', () => {
      if (pv.hzHeld) hzShow();
      pv.hzHeld = false;
    });

    const aspect = select([[16 / 9, '16:9'], [1.6, '16:10'], [21 / 9, '21:9'], [32 / 9, '32:9'], [4 / 3, '4:3']], pv.aspect, (v) => {
      pv.aspect = +v;
      sizeCanvas();
    });
    const theme = select([['realistic', 'Realistic'], ['minimal', 'Minimal']], pv.theme, (v) => {
      pv.theme = v;
      scene.R = new IST.TrackRenderer(scene.track, { theme: v });
      cockpit = null;
    });
    const maskEl = h('input', { type: 'checkbox' });
    maskEl.addEventListener('change', () => (pv.mask = maskEl.checked));
    const status = h('p', { class: 'view-status muted' });

    let cockpit = null;
    function commit() {
      IST.View.set(V);
      V = IST.View.get();
      cockpit = null; // rebuilt with the new paint / wheel next frame
      sync();
    }
    function sync() {
      for (const k of ['fov', 'horizon', 'seatY', 'seatZ']) {
        C[k].input.value = V[k];
        val[k].textContent = C[k].fmt(V[k]);
      }
      C.cockpit.input.checked = V.cockpit;
      C.wheel.input.checked = V.wheel;
      body.value = V.body;
      [C.wheel.row, body.parentNode].forEach((el) => el && el.classList.toggle('dim', !V.cockpit));
    }

    // ----------------------------------------------------------------- layout
    const cv = h('canvas', { class: 'view-canvas' });
    const wrap = h('div', { class: 'view-preview' }, cv);
    root.append(
      h('div', { class: 'res-head' },
        h('div', null, h('span', { class: 'tag' }, 'All in-car drills'), h('h1', null, 'View')),
        h('div', { class: 'view-head-actions' },
          h('button', { class: 'btn ghost', onclick: () => { IST.View.reset(); V = IST.View.get(); cockpit = null; sync(); } }, 'Reset to defaults'),
          h('button', { class: 'btn primary', onclick: close }, 'Done'))),
      h('div', { class: 'view-layout' },
        h('div', null, wrap,
          h('div', { class: 'view-preview-opts' },
            h('label', null, 'Preview screen ', aspect),
            h('label', null, 'Track style ', theme),
            h('label', { class: 'view-check' }, maskEl, 'Show blocked areas')),
          status),
        h('div', { class: 'view-panel' },
          h('h3', null, 'Cockpit'),
          C.cockpit.row, C.wheel.row,
          h('label', { class: 'view-field' }, h('span', { class: 'field-l' }, 'Paint'), body),
          h('h3', null, 'Camera'),
          C.fov.row, C.horizon.row,
          h('h3', null, 'Seat'),
          C.seatY.row, C.seatZ.row,
          h('p', { class: 'hint' }, 'Used by every in-car view: Apex Snap, Race Mode, Eyes Off the Wall, Two-Point and the Pick the Line and Class Traffic replays (each of the last three also has its own Cockpit toggle). Cockpit parts can hide an apex board, so flashes only start where the board is in clear view. Drill HUDs draw over the cockpit.')))
    );
    sync();
    IST.App.show('screen-view');

    // ------------------------------------------------------------------ scene
    const scene = {};
    function newTrack() {
      scene.track = IST.Track.generate({ rng: U.rng(U.randomSeed()), vmax: 250 / 3.6, minLength: 9000, leadIn: 60, minStraight: 14, maxStraight: 55, elevation: 'rolling', mix: 'technical', familiar: 'rare', aLat: 15, aBrake: 13, aAccel: 6, aero: 0.35 });
      scene.R = new IST.TrackRenderer(scene.track, { theme: pv.theme });
      scene.pos = 0;
      scene.heading = 0;
      scene.steer = 0;
    }
    newTrack();

    let W = 0, H = 0, dpr = 1;
    const g = cv.getContext('2d', { alpha: false });
    function sizeCanvas() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = Math.max(200, wrap.clientWidth);
      H = Math.round(Math.min(W / pv.aspect, window.innerHeight * 0.72));
      W = Math.round(Math.min(W, H * pv.aspect));
      cv.style.width = W + 'px';
      cv.style.height = H + 'px';
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    sizeCanvas();
    window.addEventListener('resize', sizeCanvas);

    let last = performance.now();
    function frame(ts) {
      const dt = Math.min(50, ts - last);
      last = ts;
      const t = scene.track, R = scene.R, HW = t.HALF_W;
      scene.pos += (t.speedAt(scene.pos) * dt) / 1000;
      scene.heading += t.curvatureAt(scene.pos) * (t.speedAt(scene.pos) * dt) / 1000;
      if (scene.pos > t.length - 400) newTrack();
      scene.steer += (IST.Cockpit.steerAt(scene.track, scene.pos) - scene.steer) * (1 - Math.exp(-dt / 70));
      const pos = scene.pos;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);

      const boards = [], sprites = [];
      const first = scene.track.nextCornerIndex(pos);
      for (let i = first; i >= 0 && i < Math.min(scene.track.corners.length, first + 2); i++) {
        const c = scene.track.corners[i], b = { c };
        boards.push(b);
        sprites.push({
          pos: c.apexPos, x: c.dir * HW * BOARD_KERB,
          draw: (g2, pr) => {
            const size = Math.max(14, BOARD_M * pr.s), cy = pr.y - size / 2;
            const fade = U.clamp((pr.dz - 4) / 8, 0, 1);
            if (fade <= 0) return;
            b.rect = [pr.x - size / 2, cy - size / 2, pr.x + size / 2, cy + size / 2];
            Sym.layer(g2, (1 - pr.fog * 0.55) * fade, pr.x, cy, size * 0.6, (L) => Sym.board(L, pr.x, cy, size, 'mask', R.theme));
          },
        });
      }
      IST.View.apply(R, W, H, V);
      R.render(g, W, H, { pos, x: scene.track.lateralAt(pos) * HW, heading: scene.heading, yaw: 0.6 * scene.track.lineYawAt(pos) }, sprites);

      if (V.cockpit) {
        if (!cockpit) cockpit = IST.View.cockpit(V, pv.theme);
        cockpit.frameFor(R, IST.View.seat(V));
        cockpit.draw(g, scene.steer, IST.Cockpit.dash(scene.track.speedAt(pos)));
        if (pv.mask) cockpit.drawMask(g);
      }

      // red line at the set horizon while it is being adjusted
      const now = performance.now();
      if (pv.hzHeld || now < pv.hzUntil) {
        const a = pv.hzHeld ? 1 : U.clamp((pv.hzUntil - now) / 400, 0, 1);
        const y = Math.round(H * R.horizonFrac) + 0.5;
        g.globalAlpha = a;
        g.strokeStyle = '#ff453a';
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(W, y);
        g.stroke();
        Sym.text(g, 'HORIZON ' + V.horizon + '%', W - 12, y - 8, { align: 'right', size: 12, weight: 800, color: '#ff453a' });
        g.globalAlpha = 1;
      }

      const b = boards[0];
      let txt = 'Field of view here: ' + Math.round(IST.View.fovFor(V, W, H)) + '° horizontal';
      if (b && b.rect && V.cockpit) {
        const cov = cockpit.coverage(b.rect[0], b.rect[1], b.rect[2], b.rect[3]);
        const hid = cov > HIDE_AT;
        if (pv.mask) {
          g.strokeStyle = hid ? '#f09ca6' : '#a6e3c4';
          g.lineWidth = 2;
          g.strokeRect(b.rect[0] - 3, b.rect[1] - 3, b.rect[2] - b.rect[0] + 6, b.rect[3] - b.rect[1] + 6);
        }
        txt += '  ·  next apex board ' + (hid ? 'blocked ' + Math.round(cov * 100) + '%' : 'in view');
      }
      status.textContent = txt;
      raf = requestAnimationFrame(frame);
    }
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);

    function close() {
      cancelAnimationFrame(raf);
      raf = 0;
      window.removeEventListener('resize', sizeCanvas);
      IST.App.exitToMenu();
    }
  }

  IST.ViewSettings = { open };
})();
