/*
 * What the 3D view can draw on top of the laps, shared by the scene, the
 * overlay and the page's Layers drawer.
 *
 *   Layers.PAINTS     line colour choices  [{ key, label, needs, title, legend }]
 *   Layers.FENCES     fence choices        [{ key, label, needs, cmp?, title }]  (cmp: needs a lap to compare)
 *   Layers.MARKERS    marker toggles       [{ key, label, kinds, color, label?, pip, def, title }]
 *   Layers.paint(key, L, i, ctx) -> [r, g, b] (0..1) for lap L at index i
 *   Layers.eventLabel(e)         -> "Entry US 14°", or '' for events shown without a label
 *   Layers.markerFor(kind)       -> the MARKERS entry an event kind belongs to
 *   Layers.nose(L, i)            -> body slip, rad, + = nose left of travel (NaN when unknown)
 *   Layers.attitudeColor(L, i)   -> wedge colour from the excess sideslip (betaX)
 *   Layers.rgb('#rrggbb')        -> [r, g, b]
 *
 * Colours come from IST.Theme so the paint matches the page. "No data" (low
 * speed, missing channel) is a dark slate, kept apart from the neutral grey
 * that means "balanced" or "no gain".
 */
(function () {
  'use strict';
  IST.Review = IST.Review || {};
  const Th = IST.Theme, DEG = Math.PI / 180;
  const rgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  };
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const NODATA = [0.2, 0.23, 0.28], NEUTRAL = rgb('#a1a9b7');
  const SKY = rgb(Th.sky), PEACH = rgb(Th.peach), ROSE = rgb(Th.rose), BUTTER = rgb(Th.butter), MINT = rgb(Th.mint), SLATE = rgb(Th.lineStrong);

  const PAINTS = [
    { key: 'lap', label: 'Lap colour', needs: [], title: 'Each lap in its own colour' },
    { key: 'balance', label: 'Balance', needs: ['us'], title: 'Understeer (sky) to oversteer (peach, rose): extra or missing steering lock against what the car’s yaw needed',
      legend: { css: 'linear-gradient(90deg, ' + Th.sky + ', #a1a9b7, ' + Th.peach + ', ' + Th.rose + ')', lo: 'Understeer', hi: 'Oversteer' } },
    { key: 'grip', label: 'Grip used', needs: ['gripUse'], title: 'Combined g against this session’s own limit at that speed: slate (40 %) to butter (100 %), rose past it',
      legend: { css: 'linear-gradient(90deg, ' + Th.lineStrong + ', ' + Th.butter + ' 85%, ' + Th.rose + ')', lo: '40 %', hi: '110 %' } },
    { key: 'gain', label: 'Time gain / loss', needs: [], cmp: true, title: 'Where each lap gains (mint) or loses (rose) time on the reference, per 100 m',
      legend: { css: 'linear-gradient(90deg, ' + Th.mint + ', #a1a9b7, ' + Th.rose + ')', lo: 'Gaining', hi: 'Losing' } },
    { key: 'speed', label: 'Speed', needs: ['speed'], title: 'Slow (sky) to fast (rose), over each lap’s own range',
      legend: { css: 'linear-gradient(90deg, ' + Th.sky + ', ' + Th.butter + ', ' + Th.rose + ')', lo: 'Slow', hi: 'Fast' } },
  ];
  const FENCES = [
    { key: 'inputs', label: 'Inputs', needs: [], title: 'Throttle (green) and brake (red), with ABS striped on the brake' },
    { key: 'balance', label: 'Balance', needs: ['us'], title: 'Height = understeer (sky) or oversteer (peach), up to 20° of steering wheel' },
    { key: 'grip', label: 'Grip used', needs: ['gripUse'], title: 'Height = share of this session’s grip at that speed; rose above 100 %' },
    { key: 'delta', label: 'Delta', needs: [], cmp: true, title: 'Height = how far one lap is behind or ahead of the reference at that point; fill = where it gains (mint) or loses (rose) time. One lap at a time: with 3 or more laps, pick it in Whose' },
    { key: 'none', label: 'None', needs: [], title: 'No fence' },
  ];
  const MARKERS = [
    { key: 'us', label: 'Understeer', kinds: ['us'], color: Th.sky, pip: true, def: true, title: 'More lock than the car’s yaw needed, past half its grip' },
    { key: 'os', label: 'Oversteer / slides', kinds: ['os', 'counter'], color: Th.peach, pip: true, def: true, title: 'Rear slipping more than the front, or more sideways than usual at that lateral g; countersteer' },
    { key: 'abs', label: 'ABS', kinds: ['abs'], color: '#ff453a', pip: false, def: false, title: 'Where ABS was cutting brake force' },
    { key: 'lock', label: 'Lockups', kinds: ['lock'], color: Th.rose, pip: true, def: true, title: 'A wheel 15 % slower than the car under braking for 0.1 s or more' },
    { key: 'spin', label: 'Wheelspin', kinds: ['spin'], color: Th.mint, pip: true, def: false, title: 'A wheel 10 % faster than the car on throttle for 0.1 s or more' },
    { key: 'kerb', label: 'Kerbs', kinds: ['kerb'], color: Th.lilac, pip: false, def: false, title: 'On rumble strips' },
    { key: 'off', label: 'Off track', kinds: ['off'], color: Th.rose, pip: true, def: true, title: 'All four wheels off the track' },
    { key: 'crash', label: 'Contact', kinds: ['crash'], color: '#ff7a3d', pip: true, def: true, title: 'An impact: g or a sudden speed loss beyond anything the tyres can give' },
    { key: 'coast', label: 'Coasting', kinds: ['coast'], color: Th.dim, pip: false, def: false, title: 'Neither pedal for 0.25 s or more at speed: time lost' },
    { key: 'settings', label: 'Setting changes', kinds: ['bbChange'], color: Th.butter, pip: true, def: false, title: 'Brake bias, ABS or TC changed in the car' },
    { key: 'attitude', label: 'Attitude', needs: ['vx', 'vy'], color: Th.peach, pip: true, def: false,
      title: 'Arrows where the nose points, with the angle to the direction of travel shaded: sky = less rotation than usual at that lateral g, grey = usual, peach / rose = more (a slide). The cars yaw by it too' },
    { key: 'gears', label: 'Gear numbers', def: true, title: 'A post and the new gear at every shift' },
    { key: 'tags', label: 'Lap tags', def: true, title: 'Lap labels along each line' },
  ];
  const byKind = {};
  MARKERS.forEach((m) => (m.kinds || []).forEach((k) => (byKind[k] = m)));

  /** Line colour for lap L at index i. ctx: { lo, hi } speed range of that lap. */
  function paint(key, L, i, ctx) {
    if (key === 'balance') {
      const v = L.us ? L.us[i] : NaN;
      if (!isFinite(v)) return NODATA;
      const d = Math.max(-20, Math.min(20, v / DEG)), t = Math.abs(d) / 20;
      const to = d >= 0 ? SKY : t < 0.5 ? PEACH : mix(PEACH, ROSE, (t - 0.5) * 2);
      return mix(NEUTRAL, to, clamp01(t * 1.6));
    }
    if (key === 'grip') {
      const v = L.gripUse ? L.gripUse[i] : NaN;
      if (!isFinite(v)) return NODATA;
      return v <= 1 ? mix(SLATE, BUTTER, clamp01((v - 0.4) / 0.6)) : mix(BUTTER, ROSE, clamp01((v - 1) / 0.1));
    }
    if (key === 'gain') {
      const v = L.gain ? L.gain[i] : NaN;
      if (!isFinite(v)) return NODATA;
      const t = clamp01(Math.abs(v) / 0.05);
      return mix(NEUTRAL, v < 0 ? MINT : ROSE, t);
    }
    if (key === 'speed') {
      const t = clamp01((L.speed[i] - ctx.lo) / (ctx.hi - ctx.lo || 1));
      return t < 0.5 ? mix(SKY, BUTTER, t * 2) : mix(BUTTER, ROSE, (t - 0.5) * 2);
    }
    return null;
  }

  /**
   * Body slip at lap index i, rad: how far the nose points left (+) or right (-) of
   * where the car is travelling, from the body velocities. NaN at low speed or without them.
   */
  function nose(L, i) {
    if (!L.vx || !L.vy || !(L.speed[i] > 12)) return NaN;
    const a = -Math.atan2(L.vy[i], Math.max(1, L.vx[i]));
    return isFinite(a) ? Math.max(-35 * DEG, Math.min(35 * DEG, a)) : NaN;
  }
  /** Wedge colour for lap L at i: excess sideslip against this session's usual at that lateral g. */
  function attitudeColor(L, i) {
    const x = L.betaX ? L.betaX[i] / DEG : NaN;
    if (!isFinite(x)) return NEUTRAL;
    if (x < -1) return mix(NEUTRAL, SKY, clamp01((-x - 1) / 2));
    if (x <= 1.5) return NEUTRAL;
    return x < 4 ? mix(NEUTRAL, PEACH, clamp01((x - 1.5) / 1.5)) : mix(PEACH, ROSE, clamp01((x - 4) / 3));
  }

  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) + ' ' : '');
  function eventLabel(e) {
    switch (e.kind) {
      case 'us': return cap(e.phase) + 'US ' + Math.round(e.peak) + '°';
      case 'os': return e.slide ? 'Slide ' + e.slide.toFixed(1) + '°' : cap(e.phase) + 'OS ' + Math.round(e.peak) + '°';
      case 'counter': return 'Countersteer';
      case 'lock': return 'Lock ' + (e.wheel || '');
      case 'spin': return 'Wheelspin';
      case 'off': return 'Off track';
      case 'crash': return 'Contact';
      case 'coast': return 'Coast ' + e.dur.toFixed(1) + ' s';
      case 'bbChange': return e.what + ' ' + e.from + '→' + e.to;
      default: return '';
    }
  }

  IST.Review.Layers = { PAINTS, FENCES, MARKERS, paint, eventLabel, markerFor: (k) => byKind[k], nose, attitudeColor, rgb, mix, NODATA };
})();
