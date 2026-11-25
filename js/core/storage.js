/*
 * Local persistence (localStorage): session summaries (latest 300 per drill),
 * per-trial detail (latest 50), settings, controller bindings and prefs.
 */
(function () {
  'use strict';
  const KEY = 'isloptrain.v1';
  const MAX_RESULTS = 300;
  const MAX_DETAIL = 50; // per-trial detail is kept only for the most recent sessions of each drill
  const EMPTY = () => ({ settings: {}, results: {}, bindings: {}, prefs: {} });
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  /** A saved or imported blob as a full data record: missing or malformed sections start empty. */
  function normalise(parsed) {
    const out = EMPTY();
    for (const k in out) if (isObj(parsed[k])) out[k] = parsed[k];
    for (const id in out.results) {
      if (!Array.isArray(out.results[id])) delete out.results[id];
      else out.results[id] = out.results[id].filter((r) => isObj(r) && isObj(r.summary));
    }
    return out;
  }
  let data = EMPTY();

  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (isObj(parsed)) data = normalise(parsed);
  } catch (e) {
    console.warn('iSlopTrain: could not read saved data', e);
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('iSlopTrain: could not save data', e);
    }
  }

  IST.Storage = {
    getSettings(def) {
      const s = {};
      def.settings.forEach((f) => (s[f.key] = f.default));
      return Object.assign(s, data.settings[def.id] || {});
    },
    setSettings(id, values) {
      data.settings[id] = values;
      save();
    },
    resetSettings(id) {
      delete data.settings[id];
      save();
    },

    addResult(id, result) {
      const list = (data.results[id] = data.results[id] || []);
      list.push(result);
      if (list.length > MAX_RESULTS) list.splice(0, list.length - MAX_RESULTS);
      for (let i = 0; i < list.length - MAX_DETAIL; i++) delete list[i].detail;
      save();
    },
    getResults(id) {
      return data.results[id] || [];
    },

    getBindings() {
      return data.bindings || {};
    },
    setBindings(b) {
      data.bindings = b;
      save();
    },

    getPref(k, d) {
      return k in data.prefs ? data.prefs[k] : d;
    },
    setPref(k, v) {
      data.prefs[k] = v;
      save();
    },

    exportJSON() {
      return JSON.stringify(data, null, 2);
    },
    importJSON(text) {
      const parsed = JSON.parse(text);
      if (!isObj(parsed) || !isObj(parsed.results)) throw new Error('Not an iSlopTrain export');
      data = normalise(parsed);
      save();
    },
    clearAll() {
      data = EMPTY();
      save();
    },
  };
})();
