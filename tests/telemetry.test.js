/*
 * The lap viewer's import: a lap read from a sim's file has the lap time,
 * length, speed and inputs the sim recorded, whichever format it came in,
 * and the delta shown against the reference adds up to the lap-time gap.
 *
 * The files are written here from a known drive: a 200 m radius circle
 * driven at a constant speed per lap (out lap, three timed laps, part of an
 * in lap), so every expected number is exact.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { load } = require('./harness');

const R = 200, L = 2 * Math.PI * R;
const SPEEDS = [30, 40, 38, 41, 25]; // out, laps 1-3, in (m/s)
const LAP_TIMES = SPEEDS.slice(1, 4).map((v) => L / v);

/** Samples of the drive at `rate` Hz. */
function drive(rate) {
  const out = [];
  let s = L * 0.7, lap = 0, t = 0;
  while (true) {
    const v = SPEEDS[lap];
    const a = s / R; // angle round the circle
    out.push({ t, lap, s, v, a, thr: lap % 2 ? 1 : 0.6, brk: 0.2 * (lap % 2), gear: 3 + (lap % 2) });
    t += 1 / rate;
    s += v / rate;
    if (s >= L) {
      s -= L;
      lap++;
    }
    if (lap === 4 && s > L * 0.4) return out;
  }
}

// ------------------------------------------------------------------ writers
/** noFix: that many samples at the start with Lat, Lon and Alt all 0, as iRacing writes before the car is placed. */
function writeIbt(rate, noFix) {
  const S = drive(rate);
  const lat0 = 50.43, lon0 = 5.97, ky = 6371008.8 * (Math.PI / 180), kx = ky * Math.cos((lat0 * Math.PI) / 180);
  const VARS = [
    ['SessionTime', 5, 's', (p) => p.t], ['Lap', 2, '', (p) => p.lap], ['LapDist', 4, 'm', (p) => p.s], ['LapDistPct', 4, '%', (p) => p.s / L],
    ['Speed', 4, 'm/s', (p) => p.v], ['Throttle', 4, '%', (p) => p.thr], ['Brake', 4, '%', (p) => p.brk], ['Gear', 2, '', (p) => p.gear],
    ['Lat', 5, 'deg', (p) => lat0 + (R * Math.sin(p.a)) / ky], ['Lon', 5, 'deg', (p) => lon0 + (R * Math.cos(p.a)) / kx], ['Alt', 4, 'm', () => 100],
    // ABS keeps 70 % of the force; tyre columns run car-left to car-right on every tyre
    ['BrakeABSactive', 2, '', () => 1], ['BrakeABScutPct', 4, '%', () => 0.7],
    ['LFtempL', 4, 'C', () => 80], ['LFtempM', 4, 'C', () => 85], ['LFtempR', 4, 'C', () => 90],
    ['RFtempL', 4, 'C', () => 81], ['RFtempM', 4, 'C', () => 86], ['RFtempR', 4, 'C', () => 91],
    // the track warms 4 degC a lap; wetness on iRacing's 0..7 scale (1 = dry)
    ['TrackTempCrew', 4, 'C', (p) => 30 + 4 * p.lap], ['TrackWetness', 2, '', () => 1],
  ];
  const SIZE = [1, 1, 4, 4, 4, 8];
  let off = 0;
  const vars = VARS.map(([name, type, unit, get]) => {
    const v = { name, type, unit, get, offset: off };
    off += SIZE[type];
    return v;
  });
  const bufLen = off;
  const yaml = '---\nWeekendInfo:\n TrackDisplayName: Test Circle\n TrackLength: ' + (L / 1000).toFixed(4) + ' km\n TrackSkies: Partly Cloudy\n TrackSurfaceTemp: 31.00 C\n TrackAirTemp: 22.50 C\n TrackWindVel: 1.20 m/s\n TrackRelativeHumidity: 55 %\nSessionInfo:\n Sessions:\n - SessionNum: 0\n   SessionTrackRubberState: moderate usage\nDriverInfo:\n DriverCarIdx: 1\n Drivers:\n - CarIdx: 0\n   UserName: Someone Else\n   CarScreenName: Other Car\n - CarIdx: 1\n   UserName: Test Driver\n   CarScreenName: Test Car\n...\n'; // a multi-car session: the player's car isn't listed first
  const varOff = 144, infoOff = varOff + vars.length * 144, dataOff = infoOff + yaml.length;
  const buf = new ArrayBuffer(dataOff + bufLen * S.length);
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  const str = (o, s) => [...s].forEach((c, i) => (u8[o + i] = c.charCodeAt(0)));
  dv.setInt32(0, 2, true);
  dv.setInt32(8, rate, true);
  dv.setInt32(16, yaml.length, true);
  dv.setInt32(20, infoOff, true);
  dv.setInt32(24, vars.length, true);
  dv.setInt32(28, varOff, true);
  dv.setInt32(32, 1, true);
  dv.setInt32(36, bufLen, true);
  dv.setInt32(52, dataOff, true);
  dv.setInt32(140, S.length, true);
  vars.forEach((v, k) => {
    const b = varOff + k * 144;
    dv.setInt32(b, v.type, true);
    dv.setInt32(b + 4, v.offset, true);
    dv.setInt32(b + 8, 1, true);
    str(b + 16, v.name);
    str(b + 112, v.unit);
  });
  str(infoOff, yaml);
  S.forEach((p, r) => {
    vars.forEach((v) => {
      const o = dataOff + r * bufLen + v.offset, x = r < (noFix || 0) && /^(Lat|Lon|Alt)$/.test(v.name) ? 0 : v.get(p);
      if (v.type === 5) dv.setFloat64(o, x, true);
      else if (v.type === 4) dv.setFloat32(o, x, true);
      else dv.setInt32(o, x, true);
    });
  });
  return buf;
}

/** MoTeC .ld with channels at different rates and no positions (lateral g instead), plus its .ldx. */
function writeLd() {
  const fast = drive(100);
  const CH = [
    // name, short, unit, Hz, int16 (scale 1, dec 1) or float32, value
    { name: 'Ground Speed', short: 'Spd', unit: 'km/h', hz: 100, int: true, get: (p) => p.v * 3.6 },
    { name: 'Throttle Pos', short: 'Thr', unit: '%', hz: 50, int: true, get: (p) => p.thr * 100 },
    { name: 'Brake Pos', short: 'Brk', unit: '%', hz: 50, int: true, get: (p) => p.brk * 100 },
    { name: 'Gear', short: 'Gear', unit: '', hz: 20, int: true, get: (p) => p.gear },
    { name: 'G Force Lat', short: 'GLat', unit: 'G', hz: 100, int: false, get: (p) => (p.v * p.v) / R / 9.80665 },
  ];
  const HEAD = 1762, CHH = 124;
  const data = CH.map((c) => {
    const step = 100 / c.hz;
    const vals = fast.filter((_, i) => i % step === 0).map(c.get);
    return { c, vals };
  });
  let dataPtr = HEAD + CH.length * CHH;
  const total = dataPtr + data.reduce((s, d) => s + d.vals.length * (d.c.int ? 2 : 4), 0);
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  const str = (o, s) => [...s].forEach((ch, i) => (u8[o + i] = ch.charCodeAt(0)));
  dv.setUint32(0, 0x40, true);
  dv.setUint32(8, HEAD, true);
  dv.setUint32(12, dataPtr, true);
  str(158, 'Test Driver');
  str(222, 'Test Car');
  str(350, 'Test Circle');
  data.forEach(({ c, vals }, k) => {
    const p = HEAD + k * CHH;
    dv.setUint32(p, k ? p - CHH : 0, true);
    dv.setUint32(p + 4, k < CH.length - 1 ? p + CHH : 0, true);
    dv.setUint32(p + 8, dataPtr, true);
    dv.setUint32(p + 12, vals.length, true);
    dv.setUint16(p + 18, c.int ? 0x03 : 0x07, true);
    dv.setUint16(p + 20, c.int ? 2 : 4, true);
    dv.setUint16(p + 22, c.hz, true);
    dv.setInt16(p + 24, 0, true);
    dv.setInt16(p + 26, 1, true);
    dv.setInt16(p + 28, 1, true);
    dv.setInt16(p + 30, c.int ? 1 : 0, true);
    str(p + 32, c.name);
    str(p + 64, c.short);
    str(p + 72, c.unit);
    vals.forEach((v, i) => (c.int ? dv.setInt16(dataPtr + i * 2, Math.round(v * 10), true) : dv.setFloat32(dataPtr + i * 4, v, true)));
    dataPtr += vals.length * (c.int ? 2 : 4);
  });
  // beacons at each line crossing, in µs
  const cross = [];
  for (let i = 1; i < fast.length; i++) {
    if (fast[i].lap > fast[i - 1].lap) {
      const a = fast[i - 1], b = fast[i];
      cross.push(a.t + (L - a.s) / a.v);
      void b;
    }
  }
  const ldx = '<?xml version="1.0"?>\n<LDXFile Locale="English_United Kingdom.1252" DefaultLocale="C" Version="1.6"><Layers><Layer><MarkerBlock><MarkerGroup Name="Beacons" Index="3">' +
    cross.map((t, i) => '<Marker Version="100" ClassName="BCN" Name="Manual.' + (i + 1) + '" Flags="77" Time="' + (t * 1e6).toFixed(3) + '"/>').join('') +
    '</MarkerGroup></MarkerBlock></Layer></Layers></LDXFile>';
  return { buf, ldx };
}

function writeCsv() {
  const rows = ['"Venue","Test Circle"', '"Vehicle","Test Car"', '', '"Time","Lap","Speed","Throttle","Brake","Gear","Pos X","Pos Y","Pos Z"', '"s","","km/h","%","%","","m","m","m"'];
  drive(50).forEach((p) => rows.push([p.t.toFixed(4), p.lap, (p.v * 3.6).toFixed(3), p.thr * 100, p.brk * 100, p.gear, (R * Math.cos(p.a)).toFixed(3), (R * Math.sin(p.a)).toFixed(3), 3].join(',')));
  return rows.join('\r\n');
}

// ---------------------------------------------------------------- checks
function checkLaps(r, label, tol) {
  const full = r.laps.filter((l) => l.kind === 'full');
  assert.equal(full.length, 3, label + ': three timed laps');
  assert.equal(r.laps[0].kind, 'out', label + ': the first segment is the out lap');
  assert.equal(r.laps[r.laps.length - 1].kind, 'in', label + ': the last is the in lap');
  full.forEach((l, k) => {
    assert.ok(Math.abs(l.time - LAP_TIMES[k]) < tol, label + ' lap ' + (k + 1) + ' time ' + l.time.toFixed(3) + ' vs ' + LAP_TIMES[k].toFixed(3));
    assert.ok(Math.abs(l.len - L) / L < 0.005, label + ' lap ' + (k + 1) + ' length ' + l.len.toFixed(1) + ' vs ' + L.toFixed(1));
    const mid = l.n >> 1;
    assert.ok(Math.abs(l.speed[mid] - SPEEDS[k + 1]) < 0.05, label + ': speed in m/s');
    assert.ok(Math.abs(l.throttle[mid] - (k % 2 ? 0.6 : 1)) < 0.01, label + ': throttle as 0..1');
    assert.equal(l.gear[mid], k % 2 ? 3 : 4, label + ': gear');
  });
  return full;
}
const radius = (l) => {
  let cx = 0, cy = 0;
  for (let i = 0; i < l.n; i++) (cx += l.x[i]), (cy += l.y[i]);
  cx /= l.n;
  cy /= l.n;
  let lo = Infinity, hi = 0;
  for (let i = 0; i < l.n; i++) {
    const d = Math.hypot(l.x[i] - cx, l.y[i] - cy);
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  return [lo, hi];
};

test('iRacing .ibt: samples with no GPS fix don’t put part of a lap half a world away', () => {
  const T = load().Telemetry.lib();
  const r = T.process('session.ibt', writeIbt(60, 3));
  // every lap, the partial out lap that holds those samples included, stays on the circle
  r.laps.forEach((l) => {
    for (let i = 0; i < l.n; i++) assert.ok(Math.hypot(l.x[i], l.y[i]) < R * 3 && Math.abs(l.z[i] - 100) < 1, 'lap ' + l.lapNo + ' (' + l.kind + ') at ' + i + ' m is at ' + Math.round(l.x[i]) + ', ' + Math.round(l.y[i]) + ', ' + Math.round(l.z[i]));
  });
});

test('iRacing .ibt: laps, times, units and the GPS line come out as recorded', () => {
  const T = load().Telemetry.lib();
  const r = T.process('session.ibt', writeIbt(60));
  assert.equal(r.meta.track, 'Test Circle');
  assert.equal(r.meta.car, 'Test Car', 'the player’s own car, not the first car listed');
  assert.equal(r.meta.driver, 'Test Driver');
  assert.equal(r.posSource, 'gps');
  const full = checkLaps(r, 'ibt', 0.005);
  const [lo, hi] = radius(full[0]);
  assert.ok(lo > R - 1 && hi < R + 1, 'GPS turned into a ' + R + ' m circle (got ' + lo.toFixed(1) + '-' + hi.toFixed(1) + ')');
  const l = full[0], mid = l.n >> 1;
  assert.ok(Math.abs(l.absCut[mid] - 0.3) < 1e-6, 'ABS cut is the share of force removed (1 - kept)');
  assert.equal(l.absActive[mid], 1);
  assert.equal(l.tLF_o[mid], 80, 'left tyre: the left column is the outer edge');
  assert.equal(l.tLF_i[mid], 90, 'left tyre: the right column is the inner edge');
  assert.equal(l.tRF_i[mid], 81, 'right tyre: the left column is the inner edge');
  assert.equal(l.tRF_o[mid], 91, 'right tyre: the right column is the outer edge');
  assert.ok(Math.abs(l.tLF[mid] - 85) < 1e-6, 'tyre mean of inner, middle and outer');
});

test('MoTeC .ld + .ldx: mixed channel rates, unit conversion, laps from the beacons', () => {
  const T = load().Telemetry.lib();
  const { buf, ldx } = writeLd();
  const r = T.process('session.ld', buf, { sidecar: ldx });
  assert.equal(r.meta.track, 'Test Circle');
  assert.equal(r.split, 'beacon');
  const full = checkLaps(r, 'ld', 0.02);
  // no positions in the log: rebuilt from lateral g and speed, closing on itself
  assert.equal(r.posSource, 'reckoned');
  const [lo, hi] = radius(full[1]);
  assert.ok(lo > R * 0.95 && hi < R * 1.05, 'reckoned line is the circle (got ' + lo.toFixed(1) + '-' + hi.toFixed(1) + ')');
});

test('.ldx beacon times in exponent notation are read like plain ones', () => {
  const T = load().Telemetry.lib();
  const xml = '<Marker Version="100" ClassName="BCN" Name="Manual.1" Flags="77" Time="9.153e+007"/><Marker Name="Manual.2" Time="45000000.5"/>';
  assert.equal(T.ldxBeacons(xml).map((t) => t.toFixed(2)).join(), '45.00,91.53');
});

test('state channels are never blended when resampled: a setting steps, a flag stays 0 or 1', () => {
  const T = load().Telemetry.lib();
  ['absSet', 'tcSet', 'bb', 'absActive', 'gear'].forEach((k) => assert.ok(T.STEP_CHANNELS.includes(k), k));
  const up = T.resample(Float64Array.from([3, 3, 4, 4]), 10, 16, 40, true);
  assert.ok(up.every((v) => v === 3 || v === 4), 'no 3.25 between ABS 3 and ABS 4');
});

test('lap times roll over at the minute: 119.9996 s is 2:00.000', () => {
  const C = load().Review.Compare;
  assert.equal(C.fmtLap(119.9996), '2:00.000');
  assert.equal(C.fmtLap(59.9996), '1:00.000');
  assert.equal(C.fmtLap(102.315), '1:42.315');
  assert.equal(C.fmtLap(48.2), '48.200');
});

test('CSV metadata: the track is named by its own row, not by "Track length"', () => {
  const T = load().Telemetry.lib();
  const rows = ['"Track","Spa"', '"Track Length","7004"', '"Car","GT3"', '"Car Number","12"', 'Time,Speed,Throttle'];
  for (let i = 0; i < 20; i++) rows.push([i / 10, 30, 1].join(','));
  const S = T.parseCSV(rows.join('\n'), 'x.csv');
  assert.equal(S.meta.track, 'Spa');
  assert.equal(S.meta.car, 'GT3');
});

test('MoTeC .ld without its .ldx is still read, as one run, and says why', () => {
  const T = load().Telemetry.lib();
  const r = T.process('session.ld', writeLd().buf);
  assert.equal(r.laps.length, 1);
  assert.ok(r.warnings.some((w) => /\.ldx/.test(w)));
});

test('CSV with a units row and metadata: laps, km/h and % converted', () => {
  const T = load().Telemetry.lib();
  const r = T.parseCSV ? T.laps(T.parseCSV(writeCsv(), 'session.csv')) : null;
  assert.equal(r.posSource, 'world');
  checkLaps(r, 'csv', 0.03);
});

test('the delta to the reference adds up to the lap-time gap, corner for corner', () => {
  const IST = load();
  const r = IST.Telemetry.lib().process('session.ibt', writeIbt(60));
  const full = r.laps.filter((l) => l.kind === 'full');
  const cmp = IST.Review.Compare.build(full[1], full);
  assert.equal(cmp.laps[0].lap, full[1], 'the reference comes first');
  cmp.laps.forEach((c) => {
    const gap = c.lap.time - full[1].time;
    assert.ok(Math.abs(c.delta[cmp.n - 1] - gap) < 1e-3, 'delta at the line equals the lap-time gap');
    // constant speed per lap: halfway round, half the gap
    assert.ok(Math.abs(c.delta[(cmp.n - 1) >> 1] - gap / 2) < 0.01, 'delta halfway is half the gap');
  });
});

test('each lap carries the conditions it was driven in, and laps far enough apart are flagged', () => {
  const IST = load();
  const r = IST.Telemetry.lib().process('cond.ibt', writeIbt(60));
  const [a, , c] = r.laps.filter((l) => l.kind === 'full');
  // the weekend's values from the header, the track temperature from the lap's own samples
  assert.equal(a.cond.airTemp, 22.5);
  assert.equal(a.cond.skies, 'Partly Cloudy');
  assert.equal(a.cond.rubber, 'moderate usage');
  assert.equal(a.cond.wetness, 0);
  assert.ok(Math.abs(a.cond.humidity - 0.55) < 1e-9);
  assert.ok(Math.abs(a.cond.trackTemp - 34) < 0.5);
  assert.ok(Math.abs(c.cond.trackTemp - 42) < 0.5);
  const K = IST.Review.Conditions;
  assert.deepEqual(K.compare([a.cond, c.cond]).rows.filter((x) => x.differs).map((x) => x.key).join(), 'trackTemp');
  // the same lap twice: nothing to flag
  assert.equal(K.compare([a.cond, a.cond]).differs, 0);
  // the same sky named by two tools still matches; a number and a label aren't compared
  assert.equal(K.compare([{ skies: 'Partly Cloudy', rubber: 'moderate usage' }, { skies: 'partly cloudy', rubber: 0.4 }]).differs, 0);
  // a file without conditions shows no panel
  assert.equal(K.compare([{}, {}]).rows.length, 0);
});

test('the import code runs in a Worker: factories use nothing from outside their own body', () => {
  const IST = load();
  const src = IST.Telemetry.workerSource();
  const posted = [];
  const sandbox = { self: { postMessage: (m) => posted.push(m) }, Float64Array, Float32Array, Uint8Array, DataView, Math, Number, String, Object, Array, Set, Error, RegExp, isFinite, parseFloat, JSON, Promise };
  vm.createContext(sandbox);
  vm.runInContext(src + ';this.__T = T;', sandbox);
  const r = sandbox.__T.process('session.ibt', writeIbt(60));
  assert.equal(r.laps.filter((l) => l.kind === 'full').length, 3);
});
