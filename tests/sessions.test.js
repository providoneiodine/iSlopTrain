/*
 * Guided sessions are plain data that override drill settings by key. A
 * typo there fails silently: the session is hidden from the menu (unknown
 * drill) or the override is ignored (unknown key). This catches both, and
 * values outside what the drill's own settings screen would allow.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const IST = require('./harness').load();

function problem(def, key, value) {
  const f = def.settings.find((x) => x.key === key);
  if (!f) return `"${key}" isn't a ${def.id} setting`;
  if (f.type === 'number' && (typeof value !== 'number' || value < f.min || value > f.max)) return `${key}=${value} is outside ${f.min}-${f.max}`;
  if (f.type === 'select' && !f.options.some((o) => String(o[0]) === String(value))) return `${key}="${value}" isn't one of its options`;
  if (f.type === 'bool' && typeof value !== 'boolean') return `${key}=${value} isn't true/false`;
  return null;
}

test('every session step names a registered drill and only valid settings', () => {
  const problems = [];
  for (const s of IST.sessions) {
    s.steps.forEach((st, i) => {
      const def = IST.getDrill(st.drill);
      if (!def) return problems.push(`${s.id} step ${i + 1}: no drill "${st.drill}"`);
      for (const k in st.settings || {}) {
        const p = problem(def, k, st.settings[k]);
        if (p) problems.push(`${s.id} step ${i + 1}: ${p}`);
      }
    });
  }
  assert.equal(problems.length, 0, '\n' + problems.join('\n'));
});

test('session ids are unique', () => {
  const ids = IST.sessions.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});
