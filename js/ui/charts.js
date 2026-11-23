/*
 * Dependency-free SVG charts for the Stats page.
 *
 * Specs follow the project's data-viz rules: one series hue (pastel sky on
 * slate), 2px lines, >=8px markers with a 2px surface ring, hairline recessive
 * grid, bars <=24px with square data ends, text in text tokens (never the
 * series colour), selective labels, and a hover/focus tooltip on every chart.
 *
 * Each function draws into a container element using its current width, so
 * call it again after resizes.
 */
(function () {
  'use strict';
  const U = IST.util;
  const NS = 'http://www.w3.org/2000/svg';
  // Matches the slate/pastel tokens in css/style.css.
  const C = {
    series: '#9fcbef',
    seq: ['#3a414c', '#4b6582', '#5b7fa3', '#719bc4', '#88b5de', '#b2d4f2'], // 0 -> high, slate surface
    grid: '#444b57',
    text: '#eef0f4',
    text2: '#c9cfd9',
    muted: '#a1a9b7',
    surface: '#323842',
    barR: 0, // square bar ends, to match the blocky panels
  };

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function txt(parent, x, y, str, attrs) {
    const t = el('text', Object.assign({ x, y, fill: C.muted, 'font-size': 11, 'font-family': IST.Symbols.FONT }, attrs || {}), parent);
    t.textContent = str;
    return t;
  }

  function niceTicks(lo, hi, count) {
    const span = hi - lo || 1;
    const raw = span / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toFixed(10));
    return out;
  }

  /** One tooltip per chart box. Rows: [{value, label, key?:'line'|'dot'}] - values lead, labels follow. */
  function tooltip(box) {
    let tip = box.querySelector(':scope > .viz-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'viz-tip';
      tip.setAttribute('role', 'status');
      box.appendChild(tip);
    }
    return {
      show(x, y, title, rows) {
        tip.textContent = '';
        if (title) {
          const t = document.createElement('div');
          t.className = 'viz-tip-title';
          t.textContent = title;
          tip.appendChild(t);
        }
        for (const r of rows) {
          const row = document.createElement('div');
          row.className = 'viz-tip-row';
          if (r.key) {
            const k = document.createElement('span');
            k.className = 'viz-key viz-key-' + r.key;
            row.appendChild(k);
          }
          const v = document.createElement('b');
          v.textContent = r.value;
          row.appendChild(v);
          if (r.label) {
            const l = document.createElement('span');
            l.className = 'viz-tip-label';
            l.textContent = ' ' + r.label;
            row.appendChild(l);
          }
          tip.appendChild(row);
        }
        tip.style.display = 'block';
        const bw = box.clientWidth, tw = tip.offsetWidth;
        tip.style.left = U.clamp(x + 12, 4, Math.max(4, bw - tw - 4)) + 'px';
        tip.style.top = Math.max(0, y - tip.offsetHeight - 10) + 'px';
      },
      hide() {
        tip.style.display = 'none';
      },
    };
  }

  function start(box, height) {
    box.textContent = '';
    box.classList.add('viz');
    const W = Math.max(220, box.clientWidth || 560);
    const svg = el('svg', { width: W, height, viewBox: '0 0 ' + W + ' ' + height }, box);
    return { W, svg };
  }

  // ----------------------------------------------------------------- line
  /**
   * Session-by-session metric. Dots = individual sessions, line = rolling average
   * (same series, two marks). spec: { values, dates, fmt, fmtTick, better, pct,
   * height, avgWindow, compact, title, pb: {idx, value} }
   */
  function line(box, spec) {
    const H = spec.height || 200;
    const n = spec.values.length;
    const pts = spec.values.map((v, i) => ({ i, v })).filter((p) => U.isNum(p.v));
    if (!pts.length) {
      box.textContent = '';
      box.append(Object.assign(document.createElement('p'), { className: 'muted small', textContent: 'No data in this range.' }));
      return;
    }
    const { W, svg } = start(box, H);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', (spec.title || 'Metric') + ' over ' + n + ' sessions');
    svg.setAttribute('tabindex', '0');
    const avg = IST.Analysis.rolling(spec.values, spec.avgWindow || 5);
    const pad = { l: 46, r: spec.compact ? 12 : 70, t: 18, b: 24 };
    let lo = Math.min.apply(null, pts.map((p) => p.v)), hi = Math.max.apply(null, pts.map((p) => p.v));
    const dataLo = lo, dataHi = hi;
    if (lo === hi) {
      lo -= Math.abs(lo) * 0.1 || 1;
      hi += Math.abs(hi) * 0.1 || 1;
    }
    const span = hi - lo;
    lo -= span * 0.12;
    hi += span * 0.12;
    if (spec.pct) {
      // keep percentages inside 0-100% unless the data itself leaves it (e.g. a negative cost)
      lo = Math.max(Math.min(0, dataLo), lo);
      hi = Math.min(Math.max(1, dataHi), hi);
    }
    const ticks = niceTicks(lo, hi, spec.compact ? 2 : 4);
    lo = Math.min(lo, ticks[0]);
    hi = Math.max(hi, ticks[ticks.length - 1]);
    const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    const X = (i) => pad.l + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
    const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * ph;
    const fmtTick = spec.fmtTick || spec.fmt;

    for (const t of ticks) {
      el('line', { x1: pad.l, x2: W - pad.r, y1: Y(t), y2: Y(t), stroke: C.grid, 'stroke-width': 1 }, svg);
      txt(svg, pad.l - 8, Y(t) + 4, fmtTick(t), { 'text-anchor': 'end' });
    }
    if (spec.dates && n) {
      txt(svg, X(0), H - 6, IST.Analysis.shortDate(spec.dates[0]), { 'text-anchor': n === 1 ? 'middle' : 'start' });
      if (n > 1) txt(svg, X(n - 1), H - 6, IST.Analysis.shortDate(spec.dates[n - 1]), { 'text-anchor': 'end' });
    }

    // rolling average line
    let d = '';
    avg.forEach((v, i) => {
      if (U.isNum(v)) d += (d ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1);
    });
    if (pts.length > 1) el('path', { d, fill: 'none', stroke: C.series, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);

    // session dots
    const r = n > 60 ? 3 : 4;
    for (const p of pts) el('circle', { cx: X(p.i), cy: Y(p.v), r, fill: C.series, 'fill-opacity': 0.45, stroke: C.surface, 'stroke-width': 2 }, svg);

    // personal best (labelled) and end value
    const pb = spec.pb;
    if (pb && pb.idx >= 0 && pts.length > 1) {
      const px = X(pb.idx), py = Y(pb.value);
      el('circle', { cx: px, cy: py, r: 5.5, fill: C.series, stroke: C.surface, 'stroke-width': 2 }, svg);
      const above = py - pad.t > 16;
      txt(svg, U.clamp(px, pad.l + 20, W - pad.r - 20), above ? py - 10 : py + 18, 'PB ' + spec.fmt(pb.value), { 'text-anchor': 'middle', fill: C.text2, 'font-weight': 600 });
    }
    const lastAvgIdx = avg.length - 1 - [...avg].reverse().findIndex(U.isNum);
    if (!spec.compact && U.isNum(avg[lastAvgIdx])) {
      el('circle', { cx: X(lastAvgIdx), cy: Y(avg[lastAvgIdx]), r: 4, fill: C.series, stroke: C.surface, 'stroke-width': 2 }, svg);
      txt(svg, X(lastAvgIdx) + 9, Y(avg[lastAvgIdx]) + 4, spec.fmt(avg[lastAvgIdx]), { fill: C.text, 'font-weight': 700, 'font-size': 12 });
    }

    // hover / focus layer: crosshair snaps to the nearest session
    const cross = el('line', { y1: pad.t, y2: H - pad.b, stroke: C.muted, 'stroke-width': 1, visibility: 'hidden' }, svg);
    const ring = el('circle', { r: 6, fill: 'none', stroke: C.text, 'stroke-width': 2, visibility: 'hidden' }, svg);
    const hit = el('rect', { x: pad.l - 10, y: 0, width: pw + 20, height: H, fill: 'transparent' }, svg);
    const tip = tooltip(box);
    let cur = n - 1;
    const showAt = (i) => {
      cur = U.clamp(i, 0, n - 1);
      const v = spec.values[cur];
      cross.setAttribute('x1', X(cur));
      cross.setAttribute('x2', X(cur));
      cross.setAttribute('visibility', 'visible');
      if (U.isNum(v)) {
        ring.setAttribute('cx', X(cur));
        ring.setAttribute('cy', Y(v));
        ring.setAttribute('visibility', 'visible');
      } else ring.setAttribute('visibility', 'hidden');
      const rows = [{ value: U.isNum(v) ? spec.fmt(v) : '–', label: 'this session', key: 'dot' }];
      if (U.isNum(avg[cur])) rows.push({ value: spec.fmt(avg[cur]), label: (spec.avgWindow || 5) + '-session avg', key: 'line' });
      const title = 'Session ' + (cur + 1) + (spec.dates ? ' · ' + new Date(spec.dates[cur]).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
      tip.show(X(cur), U.isNum(v) ? Y(v) : pad.t, title, rows);
    };
    const hide = () => {
      cross.setAttribute('visibility', 'hidden');
      ring.setAttribute('visibility', 'hidden');
      tip.hide();
    };
    hit.addEventListener('pointermove', (e) => {
      const rect = svg.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * W;
      showAt(n === 1 ? 0 : Math.round(((x - pad.l) / pw) * (n - 1)));
    });
    hit.addEventListener('pointerleave', hide);
    svg.addEventListener('focus', () => showAt(cur));
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') showAt(cur - 1);
      else if (e.key === 'ArrowRight') showAt(cur + 1);
      else return;
      e.preventDefault();
    });
  }

  // ------------------------------------------------------------------ bars
  /** Horizontal bars. spec: { items: [{label, value, n, tag}], pct, fmt, minN?, nLabel? } */
  function bars(box, spec) {
    const items = spec.items.filter((i) => U.isNum(i.value));
    const minN = spec.minN || IST.Analysis.MIN_N, nLabel = spec.nLabel || 'targets';
    if (!items.length) {
      box.textContent = '';
      box.append(Object.assign(document.createElement('p'), { className: 'muted small', textContent: 'Not enough data yet.' }));
      return;
    }
    const rowH = 30, barH = 14;
    const H = items.length * rowH + 4;
    const { W, svg } = start(box, H);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', spec.title || 'Breakdown');
    const labelW = Math.min(190, Math.round(W * 0.42));
    const valW = 64;
    const bw = W - labelW - valW - 8;
    const max = spec.pct ? 1 : Math.max.apply(null, items.map((i) => i.value)) || 1;
    const fmt = spec.fmt || ((v) => (spec.pct ? Math.round(v * 100) + '%' : U.fmt(v, 0)));
    const tip = tooltip(box);
    // 50% reference hairline for percentage charts
    if (spec.pct) {
      const x = labelW + bw * 0.5;
      el('line', { x1: x, x2: x, y1: 0, y2: H, stroke: C.grid, 'stroke-width': 1 }, svg);
    }
    items.forEach((it, k) => {
      const y = k * rowH + (rowH - barH) / 2;
      const t = txt(svg, 0, y + barH - 2, it.label, { fill: it.tag ? C.text : C.text2, 'font-size': 12, 'font-weight': it.tag ? 720 : 420 });
      if (it.tag) {
        const ts = el('tspan', { fill: C.muted, 'font-weight': 400, 'font-size': 11 }, t);
        ts.textContent = '  ▼ ' + it.tag;
      }
      const w = Math.max(2, (it.value / max) * bw);
      const x0 = labelW, rr = Math.min(C.barR, w / 2);
      el('path', {
        d: 'M' + x0 + ' ' + y + 'h' + (w - rr) + 'a' + rr + ' ' + rr + ' 0 0 1 ' + rr + ' ' + rr + 'v' + (barH - 2 * rr) + 'a' + rr + ' ' + rr + ' 0 0 1 ' + -rr + ' ' + rr + 'h' + -(w - rr) + 'z',
        fill: C.series,
        'fill-opacity': it.n != null && it.n < minN ? 0.45 : 1,
      }, svg);
      txt(svg, x0 + w + 6, y + barH - 2, fmt(it.value), { fill: C.text, 'font-size': 12, 'font-weight': 600 });
      const hit = el('rect', { x: 0, y: k * rowH, width: W, height: rowH, fill: 'transparent' }, svg);
      hit.addEventListener('pointermove', () => {
        tip.show(x0 + w, y, it.label, [{ value: fmt(it.value), label: it.n != null ? 'from ' + it.n + ' ' + nLabel + (it.n < minN ? ' (too few to judge)' : '') : '' }]);
      });
      hit.addEventListener('pointerleave', () => tip.hide());
    });
  }

  // ------------------------------------------------------------- histogram
  /** Vertical columns over value bins. spec: { values, bin, unit } */
  function histogram(box, spec) {
    const v = spec.values.filter(U.isNum);
    if (!v.length) return;
    const bin = spec.bin || 20;
    const lo = Math.floor(Math.min.apply(null, v) / bin) * bin, hi = Math.ceil((Math.max.apply(null, v) + 1) / bin) * bin;
    const nb = Math.max(1, Math.round((hi - lo) / bin));
    const counts = new Array(nb).fill(0);
    for (const x of v) counts[Math.min(nb - 1, Math.floor((x - lo) / bin))]++;
    const H = 170, pad = { l: 30, r: 8, t: 14, b: 24 };
    const { W, svg } = start(box, H);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', spec.title || 'Distribution');
    const maxC = Math.max.apply(null, counts);
    const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    const slot = pw / nb, cw = Math.min(24, slot - 2);
    const ticks = niceTicks(0, maxC, 3);
    for (const t of ticks) {
      const y = pad.t + ph - (t / Math.max(maxC, ticks[ticks.length - 1])) * ph;
      el('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, stroke: C.grid, 'stroke-width': 1 }, svg);
      txt(svg, pad.l - 6, y + 4, String(t), { 'text-anchor': 'end' });
    }
    const top = Math.max(maxC, ticks[ticks.length - 1]);
    const tip = tooltip(box);
    const med = U.median(v);
    counts.forEach((c, i) => {
      const x = pad.l + i * slot + (slot - cw) / 2;
      const h = (c / top) * ph, y = pad.t + ph - h;
      if (c > 0) {
        const rr = Math.min(C.barR, h / 2, cw / 2);
        el('path', { d: 'M' + x + ' ' + (pad.t + ph) + 'v' + -(h - rr) + 'a' + rr + ' ' + rr + ' 0 0 1 ' + rr + ' ' + -rr + 'h' + (cw - 2 * rr) + 'a' + rr + ' ' + rr + ' 0 0 1 ' + rr + ' ' + rr + 'v' + (h - rr) + 'z', fill: C.series }, svg);
      }
      if (i % Math.ceil(nb / 6) === 0) txt(svg, x + cw / 2, H - 6, String(lo + i * bin), { 'text-anchor': 'middle' });
      const hit = el('rect', { x: pad.l + i * slot, y: pad.t, width: slot, height: ph, fill: 'transparent' }, svg);
      hit.addEventListener('pointermove', () => tip.show(x + cw / 2, y, (lo + i * bin) + '–' + (lo + (i + 1) * bin) + ' ' + (spec.unit || ''), [{ value: String(c), label: c === 1 ? 'start' : 'starts' }]));
      hit.addEventListener('pointerleave', () => tip.hide());
    });
    const mx = pad.l + ((med - lo) / (hi - lo)) * pw;
    el('line', { x1: mx, x2: mx, y1: pad.t - 4, y2: pad.t + ph, stroke: C.text2, 'stroke-width': 1 }, svg);
    txt(svg, U.clamp(mx, pad.l + 30, W - 40), pad.t - 4, 'median ' + Math.round(med) + ' ' + (spec.unit || ''), { 'text-anchor': 'middle', fill: C.text2 });
  }

  // ------------------------------------------------------------------ curve
  /**
   * Profile over positions (e.g. trials after an event) against a baseline.
   * spec: { labels, series: [{label, values, muted?}], baseline, baselineLabel, pct, fmt, height, title }
   * First series = current (series hue), muted series = comparison (recessive grey).
   */
  function curve(box, spec) {
    const series = spec.series.filter((s) => s.values.some(U.isNum));
    if (!series.length) {
      box.textContent = '';
      box.append(Object.assign(document.createElement('p'), { className: 'muted small', textContent: 'Not enough data yet.' }));
      return;
    }
    const H = spec.height || 210, n = spec.labels.length;
    const { W, svg } = start(box, H);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', spec.title || 'Curve');
    svg.setAttribute('tabindex', '0');
    const fmt = spec.fmt || ((v) => (spec.pct ? Math.round(v * 100) + '%' : U.fmt(v, 0)));
    const pad = { l: 46, r: 74, t: 30, b: 24 };
    const all = series.flatMap((s) => s.values.filter(U.isNum)).concat(U.isNum(spec.baseline) ? [spec.baseline] : []);
    let lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    const span = hi - lo || Math.abs(hi) * 0.2 || 0.1;
    lo -= span * 0.15;
    hi += span * 0.15;
    if (spec.pct) lo = Math.max(0, lo);
    const ticks = niceTicks(lo, hi, 4);
    lo = Math.min(lo, ticks[0]);
    hi = Math.max(hi, ticks[ticks.length - 1]);
    const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    const X = (i) => pad.l + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
    const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * ph;

    for (const t of ticks) {
      el('line', { x1: pad.l, x2: W - pad.r, y1: Y(t), y2: Y(t), stroke: C.grid, 'stroke-width': 1 }, svg);
      txt(svg, pad.l - 8, Y(t) + 4, fmt(t), { 'text-anchor': 'end' });
    }
    spec.labels.forEach((l, i) => txt(svg, X(i), H - 6, l, { 'text-anchor': 'middle' }));

    if (U.isNum(spec.baseline)) {
      const y = Y(spec.baseline);
      el('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, stroke: C.text2, 'stroke-width': 1, 'stroke-dasharray': '4 4' }, svg);
      txt(svg, W - pad.r + 6, y + 4, (spec.baselineLabel || 'baseline') + ' ' + fmt(spec.baseline), { fill: C.text2, 'font-size': 11 });
    }

    // legend
    let lx = pad.l;
    series.forEach((s) => {
      const col = s.muted ? C.muted : C.series;
      el('line', { x1: lx, x2: lx + 14, y1: 12, y2: 12, stroke: col, 'stroke-width': 2 }, svg);
      const t = txt(svg, lx + 19, 16, s.label, { fill: C.text2 });
      lx += 19 + (t.getComputedTextLength ? t.getComputedTextLength() : s.label.length * 6) + 16;
    });

    // muted series first so the current one sits on top
    series.slice().sort((a, b) => (b.muted ? 1 : 0) - (a.muted ? 1 : 0)).forEach((s) => {
      const col = s.muted ? C.muted : C.series;
      let d = '';
      s.values.forEach((v, i) => {
        if (U.isNum(v)) d += (d ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1);
      });
      el('path', { d, fill: 'none', stroke: col, 'stroke-width': 2, 'stroke-opacity': s.muted ? 0.7 : 1, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
      s.values.forEach((v, i) => {
        if (U.isNum(v)) el('circle', { cx: X(i), cy: Y(v), r: 4, fill: col, stroke: C.surface, 'stroke-width': 2 }, svg);
      });
    });

    const cross = el('line', { y1: pad.t, y2: H - pad.b, stroke: C.muted, 'stroke-width': 1, visibility: 'hidden' }, svg);
    const hit = el('rect', { x: pad.l - 10, y: 0, width: pw + 20, height: H, fill: 'transparent' }, svg);
    const tip = tooltip(box);
    let cur = 0;
    const showAt = (i) => {
      cur = U.clamp(i, 0, n - 1);
      cross.setAttribute('x1', X(cur));
      cross.setAttribute('x2', X(cur));
      cross.setAttribute('visibility', 'visible');
      const rows = series.map((s) => ({ value: U.isNum(s.values[cur]) ? fmt(s.values[cur]) : '–', label: s.label, key: s.muted ? 'dot' : 'line' }));
      if (U.isNum(spec.baseline)) rows.push({ value: fmt(spec.baseline), label: spec.baselineLabel || 'baseline' });
      const v0 = series[0].values[cur];
      tip.show(X(cur), U.isNum(v0) ? Y(v0) : pad.t, (spec.xTitle || 'Trial') + ' ' + spec.labels[cur], rows);
    };
    const hide = () => {
      cross.setAttribute('visibility', 'hidden');
      tip.hide();
    };
    hit.addEventListener('pointermove', (e) => {
      const rect = svg.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * W;
      showAt(n === 1 ? 0 : Math.round(((x - pad.l) / pw) * (n - 1)));
    });
    hit.addEventListener('pointerleave', hide);
    svg.addEventListener('focus', () => showAt(cur));
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') showAt(cur - 1);
      else if (e.key === 'ArrowRight') showAt(cur + 1);
      else return;
      e.preventDefault();
    });
  }

  // --------------------------------------------------------------- calendar
  /** Activity heatmap: last `weeks` weeks, Monday-first columns. spec: { counts: {dayKey: n}, weeks } */
  function calendar(box, spec) {
    const weeks = spec.weeks || 16, cell = 13, gap = 3, top = 16, left = 26;
    const H = top + 7 * (cell + gap) + 26;
    const { W, svg } = start(box, H);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Training activity, last ' + weeks + ' weeks');
    const tip = tooltip(box);
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const dow = (today.getDay() + 6) % 7; // Monday = 0
    const startDay = new Date(today);
    startDay.setDate(today.getDate() - dow - (weeks - 1) * 7);
    ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'].forEach((l, i) => l && txt(svg, 0, top + i * (cell + gap) + cell - 2, l, { 'font-size': 10 }));
    const level = (c) => (c <= 0 ? 0 : Math.min(5, c));
    let lastMonth = -1;
    for (let w = 0; w < weeks; w++) {
      for (let d = 0; d < 7; d++) {
        const day = new Date(startDay);
        day.setDate(startDay.getDate() + w * 7 + d);
        if (day > today) continue;
        const key = IST.Analysis.dayKey(day.getTime());
        const c = spec.counts[key] || 0;
        const x = left + w * (cell + gap), y = top + d * (cell + gap);
        if (d === 0 && day.getMonth() !== lastMonth) {
          lastMonth = day.getMonth();
          txt(svg, x, 10, day.toLocaleDateString(undefined, { month: 'short' }), { 'font-size': 10 });
        }
        const r = el('rect', { x, y, width: cell, height: cell, fill: C.seq[level(c)] }, svg);
        r.addEventListener('pointermove', () => tip.show(x + cell / 2, y, day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }), [{ value: String(c), label: c === 1 ? 'session' : 'sessions' }]));
        r.addEventListener('pointerleave', () => tip.hide());
      }
    }
    const ly = top + 7 * (cell + gap) + 8;
    txt(svg, left, ly + 10, 'Less', { 'font-size': 10 });
    C.seq.forEach((col, i) => el('rect', { x: left + 30 + i * (cell + gap), y: ly, width: cell, height: cell, fill: col }, svg));
    txt(svg, left + 30 + C.seq.length * (cell + gap) + 4, ly + 10, 'More', { 'font-size': 10 });
  }

  IST.Charts = { line, bars, histogram, curve, calendar, COLORS: C };
})();
