/*
 * Corner numbers for known circuits, from Lovely Track Data (github.com/Lovely-Sim-Racing/lovely-track-data),
 * read from the site's own copy in data/tracks/lovely/ when it has one (scripts/bundle-tracks.js --corners), else
 * fetched from GitHub with the Map option, and cached in localStorage. Without a match the map keeps
 * the app's own corners found from braking zones (compare.js).
 *
 *   IST.Review.Corners.lookup({ id, name, len }) -> Promise<[{ start, end, name }] | null>   by iRacing TrackName ('spa 2024 combined'),
 *                                      else by the track's shown name, checked against the lap's length
 *   IST.Review.Corners.label(turns)    -> [label or null]   official numbers where the name has one
 *   IST.Review.Corners.place(cmp, turns) -> [{ apex, a, b, dir, label, name, official }]  on the reference grid
 *   IST.Review.Corners.nameSpan(cmp, a, b) -> 'T5' | 'T5–7' | null   the numbered corners in a stretch
 *
 * The data gives each corner as a share of the lap, and names it ('Turn 5', 'T5' or 'Eau Rouge').
 * Numbers in names are used as they are; a named corner between two numbered ones gets the
 * numbers that fit; a file with no numbers at all is numbered in order, which may not be official.
 */
(function () {
  'use strict';
  IST.Review = IST.Review || {};
  const BASE = 'https://raw.githubusercontent.com/Lovely-Sim-Racing/lovely-track-data/main/data/', LOCAL = 'data/tracks/lovely/';
  const KEY = 'isloptrain.review.corners', MAX = 40, DAYS = 30, MISS_DAYS = 7;

  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || {};
    } catch (e) {
      return {};
    }
  };
  function write(c) {
    try {
      const ids = Object.keys(c.tracks || {}).sort((a, b) => c.tracks[b].t - c.tracks[a].t);
      ids.slice(MAX).forEach((k) => delete c.tracks[k]);
      localStorage.setItem(KEY, JSON.stringify(c));
    } catch (e) {
      /* full or blocked: just don't cache */
    }
  }
  const fresh = (e, days) => e && Date.now() - e.t < days * 86400000;
  // the data's own file-name rule: lower case, plain letters, anything else a single hyphen
  const clean = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  async function get(url) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl && setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(url, { signal: ctl && ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // words that say nothing about which circuit or layout it is
  const FILLER = new Set(['circuit', 'circuito', 'de', 'du', 'des', 'di', 'del', 'la', 'le', 'the', 'of', 'and', 'autodromo', 'internazionale', 'nazionale', 'internacional', 'racing']);
  const words = (s) => clean(s).split('-').filter((w) => w && !FILLER.has(w));
  /** Share of a candidate's words found in the query, so 'Spa Grand Prix Pits' fits 'Circuit de Spa-Francorchamps Grand Prix Pits'. */
  function score(q, name) {
    const Q = new Set(words(q)), C = words(name);
    if (!C.length || !Q.has(C[0])) return 0; // the circuit's own name has to match, not just 'Full Course'
    const hit = C.filter((w) => Q.has(w)).length;
    return C.length ? hit / C.length + hit * 0.01 : 0;
  }

  async function turnsOf(base, path) {
    let d;
    try {
      d = await get(base + path);
    } catch (e) {
      if (base === BASE) throw e;
      d = await get(BASE + path);
    }
    const turns = (d.turn || []).filter((t) => isFinite(t.start) && isFinite(t.end)).map((t) => ({ start: +t.start, end: +t.end, name: String(t.name || '') }));
    return { turns: turns.length ? turns : null, len: +d.length || 0 };
  }

  /**
   * q: { id (iRacing TrackName, exact), name (track and layout as shown, e.g. a Garage 61 file's), len (lap metres) }.
   * By name, the best-fitting layouts are fetched and the one closest to the lap's length kept.
   */
  async function lookup(q) {
    if (typeof q === 'string') q = { id: q };
    const id = clean(q.id), key = id || (q.name ? 'name:' + clean(q.name) : '');
    if (!key) return null;
    const c = read();
    c.tracks = c.tracks || {};
    const hit = c.tracks[key];
    if (fresh(hit, hit && hit.turns ? DAYS : MISS_DAYS)) return hit.turns;
    if (!fresh(c.manifest, DAYS) || !c.manifest.base || !c.manifest.ir[0] || c.manifest.ir[0].length < 3) {
      let base = LOCAL, m;
      try {
        m = await get(LOCAL + 'manifest.json');
      } catch (e) {
        (base = BASE), (m = await get(BASE + 'manifest.json'));
      }
      c.manifest = { t: Date.now(), base, ir: ((m.tracks && m.tracks.iracing) || []).map((x) => [clean(x.trackId), x.path, String(x.trackName || '')]) };
    }
    let turns = null;
    const row = id && c.manifest.ir.find((x) => x[0] === id);
    if (row) turns = (await turnsOf(c.manifest.base, row[1])).turns;
    else if (q.name) {
      const ranked = c.manifest.ir.map((x) => ({ x, s: score(q.name, x[2]) })).filter((r) => r.s >= 0.6).sort((a, b) => b.s - a.s);
      const top = ranked.filter((r) => r.s >= ranked[0].s - 0.15).slice(0, 3);
      let best = null;
      for (const r of top) {
        const d = await turnsOf(c.manifest.base, r.x[1]);
        if (!d.turns) continue;
        const off = q.len && d.len ? Math.abs(d.len - q.len) / q.len : 0;
        if (off > 0.04) continue; // a different layout of the same circuit
        const rank = r.s - off * 5;
        if (!best || rank > best.rank) best = { rank, turns: d.turns };
      }
      turns = best && best.turns;
    }
    c.tracks[key] = { t: Date.now(), turns };
    write(c);
    return turns;
  }

  const NUMBERED = /^\s*(?:turns?|t)\s*(\d+)\b/i;
  function label(turns) {
    const num = turns.map((t) => {
      const m = NUMBERED.exec(t.name);
      return m ? +m[1] : null;
    });
    if (num.every((x) => x == null)) return turns.map((t, i) => String(i + 1));
    const out = num.slice();
    for (let i = 0; i < out.length; i++) {
      if (out[i] != null) continue;
      let j = i;
      while (j < out.length && num[j] == null) j++;
      const lo = i ? out[i - 1] : null, hi = j < out.length ? num[j] : null, gap = j - i;
      // numbers that fit between the neighbours, else none rather than a wrong one
      for (let k = 0; k < gap; k++) {
        if (lo != null && (hi == null || hi - lo - 1 >= gap)) out[i + k] = lo + 1 + k;
        else if (lo == null && hi != null && hi - 1 >= gap) out[i + k] = hi - gap + k;
      }
      i = j - 1;
    }
    return out.map((x) => (x == null ? null : String(x)));
  }

  function place(cmp, turns) {
    const R = cmp.laps[0], n = cmp.n, L = label(turns);
    const head = (i) => {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      return Math.atan2(R.y[b] - R.y[a], R.x[b] - R.x[a]);
    };
    return turns.map((t, k) => {
      const a = Math.max(0, Math.min(n - 1, Math.round(t.start * (n - 1))));
      const b = Math.max(a, Math.min(n - 1, Math.round(t.end * (n - 1))));
      let apex = Math.round((a + b) / 2);
      if (R.speed) for (let i = a; i <= b; i++) if (R.speed[i] < R.speed[apex]) apex = i;
      const dh = head(b) - head(a);
      // official: the number is in the data; name: a real name, not just 'Turn 5'
      const official = NUMBERED.test(t.name), name = official && /^\s*(?:turns?|t)\s*\d+\s*$/i.test(t.name) ? '' : t.name.trim();
      return { apex, a, b, dir: Math.sin(dh) >= 0 ? 1 : -1, label: L[k], name, official };
    }).filter((c) => c.label);
  }

  function nameSpan(cmp, a, b) {
    const T = cmp.turns;
    if (!T || !T.length) return null;
    let inside = T.filter((c) => c.apex >= a && c.apex <= b);
    if (!inside.length) {
      // a stretch the data has no corner in: the nearest one names it
      const mid = (a + b) / 2;
      inside = [T.reduce((p, c) => (Math.abs(c.apex - mid) < Math.abs(p.apex - mid) ? c : p))];
    }
    const f = inside[0].label, l = inside[inside.length - 1].label;
    return f === l ? 'T' + f : 'T' + f + '–' + l;
  }

  IST.Review.Corners = { lookup, label, place, nameSpan, clean, score };
})();
