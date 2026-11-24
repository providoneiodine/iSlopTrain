/*
 * App shell: menu, settings, controls, data, results and guided sessions.
 * Everything here is generated from drill/session definitions, so this file
 * rarely needs to change when drills are added.
 */
(function () {
  'use strict';
  const U = IST.util, h = U.h;
  const $ = (s) => document.querySelector(s);
  const SCREENS = ['screen-menu', 'screen-drill', 'screen-results', 'screen-stats', 'screen-view', 'screen-review'];

  function show(id) {
    SCREENS.forEach((s) => document.getElementById(s).classList.toggle('hidden', s !== id));
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- helpers
  const fmtMetric = (m, v) => (U.isNum(v) ? (m.pct ? U.fmt(v * 100, m.digits) : U.fmt(v, m.digits)) : '–');
  const unitOf = (m) => (m.pct ? '%' : m.unit || '');

  function deltaEl(m, cur, prev) {
    if (!m.better || !U.isNum(cur) || !U.isNum(prev)) return h('span', { class: 'delta flat' }, '');
    const d = cur - prev;
    const scale = m.pct ? 100 : 1;
    const shown = Math.abs(d * scale) < Math.pow(10, -(m.digits || 0)) / 2 ? 0 : d * scale;
    if (shown === 0) return h('span', { class: 'delta flat' }, '±0');
    const good = m.better === 'lower' ? d < 0 : d > 0;
    return h('span', { class: 'delta ' + (good ? 'good' : 'bad') }, (d > 0 ? '+' : '−') + U.fmt(Math.abs(shown), m.digits) + (m.pct ? ' pts' : ''));
  }

  function sparkline(values, w, ht) {
    w = w || 140;
    ht = ht || 38;
    const v = values.filter(U.isNum);
    if (v.length < 2) return '';
    const lo = Math.min.apply(null, v), hi = Math.max.apply(null, v);
    const span = hi - lo || 1;
    const pts = v.map((x, i) => [(i / (v.length - 1)) * (w - 6) + 3, ht - 4 - ((x - lo) / span) * (ht - 8)]);
    const last = pts[pts.length - 1];
    return (
      '<svg viewBox="0 0 ' + w + ' ' + ht + '" width="' + w + '" height="' + ht + '" aria-hidden="true">' +
      '<polyline fill="none" stroke="#f6d98f" stroke-width="2" stroke-linejoin="miter" points="' +
      pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ') + '"/>' +
      '<rect x="' + (last[0] - 3).toFixed(1) + '" y="' + (last[1] - 3).toFixed(1) + '" width="6" height="6" fill="#f6d98f"/></svg>'
    );
  }

  // ------------------------------------------------------------------ modal
  let modalClose = null;
  function openModal(content, onClose) {
    closeModal();
    const body = $('#modal .modal-body');
    body.innerHTML = '';
    body.append(content);
    $('#modal').classList.remove('hidden');
    modalClose = onClose || null;
  }
  function closeModal() {
    if ($('#modal').classList.contains('hidden')) return;
    $('#modal').classList.add('hidden');
    const cb = modalClose;
    modalClose = null;
    if (cb) cb();
  }
  $('#modal .close').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') closeModal();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) closeModal();
  });

  // ------------------------------------------------------------------- menu
  function renderMenu() {
    renderSessions();
    // each tab has a .drill-list[data-tab]; drills pick theirs with def.tab (default vision).
    // A list with no drills keeps its static "coming soon" placeholder from index.html.
    document.querySelectorAll('.drill-list').forEach((dl) => {
      const defs = IST.drills.filter((d) => (d.tab || 'vision') === dl.dataset.tab);
      if (!defs.length) return;
      dl.innerHTML = '';
      defs.forEach((d) => dl.append(drillCard(d)));
    });
  }

  /** Sessions tab: one section per group, skipping sessions that name a drill that isn't registered. */
  function renderSessions() {
    const panel = $('#panel-sessions');
    panel.innerHTML = '';
    const groups = [];
    IST.sessions
      .filter((s) => s.steps.every((st) => IST.getDrill(st.drill)))
      .forEach((s) => {
        const name = s.group || 'Sessions';
        let g = groups.find((x) => x.name === name);
        if (!g) groups.push((g = { name, list: [] }));
        g.list.push(s);
      });
    groups.forEach((g, i) => {
      const hid = 'h-sessions-' + i;
      panel.append(h('section', { class: 'menu-section', 'aria-labelledby': hid },
        h('h2', { class: 'section-title', id: hid }, g.name),
        h('div', { class: 'cards session-list' }, g.list.map(sessionCard))));
    });
  }

  /** Short "how much" for a step: its duration, or its trial/question count. */
  function stepAmount(def, st) {
    const v = Object.assign(IST.Storage.getSettings(def), st.settings || {});
    if (U.isNum(v.duration)) return v.duration % 60 ? U.fmt(v.duration / 60, 1) + ' min' : v.duration / 60 + ' min';
    const f = def.settings.find((x) => x.key === 'trials' || x.key === 'questions');
    return f && U.isNum(v[f.key]) ? v[f.key] + ' ' + f.label.toLowerCase() : '';
  }

  function sessionCard(s) {
    return h('article', { class: 'card' },
      h('div', { class: 'card-head' }, h('span', { class: 'tag' }, s.minutes), h('h3', null, s.name)),
      s.blurb ? h('p', { class: 'tagline' }, s.blurb) : null,
      h('ol', { class: 'steps' }, s.steps.map((st) => {
        const d = IST.getDrill(st.drill);
        const tab = d.tab || 'vision';
        return h('li', null, h('span', { class: 'step-row' },
          h('span', { class: 'step-tab step-' + tab, title: TABS[tab] + ' tab' }),
          h('span', null, d.name, st.note ? h('span', { class: 'step-note' }, ' · ' + st.note) : null),
          h('span', { class: 'step-amt' }, stepAmount(d, st))));
      })),
      h('div', { class: 'card-actions' }, h('button', { class: 'btn primary', onclick: () => startSession(s, 0) }, 'Start'))
    );
  }

  function drillCard(def) {
    const pm = IST.primaryMetric(def);
    const hist = IST.Storage.getResults(def.id);
    const last = hist[hist.length - 1];
    const vals = hist.slice(-20).map((r) => r.summary && r.summary[pm.key]);
    return h('article', { class: 'card' },
      h('div', { class: 'card-head' }, h('span', { class: 'tag' }, def.category || 'Drill'), h('h3', null, def.name)),
      h('p', { class: 'tagline' }, def.tagline || ''),
      last && pm
        ? h('div', { class: 'card-stats' },
            h('div', null,
              h('span', { class: 'stat-v' }, fmtMetric(pm, last.summary[pm.key]), h('small', null, unitOf(pm))),
              h('span', { class: 'stat-l' }, pm.label + ' · ' + hist.length + ' session' + (hist.length === 1 ? '' : 's'))),
            h('div', { class: 'spark', html: sparkline(vals) }))
        : null,
      h('div', { class: 'card-actions' },
        h('button', { class: 'btn primary', onclick: () => startDrill(def) }, 'Start'),
        def.settings.length ? h('button', { class: 'btn', onclick: () => openSettings(def) }, 'Settings') : null,
        h('button', { class: 'btn ghost', onclick: () => openWhy(def) }, 'Info'))
    );
  }

  // --------------------------------------------------------------- settings
  function openSettings(def) {
    const cur = IST.Storage.getSettings(def);
    const form = h('form', { class: 'settings', onsubmit: (e) => e.preventDefault() });
    def.settings.forEach((f) => {
      let input;
      if (f.type === 'bool') input = h('input', { type: 'checkbox', name: f.key, checked: !!cur[f.key] });
      else if (f.type === 'select')
        input = h('select', { name: f.key }, f.options.map((o) => h('option', { value: o[0], selected: String(cur[f.key]) === String(o[0]) }, o[1])));
      else input = h('input', { type: 'number', name: f.key, value: cur[f.key], min: f.min, max: f.max, step: f.step || 1 });
      form.append(h('label', { class: 'field' },
        h('span', { class: 'field-l' }, f.label, f.unit ? h('small', null, ' (' + f.unit + ')') : null),
        input,
        f.hint ? h('span', { class: 'hint' }, f.hint) : null));
    });
    const read = () => {
      const out = {};
      def.settings.forEach((f) => {
        const el = form.elements[f.key];
        if (f.type === 'bool') out[f.key] = el.checked;
        else if (f.type === 'select') out[f.key] = el.value;
        else {
          const n = parseFloat(el.value);
          out[f.key] = U.isNum(n) ? U.clamp(n, f.min != null ? f.min : -Infinity, f.max != null ? f.max : Infinity) : f.default;
        }
      });
      return out;
    };
    openModal(h('div', null,
      h('h2', null, def.name + ' · settings'),
      form,
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn primary', onclick: () => { IST.Storage.setSettings(def.id, read()); closeModal(); } }, 'Save'),
        h('button', { class: 'btn primary', onclick: () => { IST.Storage.setSettings(def.id, read()); closeModal(); startDrill(def); } }, 'Save & start'),
        h('button', { class: 'btn ghost', onclick: () => { IST.Storage.resetSettings(def.id); openSettings(def); } }, 'Reset to defaults'))
    ));
  }

  function openWhy(def) {
    openModal(h('div', null,
      h('h2', null, def.name),
      h('p', null, def.description || def.tagline || ''),
      // optional drill notes: def.info = [{ title, intro?, items?: [[name, text]], outro?: string | string[] }]
      (def.info || []).map((sec) => [
        h('h3', null, sec.title),
        sec.intro ? h('p', null, sec.intro) : null,
        sec.items ? h('ul', { class: 'research' }, sec.items.map((it) => h('li', null, h('b', null, it[0] + '. '), it[1]))) : null,
        [].concat(sec.outro || []).map((t) => h('p', { class: 'muted' }, t)),
      ]),
      h('h3', null, 'Research'),
      h('ul', { class: 'research' }, def.research.map((r) => h('li', null, r.point, h('span', { class: 'src' }, r.source)))),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn primary', onclick: () => { closeModal(); startDrill(def); } }, 'Start ' + def.name))
    ));
  }

  function openMethod() {
    const P = [
      ['Real gaze pattern', 'Drivers look at the next apex 1–2 s early.', 'Land & Lee 1994; Land & Tatler 2001; Lehtonen et al. 2014'],
      ['Anticipate, don\'t react', 'Flashes are shorter than an eye movement, so only eyes already there catch them.', 'Posner 1980; Breitmeyer & Ögmen 2006'],
      ['Consistent mapping', 'Same cue, same response, many reps: that\'s how it becomes automatic.', 'Schneider & Shiffrin 1977'],
      ['Two-point vision', 'Far point direct, near road peripheral.', 'Salvucci & Gray 2004; Summala et al. 1996'],
      ['Challenge point', 'Difficulty adapts to hold ~71% success.', 'Levitt 1971; Guadagnoli & Lee 2004'],
      ['Fade feedback', 'Switch to summary-only once consistent.', 'Winstein & Schmidt 1990'],
      ['Short and often', '5–10 min most days, ideally before driving.', 'Cepeda et al. 2006'],
      ['Limits', 'Transfer isn\'t guaranteed. Check your lap times.', 'Appelbaum & Erickson 2018'],
    ];
    openModal(h('div', null,
      h('h2', null, 'Method'),
      h('p', { class: 'muted' }, 'Details: docs/METHODOLOGY.md'),
      h('ul', { class: 'research' }, P.map((p) => h('li', null, h('b', null, p[0] + '. '), p[1], h('span', { class: 'src' }, p[2]))))
    ));
  }

  // --------------------------------------------------------------- controls
  function openControls() {
    const padsEl = h('div');
    const rowsEl = h('tbody');
    const testEl = h('div', { class: 'test-line' }, 'Test input…');

    const refreshPads = () => {
      const pads = IST.Input.pads();
      padsEl.innerHTML = '';
      padsEl.append(pads.length
        ? h('ul', { class: 'tips' }, pads.map((p) => h('li', null, p.id, h('span', { class: 'muted' }, ' · ' + (p.mapping === 'standard' ? 'standard' : 'bind below')))))
        : h('p', { class: 'muted' }, 'No controller detected. Press a button to wake it.'));
    };

    const renderRows = () => {
      rowsEl.innerHTML = '';
      IST.Input.ACTIONS.forEach(([action, label]) => {
        const binds = IST.Input.bindingsFor(action);
        const bindBtn = h('button', { class: 'btn small' }, 'Bind');
        bindBtn.addEventListener('click', () => {
          bindBtn.textContent = 'Press input…';
          IST.Input.learn(action, () => renderRows());
        });
        rowsEl.append(h('tr', null,
          h('td', null, h('b', null, label)),
          h('td', { class: 'muted' }, IST.Input.KEY_LABELS[action]),
          h('td', { class: 'bind-list' }, binds.length ? binds.map((b) => h('span', null, b.label)) : '–'),
          h('td', null, bindBtn, ' ', binds.length ? h('button', { class: 'btn small ghost', onclick: () => { IST.Input.clear(action); renderRows(); } }, 'Clear') : null)));
      });
    };

    refreshPads();
    renderRows();
    const timer = setInterval(refreshPads, 1500);
    const off = IST.Input.on((a, t, src) => {
      testEl.textContent = a + ' (' + src + ')';
    });

    openModal(h('div', null,
      h('h2', null, 'Controls'),
      h('h3', null, 'Controllers'),
      padsEl,
      h('h3', null, 'Actions'),
      h('table', { class: 'grid' }, h('thead', null, h('tr', null, h('th', null, 'Action'), h('th', null, 'Keyboard'), h('th', null, 'Controller'), h('th', null, ''))), rowsEl),
      testEl
    ), () => {
      clearInterval(timer);
      off();
      IST.Input.cancelLearn();
    });
  }

  // ------------------------------------------------------------------- data
  function openData() {
    const fs = h('input', { type: 'checkbox', checked: IST.Storage.getPref('fullscreen', false) });
    fs.addEventListener('change', () => IST.Storage.setPref('fullscreen', fs.checked));
    const curJuice = IST.Storage.getPref('juice', 'full');
    const juice = h('select', null, [['full', 'Full (effects + sounds)'], ['silent', 'Silent (effects, no sounds)'], ['off', 'Off (no in-drill effects)']].map((o) => h('option', { value: o[0], selected: o[0] === curJuice }, o[1])));
    juice.addEventListener('change', () => IST.Storage.setPref('juice', juice.value));
    const file = h('input', { type: 'file', accept: 'application/json,.json', class: 'hidden' });
    file.addEventListener('change', () => {
      const f = file.files[0];
      if (!f) return;
      f.text().then((txt) => {
        try {
          IST.Storage.importJSON(txt);
          IST.Input.load();
          closeModal();
          renderMenu();
          alert('Imported.');
        } catch (e) {
          alert('Import failed: ' + e.message);
        }
      });
    });
    const exportData = () => {
      const blob = new Blob([IST.Storage.exportJSON()], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: 'isloptrain-' + new Date().toISOString().slice(0, 10) + '.json' });
      document.body.append(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 1000);
    };
    openModal(h('div', null,
      h('h2', null, 'Data'),
      h('label', { class: 'field' }, h('span', { class: 'field-l' }, 'Auto fullscreen on drill start'), fs),
      h('label', { class: 'field' }, h('span', { class: 'field-l' }, 'Game feel'), juice,
        h('span', { class: 'hint' }, 'Chains, scores, sounds and celebrations. "Summary only" feedback hides them during a drill either way.')),
      h('h3', null, 'History'),
      h('p', { class: 'muted' }, 'Stored in this browser only.'),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn', onclick: exportData }, 'Export JSON'),
        h('button', { class: 'btn', onclick: () => file.click() }, 'Import JSON'),
        h('button', { class: 'btn danger', onclick: () => {
          if (confirm('Delete all history, settings and bindings? This cannot be undone.')) {
            IST.Storage.clearAll();
            IST.Input.load();
            closeModal();
            renderMenu();
          }
        } }, 'Delete all data')),
      file
    ));
  }

  // --------------------------------------------------------------- run flow
  async function startDrill(def, overrides, session) {
    const settings = Object.assign(IST.Storage.getSettings(def), overrides || {});
    // the in-car view the run used, saved with the result (cockpit occlusion changes what can be seen)
    if (def.usesView) settings.view = IST.View.get();
    if (IST.Storage.getPref('fullscreen', false) && !document.fullscreenElement && document.documentElement.requestFullscreen) {
      try {
        await document.documentElement.requestFullscreen();
      } catch (e) {
        /* not allowed here; run windowed */
      }
    }
    // canvas text needs the webfont ready before the first frame
    if (document.fonts && document.fonts.load) {
      try {
        await Promise.race([document.fonts.load('720 16px Allo'), new Promise((r) => setTimeout(r, 800))]);
      } catch (e) {
        /* fall back to system font */
      }
    }
    show('screen-drill');
    IST.Input.capture = true;
    let result = null;
    try {
      result = await IST.Runner.run(def, settings);
    } catch (e) {
      console.error(e);
      alert('Drill crashed: ' + e.message);
    }
    IST.Input.capture = false;
    if (result) {
      IST.Storage.addResult(def.id, {
        date: result.date, summary: result.summary, settings: result.settings,
        durationMs: result.durationMs, refreshHz: result.refreshHz, seed: result.seed, detail: result.detail,
      });
      showResults(def, result, session);
    } else {
      exitToMenu();
    }
  }

  function startSession(s, i) {
    const step = s.steps[i];
    const def = IST.getDrill(step.drill);
    if (!def) return exitToMenu();
    startDrill(def, step.settings, { session: s, step: i });
  }

  function exitToMenu() {
    renderMenu();
    show('screen-menu');
  }

  function showResults(def, result, sess) {
    const root = $('#screen-results');
    root.innerHTML = '';
    const hist = IST.Storage.getResults(def.id);
    const prev = hist.length >= 2 ? hist[hist.length - 2] : null;
    const pm = IST.primaryMetric(def);
    const s = result.summary;

    const rows = def.metrics
      .filter((m) => s[m.key] !== null && s[m.key] !== undefined)
      .map((m) => h('tr', { title: m.hint || '' },
        h('td', null, m.label),
        h('td', null, h('b', null, fmtMetric(m, s[m.key])), ' ', h('span', { class: 'muted' }, unitOf(m))),
        h('td', null, prev ? deltaEl(m, s[m.key], prev.summary[m.key]) : '')));

    const tips = def.coach ? def.coach(s, result, hist) : [];
    const trendVals = hist.slice(-30).map((r) => r.summary && r.summary[pm.key]);

    let primaryBtn;
    const actions = [];
    if (sess && sess.step < sess.session.steps.length - 1) {
      const nextStep = sess.session.steps[sess.step + 1];
      const nd = IST.getDrill(nextStep.drill);
      primaryBtn = h('button', { class: 'btn primary', onclick: () => startSession(sess.session, sess.step + 1) }, 'Next: ' + (nd ? nd.name : nextStep.drill) + ' →');
      actions.push(primaryBtn, h('button', { class: 'btn ghost', onclick: exitToMenu }, 'End session'));
    } else {
      primaryBtn = h('button', { class: 'btn primary', onclick: () => startDrill(def, sess ? sess.session.steps[sess.step].settings : null) }, 'Go again');
      actions.push(primaryBtn, h('button', { class: 'btn', onclick: exitToMenu }, 'Menu'));
      if (!sess) actions.push(h('button', { class: 'btn ghost', onclick: () => openSettings(def) }, 'Settings'));
    }
    actions.push(h('button', { class: 'btn ghost', onclick: () => IST.Stats.open(def.id) }, 'Full stats →'));

    const usesFlashes = def.settings.some((f) => f.key === 'startExposure');
    const frameMs = usesFlashes && result.refreshHz ? 1000 / result.refreshHz : null;
    const grade = sessionGrade(def, hist, s);
    const records = sessionRecords(hist, s);
    const gradeEl = grade
      ? h('div', { class: 'grade grade-' + grade.letter, title: grade.pb ? 'Personal best' : 'Better than ' + Math.round(grade.beaten * 100) + '% of your previous sessions' },
          h('span', { class: 'grade-l' }, grade.letter),
          h('span', { class: 'grade-s' }, grade.pb ? 'PB' : 'top ' + Math.max(1, Math.round((1 - grade.beaten) * 100)) + '%'))
      : null;
    const badges = [];
    if (grade && grade.pb) badges.push('NEW PB');
    if (!grade && hist.length === 1) badges.push('FIRST RUN');
    records.forEach((r) => badges.push(r));
    const scoreEl = U.isNum(s.score)
      ? h('div', { class: 'res-score' },
          h('div', { class: 'res-score-v' }, Math.round(s.score).toLocaleString()),
          h('div', { class: 'res-label' }, 'Score' + (U.isNum(s.bestChain) ? ' · best chain ' + s.bestChain : '')))
      : null;
    root.append(
      h('div', { class: 'res-head' },
        h('div', null,
          h('span', { class: 'tag' }, sess ? sess.session.name + ' · step ' + (sess.step + 1) + '/' + sess.session.steps.length + (sess.step === sess.session.steps.length - 1 ? ' · complete' : '') : def.category || 'Drill'),
          h('h1', null, def.name))),
      badges.length ? h('div', { class: 'badges' }, badges.map((b) => h('span', { class: 'badge' }, b))) : null,
      pm ? h('div', { class: 'res-hero' },
        gradeEl,
        h('div', null,
          h('div', { class: 'res-big' }, fmtMetric(pm, s[pm.key]), h('small', null, unitOf(pm))),
          h('div', { class: 'res-label' }, pm.label, ' ', prev ? deltaEl(pm, s[pm.key], prev.summary[pm.key]) : h('span', { class: 'muted' }, ''))),
        scoreEl,
        h('div', { class: 'trend', style: 'flex:1;min-width:200px;max-width:420px' },
          h('div', { html: sparkline(trendVals, 420, 70) }),
          h('div', { class: 'res-label' }, trendVals.filter(U.isNum).length >= 2 ? 'Last ' + trendVals.length + ' sessions' : ''))) : null,
      h('div', { class: 'res-grid' },
        h('div', null, h('table', { class: 'grid' },
          h('thead', null, h('tr', null, h('th', null, 'Metric'), h('th', null, 'This session'), h('th', null, prev ? 'vs last' : ''))),
          h('tbody', null, rows))),
        h('div', null,
          h('h3', { style: 'margin-top:0' }, 'Notes'),
          tips.length ? h('ul', { class: 'coach' }, tips.map((t) => h('li', null, t))) : null,
          frameMs ? h('p', { class: 'frame-note' }, result.refreshHz + ' Hz display: flashes rounded to ' + frameMs.toFixed(1) + ' ms frames.') : null)),
      h('div', { class: 'res-actions' }, actions)
    );
    show('screen-results');
    const scoreV = root.querySelector('.res-score-v');
    if (scoreV) countUp(scoreV, Math.round(s.score));
    if ((grade && grade.pb) || records.length) celebrate(gradeEl || (scoreV && scoreV.parentNode));
    // focus after a beat so a held Space/Enter from the drill doesn't trigger it
    setTimeout(() => primaryBtn && primaryBtn.focus(), 450);
  }

  /** S = personal best, then A/B/C by the share of your previous sessions this one beats. */
  function sessionGrade(def, hist, s) {
    const pm = IST.primaryMetric(def);
    const v = pm && s[pm.key];
    if (!pm || !pm.better || !U.isNum(v)) return null;
    const prior = hist.slice(0, -1).map((r) => r.summary && r.summary[pm.key]).filter(U.isNum);
    if (!prior.length) return null;
    const better = (a, b) => (pm.better === 'lower' ? a < b : a > b);
    const beaten = prior.filter((x) => better(v, x)).length / prior.length;
    const pb = beaten === 1;
    return { letter: pb ? 'S' : beaten >= 0.75 ? 'A' : beaten >= 0.4 ? 'B' : 'C', pb, beaten };
  }

  function sessionRecords(hist, s) {
    const prior = hist.slice(0, -1).map((r) => r.summary || {});
    const out = [];
    const rec = (key, label) => {
      const prev = prior.map((p) => p[key]).filter(U.isNum);
      if (prev.length && U.isNum(s[key]) && s[key] > 0 && s[key] > Math.max.apply(null, prev)) out.push(label);
    };
    rec('bestChain', 'NEW BEST CHAIN');
    rec('score', 'HIGH SCORE');
    return out;
  }

  /**
   * Record moment: a light sheen across the grade (or score) tile, one ring pulse and the fanfare.
   * Kept small and on the tile itself. Skipped with Game feel off; motion skipped with reduced motion.
   */
  function celebrate(target) {
    const mode = IST.Juice.mode();
    if (mode === 'off') return;
    if (mode === 'full') {
      const au = IST.Juice.makeAudio();
      if (au) {
        au.best();
        setTimeout(() => au.close(), 1500);
      }
    }
    if (target) target.classList.add('celebrate');
  }

  /** Score ticks up from zero so the number lands rather than just appears. */
  function countUp(el, to) {
    if (!el || IST.Juice.mode() === 'off' || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    const t0 = performance.now(), dur = U.clamp(400 + Math.abs(to) / 20, 500, 1100);
    (function frame(t) {
      const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(to * e).toLocaleString();
      if (p < 1) requestAnimationFrame(frame);
    })(t0);
  }

  // ------------------------------------------------------------- fullscreen
  IST.toggleFullscreen = function () {
    const d = document;
    if (d.fullscreenElement) {
      if (d.exitFullscreen) d.exitFullscreen().catch(() => {});
    } else if (d.documentElement.requestFullscreen) {
      d.documentElement.requestFullscreen().catch(() => {});
    }
  };
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyF' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    IST.toggleFullscreen();
  });

  // ------------------------------------------------------------------- tabs
  const TABS = { sessions: 'Sessions', vision: 'Vision', mind: 'Mind', reflex: 'Reflex', review: 'Review' };
  const tabBtns = Array.from(document.querySelectorAll('.tab'));
  function setTab(name, focus) {
    if (!TABS[name]) name = 'sessions';
    tabBtns.forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    Object.keys(TABS).forEach((t) => $('#panel-' + t).classList.toggle('hidden', t !== name));
    $('#brand-sub').textContent = name === 'sessions' ? 'Guided Sessions' : name === 'review' ? 'Lap Review' : TABS[name] + ' Trainer';
    document.title = 'iSlopTrain ' + TABS[name];
    history.replaceState(null, '', name === 'sessions' ? location.pathname + location.search : '#' + name);
  }
  tabBtns.forEach((b, i) => {
    b.addEventListener('click', () => setTab(b.dataset.tab));
    b.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      setTab(tabBtns[(i + d + tabBtns.length) % tabBtns.length].dataset.tab, true);
    });
  });
  setTab(location.hash.slice(1));

  // ------------------------------------------------------------------- boot
  $('#btn-fullscreen').addEventListener('click', IST.toggleFullscreen);
  $('#btn-method').addEventListener('click', openMethod);
  $('#btn-controls').addEventListener('click', openControls);
  $('#btn-data').addEventListener('click', openData);
  $('#btn-view').addEventListener('click', () => IST.ViewSettings.open());
  // Review tab: the 3D lap viewer lives in js/review/ (IST.Review)
  $('#btn-review-open').addEventListener('click', () => IST.Review.open({ pick: true }));
  $('#btn-review-demo').addEventListener('click', () => IST.Review.open({ demo: true }));
  const rc = $('#review-card');
  rc.addEventListener('dragover', (e) => (e.preventDefault(), rc.classList.add('rv-over')));
  rc.addEventListener('dragleave', () => rc.classList.remove('rv-over'));
  rc.addEventListener('drop', (e) => {
    e.preventDefault();
    rc.classList.remove('rv-over');
    if (e.dataTransfer.files.length) IST.Review.open({ files: e.dataTransfer.files });
  });
  $('#ver').textContent = IST.version;
  renderMenu();
  show('screen-menu');

  IST.App = { startDrill, startSession, showResults, renderMenu, show, exitToMenu, openModal, closeModal };
})();
