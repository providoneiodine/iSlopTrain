/*
 * The Coaching tab in the Laps panel: one focus, the three stretches costing the most with a cue
 * each, and drills for the next session. page.js hands it the comparisons and the cursor
 * (api below); the analysis is coaching.js and the advice coaching-kb.js.
 */
(function () {
  'use strict';
  IST.Review = IST.Review || {};
  const h = IST.util.h;
  const made = new WeakMap();
  const fmt = (x) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(2);

  /** A source's links, one line each. */
  function sources(ids) {
    const S = IST.Review.CoachKB.SOURCES;
    return h('ul', { class: 'rv-co-src' }, ids.filter((id) => S[id]).map((id) => h('li', null, h('a', { href: S[id][1], target: '_blank', rel: 'noopener' }, S[id][0]))));
  }

  function row(r, rank, R, api, alone) {
    const KB = IST.Review.CoachKB, T = r.pats[0], P = KB.PATTERNS[T.id];
    const sev = alone ? '' : r.lost > 0.15 ? ' hi' : r.lost > 0.05 ? ' mid' : '';
    const often = r.n > 1 ? ' · ' + (T.id === 'inconsistent' ? 'across ' + (r.n + 1) + ' laps' : T.n + ' of ' + r.n + ' laps') : '';
    const head = h('button', { class: 'rv-co-row-head', title: 'Jump to the start of ' + r.name },
      h('span', { class: 'rv-co-name' }, r.name, r.exitStraight && P.phase !== 'entry' ? h('span', { class: 'rv-co-tag', title: 'Exit onto a long straight: time lost here is carried down it' }, 'onto a straight') : null),
      alone ? null : h('span', { class: 'rv-co-lost' + sev, title: 'Typical (median) time lost a lap here, against ' + r.best + ', the quickest through this corner' }, fmt(r.lost)),
      h('span', { class: 'rv-co-diag' }, P.title + often + (alone ? '' : ' · vs ' + r.best)));
    head.addEventListener('click', () => api.jump(r.a, R.cmp));
    head.addEventListener('pointerenter', () => api.preview(r.a, R.cmp));
    head.addEventListener('pointerleave', () => api.preview(-1));
    const more = r.pats.slice(1, 3).map((x) => KB.PATTERNS[x.id].title.toLowerCase());
    return h('li', { class: 'rv-co-row' }, head,
      h('p', { class: 'rv-co-cue' }, h('b', null, 'Try: '), P.cue),
      h('details', { class: 'rv-co-why' }, h('summary', null, 'Why this advice'),
        h('ul', { class: 'rv-co-ev' }, T.ev.map((e) => h('li', null, e))),
        more.length ? h('p', { class: 'muted' }, 'Also here: ' + more.join(', ') + '.') : null,
        h('p', null, P.why), sources(P.sources)));
  }

  function drills(D, api) {
    const KB = IST.Review.CoachKB;
    return h('ul', { class: 'rv-co-drills' }, D.map((d) => {
      const X = KB.DRILLS[d.id], def = X.app && IST.getDrill && IST.getDrill(X.app);
      const name = def ? h('button', { class: 'rv-co-drill-btn', title: 'Open ' + X.name + ' (your laps stay loaded)', onclick: () => api.startDrill(def) }, X.name) : h('b', null, X.name);
      return h('li', null, name, h('span', { class: 'muted' }, ' for ' + d.for.name + ' · ' + KB.PATTERNS[d.for.id].title.toLowerCase()), h('p', null, X.how));
    }));
  }

  function principles() {
    return h('details', { class: 'rv-co-how' }, h('summary', null, 'How this coaching works'),
      IST.Review.CoachKB.PRINCIPLES.map(([t, text, src]) => h('div', { class: 'rv-co-pr' }, h('b', null, t), h('p', null, text), sources(src))));
  }

  /** The tab's body into el. api: { scope, setScope, scopes: [[id, label, n]], get(scope) -> { cmp, label }, jump, preview, startDrill }. */
  function render(el, api) {
    el.innerHTML = '';
    const scopeLine = h('div', { class: 'rv-co-scope', role: 'group', 'aria-label': 'Laps the advice is based on' },
      h('span', { class: 'muted' }, 'Based on '),
      api.scopes.map(([id, label, n], i) => [i ? h('span', { class: 'muted' }, ' / ') : null,
        h('button', { class: 'rv-co-scope-b' + (id === api.scope ? ' on' : ''), 'aria-pressed': String(id === api.scope), disabled: n ? null : true, onclick: () => api.setScope(id) }, label + ' (' + n + ')')]));
    el.append(scopeLine);
    const body = h('div', { class: 'rv-co-body' }, h('div', { class: 'rv-co-skel' }), h('div', { class: 'rv-co-skel short' }), h('div', { class: 'rv-co-skel' }));
    el.append(body);
    const fill = () => {
      if (!body.isConnected) return;
      const R = api.get(api.scope);
      body.innerHTML = '';
      if (!R || !R.cmp) return body.append(h('p', { class: 'hint' }, 'Pick a reference lap to coach against.'));
      let rep = made.get(R.cmp);
      if (!rep) made.set(R.cmp, (rep = IST.Review.Coaching.report(R.cmp)));
      body.append(h('p', { class: 'rv-co-meta muted' }, R.label + (isFinite(rep.ideal) && rep.ideal < rep.bestLap - 0.005 ? ' · your best corners add up to ' + IST.Review.Compare.fmtLap(rep.ideal) : '') + (isFinite(rep.spread) ? ' · lap times spread ' + rep.spread.toFixed(2) + ' s' : '') + (rep.dropped ? ' · ' + rep.dropped + (rep.dropped === 1 ? ' slow or part lap' : ' slow or part laps') + ' left out' : '')));
      if (rep.missing) return body.append(h('p', { class: 'hint' }, 'Coaching needs brake and throttle channels, and this file has no pedal data.'));
      const F = rep.focus;
      if (!F) {
        body.append(h('p', { class: 'rv-co-head' }, rep.alone ? 'Nothing stands out on this lap on its own.' : 'No stretch loses time in a way that repeats. Nice and tidy.'));
        if (rep.alone) body.append(h('p', { class: 'hint' }, 'Tick another lap, or switch to the whole session, to see where the time goes.'));
        return body.append(principles());
      }
      const P = IST.Review.CoachKB.PATTERNS[F.pat.id];
      body.append(h('p', { class: 'rv-co-head' }, rep.alone
        ? 'On this lap alone, ' + F.row.name + ' stands out. Focus next session: ' + P.title.toLowerCase() + ' there.'
        : 'Most time is at ' + F.row.name + ', ' + fmt(F.row.lost) + ' s a lap. Focus next session: ' + P.title.toLowerCase() + ' there.'));
      if (rep.alone) body.append(h('p', { class: 'hint' }, 'With no lap to compare, this reads the lap’s own habits. Tick another lap to see where the time goes.'));
      body.append(h('ol', { class: 'rv-co-rows' }, rep.rows.map((r, i) => row(r, i, R, api, rep.alone))));
      if (rep.drills.length) body.append(h('h3', { class: 'rv-co-h' }, 'Drills before next session'), drills(rep.drills, api));
      body.append(principles());
    };
    // a whole session takes a moment to line up, so the skeleton paints first
    setTimeout(fill, 30);
  }

  IST.Review.CoachPanel = { render };
})();
