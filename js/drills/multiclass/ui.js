/*
 * Class Traffic: the widgets only this drill uses, on top of the shared
 * ones (IST.CanvasUI): the verdict glyphs and the livery chip that carries
 * them. MC.ui is the shared set plus these.
 */
(function () {
  'use strict';
  const UI = IST.CanvasUI, MC = IST.Multiclass, COL = MC.COL;
  const { caps, capsWidth } = UI;

  /** Small line icons drawn in the chip's ink cell, one per verdict (and role). */
  function glyph(g, kind, cx, cy, r, color) {
    g.save();
    g.strokeStyle = color;
    g.fillStyle = color;
    g.lineWidth = Math.max(1.4, r * 0.32);
    g.lineCap = 'square';
    g.lineJoin = 'miter';
    g.beginPath();
    if (kind === 'ok') {
      g.moveTo(cx - r * 0.85, cy);
      g.lineTo(cx - r * 0.2, cy + r * 0.65);
      g.lineTo(cx + r * 0.9, cy - r * 0.7);
      g.stroke();
    } else if (kind === 'near') {
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.moveTo(cx - r * 0.5, cy);
      g.lineTo(cx - r * 0.1, cy + r * 0.4);
      g.lineTo(cx + r * 0.55, cy - r * 0.4);
      g.stroke();
    } else if (kind === 'contact') {
      // impact burst
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2, rr = k % 2 ? r * 0.5 : r;
        const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
        if (k) g.lineTo(px, py);
        else g.moveTo(px, py);
      }
      g.closePath();
      g.fill();
    } else if (kind === 'squeeze') {
      // two arrows closing in
      g.moveTo(cx - r, cy - r * 0.6);
      g.lineTo(cx - r * 0.2, cy);
      g.lineTo(cx - r, cy + r * 0.6);
      g.moveTo(cx + r, cy - r * 0.6);
      g.lineTo(cx + r * 0.2, cy);
      g.lineTo(cx + r, cy + r * 0.6);
      g.stroke();
    } else if (kind === 'cut') {
      // swerve across a lane line
      g.moveTo(cx - r, cy + r * 0.8);
      g.lineTo(cx - r * 0.2, cy + r * 0.8);
      g.lineTo(cx + r * 0.3, cy - r * 0.8);
      g.lineTo(cx + r, cy - r * 0.8);
      g.stroke();
    } else if (kind === 'hard') {
      // brake disc
      g.arc(cx, cy, r * 0.85, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.arc(cx, cy, r * 0.25, 0, Math.PI * 2);
      g.fill();
    } else if (kind === 'offline') {
      // weave: no telling which way
      g.moveTo(cx - r, cy);
      g.bezierCurveTo(cx - r * 0.5, cy - r * 1.1, cx - r * 0.1, cy - r * 1.1, cx, cy);
      g.bezierCurveTo(cx + r * 0.1, cy + r * 1.1, cx + r * 0.5, cy + r * 1.1, cx + r, cy);
      g.stroke();
    } else if (kind === 'illegal') {
      g.arc(cx, cy, r * 0.85, 0, Math.PI * 2);
      g.moveTo(cx - r * 0.6, cy + r * 0.6);
      g.lineTo(cx + r * 0.6, cy - r * 0.6);
      g.stroke();
    } else if (kind === 'held') {
      // hourglass
      g.moveTo(cx - r * 0.7, cy - r);
      g.lineTo(cx + r * 0.7, cy - r);
      g.lineTo(cx - r * 0.7, cy + r);
      g.lineTo(cx + r * 0.7, cy + r);
      g.closePath();
      g.fill();
    } else if (kind === 'slower') {
      // stopwatch
      g.arc(cx, cy + r * 0.15, r * 0.78, 0, Math.PI * 2);
      g.moveTo(cx, cy + r * 0.15);
      g.lineTo(cx + r * 0.4, cy - r * 0.25);
      g.moveTo(cx - r * 0.25, cy - r);
      g.lineTo(cx + r * 0.25, cy - r);
      g.stroke();
    } else if (kind === 'fast' || kind === 'slow') {
      // chevrons: two for the faster class, one for the slower
      const n = kind === 'fast' ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const ox = (k - (n - 1) / 2) * r * 0.75;
        g.moveTo(cx + ox - r * 0.35, cy - r * 0.75);
        g.lineTo(cx + ox + r * 0.35, cy);
        g.lineTo(cx + ox - r * 0.35, cy + r * 0.75);
      }
      g.stroke();
    }
    g.restore();
  }

  function chipWidth(g, text, size) {
    const h = Math.round(size + 11), sk = Math.round(h * 0.34);
    return sk + h + 2 + capsWidth(g, text, size) + 12 + sk * 0.6;
  }

  /**
   * Livery chip: a slanted pastel plate with a hard shadow and an ink cell carrying
   * the icon, like a class number panel on a car. Returns its width.
   */
  function chip(g, kind, text, x, y, color, o) {
    o = o || {};
    const size = o.size || 10.5, h = Math.round(size + 11), sk = Math.round(h * 0.34), cell = h + 2;
    const w = chipWidth(g, text, size);
    const x0 = o.right ? x - w : x;
    const plate = (x1, x2) => {
      g.beginPath();
      g.moveTo(x1 + sk, y);
      g.lineTo(x2, y);
      g.lineTo(x2 - sk, y + h);
      g.lineTo(x1, y + h);
      g.closePath();
    };
    g.save();
    g.translate(2, 2);
    plate(x0, x0 + w);
    g.fillStyle = 'rgba(12,14,18,0.55)';
    g.fill();
    g.restore();
    plate(x0, x0 + w);
    g.fillStyle = color;
    g.fill();
    plate(x0, x0 + sk + cell);
    g.fillStyle = COL.ink;
    g.fill();
    glyph(g, kind, x0 + sk * 0.5 + cell / 2, y + h / 2, h * 0.27, color);
    caps(g, text, x0 + sk + cell + 6, y + h / 2 + 0.5, { size, color: COL.ink, baseline: 'middle' });
    return w;
  }

  MC.ui = Object.assign({}, UI, { glyph, chipWidth, chip });
})();
