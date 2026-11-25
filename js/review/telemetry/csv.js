/*
 * CSV / TSV telemetry parser: the fallback for any tool that exports a table
 * (MoTeC i2 "Export as CSV", Garage 61, SimHub, Second Monitor, a spreadsheet).
 * A factory: see common.js.
 *
 * - Delimiter: comma, semicolon or tab, whichever splits the header widest.
 * - Header: the widest non-numeric row near the top that is followed (after
 *   an optional units row) by numeric rows. Rows above it with two fields
 *   are read as key/value metadata (MoTeC's "Venue","Spa").
 * - Units: from the units row, or from the header ("Speed [km/h]",
 *   "Throttle (%)"), or guessed from the range (see T.toSI).
 * - Columns are matched to canonical channels by name (T.ALIASES).
 */
(function () {
  'use strict';
  IST.Telemetry.def('csv', function (T) {
    function splitter(d) {
      return function (line) {
        if (line.indexOf('"') < 0) return line.split(d);
        const out = [];
        let cur = '', q = false;
        for (let i = 0; i < line.length; i++) {
          const c = line[i];
          if (q) {
            if (c === '"') {
              if (line[i + 1] === '"') (cur += '"'), i++;
              else q = false;
            } else cur += c;
          } else if (c === '"') q = true;
          else if (c === d) out.push(cur), (cur = '');
          else cur += c;
        }
        out.push(cur);
        return out;
      };
    }
    // Garage 61 writes flags (ABSActive, DRSActive...) as true / false
    const BOOL = { true: 1, false: 0 };
    const isNumRow = (f) => f.length > 1 && f.filter((x) => x.trim() !== '' && (isFinite(+x) || /^(true|false)$/i.test(x.trim()))).length >= f.length * 0.6;
    const unitIn = (s) => {
      const m = String(s).match(/[[(]([^\])]+)[\])]/);
      return m ? m[1].trim() : '';
    };

    T.parseCSV = function (text, name, opt) {
      const lines = text.split(/\r?\n/);
      const head = lines.slice(0, 60).filter((l) => l.trim());
      let best = null;
      for (const d of [',', ';', '\t']) {
        const sp = splitter(d);
        for (let i = 0; i < Math.min(lines.length, 60); i++) {
          const f = sp(lines[i]);
          if (f.length < 3 || isNumRow(f)) continue;
          // the header is followed by numbers, maybe after a units row and a blank line
          let j = i + 1, unitsRow = null;
          while (j < lines.length && !lines[j].trim()) j++;
          let g = j < lines.length ? sp(lines[j]) : [];
          if (!isNumRow(g) && g.length === f.length) {
            unitsRow = g;
            j++;
            while (j < lines.length && !lines[j].trim()) j++;
            g = j < lines.length ? sp(lines[j]) : [];
          }
          if (isNumRow(g) && g.length >= f.length - 1 && (!best || f.length > best.f.length)) best = { d, sp, i, f, unitsRow, data: j };
          if (best && best.d === d) break;
        }
      }
      if (!best || !head.length) throw new Error('Could not find a header row followed by numbers');

      const names = best.f.map((s) => s.trim());
      const meta = {};
      for (let i = 0; i < best.i; i++) {
        const f = best.sp(lines[i]).map((s) => s.trim()).filter(Boolean);
        if (f.length < 2) continue;
        const k = T.norm(f[0]), x = parseFloat(f[1]);
        const cond = (meta.cond = meta.cond || {});
        if (/^(track|road)(surface)?temp/.test(k)) cond.trackTemp = x;
        else if (/^(air|ambient)temp/.test(k)) cond.airTemp = x;
        else if (/^track(usage|rubber)|^rubber/.test(k)) cond.rubber = isFinite(x) ? T.share(x) : f[1];
        else if (/^(track)?wetness/.test(k)) cond.wetness = T.share(x);
        else if (/^precip/.test(k)) cond.precip = T.share(x);
        else if (/^(relative)?humidity/.test(k)) cond.humidity = T.share(x);
        else if (/^wind(vel|speed)?$/.test(k)) cond.wind = x;
        else if (/^(clouds|skies|sky)$/.test(k)) cond.skies = f[1];
        else if (/venue|circuit|^track(name)?$/.test(k)) meta.track = f[1];
        else if (/vehicle|^car(name|model)?$/.test(k)) meta.car = f[1];
        else if (/driver/.test(k)) meta.driver = f[1];
        else if (/date/.test(k)) meta.date = f[1];
      }
      if (meta.cond) {
        Object.keys(meta.cond).forEach((k) => {
          if (typeof meta.cond[k] === 'number' && !isFinite(meta.cond[k])) delete meta.cond[k];
        });
      }
      // a lap downloaded from Garage 61 has no heading rows: its file name carries the driver, car and track
      const g61 = /^Garage 61 - (.+?) - (.+?) - (.+) - \d+\.\d+\.\d+ - /i.exec(name || '');
      if (g61) {
        meta.driver = meta.driver || g61[1];
        meta.car = meta.car || g61[2];
        meta.track = meta.track || g61[3];
      }
      const idx = T.match(names);
      if (idx.speed == null && (idx.x == null || idx.y == null) && (idx.lat == null || idx.lon == null)) {
        throw new Error('No speed or position column found. Columns seen: ' + names.slice(0, 12).join(', '));
      }

      const keys = Object.keys(idx);
      const cols = keys.map(() => []);
      for (let r = best.data; r < lines.length; r++) {
        const l = lines[r];
        if (!l.trim()) continue;
        const f = best.sp(l);
        if (f.length < 2) continue;
        for (let c = 0; c < keys.length; c++) {
          const s = f[idx[keys[c]]];
          cols[c].push(s == null || s === '' ? NaN : BOOL[s.trim().toLowerCase()] != null ? BOOL[s.trim().toLowerCase()] : +s);
        }
        if (opt && opt.progress && (r & 16383) === 0) opt.progress(r / lines.length);
      }
      const n = cols.length ? cols[0].length : 0;
      if (n < 10) throw new Error('Only ' + n + ' data rows');
      const ch = {}, units = {};
      keys.forEach((k, c) => {
        const u = (best.unitsRow && best.unitsRow[idx[k]] && best.unitsRow[idx[k]].trim()) || unitIn(names[idx[k]]) || (/kmh|kph/.test(T.norm(names[idx[k]])) ? 'km/h' : /mph/.test(T.norm(names[idx[k]])) ? 'mph' : '');
        units[k] = u;
        ch[k] = T.toSI(k, u, Float64Array.from(cols[c]));
      });
      // a "time" column in ms without a unit
      if (ch.t && !units.t && n > 2) {
        const dt = (ch.t[n - 1] - ch.t[0]) / (n - 1);
        if (dt >= 4) for (let i = 0; i < n; i++) ch.t[i] /= 1000;
      }
      return T.session({ format: 'csv', name, meta, n, ch, units });
    };

    T.formats.csv = {
      label: 'CSV',
      exts: ['csv', 'tsv', 'txt'],
      sniff: (u8, name) => /\.(csv|tsv|txt)$/i.test(name),
      text: true,
      parse(buf, name, opt) {
        const u8 = new Uint8Array(buf);
        const text = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8').decode(u8) : T.text(u8, 0, u8.length);
        return T.parseCSV(text, name, opt);
      },
    };
  });
})();
