/*
 * Garage 61 import (js/review/garage61.js): the bookmarklet bridge goes easy on
 * Garage 61's API, the viewer only takes laps from the Garage 61 tab it opened,
 * and a lap that comes through lands on the same track as an .ibt from there,
 * with its telemetry.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const IST = load();
const G = IST.Review.Garage61;
const C = G.core;

const headers = (o) => (k) => (o[k] == null ? null : String(o[k]));

test('the bridge never calls faster than its minimum gap, and waits out Retry-After', () => {
  assert.ok(C.MIN_GAP >= 1000);
  assert.ok(C.waitAfter(200, headers({})) >= C.MIN_GAP);
  assert.ok(C.waitAfter(200, headers({ 'Retry-After': 0.2, 'X-Ratelimit-Bucket-Remaining': 0 })) >= C.MIN_GAP);
  // a hit limit: at least the time Garage 61 asks for
  assert.ok(C.waitAfter(429, headers({ 'Retry-After': 30 })) >= 30000);
  // a bucket emptied by a successful call: pause before the next one
  assert.ok(C.waitAfter(200, headers({ 'Retry-After': 4, 'X-Ratelimit-Global-Remaining': 0 })) >= 4000);
  // a 429 with no header still backs off well beyond the gap
  assert.ok(C.waitAfter(429, headers({})) > 10 * C.MIN_GAP);
  assert.ok(C.MAX_SEND <= 5);
});

test('the viewer only accepts laps from the Garage 61 tab it opened, with its nonce', () => {
  const tab = {}, other = {};
  const lap = (o) => Object.assign({ origin: 'https://garage61.net', source: tab, data: { type: 'ist-g61-lap', v: G.PROTO, nonce: 'abc', name: 'G61 lap.csv', csv: 'Speed,LapDistPct\n1,0\n' } }, o);
  const make = () => G.receiver({ source: () => tab, nonce: 'abc' });

  assert.equal(make()(lap()).type, 'lap');
  assert.equal(make()(lap({ origin: 'https://evil.example' })), null);
  assert.equal(make()(lap({ origin: 'null' })), null);
  assert.equal(make()(lap({ source: other })), null);
  assert.equal(make()(lap({ data: Object.assign({}, lap().data, { nonce: 'abd' }) })), null);
  assert.equal(make()(lap({ data: Object.assign({}, lap().data, { v: G.PROTO + 1 }) })), null);
  assert.equal(make()(lap({ data: Object.assign({}, lap().data, { csv: 42 }) })), null);
  assert.equal(make()(lap({ data: Object.assign({}, lap().data, { csv: { length: G.MAX_CSV + 1 } }) })), null);
  // a name can't smuggle a path or another extension
  const n = make()(lap({ data: Object.assign({}, lap().data, { name: '../../etc/x.html' }) })).name;
  assert.match(n, /^[A-Za-z0-9 ._-]+\.csv$/);
  assert.ok(!n.includes('/'));
  // no more than one send's worth of laps per connection
  const r = make();
  let got = 0;
  for (let i = 0; i < G.MAX_SEND + 3; i++) if (r(lap())) got++;
  assert.equal(got, G.MAX_SEND);
});

test('the bridge finds the layout loaded in the viewer', () => {
  const tracks = [
    { id: 1, name: 'Circuit de Spa-Francorchamps', variant: 'Endurance' },
    { id: 2, name: 'Circuit de Spa-Francorchamps', variant: 'Grand Prix Pits' },
    { id: 3, name: 'Lime Rock Park', variant: 'Grand Prix' },
  ];
  // an .ibt names it "TrackDisplayName · TrackConfigName"
  const m = C.matchTrack('Circuit de Spa-Francorchamps · Grand Prix Pits', tracks);
  assert.equal(m.best.id, 2);
  assert.ok(m.sure);
  // without a layout it asks rather than guessing between two
  const q = C.matchTrack('Circuit de Spa-Francorchamps', tracks);
  assert.equal(q.options.length, 2);
  assert.equal(q.sure, false);
  assert.equal(C.matchTrack('', tracks).best, null);
});

test('a lap brought over from Garage 61 lands on the same track as an .ibt from there, with its telemetry', () => {
  const T = IST.Telemetry.lib();
  const apiLap = {
    id: 'x', lapTime: 50.27, startTime: '2026-11-20T18:00:00Z',
    track: { id: 2, name: 'Circuit de Spa-Francorchamps', variant: 'Grand Prix Pits' },
    car: { id: 9, name: 'Cadillac V-Series.R GTP' },
    driver: { firstName: 'Sam', lastName: 'Driver' },
    trackTemp: 38.5, airTemp: 24, trackUsage: 60, trackWetness: 0, windVel: 2.5, relativeHumidity: 48, clouds: 2,
  };
  // a Garage 61 export: one lap, 60 Hz rows, flags as true / false, no time column
  const R = 200, L = 2 * Math.PI * R, v = 25, rows = Math.round((L / v) * 60);
  const lines = ['Speed,LapDistPct,Lat,Lon,Brake,Throttle,RPM,SteeringWheelAngle,Gear,Clutch,ABSActive,DRSActive,P2PActive,LatAccel,LongAccel,VertAccel,Yaw,YawRate,PositionType'];
  for (let i = 0; i < rows; i++) {
    const p = i / rows, a = p * 2 * Math.PI;
    const lat = 50.437 + (R * Math.sin(a)) / 111195, lon = 5.971 + (R * (1 - Math.cos(a))) / (111195 * Math.cos((50.437 * Math.PI) / 180));
    lines.push([v, p.toFixed(6), lat.toFixed(8), lon.toFixed(8), 0, 0.8, 7000, 0.1, 4, 0, 'false', 'false', 'false', (v * v) / R, 0, 9.8, a, v / R, 3].join(','));
  }
  const text = C.withMeta(lines.join('\n'), apiLap);
  const buf = new TextEncoder().encode(text).buffer;
  const s = T.process(C.fileName(apiLap), buf, {});
  assert.equal(s.meta.track, 'Circuit de Spa-Francorchamps · Grand Prix Pits');
  assert.equal(s.meta.car, 'Cadillac V-Series.R GTP');
  assert.equal(s.meta.driver, 'Sam Driver');
  assert.equal(s.laps.length, 1);
  // and the conditions Garage 61 recorded for it
  const c = s.laps[0].cond;
  assert.equal(c.trackTemp, 38.5);
  assert.equal(c.airTemp, 24);
  assert.ok(Math.abs(c.rubber - 0.6) < 1e-9);
  assert.equal(c.wetness, 0);
  assert.ok(Math.abs(c.humidity - 0.48) < 1e-9);
  assert.equal(c.skies, 'Partly cloudy');
  assert.ok(s.laps[0].speed && Math.abs(s.laps[0].speed[10] - v) < 0.5);
  assert.ok(Math.abs(s.laps[0].time - L / v) / (L / v) < 0.02);
  assert.match(C.fileName(apiLap), /^G61 0m50\.270 Sam Driver Cadillac V-Series\.R GTP\.csv$/);
});

test('a Garage 61 lap cut on the samples either side of the line has the same lap time as the .ibt lap it came from', () => {
  const T = IST.Telemetry.lib();
  // the first row is most of a sample past the line and the last just short of it, as Garage 61 cuts them
  const R = 200, L = 2 * Math.PI * R, v = 30, dp = v / 60 / L, p0 = dp * 0.9, rows = Math.floor((1 - p0) / dp) + 1;
  const lines = ['Speed,LapDistPct,Lat,Lon,Brake,Throttle,RPM,SteeringWheelAngle,Gear'];
  for (let i = 0; i < rows; i++) {
    const p = p0 + i * dp, a = p * 2 * Math.PI;
    const lat = 50.437 + (R * Math.sin(a)) / 111195, lon = 5.971 + (R * (1 - Math.cos(a))) / (111195 * Math.cos((50.437 * Math.PI) / 180));
    lines.push([v, p.toFixed(8), lat.toFixed(9), lon.toFixed(9), 0, 1, 7000, 0.1, 4].join(','));
  }
  const s = T.process('Garage 61 - Sam Driver - Car - Track - 00.41.887 - X.csv', new TextEncoder().encode(lines.join('\n')).buffer, {});
  assert.equal(s.laps.length, 1);
  assert.equal(s.laps[0].kind, 'full');
  assert.ok(Math.abs(s.laps[0].time - L / v) < 0.002, 'lap time ' + s.laps[0].time + ' vs ' + L / v);
  assert.ok(Math.abs(s.laps[0].len - L) < 0.5);
});
