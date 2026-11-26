/*
 * Track conditions of the compared laps, and where they differ.
 *
 *   IST.Review.Conditions.compare(conds)  conds: one lap.cond per lap, reference first
 *     -> { rows: [{ key, label, values: [text], raw, differs, apart }], differs: count }
 *        rows only for fields at least one lap has; `differs` when the spread is past
 *        the field's tolerance (numbers) or the labels disagree. A field one lap gives
 *        as a number and another as a label (rubber) is shown, not compared.
 *
 *   IST.Review.Conditions.wet(conds)  -> { level 0..1, laps: [bool], rain } or null when all dry
 *
 * The tolerances are rules of thumb for "enough to change grip or balance", not
 * thresholds from a study: see docs/METHODOLOGY.md (Lap Viewer · Conditions).
 */
(function () {
  'use strict';
  const pct = (v) => Math.round(v * 100) + ' %';
  const FIELDS = [
    { key: 'trackTemp', label: 'Track temp', tol: 3, unit: '°C', fmt: (v) => v.toFixed(1) + ' °C' },
    { key: 'airTemp', label: 'Air temp', tol: 3, unit: '°C', fmt: (v) => v.toFixed(1) + ' °C' },
    { key: 'wetness', label: 'Wetness', tol: 0.1, fmt: (v) => (v < 0.02 ? 'Dry' : pct(v)) },
    { key: 'precip', label: 'Rain', tol: 0.1, fmt: (v) => (v < 0.01 ? 'None' : pct(v)) },
    { key: 'rubber', label: 'Rubber', tol: 0.15, fmt: pct },
    { key: 'wind', label: 'Wind', tol: 3, unit: 'm/s', fmt: (v) => v.toFixed(1) + ' m/s' },
    { key: 'humidity', label: 'Humidity', tol: 0.15, fmt: pct },
    { key: 'skies', label: 'Skies' },
  ];

  const known = (v) => (typeof v === 'number' ? isFinite(v) : typeof v === 'string' && v.trim() !== '');
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function compare(conds) {
    const rows = [];
    FIELDS.forEach((F) => {
      const raw = conds.map((c) => (c && known(c[F.key]) ? c[F.key] : null));
      const have = raw.filter((v) => v != null);
      if (!have.length) return;
      const nums = have.filter((v) => typeof v === 'number'), strs = have.filter((v) => typeof v === 'string');
      let differs = false, apart = '';
      if (nums.length >= 2 && !strs.length && F.tol != null) {
        const spread = Math.max.apply(null, nums) - Math.min.apply(null, nums);
        differs = spread > F.tol;
        if (differs) apart = F.unit ? spread.toFixed(1) + ' ' + F.unit : Math.round(spread * 100) + ' pts';
      } else if (strs.length >= 2 && !nums.length) {
        differs = new Set(strs.map((s) => s.trim().toLowerCase())).size > 1;
      }
      const values = raw.map((v) => (v == null ? '–' : typeof v === 'number' ? (F.fmt ? F.fmt(v) : String(v)) : cap(v.trim())));
      rows.push({ key: F.key, label: F.label, values, raw, differs, apart });
    });
    return { rows, differs: rows.filter((r) => r.differs).length };
  }

  /** Which laps ran wet: track wetness past "mostly dry", or any real rain. Level is the wettest lap's. */
  function wet(conds) {
    let level = 0, rain = false;
    const laps = conds.map((c) => {
      const w = c && isFinite(c.wetness) ? c.wetness : 0, p = c && isFinite(c.precip) ? c.precip : 0;
      const on = w >= WET_MIN || p >= RAIN_MIN;
      if (on) level = Math.max(level, w, p);
      if (p >= RAIN_MIN) rain = true;
      return on;
    });
    return laps.some(Boolean) ? { level: Math.min(1, level), laps, rain } : null;
  }
  const WET_MIN = 0.15, RAIN_MIN = 0.02;

  IST.Review.Conditions = { FIELDS, compare, wet };
})();
