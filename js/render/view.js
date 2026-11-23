/*
 * In-car view: one set of camera + cockpit settings shared by every drill that shows
 * the road from the driver's seat (saved as the 'view' pref, edited on the View
 * screen with a live preview).
 *
 * FOV is Hor+: the value is the horizontal FOV a 16:9 screen would have, so wider
 * screens see more at the sides and taller ones more top and bottom, and the cockpit
 * framing holds on any aspect ratio. Horizon is a lens shift (where the horizon sits
 * on screen); seat height / fore-aft move the eye, which also moves the camera above
 * the road and re-projects the cockpit with parallax.
 *
 *   const V = IST.View.get();
 *   IST.View.apply(R, W, H, V);          // before R.prepare / R.render
 *   const C = IST.View.cockpit(V, theme); // IST.Cockpit or null when off
 */
(function () {
  'use strict';
  const U = IST.util;
  const EYE_H = 1.05; // m above the road at the reference seat (GT3)

  const DEFAULTS = { cockpit: true, fov: 54, horizon: 37, seatY: 0, seatZ: 0, wheel: true, body: 'pearl' };
  const LIMITS = { fov: [36, 100], horizon: [20, 80], seatY: [-12, 12], seatZ: [-15, 15] };

  function clean(v) {
    const out = Object.assign({}, DEFAULTS, v || {});
    for (const k in LIMITS) out[k] = U.isNum(+out[k]) ? U.clamp(+out[k], LIMITS[k][0], LIMITS[k][1]) : DEFAULTS[k];
    if (!IST.Cockpit.BODY[out.body]) out.body = DEFAULTS.body;
    out.cockpit = !!out.cockpit;
    out.wheel = !!out.wheel;
    return out;
  }

  IST.View = {
    DEFAULTS, LIMITS, EYE_H,
    get: () => clean(IST.Storage.getPref('view', null)),
    set: (v) => IST.Storage.setPref('view', clean(v)),
    reset: () => IST.Storage.setPref('view', Object.assign({}, DEFAULTS)),
    /** Horizontal FOV (deg) for a W x H view. */
    fovFor(v, W, H) {
      const t = Math.tan((v.fov * Math.PI) / 360) * (W / Math.max(1, H)) / (16 / 9);
      return (2 * Math.atan(t) * 180) / Math.PI;
    },
    seat: (v) => ({ x: 0, y: v.seatY / 100, z: v.seatZ / 100 }),
    apply(R, W, H, v) {
      R.fov = IST.View.fovFor(v, W, H);
      R.horizonFrac = v.horizon / 100;
      R.camH = EYE_H + v.seatY / 100;
    },
    cockpit: (v, theme) => (v.cockpit ? new IST.Cockpit({ body: v.body, wheel: v.wheel, night: theme === 'minimal' }) : null),
  };
})();
