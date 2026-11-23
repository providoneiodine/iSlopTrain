/*
 * Hazard layer: threats on the outside of corners that compete with the apex
 * for your eyes (used by Eyes Off the Wall).
 *
 * Every hazard corner gets a barrier on the OUTSIDE, between turn-in and the
 * apex: the place you'd hit if you overcooked it. The barrier carries a
 * yellow-bordered hazard board with the same pattern mask as the apex board.
 * On probe trials both boards flash a DIFFERENT arrow for the same brief,
 * masked exposure. Only the board you were already looking at can be read,
 * so the arrow you report shows where your eyes were: apex or wall.
 *
 * On top of the barrier sits an event that makes it more salient:
 *   wall   - long concrete wall close to the edge (impact sparks when sudden)
 *   wreck  - a stopped car with hazard lights and smoke
 *   yellow - a marshal waving a yellow flag
 *   spin   - a car spinning off towards the barrier (always sudden)
 * "Sudden" events appear a short, random time before the flash, which is when
 * abrupt onsets capture the eyes most (Theeuwes et al., 1998).
 *
 * Threat level (1-6) sets how many corners have hazards, which kinds, how
 * often they appear suddenly, how close to the edge the barrier is, and
 * whether there is impact sound.
 *
 * Interface used by the drill:
 *   new IST.HazardLayer({track, rnd, level, audio, framing, boardThrough})
 *     boardThrough(pos, x, exposure) -> screen board {x, y, size} if it stays readable
 *     for the whole flash (IST.View.board), else null
 *   .plan(plan, ci, pos)       attach the corner's hazard + decoy arrow to a trial plan
 *   .arm(plan, W, apex)        at flash onset (apex: the apex board on screen): decide whether this is a probe trial
 *   .update(dt, clock, ts, pos)
 *   .sprites(pos, far, ts, plan, fb, boardSize, th) -> sprite[]
 *   .renderHUD(g, W, H, ts, clock)
 *   .framingAt(clock) -> 'approach' | 'avoid'
 *   .call(ts) -> {kind:'live'|'wall'|'none', hz, rt}    (call mode)
 *   .callSummary()                                      (call mode)
 *   .pause() .resume() .destroy()
 *
 * Call mode (o.call): live hazards (wreck, yellow, spin: something on or by the
 * track that changes what you'd do) must be called with Confirm; walls must
 * not, even when they spark. A hazard's call window opens once it has
 * appeared and is within CALL_AHEAD s, and closes as the car passes it. An
 * uncalled live hazard is reported through o.onMissed(hz) when it closes.
 */
(function () {
  'use strict';
  const U = IST.util, Sym = IST.Symbols;

  const LEVELS = [
    null,
    { rate: 0.35, types: ['wall', 'wreck'], pop: 0, gap: 5, lights: false, smoke: false, sound: false, soa: [0.6, 1.2] },
    { rate: 0.45, types: ['wall', 'wreck', 'yellow'], pop: 0.35, gap: 4, lights: true, smoke: false, sound: false, soa: [0.5, 1.0] },
    { rate: 0.55, types: ['wall', 'wreck', 'yellow'], pop: 0.55, gap: 3, lights: true, smoke: true, sound: false, soa: [0.35, 0.8] },
    { rate: 0.6, types: ['wall', 'wreck', 'yellow', 'spin'], pop: 0.65, gap: 2.2, lights: true, smoke: true, sound: false, soa: [0.25, 0.6] },
    { rate: 0.7, types: ['wall', 'wreck', 'yellow', 'spin'], pop: 0.75, gap: 1.6, lights: true, smoke: true, sound: true, soa: [0.15, 0.45] },
    { rate: 0.8, types: ['wall', 'wreck', 'yellow', 'spin'], pop: 0.85, gap: 1.2, lights: true, smoke: true, sound: true, soa: [0.1, 0.35] },
  ];
  const MAX_LEVEL = LEVELS.length - 1;
  const TYPE_LABELS = { wall: 'Wall', wreck: 'Wreck', yellow: 'Yellow flag', spin: 'Spinning car' };
  const CAR_COLORS = ['#d7263d', '#1b998b', '#f46036', '#2e86ab', '#e8e8e8', '#8e44ad', '#f1c40f', '#3d5a80'];
  const FRAME_BLOCK_MS = 40000;
  const CUES = { approach: 'Eyes: apex', avoid: "Don't look at the wall" };
  const SPIN_MS = 1400;
  const CALL_AHEAD = 3.5; // s: a hazard's call window opens this far ahead (once it has appeared)
  const CALL_PAST = 5; // m past the anchor: window closes (you're alongside it)
  const isLive = (type) => type !== 'wall';

  function HazardLayer(o) {
    this.o = o;
    this.t = o.track;
    this.rnd = o.rnd;
    this.level = U.clamp(Math.round(o.level || 1), 1, MAX_LEVEL);
    this.L = LEVELS[this.level];
    this.HW = this.t.HALF_W;
    this.framingStart = o.framing === 'compare' ? (this.rnd() < 0.5 ? 'approach' : 'avoid') : 'approach';
    this.lastFraming = null;
    this.banner = null; // {text, until}
    this.capFb = 0; // performance.now() until which "eyes on the wall" shows
    this.audio = null;
    this.lastPos = 0;
    this.byCorner = [];
    this.list = [];
    const t = this.t, L = this.L, rnd = this.rnd, HW = this.HW;
    t.corners.forEach((c, i) => {
      if (i === 0 || rnd() >= L.rate) return;
      // skip when the next corner's apex is right behind this one in the opposite
      // direction (chicane): its apex board would sit next to this barrier
      const nx = t.corners[i + 1];
      const anchor = c.startPos + (c.apexPos - c.startPos) * rnd.range(0.1, 0.55);
      if (nx && nx.dir !== c.dir && nx.apexPos - anchor < 70) return;
      const type = L.types[(rnd() * L.types.length) | 0];
      const side = -c.dir;
      const gap = L.gap * (type === 'wall' ? 0.7 : 1) + rnd.range(0, 0.6);
      const hz = {
        ci: i, type, side, gap, anchor,
        x: side * (HW + gap), // barrier face, lateral metres
        len: type === 'wall' ? [45, 30] : type === 'yellow' ? [9, 7] : [9, 20], // metres before / after the anchor
        pop: type === 'spin' || rnd() < L.pop,
        appearPos: -Infinity,
        appearTs: -Infinity,
        color: CAR_COLORS[(rnd() * CAR_COLORS.length) | 0],
        phase: rnd() * 1000,
        live: isLive(type),
        win: 0, // call window: 0 not yet open, 1 open, 2 closed
        openTs: null, calledTs: null, probeOutcome: null,
      };
      if (hz.pop) hz.appearPos = Math.max(0, c.startPos - 120); // overwritten when the trial is planned
      this.byCorner[i] = hz;
      this.list.push(hz);
    });
    this.falseNone = 0; // calls with no hazard in a call window
    if (o.audio && L.sound) this.initAudio();
  }
  HazardLayer.LEVELS = LEVELS;
  HazardLayer.MAX_LEVEL = MAX_LEVEL;
  HazardLayer.TYPE_LABELS = TYPE_LABELS;
  HazardLayer.isLive = isLive;
  HazardLayer.CUES = CUES;

  HazardLayer.prototype.framingAt = function (clock) {
    if (this.o.framing !== 'compare') return 'approach';
    const flip = Math.floor(clock / FRAME_BLOCK_MS) % 2 === 1;
    const other = this.framingStart === 'approach' ? 'avoid' : 'approach';
    return flip ? other : this.framingStart;
  };

  /** Attach the corner's hazard to a new trial plan and schedule a sudden event before its flash. */
  HazardLayer.prototype.plan = function (p, ci, pos) {
    const hz = this.byCorner[ci];
    if (!hz) return;
    p.hazard = hz;
    const others = Sym.DIRS.filter((d) => d !== p.dir);
    p.decoy = others[(this.rnd() * others.length) | 0];
    if (hz.pop && hz.appearTs === -Infinity) {
      const t = this.t;
      const soa = this.rnd.range(this.L.soa[0], this.L.soa[1]);
      hz.appearPos = Math.max(pos + 1, t.posAtTime(t.timeAt(p.onsetPos) - soa));
      p.soa = soa;
    }
  };

  /**
   * At flash onset: a probe needs the hazard board readable by the same rule as the apex
   * board, for the whole flash, and well apart from the apex board (a: its screen board).
   */
  HazardLayer.prototype.arm = function (p, W, a) {
    p.probe = false;
    const hz = p.hazard;
    if (!hz || !a) return;
    const b = this.o.boardThrough(hz.anchor, this.boardX(hz), p.exposure);
    if (b && Math.abs(a.x - b.x) >= Math.max(W * 0.07, 3 * a.size)) p.probe = true;
  };

  HazardLayer.prototype.boardX = function (hz) {
    return hz.side * (this.HW + hz.gap - 0.35); // just in front of the barrier
  };

  HazardLayer.prototype.update = function (dt, clock, ts, pos) {
    for (const hz of this.list) {
      if (hz.pop && hz.appearTs === -Infinity && this.lastPos < hz.appearPos && pos >= hz.appearPos) {
        hz.appearTs = ts;
        if (this.L.sound) this.impact(hz.type);
      }
    }
    this.lastPos = pos;
    if (this.o.call) this.updateCalls(ts, pos);
    const f = this.framingAt(clock);
    if (this.o.framing === 'compare' && f !== this.lastFraming) {
      this.banner = { text: CUES[f], until: performance.now() + 2600 };
    }
    this.lastFraming = f;
  };

  HazardLayer.prototype.updateCalls = function (ts, pos) {
    const t = this.t, tNow = t.timeAt(pos);
    for (const hz of this.list) {
      if (hz.win === 2) continue;
      if (pos > hz.anchor + CALL_PAST) {
        const wasOpen = hz.win === 1;
        hz.win = 2;
        if (wasOpen && hz.live && hz.calledTs == null && this.o.onMissed) this.o.onMissed(hz);
        continue;
      }
      const appeared = !hz.pop || hz.appearTs !== -Infinity;
      if (hz.win === 0 && appeared && t.timeAt(hz.anchor) - tNow <= CALL_AHEAD) {
        hz.win = 1;
        hz.openTs = ts;
      }
    }
  };

  /** Confirm pressed in call mode: credit the nearest hazard in its call window. */
  HazardLayer.prototype.call = function (ts) {
    let best = null;
    for (const hz of this.list) {
      if (hz.win === 1 && hz.calledTs == null && (!best || hz.anchor < best.anchor)) best = hz;
    }
    if (!best) {
      this.falseNone++;
      return { kind: 'none' };
    }
    best.calledTs = ts;
    return { kind: best.live ? 'live' : 'wall', hz: best, rt: ts - best.openTs };
  };

  /** Call-mode tallies over hazards whose call window has opened. */
  HazardLayer.prototype.callSummary = function () {
    const seen = this.list.filter((hz) => hz.win > 0);
    const live = seen.filter((hz) => hz.live && (hz.win === 2 || hz.calledTs != null));
    const walls = seen.filter((hz) => !hz.live && hz.win === 2);
    const called = live.filter((hz) => hz.calledTs != null);
    const wallCalls = seen.filter((hz) => !hz.live && hz.calledTs != null).length;
    const tally = (arr, hit) => {
      const o = {};
      for (const hz of arr) {
        const e = (o[hz.type] = o[hz.type] || [0, 0]);
        e[0]++;
        if (hit(hz)) e[1]++;
      }
      return o;
    };
    const suddenRTs = called.filter((hz) => hz.pop).map((hz) => hz.calledTs - hz.openTs);
    return {
      live: live.length, called: called.length, walls: walls.length, wallCalls, noneCalls: this.falseNone,
      callRT: suddenRTs.length ? U.median(suddenRTs) : null,
      callByHz: tally(live.concat(walls), (hz) => hz.calledTs != null),
    };
  };

  HazardLayer.prototype.captured = function () {
    this.capFb = performance.now() + 650;
  };

  // ------------------------------------------------------------------ audio
  HazardLayer.prototype.initAudio = function () {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ac = new AC();
      const len = Math.floor(ac.sampleRate * 0.5);
      const buf = ac.createBuffer(1, len, ac.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      if (ac.state === 'suspended') ac.resume().catch(() => {});
      this.audio = { ac, buf };
    } catch (e) {
      this.audio = null;
    }
  };

  HazardLayer.prototype.impact = function (type) {
    const A = this.audio;
    if (A) {
      try {
        const src = A.ac.createBufferSource();
        src.buffer = A.buf;
        const lp = A.ac.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = type === 'yellow' ? 2400 : 900;
        const gain = A.ac.createGain();
        gain.gain.value = type === 'yellow' ? 0.08 : 0.35;
        src.connect(lp);
        lp.connect(gain);
        gain.connect(A.ac.destination);
        src.start();
      } catch (e) {
        /* audio unavailable */
      }
    }
    if (type === 'yellow' && this.o.audio && window.speechSynthesis && window.SpeechSynthesisUtterance) {
      try {
        const u = new SpeechSynthesisUtterance('Yellow, yellow');
        u.rate = 1.4;
        speechSynthesis.speak(u);
      } catch (e) {
        /* speech unavailable */
      }
    }
  };

  HazardLayer.prototype.pause = function () {
    if (this.audio) this.audio.ac.suspend().catch(() => {});
    if (window.speechSynthesis) speechSynthesis.cancel();
  };
  HazardLayer.prototype.resume = function () {
    if (this.audio) this.audio.ac.resume().catch(() => {});
  };
  HazardLayer.prototype.destroy = function () {
    if (window.speechSynthesis) speechSynthesis.cancel();
    if (this.audio) {
      try {
        this.audio.ac.close();
      } catch (e) {
        /* already closed */
      }
    }
  };

  // ---------------------------------------------------------------- drawing
  const shade = (hex, fog) => {
    const n = parseInt(hex.slice(1), 16);
    return U.rgb(U.mix([(n >> 16) & 255, (n >> 8) & 255, n & 255], [182, 202, 220], fog * 0.7));
  };

  /** One 5 m barrier panel from pos to pos+len, drawn as a perspective quad. */
  function drawPanel(g, pr, R, hz, pos, len, isWall, ts, idx) {
    const pr2 = R.project(pos + len, hz.x, 0);
    if (!pr2) return;
    const hgt = isWall ? 1.15 : 0.85;
    const top1 = pr.y - hgt * pr.s, top2 = pr2.y - hgt * pr2.s;
    g.globalAlpha = 1 - pr.fog * 0.6;
    g.fillStyle = isWall ? shade(idx % 2 ? '#b9bbbf' : '#aeb1b6', pr.fog) : shade('#202226', pr.fog);
    g.beginPath();
    g.moveTo(pr.x, pr.y);
    g.lineTo(pr2.x, pr2.y);
    g.lineTo(pr2.x, top2);
    g.lineTo(pr.x, top1);
    g.closePath();
    g.fill();
    // top band: red/white on walls, white strap on tyre stacks
    g.fillStyle = isWall ? (idx % 2 ? '#d8282b' : '#f0f0f0') : '#d9d9d9';
    const b = isWall ? 0.18 : 0.12;
    g.beginPath();
    g.moveTo(pr.x, top1);
    g.lineTo(pr2.x, top2);
    g.lineTo(pr2.x, top2 + b * pr2.s);
    g.lineTo(pr.x, top1 + b * pr.s);
    g.closePath();
    g.fill();
    if (isWall && idx % 3 === 1) {
      // scuff marks from earlier impacts
      g.strokeStyle = 'rgba(20,20,20,.55)';
      g.lineWidth = Math.max(1, 0.06 * pr.s);
      g.beginPath();
      g.moveTo(pr.x, pr.y - 0.35 * pr.s);
      g.lineTo(pr2.x, pr2.y - 0.55 * pr2.s);
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  function sideCar(g, pr, color, ts, lights, widthM) {
    const s = pr.s, w = (widthM || 4.3) * s, h = 1.05 * s, x = pr.x, yb = pr.y;
    if (w < 3) {
      g.fillStyle = color;
      g.fillRect(x - w / 2, yb - h, Math.max(1, w), Math.max(1, h));
      return;
    }
    g.fillStyle = 'rgba(0,0,0,.35)';
    g.fillRect(x - w * 0.52, yb - h * 0.08, w * 1.04, h * 0.12);
    g.fillStyle = color;
    Sym.roundRect(g, x - w / 2, yb - h * 0.75, w, h * 0.5, h * 0.15);
    g.fill();
    g.fillStyle = '#1a1a1a';
    Sym.roundRect(g, x - w * 0.18, yb - h * 1.0, w * 0.34, h * 0.3, h * 0.1);
    g.fill();
    g.fillRect(x - w * 0.5, yb - h * 0.95, w * 0.1, h * 0.25); // rear wing
    g.beginPath();
    g.arc(x - w * 0.3, yb - h * 0.22, h * 0.22, 0, Math.PI * 2);
    g.arc(x + w * 0.3, yb - h * 0.22, h * 0.22, 0, Math.PI * 2);
    g.fill();
    if (lights && ts % 700 < 350) {
      g.shadowColor = 'rgba(255,170,0,.95)';
      g.shadowBlur = Math.max(4, h * 0.6);
      g.fillStyle = '#ffb000';
      g.fillRect(x - w * 0.5, yb - h * 0.62, w * 0.06, h * 0.14);
      g.fillRect(x + w * 0.44, yb - h * 0.62, w * 0.06, h * 0.14);
      g.shadowBlur = 0;
    }
  }

  function smoke(g, pr, ts, phase, color, n, rise) {
    for (let k = 0; k < n; k++) {
      const t = ((ts + phase + k * 450) % 1800) / 1800;
      const r = (0.6 + t * 1.6) * pr.s;
      g.globalAlpha = (1 - t) * 0.45 * (1 - pr.fog * 0.6);
      g.fillStyle = color;
      g.beginPath();
      g.arc(pr.x + Math.sin(k * 2.1 + t * 2) * 0.8 * pr.s, pr.y - (0.8 + t * rise) * pr.s, r, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  function sparks(g, pr, age) {
    const t = age / 600;
    if (t >= 1) return;
    g.globalAlpha = 1 - t;
    g.fillStyle = '#ffd34d';
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * Math.PI - Math.PI;
      const d = (0.3 + t * 2.2) * pr.s * (0.6 + (k % 3) * 0.25);
      g.fillRect(pr.x + Math.cos(a) * d, pr.y - 0.6 * pr.s + Math.sin(a) * d, Math.max(1.5, 0.12 * pr.s), Math.max(1.5, 0.12 * pr.s));
    }
    g.globalAlpha = 1;
  }

  function marshal(g, pr, ts, waving, phase) {
    const s = pr.s, x = pr.x, yb = pr.y;
    g.globalAlpha = 1 - pr.fog * 0.6;
    g.fillStyle = '#f26a1b'; // orange overalls
    g.fillRect(x - 0.22 * s, yb - 1.45 * s, 0.44 * s, 0.85 * s);
    g.fillStyle = '#2b2b2b';
    g.fillRect(x - 0.2 * s, yb - 0.6 * s, 0.15 * s, 0.6 * s);
    g.fillRect(x + 0.05 * s, yb - 0.6 * s, 0.15 * s, 0.6 * s);
    g.fillStyle = '#e8c39e';
    g.beginPath();
    g.arc(x, yb - 1.62 * s, 0.17 * s, 0, Math.PI * 2);
    g.fill();
    const hx = x + 0.25 * s, hy = yb - 1.5 * s;
    if (waving) {
      const sw = Math.sin((ts + phase) / 110);
      const tipX = hx + sw * 0.9 * s, tipY = hy - 1.0 * s;
      g.strokeStyle = '#ccc';
      g.lineWidth = Math.max(1, 0.05 * s);
      g.beginPath();
      g.moveTo(hx, hy);
      g.lineTo(tipX, tipY);
      g.stroke();
      g.fillStyle = '#ffd400';
      g.beginPath();
      g.moveTo(tipX, tipY);
      g.lineTo(tipX + (sw > 0 ? -1 : 1) * 1.1 * s, tipY + 0.15 * s + Math.cos((ts + phase) / 90) * 0.12 * s);
      g.lineTo(tipX + (sw > 0 ? -1 : 1) * 1.0 * s, tipY + 0.85 * s);
      g.lineTo(tipX, tipY + 0.7 * s);
      g.closePath();
      g.fill();
    } else {
      g.fillStyle = '#c9a800'; // furled flag
      g.fillRect(hx, hy - 0.9 * s, Math.max(1, 0.08 * s), 0.9 * s);
    }
    g.globalAlpha = 1;
  }

  /** Yellow/black bordered hazard board: same mask as the apex board, different frame. */
  function hazardBoard(g, x, cy, size, content, th) {
    const half = size / 2;
    Sym.roundRect(g, x - half, cy - half, size, size, size * 0.14);
    g.fillStyle = th.boardBg;
    g.fill();
    g.lineWidth = Math.max(2, size * 0.1);
    g.strokeStyle = '#ffcc00';
    g.stroke();
    g.setLineDash([Math.max(2, size * 0.12), Math.max(2, size * 0.12)]);
    g.strokeStyle = '#111';
    g.stroke();
    g.setLineDash([]);
    const inner = size * 0.7;
    if (content === 'mask') Sym.mask(g, x, cy, inner, th.boardFg);
    else Sym.arrow(g, x, cy, inner, content, th.boardFg);
  }

  HazardLayer.prototype.sprites = function (pos, far, ts, plan, fb, boardSize, th) {
    const out = [], L = this.L;
    for (const hz of this.list) {
      const from = hz.anchor - hz.len[0], to = hz.anchor + hz.len[1];
      if (to < pos || from > far) continue;
      const isWall = hz.type === 'wall';
      // barrier panels
      let idx = 0;
      for (let p = from; p < to; p += 5, idx++) {
        if (p + 5 < pos + 2 || p > far) continue;
        const pp = Math.max(p, pos + 2), len = Math.min(5, p + 5 - pp), k = idx;
        out.push({ pos: pp, x: hz.x, draw: (g, pr, R) => drawPanel(g, pr, R, hz, pp, len, isWall, ts, k) });
      }
      const appeared = !hz.pop || hz.appearTs !== -Infinity;
      const age = ts - hz.appearTs;
      // event. Always placed at or beyond the board (pos >= anchor), so the far-to-near
      // sprite order draws the board on top: an event can never hide the hazard arrow.
      if (hz.type === 'wall' && hz.pop && appeared && age < 600) {
        out.push({ pos: hz.anchor + 2, x: hz.x, draw: (g, pr) => sparks(g, pr, age) });
      } else if (hz.type === 'wreck' && appeared) {
        const wp = hz.anchor + 11, wx = hz.side * (this.HW + Math.max(1.2, hz.gap * 0.5));
        out.push({
          pos: wp, x: wx,
          draw: (g, pr) => {
            if (L.smoke || hz.pop) smoke(g, pr, ts, hz.phase, 'rgb(150,150,150)', 4, 2.2);
            g.globalAlpha = 1 - pr.fog * 0.6;
            sideCar(g, pr, hz.color, ts + hz.phase, L.lights);
            g.globalAlpha = 1;
            if (hz.pop && age < 600) sparks(g, pr, age);
          },
        });
      } else if (hz.type === 'yellow') {
        out.push({ pos: hz.anchor + 1, x: hz.side * (this.HW + hz.gap + 2.4), draw: (g, pr) => marshal(g, pr, ts, appeared, hz.phase) });
      } else if (hz.type === 'spin' && appeared) {
        const k = U.smooth(U.clamp(age / SPIN_MS, 0, 1));
        const sp = hz.anchor + 6 + k * 12;
        const sx = U.lerp(hz.side * this.HW * 0.35, hz.side * (this.HW + hz.gap - 1.4), k);
        const ang = k * Math.PI * 1.6;
        out.push({
          pos: sp, x: sx,
          draw: (g, pr) => {
            if (k < 1) smoke(g, pr, ts, hz.phase, 'rgb(170,150,120)', 3, 1.2);
            g.globalAlpha = 1 - pr.fog * 0.6;
            sideCar(g, pr, hz.color, ts + hz.phase, L.lights && k >= 1, U.lerp(1.9, 4.3, Math.abs(Math.sin(ang))));
            g.globalAlpha = 1;
          },
        });
      }
      // hazard board (just nearer than the panel it stands in front of)
      out.push({
        pos: hz.anchor - 0.05, x: this.boardX(hz),
        draw: (g, pr) => {
          const size = boardSize(pr), cy = pr.y - size / 2;
          const content = plan && plan.hazard === hz && plan.probe && plan.state === 'shown' ? plan.decoy : 'mask';
          if (!Sym.trackBoard(g, pr, pr.x, cy, size * 0.62, hz.ci + 0.5, (L) => hazardBoard(L, pr.x, cy, size, content, th))) return;
          if (fb && fb.hazard === hz && fb.captured && performance.now() < fb.until) Sym.ring(g, pr.x, cy, size * 0.85, '#ffb000', Math.max(2, size * 0.1));
        },
      });
    }
    return out;
  };

  HazardLayer.prototype.renderHUD = function (g, W, H, ts, clock, showFb) {
    Sym.text(g, 'threat ' + this.level, W - 18, 74, { size: 13, weight: 420, align: 'right', alpha: 0.6 });
    const now = performance.now();
    if (this.o.framing === 'compare') {
      const f = this.framingAt(clock);
      if (this.banner && now < this.banner.until) {
        const a = U.clamp((this.banner.until - now) / 500, 0, 1);
        Sym.text(g, this.banner.text, W / 2, H * 0.16, { align: 'center', size: Math.max(22, W * 0.022), weight: 820, alpha: a, color: f === 'avoid' ? '#ffcc00' : '#fff' });
      } else {
        Sym.text(g, CUES[f], W / 2, 30, { align: 'center', size: 14, weight: 620, alpha: 0.7, color: f === 'avoid' ? '#ffcc00' : '#fff' });
      }
    }
    if (showFb && now < this.capFb) Sym.text(g, 'eyes on the wall', W / 2, H * 0.08 + 20, { align: 'center', size: 14, color: '#ffb000' });
  };

  IST.HazardLayer = HazardLayer;
})();
