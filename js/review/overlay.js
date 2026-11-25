/*
 * The 2D labels drawn over the 3D view: car chips with the gap to the
 * reference, cursor posts, lap tags along each line, gear numbers and the
 * ends of a zoomed stretch.
 *
 *   const ov = IST.Review.Overlay.create()
 *   ov.draw(g, W, H, f)    f: { vp, scene, cmp, cursorF, cars, gaps, range, gears, tags, fences, markers, chipsBeside, dt }
 *     markers: Set of event kinds (derive.js) to mark: a pip at each event's peak, and a
 *           label chip ("Entry US 14°") within LABEL_DIST of the camera or near the cursor
 *           gaps[k]: lap k's distance behind the reference (m), for the cursor posts
 *     attitude: add slip angle and yaw rate to the car chips (cars carry slip, j)
 *     cars: [{ k, j, pose, gapM, slip }] one per lap, at where that lap was at the
 *           reference's time (k = 0 is the reference, at the cursor)
 *
 * Labels never pop: each has an opacity that eases toward shown or hidden,
 * labels already showing win the space over new ones, and stacked car chips
 * slide rather than jump. Everything is placed from the same matrix as the
 * frame it's drawn on, at fractional positions, so it moves with the scene.
 */
(function () {
  'use strict';
  const POST_GAP = 25; // m
  const Th = IST.Theme, M = IST.Review.M3, FONT = IST.Symbols.FONT;
  const FADE = 9; // per second
  const LABEL_DIST = 350, NEAR_CURSOR = 60; // m
  const Ly = IST.Review.Layers;

  function diamond(g, x, y, r) {
    g.beginPath();
    g.moveTo(x, y - r);
    g.lineTo(x + r, y);
    g.lineTo(x, y + r);
    g.lineTo(x - r, y);
    g.closePath();
    g.fill();
  }

  function create() {
    const mem = new Map(); // label key -> { a: opacity, y: eased stack offset }
    const slot = (key) => {
      let m = mem.get(key);
      if (!m) mem.set(key, (m = { a: 0, y: 0, used: 0 }));
      return m;
    };
    let frameNo = 0;

    function draw(g, W, H, f) {
      frameNo++;
      g.clearRect(0, 0, W, H);
      const S = f.scene, cmp = f.cmp, vp = f.vp, top = S.fenceH * 1.25;
      const k = 1 - Math.exp(-FADE * (f.dt || 0.016));
      const taken = [];
      const overlaps = (r) => taken.some((t) => r[0] < t[0] + t[2] && r[0] + r[2] > t[0] && r[1] < t[1] + t[3] && r[1] + r[3] > t[1]);
      const proj = (p, dy) => M.project(vp, p[0], p[1] + (dy || 0), p[2], W, H);
      const onScreen = (p, pad) => p.w > 0 && p.x > -pad && p.y > -pad && p.x < W + pad && p.y < H + pad;
      g.textBaseline = 'middle';

      // ---- zoomed stretch ends
      if (f.range) {
        const P = S.base[0];
        g.strokeStyle = Th.butter;
        g.lineWidth = 1.5;
        g.setLineDash([5, 4]);
        f.range.forEach((i) => {
          const b = proj([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]), t = proj([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], top * 1.4);
          if (b.w <= 0 || t.w <= 0) return;
          g.beginPath();
          g.moveTo(b.x, b.y);
          g.lineTo(t.x, t.y);
          g.stroke();
        });
        g.setLineDash([]);
      }

      // ---- cursor posts: every lap at the same distance as the reference. A lap more
      // than POST_GAP behind or ahead is left out: its car is far from the cursor, so a
      // post there reads as a second car rather than a comparison of lines.
      if (f.cursorF >= 0) {
        cmp.laps.forEach((L, li) => {
          if (li && f.gaps && Math.abs(f.gaps[li]) > POST_GAP) return;
          const q = IST.Review.Rigs.pose(S, li, f.cursorF);
          const b = proj(q.p), t = proj(q.p, top);
          if (b.w <= 0 || t.w <= 0) return;
          g.strokeStyle = L.color;
          g.globalAlpha = 0.7;
          g.lineWidth = 1.5;
          g.beginPath();
          g.moveTo(b.x, b.y);
          g.lineTo(t.x, t.y);
          g.stroke();
          g.globalAlpha = 1;
          g.fillStyle = L.color;
          g.fillRect(b.x - 3, b.y - 3, 6, 6);
        });
      }

      // ---- car chips: lap, gap, and a leader line to the car
      const i = Math.round(Math.max(0, f.cursorF));
      (f.cars || []).forEach((c) => {
        const L = cmp.laps[c.k];
        const roof = proj(c.pose.p, 1.4);
        if (!onScreen(roof, 60)) return;
        const isRef = c.k === 0;
        const tag = 'L' + L.lap.lapNo;
        let main, sub;
        if (isRef) {
          main = 'REF';
          sub = Math.round(L.speed[i] * 3.6) + ' km/h' + (L.gear ? ' · G' + Math.round(L.gear[i]) : '');
        } else {
          const d = L.delta[i];
          main = (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(3) + 's';
          sub = Math.abs(c.gapM) < 0.5 ? 'level' : Math.abs(c.gapM).toFixed(1) + ' m ' + (c.gapM > 0 ? 'behind' : 'ahead');
        }
        if (f.attitude && isFinite(c.slip)) {
          // slip signed by the turn (+ = nose into the corner) and the yaw rate
          const j = Math.round(c.j), b = L.beta && isFinite(L.beta[j]) ? L.beta[j] : Math.abs(c.slip);
          sub += ' · β ' + ((b * 180) / Math.PI).toFixed(1) + '°' + (L.yawRate ? ' · ' + Math.round(Math.abs(L.yawRate[j]) * 180 / Math.PI) + '°/s' : '');
        }
        g.font = '800 11px ' + FONT;
        const tw = g.measureText(tag).width + 10;
        g.font = '800 12.5px ' + FONT;
        const mw = g.measureText(main).width;
        g.font = '500 11px ' + FONT;
        const sw = g.measureText(sub).width;
        const w = tw + Math.max(mw, sw) + 16, hh = 34;
        // above the car, or beside it when looking straight down (so the road ahead stays clear);
        // stacked upward past chips already placed, easing toward that slot
        const m = slot('car' + c.k);
        const beside = f.chipsBeside;
        const bx = beside ? roof.x + 26 : roof.x - w / 2, by = beside ? roof.y - hh / 2 : roof.y - 18 - hh;
        const dir = -1;
        let off = 0;
        while (off < 5 && overlaps([bx, by + dir * off * (hh + 4), w, hh])) off++;
        const want = off * (hh + 4);
        m.y = m.used === frameNo - 1 ? m.y + (want - m.y) * k : want;
        m.used = frameNo;
        const x = bx, y = by + dir * m.y;
        taken.push([x, y, w, hh]);
        // leader
        g.strokeStyle = L.color;
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(roof.x, roof.y);
        if (beside) g.lineTo(x, y + hh / 2);
        else g.lineTo(roof.x, y + hh);
        g.stroke();
        // chip
        g.fillStyle = Th.shadow;
        g.fillRect(x + 2, y + 2, w, hh);
        g.fillStyle = Th.deep;
        g.fillRect(x, y, w, hh);
        g.fillStyle = L.color;
        g.fillRect(x, y, tw, hh);
        g.fillStyle = Th.ink;
        g.textAlign = 'center';
        g.font = '800 11px ' + FONT;
        g.fillText(tag, x + tw / 2, y + hh / 2 + 0.5);
        g.textAlign = 'left';
        g.font = '800 12.5px ' + FONT;
        g.fillStyle = isRef ? Th.butter : L.delta[i] > 0.0005 ? Th.rose : L.delta[i] < -0.0005 ? Th.mint : Th.text;
        g.fillText(main, x + tw + 8, y + 12);
        g.font = '500 11px ' + FONT;
        g.fillStyle = Th.dim;
        g.fillText(sub, x + tw + 8, y + 25);
      });

      // ---- event pips (labels join the fading labels below)
      const cand = [];
      if (f.markers && f.markers.size) {
        const cur = f.cursorF >= 0 ? f.cursorF : -1e9, near = NEAR_CURSOR / cmp.step;
        cmp.laps.forEach((L, li) => {
          if (f.fences && !f.fences[li]) return;
          const P = S.base[li];
          (L.events || []).forEach((e) => {
            if (!f.markers.has(e.kind)) return;
            const mk = Ly.markerFor(e.kind);
            if (!mk || !mk.pip) return;
            const i = e.iPeak, at = [P[i * 3], P[i * 3 + 1] + 0.4, P[i * 3 + 2]], p = proj(at);
            if (!onScreen(p, 10)) return;
            g.fillStyle = '#111317';
            diamond(g, p.x, p.y, 6);
            g.fillStyle = mk.color;
            diamond(g, p.x, p.y, 4);
            const close = Math.abs(i - cur) < near || (cur >= e.i0 && cur <= e.i1);
            const text = Ly.eventLabel(e);
            if (text && (p.w < LABEL_DIST || close)) cand.push({ key: 'e' + li + ':' + e.kind + ':' + e.i0, li, p: at, text, kind: 'event', color: mk.color, near: close ? 1 : 0 });
          });
        });
      }

      // ---- fading labels: event chips, lap tags along the lines and gear numbers
      if (f.tags) {
        const every = Math.round(200 / cmp.step);
        cmp.laps.forEach((L, li) => {
          const P = S.base[li], off = Math.round((60 + li * 37) / cmp.step);
          for (let j = off; j < cmp.n; j += every) cand.push({ key: 't' + li + ':' + j, li, p: [P[j * 3], P[j * 3 + 1] + 0.3, P[j * 3 + 2]], text: 'L' + L.lap.lapNo, kind: 'tag' });
        });
      }
      if (f.gears) {
        cmp.laps.forEach((L, li) => {
          if (f.fences && !f.fences[li]) return;
          const P = S.base[li];
          L.shifts.forEach((s) => cand.push({ key: 'g' + li + ':' + s.i, li, p: [P[s.i * 3], P[s.i * 3 + 1] + top, P[s.i * 3 + 2]], text: String(Math.round(s.to)), kind: 'gear' }));
        });
      }
      // labels already showing keep their place; new ones fit round them
      cand.forEach((c) => (c.m = slot(c.key)));
      cand.sort((a, b) => (b.near || 0) - (a.near || 0) || b.m.a - a.m.a);
      g.textAlign = 'center';
      cand.forEach((c) => {
        const p = proj(c.p);
        let want = false, r = null;
        if (onScreen(p, 10)) {
          if (c.kind === 'event') {
            g.font = '700 10.5px ' + FONT;
            const w = g.measureText(c.text).width + 14, hh = 17;
            r = [p.x - w / 2, p.y - 10 - hh, w, hh];
          } else {
            const w = c.kind === 'tag' ? 24 : 17, hh = c.kind === 'tag' ? 15 : 16;
            r = c.kind === 'tag' ? [p.x - w / 2, p.y - hh / 2, w, hh] : [p.x - w / 2, p.y - hh, w, hh];
          }
          // tags thin out with distance so the far track doesn't fill with them; gear
          // numbers keep a clear gap round each, so a tight complex shows one or two, not a wall
          const G = c.kind === 'gear' ? 9 : 0;
          want = !overlaps([r[0] - G, r[1] - G, r[2] + 2 * G, r[3] + 2 * G]) && (c.kind !== 'tag' || p.w < S.size * 0.9);
          if (want) taken.push(r);
        }
        c.m.a += ((want ? 1 : 0) - c.m.a) * k;
        if (c.m.a < 0.02 || !r) return;
        const L = cmp.laps[c.li];
        g.globalAlpha = c.m.a;
        if (c.kind === 'event') {
          g.fillStyle = Th.deep;
          g.fillRect(r[0], r[1], r[2], r[3]);
          g.fillStyle = c.color;
          g.fillRect(r[0], r[1], 3, r[3]);
          g.fillStyle = Th.text;
          g.font = '700 10.5px ' + FONT;
          g.fillText(c.text, r[0] + r[2] / 2 + 1.5, r[1] + r[3] / 2 + 0.5);
          g.globalAlpha = 1;
          return;
        }
        if (c.kind === 'tag') {
          g.fillStyle = Th.deep;
          g.fillRect(r[0], r[1], r[2], r[3]);
          g.strokeStyle = L.color;
          g.lineWidth = 1.5;
          g.strokeRect(r[0] + 0.75, r[1] + 0.75, r[2] - 1.5, r[3] - 1.5);
          g.fillStyle = L.color;
          g.font = '800 10px ' + FONT;
        } else {
          g.fillStyle = L.color;
          g.fillRect(r[0], r[1], r[2], r[3]);
          g.fillStyle = Th.ink;
          g.font = '800 11px ' + FONT;
        }
        g.fillText(c.text, r[0] + r[2] / 2, r[1] + r[3] / 2 + 0.5);
        g.globalAlpha = 1;
      });

      // forget labels that haven't been around for a while
      if (mem.size > 4000) mem.clear();
    }

    return { draw };
  }

  IST.Review.Overlay = { create };
})();
