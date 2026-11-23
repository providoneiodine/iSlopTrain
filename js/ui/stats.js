/*
 * Stats page: aim-trainer-style progress dashboard.
 *
 *   filters (range, drill) -> overview tiles -> improvement notes + in-sim
 *   work-ons -> activity calendar -> per-drill deep dives (primary chart,
 *   small multiples for every metric, weak-spot breakdowns, session table).
 *
 * All numbers come from IST.Storage results; analysis from IST.Analysis and
 * each drill's analyze().
 */
(function () {
  'use strict';
  const U = IST.util, h = U.h, A = IST.Analysis, Ch = IST.Charts;
  const RANGES = [['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['all', 'All time']];
  const state = { range: 'all', drill: 'all' };
  let draws = [];

  const root = () => document.getElementById('screen-stats');
  const inRange = (r) => state.range === 'all' || r.date >= Date.now() - Number(state.range) * 86400000;
  const fmtFor = (m) => (v) => A.fmt(m, v);
  const tickFor = (m) => (v) => (m.pct ? Math.round(v * 100) + '%' : U.fmt(v, Math.abs(v) < 10 && m.digits ? 1 : 0));

  function chartBox(draw, cls) {
    const box = h('div', { class: 'viz-box ' + (cls || '') });
    draws.push(() => draw(box));
    return box;
  }
  function drawAll() {
    draws.forEach((f) => {
      try {
        f();
      } catch (e) {
        console.error(e);
      }
    });
  }
  let resizeT = 0;
  window.addEventListener('resize', () => {
    if (root().classList.contains('hidden')) return;
    clearTimeout(resizeT);
    resizeT = setTimeout(drawAll, 150);
  });

  function tile(value, label, sub) {
    return h('div', { class: 'tile' }, h('div', { class: 'tile-v' }, value), h('div', { class: 'tile-l' }, label), sub ? h('div', { class: 'tile-s' }, sub) : null);
  }

  function trendBadge(t, compact, m) {
    if (!t.enough) return h('span', { class: 'delta flat' }, '');
    const what = 'last ' + t.k + ' vs previous ' + t.k + ' sessions';
    // counts (jump starts, guesses...) near zero: show the absolute change per session, not a silly %
    const isCount = m && !m.pct && !m.unit;
    const d = t.recent - t.prior;
    if (isCount ? Math.abs(d) < 0.15 : t.flat) return h('span', { class: 'delta flat', title: 'No real change, ' + what }, '● flat');
    const label = (t.good ? '▲ ' : '▼ ') + (isCount ? (d > 0 ? '+' : '−') + Math.abs(d).toFixed(1) + '/session' : A.pctTxt(t.pct) + (t.good ? ' better' : ' worse'));
    return h('span', { class: 'delta ' + (t.good ? 'good' : 'bad'), title: label + ', ' + what }, label, compact ? null : h('span', { class: 'muted' }, ' · ' + what));
  }

  function noteItem(n) {
    const icon = n.tone === 'good' ? '▲' : n.tone === 'bad' ? '▼' : '●';
    return h('li', { class: 'note note-' + n.tone }, h('span', { class: 'note-ic', 'aria-label': n.tone === 'good' ? 'improvement' : n.tone === 'bad' ? 'needs work' : 'info' }, icon), h('span', null, n.text));
  }

  function insimItem(s, i) {
    const tip = A.TIPS[s.id];
    if (!tip) return null;
    const train = tip.train ? IST.getDrill(tip.train) : null;
    return h('li', { class: 'insim' },
      h('div', { class: 'insim-rank' }, String(i + 1)),
      h('div', null,
        h('div', { class: 'insim-title' }, tip.title),
        h('p', { class: 'insim-text' }, tip.text),
        h('ul', { class: 'insim-ev' }, s.evidence.map((e) => h('li', null, e))),
        train ? h('button', { class: 'btn small', onclick: () => IST.App.startDrill(train) }, 'Train: ' + train.name) : null));
  }

  function drillSection(rep) {
    const def = rep.def, pm = rep.pm, res = rep.results;
    const last = res[res.length - 1];
    const dates = res.map((r) => r.date);
    const totalMin = res.reduce((s, r) => s + (r.durationMs || 0), 0) / 60000;

    const head = h('div', { class: 'ds-head' },
      h('div', null, h('span', { class: 'tag' }, def.category || 'Drill'), h('h2', { class: 'ds-title' }, def.name)),
      h('div', { class: 'card-actions' }, h('button', { class: 'btn primary small', onclick: () => IST.App.startDrill(def) }, 'Start')));

    const tiles = h('div', { class: 'tiles' },
      tile(A.fmt(pm, last.summary[pm.key]), 'Last'),
      tile(A.fmt(pm, rep.pb.value), 'Best', rep.pb.idx >= 0 ? A.shortDate(res[rep.pb.idx].date) : ''),
      h('div', { class: 'tile' }, h('div', { class: 'tile-v tile-trend' }, trendBadge(rep.trend)), h('div', { class: 'tile-l' }, 'Trend')),
      tile(String(res.length), 'Sessions', Math.round(totalMin) + ' min'));

    const primary = h('div', { class: 'card' },
      h('div', { class: 'card-h' }, h('h3', null, pm.label), h('span', { class: 'muted small' }, (pm.better === 'lower' ? 'lower is better' : 'higher is better'))),
      chartBox((box) => Ch.line(box, { values: rep.values, dates, fmt: fmtFor(pm), fmtTick: tickFor(pm), pct: pm.pct, better: pm.better, pb: rep.pb, height: 230, title: pm.label })));

    // small multiples: every other metric with data
    const others = def.metrics.filter((m) => m !== pm && m.key !== 'trials' && m.key !== 'valid' && A.values(res, m.key).some(U.isNum));
    const multiples = others.length
      ? h('div', { class: 'grid-multi' }, others.map((m) => {
          const vals = A.values(res, m.key);
          const t = A.trend(vals, m.better);
          return h('div', { class: 'card card-sm', title: m.hint || '' },
            h('div', { class: 'card-h' }, h('h4', null, m.label), m.better ? trendBadge(t, true, m) : null),
            h('div', { class: 'sm-last' }, A.fmt(m, A.mean(vals.slice(-1))), h('span', { class: 'muted small' }, '  best ' + A.fmt(m, A.pb(vals, m.better).value))),
            chartBox((box) => Ch.line(box, { values: vals, dates, fmt: fmtFor(m), fmtTick: tickFor(m), pct: m.pct, compact: true, height: 120, title: m.label })));
        }))
      : null;

    const bds = rep.breakdowns.length
      ? h('div', { class: 'grid-bd' }, rep.breakdowns.map((b) =>
          h('div', { class: 'card' },
            h('div', { class: 'card-h' }, h('h3', null, b.title),
              h('span', { class: 'muted small' }, (b.subtitle || '') + (b.items && b.items.some((i) => i.n != null && i.n < (b.minN || A.MIN_N)) ? ' · faded = too few' : ''))),
            chartBox((box) => (b.type === 'histogram' ? Ch.histogram(box, b) : b.type === 'curve' ? Ch.curve(box, b) : Ch.bars(box, b))))))
      : null;

    // table view (accessibility + fine grain): newest first
    const cols = def.metrics.filter((m) => A.values(res, m.key).some(U.isNum));
    const table = h('details', { class: 'card table-card' },
      h('summary', null, 'Sessions (' + res.length + ')'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
        h('thead', null, h('tr', null, h('th', null, 'Date'), cols.map((m) => h('th', { title: m.hint || '' }, m.label)))),
        h('tbody', null, res.slice().reverse().map((r) => h('tr', null,
          h('td', null, new Date(r.date).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })),
          cols.map((m) => h('td', null, A.fmt(m, r.summary[m.key])))))))));

    return h('section', { class: 'drill-section', id: 'ds-' + def.id }, head, tiles, primary, multiples, bds, table);
  }

  function render() {
    const el = root();
    el.innerHTML = '';
    draws = [];

    const drillsWithData = IST.drills.filter((d) => IST.Storage.getResults(d.id).length);
    if (state.drill !== 'all' && !drillsWithData.some((d) => d.id === state.drill)) state.drill = 'all';

    const seg = (opts, cur, onPick) => h('div', { class: 'seg', role: 'group' }, opts.map(([v, l]) =>
      h('button', { class: 'seg-b' + (cur === v ? ' on' : ''), 'aria-pressed': cur === v ? 'true' : 'false', onclick: () => onPick(v) }, l)));

    el.append(
      h('div', { class: 'res-head' },
        h('h1', null, 'Stats'),
        h('div', { class: 'card-actions' }, h('button', { class: 'btn', onclick: () => IST.App.exitToMenu() }, '← Menu'))),
      h('div', { class: 'filters' },
        seg(RANGES, state.range, (v) => { state.range = v; render(); }),
        seg([['all', 'All drills']].concat(drillsWithData.map((d) => [d.id, d.name])), state.drill, (v) => { state.drill = v; render(); }))
    );

    const defs = (state.drill === 'all' ? drillsWithData : drillsWithData.filter((d) => d.id === state.drill));
    const perDrill = defs.map((d) => ({ def: d, results: IST.Storage.getResults(d.id).filter(inRange) })).filter((x) => x.results.length);
    const all = perDrill.flatMap((x) => x.results);

    if (!all.length) {
      el.append(h('div', { class: 'card empty' },
        h('p', { class: 'muted' }, drillsWithData.length ? 'No sessions in this range.' : 'No sessions yet.')));
      IST.App.show('screen-stats');
      return;
    }

    const ov = A.overview(all);
    el.append(h('div', { class: 'tiles tiles-top' },
      tile(String(ov.sessions), 'Sessions'),
      tile(ov.minutes < 60 ? Math.round(ov.minutes) + ' min' : (ov.minutes / 60).toFixed(1) + ' h', 'Training time'),
      tile(String(ov.activeDays), 'Active days'),
      tile(ov.streak + (ov.streak === 1 ? ' day' : ' days'), 'Streak')));

    const reports = perDrill.map((x) => A.drillReport(x.def, x.results));
    const order = { bad: 0, good: 1, info: 2 };
    const notes = reports.flatMap((r) => r.notes).sort((a, b) => order[a.tone] - order[b.tone]);
    const insim = A.mergeInsim(reports).slice(0, 6);

    const notesList = h('ul', { class: 'notes' }, notes.slice(0, 8).map(noteItem));
    const moreNotes = notes.length > 8 ? h('details', null, h('summary', { class: 'muted small' }, notes.length - 8 + ' more'), h('ul', { class: 'notes' }, notes.slice(8).map(noteItem))) : null;

    el.append(h('div', { class: 'grid-2' },
      h('div', { class: 'card' },
        h('div', { class: 'card-h' }, h('h3', null, 'Notes')),
        notes.length ? [notesList, moreNotes] : h('p', { class: 'muted' }, '–')),
      h('div', { class: 'card' },
        h('div', { class: 'card-h' }, h('h3', null, 'Work on in-sim')),
        insim.length
          ? h('ol', { class: 'insim-list' }, insim.map(insimItem))
          : h('p', { class: 'muted' }, 'No weak spots yet.'))));

    const counts = {};
    for (const r of all) {
      const k = A.dayKey(r.date);
      counts[k] = (counts[k] || 0) + 1;
    }
    el.append(h('div', { class: 'card' },
      h('div', { class: 'card-h' }, h('h3', null, 'Activity'), h('span', { class: 'muted small' }, 'last 16 weeks')),
      chartBox((box) => Ch.calendar(box, { counts, weeks: 16 }))));

    reports.forEach((rep) => el.append(drillSection(rep)));

    IST.App.show('screen-stats');
    drawAll();
  }

  function open(drillId) {
    if (drillId) state.drill = drillId;
    render();
  }

  document.getElementById('btn-stats').addEventListener('click', () => open());
  IST.Stats = { open, render };
})();
