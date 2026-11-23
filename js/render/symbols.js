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
  let layerCv = null;
  S.layer = function (g, alpha, cx, cy, half, fn) {
    if (alpha >= 0.999) return fn(g);
    if (alpha <= 0.002) return;
    const m = g.getTransform ? g.getTransform() : { a: 1 };
    const sc = Math.max(0.5, Math.hypot(m.a, m.b || 0));
    const px = Math.min(2048, Math.ceil(2 * half * sc) + 4);
    if (!layerCv) layerCv = document.createElement('canvas');
    if (layerCv.width < px || layerCv.height < px) layerCv.width = layerCv.height = Math.max(px, layerCv.width);
    const L = layerCv.getContext('2d');
    L.setTransform(1, 0, 0, 1, 0, 0);
    L.clearRect(0, 0, px, px);
    L.globalAlpha = 1;
    L.setTransform(sc, 0, 0, sc, px / 2 - cx * sc, px / 2 - cy * sc);
    fn(L);
    const prev = g.globalAlpha;
    g.globalAlpha = alpha;
    g.drawImage(layerCv, 0, 0, px, px, cx - px / 2 / sc, cy - px / 2 / sc, px / sc, px / sc);
    g.globalAlpha = prev;
  };

  /** Square target board. content: 'mask' | 'blank' | 'up' | 'down' | 'left' | 'right' */
  S.board = function (g, cx, cy, size, content, th) {
    const half = size / 2;
    S.roundRect(g, cx - half, cy - half, size, size, size * 0.14);
    g.fillStyle = th.boardBg;
    g.fill();
    g.lineWidth = Math.max(1.5, size * 0.07);
    g.strokeStyle = th.boardBorder;
    g.stroke();
    const inner = size * 0.74;
    if (content === 'mask') S.mask(g, cx, cy, inner, th.boardFg);
    else if (ROT[content] !== undefined) S.arrow(g, cx, cy, inner, content, th.boardFg);
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
    g.font = (o.weight || 600) + ' ' + (o.size || 16) + 'px ' + S.FONT;
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

  S.ring = function (g, cx, cy, r, color, width) {
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.lineWidth = width || 3;
    g.strokeStyle = color;
    g.stroke();
  };

  IST.Symbols = S;
})();
