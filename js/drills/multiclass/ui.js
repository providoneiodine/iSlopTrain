/*
 * Class Traffic: canvas widgets in the main page's theme
 * (css/style.css): square slate blocks, 1 px border, hard offset shadow,
 * pastel meaning, caps labels. Stateless; button() records its hit box in
 * the buttons array it is given.
 */
(function () {
  'use strict';
  const Sym = IST.Symbols, MC = IST.Multiclass, COL = MC.COL;

  function wrapText(g, text, x, y, maxW, size, lh, color, maxLines, weight) {
    g.font = (weight || 520) + ' ' + size + 'px ' + Sym.FONT;
    const words = (text || '').split(' ');
    let line = '', n = 0;
    for (let i = 0; i < words.length; i++) {
      const t = line ? line + ' ' + words[i] : words[i];
      if (g.measureText(t).width > maxW && line) {
        Sym.text(g, line, x, y + n * lh, { size, weight: weight || 520, color, shadow: false });
        line = words[i];
        if (++n >= maxLines) return n;
      } else line = t;
    }
    if (line) Sym.text(g, line, x, y + n * lh, { size, weight: weight || 520, color, shadow: false });
    return n + 1;
  }

  function box(g, x, y, w, h, o) {
    o = o || {};
    const d = o.shadow == null ? 4 : o.shadow;
    if (d) {
      g.fillStyle = 'rgba(12,14,18,0.5)';
      g.fillRect(x + d, y + d, w, h);
    }
    g.fillStyle = o.fill || COL.panel;
    g.fillRect(x, y, w, h);
    g.lineWidth = 1;
    g.strokeStyle = o.line || COL.line;
    g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    if (o.accent) {
      g.fillStyle = o.accent;
      if (o.side) g.fillRect(x, y, o.side, h);
      else g.fillRect(x, y, w, o.accentH || 4);
    }
  }
  const spaced = (g, px) => {
    if ('letterSpacing' in g) g.letterSpacing = px + 'px';
  };
  /** Uppercase, letter-spaced label (the page's h2 / .tag type). Returns its width. */
  function caps(g, text, x, y, o) {
    o = o || {};
    const t = String(text).toUpperCase(), size = o.size || 10.5, weight = o.weight || 720;
    spaced(g, o.spacing == null ? size * 0.13 : o.spacing);
    g.font = weight + ' ' + size + 'px ' + Sym.FONT;
    const w = g.measureText(t).width;
    Sym.text(g, t, x, y, Object.assign({ size, weight, shadow: false }, o));
    spaced(g, 0);
    return w;
  }
  function capsWidth(g, text, size, weight) {
    spaced(g, size * 0.13);
    g.font = (weight || 720) + ' ' + size + 'px ' + Sym.FONT;
    const w = g.measureText(String(text).toUpperCase()).width;
    spaced(g, 0);
    return w;
  }

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

  /** Key-cap number: the key you'd press, raised when it's the one selected. */
  function keycap(g, n, x, y, s, on) {
    g.fillStyle = on ? '#b89a52' : '#2a2f37';
    g.fillRect(x, y + 3, s, s);
    g.fillStyle = on ? COL.quiz : COL.panel2;
    g.fillRect(x, y, s, s);
    g.strokeStyle = on ? COL.quiz : COL.lineStrong;
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
    Sym.text(g, String(n), x + s / 2, y + s / 2 + 1, { align: 'center', baseline: 'middle', size: Math.round(s * 0.52), weight: 820, color: on ? COL.ink : COL.text, shadow: false });
  }


  function button(g, buttons, x, y, label, act, o) {
    o = o || {};
    g.font = '720 13px ' + Sym.FONT;
    const w = Math.max(o.min || 0, g.measureText(label).width + 26), h = 30;
    const x0 = x - (o.right ? w : 0);
    box(g, x0, y, w, h, { fill: o.primary ? COL.peach : COL.panel2, line: o.primary ? COL.peach : COL.lineStrong, shadow: 2 });
    Sym.text(g, label, x0 + w / 2, y + h / 2 + 0.5, { align: 'center', baseline: 'middle', size: 13, weight: 720, color: o.primary ? COL.ink : COL.text, shadow: false });
    buttons.push({ x: x0, y, w, h, act });
    return w;
  }

  function countLines(g, text, maxW, size) {
    g.font = '420 ' + size + 'px ' + Sym.FONT;
    let line = '', n = 1;
    for (const word of (text || '').split(' ')) {
      const t = line ? line + ' ' + word : word;
      if (g.measureText(t).width > maxW && line) {
        n++;
        line = word;
      } else line = t;
    }
    return n;
  }

  MC.ui = { wrapText, box, caps, capsWidth, glyph, chipWidth, chip, keycap, button, countLines };
})();
