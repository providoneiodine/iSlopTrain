/*
 * Shared stimulus drawing: arrow targets, pattern masks, boards, flags,
 * noise masks and HUD text.
 *
 * The placeholder shown on a target board is a superimposition of all four
 * arrows. It shares every feature with the real target, so it works as a
 * backward pattern mask (Breitmeyer & Ögmen, 2006) and the target onset is
 * not a big luminance transient that could pull the eyes reflexively.
 */
(function () {
  'use strict';
  const S = {};
  S.DIRS = ['up', 'down', 'left', 'right'];
  S.FONT = "Allo, system-ui, 'Segoe UI', Roboto, sans-serif";

  const ARROW = [[0, -0.42], [0.38, 0.02], [0.15, 0.02], [0.15, 0.42], [-0.15, 0.42], [-0.15, 0.02], [-0.38, 0.02]];
  const ROT = { up: 0, right: Math.PI / 2, down: Math.PI, left: -Math.PI / 2 };

  S.roundRect = function (g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  };

  function arrowPath(g, cx, cy, size, dir) {
    const a = ROT[dir] || 0, c = Math.cos(a), s = Math.sin(a);
    for (let i = 0; i < ARROW.length; i++) {
      const x = ARROW[i][0], y = ARROW[i][1];
      const px = cx + (x * c - y * s) * size;
      const py = cy + (x * s + y * c) * size;
      if (i) g.lineTo(px, py);
      else g.moveTo(px, py);
    }
    g.closePath();
  }

  S.arrow = function (g, cx, cy, size, dir, color) {
    g.beginPath();
    arrowPath(g, cx, cy, size, dir);
    g.fillStyle = color;
    g.fill();
  };

  // one path, one fill: overlapping arrows don't stack up when drawn translucent
  S.mask = function (g, cx, cy, size, color) {
    g.beginPath();
    for (const d of S.DIRS) arrowPath(g, cx, cy, size, d);
    g.fillStyle = color;
    g.fill('nonzero');
  };

  /*
   * Draw fn() at full opacity into an offscreen layer, then composite it at `alpha`,
   * so a multi-part sign (fill, border, symbol) fades as one flat image instead of
   * each part blending separately. (cx, cy, half) bounds the drawing.
   */
  const LAYER_MAX = 2048; // px; a bigger sign is rendered at lower resolution, never cropped
  let layerCv = null;
  function renderLayer(g, cx, cy, half, fn) {
    const m = g.getTransform ? g.getTransform() : { a: 1 };
    const sc = Math.min(Math.max(0.5, Math.hypot(m.a, m.b || 0)), (LAYER_MAX - 4) / Math.max(1, 2 * half));
    const px = Math.ceil(2 * half * sc) + 4;
    if (!layerCv) layerCv = document.createElement('canvas');
    if (layerCv.width < px || layerCv.height < px) layerCv.width = layerCv.height = Math.max(px, layerCv.width);
    const L = layerCv.getContext('2d');
    L.setTransform(1, 0, 0, 1, 0, 0);
    L.clearRect(0, 0, px, px);
    L.globalAlpha = 1;
    L.setTransform(sc, 0, 0, sc, px / 2 - cx * sc, px / 2 - cy * sc);
    fn(L);
    return { cv: layerCv, px, sc };
  }
  S.layer = function (g, alpha, cx, cy, half, fn) {
    if (alpha >= 0.999) return fn(g);
    if (alpha <= 0.002) return;
    const { cv, px, sc } = renderLayer(g, cx, cy, half, fn);
    const prev = g.globalAlpha;
    g.globalAlpha = alpha;
    g.drawImage(cv, 0, 0, px, px, cx - px / 2 / sc, cy - px / 2 / sc, px / sc, px / sc);
    g.globalAlpha = prev;
  };

  /*
   * Trackside boards (apex boards, hazard boards, the View preview) fade out over
   * the last metres before you reach them and break apart as they go, so a board
   * never fills the view and passing one feels the same in every drill.
   *   S.BOARD_FADE      [start, gone] metres ahead
   *   S.boardFade(dz)   1 (whole) .. 0 (gone)
   *   S.trackBoard(g, pr, cx, cy, half, seed, fn)   draws fn() faded and broken; false if gone
   */
  S.BOARD_FADE = [12, 4];
  const BREAK_AT = 0.75; // fade level where the board starts to break
  const GRID = 3;
  S.boardFade = (dz) => Math.min(1, Math.max(0, (dz - S.BOARD_FADE[1]) / (S.BOARD_FADE[0] - S.BOARD_FADE[1])));
  const hash = (n) => {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  S.trackBoard = function (g, pr, cx, cy, half, seed, fn) {
    const fade = S.boardFade(pr.dz);
    if (fade <= 0) return false;
    const alpha = fade; // boards don't fog out with distance: a far one is small, it shouldn't be faint too
    const t = Math.min(1, Math.max(0, (BREAK_AT - fade) / BREAK_AT));
    const k = t * t * (3 - 2 * t);
    if (k <= 0) {
      S.layer(g, alpha, cx, cy, half, fn);
      return true;
    }
    // break: the board splits into a GRID x GRID of pieces that drift apart, drop and turn
    const { cv, px, sc } = renderLayer(g, cx, cy, half, fn);
    const cell = px / GRID, w = cell / sc, gap = 1 - 0.08 * k;
    const prev = g.globalAlpha;
    g.globalAlpha = alpha;
    for (let i = 0; i < GRID; i++) {
      for (let j = 0; j < GRID; j++) {
        const n = (seed || 0) * 13 + i * GRID + j;
        const dx = i - (GRID - 1) / 2, dy = j - (GRID - 1) / 2;
        const ox = k * half * (0.55 * dx + (hash(n) - 0.5) * 0.35);
        const oy = k * half * (0.45 * dy + (hash(n + 0.5) - 0.5) * 0.3) + k * k * half * 0.5;
        const rot = k * (hash(n + 0.25) - 0.5) * 0.9;
        g.save();
        g.translate(cx - px / 2 / sc + (i + 0.5) * w + ox, cy - px / 2 / sc + (j + 0.5) * w + oy);
        g.rotate(rot);
        g.drawImage(cv, i * cell, j * cell, cell, cell, (-w / 2) * gap, (-w / 2) * gap, w * gap, w * gap);
        g.restore();
      }
    }
    g.globalAlpha = prev;
    return true;
  };

  /*
   * A revealed arrow is drawn for reading: a bright colour on pure black, and larger
   * than the mask's arrows, so it fills the board. Same for apex and hazard boards.
   * The colour is the player's choice on the View screen (IST.View sets REVEAL.fg);
   * every option is at least 7:1 against the black board.
   */
  S.ARROW_COLORS = { purple: '#cc88ff', white: '#ffffff', yellow: '#ffe600', green: '#5cff8a', cyan: '#5ce1ff', orange: '#ff9d2e' };
  S.REVEAL = { bg: '#000000', fg: S.ARROW_COLORS.purple, grow: 1.16 };
  S.isDir = (content) => ROT[content] !== undefined;

  /** Square target board. content: 'mask' | 'blank' | 'up' | 'down' | 'left' | 'right' */
  S.board = function (g, cx, cy, size, content, th) {
    const half = size / 2, dir = S.isDir(content);
    S.roundRect(g, cx - half, cy - half, size, size, size * 0.14);
    g.fillStyle = dir ? S.REVEAL.bg : th.boardBg;
    g.fill();
    g.lineWidth = Math.max(1.5, size * 0.07);
    g.strokeStyle = th.boardBorder;
    g.stroke();
    const inner = size * 0.74;
    if (content === 'mask') S.mask(g, cx, cy, inner, th.boardFg);
    else if (dir) S.arrow(g, cx, cy, inner * S.REVEAL.grow, content, S.REVEAL.fg);
  };

  /** Marshal-style flag; (cx, cy) is the centre of the cloth. */
  S.flag = function (g, cx, cy, size, color) {
    const w = size, h = size * 0.7;
    const x0 = cx - w / 2, y0 = cy - h / 2;
    g.fillStyle = '#c9ced8';
    g.fillRect(x0 - Math.max(2, size * 0.08), y0, Math.max(2, size * 0.08), size * 1.6);
    g.fillStyle = color;
    g.fillRect(x0, y0, w, h);
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(0,0,0,.55)';
    g.strokeRect(x0, y0, w, h);
  };

  const NOISE = ['#f5c400', '#f2f2f2', '#7a7f8a', '#1a1c22', '#d9b000', '#c8ccd4', '#3a3e48'];
  S.noise = function (g, cx, cy, size, rnd) {
    const n = 6, c = size / n, x0 = cx - size / 2, y0 = cy - size / 2;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        g.fillStyle = NOISE[(rnd() * NOISE.length) | 0];
        g.fillRect(x0 + i * c, y0 + j * c, c + 0.5, c + 0.5);
      }
    }
  };

  S.text = function (g, str, x, y, o) {
    o = o || {};
    g.font = (o.weight || 620) + ' ' + (o.size || 16) + 'px ' + S.FONT;
    g.textAlign = o.align || 'left';
    g.textBaseline = o.baseline || 'alphabetic';
    g.globalAlpha = o.alpha == null ? 1 : o.alpha;
    if (o.shadow !== false) {
      g.fillStyle = 'rgba(0,0,0,.6)';
      g.fillText(str, x + 1, y + 1.5);
    }
    g.fillStyle = o.color || '#fff';
    g.fillText(str, x, y);
    g.globalAlpha = 1;
  };

  /** The session readout in a top corner (time left, trial count, speed): the same type in every drill. */
  S.hud = function (g, str, x, align) {
    S.text(g, str, x, 32, { size: 18, weight: 820, align: align || 'left', alpha: 0.85 });
  };

  S.ring = function (g, cx, cy, r, color, width) {
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.lineWidth = width || 3;
    g.strokeStyle = color;
    g.stroke();
  };

  IST.Symbols = S;
})();
