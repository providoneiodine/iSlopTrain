/*
 * Draw the Line: canvas widgets. Stateless; button() records its hit
 * box in the buttons array it is given.
 */
(function () {
  'use strict';
  const Sym = IST.Symbols, RL = IST.RacingLine, COL = RL.COL;

  function button(g, buttons, x, y, label, act, o) {
    o = o || {};
    g.font = '820 13px ' + Sym.FONT;
    const w = Math.max(o.min || 0, g.measureText(label).width + 22), h = 28;
    const bx = x - (o.right ? w : 0);
    Sym.roundRect(g, bx, y, w, h, 7);
    g.fillStyle = o.primary ? (o.disabled ? 'rgba(246,217,143,0.25)' : COL.quiz) : 'rgba(255,255,255,0.1)';
    g.fill();
    Sym.text(g, label, bx + w / 2, y + h / 2 + 0.5, { align: 'center', baseline: 'middle', size: 13, weight: 820, color: o.primary ? '#141a16' : COL.text, shadow: false });
    if (!o.disabled) buttons.push({ x: bx, y, w, h, act });
    return w;
  }

  function panel(g, x, y, w, h, fill) {
    Sym.roundRect(g, x, y, w, h, 10);
    g.fillStyle = fill || COL.panel;
    g.fill();
  }
  function outline(g, x, y, w, h, color) {
    Sym.roundRect(g, x, y, w, h, 10);
    g.lineWidth = 1;
    g.strokeStyle = color || 'rgba(255,255,255,0.12)';
    g.stroke();
  }

  /** Word-wrapped text; returns the number of lines drawn. */
  function wrapText(g, text, x, y, maxW, size, lh, color, maxLines) {
    g.font = '500 ' + size + 'px ' + Sym.FONT;
    const words = (text || '').split(' ');
    let line = '', n = 0;
    for (let i = 0; i < words.length; i++) {
      const t = line ? line + ' ' + words[i] : words[i];
      if (g.measureText(t).width > maxW && line) {
        Sym.text(g, line, x, y + n * lh, { size, weight: 520, color, shadow: false });
        line = words[i];
        if (++n >= maxLines) return n;
      } else line = t;
    }
    if (line) {
      Sym.text(g, line, x, y + n * lh, { size, weight: 520, color, shadow: false });
      n++;
    }
    return n;
  }

  RL.ui = { button, panel, outline, wrapText };
})();
