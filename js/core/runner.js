/*
 * Drill runner: owns the canvas, the animation loop, pause/resume and the
 * drill lifecycle. A drill instance (returned by def.create(ctx)) implements:
 *
 *   update(dt, clock, ts)        simulation step; clock = ms of unpaused time
 *   render(g, W, H, ts, paused)  draw one frame (CSS pixels); ts = rAF time
 *   onAction(action, t, src)     input; t in the same timebase as ts
 *   onPause() / onResume()       optional
 *   result()                     -> { summary: {...}, ... }
 *
 * ctx gives the drill: settings, history (past results), W/H, clock(),
 * frameInterval() and finish().
 */
(function () {
  'use strict';
  const U = IST.util;

  IST.Runner = {
    active: null,

    run(def, settings) {
      return new Promise((resolve) => {
        const canvas = document.getElementById('stage');
        const overlay = document.getElementById('pause-overlay');
        const g = canvas.getContext('2d', { alpha: false });
        let W = 0, H = 0, clock = 0, last = null, paused = false, done = false, raf = 0, inst = null;
        const dts = [];

        function resize() {
          const dpr = Math.min(2, window.devicePixelRatio || 1);
          W = canvas.clientWidth || window.innerWidth;
          H = canvas.clientHeight || window.innerHeight;
          canvas.width = Math.round(W * dpr);
          canvas.height = Math.round(H * dpr);
          g.setTransform(dpr, 0, 0, dpr, 0, 0);
          if (inst && inst.resize) inst.resize(W, H);
        }

        const ctx = {
          def,
          settings,
          history: IST.Storage.getResults(def.id),
          get W() { return W; },
          get H() { return H; },
          clock: () => clock,
          frameInterval: () => (dts.length ? U.median(dts) : 1000 / 60),
          finish: () => end(true),
        };

        function setPaused(p) {
          if (done || p === paused) return;
          paused = p;
          overlay.classList.toggle('hidden', !p);
          if (p && inst.onPause) inst.onPause();
          if (!p && inst.onResume) inst.onResume();
        }

        const onVis = () => {
          if (document.hidden) setPaused(true);
        };

        const off = IST.Input.on((a, t, src) => {
          if (done) return;
          if (a === 'pause') return setPaused(!paused);
          if (paused) {
            if (a === 'confirm') setPaused(false);
            return;
          }
          if (inst.onAction) inst.onAction(a, t, src);
        });

        function end(save) {
          if (done) return;
          done = true;
          cancelAnimationFrame(raf);
          off();
          window.removeEventListener('resize', resize);
          document.removeEventListener('visibilitychange', onVis);
          overlay.classList.add('hidden');
          overlay.onclick = null;
          IST.Runner.active = null;
          let result = null;
          if (save) {
            result = inst.result();
            result.date = Date.now();
            result.drill = def.id;
            result.settings = settings;
            result.durationMs = Math.round(clock);
            result.refreshHz = Math.round(1000 / ctx.frameInterval());
          }
          if (inst.destroy) inst.destroy();
          resolve(result);
        }

        overlay.onclick = (e) => {
          const act = e.target && e.target.dataset ? e.target.dataset.act : null;
          if (act === 'resume') setPaused(false);
          else if (act === 'finish') end(true);
          else if (act === 'quit') end(false);
          else if (act === 'fullscreen' && IST.toggleFullscreen) IST.toggleFullscreen();
        };
        window.addEventListener('resize', resize);
        document.addEventListener('visibilitychange', onVis);

        resize();
        inst = def.create(ctx);
        IST.Runner.active = inst;

        function frame(ts) {
          if (done) return;
          if (last !== null) {
            const d = ts - last;
            if (d > 2 && d < 100) {
              dts.push(d);
              if (dts.length > 240) dts.shift();
            }
          }
          const dt = last === null ? 0 : Math.min(50, ts - last);
          last = ts;
          if (!paused) {
            clock += dt;
            inst.update(dt, clock, ts);
          }
          if (!done) inst.render(g, W, H, ts, paused);
          raf = requestAnimationFrame(frame);
        }
        raf = requestAnimationFrame(frame);
      });
    },
  };
})();
