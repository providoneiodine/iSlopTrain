/*
 * Juice: shared game-feel layer (chain, multiplier tiers, score, timing
 * grades, tones, callouts, chain-break and miss feedback).
 *
 *   const J = new IST.Juice({ history, live, sound });
 *   J.hit({ base, bonus, label, color })   -> points awarded
 *   J.miss({ label })                      -> breaks the chain
 *   J.bonus(pts, label)                    -> side points (e.g. marshal light)
 *   J.callout(text, color, sub)            -> centre message
 *   J.render(g, W, H, { x, y, size, side }) draws the chain block + effects
 *   J.summary()                            -> { score, bestChain }
 *
 * `live: false` keeps score silently (for "summary only" feedback, which
 * must not reveal per-trial results; Winstein & Schmidt, 1990). The global
 * Game feel preference (Data menu) can mute sounds or switch effects off.
 *
 * Placement is the drill's job: keep the block away from anything the
 * player has to look at or read.
 */
(function () {
  'use strict';
  const U = IST.util, Sym = IST.Symbols, TH = IST.Theme;

  // Chain tiers: the multiplier and colour climb as the streak grows.
  const TIERS = [
    { at: 0, m: 1, c: '#e8ecf2' },
    { at: 5, m: 2, c: '#9fe3b0' },
    { at: 10, m: 3, c: '#9fcbef' },
    { at: 20, m: 4, c: TH.gold },
    { at: 35, m: 5, c: '#ffb26b' },
    { at: 50, m: 6, c: '#ff7ad9' },
    { at: 75, m: 8, c: '#c69bff' },
    { at: 100, m: 10, c: '#ffffff' },
  ];
  const tierOf = (n) => {
    let k = 0;
    for (let j = 0; j < TIERS.length; j++) if (n >= TIERS[j].at) k = j;
    return k;
  };
  const PENTA = [0, 2, 4, 7, 9];

  const hexCache = {};
  function hex(c) {
    if (hexCache[c]) return hexCache[c];
    const n = parseInt(c.slice(1), 16);
    return (hexCache[c] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]);
  }

  /** 'full' | 'silent' (effects, no sound) | 'off' (no per-trial effects) */
  const mode = () => IST.Storage.getPref('juice', 'full');

  // ------------------------------------------------------------------ audio
  function makeAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      const ac = new AC();
      const master = ac.createGain();
      master.gain.value = 0.32;
      master.connect(ac.destination);
      const nb = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.4), ac.sampleRate);
      const nd = nb.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

      const tone = (f, dur, type, vol, delay, slideTo) => {
        const t = ac.currentTime + (delay || 0);
        const o = ac.createOscillator(), gn = ac.createGain();
        o.type = type || 'triangle';
        o.frequency.setValueAtTime(f, t);
        if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
        gn.gain.setValueAtTime(0.0001, t);
        gn.gain.exponentialRampToValueAtTime(vol, t + 0.006);
        gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(gn);
        gn.connect(master);
        o.start(t);
        o.stop(t + dur + 0.02);
      };
      const noise = (dur, vol, freq, type) => {
        const t = ac.currentTime;
        const s = ac.createBufferSource(), f = ac.createBiquadFilter(), gn = ac.createGain();
        s.buffer = nb;
        f.type = type || 'lowpass';
        f.frequency.value = freq || 900;
        gn.gain.setValueAtTime(vol, t);
        gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        s.connect(f);
        f.connect(gn);
        gn.connect(master);
        s.start(t);
        s.stop(t + dur + 0.02);
      };
      const note = (step) => 262 * Math.pow(2, (PENTA[step % 5] + 12 * Math.floor(step / 5)) / 12);
      return {
        ok(chain, sparkle) {
          tone(note((chain - 1) % 15), 0.11, 'triangle', 0.22);
          if (sparkle) tone(note(((chain - 1) % 15) + 5), 0.08, 'sine', 0.08, 0.02);
        },
        tick() {
          noise(0.03, 0.06, 6000, 'highpass');
        },
        tier(ti) {
          const b = 2 + Math.min(ti, 6);
          [0, 2, 4].forEach((k, j) => tone(note(b * 2 + k), 0.16, 'triangle', 0.24, j * 0.055));
          tone(note(b * 2 + 7), 0.3, 'sine', 0.16, 0.17);
        },
        best() {
          [0, 4, 7, 12].forEach((k, j) => tone(523 * Math.pow(2, k / 12), 0.18, 'sine', 0.2, j * 0.07));
        },
        ding() {
          tone(1760, 0.6, 'sine', 0.025); // barely-there nod
        },
        coin() {
          tone(988, 0.07, 'square', 0.08);
          tone(1319, 0.16, 'square', 0.08, 0.06);
        },
        recovered() {
          tone(392, 0.12, 'sine', 0.22);
          tone(587, 0.22, 'sine', 0.22, 0.09);
        },
        err(k, soft) {
          if (soft) {
            tone(150, 0.16, 'sawtooth', 0.16, 0, 95);
            tone(158, 0.16, 'square', 0.07, 0, 98);
            return;
          }
          const d = 0.24 + Math.min(4, k) * 0.05, lo = Math.max(45, 110 - k * 12);
          tone(lo, d, 'sawtooth', 0.42, 0, lo * 0.62);
          tone(lo * 1.06, d, 'square', 0.22, 0, lo * 0.6);
          noise(0.12 + k * 0.03, 0.3, 700);
        },
        chirp() {
          tone(1900, 0.08, 'sine', 0.16, 0, 950);
          tone(2400, 0.06, 'sine', 0.1, 0.09, 1400);
        },
        reset() {
          tone(196, 0.5, 'sine', 0.18, 0, 147);
        },
        suspend() {
          ac.suspend().catch(() => {});
        },
        resume() {
          ac.resume().catch(() => {});
        },
        close() {
          try {
            ac.close();
          } catch (e) {
            /* already closed */
          }
        },
      };
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------- instance
  class Juice {
    constructor(o) {
      o = o || {};
      const m = mode();
      this.live = o.live !== false && m !== 'off';
      this.audio = this.live && m === 'full' && o.sound !== false ? makeAudio() : null;
      this.allTimeBest = (o.history || []).reduce((b, r) => Math.max(b, (r.summary && r.summary.bestChain) || 0), 0);
      this.chain = 0;
      this.best = 0;
      this.score = 0;
      this.errRun = 0;
      this.fx = [];
      this.popT = -1e9;
      this.breakT = -1e9;
      this.missT = -1e9;
      this.brokenChain = 0;
      this.newBestShown = false;
    }

    hit(o) {
      o = o || {};
      const prev = tierOf(this.chain);
      this.chain++;
      this.errRun = 0;
      this.best = Math.max(this.best, this.chain);
      const ti = tierOf(this.chain), T = TIERS[ti];
      const pts = Math.round(T.m * ((o.base == null ? 10 : o.base) + (o.bonus || 0)));
      this.score += pts;
      if (!this.live) return pts;
      const t = performance.now();
      this.popT = t;
      this.fx.push({ k: 'float', t0: t, dur: 900, text: '+' + pts, sub: o.label || null, color: o.color || T.c });
      if (ti > prev) {
        this.fx.push({ k: 'tier', t0: t, dur: 900, text: '×' + T.m, color: T.c });
        this.fx.push({ k: 'ring', t0: t, dur: 700, color: T.c, n: 12 + ti * 3 });
        if (this.audio) this.audio.tier(ti);
      } else if (this.audio) this.audio.ok(this.chain, !!o.label);
      if (!this.newBestShown && this.allTimeBest >= 5 && this.chain === this.allTimeBest + 1) {
        this.newBestShown = true;
        this.callout('NEW BEST CHAIN', TH.gold);
        if (this.audio) this.audio.best();
      }
      return pts;
    }

    miss(o) {
      o = o || {};
      const t = performance.now();
      if (this.live && this.chain >= 5) this.fx.push({ k: 'call', t0: t, dur: 900, text: 'CHAIN BROKEN · ' + this.chain, color: TH.miss, small: true });
      this.brokenChain = this.chain;
      this.breakT = t;
      this.chain = 0;
      this.errRun++;
      if (!this.live) return;
      this.missT = t;
      if (o.label) this.fx.push({ k: 'float', t0: t, dur: 900, text: o.label, color: '#ff6b5e' });
      if (this.audio) this.audio.err(this.errRun, true);
    }

    bonus(pts, label, color) {
      this.score += pts;
      if (!this.live) return;
      this.fx.push({ k: 'float', t0: performance.now(), dur: 900, text: '+' + pts, sub: label || null, color: color || TH.gold });
      if (this.audio) this.audio.coin();
    }

    /** a quiet ding with no visuals (e.g. entering a familiar corner) */
    ding() {
      if (this.audio) this.audio.ding();
    }

    callout(text, color, sub) {
      if (!this.live) return;
      this.fx.push({ k: 'call', t0: performance.now(), dur: 1400, text, sub: sub || null, color: color || TH.gold });
    }

    summary() {
      return { score: Math.round(this.score), bestChain: this.best };
    }

    /**
     * o: { x, y (top of the block), size (chain digits px), side: 1 = effects to the right, -1 = left,
     *      callY (centre callouts), vignette (edge flash on misses, default true) }
     */
    render(g, W, H, o) {
      if (!this.live) return;
      o = o || {};
      const t = performance.now();
      const size = o.size || U.clamp(H * 0.05, 28, 46);
      const cx = o.x != null ? o.x : W / 2, top = o.y != null ? o.y : 16;
      const side = o.side || 1;
      const ti = tierOf(this.chain), T = TIERS[ti];
      const cy = top + size * 0.5;

      // miss: red pulse at the screen edges (keeps the centre of the view clear)
      const mp = (t - this.missT) / 300;
      if (mp < 1 && o.vignette !== false) {
        const grd = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.32, W / 2, H / 2, Math.max(W, H) * 0.72);
        grd.addColorStop(0, 'rgba(255,40,30,0)');
        grd.addColorStop(1, 'rgba(255,40,30,' + (0.38 * (1 - mp)).toFixed(3) + ')');
        g.fillStyle = grd;
        g.fillRect(0, 0, W, H);
      }

      // chain number
      const pp = (t - this.popT) / 200;
      const scale = pp < 1 ? 1 + 0.22 * (1 - pp) : 1;
      g.save();
      g.translate(cx, cy);
      g.scale(scale, scale);
      if (ti >= 1) {
        g.shadowColor = T.c;
        g.shadowBlur = 8 + ti * 3;
      }
      Sym.text(g, String(this.chain), 0, 0, { align: 'center', baseline: 'middle', size, weight: 900, color: T.c, alpha: this.chain ? 1 : 0.35, shadow: ti < 1 });
      g.shadowBlur = 0;
      g.restore();
      const bp = (t - this.breakT) / 650;
      if (bp < 1 && this.brokenChain >= 3) {
        Sym.text(g, String(this.brokenChain), cx, cy + bp * size, { align: 'center', baseline: 'middle', size: size * (1 - bp * 0.3), weight: 900, color: TH.miss, alpha: 1 - bp, shadow: false });
      }
      const ly = top + size + 10;
      Sym.text(g, 'CHAIN ×' + T.m, cx, ly, { align: 'center', size: 11, weight: 820, color: ti ? T.c : '#a1a9b7', alpha: 0.9 });
      const next = TIERS[ti + 1];
      const bw = size * 2.6, by = ly + 6;
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(cx - bw / 2, by, bw, 3);
      g.fillStyle = T.c;
      g.fillRect(cx - bw / 2, by, bw * U.clamp(next ? (this.chain - T.at) / (next.at - T.at) : 1, 0, 1), 3);
      Sym.text(g, Math.round(this.score).toLocaleString(), cx, by + 18, { align: 'center', size: 13, weight: 720, color: this.score < 0 ? '#ff6b5e' : '#d5dae3' });

      // effects
      const fxX = cx + side * size * 1.25;
      for (let j = this.fx.length - 1; j >= 0; j--) {
        const f = this.fx[j];
        const p = (t - f.t0) / f.dur;
        if (p >= 1) {
          this.fx.splice(j, 1);
          continue;
        }
        const a = 1 - p;
        if (f.k === 'float') {
          const y = cy - p * size * 0.9;
          const al = side > 0 ? 'left' : 'right';
          if (f.text) Sym.text(g, f.text, fxX, y, { align: al, baseline: 'middle', size: Math.round(size * 0.48), weight: 900, color: f.color, alpha: Math.min(1, a * 1.6) });
          if (f.sub) Sym.text(g, f.sub, fxX, y + size * 0.42, { align: al, baseline: 'middle', size: Math.round(size * 0.32), weight: 820, color: f.color, alpha: a });
        } else if (f.k === 'tier') {
          const s = 1 + 0.5 * U.smooth(Math.min(1, p * 3));
          Sym.text(g, f.text, cx - side * size * 1.2, cy - p * 14, { align: side > 0 ? 'right' : 'left', baseline: 'middle', size: size * 0.7 * s, weight: 900, color: f.color, alpha: a });
        } else if (f.k === 'ring') {
          const r = size * 0.6 + p * size * 2.2;
          g.fillStyle = f.color;
          g.globalAlpha = a;
          for (let i = 0; i < f.n; i++) {
            const ang = (i / f.n) * Math.PI * 2;
            g.fillRect(cx + Math.cos(ang) * r - 2.5, cy + Math.sin(ang) * r * 0.7 - 2.5, 5, 5);
          }
          g.globalAlpha = 1;
        } else if (f.k === 'call') {
          const y = o.callY != null ? o.callY : H * 0.2;
          const s = 1 + 0.25 * (1 - U.smooth(Math.min(1, p * 4)));
          Sym.text(g, f.text, W / 2, y, { align: 'center', baseline: 'middle', size: (f.small ? 20 : 28) * s, weight: 900, color: f.color, alpha: Math.min(1, a * 1.8) });
          if (f.sub) Sym.text(g, f.sub, W / 2, y + 26, { align: 'center', baseline: 'middle', size: 15, weight: 720, color: f.color, alpha: a });
        }
      }
    }

    pause() {
      if (this.audio) this.audio.suspend();
    }
    resume() {
      if (this.audio) this.audio.resume();
    }
    destroy() {
      if (this.audio) this.audio.close();
      this.audio = null;
    }
  }

  Juice.TIERS = TIERS;
  Juice.tierOf = tierOf;
  Juice.makeAudio = makeAudio;
  Juice.hex = hex;
  Juice.mode = mode;
  /** Metric rows drills append so score and best chain show up in results and Stats. */
  Juice.METRICS = [
    { key: 'bestChain', label: 'Best chain', digits: 0, better: 'higher' },
    { key: 'score', label: 'Score', digits: 0, better: 'higher' },
  ];
  IST.Juice = Juice;
})();
