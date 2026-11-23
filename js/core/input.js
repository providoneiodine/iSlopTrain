/*
 * Unified input -> abstract actions: up, down, left, right, confirm, pause.
 *
 * Sources: keyboard (arrows/WASD, Space/Enter, Esc/P), standard-mapped
 * gamepads (d-pad, A, Start) and user-learned bindings for any wheel or
 * button box (buttons, POV hats and axes), so drills can be answered with
 * hands on the wheel. Listeners get (action, timestamp, source); timestamps
 * share the performance.now() timebase with requestAnimationFrame.
 *
 * Note: gamepads are polled once per animation frame, so pad timings carry
 * up to one frame (~17 ms @60 Hz) of extra latency versus the keyboard.
 */
(function () {
  'use strict';

  const KEYMAP = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
    Space: 'confirm', Enter: 'confirm', NumpadEnter: 'confirm',
    Escape: 'pause', KeyP: 'pause',
  };
  const KEY_LABELS = {
    up: '↑ / W', down: '↓ / S', left: '← / A', right: '→ / D', confirm: 'Space / Enter', pause: 'Esc / P',
  };
  const STD_PAD = { 12: 'up', 13: 'down', 14: 'left', 15: 'right', 0: 'confirm', 9: 'pause' };
  const ACTIONS = [
    ['up', 'Up'], ['down', 'Down'], ['left', 'Left'], ['right', 'Right'],
    ['confirm', 'Confirm / react'], ['pause', 'Pause'],
  ];

  const listeners = new Set();
  let bindings = {}; // action -> [{kind:'button'|'axis', pad, index, mode?, value?, label}]
  let learning = null;
  const btnPrev = new Map(); // pad.index -> bool[]
  const axisActive = new Map(); // binding object -> bool

  function emit(action, t, src) {
    listeners.forEach((fn) => {
      try {
        fn(action, t, src);
      } catch (e) {
        console.error(e);
      }
    });
  }

  window.addEventListener('keydown', (e) => {
    const a = KEYMAP[e.code];
    if (!a) return;
    if (Input.capture) e.preventDefault();
    if (e.repeat) return;
    emit(a, e.timeStamp || performance.now(), 'key');
  });

  const shortName = (id) => (id || 'Controller').replace(/\(.*?\)/g, '').trim().slice(0, 32) || 'Controller';

  function addBinding(action, b) {
    // a physical input maps to exactly one action
    for (const a in bindings) {
      bindings[a] = bindings[a].filter((x) => !(x.pad === b.pad && x.kind === b.kind && x.index === b.index && x.value === b.value));
    }
    (bindings[action] = bindings[action] || []).push(b);
    IST.Storage.setBindings(bindings);
  }

  function finishLearn(b) {
    const l = learning;
    learning = null;
    if (b) addBinding(l.action, b);
    if (l.cb) l.cb(b);
  }

  function onButton(p, i, now) {
    if (learning) {
      finishLearn({ kind: 'button', pad: p.id, index: i, label: shortName(p.id) + ' · button ' + i });
      return;
    }
    let action = null;
    for (const a in bindings) {
      if (bindings[a].some((b) => b.kind === 'button' && b.pad === p.id && b.index === i)) {
        action = a;
        break;
      }
    }
    if (!action && p.mapping === 'standard') action = STD_PAD[i] || null;
    if (action) emit(action, now, 'pad');
  }

  const axisOn = (b, v) => (b.mode === 'thresh' ? v * b.value > 0.6 : Math.abs(v - b.value) < 0.08);

  function poll() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const now = performance.now();
    if (learning && now - learning.started > 15000) finishLearn(null);
    for (const p of pads) {
      if (!p || !p.connected) continue;
      let prev = btnPrev.get(p.index);
      if (!prev || prev.length !== p.buttons.length) {
        prev = p.buttons.map((b) => b.pressed);
        btnPrev.set(p.index, prev); // don't fire on first sight
      }
      for (let i = 0; i < p.buttons.length; i++) {
        const b = p.buttons[i];
        const down = b.pressed || b.value > 0.6;
        if (down && !prev[i]) onButton(p, i, now);
        prev[i] = down;
      }

      if (learning) {
        let base = learning.base.get(p.index);
        if (!base) learning.base.set(p.index, (base = Array.from(p.axes)));
        for (let i = 0; i < p.axes.length && learning; i++) {
          const v = p.axes[i];
          if (Math.abs(v - base[i]) > 0.5) {
            const thresh = Math.abs(base[i]) < 0.3;
            const value = thresh ? Math.sign(v) : Math.round(v * 100) / 100;
            finishLearn({
              kind: 'axis', pad: p.id, index: i, mode: thresh ? 'thresh' : 'exact', value,
              label: shortName(p.id) + ' · axis ' + i + (thresh ? (value > 0 ? ' +' : ' −') : ' = ' + value.toFixed(2)),
            });
          }
        }
        continue;
      }

      for (const a in bindings) {
        for (const b of bindings[a]) {
          if (b.kind !== 'axis' || b.pad !== p.id || b.index >= p.axes.length) continue;
          const on = axisOn(b, p.axes[b.index]);
          if (on && !axisActive.get(b)) emit(a, now, 'pad');
          axisActive.set(b, on);
        }
      }
    }
  }

  (function loop() {
    try {
      poll();
    } catch (e) {
      console.error(e);
    }
    requestAnimationFrame(loop);
  })();

  const Input = {
    capture: false,
    ACTIONS,
    KEY_LABELS,
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    learn(action, cb) {
      learning = { action, cb, base: new Map(), started: performance.now() };
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const p of pads) if (p) learning.base.set(p.index, Array.from(p.axes));
    },
    cancelLearn() {
      learning = null;
    },
    isLearning() {
      return !!learning;
    },
    bindingsFor(action) {
      return bindings[action] || [];
    },
    clear(action) {
      delete bindings[action];
      IST.Storage.setBindings(bindings);
    },
    load() {
      bindings = JSON.parse(JSON.stringify(IST.Storage.getBindings() || {}));
    },
    pads() {
      return Array.from(navigator.getGamepads ? navigator.getGamepads() : []).filter(Boolean);
    },
  };

  IST.Input = Input;
  Input.load();
})();
