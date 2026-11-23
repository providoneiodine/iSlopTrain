/*
 * Clean Slate: drawing. The lane with its beat lines, reveal line and hit
 * window, the rows (masks until revealed, then arrows), distractions, the
 * chain counter, hit / error effects and the HUD.
 *
 * createView(R, env) draws from the drill's live run state R (read-only,
 * except that finished effects are dropped from R.fx); env = { S, bLevel,
 * dLevel, allTimeBest }.
 */
(function () {
  'use strict';
  const U = IST.util, Sym = IST.Symbols, CS = IST.CleanSlate;
  const { APPROACH, BEAT, HW, PERFECT, COL } = CS;
  const { TIERS, tierOf, hex } = IST.Juice;

  CS.createView = function (R, env) {
    const { S, bLevel, dLevel, allTimeBest } = env;

    function layout(W, H) {
      const laneW = Math.min(W * 0.5, 680, H * 0.95);
      const laneX = (W - laneW) / 2;
      const topY = H * 0.06, hitY = H * 0.8;
      return { laneW, laneX, topY, hitY, speed: (hitY - topY) / APPROACH };
    }
    const rowY = (L, r) => L.hitY - (r.arriveT - R.now) * L.speed;
    function slotX(L, r, j) {
      const gap = L.laneW / (r.n + 1);
      const drift = r.jx && R.now >= r.revealT ? r.jx * L.laneW * 0.16 * U.clamp((R.now - r.revealT) / 400, 0, 1) : 0;
      return L.laneX + gap * (j + 1) + drift;
    }
    const sizeOf = (L, r, H) => Math.min((L.laneW / (r.n + 1)) * 0.74, H * 0.075);

    function drawLane(g, W, H, L) {
      const ti = tierOf(R.chain), T = TIERS[ti];
      g.fillStyle = '#0c0e12';
      g.fillRect(L.laneX, 0, L.laneW, H);
      g.fillStyle = '#1d2129';
      g.fillRect(L.laneX - 2, 0, 2, H);
      g.fillRect(L.laneX + L.laneW, 0, 2, H);
      // beat lines scroll with the rows
      g.fillStyle = 'rgba(255,255,255,0.035)';
      for (let t = R.lastArrive + BEAT; t > R.now - 400; t -= BEAT) {
        const y = L.hitY - (t - R.now) * L.speed - BEAT * L.speed * 0.5;
        if (y > 0 && y < H) g.fillRect(L.laneX, y, L.laneW, 1);
      }
      // reveal line
      const ry = L.hitY - R.lead * L.speed;
      if (ry > L.topY) {
        g.fillStyle = 'rgba(159,203,239,0.22)';
        for (let x = L.laneX; x < L.laneX + L.laneW; x += 14) g.fillRect(x, ry, 7, 1);
        Sym.text(g, 'REVEAL', L.laneX + L.laneW + 8, ry + 4, { size: 10, weight: 600, color: '#5d7590', shadow: false });
      }
      // hit window band + line
      const hw = HW * L.speed, pw = PERFECT * L.speed;
      g.fillStyle = U.rgb(hex(T.c), 0.06);
      g.fillRect(L.laneX, L.hitY - hw, L.laneW, hw * 2);
      g.fillStyle = U.rgb(hex(T.c), 0.08);
      g.fillRect(L.laneX, L.hitY - pw, L.laneW, pw * 2);
      const fp = (R.now - R.hitFlashT) / 220;
      const lineCol = fp < 1 ? U.rgb(U.mix(hex(T.c), [255, 255, 255], 1 - fp), 1) : T.c;
      g.fillStyle = lineCol;
      if (ti >= 1 || fp < 1) {
        g.shadowColor = T.c;
        g.shadowBlur = fp < 1 ? 18 : 6 + ti * 2;
      }
      g.fillRect(L.laneX, L.hitY - 1.5, L.laneW, 3);
      g.shadowBlur = 0;
      g.fillStyle = '#6c7484';
      g.fillRect(L.laneX - 12, L.hitY - hw, 6, 1);
      g.fillRect(L.laneX - 12, L.hitY + hw, 6, 1);
      g.fillRect(L.laneX - 7, L.hitY - hw, 1, hw * 2);
    }

    function drawRow(g, L, H, r) {
      const y = rowY(L, r);
      if (y < -60 || y > H + 60) return;
      const s = sizeOf(L, r, H);
      if (r.resolved && r.ok) return; // hit rows vanish into the burst
      const missed = r.resolved && !r.ok;
      const revealed = R.now >= r.revealT;
      const fade = missed ? U.clamp(1 - (R.now - r.resT) / 500, 0, 1) : 1;
      if (fade <= 0) return;
      g.globalAlpha = fade;
      if (r.noise && revealed) {
        for (const n of r.noise) {
          const q = s * n[2];
          g.fillStyle = 'rgba(200,205,215,' + (0.1 + n[3] * 0.2).toFixed(2) + ')';
          g.fillRect(L.laneX + L.laneW * (0.5 + n[0]) - q / 2, y + n[1] * s * 1.4 - q / 2, q, q);
        }
      }
      const glow = tierOf(R.chain) >= 2 && !missed;
      for (let j = 0; j < r.n; j++) {
        const x = slotX(L, r, j), yy = y + r.offs[j] * s;
        if (!revealed) {
          Sym.mask(g, x, yy, s, COL.mask);
          continue;
        }
        if (j === r.tgt) {
          const c = missed ? '#ff453a' : r.orange ? COL.orange : COL.blue;
          if (glow) {
            g.shadowColor = c;
            g.shadowBlur = 14;
          }
          // after an error, show the arrow you should have pressed
          Sym.arrow(g, x, yy, s, missed ? r.ans : r.dir, c);
          g.shadowBlur = 0;
        } else {
          Sym.arrow(g, x, yy, s, r.fl, missed ? 'rgba(174,182,196,.35)' : j === r.look ? COL.look : COL.flank);
        }
      }
      g.globalAlpha = 1;
    }

    function activeDist() {
      const out = [];
      for (const r of R.notes) {
        if (!r.dist || r.resolved) continue;
        for (const d of r.dist) {
          if (!d.dur) continue;
          const t0 = r.revealT + d.soa;
          if (R.now >= t0 && R.now <= t0 + d.dur) out.push(d);
        }
      }
      return out;
    }
    function drawDist(g, W, H, unit, list) {
      let glitch = false;
      for (const d of list) {
        const x = d.u * W, y = d.v * H;
        if (d.type === 'pop') {
          g.fillStyle = d.color;
          const s = unit * 0.55;
          if (d.shape === 0) {
            g.beginPath();
            g.arc(x, y, s / 2, 0, Math.PI * 2);
            g.fill();
          } else if (d.shape === 1) g.fillRect(x - s / 2, y - s / 2, s, s);
          else {
            g.beginPath();
            g.moveTo(x, y - s / 2);
            g.lineTo(x + s / 2, y + s / 2);
            g.lineTo(x - s / 2, y + s / 2);
            g.closePath();
            g.fill();
          }
        } else if (d.type === 'word') {
          Sym.text(g, d.word, x, y, { align: 'center', baseline: 'middle', size: Math.max(18, unit * 0.42), weight: 850, color: d.shape ? '#ff6b5e' : '#f5c400' });
        } else if (d.type === 'decoy') {
          Sym.arrow(g, x, y, unit * 0.8, d.dir, d.shape === 2 ? COL.blue : COL.flank);
        } else if (d.type === 'glitch') glitch = true;
      }
      return glitch;
    }

    function drawChain(g, W, H, L, glitch) {
      const ti = tierOf(R.chain), T = TIERS[ti];
      const hx = W / 2, hy = H * 0.34;
      const base = U.clamp(H * 0.14, 50, 130);
      const pp = (R.now - R.chainPopT) / 220;
      const scale = pp < 1 ? 1 + 0.16 * (1 - pp) : 1;
      const alpha = R.chain ? (pp < 1 ? 0.55 + 0.35 * (1 - pp) : 0.55) : 0.25;
      let col = T.c, gx = 0;
      if (glitch) {
        col = '#ff453a';
        gx = (Math.random() - 0.5) * 16;
      }
      g.save();
      g.translate(hx + gx, hy);
      g.scale(scale, scale);
      if (ti >= 1) {
        g.shadowColor = T.c;
        g.shadowBlur = 10 + ti * 4;
      }
      Sym.text(g, glitch ? R.chain + '?' : String(R.chain), 0, 0, { align: 'center', baseline: 'middle', size: base, weight: 900, color: col, alpha: glitch ? 0.9 : alpha, shadow: false });
      g.shadowBlur = 0;
      g.restore();
      const ly = hy + base * 0.62;
      Sym.text(g, 'CHAIN  ×' + T.m, hx, ly, { align: 'center', size: 13, weight: 700, color: ti ? T.c : '#8a93a6', alpha: 0.8, shadow: false });
      const next = TIERS[ti + 1];
      const bw = Math.min(200, L.laneW * 0.5), by = ly + 10;
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.fillRect(hx - bw / 2, by, bw, 4);
      g.fillStyle = T.c;
      g.fillRect(hx - bw / 2, by, bw * U.clamp(next ? (R.chain - T.at) / (next.at - T.at) : 1, 0, 1), 4);
      if (next) Sym.text(g, String(next.at), hx + bw / 2 + 8, by + 6, { size: 11, weight: 500, color: '#6c7484', shadow: false });
      const bp = (R.now - R.breakT) / 650;
      if (bp < 1 && R.brokenChain >= 5) {
        Sym.text(g, String(R.brokenChain), hx, hy + bp * base * 0.9, { align: 'center', baseline: 'middle', size: base * (1 - bp * 0.3), weight: 900, color: '#ff453a', alpha: 1 - bp, shadow: false });
      }
    }

    function drawHud(g, W, H) {
      Sym.text(g, Math.round(R.score).toLocaleString(), W - 18, 34, { align: 'right', size: 22, weight: 800, color: R.score < 0 ? '#ff6b5e' : '#eef0f4' });
      Sym.text(g, 'Best chain ' + Math.max(allTimeBest, R.bestChain), W - 18, 54, { align: 'right', size: 13, weight: 500, color: '#8a93a6' });
      Sym.text(g, U.fmtTime(Math.max(0, S.duration - R.now / 1000)), 18, 34, { size: 20, weight: 700, alpha: 0.8 });
      Sym.text(g, 'Burst ' + bLevel + ' · Distraction ' + dLevel + (S.resetCue ? ' · Reset: Space' : ''), 18, H - 16, { size: 12, weight: 500, alpha: 0.45 });
      Sym.text(g, 'Esc', W - 18, H - 16, { size: 12, align: 'right', alpha: 0.45 });
    }

    function drawFx(g, W, H, L) {
      const hy = H * 0.34;
      for (let j = R.fx.length - 1; j >= 0; j--) {
        const f = R.fx[j];
        const p = (R.now - f.t0) / f.dur;
        if (p >= 1) {
          R.fx.splice(j, 1);
          continue;
        }
        const a = 1 - p;
        if (f.k === 'judge') {
          const x = L.laneX + L.laneW + 16, y = L.hitY - 6 - p * 18;
          Sym.text(g, f.text, x, y, { size: 20, weight: 900, color: f.color, alpha: Math.min(1, a * 1.5) });
          Sym.text(g, f.sub, x, y + 20, { size: 14, weight: 700, color: f.color, alpha: a });
        } else if (f.k === 'burst') {
          const r = 10 + p * 46;
          g.globalAlpha = a;
          Sym.ring(g, f.x, L.hitY, r, f.color, 3);
          g.fillStyle = f.color;
          for (let i = 0; i < 8; i++) {
            const ang = (i / 8) * Math.PI * 2;
            g.fillRect(f.x + Math.cos(ang) * r * 1.2 - 2, L.hitY + Math.sin(ang) * r * 1.2 - 2, 4, 4);
          }
          g.globalAlpha = 1;
        } else if (f.k === 'tier') {
          const s = 1 + 0.6 * U.smooth(Math.min(1, p * 3));
          Sym.text(g, f.text, W / 2 + U.clamp(H * 0.14, 50, 130) * 0.9, hy - 30 - p * 20, { align: 'left', baseline: 'middle', size: 30 * s, weight: 900, color: f.color, alpha: a });
        } else if (f.k === 'ring') {
          const r = 30 + p * Math.min(W, H) * 0.2;
          g.fillStyle = f.color;
          g.globalAlpha = a;
          for (let i = 0; i < f.n; i++) {
            const ang = (i / f.n) * Math.PI * 2;
            g.fillRect(W / 2 + Math.cos(ang) * r - 3, hy + Math.sin(ang) * r * 0.6 - 3, 6, 6);
          }
          g.globalAlpha = 1;
        } else if (f.k === 'call') {
          const y = H * 0.5;
          Sym.text(g, f.text, W / 2, y, { align: 'center', size: f.small ? 22 : 30, weight: 900, color: f.color, alpha: Math.min(1, a * 1.6) });
          if (f.sub) Sym.text(g, f.sub, W / 2, y + 26, { align: 'center', size: 16, weight: 700, color: f.color, alpha: a });
        } else if (f.k === 'reset') {
          g.globalAlpha = a * 0.7;
          Sym.ring(g, W / 2, L.hitY, 30 + p * L.laneW * 0.5, '#9fcbef', 3);
          g.globalAlpha = 1;
        }
      }
    }

    /** Draw one frame. Returns the layout, which input uses to place hits. */
    function render(g, W, H) {
      const L = layout(W, H);
      const ti = tierOf(R.chain), T = TIERS[ti];
      g.fillStyle = '#07080a';
      g.fillRect(0, 0, W, H);
      if (ti >= 1) {
        const grd = g.createRadialGradient(W / 2, L.hitY, 0, W / 2, L.hitY, Math.max(W, H) * 0.7);
        grd.addColorStop(0, U.rgb(hex(T.c), 0.05 + ti * 0.012));
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grd;
        g.fillRect(0, 0, W, H);
      }
      const ep = (R.now - R.errT) / 320;
      g.save();
      if (ep < 1) g.translate((Math.random() - 0.5) * 12 * (1 - ep), (Math.random() - 0.5) * 8 * (1 - ep));
      drawLane(g, W, H, L);
      const dl = activeDist();
      const glitch = dl.some((d) => d.type === 'glitch');
      drawChain(g, W, H, L, glitch);
      for (const r of R.notes) drawRow(g, L, H, r);
      const unit = Math.min(L.laneW / 6 * 0.74, H * 0.075);
      drawDist(g, W, H, unit, dl);
      drawFx(g, W, H, L);
      g.restore();

      if (R.now < 1200 + APPROACH - 800 && !R.trials.length) {
        const y = H * 0.52;
        Sym.text(g, 'Press the BLUE arrow\'s direction as its row hits the line', W / 2, y, { align: 'center', size: Math.max(17, Math.min(26, W * 0.018)), weight: 700, color: COL.blue });
        Sym.text(g, 'ORANGE arrow: press the opposite way', W / 2, y + 30, { align: 'center', size: 16, weight: 600, color: COL.orange });
        Sym.text(g, 'Build the chain. When it breaks, make the next one count.', W / 2, y + 56, { align: 'center', size: 15, weight: 400, color: '#a1a9b7' });
      }
      if (ep < 1) {
        g.fillStyle = 'rgba(255,40,30,' + (0.24 * (1 - ep)).toFixed(3) + ')';
        g.fillRect(0, 0, W, H);
      }
      drawHud(g, W, H);
      return L;
    }

    return { layout, slotX, render };
  };
})();
