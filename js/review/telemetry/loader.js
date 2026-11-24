/*
 * Loads telemetry files off the main thread.
 *
 *   IST.Telemetry.load(files, onProgress) -> Promise<{ sessions, errors }>
 *     files       File objects (from a picker or a drop); an .ldx is paired
 *                 with the .ld of the same name and not loaded on its own
 *     onProgress  (fraction 0..1, label) while it works
 *     sessions    one T.process() result per file (see laps.js), plus `file`
 *     errors      [{ file, message }] for files that couldn't be read
 *
 * The Worker is built from the factories' source (see common.js), as a Blob,
 * so it works from file:// with no extra worker file to fetch. If a Worker
 * can't be made, the same code runs here and the page waits for it.
 * Only the cut laps come back (their typed arrays are transferred), never the
 * whole file, so a long stint costs a few MB of memory once loaded.
 */
(function () {
  'use strict';
  const Tel = IST.Telemetry;

  // runs inside the Worker, with the pipeline built into the global T
  function workerMain(e) {
    const m = e.data;
    const post = (o, tr) => self.postMessage(Object.assign({ id: m.id }, o), tr || []);
    m.file.arrayBuffer().then((buf) => {
      try {
        const r = T.process(m.file.name, buf, { sidecar: m.sidecar, progress: (p, label) => post({ progress: p, label }) });
        const tr = [];
        r.laps.forEach((l) => ['t', 'x', 'y', 'z', 'speed', 'throttle', 'brake', 'steer', 'gear', 'rpm'].forEach((k) => l[k] && tr.push(l[k].buffer)));
        post({ done: r }, tr);
      } catch (err) {
        post({ error: String((err && err.message) || err) });
      }
    }, (err) => post({ error: 'Could not read the file: ' + err }));
  }

  /** The Worker's whole source: every factory, then the message handler. */
  Tel.workerSource = () => '"use strict";var T={};\n' + Tel.factories.map((f) => '(' + f.fn.toString() + ')(T);').join('\n') + '\nself.onmessage=' + workerMain.toString() + ';';

  let worker = null, nextId = 1;
  const pending = {};
  function getWorker() {
    if (worker !== null) return worker;
    try {
      const url = URL.createObjectURL(new Blob([Tel.workerSource()], { type: 'text/javascript' }));
      worker = new Worker(url);
      worker.onmessage = (e) => {
        const p = pending[e.data.id];
        if (!p) return;
        if (e.data.progress != null) p.progress(e.data.progress, e.data.label);
        else {
          delete pending[e.data.id];
          if (e.data.error) p.reject(new Error(e.data.error));
          else p.resolve(e.data.done);
        }
      };
      worker.onerror = (e) => {
        // a Worker that fails to start: finish what's pending on this thread
        console.warn('Telemetry worker failed, parsing on the main thread', e.message);
        worker.terminate();
        worker = false;
        Object.keys(pending).forEach((id) => {
          const p = pending[id];
          delete pending[id];
          local(p.file, p.sidecar, p.progress).then(p.resolve, p.reject);
        });
      };
    } catch (err) {
      worker = false;
    }
    return worker;
  }

  function local(file, sidecar, progress) {
    return file.arrayBuffer().then(
      (buf) =>
        new Promise((res, rej) =>
          setTimeout(() => {
            try {
              res(Tel.lib().process(file.name, buf, { sidecar, progress }));
            } catch (err) {
              rej(err);
            }
          }, 30)
        )
    );
  }

  function one(file, sidecar, progress) {
    const w = getWorker();
    if (!w) return local(file, sidecar, progress);
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending[id] = { resolve, reject, progress, file, sidecar };
      w.postMessage({ id, file, sidecar });
    });
  }

  const base = (n) => n.replace(/\.[^.]+$/, '').toLowerCase();

  Tel.load = async function (files, onProgress) {
    files = Array.from(files || []);
    const ldx = {};
    for (const f of files) if (/\.ldx$/i.test(f.name)) ldx[base(f.name)] = await f.text();
    const main = files.filter((f) => !/\.ldx$/i.test(f.name));
    const sessions = [], errors = [];
    for (let i = 0; i < main.length; i++) {
      const f = main[i];
      const prog = (p, label) => onProgress && onProgress((i + Math.min(1, p || 0)) / main.length, f.name + (label ? ' · ' + label : ''));
      prog(0, 'Opening');
      try {
        const r = await one(f, ldx[base(f.name)] || null, prog);
        r.file = f.name;
        r.size = f.size;
        sessions.push(r);
      } catch (err) {
        errors.push({ file: f.name, message: err.message || String(err) });
      }
    }
    if (onProgress) onProgress(1, 'Done');
    return { sessions, errors };
  };
})();
