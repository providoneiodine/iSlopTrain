/*
 * iRacing .ibt (disk telemetry) parser. A factory: see common.js.
 *
 * Layout (irsdk_defines.h, little-endian):
 *   0    irsdk_header (112 B): ver, status, tickRate, sessionInfoUpdate,
 *        sessionInfoLen, sessionInfoOffset, numVars, varHeaderOffset,
 *        numBuf, bufLen, pad[2], varBuf[4] { tickCount, bufOffset, pad[2] }
 *   112  irsdk_diskSubHeader: sessionStartDate (time_t, 8 B), startTime,
 *        endTime (double), lapCount, recordCount (int)
 *   varHeaderOffset: numVars x 144 B { type, offset, count, countAsTime(+pad),
 *        name[32], desc[64], unit[32] }
 *   sessionInfoOffset: YAML (track, car, driver)
 *   varBuf[0].bufOffset: recordCount records of bufLen bytes each
 *
 * iRacing exports world position only as GPS (Lat / Lon / Alt), which
 * laps.js turns into metres. Lap, LapDist and LapDistPct cut the laps.
 */
(function () {
  'use strict';
  IST.Telemetry.def('ibt', function (T) {
    const SIZE = [1, 1, 4, 4, 4, 8]; // char, bool, int, bitfield, float, double
    const WANT = {
      t: 'SessionTime', lap: 'Lap', lapDist: 'LapDist', lapPct: 'LapDistPct', speed: 'Speed',
      throttle: 'Throttle', brake: 'Brake', steer: 'SteeringWheelAngle', gear: 'Gear', rpm: 'RPM',
      lat: 'Lat', lon: 'Lon', alt: 'Alt', yaw: 'YawNorth', yawRate: 'YawRate', latG: 'LatAccel', onPit: 'OnPitRoad',
      vx: 'VelocityX', vy: 'VelocityY', longG: 'LongAccel', vertG: 'VertAccel', roll: 'Roll', pitch: 'Pitch',
      absActive: 'BrakeABSactive', absCut: 'BrakeABScutPct', bpF: 'LFbrakeLinePress', bpR: 'LRbrakeLinePress',
      wsLF: 'LFspeed', wsRF: 'RFspeed', wsLR: 'LRspeed', wsRR: 'RRspeed',
      pLF: 'LFpressure', pRF: 'RFpressure', pLR: 'LRpressure', pRR: 'RRpressure',
      steerTq: 'SteeringWheelTorque', surface: 'PlayerTrackSurface', material: 'PlayerTrackSurfaceMaterial',
      bb: 'dcBrakeBias', absSet: 'dcABS', tcSet: 'dcTractionControl',
      rhLF: 'LFrideHeight', rhRF: 'RFrideHeight', rhLR: 'LRrideHeight', rhRR: 'RRrideHeight',
      cTrack: 'TrackTempCrew', cAir: 'AirTemp', cWet: 'TrackWetness', cPrecip: 'Precipitation', cWind: 'WindVel', cHum: 'RelativeHumidity', cSkies: 'Skies',
    };
    // Surface temps, columns car-left to car-right on every tyre (the session YAML says
    // LastTempsOMI for left tyres, IMO for right): left tyres L = outer, right tyres L = inner.
    ['LF', 'LR'].forEach((w) => Object.assign(WANT, { ['t' + w + '_o']: w + 'tempL', ['t' + w + '_m']: w + 'tempM', ['t' + w + '_i']: w + 'tempR' }));
    ['RF', 'RR'].forEach((w) => Object.assign(WANT, { ['t' + w + '_i']: w + 'tempL', ['t' + w + '_m']: w + 'tempM', ['t' + w + '_o']: w + 'tempR' }));
    const FALLBACK = { yaw: 'Yaw', cTrack: 'TrackTemp' };

    /** The weekend's conditions from the session YAML (WeekendInfo, and the last session's rubber). */
    function conditions(info) {
      const num = (re) => parseFloat(yaml(info, re));
      const c = {
        trackTemp: num(/TrackSurfaceTemp:\s*(-?[\d.]+)\s*C/),
        airTemp: num(/TrackAirTemp:\s*(-?[\d.]+)\s*C/),
        wind: num(/TrackWindVel:\s*([\d.]+)\s*m\/s/),
        humidity: num(/TrackRelativeHumidity:\s*([\d.]+)\s*%/) / 100,
        precip: num(/TrackPrecipitation:\s*([\d.]+)\s*%/) / 100,
        skies: yaml(info, /TrackSkies:\s*(.+)/),
      };
      // one SessionTrackRubberState per session in the weekend; the recording is the last one listed
      const rub = info.match(/SessionTrackRubberState:[^\n]*/g);
      if (rub) c.rubber = rub[rub.length - 1].replace(/SessionTrackRubberState:\s*/, '').trim();
      Object.keys(c).forEach((k) => {
        if (c[k] === '' || (typeof c[k] === 'number' && !isFinite(c[k]))) delete c[k];
      });
      return c;
    }

    /** A YAML value; an empty one ("TrackConfigName: ") stays empty instead of taking the next line. */
    function yaml(info, re) {
      const m = info.match(re);
      if (!m) return '';
      const lead = m[0].slice(0, m[0].indexOf(m[1]));
      return /\n/.test(lead) ? '' : m[1].trim();
    }

    T.formats.ibt = {
      label: 'iRacing .ibt',
      exts: ['ibt'],
      sniff: (u8, name) => /\.ibt$/i.test(name),
      parse(buf, name, opt) {
        const dv = new DataView(buf), u8 = new Uint8Array(buf);
        const i32 = (o) => dv.getInt32(o, true);
        if (buf.byteLength < 144) throw new Error('Too short to be an .ibt file');
        const infoLen = i32(16), infoOff = i32(20), numVars = i32(24), varOff = i32(28), bufLen = i32(36);
        const dataOff = i32(52);
        if (numVars <= 0 || numVars > 4096 || bufLen <= 0 || varOff + numVars * 144 > buf.byteLength) throw new Error('Not an iRacing .ibt file (bad header)');
        let n = i32(140);
        const fit = Math.floor((buf.byteLength - dataOff) / bufLen);
        if (!(n > 0) || n > fit) n = fit;

        const vars = {};
        for (let k = 0; k < numVars; k++) {
          const b = varOff + k * 144;
          vars[T.str(u8, b + 16, 32)] = { type: i32(b), offset: i32(b + 4), count: i32(b + 8), unit: T.str(u8, b + 112, 32) };
        }
        const info = infoLen > 0 && infoOff + infoLen <= buf.byteLength ? T.text(u8, infoOff, infoLen) : '';
        const meta = {
          track: yaml(info, /TrackDisplayName:\s*(.+)/) || yaml(info, /TrackName:\s*(.+)/),
          config: yaml(info, /TrackConfigName:\s*(.+)/),
          trackId: yaml(info, /TrackName:\s*(.+)/), // iRacing's own name for the layout
          car: '',
          driver: '',
          trackLen: (parseFloat(yaml(info, /TrackLength:\s*([\d.]+)\s*km/)) || 0) * 1000 || 0,
          date: Number(dv.getBigInt64 ? dv.getBigInt64(112, true) : 0) * 1000 || 0,
        };
        // the player's own entry under Drivers: (the first CarScreenName is often someone else's
        // car in a multi-car session; anchor on "- CarIdx:" so DriverCarIdx doesn't match)
        const me = yaml(info, /DriverCarIdx:\s*(\d+)/);
        let own = '';
        if (me) {
          const at = info.search(new RegExp('-\\s*CarIdx:\\s*' + me + '\\s*\\n'));
          if (at >= 0) {
            const rest = info.slice(at + 1);
            const next = rest.search(/\n\s*-\s*CarIdx:|\n\S/);
            own = next >= 0 ? rest.slice(0, next) : rest;
          }
        }
        meta.driver = yaml(own, /UserName:\s*(.+)/);
        meta.car = yaml(own, /CarScreenName:\s*(.+)/) || yaml(info, /CarScreenName:\s*(.+)/);
        meta.carPath = yaml(own, /CarPath:\s*(.+)/) || yaml(info, /CarPath:\s*(.+)/);
        if (meta.config && meta.track && meta.config !== meta.track) meta.track += ' · ' + meta.config;
        meta.cond = conditions(info);

        const ch = {}, units = {};
        for (const key in WANT) {
          const v = vars[WANT[key]] || (FALLBACK[key] && vars[FALLBACK[key]]);
          if (!v || v.count < 1 || v.offset + SIZE[v.type] > bufLen) continue;
          const a = new Float64Array(n);
          const ty = v.type;
          for (let r = 0, o = dataOff + v.offset; r < n; r++, o += bufLen) {
            a[r] = ty === 4 ? dv.getFloat32(o, true) : ty === 5 ? dv.getFloat64(o, true) : ty === 2 || ty === 3 ? dv.getInt32(o, true) : u8[o];
            if (opt && opt.progress && (r & 32767) === 0) opt.progress(r / n);
          }
          ch[key] = a;
          units[key] = v.unit;
        }
        if (!ch.speed) throw new Error('No Speed channel in this .ibt');
        // BrakeABScutPct reads as the share of brake force kept (1 with ABS idle): store the share removed
        if (ch.absCut) for (let i = 0; i < n; i++) ch.absCut[i] = Math.max(0, Math.min(1, 1 - ch.absCut[i]));
        // ride height: front and rear axle means, then drop the corners
        const pair = (a, b) => (ch[a] && ch[b] ? ch[a].map((v, i) => (v + ch[b][i]) / 2) : null);
        const rhF = pair('rhLF', 'rhRF'), rhR = pair('rhLR', 'rhRR');
        // and the left and right side means, for body roll in the 3D view
        const rhLt = pair('rhLF', 'rhLR'), rhRt = pair('rhRF', 'rhRR');
        ['rhLF', 'rhRF', 'rhLR', 'rhRR'].forEach((k) => delete ch[k]);
        if (rhF) ch.rhF = rhF;
        if (rhR) ch.rhR = rhR;
        if (rhLt && rhRt) (ch.rhLt = rhLt), (ch.rhRt = rhRt);
        // a car without ABS logs zeros: no ABS channels at all, so its lanes read "Not in this file"
        if (ch.absActive && !ch.absActive.some((v) => v > 0)) delete ch.absActive, delete ch.absCut;
        // wetness from iRacing's 0..7 scale to a share (0 = unknown: dropped)
        if (ch.cWet) {
          for (let i = 0; i < n; i++) {
            const w = T.WETNESS[Math.round(ch.cWet[i])];
            ch.cWet[i] = w != null ? w : NaN;
          }
          if (!ch.cWet.some(isFinite)) delete ch.cWet;
        }
        return T.session({ format: 'ibt', name, meta, n, rate: i32(8) || 60, ch, units });
      },
    };
  });
})();
