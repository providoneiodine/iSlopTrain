/*
 * Race layer: the clutter of a real race, added on top of a driving drill.
 *
 *   - Traffic: opponent cars on the racing line ahead (with brake lights),
 *     plus a car nose creeping into the periphery when someone is alongside.
 *   - Relative timing box ("blackbox"): cars ahead/behind with live gaps.
 *   - Dash: shift lights, gear, delta bar, benign amber warnings.
 *   - Radio: engineer chatter (ignore) and spotter calls (act on).
 *   - Audio (optional): engine note (WebAudio) + spotter/engineer speech
 *     (Web Speech API). No external libraries.
 *
 * The rule for the athlete is go/no-go: press Confirm ONLY for threats
 * (a car closing to alongside: red relative row + "CAR LEFT/RIGHT" call
 * + car nose in the periphery). Everything else is noise to be ignored
 * while the eyes stay on the next apex.
 *
 * Interface used by drills:
 *   new IST.RaceLayer({track, rnd, intensity, relative, traffic, dash, radio, audio, relPos, vmax})
 *   .update(dt, clock, ts, pos, v)   .sprites(pos, far, HW) -> sprite[]
 *   .renderHUD(g, W, H, ts)          .onConfirm(t) -> bool (consumed)
 *   .pause() .resume() .destroy()    .summary() -> {threatHit, threatRT, ...}
 */
(function () {
  'use strict';
  const U = IST.util, Sym = IST.Symbols;

  const NAMES = ['Novak', 'Berg', 'Silva', 'Okafor', 'Lindqvist', 'Moreau', 'Tanaka', 'Reyes', 'Kowalski', 'Haddad', 'Brennan', 'Ito', 'Duarte', 'Varga'];
  const COLORS = ['#d7263d', '#1b998b', '#f46036', '#2e86ab', '#c5d86d', '#e8e8e8', '#8e44ad', '#f1c40f', '#ff6b9d', '#3d5a80', '#ff9f1c'];
  const RATES = {
    light: { radio: 14000, warn: 22000, threat: 17000 },
    race: { radio: 8000, warn: 12000, threat: 11000 },
    chaos: { radio: 4500, warn: 6500, threat: 7000 },
  };
  const RADIO = [
    'Fuel is good, keep pushing.', 'Gap to the car ahead is coming down.', 'Track temp is up two degrees.',
    'Copy, tyres look fine.', 'Delta is green, nice lap.', 'Ten laps to go.', 'Stay out, stay out.',
    'Brake bias is fine, no change.', 'No rain expected.', 'Keep it clean through sector two.',
    'Car ahead is struggling on the exits.', 'Purple sector one.', 'Target lap is a one fifty-two.',
  ];
  const WARNS = ['TYRE TEMP', 'FUEL 4 LAPS', 'WATER TEMP', 'BRAKE TEMP', 'TC ACTIVE', 'ABS ACTIVE'];
  const THREAT_WINDOW = 2200; // ms to respond once a car is alongside
  const ALONGSIDE = -0.42; // gap (s) at which the threat is live

  function shuffle(a, rnd) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  function RaceLayer(o) {
    this.o = o;
    this.t = o.track;
    this.rnd = o.rnd;
    this.rate = RATES[o.intensity] || RATES.race;
    const rnd = this.rnd;
    const names = shuffle(NAMES.slice(), rnd), colors = shuffle(COLORS.slice(), rnd);
    this.myPos = 6 + Math.floor(rnd() * 8);
    this.myNum = 7 + Math.floor(rnd() * 80);
    this.cars = [];
    for (let k = 0; k < 6; k++) {
      const ahead = k < 3;
      const rank = ahead ? 3 - k : k - 2; // 1..3
      const gap = ahead ? rank * (0.8 + rnd() * 0.9) : -rank * (0.8 + rnd() * 0.9);
      this.cars.push({
        num: String(10 + Math.floor(rnd() * 89)), name: names[k], color: colors[k],
        gap, target: gap, rate: 0.12, lat: (rnd() - 0.5) * 0.35, nextTarget: 0,
      });
    }
    this.nextRadio = 2500 + rnd() * this.rate.radio * 0.5;
    this.nextWarn = 4000 + rnd() * this.rate.warn;
    this.nextThreat = 7000 + rnd() * this.rate.threat * 0.6;
    this.msg = null; // {kind:'radio'|'spotter', text, until}
    this.warn = null; // {text, until}
    this.threat = null; // {car, side, onTs, done}
    this.delta = 0;
    this.rpm = 5000;
    this.gear = 3;
    this.stats = { rts: [], miss: 0, fa: 0, events: 0 };
    this.audio = null;
    if (o.audio) this.initAudio();
  }

  // ------------------------------------------------------------------ audio
  RaceLayer.prototype.initAudio = function () {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ac = new AC();
      const gain = ac.createGain();
      gain.gain.value = 0.035;
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      const o1 = ac.createOscillator(), o2 = ac.createOscillator();
      o1.type = 'sawtooth';
      o2.type = 'square';
      o1.connect(lp);
      o2.connect(lp);
      lp.connect(gain);
      gain.connect(ac.destination);
      o1.start();
      o2.start();
      if (ac.state === 'suspended') ac.resume().catch(() => {});
      this.audio = { ac, o1, o2, gain };
    } catch (e) {
      this.audio = null;
    }
  };

  RaceLayer.prototype.say = function (text, spotter) {
    if (!this.o.audio || !window.speechSynthesis || !window.SpeechSynthesisUtterance) return;
    try {
      if (spotter) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = spotter ? 1.35 : 1.1;
      u.pitch = spotter ? 0.9 : 1.15;
      u.volume = spotter ? 1 : 0.7;
      speechSynthesis.speak(u);
    } catch (e) {
      /* speech unavailable */
    }
  };

  RaceLayer.prototype.pause = function () {
    if (this.audio) this.audio.ac.suspend().catch(() => {});
    if (window.speechSynthesis) speechSynthesis.cancel();
    if (this.threat && !this.threat.done) this.endThreat(false, true);
  };
  RaceLayer.prototype.resume = function () {
    if (this.audio) this.audio.ac.resume().catch(() => {});
  };
  RaceLayer.prototype.destroy = function () {
    if (window.speechSynthesis) speechSynthesis.cancel();
    if (this.audio) {
      try {
        this.audio.o1.stop();
        this.audio.o2.stop();
        this.audio.ac.close();
      } catch (e) {
        /* already closed */
      }
      this.audio = null;
    }
  };

  // ----------------------------------------------------------------- update
  RaceLayer.prototype.endThreat = function (hit, silent) {
    const th = this.threat;
    if (!th) return;
    th.done = true;
    if (!silent && !hit) this.stats.miss++;
    th.car.target = -(1.0 + this.rnd() * 1.4); // drops back
    th.car.rate = 0.35;
    this.threat = null;
  };

  RaceLayer.prototype.update = function (dt, clock, ts, pos, v) {
    const rnd = this.rnd, s = dt / 1000;

    // gaps drift; ordering kept sane, nobody sits on top of you
    for (const c of this.cars) {
      if (clock >= c.nextTarget && !(this.threat && this.threat.car === c)) {
        const ahead = c.gap > 0;
        c.target = ahead ? 0.45 + rnd() * 4.5 : -(0.6 + rnd() * 4.2);
        c.rate = 0.06 + rnd() * 0.16;
        c.nextTarget = clock + 3000 + rnd() * 6000;
      }
      const d = c.target - c.gap;
      c.gap += Math.sign(d) * Math.min(Math.abs(d), c.rate * s);
      if (!(this.threat && this.threat.car === c)) {
        if (c.gap > 0 && c.gap < 0.4) c.gap = 0.4;
        if (c.gap <= 0 && c.gap > -0.3) c.gap = -0.3;
      }
    }

    // threat: nearest car behind closes to alongside
    if (!this.threat && clock >= this.nextThreat) {
      const behind = this.cars.filter((c) => c.gap < 0).sort((a, b) => b.gap - a.gap)[0];
      if (behind) {
        this.threat = { car: behind, side: rnd() < 0.5 ? 'LEFT' : 'RIGHT', onTs: null, done: false };
        behind.target = -0.12;
        behind.rate = 0.45;
        this.stats.events++;
      }
      this.nextThreat = clock + this.rate.threat * (0.6 + rnd() * 0.8);
    }
    const th = this.threat;
    if (th) {
      if (th.onTs == null && th.car.gap >= ALONGSIDE) {
        th.onTs = ts;
        this.msg = { kind: 'spotter', text: 'CAR ' + th.side, until: ts + THREAT_WINDOW };
        this.say('Car ' + th.side.toLowerCase(), true);
      } else if (th.onTs != null && ts - th.onTs > THREAT_WINDOW) {
        this.endThreat(false);
      }
    }

    // radio chatter (ignore)
    if (this.o.radio && clock >= this.nextRadio) {
      if (!this.msg || this.msg.kind !== 'spotter') {
        const text = RADIO[Math.floor(rnd() * RADIO.length)];
        this.msg = { kind: 'radio', text, until: ts + 3400 };
        this.say(text, false);
      }
      this.nextRadio = clock + this.rate.radio * (0.6 + rnd() * 0.8);
    }
    if (this.msg && ts > this.msg.until) this.msg = null;

    // dash warnings (ignore)
    if (this.o.dash && clock >= this.nextWarn) {
      this.warn = { text: WARNS[Math.floor(rnd() * WARNS.length)], until: ts + 2600 };
      this.nextWarn = clock + this.rate.warn * (0.6 + rnd() * 0.8);
    }
    if (this.warn && ts > this.warn.until) this.warn = null;

    // simple gearbox for rpm / shift lights / engine note
    const vmax = this.o.vmax || 60;
    const tops = [0.3, 0.44, 0.58, 0.72, 0.86, 1.02].map((f) => f * vmax);
    let gear = tops.findIndex((tp) => v <= tp * 0.985);
    if (gear < 0) gear = 5;
    this.gear = gear + 1;
    const low = gear ? tops[gear - 1] * 0.82 : 0;
    this.rpm = U.clamp(4200 + ((v - low) / (tops[gear] - low)) * 4600, 3800, 8900);
    this.delta = U.clamp(this.delta + (rnd() - 0.5) * 0.25 * s * 4, -0.9, 0.9);
    if (this.audio) {
      const f = (this.rpm / 60) * 3;
      const now = this.audio.ac.currentTime;
      this.audio.o1.frequency.setTargetAtTime(f, now, 0.03);
      this.audio.o2.frequency.setTargetAtTime(f / 2, now, 0.03);
    }
  };

  RaceLayer.prototype.onConfirm = function (t) {
    const th = this.threat;
    if (th && th.onTs != null && !th.done) {
      this.stats.rts.push(Math.max(0, t - th.onTs));
      this.msg = { kind: 'spotter', text: 'CLEAR ' + th.side, until: performance.now() + 900 };
      this.endThreat(true);
      return true;
    }
    return false;
  };
  RaceLayer.prototype.falseConfirm = function () {
    this.stats.fa++;
  };

  // ---------------------------------------------------------------- drawing
  function drawCar(g, pr, c, braking) {
    const s = pr.s, w = 1.9 * s, h = 1.0 * s, x = pr.x, yb = pr.y;
    g.globalAlpha = 1 - pr.fog * 0.6;
    if (w < 3) {
      g.fillStyle = c.color;
      g.fillRect(x - w / 2, yb - h, Math.max(1, w), Math.max(1, h));
      g.globalAlpha = 1;
      return;
    }
    g.fillStyle = 'rgba(0,0,0,.35)';
    g.fillRect(x - w * 0.52, yb - h * 0.06, w * 1.04, h * 0.1);
    g.fillStyle = '#111';
    g.fillRect(x - w * 0.5, yb - h * 0.48, w * 0.2, h * 0.48);
    g.fillRect(x + w * 0.3, yb - h * 0.48, w * 0.2, h * 0.48);
    g.fillStyle = c.color;
    Sym.roundRect(g, x - w * 0.36, yb - h * 0.82, w * 0.72, h * 0.66, h * 0.12);
    g.fill();
    g.fillStyle = '#1a1a1a';
    g.fillRect(x - w * 0.3, yb - h * 0.26, w * 0.6, h * 0.14);
    g.fillRect(x - w * 0.47, yb - h * 1.06, w * 0.94, h * 0.13);
    g.fillRect(x - w * 0.25, yb - h * 0.95, w * 0.04, h * 0.15);
    g.fillRect(x + w * 0.21, yb - h * 0.95, w * 0.04, h * 0.15);
    if (braking) {
      g.shadowColor = 'rgba(255,40,40,.9)';
      g.shadowBlur = Math.max(4, w * 0.15);
    }
    g.fillStyle = braking ? '#ff2a2a' : '#5c1414';
    g.fillRect(x - w * 0.32, yb - h * 0.52, w * 0.12, h * 0.1);
    g.fillRect(x + w * 0.2, yb - h * 0.52, w * 0.12, h * 0.1);
    g.shadowBlur = 0;
    g.globalAlpha = 1;
  }

  RaceLayer.prototype.sprites = function (pos, far, HW) {
    if (!this.o.traffic) return [];
    const t = this.t, out = [];
    const tNow = t.timeAt(pos);
    for (const c of this.cars) {
      if (c.gap <= 0) continue;
      const cp = t.posAtTime(tNow + c.gap);
      if (cp - pos < 6 || cp > far) continue;
      const braking = t.speedAt(cp + 12) < t.speedAt(cp) - 0.4;
      out.push({ pos: cp, x: (t.lateralAt(cp) + c.lat) * HW, draw: (g, pr) => drawCar(g, pr, c, braking) });
    }
    return out;
  };

  function fmtGap(gap) {
    return (gap > 0 ? '▲ ' : '▼ ') + Math.abs(gap).toFixed(gap > -10 && gap < 10 ? 2 : 1);
  }

  RaceLayer.prototype.renderHUD = function (g, W, H, ts) {
    const o = this.o;
    const th = this.threat;
    const pulse = 0.5 + 0.5 * Math.sin(ts / 90);

    // car alongside: nose creeping into the lower periphery
    if (o.traffic && th && th.car.gap > -0.75) {
      const overlap = U.clamp((th.car.gap + 0.75) / 0.6, 0, 1);
      const left = th.side === 'LEFT';
      // drawn at mid-height on the screen edge (clear of the relative box)
      const w = W * 0.14 * overlap, y0 = H * 0.44, y1 = H * 0.68;
      g.fillStyle = th.car.color;
      g.beginPath();
      if (left) {
        g.moveTo(0, y0);
        g.lineTo(w, y0 + H * 0.05);
        g.lineTo(w * 0.92, y1);
        g.lineTo(0, y1 + H * 0.02);
      } else {
        g.moveTo(W, y0);
        g.lineTo(W - w, y0 + H * 0.05);
        g.lineTo(W - w * 0.92, y1);
        g.lineTo(W, y1 + H * 0.02);
      }
      g.closePath();
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = 'rgba(0,0,0,.45)';
      g.stroke();
      // front tyre + shading so it reads as a car rather than a slab
      if (w > 12) {
        const wx = left ? w * 0.62 : W - w * 0.62;
        g.fillStyle = '#111';
        g.beginPath();
        g.ellipse(wx, y1 - H * 0.03, w * 0.32, H * 0.075, 0, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = 'rgba(0,0,0,.25)';
        g.fillRect(left ? 0 : W - w, y0 + H * 0.1, w * 0.85, H * 0.025);
      }
    }

    // dash: shift lights, gear, delta, warnings
    if (o.dash) {
      const bw = Math.min(W * 0.3, 380), x0 = (W - bw) / 2, y = 12, n = 12, cell = bw / n;
      const lit = U.clamp(Math.round(((this.rpm - 6200) / (8300 - 6200)) * n), 0, n);
      const flash = this.rpm > 8350 && Math.floor(ts / 70) % 2 === 0;
      g.fillStyle = 'rgba(0,0,0,.55)';
      Sym.roundRect(g, x0 - 8, y - 6, bw + 16, cell * 0.8 + 52, 8);
      g.fill();
      for (let i = 0; i < n; i++) {
        const on = flash || i < lit;
        const col = i < 5 ? '#2bd15a' : i < 9 ? '#ff3b30' : '#3a8bff';
        g.beginPath();
        g.arc(x0 + cell * (i + 0.5), y + cell * 0.32, cell * 0.3, 0, Math.PI * 2);
        g.fillStyle = on ? col : 'rgba(255,255,255,.08)';
        g.fill();
      }
      const yy = y + cell * 0.8 + 6;
      Sym.text(g, String(this.gear), W / 2, yy + 26, { align: 'center', size: 32, weight: 900, shadow: false });
      const dw = bw * 0.36, dy = yy + 10;
      g.fillStyle = 'rgba(255,255,255,.12)';
      g.fillRect(x0, dy, dw, 8);
      g.fillRect(x0 + bw - dw, dy, dw, 8);
      const frac = Math.abs(this.delta) / 0.9;
      g.fillStyle = this.delta < 0 ? '#2bd15a' : '#ff453a';
      if (this.delta < 0) g.fillRect(x0 + bw - dw, dy, dw * frac, 8);
      else g.fillRect(x0 + dw * (1 - frac), dy, dw * frac, 8);
      Sym.text(g, (this.delta < 0 ? '−' : '+') + Math.abs(this.delta).toFixed(2), x0, dy + 26, { size: 14, weight: 720, shadow: false, color: this.delta < 0 ? '#2bd15a' : '#ff453a' });
      if (this.warn && Math.floor(ts / 250) % 2 === 0)
        Sym.text(g, this.warn.text, x0 + bw, dy + 26, { size: 14, weight: 820, align: 'right', shadow: false, color: '#ffb000' });
    }

    // relative box
    if (o.relative) {
      const rows = this.cars.map((c) => ({ c, gap: c.gap }));
      rows.push({ me: true, gap: 0 });
      rows.sort((a, b) => b.gap - a.gap);
      const meIdx = rows.findIndex((r) => r.me);
      const rh = Math.max(18, Math.min(24, H * 0.03)), bw = rh * 12.5;
      const bx = o.relPos === 'left' ? 16 : W - bw - 16, by = H - rows.length * rh - 26;
      g.fillStyle = 'rgba(8,10,14,.78)';
      Sym.roundRect(g, bx - 6, by - 20, bw + 12, rows.length * rh + 26, 8);
      g.fill();
      Sym.text(g, 'RELATIVE', bx, by - 6, { size: 10, weight: 820, color: '#8a93a6', shadow: false });
      const fs = rh * 0.6;
      rows.forEach((r, i) => {
        const y = by + i * rh;
        const isThreat = th && r.c === th.car && th.onTs != null;
        if (r.me) {
          g.fillStyle = 'rgba(255,255,255,.14)';
          g.fillRect(bx - 4, y + 1, bw + 8, rh - 2);
        } else if (isThreat) {
          g.fillStyle = 'rgba(255,40,30,' + (0.35 + 0.45 * pulse) + ')';
          g.fillRect(bx - 4, y + 1, bw + 8, rh - 2);
        }
        const pos = this.myPos + (i - meIdx);
        const col = r.me ? '#ffffff' : '#d5dae3';
        const ty = y + rh * 0.72;
        Sym.text(g, 'P' + pos, bx, ty, { size: fs, weight: 720, color: col, shadow: false });
        if (!r.me) {
          g.fillStyle = r.c.color;
          g.fillRect(bx + rh * 1.9, y + rh * 0.25, rh * 0.18, rh * 0.5);
        }
        Sym.text(g, '#' + (r.me ? this.myNum : r.c.num), bx + rh * 2.3, ty, { size: fs, weight: 620, color: col, shadow: false });
        Sym.text(g, r.me ? 'YOU' : r.c.name, bx + rh * 4.4, ty, { size: fs, weight: r.me ? 800 : 500, color: col, shadow: false });
        if (!r.me) Sym.text(g, fmtGap(r.gap), bx + bw, ty, { size: fs, weight: 720, align: 'right', shadow: false, color: isThreat ? '#ffffff' : r.gap > 0 ? '#9fb3c8' : '#c8b49f' });
      });
    }

    // radio / spotter banner
    if (this.msg) {
      const spot = this.msg.kind === 'spotter';
      const fs = spot ? Math.max(18, W * 0.016) : Math.max(13, W * 0.011);
      const x = 16, y = 52;
      g.font = (spot ? 820 : 420) + ' ' + fs + 'px ' + Sym.FONT;
      const tw = g.measureText(this.msg.text).width;
      g.fillStyle = spot ? 'rgba(160,20,15,.85)' : 'rgba(8,10,14,.75)';
      Sym.roundRect(g, x, y, tw + 24, fs + 30, 8);
      g.fill();
      Sym.text(g, spot ? 'SPOTTER' : 'RADIO · ENGINEER', x + 12, y + 15, { size: 10, weight: 820, color: spot ? '#ffd0cc' : '#8a93a6', shadow: false });
      Sym.text(g, this.msg.text, x + 12, y + 18 + fs, { size: fs, weight: spot ? 800 : 500, shadow: false });
    }
  };

  RaceLayer.prototype.summary = function () {
    const st = this.stats;
    const n = st.rts.length + st.miss;
    return {
      threatHit: n ? st.rts.length / n : null,
      threatRT: st.rts.length ? U.median(st.rts) : null,
      threats: n,
      falseConfirms: st.fa,
    };
  };

  RaceLayer.drawCar = drawCar; // reused by other drills (ghost cars)
  IST.RaceLayer = RaceLayer;
})();
