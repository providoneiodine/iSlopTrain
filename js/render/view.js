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
 *
 * Trackside target boards (apex boards, hazard boards) share one size and one
 * visibility rule, so a flash counts as "in view" the same way in every drill
 * and on the View screen:
 *   IST.View.BOARD                          sizes and thresholds
 *   IST.View.boardSize(pr, minPx)           drawn edge, px
 *   IST.View.board(R, pos, x, o)            {x, y, size, rect, pr, cover, why}; why null = readable
 *   IST.View.boardVisible(R, pos, x, o)     the same, or null when not readable
 */
(function () {
  'use strict';
  const U = IST.util;
  const EYE_H = 1.05; // m above the road at the reference seat (GT3)

  const BOARD = {
    M: 2.4, // board edge, metres
    KERB: 1.07, // apex boards stand on the centre of the inside kerb (half-widths): fixating one = fixating the apex
    MIN_PX: 22, // smallest drawn edge unless a drill sets its own
    HIDE_AT: 0.1, // share of a board the cockpit may cover and still count as in view
    // Board centre at least this share of the width in from either side. On a single
    // screen a hairpin's apex sits at the very edge of the view until late, and a
    // flash out there is a coin toss rather than a test of where your eyes were.
    BAND: 0.1,
    EDGE: 0.02, // the whole board at least this share of the width inside the sides
    HUD_TOP: 0.08, // top share of the height kept for the HUD: board tops stay below it
    // A board must have been readable without a break for this long (ms) before it may
    // flash: eyes can't already be on a board that has only just come out from behind
    // the A-pillar or over a crest, so a flash there tests nothing.
    LEAD_MS: 400,
  };

  /**
   * Can a board standing at (pos, x) be read in R's prepared frame (after IST.View.apply
   * and R.prepare)? The whole board must be on screen and clear of the HUD band, its
   * bottom edge clear of nearer terrain, not yet fading out as you reach it, and no more
   * than HIDE_AT covered by the cockpit.
   *   o: { minPx, band, hudTop, cockpit (IST.Cockpit or null), seat, steer (wheel deg) }
   * why: null | 'off' | 'fade' | 'side' | 'hud' | 'below' | 'crest' | 'cockpit'
   * (x, y) is the board centre, as the boards are drawn; rect is [x0, y0, x1, y1].
   */
  function board(R, pos, x, o) {
    o = o || {};
    const pr = R.project(pos, x, 0);
    if (!pr) return { why: 'off', cover: 0 };
    const W = R.W, H = R.H;
    const size = boardSize(pr, o.minPx), half = size / 2;
    const band = o.band != null ? o.band : BOARD.BAND, hudTop = o.hudTop != null ? o.hudTop : BOARD.HUD_TOP;
    const out = { x: pr.x, y: pr.y - half, size, rect: [pr.x - half, pr.y - size, pr.x + half, pr.y], pr, cover: 0, why: null };
    if (IST.Symbols.boardFade(pr.dz) < 1) out.why = 'fade';
    else if (pr.x < W * band || pr.x > W * (1 - band) || pr.x - half < W * BOARD.EDGE || pr.x + half > W * (1 - BOARD.EDGE)) out.why = 'side';
    else if (pr.y - size < H * hudTop) out.why = 'hud';
    else if (pr.y > H) out.why = 'below';
    else if (pr.y > pr.clip + 0.5) out.why = 'crest';
    else if (o.cockpit) {
      o.cockpit.frameFor(R, o.seat);
      out.cover = o.cockpit.hidden(out.rect, o.steer || 0);
      if (out.cover > BOARD.HIDE_AT) out.why = 'cockpit';
    }
    return out;
  }
  function boardSize(pr, minPx) {
    return Math.max(minPx != null ? minPx : BOARD.MIN_PX, BOARD.M * pr.s);
  }

  // arrow: colour of a revealed board arrow (IST.Symbols.ARROW_COLORS)
  const DEFAULTS = { cockpit: true, fov: 54, horizon: 37, seatY: 0, seatZ: 0, wheel: true, body: 'pearl', arrow: 'purple' };
  const LIMITS = { fov: [36, 100], horizon: [20, 80], seatY: [-12, 12], seatZ: [-15, 15] };

  function clean(v) {
    const out = Object.assign({}, DEFAULTS, v || {});
    for (const k in LIMITS) out[k] = U.isNum(+out[k]) ? U.clamp(+out[k], LIMITS[k][0], LIMITS[k][1]) : DEFAULTS[k];
    if (!IST.Cockpit.BODY[out.body]) out.body = DEFAULTS.body;
    if (!IST.Symbols.ARROW_COLORS[out.arrow]) out.arrow = DEFAULTS.arrow;
    out.cockpit = !!out.cockpit;
    out.wheel = !!out.wheel;
    return out;
  }
  /** Reading the view also puts its arrow colour in force: every board drill reads it as it starts. */
  function current() {
    const v = clean(IST.Storage.getPref('view', null));
    IST.Symbols.REVEAL.fg = IST.Symbols.ARROW_COLORS[v.arrow];
    return v;
  }

  IST.View = {
    DEFAULTS, LIMITS, EYE_H, BOARD,
    board, boardSize,
    boardVisible: (R, pos, x, o) => {
      const b = board(R, pos, x, o);
      return b.why ? null : b;
    },
    get: current,
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
