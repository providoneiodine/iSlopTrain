/*
 * Derived channels: handling balance, sideslip, wheel slip, grip used,
 * coasting, and per-lap events. A factory: see common.js (runs in the Worker).
 *
 *   T.derive(S, t) -> { ch: { us, beta, betaX, betaRate, counter, slipF, slipR, gripUse,
 *                             balState, phase, coast, tLF.. (tyre means) }, calib }
 *   T.events(lap)  -> [{ kind, i0, i1, iPeak, peak, phase, wheel?, from?, to?, dur }]
 *
 * derive runs on the native-rate session, before laps are cut, because it needs
 * time for rates and lags; laps.js then resamples its channels like any other.
 * A channel whose inputs the file lacks is left out (not zeros), so the lanes
 * box can say "Not in this file".
 *
 * Balance (understeer angle, in steering-wheel units, from the steady-state
 * single-track model: delta = L/R + (alpha_f - alpha_r), 1/R = r/V):
 *     us = (steer - d0) - G * r(t + tau) / V        signed so + = understeer in both directions
 * G (= steering ratio x wheelbase) is fitted per stint from steady, linear-range
 * driving, so us is ~0 through the car's own linear behaviour and measures the
 * limit balance. d0 is the steering offset on straights, tau the yaw lag.
 * Sideslip beta = atan2(vy, vx), turn-signed; betaX is its excess over this
 * session's usual sideslip at the same lateral g. Channels are SI: rad, rad/s.
 *
 * calib: { G, Gspread, d0, tau, ayMax, betaNorm[10], env[] (per envStep m/s), envStep,
 *          thr (us threshold, rad), rFromAy, stints, notes[] }
 */
(function () {
  'use strict';
  IST.Telemetry.def('derive', function (T) {
    const DEG = Math.PI / 180;
    const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

    function quant(list, q) {
      if (!list.length) return NaN;
      const s = Float64Array.from(list).sort();
      return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
    }
    /** Centred moving average over w samples. */
    function smooth(a, w) {
      const n = a.length, o = new Float64Array(n), h = w >> 1;
      let s = 0, c = 0;
      for (let i = 0; i < Math.min(n, h); i++) (s += a[i]), c++;
      for (let i = 0; i < n; i++) {
        if (i + h < n) (s += a[i + h]), c++;
        if (i - h - 1 >= 0) (s -= a[i - h - 1]), c--;
        o[i] = s / c;
      }
      return o;
    }
    function rateOf(a, t) {
      const n = a.length, o = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const p = Math.max(0, i - 1), q = Math.min(n - 1, i + 1);
        const dt = t[q] - t[p];
        o[i] = dt > 0 ? (a[q] - a[p]) / dt : 0;
      }
      return o;
    }
    /** Keep only runs of `on` that last at least minT seconds. */
    function minRun(on, t, minT) {
      const n = on.length;
      for (let i = 0; i < n; ) {
        if (!on[i]) {
          i++;
          continue;
        }
        let j = i;
        while (j < n && on[j]) j++;
        if (t[j - 1] - t[i] < minT) for (let k = i; k < j; k++) on[k] = 0;
        i = j;
      }
      return on;
    }

    T.derive = function (S, t) {
      const C = S.ch, n = S.n, rate = S.rate || 60;
      const out = {}, notes = [];
      const v = C.speed;
      if (!v || n < 50) return { ch: out, calib: null };
      const W = Math.max(3, Math.round(0.15 * rate) | 1);
      const ay = C.latG ? smooth(C.latG, W) : null;
      const ax = C.longG ? smooth(C.longG, W) : null;
      const sw = C.steer ? smooth(C.steer, W) : null;
      const rFromAy = !C.yawRate && !!ay;
      const r = C.yawRate ? smooth(C.yawRate, W) : rFromAy ? ay.map((a, i) => a / Math.max(5, v[i])) : null;
      const vxs = C.vx ? smooth(C.vx, W) : null;
      const vys = C.vy ? smooth(C.vy, W) : null;
      const dsw = sw ? rateOf(sw, t) : null, dr = r ? rateOf(r, t) : null;

      // tyre means from inner / mid / outer, when the file has bands but no single temp
      T.TYRES.forEach((w) => {
        const b = ['_i', '_m', '_o'].map((s) => C['t' + w + s]);
        if (!C['t' + w] && b.every(Boolean)) out['t' + w] = b[0].map((x, i) => (x + b[1][i] + b[2][i]) / 3);
      });

      // clean on-track samples: off pit road, on track, on asphalt, no kerb strike
      let vgMid = NaN;
      if (C.vertG) {
        const s = [];
        for (let i = 0; i < n; i += 7) s.push(C.vertG[i]);
        vgMid = quant(s, 0.5);
      }
      const clean = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        clean[i] = v[i] > 12 && !(C.onPit && C.onPit[i] > 0.5) && (!C.surface || C.surface[i] === 3) &&
          (!C.material || (C.material[i] >= 1 && C.material[i] <= 6)) && (!C.vertG || Math.abs(C.vertG[i] - vgMid) < 5) ? 1 : 0;
      }

      // stints: split where the car leaves pit road
      const cuts = [0];
      if (C.onPit) for (let i = 1; i < n; i++) if (C.onPit[i - 1] > 0.5 && C.onPit[i] <= 0.5) cuts.push(i);
      cuts.push(n);
      const betaT = vys && vxs ? new Float64Array(n) : null;
      if (betaT) for (let i = 0; i < n; i++) betaT[i] = -Math.atan2(vys[i], Math.max(1, vxs[i])) * (ay ? sgn(ay[i]) || 1 : 1);

      function calibrate(a, b) {
        const c = { a, b, fit: 0 };
        const absAy = [];
        if (ay) for (let i = a; i < b; i++) if (clean[i]) absAy.push(Math.abs(ay[i]));
        c.ayMax = quant(absAy, 0.98);
        if (!(c.ayMax > 2)) c.ayMax = NaN;
        if (sw && r) {
          const off = [];
          for (let i = a; i < b; i++) if (clean[i] && v[i] > 30 && Math.abs(r[i]) < 0.01) off.push(sw[i]);
          c.d0 = off.length > 20 ? quant(off, 0.5) : 0;
          // yaw lag: the shift (0-0.25 s) at which steering and yaw rate line up best
          const maxLag = Math.round(0.25 * rate);
          let bestLag = Math.round(0.1 * rate), best = -Infinity;
          if (!rFromAy) {
            for (let L = 0; L <= maxLag; L++) {
              let sxy = 0, sxx = 0, syy = 0;
              for (let i = a; i < b - L; i += 2) {
                if (!clean[i]) continue;
                const x = sw[i] - c.d0, y = r[i + L];
                sxy += x * y;
                sxx += x * x;
                syy += y * y;
              }
              const cor = sxx && syy ? sxy / Math.sqrt(sxx * syy) : -1;
              if (cor > best) (best = cor), (bestLag = L);
            }
          }
          c.lag = bestLag;
          c.tau = bestLag / rate;
          // steering gain from the linear range
          const ratios = [];
          const lo = 0.1 * c.ayMax, hi = 0.35 * c.ayMax;
          for (let i = a + 1; i < b - c.lag - 1; i++) {
            if (!clean[i]) continue;
            const aa = ay ? Math.abs(ay[i]) : NaN;
            if (!(aa > lo && aa < hi)) continue;
            if (Math.abs(dsw[i]) > 20 * DEG || Math.abs(dr[i]) > 0.15) continue;
            const rr = r[i + c.lag];
            if (Math.abs(rr) < 0.02) continue;
            const g = ((sw[i] - c.d0) * v[i]) / rr;
            if (g > 0) ratios.push(g);
          }
          c.fit = ratios.length;
          c.G = quant(ratios, 0.5);
          c.Gspread = ratios.length ? (quant(ratios, 0.75) - quant(ratios, 0.25)) / c.G : NaN;
        }
        if (betaT && ay && c.ayMax > 0) {
          const bins = Array.from({ length: 10 }, () => []);
          for (let i = a; i < b; i++) if (clean[i]) bins[Math.min(9, Math.floor((Math.abs(ay[i]) / c.ayMax) * 10))].push(betaT[i]);
          c.betaNorm = bins.map((x) => (x.length >= 30 ? quant(x, 0.5) : NaN));
          fill(c.betaNorm, 0);
        }
        if (ax && ay) {
          const step = 10 / 3.6;
          const bins = [];
          for (let i = a; i < b; i++) {
            if (!clean[i]) continue;
            const k = Math.floor(v[i] / step);
            (bins[k] = bins[k] || []).push(Math.hypot(ax[i], ay[i]));
          }
          const env = [];
          for (let k = 0; k < bins.length; k++) env[k] = bins[k] && bins[k].length >= 30 ? quant(bins[k], 0.98) : NaN;
          fill(env, NaN);
          for (let k = 1; k < env.length; k++) if (env[k] < env[k - 1]) env[k] = env[k - 1];
          c.env = env;
          c.envStep = step;
        }
        return c;
      }
      /** Fill NaN gaps by linear interpolation, ends from the nearest value (or dflt if all empty). */
      function fill(a, dflt) {
        const good = [];
        a.forEach((x, i) => isFinite(x) && good.push(i));
        if (!good.length) return a.fill(dflt);
        for (let i = 0; i < a.length; i++) {
          if (isFinite(a[i])) continue;
          let p = -1, q = -1;
          for (const g of good) {
            if (g < i) p = g;
            else if (q < 0) q = g;
          }
          a[i] = p < 0 ? a[q] : q < 0 ? a[p] : a[p] + ((a[q] - a[p]) * (i - p)) / (q - p);
        }
        return a;
      }

      const stints = [];
      for (let k = 0; k < cuts.length - 1; k++) if (cuts[k + 1] - cuts[k] > 10) stints.push(calibrate(cuts[k], cuts[k + 1]));
      // a stint too short to fit borrows the nearest one that could
      const ok = (c) => c.fit >= 150 && c.G > 0;
      stints.forEach((c, k) => {
        if (ok(c)) return;
        let best = null;
        for (let d = 1; d < stints.length && !best; d++) best = [stints[k - d], stints[k + d]].find((x) => x && ok(x)) || null;
        if (best) ['G', 'Gspread', 'd0', 'lag', 'tau', 'ayMax', 'betaNorm', 'env', 'envStep'].forEach((key) => !(isFinite(c[key]) || Array.isArray(c[key])) && (c[key] = best[key]));
        if (best) c.borrowed = true;
      });
      const main = stints.slice().sort((p, q) => q.b - q.a - (p.b - p.a))[0];
      if (!main) return { ch: out, calib: null };

      // ------------------------------------------------------- per sample
      const have = { us: !!(sw && r && ay), beta: !!betaT, slip: T.TYRES.every((w) => C['ws' + w]), grip: !!(ax && ay) };
      if (have.us && !stints.some(ok)) {
        have.us = false;
        notes.push('Not enough steady cornering to calibrate the balance channel.');
      }
      const ch = {};
      if (have.us) ['us', 'counter', 'balState'].forEach((k) => (ch[k] = new Float64Array(n)));
      if (have.beta) ['beta', 'betaX', 'betaRate'].forEach((k) => (ch[k] = new Float64Array(n)));
      if (have.slip) ['slipF', 'slipR'].forEach((k) => (ch[k] = new Float64Array(n)));
      if (have.grip) ch.gripUse = new Float64Array(n);
      if (C.throttle && C.brake) (ch.phase = new Float64Array(n)), (ch.coast = new Uint8Array(n));
      const dBeta = have.beta ? rateOf(vys.map((y, i) => Math.atan2(y, Math.max(1, vxs[i]))), t) : null;

      stints.forEach((c) => {
        const thr = 6 * DEG * (c.G > 0 ? c.G / 50 : 1);
        c.thr = thr;
        for (let i = c.a; i < c.b; i++) {
          const fast = v[i] > 12;
          const turn = ay ? sgn(ay[i]) || 1 : 1;
          const band = ay && c.ayMax > 0 ? Math.abs(ay[i]) / c.ayMax : 0;
          let bx = NaN;
          if (have.beta) {
            ch.beta[i] = fast ? betaT[i] : NaN;
            bx = fast && c.betaNorm ? betaT[i] - c.betaNorm[Math.min(9, Math.floor(band * 10))] : NaN;
            ch.betaX[i] = bx;
            ch.betaRate[i] = fast ? -dBeta[i] * turn : NaN;
          }
          if (have.us) {
            if (!fast || !(c.G > 0)) {
              ch.us[i] = ch.balState[i] = NaN;
              ch.counter[i] = 0;
            } else {
              const j = Math.min(n - 1, i + (c.lag || 0));
              const s0 = sw[i] - c.d0;
              const us = (s0 - (c.G * r[j]) / v[i]) * turn;
              ch.us[i] = us;
              const ctr = !rFromAy && Math.abs(r[i]) > 0.1 && Math.abs(s0) > 2 * DEG && sgn(s0) !== sgn(r[i]) ? 1 : 0;
              ch.counter[i] = ctr;
              ch.balState[i] = ctr || us < -thr || bx > 1.5 * DEG ? -1 : us > thr && band > 0.5 ? 1 : 0;
            }
          }
          if (have.slip) {
            if (v[i] < 8) ch.slipF[i] = ch.slipR[i] = NaN;
            else {
              const V = Math.max(5, vxs ? vxs[i] : v[i]);
              const k = (w) => (C['ws' + w][i] - V) / V;
              ch.slipF[i] = Math.min(k('LF'), k('RF'));
              ch.slipR[i] = Math.max(k('LR'), k('RR'));
            }
          }
          if (have.grip) {
            const e = c.env && c.env.length ? c.env[Math.min(c.env.length - 1, Math.floor(v[i] / c.envStep))] : NaN;
            ch.gripUse[i] = v[i] > 8 && e > 0 ? Math.hypot(ax[i], ay[i]) / e : NaN;
          }
          if (ch.phase) {
            const b = C.brake[i], th = C.throttle[i];
            ch.phase[i] = b > 0.05 ? 1 : th > 0.2 ? 3 : band > 0.5 && b <= 0.2 && th <= 0.2 ? 2 : 0;
            ch.coast[i] = th < 0.05 && b < 0.02 && v[i] > 15 ? 1 : 0;
          }
        }
      });
      if (ch.coast) ch.coast = Float64Array.from(minRun(ch.coast, t, 0.25));
      Object.assign(out, ch);

      if (have.us && main.Gspread > 0.5) notes.push('Balance calibration uncertain (steering gain spread ' + Math.round(main.Gspread * 100) + ' %).');
      if (rFromAy) notes.push('No yaw-rate channel: balance is worked out from lateral g.');
      const calib = {
        G: main.G, Gspread: main.Gspread, d0: main.d0, tau: main.tau, ayMax: main.ayMax, betaNorm: main.betaNorm || null,
        env: main.env || null, envStep: main.envStep || null, thr: main.thr, rFromAy,
        stints: stints.map((c) => ({ a: c.a, b: c.b, G: c.G, Gspread: c.Gspread, d0: c.d0, tau: c.tau, ayMax: c.ayMax, fit: c.fit, borrowed: !!c.borrowed })),
        absPresent: !!C.absActive, notes,
      };
      return { ch: out, calib };
    };

    // ------------------------------------------------------------- events
    /**
     * Runs of a per-metre condition on one lap's grid, merged when closer than mergeM
     * and kept when they last at least minT seconds.
     */
    function runs(lap, test, minT, mergeM) {
      const n = lap.n, step = lap.step || 1, list = [];
      let i0 = -1;
      for (let i = 0; i <= n; i++) {
        const on = i < n && test(i);
        if (on && i0 < 0) i0 = i;
        else if (!on && i0 >= 0) {
          const last = list[list.length - 1];
          if (last && (i0 - last[1]) * step < mergeM) last[1] = i - 1;
          else list.push([i0, i - 1]);
          i0 = -1;
        }
      }
      return list.filter(([a, b]) => lap.t[b] - lap.t[a] >= minT || (minT === 0 && b >= a));
    }
    const PHASE = ['', 'entry', 'mid', 'exit'];

    T.events = function (lap) {
      const ev = [];
      const push = (kind, r, peakOf, extra) => {
        let iPeak = r[0], peak = -Infinity;
        for (let i = r[0]; i <= r[1]; i++) {
          const p = peakOf ? peakOf(i) : 0;
          if (p > peak) (peak = p), (iPeak = i);
        }
        const ph = lap.phase ? PHASE[lap.phase[iPeak]] || '' : '';
        ev.push(Object.assign({ kind, i0: r[0], i1: r[1], iPeak, peak: isFinite(peak) ? peak : 0, phase: ph, dur: lap.t[r[1]] - lap.t[r[0]] }, extra ? extra(iPeak) : null));
      };
      if (lap.balState) {
        runs(lap, (i) => lap.balState[i] === 1, 0.15, 10).forEach((r) => push('us', r, (i) => lap.us[i] / DEG));
        runs(lap, (i) => lap.balState[i] === -1, 0.15, 10).forEach((r) => push('os', r, (i) => Math.max(-lap.us[i], lap.betaX ? lap.betaX[i] : -Infinity) / DEG, (k) => {
          // a slide: the excess sideslip is the bigger signal (needs body velocities)
          const slide = lap.betaX ? lap.betaX[k] / DEG : 0, us = -lap.us[k] / DEG;
          return { slide: slide > us ? slide : 0 };
        }));
        runs(lap, (i) => lap.counter[i] > 0.5, 0.15, 10).forEach((r) => push('counter', r, (i) => Math.abs(lap.us[i]) / DEG));
      }
      if (lap.absActive) runs(lap, (i) => lap.absActive[i] > 0.5, 0, 10).forEach((r) => push('abs', r, (i) => (lap.absCut ? lap.absCut[i] : 0)));
      const ws = T.TYRES.every((w) => lap['ws' + w]);
      if (ws) {
        const V = (i) => Math.max(5, lap.vx ? lap.vx[i] : lap.speed[i]);
        const k = (w, i) => (lap['ws' + w][i] - V(i)) / V(i);
        const minK = (i) => Math.min(k('LF', i), k('RF', i), k('LR', i), k('RR', i));
        const maxK = (i) => Math.max(k('LF', i), k('RF', i), k('LR', i), k('RR', i));
        const wheelAt = (pick) => (i) => {
          let best = 'LF';
          T.TYRES.forEach((w) => pick(k(w, i), k(best, i)) && (best = w));
          return { wheel: best };
        };
        if (lap.brake) runs(lap, (i) => lap.speed[i] > 8 && lap.brake[i] > 0.2 && minK(i) < -0.15, 0.1, 10).forEach((r) => push('lock', r, (i) => -minK(i), wheelAt((a, b) => a < b)));
        if (lap.throttle) runs(lap, (i) => lap.speed[i] > 5 && lap.throttle[i] > 0.3 && maxK(i) > 0.1, 0.1, 10).forEach((r) => push('spin', r, (i) => maxK(i), wheelAt((a, b) => a > b)));
      }
      if (lap.material) runs(lap, (i) => lap.material[i] >= 11 && lap.material[i] <= 14, 0, 10).forEach((r) => push('kerb', r));
      if (lap.surface) runs(lap, (i) => lap.surface[i] === 0, 0, 10).forEach((r) => push('off', r));
      if (lap.coast) runs(lap, (i) => lap.coast[i] > 0.5, 0.25, 10).forEach((r) => push('coast', r));
      [['bb', 'BB', 1], ['absSet', 'ABS', 0], ['tcSet', 'TC', 0]].forEach(([key, name, dp]) => {
        const a = lap[key];
        if (!a) return;
        for (let i = 1; i < lap.n; i++) {
          if (isFinite(a[i]) && isFinite(a[i - 1]) && Math.abs(a[i] - a[i - 1]) > 1e-4) ev.push({ kind: 'bbChange', i0: i, i1: i, iPeak: i, peak: 0, phase: '', dur: 0, what: name, from: +a[i - 1].toFixed(dp + 1), to: +a[i].toFixed(dp + 1), dp });
        }
      });
      return ev.sort((p, q) => p.i0 - q.i0);
    };
  });
})();
