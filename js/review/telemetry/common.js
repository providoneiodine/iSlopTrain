/*
 * Telemetry import: the shared part every format parser builds on.
 *
 *   IST.Telemetry.def(name, factory)   register a piece of the import pipeline
 *   IST.Telemetry.lib()                the pipeline, built on this thread (tests, no-Worker fallback)
 *   IST.Telemetry.factories            what loader.js turns into a Web Worker
 *
 * Every file in js/review/telemetry/ (except loader.js) is one factory:
 * `function (T) { ... }` that adds to the shared object T. A factory must not
 * use anything from outside its own body (no IST, no closure variables, no
 * DOM), because loader.js stringifies the factories into a Worker so a
 * 100 MB .ibt parses off the main thread. Load order is factory order.
 *
 * The common session every parser produces (T.session):
 *   { format, name, meta: { track, car, driver, date, trackLen }, n, rate,
 *     ch: { <canonical>: Float64Array(n) }, units, beacons? }
 * Canonical channels are in SI: s, m, m/s, rad, rad/s, m/s^2; pedals 0..1.
 * Laps are cut and resampled by distance in laps.js.
 */
(function () {
  'use strict';
  const factories = [];
  let lib = null;
  IST.Telemetry = {
    factories,
    def(name, fn) {
      factories.push({ name, fn });
      lib = null;
    },
    lib() {
      if (!lib) {
        const T = {};
        factories.forEach((f) => f.fn(T));
        lib = T;
      }
      return lib;
    },
  };

  IST.Telemetry.def('common', function (T) {
    T.formats = {};

    /** Canonical channel -> names it goes by in exports (normalised: lower case, letters and digits only), best first. */
    T.ALIASES = {
      t: ['sessiontime', 'time', 'timestamp', 'elapsedtime', 'timesec', 'times'],
      lap: ['lap', 'lapnumber', 'lapno', 'laps', 'lapindex', 'currentlap'],
      lapDist: ['lapdist', 'lapdistance', 'distancelap', 'lapdistm', 'distance', 'dist'],
      lapPct: ['lapdistpct', 'lapdistancepct', 'lappct', 'lapfraction', 'normalizedcarposition', 'splinepos'],
      speed: ['speed', 'groundspeed', 'vehiclespeed', 'carspeed', 'speedkmh', 'speedkph', 'speedmph', 'speedms', 'gpsspeed', 'velocity'],
      throttle: ['throttle', 'throttlepos', 'throttleposition', 'throttlepedal', 'gas', 'accelerator', 'pedalthrottle', 'tps'],
      brake: ['brake', 'brakepos', 'brakeposition', 'brakepedal', 'pedalbrake', 'brakepedalpos', 'brakepressure', 'brakepressfront'],
      steer: ['steeringwheelangle', 'steeringangle', 'steerangle', 'steer', 'steering', 'steeringwheel', 'steeringpos'],
      gear: ['gear', 'currentgear', 'gearpos'],
      rpm: ['rpm', 'rpms', 'enginerpm', 'enginespeed', 'engrpm'],
      x: ['carposx', 'posx', 'positionx', 'worldx', 'worldpositionx', 'carcoordx', 'xpos', 'x'],
      y: ['carposy', 'posy', 'positiony', 'worldy', 'worldpositiony', 'carcoordy', 'ypos', 'y'],
      z: ['carposz', 'posz', 'positionz', 'worldz', 'worldpositionz', 'carcoordz', 'zpos', 'z'],
      lat: ['lat', 'latitude', 'gpslatitude', 'gpslat'],
      lon: ['lon', 'long', 'longitude', 'gpslongitude', 'gpslon', 'gpslong'],
      alt: ['alt', 'altitude', 'gpsaltitude', 'elevation', 'gpsalt'],
      yaw: ['yaw', 'yawnorth', 'heading', 'gpsheading', 'yawangle'],
      yawRate: ['yawrate', 'yawvelocity', 'roty', 'gyroz', 'yawspeed'],
      latG: ['latacc', 'lataccel', 'latg', 'glat', 'gforcelat', 'lateralacceleration', 'lateralg', 'accellat'],
      onPit: ['onpitroad', 'inpits', 'pitlane', 'inpitlane'],
      // body-frame velocities (never plain x / y: those are positions)
      vx: ['velocityx', 'vx', 'localvelx', 'velx', 'longvelocity'],
      vy: ['velocityy', 'vy', 'localvely', 'vely', 'latvelocity'],
      longG: ['longaccel', 'longacc', 'glong', 'glon', 'accellong', 'longitudinalacceleration', 'gforcelong', 'longg'],
      vertG: ['vertaccel', 'vertacc', 'gvert', 'accelvert', 'verticalacceleration', 'gforcevert'],
      roll: ['roll', 'rollangle'],
      pitch: ['pitch', 'pitchangle'],
      absActive: ['brakeabsactive', 'absactive', 'abs', 'absinaction'],
      tcActive: ['tcactive', 'tc', 'tcinaction'],
      drs: ['drsactive', 'drs'],
      p2p: ['p2pactive', 'pushtopass'],
      wsLF: ['lfspeed', 'wheelspeedlf', 'wheelspeedfl', 'wheelspdfl', 'wheelspeedfrontleft'],
      wsRF: ['rfspeed', 'wheelspeedrf', 'wheelspeedfr', 'wheelspdfr', 'wheelspeedfrontright'],
      wsLR: ['lrspeed', 'wheelspeedlr', 'wheelspeedrl', 'wheelspdrl', 'wheelspeedrearleft'],
      wsRR: ['rrspeed', 'wheelspeedrr', 'wheelspdrr', 'wheelspeedrearright'],
      // one surface temperature per tyre (ACC and most CSVs); iRacing's inner / mid / outer come from ibt.js
      tLF: ['tyretemplf', 'tyretempfl', 'tyretairlf', 'tiretemplf', 'tiretempfl', 'tyretempfrontleft'],
      tRF: ['tyretemprf', 'tyretempfr', 'tyretairrf', 'tiretemprf', 'tiretempfr', 'tyretempfrontright'],
      tLR: ['tyretemplr', 'tyretemprl', 'tyretairlr', 'tiretemplr', 'tiretemprl', 'tyretemprearleft'],
      tRR: ['tyretemprr', 'tyretairrr', 'tiretemprr', 'tyretemprearright'],
      pLF: ['lfpressure', 'tyrepresslf', 'tyrepressfl', 'tirepressurelf', 'tirepressurefl', 'tyrepressurefl'],
      pRF: ['rfpressure', 'tyrepressrf', 'tyrepressfr', 'tirepressurerf', 'tirepressurefr', 'tyrepressurefr'],
      pLR: ['lrpressure', 'tyrepresslr', 'tyrepressrl', 'tirepressurelr', 'tirepressurerl', 'tyrepressurerl'],
      pRR: ['rrpressure', 'tyrepressrr', 'tirepressurerr', 'tyrepressurerr'],
      steerTq: ['steeringwheeltorque', 'steertorque', 'steeringtorque'],
      surface: ['playertracksurface', 'tracksurface'],
      material: ['playertracksurfacematerial', 'surfacematerial'],
      bb: ['dcbrakebias', 'brakebias'],
      absSet: ['dcabs', 'abssetting', 'abslevel'],
      tcSet: ['dctractioncontrol', 'tcsetting', 'tclevel'],
    };

    /**
     * Channels every lap carries (resampled by distance in laps.js, sent back from the
     * Worker, lined up in compare.js). Missing ones are null on the lap. Derived channels
     * (derive.js) are in the list too: they're computed at the native rate, then cut
     * like the rest.
     */
    T.TYRES = ['LF', 'RF', 'LR', 'RR'];
    T.LAP_CHANNELS = ['t', 'x', 'y', 'z', 'speed', 'throttle', 'brake', 'steer', 'gear', 'rpm',
      'yawRate', 'latG', 'longG', 'vx', 'vy', 'absActive', 'absCut', 'tcActive', 'bpF', 'bpR',
      'wsLF', 'wsRF', 'wsLR', 'wsRR', 'tLF', 'tRF', 'tLR', 'tRR',
      'tLF_i', 'tLF_m', 'tLF_o', 'tRF_i', 'tRF_m', 'tRF_o', 'tLR_i', 'tLR_m', 'tLR_o', 'tRR_i', 'tRR_m', 'tRR_o',
      'pLF', 'pRF', 'pLR', 'pRR', 'rhF', 'rhR', 'steerTq', 'surface', 'material', 'bb', 'absSet', 'tcSet',
      // derived (derive.js)
      'us', 'beta', 'betaX', 'betaRate', 'counter', 'slipF', 'slipR', 'gripUse', 'balState', 'phase', 'coast'];
    /** Channels that hold a state, not a measurement: resampled by nearest sample, never blended. */
    T.STEP_CHANNELS = ['gear', 'absActive', 'tcActive', 'surface', 'material', 'bb', 'absSet', 'tcSet', 'counter', 'balState', 'phase', 'coast'];

    T.norm = (s) => String(s || '').toLowerCase().replace(/\[.*?\]|\(.*?\)/g, '').replace(/[^a-z0-9]/g, '');

    /** Map column / channel names to canonical channels: { canonical: index }. Earlier aliases win. */
    T.match = function (names) {
      const normed = names.map(T.norm);
      const out = {};
      const used = new Set();
      for (const key in T.ALIASES) {
        for (const a of T.ALIASES[key]) {
          const i = normed.findIndex((nm, j) => nm === a && !used.has(j));
          if (i >= 0) {
            out[key] = i;
            used.add(i);
            break;
          }
        }
      }
      return out;
    };

    /** A NUL-terminated latin1 string from bytes. */
    T.str = function (u8, off, len) {
      let s = '';
      for (let i = off; i < off + len && i < u8.length; i++) {
        if (!u8[i]) break;
        s += String.fromCharCode(u8[i]);
      }
      return s.trim();
    };
    T.text = function (u8, off, len) {
      if (typeof TextDecoder !== 'undefined') return new TextDecoder('latin1').decode(u8.subarray(off, off + len));
      let s = '';
      for (let i = off; i < off + len; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(off + len, i + 8192)));
      return s;
    };

    const maxAbs = (a) => {
      let m = 0;
      for (let i = 0; i < a.length; i++) if (Math.abs(a[i]) > m && isFinite(a[i])) m = Math.abs(a[i]);
      return m;
    };

    /** Convert a canonical channel to SI in place, from its unit string or, failing that, its range. */
    T.toSI = function (key, unit, a) {
      const u = String(unit || '').toLowerCase().replace(/\s/g, '');
      let k = 1;
      if (key === 'speed') {
        if (/km\/?h|kph|kmh/.test(u)) k = 1 / 3.6;
        else if (/mph/.test(u)) k = 0.44704;
      } else if (key === 'throttle' || key === 'brake') {
        if (u === '%' || /pct|percent/.test(u)) k = 0.01;
        else if (!u || u === 'raw') k = maxAbs(a) > 1.5 ? (maxAbs(a) > 101 ? 1 / maxAbs(a) : 0.01) : 1;
        else if (maxAbs(a) > 1.5) k = 1 / maxAbs(a); // a pressure (bar, psi, kPa): show it as a share of the peak
      } else if (key === 'steer' || key === 'yaw') {
        if (/deg|°/.test(u)) k = Math.PI / 180;
        else if (!u && maxAbs(a) > 7) k = Math.PI / 180;
      } else if (key === 'yawRate') {
        if (/deg|°/.test(u)) k = Math.PI / 180;
      } else if (key === 'vx' || key === 'vy' || /^ws/.test(key)) {
        if (/km\/?h|kph|kmh/.test(u)) k = 1 / 3.6;
        else if (/mph/.test(u)) k = 0.44704;
      } else if (key === 'roll' || key === 'pitch') {
        if (/deg|°/.test(u)) k = Math.PI / 180;
      } else if (key === 'latG' || key === 'longG' || key === 'vertG') {
        if (u === 'g' || /^g$/.test(u) || (!/m\/s/.test(u) && maxAbs(a) < 6)) k = 9.80665;
      } else if (key === 't') {
        if (u === 'ms') k = 0.001;
        else if (u === 'us' || u === 'µs') k = 1e-6;
      } else if (key === 'lapDist' || key === 'x' || key === 'y' || key === 'z' || key === 'alt') {
        if (u === 'km') k = 1000;
        else if (u === 'ft') k = 0.3048;
        else if (u === 'mi') k = 1609.344;
      } else if (key === 'lapPct') {
        if (u === '%' || maxAbs(a) > 1.5) k = 0.01;
      }
      if (k !== 1) for (let i = 0; i < a.length; i++) a[i] *= k;
      return a;
    };

    /** Linear resample of a channel sampled at fSrc Hz to n samples at fDst Hz (gear-like channels step). */
    T.resample = function (src, fSrc, n, fDst, step) {
      const out = new Float64Array(n);
      const r = fSrc / fDst, last = src.length - 1;
      for (let i = 0; i < n; i++) {
        const f = i * r;
        const j = Math.min(last, Math.floor(f));
        const k = Math.min(last, j + 1);
        out[i] = step ? src[j] : src[j] + (src[k] - src[j]) * (f - j);
      }
      return out;
    };

    /** Build the common session record, filling dropouts (NaN) with the last good value. */
    T.session = function (o) {
      const ch = {};
      for (const k in o.ch) {
        const a = o.ch[k];
        if (!a || !a.length) continue;
        let last = NaN, first = -1;
        for (let i = 0; i < a.length; i++) {
          if (isFinite(a[i])) {
            if (first < 0) first = i;
            last = a[i];
          } else a[i] = last;
        }
        if (first < 0) continue; // all empty
        for (let i = 0; i < first; i++) a[i] = a[first];
        ch[k] = a;
      }
      const n = o.n;
      let rate = o.rate;
      if (!rate && ch.t && n > 2) {
        const dts = [];
        for (let i = 1; i < Math.min(n, 2000); i++) if (ch.t[i] > ch.t[i - 1]) dts.push(ch.t[i] - ch.t[i - 1]);
        dts.sort((a, b) => a - b);
        rate = dts.length ? 1 / dts[dts.length >> 1] : 60;
      }
      return { format: o.format, name: o.name, meta: o.meta || {}, n, rate: rate || 60, ch, units: o.units || {}, beacons: o.beacons || null, warnings: o.warnings || [] };
    };

    /** Pick the format for a file: by its sniff() on the first bytes, then by extension. */
    T.pick = function (name, u8) {
      for (const k in T.formats) if (T.formats[k].sniff && T.formats[k].sniff(u8, name)) return T.formats[k];
      const ext = (String(name).match(/\.([a-z0-9]+)$/i) || [])[1];
      for (const k in T.formats) if (ext && T.formats[k].exts.indexOf(ext.toLowerCase()) >= 0) return T.formats[k];
      return null;
    };
  });
})();
