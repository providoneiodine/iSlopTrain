/* Small math / stats / DOM helpers shared by every module. */
(function () {
  'use strict';
  const U = {};

  U.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  U.lerp = (a, b, t) => a + (b - a) * t;
  U.smooth = (t) => t * t * (3 - 2 * t);

  /** Seeded PRNG (mulberry32) so tracks can be reproduced from a seed. */
  U.rng = function (seed) {
    let a = seed >>> 0 || 0x9e3779b9;
    const r = function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    r.range = (lo, hi) => lo + (hi - lo) * r();
    r.int = (lo, hi) => lo + Math.floor((hi - lo + 1) * r());
    r.pick = (arr) => arr[Math.floor(r() * arr.length)];
    return r;
  };
  U.randomSeed = () => 1 + Math.floor(Math.random() * 999998);

  U.mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
  U.median = (a) => {
    if (!a.length) return NaN;
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  U.sd = (a) => {
    if (a.length < 2) return NaN;
    const m = U.mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1));
  };
  U.geomean = (a) => (a.length ? Math.exp(U.mean(a.map(Math.log))) : NaN);

  U.mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  U.rgb = (c, alpha) =>
    alpha == null
      ? 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')'
      : 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + alpha + ')';

  U.isNum = (v) => typeof v === 'number' && isFinite(v);
  U.fmt = (v, digits) => (U.isNum(v) ? Number(v).toFixed(digits || 0) : '–');
  U.fmtTime = (sec) => {
    sec = Math.max(0, Math.ceil(sec));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  };

  /** Tiny hyperscript DOM builder: h('div', {class:'x', onclick: fn}, 'text', child) */
  U.h = function (tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    const kids = Array.prototype.slice.call(arguments, 2).flat(Infinity);
    for (const kid of kids) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : String(kid));
    }
    return el;
  };

  IST.util = U;
})();
