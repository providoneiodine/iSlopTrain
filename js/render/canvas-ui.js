/*
 * The app's palette, and canvas widgets in the main page's style
 * (css/style.css): square slate blocks, 1 px border, hard offset shadow,
 * pastel meaning, caps labels.
 *
 *   IST.Theme      colours; the slate and pastel values mirror css/style.css :root
 *   IST.CanvasUI   backdrop, wrapText, countLines, box, pane, caps, capsWidth, keycap, button, hit
 *
 * The widgets are stateless. button() records its hit box in the array it is
 * given; hit() finds the box under a point. Drills that draw their own
 * screens (Draw the Line, Class Traffic) build them from these, so a canvas
 * screen looks like the page it sits in.
 */
(function () {
  'use strict';
  const Sym = IST.Symbols;

  const Theme = {
    // slate: structure
    bg: '#272c34', deep: '#1f232a', panel: '#323842', panel2: '#3c434f', line: '#4a525f', lineStrong: '#5d6675',
    text: '#eef0f4', text2: '#c9cfd9', dim: '#a1a9b7', ink: '#1f232a', // ink: dark text on pastel fills
    // pastels: meaning
    peach: '#f5b09a', butter: '#f6d98f', mint: '#a6e3c4', sky: '#9fcbef', lilac: '#c4b4ef', rose: '#f09ca6',
    shadow: 'rgba(12,14,18,0.5)',
    // Signals over the in-car view and the dark drill stages: saturated, so right / wrong
    // reads at a glance in the periphery. gold marks records, bonuses and the selection.
    hit: '#30d158', miss: '#ff453a', gold: '#f6d98f',
  };

  /** Break text into the lines that fit maxW at this size and weight. */
  function lines(g, text, maxW, size, weight) {
    g.font = weight + ' ' + size + 'px ' + Sym.FONT;
    const out = [];
    let line = '';
    for (const word of (text || '').split(' ')) {
      const t = line ? line + ' ' + word : word;
      if (line && g.measureText(t).width > maxW) {
        out.push(line);
        line = word;
      } else line = t;
    }
    if (line) out.push(line);
    return out;
  }

  /** Word-wrapped text, at most maxLines of it; returns the number of lines drawn. */
  function wrapText(g, text, x, y, maxW, size, lh, color, maxLines, weight) {
    weight = weight || 520;
    const ls = lines(g, text, maxW, size, weight).slice(0, maxLines == null ? Infinity : maxLines);
    ls.forEach((l, n) => Sym.text(g, l, x, y + n * lh, { size, weight, color, shadow: false }));
    return ls.length;
  }
  /** Lines the text needs at this width (at least 1), to size a box before drawing it. */
  const countLines = (g, text, maxW, size, weight) => Math.max(1, lines(g, text, maxW, size, weight || 420).length);

  /**
   * A block: fill, 1 px border, hard offset shadow.
   * o: { fill, line, shadow (px, 0 for none), accent (colour of a top bar, or a left bar `side` px wide) }
   */
  function box(g, x, y, w, h, o) {
    o = o || {};
    const d = o.shadow == null ? 4 : o.shadow;
    if (d) {
      g.fillStyle = Theme.shadow;
      g.fillRect(x + d, y + d, w, h);
    }
    g.fillStyle = o.fill || Theme.panel;
    g.fillRect(x, y, w, h);
    g.lineWidth = 1;
    g.strokeStyle = o.line || Theme.line;
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

  /** Key-cap number: the key you'd press, raised when it's the one selected. */
  function keycap(g, n, x, y, s, on) {
    g.fillStyle = on ? '#b89a52' : '#2a2f37';
    g.fillRect(x, y + 3, s, s);
    g.fillStyle = on ? Theme.gold : Theme.panel2;
    g.fillRect(x, y, s, s);
    g.strokeStyle = on ? Theme.gold : Theme.lineStrong;
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
    Sym.text(g, String(n), x + s / 2, y + s / 2 + 1, { align: 'center', baseline: 'middle', size: Math.round(s * 0.52), weight: 820, color: on ? Theme.ink : Theme.text, shadow: false });
  }

  /**
   * A page-style button, 30 px tall. Returns its width.
   * o: { primary, right (x is its right edge), min (width), disabled (drawn dim, not clickable) }
   */
  function button(g, buttons, x, y, label, act, o) {
    o = o || {};
    g.font = '720 13px ' + Sym.FONT;
    const w = Math.max(o.min || 0, g.measureText(label).width + 26), h = 30;
    const x0 = x - (o.right ? w : 0);
    const primary = o.primary && !o.disabled;
    box(g, x0, y, w, h, { fill: primary ? Theme.peach : Theme.panel2, line: primary ? Theme.peach : Theme.lineStrong, shadow: o.disabled ? 0 : 2 });
    Sym.text(g, label, x0 + w / 2, y + h / 2 + 0.5, { align: 'center', baseline: 'middle', size: 13, weight: 720, color: primary ? Theme.ink : o.disabled ? Theme.dim : Theme.text, shadow: false });
    if (!o.disabled) buttons.push({ x: x0, y, w, h, act });
    return w;
  }

  /** A box with its inside clipped for what is drawn next. Saves the context: g.restore() when done. */
  function pane(g, x, y, w, h, o) {
    box(g, x, y, w, h, o);
    g.save();
    g.beginPath();
    g.rect(x + 1, y + 1, w - 2, h - 2);
    g.clip();
  }

  /** A drill screen's background: the page's slate with its faint 32 px blueprint grid. */
  function backdrop(g, W, H) {
    g.fillStyle = Theme.bg;
    g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,0.025)';
    for (let x = 0; x < W; x += 32) g.fillRect(x, 0, 1, H);
    for (let y = 0; y < H; y += 32) g.fillRect(0, y, W, 1);
  }

  /** The hit box under (x, y), if any. */
  const hit = (buttons, x, y) => buttons.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);

  IST.Theme = Theme;
  IST.CanvasUI = { backdrop, wrapText, countLines, box, pane, caps, capsWidth, keycap, button, hit };
})();
