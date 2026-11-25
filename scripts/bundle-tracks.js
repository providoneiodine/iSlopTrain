#!/usr/bin/env node
/*
 * Builds data/tracks/: each circuit in scripts/tracks.json with its OpenStreetMap raceways,
 * so the Map option rarely has to ask Overpass or Nominatim. Run from the repo root:
 *
 *   node scripts/bundle-tracks.js                 all circuits
 *   node scripts/bundle-tracks.js spa monza       just these (the rest of the index is kept)
 *   node scripts/bundle-tracks.js --resume        skip circuits that already have a file (after an interrupted run)
 *   node scripts/bundle-tracks.js --corners       also mirror Lovely Track Data's iRacing files
 *   node scripts/bundle-tracks.js --js            only rewrite bundle.js from the files already there
 *
 * Every run also writes data/tracks/bundle.js, the same index and outlines as one script: a page
 * opened from file:// can't fetch the JSON, but it can load a script.
 *
 * --corners is off by default: Lovely Track Data has no licence yet, so only mirror it with the
 * maintainers' permission. Node 18+, nothing to install.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'tracks');
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const LTD = 'https://raw.githubusercontent.com/Lovely-Sim-Racing/lovely-track-data/main/data/';
const UA = { 'User-Agent': 'isloptrain-track-bundler/1 (static site build script)' };
const R_DEFAULT = 3500;

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
// Lovely Track Data's file-name rule, same as corners.js
const clean = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

async function getJSON(url, ms) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms || 60000) });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return r.json();
}

/** Google's polyline encoding at 1e-6 degrees (~0.1 m); mapdata.js decodes it. */
function encode(pts) {
  let out = '', pa = 0, pb = 0;
  const num = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    while (v >= 0x20) (out += String.fromCharCode((0x20 | (v & 0x1f)) + 63)), (v >>>= 5);
    out += String.fromCharCode(v + 63);
  };
  for (const [lat, lon] of pts) {
    const a = Math.round(lat * 1e6), b = Math.round(lon * 1e6);
    num(a - pa), num(b - pb);
    (pa = a), (pb = b);
  }
  return out;
}

function decode(s) {
  const pts = [];
  let i = 0, a = 0, b = 0;
  const num = () => {
    let v = 0, sh = 0, c;
    do (c = s.charCodeAt(i++) - 63), (v |= (c & 0x1f) << sh), (sh += 5);
    while (c >= 0x20);
    return v & 1 ? ~(v >> 1) : v >> 1;
  };
  while (i < s.length) (a += num()), (b += num()), pts.push([a / 1e6, b / 1e6]);
  return pts;
}

const metres = (a, b) => {
  const k = Math.PI / 180, x = (b[1] - a[1]) * k * Math.cos(((a[0] + b[0]) / 2) * k), y = (b[0] - a[0]) * k;
  return Math.hypot(x, y) * 6371000;
};

/**
 * Raceways around a point, filtered exactly as mapdata.js does live. A street or public-road
 * circuit (Bathurst, Adelaide) also takes the public roads it's made of, by their OSM names.
 */
async function raceways(lat, lon, r, roads) {
  const near = '(around:' + r + ',' + lat + ',' + lon + ')';
  // anything but letters, digits, spaces, hyphens and apostrophes matches as any character
  const esc = (n) => n.replace(/[^\w '-]/g, '.');
  const named = roads && roads.length ? 'way["highway"]["name"~"^(' + roads.map(esc).join('|') + ')$"]' + near + ';' : '';
  const q = '[out:json][timeout:60];(way["highway"="raceway"]' + near + ';' + named + ');out tags geom;';
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    // every mirror at once, first answer wins (as mapdata.js does), the others cancelled
    const ctls = OVERPASS.map(() => new AbortController());
    try {
      const res = await Promise.any(OVERPASS.map(async (url, k) => {
        const r = await fetch(url + '?data=' + encodeURIComponent(q), { headers: UA, signal: AbortSignal.any([ctls[k].signal, AbortSignal.timeout(120000)]) });
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
        return r.json();
      }));
      return (res.elements || [])
        .filter((e) => e.type === 'way' && e.geometry && e.geometry.length > 1)
        .filter((e) => {
          const t = e.tags || {};
          // a named road was asked for by name, so Bathurst's Pit Straight stays
          return t.highway !== 'raceway' || (t.area !== 'yes' && !/pit/i.test(t.name || '') && t.service !== 'repair' && t.service !== 'pit');
        })
        .map((e) => ({ pts: e.geometry.map((g) => [g.lat, g.lon]), width: parseFloat((e.tags || {}).width) || 0 }));
    } catch (e) {
      last = e;
    } finally {
      ctls.forEach((c) => c.abort());
    }
    await sleep(10000 * (attempt + 1));
  }
  throw last;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--js')) return writeScript();
  const corners = args.includes('--corners'), resume = args.includes('--resume');
  const only = new Set(args.filter((a) => !a.startsWith('--')));
  const list = JSON.parse(fs.readFileSync(path.join(__dirname, 'tracks.json'), 'utf8')).circuits;
  fs.mkdirSync(path.join(OUT, 'osm'), { recursive: true });

  // Lovely Track Data's iRacing list says which trackIds are layouts of which circuit
  const manifest = await getJSON(LTD + 'manifest.json');
  const ir = (manifest.tracks && manifest.tracks.iracing) || [];
  const layouts = new Map(list.map((c) => [c.id, []]));
  for (const t of ir) {
    const first = clean(t.trackId).split('-')[0];
    const c = list.find((x) => (x.match || []).includes(first));
    if (c) layouts.get(c.id).push(t);
    else console.warn('! no circuit for Lovely Track Data trackId "' + t.trackId + '": add it to tracks.json');
  }

  const indexFile = path.join(OUT, 'index.json');
  const old = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : { circuits: [] };
  const index = [];
  for (const c of list) {
    const r = c.r || R_DEFAULT;
    const entry = {
      id: c.id, name: c.name, lat: c.lat, lon: c.lon, r,
      ids: layouts.get(c.id).map((t) => clean(t.trackId)),
      names: [c.name].concat(c.names || [], layouts.get(c.id).map((t) => t.trackName)).filter((v, i, a) => a.indexOf(v) === i),
    };
    const prev = old.circuits.find((x) => x.id === c.id);
    if (only.size && !only.has(c.id)) {
      if (prev) index.push(Object.assign(prev, { ids: entry.ids, names: entry.names }));
      continue;
    }
    const have = path.join(OUT, 'osm', c.id + '.json');
    if (resume && fs.existsSync(have)) {
      const ways = JSON.parse(fs.readFileSync(have, 'utf8')).ways.map((w) => decode(w.p));
      index.push(Object.assign(entry, { osm: true, km: +(ways.reduce((s, w) => s + w.slice(1).reduce((t, p, i) => t + metres(w[i], p), 0), 0) / 1000).toFixed(1) }));
      continue;
    }
    process.stdout.write(c.id.padEnd(16));
    let ways;
    try {
      ways = await raceways(c.lat, c.lon, r, c.roads);
    } catch (e) {
      // servers down for this one: keep what was there, run it again later
      console.log('failed (' + e.message + ')' + (prev ? ', kept the old data' : ', left out'));
      if (prev) index.push(prev);
      continue;
    }
    const km = ways.reduce((s, w) => s + w.pts.slice(1).reduce((t, p, i) => t + metres(w.pts[i], p), 0), 0) / 1000;
    const file = path.join(OUT, 'osm', c.id + '.json');
    if (ways.length) {
      fs.writeFileSync(file, JSON.stringify({ id: c.id, ways: ways.map((w) => (w.width ? { p: encode(w.pts), w: w.width } : { p: encode(w.pts) })) }) + '\n');
    } else if (fs.existsSync(file)) fs.unlinkSync(file);
    // osm: false tells the app there's nothing on the map here, so it doesn't ask either
    entry.osm = ways.length > 0;
    entry.km = +km.toFixed(1);
    index.push(entry);
    console.log(ways.length + ' ways, ' + km.toFixed(1) + ' km' + (ways.length ? '' : '  (none: no map for this circuit)'));
    await sleep(3000); // a polite pace for volunteer servers
  }
  fs.writeFileSync(indexFile, JSON.stringify({ v: 1, built: new Date().toISOString().slice(0, 10), circuits: index }, null, 1) + '\n');

  if (corners) {
    const dir = path.join(OUT, 'lovely');
    fs.mkdirSync(path.join(dir, 'iracing'), { recursive: true });
    for (const t of ir) {
      const d = await getJSON(LTD + t.path);
      // only what corners.js reads
      fs.writeFileSync(path.join(dir, t.path), JSON.stringify({ name: d.name, trackId: d.trackId, length: d.length, turn: (d.turn || []).map((x) => ({ name: x.name, start: x.start, end: x.end })) }) + '\n');
      await sleep(200);
    }
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ tracks: { iracing: ir } }) + '\n');
    console.log('Lovely Track Data: ' + ir.length + ' iRacing files');
  }
  writeScript();
  console.log('wrote ' + path.relative(ROOT, OUT));
}

/** data/tracks/bundle.js: index.json and every osm/<id>.json, for pages opened from file://. */
function writeScript() {
  const index = JSON.parse(fs.readFileSync(path.join(OUT, 'index.json'), 'utf8'));
  const osm = {};
  index.circuits.forEach((c) => {
    const f = path.join(OUT, 'osm', c.id + '.json');
    if (c.osm && fs.existsSync(f)) osm[c.id] = JSON.parse(fs.readFileSync(f, 'utf8'));
  });
  fs.writeFileSync(path.join(OUT, 'bundle.js'), '/* Built by scripts/bundle-tracks.js from index.json and osm/. Track (c) OpenStreetMap contributors, ODbL. */\n' +
    'window.IST = window.IST || {};\nIST.TrackBundle = ' + JSON.stringify({ index, osm }) + ';\n');
  console.log('wrote ' + path.relative(ROOT, path.join(OUT, 'bundle.js')));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
