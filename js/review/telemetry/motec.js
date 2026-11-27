/*
 * MoTeC i2 .ld parser (ACC, rFactor 2 / Le Mans Ultimate, iRacing via
 * converters, and anything else that writes i2 logs). A factory: see common.js.
 *
 * The format is not published; this follows the widely used reverse-engineered
 * layout (as in the open-source ldparser). Little-endian:
 *   header   0 marker 0x40, 8 channel-meta pointer, 12 channel-data pointer,
 *            36 event pointer, 94 date[16], 126 time[16], 158 driver[64],
 *            222 vehicle[64], 350 venue[64], 1572 short comment[64]
 *   channel  a linked list from the meta pointer, 124 B each:
 *            0 prev, 4 next, 8 data pointer, 12 sample count, 16 counter,
 *            18 dtype_a, 20 dtype (bytes per sample), 22 freq (Hz),
 *            24 shift, 26 mul, 28 scale, 30 dec (int16), 32 name[32],
 *            64 short name[8], 72 unit[12]
 *   value    (raw / scale * 10^-dec + shift) * mul;
 *            dtype_a 0x07 = float (f16 / f32), 0 / 3 / 5 = int (i16 / i32)
 *
 * Channels each have their own rate; the ones used are resampled to the
 * fastest of them. Lap markers live in the .ldx sidecar (beacon times, µs):
 * drop it alongside the .ld and loader.js passes its text in as opt.sidecar.
 * Without it, laps are cut from a lap-number or lap-distance channel if the
 * log has one.
 */
(function () {
  'use strict';
  IST.Telemetry.def('motec', function (T) {
    function f16(h) {
      const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
      if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
      if (e === 31) return f ? NaN : s * Infinity;
      return s * Math.pow(2, e - 15) * (1 + f / 1024);
    }

    /** Beacon times (s) from an .ldx sidecar's XML. */
    T.ldxBeacons = function (xml) {
      const out = [];
      const re = /<Marker\b[^>]*\bTime="([\d.]+(?:[eE][+-]?\d+)?)"/g; // i2 writes 1.2345e+008 as readily as 123450000
      let m;
      while ((m = re.exec(xml || ''))) out.push(parseFloat(m[1]) / 1e6);
      return out.sort((a, b) => a - b);
    };

    T.formats.motec = {
      label: 'MoTeC .ld',
      exts: ['ld'],
      sniff: (u8, name) => /\.ld$/i.test(name) && u8.length > 16 && u8[0] === 0x40 && u8[1] === 0 && u8[2] === 0 && u8[3] === 0,
      parse(buf, name, opt) {
        const dv = new DataView(buf), u8 = new Uint8Array(buf);
        const u32 = (o) => dv.getUint32(o, true), u16 = (o) => dv.getUint16(o, true), i16 = (o) => dv.getInt16(o, true);
        if (buf.byteLength < 1762 || u32(0) !== 0x40) throw new Error('Not a MoTeC .ld file');
        const meta = {
          date: T.str(u8, 94, 16) + ' ' + T.str(u8, 126, 16),
          driver: T.str(u8, 158, 64),
          car: T.str(u8, 222, 64),
          track: T.str(u8, 350, 64),
          comment: T.str(u8, 1572, 64),
        };

        // walk the channel list
        const chans = [];
        const seen = new Set();
        for (let p = u32(8); p && p + 124 <= buf.byteLength && !seen.has(p) && chans.length < 5000; p = u32(p + 4)) {
          seen.add(p);
          chans.push({
            data: u32(p + 8), n: u32(p + 12), typeA: u16(p + 18), size: u16(p + 20), freq: u16(p + 22),
            shift: i16(p + 24), mul: i16(p + 26) || 1, scale: i16(p + 28) || 1, dec: i16(p + 30),
            name: T.str(u8, p + 32, 32), short: T.str(u8, p + 64, 8), unit: T.str(u8, p + 72, 12),
          });
        }
        if (!chans.length) throw new Error('No channels in this .ld file');

        // match by full name, then by short name for any left over
        const byName = T.match(chans.map((c) => c.name));
        const byShort = T.match(chans.map((c) => c.short));
        const pick = {};
        for (const k in T.ALIASES) {
          const i = byName[k] != null ? byName[k] : byShort[k];
          if (i != null && chans[i].n > 1 && chans[i].freq > 0) pick[k] = chans[i];
        }
        if (!pick.speed) throw new Error('No speed channel found (looked for: ' + T.ALIASES.speed.slice(0, 4).join(', ') + '…)');

        const read = (c) => {
          const out = new Float64Array(c.n);
          const isF = c.typeA === 0x07, sz = c.size;
          const k = Math.pow(10, -c.dec) / c.scale;
          for (let i = 0, o = c.data; i < c.n; i++, o += sz) {
            if (o + sz > buf.byteLength) {
              out.fill(NaN, i);
              break;
            }
            const raw = isF ? (sz === 2 ? f16(u16(o)) : dv.getFloat32(o, true)) : sz === 2 ? dv.getInt16(o, true) : dv.getInt32(o, true);
            out[i] = (raw * k + c.shift) * c.mul;
          }
          return out;
        };

        let F = 0, dur = Infinity;
        for (const k in pick) {
          F = Math.max(F, pick[k].freq);
          dur = Math.min(dur, pick[k].n / pick[k].freq);
        }
        const n = Math.max(2, Math.floor(dur * F));
        const ch = {}, units = {};
        let done = 0;
        const keys = Object.keys(pick);
        for (const k of keys) {
          const c = pick[k];
          ch[k] = T.toSI(k, c.unit, T.resample(read(c), c.freq, n, F, k === 'lap' || T.STEP_CHANNELS.indexOf(k) >= 0));
          units[k] = c.unit;
          if (opt && opt.progress) opt.progress(++done / keys.length);
        }
        // iRacing's BrakeABScutPct is the share of brake force kept: store the share removed, as ibt.js does
        if (ch.absCut) for (let i = 0; i < n; i++) ch.absCut[i] = Math.max(0, Math.min(1, 1 - ch.absCut[i]));
        // iRacing's TrackWetness, carried over as its 0..7 enum (an integer channel), would read as 100 % wet
        if (ch.cWet && (pick.cWet.typeA !== 0x07 || (ch.cWet.some((v) => v > 1) && ch.cWet.every((v) => !isFinite(v) || (v === Math.round(v) && v >= 0 && v <= 7)))) && !T.wetShare(ch.cWet)) delete ch.cWet;
        // the .ldx names the venue; an iRacing export uses the sim's own track id, which finds the official corner numbers
        const venue = opt && opt.sidecar && /<String Id="Venue" Value="([^"]+)"/.exec(opt.sidecar);
        const vLen = opt && opt.sidecar && /<Numeric Id="Venue Length" Value="([\d.]+)" Unit="km"/.exec(opt.sidecar);
        if (venue && !meta.trackId) meta.trackId = venue[1].trim();
        if (vLen && parseFloat(vLen[1]) > 0.5) meta.trackLen = parseFloat(vLen[1]) * 1000;
        // a lap-number channel in i2 often counts from the first timed lap; it's only a marker
        const beacons = opt && opt.sidecar ? T.ldxBeacons(opt.sidecar) : null;
        const warnings = [];
        if (!beacons && !ch.lap && !ch.lapDist && !ch.lapPct) warnings.push('No .ldx or lap channel: the log is shown as one run. Drop the matching .ldx with the .ld to split laps.');
        return T.session({ format: 'motec', name, meta, n, rate: F, ch, units, beacons, warnings });
      },
    };
  });
})();
