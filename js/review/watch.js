/*
 * Folder watch: while the app is open, polls a user-picked telemetry folder and offers new .ibt files to the Lap Viewer.
 * Chrome/Edge only (File System Access API); the handle is kept in IndexedDB so a reload needs one click to resume.
 * A file is offered only once its size stops changing, since iRacing writes it for the whole stint.
 */
(function () {
  'use strict';
  const POLL_MS = 3000, STABLE_MS = 8000;
  const EXT = /\.ibt$/i;

  /**
   * Feed it each scan's [{ name, size, mtime }]; it returns the files that are new and
   * have settled. Files there at the first scan are the baseline and never offered,
   * unless `known` (names seen before a reload) is given, which then sets the baseline.
   */
  function tracker(stableMs, known) {
    const seen = new Set(known || []);
    const live = new Map(); // name -> { size, mtime, since }
    let first = !known;
    return {
      seen,
      scan(entries, now) {
        const ready = [];
        const names = new Set();
        for (const e of entries) {
          names.add(e.name);
          if (seen.has(e.name)) continue;
          if (first) {
            seen.add(e.name);
            continue;
          }
          const p = live.get(e.name);
          if (!p || p.size !== e.size || p.mtime !== e.mtime) live.set(e.name, { size: e.size, mtime: e.mtime, since: now });
          else if (e.size > 0 && now - p.since >= stableMs) {
            live.delete(e.name);
            seen.add(e.name);
            ready.push(e.name);
          }
        }
        // a file deleted before it settled is forgotten
        for (const n of live.keys()) if (!names.has(n)) live.delete(n);
        first = false;
        return ready;
      },
    };
  }

  IST.Review.Watch = { tracker };
  if (typeof window === 'undefined' || typeof window.showDirectoryPicker !== 'function' || typeof indexedDB === 'undefined') return;

  const U = IST.util, h = U.h;
  // ------------------------------------------------------------ handle store
  const DB = 'ist-watch', STORE = 'kv';
  function db() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function kv(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(STORE, mode), r = fn(t.objectStore(STORE));
      t.oncomplete = () => res(r && r.result);
      t.onerror = () => rej(t.error);
    });
  }
  const get = (k) => kv('readonly', (s) => s.get(k)).catch(() => null);
  const put = (k, v) => kv('readwrite', (s) => s.put(v, k)).catch(() => {});
  const del = (k) => kv('readwrite', (s) => s.delete(k)).catch(() => {});

  // ------------------------------------------------------------------ state
  const W = { dir: null, status: 'off', track: null, timer: 0, busy: false, pending: [], err: '' };
  // status: off (no folder), paused (saved folder, needs a click), on, error

  async function start(dir, known) {
    stop();
    W.dir = dir;
    W.track = tracker(STABLE_MS, known);
    W.status = 'on';
    W.err = '';
    await poll();
    W.timer = setInterval(poll, POLL_MS);
    sync();
  }
  function stop() {
    clearInterval(W.timer);
    W.timer = 0;
  }

  async function poll() {
    if (W.busy || !W.dir) return;
    W.busy = true;
    try {
      const entries = [];
      for await (const fh of W.dir.values()) {
        if (fh.kind !== 'file' || !EXT.test(fh.name)) continue;
        try {
          const f = await fh.getFile();
          entries.push({ name: fh.name, size: f.size, mtime: f.lastModified, fh });
        } catch (e) {
          /* still locked by the sim: try again next scan */
        }
      }
      const before = W.track.seen.size;
      const ready = W.track.scan(entries, Date.now());
      if (W.track.seen.size !== before) put('seen', [...W.track.seen]);
      ready.forEach((n) => {
        const e = entries.find((x) => x.name === n);
        if (e) W.pending.push(e);
      });
      if (ready.length) prompt();
    } catch (e) {
      // folder moved, deleted or permission withdrawn
      stop();
      W.status = 'error';
      W.err = (e && e.message) || String(e);
      sync();
    }
    W.busy = false;
  }

  // ------------------------------------------------------------------ actions
  async function pick() {
    let dir;
    try {
      dir = await window.showDirectoryPicker({ id: 'ist-telemetry', mode: 'read', startIn: 'documents' });
    } catch (e) {
      return; // cancelled
    }
    await put('dir', dir);
    await del('seen');
    W.pending = [];
    start(dir, null);
  }
  async function resume() {
    if (!W.dir) return;
    try {
      if ((await W.dir.requestPermission({ mode: 'read' })) !== 'granted') return;
    } catch (e) {
      return;
    }
    start(W.dir, (await get('seen')) || []);
  }
  async function forget() {
    stop();
    W.dir = null;
    W.pending = [];
    W.status = 'off';
    await del('dir');
    await del('seen');
    sync();
    prompt();
  }

  async function load(list) {
    W.pending = W.pending.filter((e) => !list.includes(e));
    prompt();
    const files = [];
    for (const e of list) {
      try {
        files.push(await e.fh.getFile());
      } catch (err) {
        /* gone since it was offered */
      }
    }
    if (!files.length) return;
    IST.Review.open({ files });
  }

  // --------------------------------------------------------------- the card
  const mb = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
  function sync() {
    const card = document.getElementById('review-card');
    if (!card) return;
    let box = card.querySelector('.rv-watch');
    if (!box) card.append((box = h('div', { class: 'rv-watch' })));
    box.innerHTML = '';
    const name = W.dir ? W.dir.name : '';
    if (W.status === 'on') {
      box.append(
        h('span', { class: 'rv-watch-dot on', 'aria-hidden': 'true' }),
        h('span', { class: 'rv-watch-text' }, 'Watching ', h('b', null, name), ' for new laps'),
        h('button', { class: 'btn small ghost', onclick: pick, title: 'Watch a different folder' }, 'Change'),
        h('button', { class: 'btn small ghost', onclick: forget }, 'Stop'));
    } else if (W.status === 'paused' || W.status === 'error') {
      box.append(
        h('span', { class: 'rv-watch-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'rv-watch-text' }, W.status === 'error' ? 'Lost access to ' : 'Not watching ', h('b', null, name)),
        h('button', { class: 'btn small', onclick: resume, title: 'The browser asks once each time the app is reopened' }, 'Resume watching'),
        h('button', { class: 'btn small ghost', onclick: forget }, 'Forget'));
    } else {
      box.append(
        h('span', { class: 'rv-watch-text muted' }, 'Get offered new laps as iRacing saves them.'),
        h('button', { class: 'btn small', onclick: pick, title: 'Usually Documents\\iRacing\\telemetry' }, 'Watch telemetry folder'));
    }
  }

  // --------------------------------------------------------------- the prompt
  // kept off a running drill: it waits until the drill ends
  const inDrill = () => !document.getElementById('screen-drill').classList.contains('hidden');
  function prompt() {
    let el = document.getElementById('rv-watch-prompt');
    if (!W.pending.length || inDrill()) {
      if (el) el.remove();
      return;
    }
    if (!el) document.body.append((el = h('div', { id: 'rv-watch-prompt', class: 'rv-watch-prompt', role: 'status', 'aria-live': 'polite' })));
    el.innerHTML = '';
    const n = W.pending.length;
    el.append(
      h('div', { class: 'rv-watch-title' }, n === 1 ? 'New telemetry recorded' : n + ' new telemetry files'),
      h('ul', null, ...W.pending.map((e) => h('li', null,
        h('span', { class: 'rv-watch-file', title: e.name }, e.name.replace(EXT, '')),
        h('span', { class: 'muted' }, mb(e.size)),
        h('button', { class: 'btn small', onclick: () => load([e]) }, 'Load'),
        h('button', { class: 'btn small ghost', onclick: () => ((W.pending = W.pending.filter((x) => x !== e)), prompt()), title: 'Not now' }, '✕')))),
      h('div', { class: 'modal-actions' },
        n > 1 ? h('button', { class: 'btn primary small', onclick: () => load(W.pending.slice()) }, 'Load all') : null,
        h('button', { class: 'btn ghost small', onclick: () => ((W.pending = []), prompt()) }, 'Dismiss')));
  }
  // show what waited out a drill once the menu or results are back
  new MutationObserver(() => W.pending.length && prompt()).observe(document.getElementById('screen-drill'), { attributes: true, attributeFilter: ['class'] });

  // ------------------------------------------------------------------- boot
  (async () => {
    const dir = await get('dir');
    if (dir) {
      W.dir = dir;
      let p = 'prompt';
      try {
        p = await dir.queryPermission({ mode: 'read' });
      } catch (e) {
        /* treat as needing a click */
      }
      if (p === 'granted') return start(dir, (await get('seen')) || []);
      W.status = 'paused';
    }
    sync();
  })();
})();
