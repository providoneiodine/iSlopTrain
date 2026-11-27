/*
 * iRacing laps that reach the Lap Viewer through other tools: a MoTeC .ld converted from an
 * .ibt keeps iRacing's own channels, and a Garage 61 CSV may stop one sample past the line.
 * Either way the lap shows the conditions and lap time iRacing recorded.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const LEN = 4000, V = 50, RATE = 60, TIME = LEN / V; // one lap at a constant 50 m/s

/** An .ld of one lap plus a little, with iRacing's channel names; wetness is its 0..7 enum (1 = dry). */
function writeLd(wet) {
  const n = Math.round(TIME * RATE) + 120;
  const pct = (i) => ((0.99 * LEN + (V * i) / RATE) / LEN) % 1;
  const CH = [
    { name: 'Speed', f: true, get: () => V },
    { name: 'LapDistPct', f: true, get: pct },
    { name: 'Lap', f: false, get: (i) => 1 + Math.floor((0.99 * LEN + (V * i) / RATE) / LEN) },
    { name: 'TrackWetness', f: false, get: () => wet },
    { name: 'PlayerCarMyIncidentCount', f: false, get: (i) => (i > n / 2 ? 2 : 0) },
  ];
  const HEAD = 1762, CHH = 124;
  let ptr = HEAD + CH.length * CHH;
  const buf = new ArrayBuffer(ptr + CH.reduce((s, c) => s + n * (c.f ? 4 : 2), 0));
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  const str = (o, s) => [...s].forEach((ch, i) => (u8[o + i] = ch.charCodeAt(0)));
  dv.setUint32(0, 0x40, true);
  dv.setUint32(8, HEAD, true);
  CH.forEach((c, k) => {
    const p = HEAD + k * CHH;
    dv.setUint32(p + 4, k < CH.length - 1 ? p + CHH : 0, true);
    dv.setUint32(p + 8, ptr, true);
    dv.setUint32(p + 12, n, true);
    dv.setUint16(p + 18, c.f ? 0x07 : 0x03, true);
    dv.setUint16(p + 20, c.f ? 4 : 2, true);
    dv.setUint16(p + 22, RATE, true);
    dv.setInt16(p + 26, 1, true);
    dv.setInt16(p + 28, 1, true);
    str(p + 32, c.name);
    for (let i = 0; i < n; i++) (c.f ? dv.setFloat32(ptr + i * 4, c.get(i), true) : dv.setInt16(ptr + i * 2, c.get(i), true));
    ptr += n * (c.f ? 4 : 2);
  });
  return buf;
}
const LDX = '<LDXFile><Layers><Details><String Id="Venue" Value="roadamerica full"/><Numeric Id="Venue Length" Value="4" Unit="km" DPS="2"/></Details></Layers></LDXFile>';

test('a MoTeC export of an iRacing lap: a dry track reads dry, a wet one wet, and the venue names the track', () => {
  const T = load().Telemetry.lib(), K = load().Review.Conditions;
  const dry = T.process('race.ld', writeLd(1), { sidecar: LDX });
  const lap = dry.laps.find((l) => l.kind === 'full');
  assert.equal(lap.cond.wetness, 0, 'iRacing’s "dry" (1) is no wetness, not 100 %');
  assert.equal(K.wet([lap.cond]), null, 'no rain drawn over a dry lap');
  assert.equal(dry.meta.trackId, 'roadamerica full', 'the .ldx venue finds the official corner numbers');
  assert.equal(dry.trackLen, 4000);
  assert.equal(lap.inc, 2, 'incidents come over from iRacing’s own channel');
  const wet = T.process('race.ld', writeLd(5), { sidecar: LDX }).laps.find((l) => l.kind === 'full');
  assert.ok(K.wet([wet.cond]), 'a moderately wet track (5) still reads wet');
});

test('a Garage 61 lap that stops one sample past the line has the lap time iRacing gave it', () => {
  const T = load().Telemetry.lib();
  // starts just past the line, ends just past it again: the sample spacing doesn't divide the lap
  const rows = ['"Venue","Test Circle"', 'Speed,LapDistPct,Throttle,Brake'];
  const dp = V / RATE / LEN, p0 = 0.3 * dp;
  for (let p = p0; ; p += dp) {
    rows.push([V, (p % 1).toFixed(9), 1, 0].join(','));
    if (p >= 1) break;
  }
  const r = T.process('G61 lap.csv', new TextEncoder().encode(rows.join('\n')).buffer);
  const full = r.laps.filter((l) => l.kind === 'full');
  assert.equal(full.length, 1);
  assert.ok(Math.abs(full[0].time - TIME) < 0.002, 'lap time ' + full[0].time.toFixed(4) + ' vs ' + TIME);
});
