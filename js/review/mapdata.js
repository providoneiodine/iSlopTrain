/*
 * Map data for the Review viewer: the track's outline from OpenStreetMap and
 * satellite tiles from Esri World Imagery. The only part of the viewer that
 * touches the network, and only when the Map option is on. What's sent is
 * where the track is (a point and radius, or the track's name); telemetry
 * never leaves the browser.
 *
 *   IST.Review.MapData.lookup(q) -> Promise<{ geo, lines, halfWidth, how } | null>
 *     q: { origin ({ lat, lon } of the session frame, GPS laps), track (name),
 *          x, y (the reference lap, session metres) }
 *     GPS laps: raceways around the lap, the lap nudged onto them (Track.align)
 *     to undo the sim's GPS offset; null if the lap doesn't follow any raceway
 *     (the spot isn't a circuit on the map). Laps in a sim's own coordinates: the
 *     track name is looked up (Nominatim), raceways fetched round each hit,
 *     and the lap fitted onto them (Track.fit) to find where it is.
 *     geo: Track.geo for the session frame; lines: raceway centrelines in
 *     session metres (pit lanes and areas left out); shift: metres the laps
 *     were moved to meet the map. null: nothing usable.
 *   IST.Review.MapData.tile(z, x, y) -> Promise<ImageBitmap | HTMLImageElement>
 *   IST.Review.MapData.available(z, tiles) -> Promise<Set('x,y')>  which Esri really has
 *   IST.Review.MapData.ATTRIB
 *
 * Being light on free servers: raceway and place answers are cached in
 * localStorage (latest 24, for 90 days) and tiles in Cache Storage (30 days,
 * 200 MB), so a track you've opened before costs them nothing and works
 * offline. The two Overpass servers are asked together and the slower
 * request is cancelled as soon as one answers.
 */
(function () {
  'use strict';
  IST.Review = IST.Review || {};
  const Tk = IST.Review.Track;
  // servers that answer browser requests from any origin (a static GitHub Pages site)
  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
  const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  // two hosts for the same tiles, so twice as many load at once
  const TILE = (z, x, y) => 'https://' + ((x + y) % 2 ? 'server' : 'services') + '.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/' + z + '/' + y + '/' + x;
  const ATTRIB = 'Imagery © Esri, Maxar, Earthstar Geographics · Track © OpenStreetMap contributors';
  const CACHE_KEY = 'isloptrain.review.osm', CACHE_MAX = 24;

  // ---------------------------------------------------------------- cache
  const readCache = () => {
    try {
      return JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
    } catch (e) {
      return {};
    }
  };
  const OSM_DAYS = 90; // then asked again, so edits to the map reach us
  function cached(key) {
    const c = readCache()[key];
    return c && Date.now() - c.t < OSM_DAYS * 86400000 ? c.ways : null;
  }
  function store(key, ways) {
    try {
      const c = readCache();
      c[key] = { t: Date.now(), ways };
      const keys = Object.keys(c).sort((a, b) => c[b].t - c[a].t);
      keys.slice(CACHE_MAX).forEach((k) => delete c[k]);
      localStorage.setItem(CACHE_KEY, JSON.stringify(c));
    } catch (e) {
      /* full or blocked: just don't cache */
    }
  }

  // -------------------------------------------------------------- fetching
  async function fetchJSON(url, init, ms) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl && setTimeout(() => ctl.abort(), ms || 25000);
    // a caller's own signal (cancelling the losers of a race) also stops it
    if (ctl && init && init.signal) init.signal.addEventListener('abort', () => ctl.abort());
    try {
      const r = await fetch(url, Object.assign({}, init, { signal: ctl && ctl.signal }));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Raceway ways within r metres of a point: [{ pts: [[lat, lon]...], width }] (cached). */
  async function raceways(lat, lon, r) {
    const key = 'p' + lat.toFixed(3) + ',' + lon.toFixed(3) + ',' + Math.round(r / 100);
    const hit = cached(key);
    if (hit) return hit;
    const q = '[out:json][timeout:25];way["highway"="raceway"](around:' + Math.round(r) + ',' + lat.toFixed(6) + ',' + lon.toFixed(6) + ');out tags geom;';
    // Ask every server at once and take the first answer: the main one can take 30 s+
    // for a big circuit while a mirror answers in under one. GET, because the main
    // server answers browser POSTs with 502s. The rest are cancelled once one answers.
    const ctls = OVERPASS.map(() => (typeof AbortController !== 'undefined' ? new AbortController() : null));
    let res;
    try {
      res = await Promise.any(OVERPASS.map((url, k) => fetchJSON(url + '?data=' + encodeURIComponent(q), { signal: ctls[k] && ctls[k].signal }, 45000)));
    } catch (e) {
      throw new Error('map servers unreachable');
    } finally {
      ctls.forEach((c) => c && c.abort());
    }
    const ways = (res.elements || [])
      .filter((e) => e.type === 'way' && e.geometry && e.geometry.length > 1)
      .filter((e) => {
        const t = e.tags || {};
        // the circuit, not its pit lane, paddock roads or area outlines
        return t.area !== 'yes' && !/pit/i.test(t.name || '') && t.service !== 'repair' && t.service !== 'pit';
      })
      .map((e) => ({ pts: e.geometry.map((g) => [+g.lat.toFixed(7), +g.lon.toFixed(7)]), width: parseFloat((e.tags || {}).width) || 0 }));
    store(key, ways);
    return ways;
  }

  /** Places a track name might be, raceways first. */
  async function geocode(name) {
    const key = 'n' + name.toLowerCase();
    const hit = cached(key);
    if (hit) return hit;
    const seen = new Set(), out = [];
    for (const q of [name + ' circuit', name + ' raceway', name]) {
      let res = [];
      try {
        res = await fetchJSON(NOMINATIM + '?format=jsonv2&limit=6&q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' } }, 15000);
      } catch (e) {
        res = [];
      }
      res.forEach((r) => {
        const k = (+r.lat).toFixed(2) + ',' + (+r.lon).toFixed(2);
        if (seen.has(k)) return;
        seen.add(k);
        const rank = r.type === 'raceway' ? 0 : r.class === 'leisure' || r.class === 'landuse' ? 1 : 2;
        out.push({ lat: +r.lat, lon: +r.lon, rank });
      });
      if (out.some((o) => o.rank === 0)) break;
      await new Promise((ok) => setTimeout(ok, 1100)); // Nominatim asks for one request a second
    }
    out.sort((a, b) => a.rank - b.rank);
    const top = out.slice(0, 3);
    store(key, top);
    return top;
  }

  const cleanName = (s) => String(s || '').split('·')[0].replace(/[_-]+/g, ' ').replace(/\b(19|20)\d\d\b/g, '').replace(/\s+/g, ' ').trim();
  const halfWidthOf = (ways) => {
    const w = ways.map((x) => x.width).filter((v) => v >= 6 && v <= 30).sort((a, b) => a - b);
    return w.length ? w[w.length >> 1] / 2 : 0;
  };

  async function lookup(q) {
    const n = q.x.length;
    if (q.origin) {
      const g = Tk.geo(q.origin.lat, q.origin.lon);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < n; i += 5) (x0 = Math.min(x0, q.x[i])), (x1 = Math.max(x1, q.x[i])), (y0 = Math.min(y0, q.y[i])), (y1 = Math.max(y1, q.y[i]));
      const c = g.toLL((x0 + x1) / 2, (y0 + y1) / 2);
      const ways = await raceways(c[0], c[1], Math.hypot(x1 - x0, y1 - y0) / 2 + 300);
      // no raceway under the lap (a closed circuit since built over, or a sim's fantasy
      // track) means the imagery would show the wrong place, so there's no map
      const a = Tk.align(q.x, q.y, ways.map((w) => w.pts.map((p) => g.toXY(p[0], p[1]))));
      if (!a || a.cover < 0.6) return null;
      // session -> map metres is a.m; nudge the geo frame so laps sit on the raceway
      const gf = a.fitted ? Tk.geo(q.origin.lat, q.origin.lon, Tk.invert(a.m)) : g;
      return { geo: gf, lines: ways.map((w) => w.pts.map((p) => gf.toXY(p[0], p[1]))), halfWidth: halfWidthOf(ways), how: 'gps', shift: a.shift };
    }
    const name = cleanName(q.track);
    if (!name) return null;
    for (const place of await geocode(name)) {
      const ways = await raceways(place.lat, place.lon, 4000);
      if (!ways.length) continue;
      const local = Tk.geo(place.lat, place.lon);
      const lines = ways.map((w) => w.pts.map((p) => local.toXY(p[0], p[1])));
      const f = Tk.fit(q.x, q.y, lines);
      if (!f) continue;
      // session -> local metres is f.m; the geo frame wants local -> session
      const g = Tk.geo(place.lat, place.lon, Tk.invert(f.m));
      return { geo: g, lines: ways.map((w) => w.pts.map((p) => g.toXY(p[0], p[1]))), halfWidth: halfWidthOf(ways), how: 'fit' };
    }
    return null;
  }

  // ----------------------------------------------------------------- tiles
  /*
   * Tiles are kept in the browser's Cache Storage for 30 days, so reopening a
   * track asks Esri for nothing (their own headers only allow a day). An index
   * ("z/x/y" -> [saved, last used, bytes], days and bytes) lives in the same
   * cache; past 200 MB (~60 circuits) the least recently used go first.
   * Without Cache Storage (old browsers, some private windows) tiles load as
   * plain images and only the browser's own one-day cache applies.
   */
  const TILE_CACHE = 'isloptrain-tiles-v1', INDEX_URL = '/__isloptrain-tile-index';
  const TILE_DAYS = 30, TILE_MAX = 200 * 1024 * 1024, TILE_TRIM = 170 * 1024 * 1024;
  const today = () => Math.floor(Date.now() / 86400000);
  let store$ = null; // Promise<{ cache, index }> | null when unavailable
  function tileStore() {
    if (store$) return store$;
    store$ = (async () => {
      if (typeof caches === 'undefined') return null;
      const cache = await caches.open(TILE_CACHE);
      const r = await cache.match(INDEX_URL);
      let index = {};
      try {
        index = r ? await r.json() : {};
      } catch (e) {
        index = {};
      }
      return { cache, index };
    })().catch(() => null);
    return store$;
  }
  let saveT = 0;
  function saveIndex(S) {
    // written at most every 2 s, and trimmed to the size cap first
    clearTimeout(saveT);
    saveT = setTimeout(async () => {
      let total = 0;
      const keys = Object.keys(S.index);
      keys.forEach((k) => (total += S.index[k][2]));
      if (total > TILE_MAX) {
        keys.sort((a, b) => S.index[a][1] - S.index[b][1]);
        for (const k of keys) {
          if (total <= TILE_TRIM) break;
          total -= S.index[k][2];
          const url = S.index[k][3] || TILE.apply(null, k.split('/').map(Number));
          delete S.index[k];
          S.cache.delete(url).catch(() => {});
        }
      }
      S.cache.put(INDEX_URL, new Response(JSON.stringify(S.index), { headers: { 'Content-Type': 'application/json' } })).catch(() => {});
    }, 2000);
  }
  /** A response body from the cache when it's under 30 days old, else from the network (and kept). */
  async function cachedBlob(key, url) {
    const S = await tileStore();
    if (S) {
      const e = S.index[key];
      if (e && today() - e[0] < TILE_DAYS) {
        const hit = await S.cache.match(url);
        if (hit) {
          e[1] = today();
          saveIndex(S);
          return hit.blob();
        }
      }
    }
    const r = await fetch(url, { mode: 'cors' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
    const blob = await r.blob();
    if (S) {
      S.cache.put(url, new Response(blob, { headers: { 'Content-Type': blob.type || 'application/octet-stream' } })).catch(() => {});
      // tiles are found again from their key; anything else keeps its url
      S.index[key] = /^\d+\/\d+\/\d+$/.test(key) ? [today(), today(), blob.size] : [today(), today(), blob.size, url];
      saveIndex(S);
    }
    return blob;
  }
  const tileBlob = (z, x, y) => cachedBlob(z + '/' + x + '/' + y, TILE(z, x, y));

  /*
   * Which tiles Esri really has at zoom z (above ~z19 most places return a "no
   * data" placeholder). Esri answers in 128 x 128 blocks, so a circuit costs a
   * request or a few; answers go in the same 30-day cache.
   *   available(z, [{ x, y }]) -> Promise<Set('x,y')>
   */
  const TILEMAP = (z, row, col) => 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tilemap/' + z + '/' + row + '/' + col + '/128/128';
  async function available(z, list) {
    const blocks = new Map();
    list.forEach((t) => {
      const k = (t.y >> 7) + ',' + (t.x >> 7);
      if (!blocks.has(k)) blocks.set(k, [t.y >> 7 << 7, t.x >> 7 << 7]);
    });
    const have = new Set();
    await Promise.all(Array.from(blocks.values()).map(async ([row, col]) => {
      const d = JSON.parse(await (await cachedBlob('m/' + z + '/' + row + '/' + col, TILEMAP(z, row, col))).text());
      const L = d.location || {}, w = L.width || 0;
      (d.data || []).forEach((v, i) => v && have.add((L.left + (i % w)) + ',' + (L.top + Math.floor(i / w))));
    }));
    return have;
  }
  const decode = (blob) => {
    if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
    return new Promise((ok, fail) => {
      const im = new Image(), u = URL.createObjectURL(blob);
      im.onload = () => (URL.revokeObjectURL(u), ok(im));
      im.onerror = () => (URL.revokeObjectURL(u), fail(new Error('tile decode')));
      im.src = u;
    });
  };
  const tiles = new Map(); // this page's decoded tiles, so a rebuild doesn't even hit the cache
  function tile(z, x, y) {
    const key = z + '/' + x + '/' + y;
    if (!tiles.has(key)) {
      tiles.set(key, tileBlob(z, x, y).then(decode).catch((e) => {
        tiles.delete(key);
        throw e;
      }));
    }
    return tiles.get(key);
  }

  IST.Review.MapData = { lookup, tile, available, ATTRIB, cleanName };
})();
