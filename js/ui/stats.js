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
  // below this many sessions a drill shows its readings, not trends or small multiples
  // (A.trend needs the same number before it compares two blocks)
  const FIRST_N = 4;
  const sparse = (rep) => rep.values.filter(U.isNum).length < FIRST_N; // readings of the headline metric

  /** Few sessions: every metric's value per session in one small table, primary metric first. */
  function firstReadings(def, pm, res) {
    const cols = [pm].concat(def.metrics.filter((m) => m !== pm && m.key !== 'trials' && m.key !== 'valid' && A.values(res, m.key).some(U.isNum)));
    const when = (r) => new Date(r.date).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return h('div', { class: 'card first-readings' },
      h('div', { class: 'card-h' }, h('h3', null, 'First readings'),
        h('span', { class: 'muted small' }, 'Trends and charts start after ' + FIRST_N + ' readings (' + A.values(res, pm.key).filter(U.isNum).length + '/' + FIRST_N + ')')),
      h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
        h('thead', null, h('tr', null, h('th', null, 'Metric'), res.map((r, i) => h('th', null, 'Session ' + (i + 1), h('span', { class: 'muted' }, ' · ' + A.shortDate(r.date) + ' ' + when(r)))))),
        h('tbody', null, cols.map((m) => h('tr', { class: m === pm ? 'fr-primary' : null },
          h('td', null, U.term(m.label, m.hint)),
          res.map((r) => h('td', null, A.fmt(m, r.summary[m.key])))))))));
  }

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
    if (!t.enough) return h('span', { class: 'delta flat' }, 'Trend after ' + FIRST_N + ' sessions (' + Math.min(t.n, FIRST_N) + '/' + FIRST_N + ')');
    const what = 'average of the last ' + t.k + ' sessions against the ' + t.k + ' before';
    // The sign is the direction the value moved; the word (and colour) says whether that's
    // better. Small counts (jump starts, guesses) change by so much per session, not by a
    // silly %; percentages change by points.
    const d = t.recent - t.prior;
    const isCount = m && !m.pct && !m.unit && Math.max(Math.abs(t.recent), Math.abs(t.prior)) < 10;
    const sign = d > 0 ? '+' : '−';
    if (isCount ? Math.abs(d) < 0.15 : m && m.pct ? Math.abs(d) < 0.005 : t.flat) return h('span', { class: 'delta flat', title: 'No real change: ' + what }, 'no change');
    const amount = isCount ? sign + U.fmt(Math.abs(d), Math.abs(d) < 10 ? 1 : 0) + ' per session'
      : m && m.pct ? sign + Math.round(Math.abs(d) * 100) + ' pts'
      : sign + A.pctTxt(t.pct);
    const label = amount + ' · ' + (t.good ? 'better' : 'worse');
    return h('span', { class: 'delta ' + (t.good ? 'good' : 'bad'), title: label + ': ' + what }, label, compact ? null : h('span', { class: 'muted' }, ' · ' + what));
  }

  function noteItem(n) {
    // a coloured square for the tone (not an arrow: arrows read as the value's direction)
    const tone = n.tone === 'good' ? 'Better' : n.tone === 'bad' ? 'Needs work' : 'Info';
    return h('li', { class: 'note note-' + n.tone }, h('span', { class: 'note-ic', role: 'img', 'aria-label': tone, title: tone }), h('span', null, n.text));
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

  /**
   * "Did today help?": each drill trained on the latest day, against its previous day
   * (from the whole history, not just the range), or first against last session when
   * that day is all there is.
   */
  function latestDay(perDrill) {
    const day = A.dayKey(Math.max.apply(null, perDrill.flatMap((x) => x.results.map((r) => r.date))));
    const rows = perDrill.map(({ def }) => {
      const pm = IST.primaryMetric(def);
      const hist = IST.Storage.getResults(def.id);
      const that = hist.filter((r) => A.dayKey(r.date) === day);
      if (!that.length) return null;
      const before = hist.filter((r) => r.date < that[0].date && A.dayKey(r.date) !== day);
      const val = (rs) => A.mean(A.values(rs, pm.key));
      const row = { def, pm, n: that.length, to: val(that), from: null, kind: 'first' };
      if (before.length) {
        const prevDay = A.dayKey(before[before.length - 1].date);
        row.from = val(before.filter((r) => A.dayKey(r.date) === prevDay));
        row.kind = 'last';
        row.since = before[before.length - 1].date;
      } else if (that.length >= 2) {
        const v = A.values(that, pm.key).filter(U.isNum);
        if (v.length >= 2) {
          row.from = v[0];
          row.to = v[v.length - 1];
          row.kind = 'within';
        }
      }
      if (U.isNum(row.from) && U.isNum(row.to) && pm.better) {
        const d = row.to - row.from, rel = row.from ? d / Math.abs(row.from) : d;
        row.verdict = Math.abs(rel) < 0.03 ? 'same' : (pm.better === 'lower' ? d < 0 : d > 0) ? 'better' : 'worse';
      }
      return row;
    }).filter(Boolean);
    return { day, rows };
  }

  function todayCard(perDrill, ov) {
    const L = latestDay(perDrill);
    const isToday = L.day === A.dayKey(Date.now());
    const when = isToday ? 'today' : new Date(L.day + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    const count = (v) => L.rows.filter((r) => r.verdict === v).length;
    const firsts = L.rows.filter((r) => r.kind === 'first').length;
    const parts = [[count('better'), 'better', 'good'], [count('worse'), 'worse', 'bad'], [count('same'), 'no change', 'flat'], [firsts, firsts === 1 ? 'first reading' : 'first readings', 'flat']]
      .filter((p) => p[0]).map(([n, w, cls]) => h('span', { class: 'delta ' + cls }, n + ' ' + w));
    const minutes = ov.minutes < 60 ? Math.round(ov.minutes) + ' min' : (ov.minutes / 60).toFixed(1) + ' h';
    const comp = (r) => (r.kind === 'last' ? 'day average against ' + A.shortDate(r.since)
      : r.kind === 'within' ? 'first against last of ' + r.n + ' sessions'
      : r.n === 1 ? 'one session, nothing to compare yet' : r.n + ' sessions, nothing to compare yet');
    return h('section', { class: 'card today-card', 'aria-labelledby': 'st-today' },
      h('div', { class: 'card-h' },
        h('h2', { id: 'st-today' }, 'Did ' + when + ' help?'),
        h('span', { class: 'muted small' }, ov.sessions + (ov.sessions === 1 ? ' session' : ' sessions') + ' · ' + minutes + ' in this range')),
      parts.length ? h('p', { class: 'today-sum' }, parts.map((p, i) => [i ? ' · ' : '', p])) : null,
      h('ul', { class: 'today-list' }, L.rows.map((r) => h('li', null,
        h('button', { class: 'today-row', onclick: () => showDrill(r.def.id), title: 'Open ' + r.def.name + ' stats' },
          h('span', { class: 'today-name' }, r.def.name),
          h('span', { class: 'today-val' }, U.isNum(r.from) ? A.fmt(r.pm, r.from) + ' → ' : '', A.fmt(r.pm, r.to)),
          h('span', { class: 'today-what muted' }, r.pm.label + ' · ' + comp(r)),
          h('span', { class: 'delta ' + ({ better: 'good', worse: 'bad' }[r.verdict] || 'flat') }, r.verdict === 'same' ? 'no change' : r.verdict || ''))))));
  }

  function showDrill(id) {
    state.drill = id;
    render();
  }

  /** All-drills grid card: the headline metric, its trend, a small chart, and the way in. */
  function drillSummary(rep) {
    const def = rep.def, pm = rep.pm, res = rep.results;
    const last = res[res.length - 1];
    return h('article', { class: 'card drill-sum' },
      h('div', { class: 'card-h' },
        h('h3', null, def.name),
        h('span', { class: 'muted small' }, res.length + (res.length === 1 ? ' session' : ' sessions'))),
      h('div', { class: 'sum-head' },
        h('span', { class: 'sum-v' }, A.fmt(pm, last.summary[pm.key])),
        h('span', { class: 'sum-l' }, U.term(pm.label, pm.hint), ', last session')),
      h('div', { class: 'sum-sub' },
        h('span', null, 'Best ' + A.fmt(pm, rep.pb.value)),
        trendBadge(rep.trend, true, pm)),
      sparse(rep)
        ? h('p', { class: 'sum-readings' }, h('span', { class: 'muted' }, rep.values.filter(U.isNum).length === 1 ? 'First reading ' : 'First readings '), rep.values.filter(U.isNum).map((v) => A.fmt(pm, v)).join(' · '))
        : chartBox((box) => Ch.line(box, { values: rep.values, dates: res.map((r) => r.date), fmt: fmtFor(pm), fmtTick: tickFor(pm), pct: pm.pct, compact: true, height: 96, title: pm.label })),
      h('div', { class: 'card-actions' },
        h('button', { class: 'btn small', onclick: () => showDrill(def.id) }, 'Details'),
        h('button', { class: 'btn ghost small', onclick: () => IST.App.startDrill(def) }, 'Start')));
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
      tile(A.fmt(pm, last.summary[pm.key]), 'Last session'),
      tile(A.fmt(pm, rep.pb.value), 'Best', rep.pb.idx >= 0 ? A.shortDate(res[rep.pb.idx].date) : ''),
      h('div', { class: 'tile' }, h('div', { class: 'tile-v tile-trend' }, trendBadge(rep.trend, false, pm)), rep.trend.enough ? h('div', { class: 'tile-l' }, 'Trend') : null),
      tile(String(res.length), 'Sessions', Math.round(totalMin) + ' min'));

    const primary = h('div', { class: 'card' },
      h('div', { class: 'card-h' }, h('h3', null, U.term(pm.label, pm.hint)), h('span', { class: 'muted small' }, 'Dots: each session · line: 5-session average · ' + (pm.better === 'lower' ? 'lower is better' : 'higher is better'))),
      chartBox((box) => Ch.line(box, { values: rep.values, dates, fmt: fmtFor(pm), fmtTick: tickFor(pm), pct: pm.pct, better: pm.better, pb: rep.pb, height: 230, title: pm.label })));

    // small multiples: every other metric with data
    const others = def.metrics.filter((m) => m !== pm && m.key !== 'trials' && m.key !== 'valid' && A.values(res, m.key).some(U.isNum));
    const multiples = others.length
      ? h('div', { class: 'grid-multi' }, others.map((m) => {
          const vals = A.values(res, m.key);
          const t = A.trend(vals, m.better);
          return h('div', { class: 'card card-sm' },
            h('div', { class: 'card-h' }, h('h4', null, U.term(m.label, m.hint)), m.better ? trendBadge(t, true, m) : null),
            h('div', { class: 'sm-last' }, A.fmt(m, A.mean(vals.slice(-1))), h('span', { class: 'muted small' }, ' last session · best ' + A.fmt(m, A.pb(vals, m.better).value))),
            chartBox((box) => Ch.line(box, { values: vals, dates, fmt: fmtFor(m), fmtTick: tickFor(m), pct: m.pct, compact: true, height: 120, title: m.label })));
        }))
      : null;

    const bds = rep.breakdowns.length
      ? h('div', { class: 'grid-bd' }, rep.breakdowns.map((b) =>
          h('div', { class: 'card' },
            h('div', { class: 'card-h' }, h('h3', null, b.title),
              h('span', { class: 'muted small' }, (b.subtitle || '') + (b.items && b.items.some((i) => i.n != null && i.n < (b.minN || A.MIN_N)) ? ' · hatched: too few to judge' : ''))),
            chartBox((box) => (b.type === 'histogram' ? Ch.histogram(box, b) : b.type === 'curve' ? Ch.curve(box, b) : Ch.bars(box, b))))))
      : null;

    // table view (accessibility + fine grain): newest first
    const cols = def.metrics.filter((m) => A.values(res, m.key).some(U.isNum));
    const table = h('details', { class: 'card table-card' },
      h('summary', null, 'Sessions (' + res.length + ')'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
        h('thead', null, h('tr', null, h('th', null, 'Date'), cols.map((m) => h('th', null, U.term(m.label, m.hint))))),
        h('tbody', null, res.slice().reverse().map((r) => h('tr', null,
          h('td', null, new Date(r.date).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })),
          cols.map((m) => h('td', null, A.fmt(m, r.summary[m.key])))))))));

    const early = sparse(rep);
    return h('section', { class: 'drill-section', id: 'ds-' + def.id }, head, tiles, early ? firstReadings(def, pm, res) : [primary, multiples], bds, table);
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
      const toSessions = () => {
        IST.App.exitToMenu();
        const tab = document.getElementById('tab-sessions');
        if (tab) tab.click();
      };
      el.append(h('div', { class: 'card empty' },
        drillsWithData.length
          ? [h('p', null, 'No sessions in the last ' + RANGES.find((r) => r[0] === state.range)[1] + '.'),
            h('div', { class: 'card-actions' }, h('button', { class: 'btn primary', onclick: () => { state.range = 'all'; render(); } }, 'Show all time'))]
          : [h('p', null, 'No sessions yet. Your progress, weak spots and in-sim advice show up here after your first drill.'),
            h('div', { class: 'card-actions' }, h('button', { class: 'btn primary', onclick: toSessions }, 'Start a guided session'))]));
      IST.App.show('screen-stats');
      return;
    }

    const ov = A.overview(all);
    const reports = perDrill.map((x) => A.drillReport(x.def, x.results));
    const order = { bad: 0, good: 1, info: 2 };
    const notes = reports.flatMap((r) => r.notes).sort((a, b) => order[a.tone] - order[b.tone]);
    const insim = A.mergeInsim(reports).slice(0, 6);

    const notesList = h('ul', { class: 'notes' }, notes.slice(0, 8).map(noteItem));
    const moreNotes = notes.length > 8 ? h('details', null, h('summary', { class: 'muted small' }, notes.length - 8 + ' more'), h('ul', { class: 'notes' }, notes.slice(8).map(noteItem))) : null;

    // lead with what to do in the car, then whether the latest day helped, then the notes
    el.append(
      h('section', { class: 'card insim-card', 'aria-labelledby': 'st-insim' },
        h('div', { class: 'card-h' }, h('h2', { id: 'st-insim' }, 'Work on in-sim')),
        insim.length
          ? h('ol', { class: 'insim-list' }, insim.map(insimItem))
          : h('p', { class: 'muted' }, reports.some((r) => sparse(r))
            ? 'Need more sessions to judge. Weak spots show once a drill has ' + FIRST_N + ' sessions.'
            : 'No weak spots yet.')),
      todayCard(perDrill, ov),
      h('section', { class: 'card notes-card', 'aria-labelledby': 'st-notes' },
        h('div', { class: 'card-h' }, h('h2', { id: 'st-notes' }, 'Notes')),
        notes.length ? [notesList, moreNotes] : h('p', { class: 'muted' }, '–')));

    const counts = {};
    for (const r of all) {
      const k = A.dayKey(r.date);
      counts[k] = (counts[k] || 0) + 1;
    }
    // one active day is a single square: not worth a calendar yet
    if (ov.activeDays >= 2) {
      el.append(h('section', { class: 'card', 'aria-labelledby': 'st-activity' },
        h('div', { class: 'card-h' }, h('h2', { id: 'st-activity' }, 'Activity'), h('span', { class: 'muted small' }, 'last 16 weeks')),
        chartBox((box) => Ch.calendar(box, { counts, weeks: 16 }))));
    }

    // all drills: one summary card each, linking to its deep dive; one drill: the deep dive
    if (state.drill === 'all') {
      el.append(h('section', { class: 'drill-grid-sec', 'aria-labelledby': 'st-drills' },
        h('h2', { class: 'sec-title', id: 'st-drills' }, 'Drills'),
        h('div', { class: 'drill-grid' }, reports.map(drillSummary))));
    } else reports.forEach((rep) => el.append(drillSection(rep)));

    IST.App.show('screen-stats');
    drawAll();
  }

  function open(drillId) {
    if (drillId) state.drill = drillId;
    render();
  }

  document.getElementById('btn-stats').addEventListener('click', () => open());
  // Esc goes back to the menu, as it does from Review. Capture phase: an open modal is
  // still open here, so the Esc that closes it doesn't also leave the page
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || root().classList.contains('hidden')) return;
    if (!document.getElementById('modal').classList.contains('hidden')) return;
    IST.App.exitToMenu();
  }, true);
  IST.Stats = { open, render };
})();
