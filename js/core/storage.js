/*
 * Local persistence (localStorage): session summaries (latest 300 per drill),
 * per-trial detail (latest 50), settings, controller bindings and prefs.
 */
(function () {
  'use strict';
  const KEY = 'isloptrain.v1';
  const MAX_RESULTS = 300;
  const MAX_DETAIL = 50; // per-trial detail is kept only for the most recent sessions of each drill
  let data = { settings: {}, results: {}, bindings: {}, prefs: {} };

  try {
    const raw = localStorage.getItem(KEY);
    if (raw) data = Object.assign(data, JSON.parse(raw));
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
      if (!parsed || typeof parsed !== 'object' || !parsed.results) throw new Error('Not an iSlopTrain export');
      data = Object.assign({ settings: {}, results: {}, bindings: {}, prefs: {} }, parsed);
      save();
    },
    clearAll() {
      data = { settings: {}, results: {}, bindings: {}, prefs: {} };
      save();
    },
  };
})();
