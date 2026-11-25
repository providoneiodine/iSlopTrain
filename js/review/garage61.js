/*
 * Garage 61 import for the Lap Viewer.
 *
 *   IST.Review.Garage61.panel(ctx, onFiles)   the import panel (modal content + a dispose())
 *   IST.Review.Garage61.href()                the bookmarklet, as a javascript: URL
 *   IST.Review.Garage61.receiver(o)           message filter for laps sent back (tests)
 *   IST.Review.Garage61.core                  the bridge's pure helpers (tests)
 *
 * Garage 61's API sends no CORS headers, so this page can't call it. Two ways in:
 *
 * 1. Manual: export a lap's CSV on garage61.net and drop it here (csv.js reads it).
 * 2. The bookmarklet bridge. This page opens garage61.net in a new tab; there the
 *    user clicks the bookmarklet, which runs on garage61.net itself, so its calls
 *    to garage61.net/api/v1 are same-origin and need no CORS. It asks for the
 *    user's personal access token, lists their laps on the track loaded here, and
 *    sends each picked lap's CSV back to this tab with postMessage.
 *
 * Security and API manners (the bridge's side):
 *   - The token never reaches this page. It lives in one variable inside the
 *     bookmarklet's closure, is cleared from its input as soon as it's read, and
 *     is dropped (with every cached list) when the panel closes, after a send,
 *     on a 401, or after 10 minutes idle. Nothing is written to storage.
 *   - Only public endpoints, with the token as a Bearer header and no cookies
 *     (credentials: 'omit'). Read-only: GET /tracks, /cars, /laps, /laps/{id}/csv.
 *   - Calls run one at a time, at least MIN_GAP apart, only on a click. Retry-After
 *     is honoured (also on success when a bucket is empty); a 429 waits and retries
 *     once, then stops. Lists are fetched once per panel; at most MAX_SEND laps per send.
 * This page's side: a lap is accepted only from the tab it opened, from
 * https://garage61.net, carrying this connection's random nonce, as a CSV under
 * MAX_CSV bytes; anything else is ignored. The listener goes when the import
 * finishes, the Garage 61 tab closes, or the panel closes.
 */
(function () {
  'use strict';
  const U = IST.util, h = U.h;
  const G61 = 'https://garage61.net';
  const PROTO = 1;
  const MAX_SEND = 5;
  const MAX_CSV = 25 * 1024 * 1024;

  /*
   * The bookmarklet. Runs on garage61.net, so it must not use anything from outside
   * its own body: it's stringified into a javascript: URL. bridge(window, true)
   * returns the pure helpers without touching the page (tests).
   */
  function bridge(W, testOnly) {
    'use strict';
    var PROTO = 1, MAX_SEND = 5, MIN_GAP = 1100, IDLE = 10 * 60 * 1000;
    var norm = function (s) {
      return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    };
    var core = {
      MIN_GAP: MIN_GAP,
      MAX_SEND: MAX_SEND,
      norm: norm,
      /** Garage 61's track as the viewer names tracks (name · layout, like an .ibt). */
      trackLabel: function (t) {
        if (!t) return '';
        return t.variant && norm(t.variant) !== norm(t.name) ? t.name + ' · ' + t.variant : t.name || '';
      },
      /** The best Garage 61 track for a viewer track name: { best, options }. */
      matchTrack: function (name, tracks) {
        var parts = String(name || '').split(/\s+·\s+/), n = norm(parts[0]), cfg = norm(parts.slice(1).join(' '));
        if (!n) return { best: null, options: [], sure: false };
        var opts = tracks.filter(function (t) {
          var tn = norm(t.name);
          return tn === n || (tn.length > 4 && (tn.indexOf(n) >= 0 || n.indexOf(tn) >= 0));
        });
        var score = function (t) {
          var v = norm(t.variant);
          return (norm(t.name) === n ? 2 : 0) + (cfg && v === cfg ? 4 : cfg && v && (v.indexOf(cfg) >= 0 || cfg.indexOf(v) >= 0) ? 1 : 0) + (!cfg && (!v || v === norm(t.name)) ? 1 : 0);
        };
        opts.sort(function (a, b) {
          return score(b) - score(a);
        });
        var best = opts[0] || null;
        // sure enough to skip asking: the only candidate, or the name and the layout both match
        var sure = !!best && (opts.length === 1 || (norm(best.name) === n && (cfg ? norm(best.variant) === cfg : score(best) > (opts[1] ? score(opts[1]) : -1))));
        return { best: best, options: opts, sure: sure };
      },
      matchCar: function (name, cars) {
        var n = norm(name);
        if (!n) return null;
        var exact = cars.filter(function (c) {
          return norm(c.name) === n;
        });
        return exact[0] || null;
      },
      /**
       * How long to wait before the next call (ms), from a response's status and
       * headers (a get(name) function): Retry-After when a limit was hit or a bucket
       * is empty, else the minimum gap.
       */
      waitAfter: function (status, get) {
        var ra = parseFloat(get('Retry-After'));
        var empty = get('X-Ratelimit-Global-Remaining') === '0' || get('X-Ratelimit-Bucket-Remaining') === '0';
        if (isFinite(ra) && ra > 0 && (status === 429 || empty)) return Math.max(MIN_GAP, ra * 1000);
        if (status === 429) return 30000;
        return MIN_GAP;
      },
      driverName: function (d) {
        if (!d) return 'Unknown driver';
        return d.nickName || [d.firstName, d.lastName].filter(Boolean).join(' ') || d.slug || 'Unknown driver';
      },
      lapTime: function (s) {
        if (!(s > 0)) return '-';
        s = Math.round(s * 1000) / 1000;
        var m = Math.floor(s / 60), r = s - m * 60;
        return m + ':' + (r < 10 ? '0' : '') + r.toFixed(3);
      },
      /** File name the viewer lists the lap under. */
      fileName: function (lap) {
        var s = 'G61 ' + core.lapTime(lap.lapTime).replace(':', 'm') + ' ' + core.driverName(lap.driver) + (lap.car && lap.car.name ? ' ' + lap.car.name : '');
        return s.replace(/[^A-Za-z0-9 ._-]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 110) + '.csv';
      },
      /** The CSV with key/value rows on top that csv.js reads as the session's track, car, driver and date. */
      withMeta: function (csv, lap) {
        var q = function (s) {
          return '"' + String(s || '').replace(/"/g, '""').replace(/[\r\n]+/g, ' ') + '"';
        };
        var num = function (v) {
          return typeof v === 'number' && isFinite(v) ? String(v) : '';
        };
        var rows = [['Venue', core.trackLabel(lap.track)], ['Vehicle', lap.car && lap.car.name], ['Driver', core.driverName(lap.driver)], ['Date', lap.startTime],
          // the lap's conditions (csv.js reads these rows into the lap's conditions)
          ['Track temp', num(lap.trackTemp)], ['Air temp', num(lap.airTemp)], ['Track usage', num(lap.trackUsage)], ['Track wetness', num(lap.trackWetness)],
          ['Wind', num(lap.windVel)], ['Humidity', num(lap.relativeHumidity)], ['Precipitation', num(lap.precipitation)],
          ['Clouds', ['', 'Clear', 'Partly cloudy', 'Mostly cloudy', 'Overcast'][lap.clouds] || '']];
        return rows.filter(function (r) {
          return r[1];
        }).map(function (r) {
          return q(r[0]) + ',' + q(r[1]);
        }).join('\n') + '\n' + csv;
      },
    };
    if (testOnly) return core;

    if (W.location.origin !== 'https://garage61.net') {
      W.alert('iSlopTrain: open garage61.net first, then click this bookmark again.');
      return;
    }
    if (W.__istG61) return W.__istG61.focus();

    // ------------------------------------------------------------ state (closure only)
    var token = null, appOrigin = null, nonce = null, ctx = {};
    var cache = { tracks: null, cars: null, mine: null, team: null };
    var track = null, car = null, tab = 'mine', picked = {}, busy = false;
    var nextAt = 0, idleT = 0, queue = Promise.resolve();
    var opener = null;
    try {
      opener = W.opener && !W.opener.closed ? W.opener : null;
    } catch (e) {
      opener = null;
    }

    // ------------------------------------------------------------ API: one call at a time
    var sleep = function (ms) {
      return new Promise(function (r) {
        setTimeout(r, ms);
      });
    };
    function api(path, asText) {
      var run = function () {
        return attempt(path, asText, 0);
      };
      var p = queue.then(run, run);
      queue = p.then(function () {}, function () {});
      return p;
    }
    function attempt(path, asText, tries) {
      if (!token) return Promise.reject(new Error('Not connected.'));
      return sleep(Math.max(0, nextAt - Date.now())).then(function () {
        return fetch('/api/v1' + path, {
          headers: { Authorization: 'Bearer ' + token, Accept: asText ? 'text/csv' : 'application/json' },
          credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        });
      }).then(function (res) {
        var get = function (k) {
          return res.headers.get(k);
        };
        var wait = core.waitAfter(res.status, get);
        nextAt = Date.now() + wait + (res.status === 429 ? Math.random() * 1500 : 0);
        if (res.status === 429) {
          if (tries < 1) return attempt(path, asText, tries + 1);
          throw new Error('Garage 61 is rate limiting these requests. Try again in ' + Math.ceil(wait / 1000) + ' s.');
        }
        if (res.status === 401) {
          token = null;
          throw new Error('Garage 61 rejected the token. Check it on My applications.');
        }
        if (res.status === 403) throw new Error('This token has no access to driving data. The app needs the driving_data permission, approved by Garage 61.');
        if (!res.ok) throw new Error('Garage 61 answered ' + res.status + ' for ' + path.split('?')[0] + '.');
        return asText ? res.text() : res.json();
      });
    }

    // ------------------------------------------------------------ talking to the viewer tab
    function onMsg(e) {
      if (!opener || e.source !== opener) return;
      var m = e.data;
      if (!m || m.type !== 'ist-g61-ctx' || typeof m.nonce !== 'string') return;
      if (m.v !== PROTO) return setStatus('This bookmark is out of date. Drag the new one from iSlopTrain to your bookmarks bar.', true);
      appOrigin = e.origin;
      nonce = m.nonce;
      ctx = { track: typeof m.track === 'string' ? m.track.slice(0, 200) : '', car: typeof m.car === 'string' ? m.car.slice(0, 200) : '' };
      render();
    }
    function toApp(msg) {
      if (!opener || !nonce) return false;
      try {
        if (opener.closed) return false;
        msg.type = 'ist-g61-' + msg.type;
        msg.v = PROTO;
        msg.nonce = nonce;
        // file:// pages have the opaque origin "null", which can't be targeted
        opener.postMessage(msg, appOrigin && appOrigin !== 'null' ? appOrigin : '*');
        return true;
      } catch (err) {
        return false;
      }
    }
    W.addEventListener('message', onMsg);
    if (opener) {
      try {
        // the hello carries nothing, so it can go to any origin
        opener.postMessage({ type: 'ist-g61-hello', v: PROTO }, '*');
      } catch (err) {
        opener = null;
      }
    }

    // ------------------------------------------------------------ panel (shadow DOM, textContent only)
    var host = W.document.createElement('div');
    host.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;';
    var root = host.attachShadow({ mode: 'closed' });
    var style = W.document.createElement('style');
    style.textContent = [
      '*{box-sizing:border-box;font:13px/1.4 system-ui,sans-serif}',
      '.p{width:420px;max-height:calc(100vh - 24px);overflow:auto;background:#272c34;color:#eef0f4;border:1px solid #5d6675;border-top:4px solid #f6d98f;box-shadow:6px 6px 0 rgba(0,0,0,.35);padding:14px 16px}',
      '.hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}.hd b{font-size:15px}',
      '.x{background:none;border:0;color:#a1a9b7;font-size:18px;cursor:pointer}',
      '.m{color:#a1a9b7;font-size:12px;margin:6px 0}.e{color:#f2a7b5}',
      'input,select{width:100%;background:#1f232a;color:#eef0f4;border:1px solid #4a525f;padding:7px 8px;margin:4px 0}',
      'button.b{background:#3c434f;color:#eef0f4;border:1px solid #5d6675;padding:7px 12px;cursor:pointer;margin:6px 6px 0 0}',
      'button.pr{background:#f6d98f;color:#1f232a;border-color:#f6d98f;font-weight:700}',
      'button:disabled{opacity:.45;cursor:default}',
      '.tabs{display:flex;gap:4px;margin:8px 0}.tabs button{flex:1;margin:0}.tabs .on{border-color:#f6d98f;color:#f6d98f}',
      'table{width:100%;border-collapse:collapse;margin-top:4px}td{padding:4px 4px;border-top:1px solid #3c434f;vertical-align:middle}',
      'td.t{font-variant-numeric:tabular-nums;font-weight:600}tr.off{opacity:.4}tr.best td.t{color:#f6d98f}',
      'a{color:#f6d98f}',
    ].join('');
    var panel = W.document.createElement('div');
    panel.className = 'p';
    root.append(style, panel);
    W.document.body.append(host);

    var statusText = '', statusErr = false;
    function setStatus(t, err) {
      statusText = t || '';
      statusErr = !!err;
      render();
    }
    function el(tag, attrs, kids) {
      var n = W.document.createElement(tag);
      for (var k in attrs || {}) {
        if (attrs[k] == null || attrs[k] === false) continue;
        if (k === 'text') n.textContent = attrs[k];
        else if (k === 'on') for (var ev in attrs.on) n.addEventListener(ev, attrs.on[ev]);
        else if (k in n && k !== 'list') n[k] = attrs[k];
        else n.setAttribute(k, attrs[k]);
      }
      (kids || []).forEach(function (c) {
        if (c) n.append(c);
      });
      return n;
    }

    function touch() {
      clearTimeout(idleT);
      idleT = setTimeout(function () {
        dispose('Closed after 10 minutes idle. The token was forgotten.');
      }, IDLE);
    }

    function dispose(note) {
      token = null;
      cache = { tracks: null, cars: null, mine: null, team: null };
      picked = {};
      clearTimeout(idleT);
      W.removeEventListener('message', onMsg);
      host.remove();
      delete W.__istG61;
      if (note) W.console.info('iSlopTrain: ' + note);
    }

    function render() {
      panel.textContent = '';
      panel.append(el('div', { className: 'hd' }, [
        el('b', { text: 'Send laps to iSlopTrain' }),
        el('button', { className: 'x', title: 'Close and forget the token', text: '×', on: { click: function () {
          toApp({ type: 'cancel' });
          dispose();
        } } }),
      ]));
      if (!opener) {
        panel.append(el('p', { className: 'm', text: 'Not opened from iSlopTrain, so laps will be saved as CSV files instead. Drop them on the Lap Viewer.' }));
      } else if (!nonce) {
        panel.append(el('p', { className: 'm', text: 'Waiting for the iSlopTrain tab…' }));
      } else if (ctx.track) {
        panel.append(el('p', { className: 'm', text: 'Loaded in iSlopTrain: ' + ctx.track + (ctx.car ? ' · ' + ctx.car : '') }));
      }
      if (!token) renderToken();
      else if (!track) renderTrack();
      else renderLaps();
      if (statusText) panel.append(el('p', { className: 'm' + (statusErr ? ' e' : ''), text: statusText }));
    }

    function renderToken() {
      var user = el('input', { type: 'text', name: 'username', autocomplete: 'username', value: 'Garage 61 API token', hidden: true });
      var inp = el('input', { type: 'password', name: 'password', autocomplete: 'current-password', placeholder: 'Personal access token', required: true });
      var form = el('form', { on: { submit: function (e) {
        e.preventDefault();
        var v = inp.value.trim();
        inp.value = '';
        if (!v) return;
        token = v;
        touch();
        start();
      } } }, [user, inp, el('button', { className: 'b pr', type: 'submit', text: 'Connect' })]);
      panel.append(form);
      var help = el('p', { className: 'm' });
      help.append('Your token from ', el('a', { href: '/developer/applications', target: '_blank', rel: 'noopener', text: 'My applications' }),
        '. It stays in this tab only and is forgotten when this panel closes.');
      panel.append(help);
      setTimeout(function () {
        inp.focus();
      }, 0);
    }

    function start() {
      if (busy) return;
      busy = true;
      setStatus('Looking up the track…');
      var need = [api('/tracks')];
      if (ctx.car) need.push(api('/cars'));
      Promise.all(need).then(function (r) {
        cache.tracks = (r[0] && r[0].items) || [];
        cache.cars = r[1] ? r[1].items || [] : null;
        var m = core.matchTrack(ctx.track, cache.tracks);
        car = cache.cars ? core.matchCar(ctx.car, cache.cars) : null;
        busy = false;
        statusText = '';
        if (m.sure) return pickTrack(m.best);
        trackOpts = m.options;
        render();
      }).catch(fail);
    }
    var trackOpts = [];

    function renderTrack() {
      var list = trackOpts.length ? trackOpts : cache.tracks || [];
      var sel = el('select', { size: 8 });
      var fill = function (q) {
        sel.textContent = '';
        var n = norm(q);
        list.filter(function (t) {
          return !n || norm(core.trackLabel(t)).indexOf(n) >= 0;
        }).slice(0, 300).forEach(function (t, i) {
          sel.append(el('option', { value: String(t.id), text: core.trackLabel(t) + (t.platform ? ' (' + t.platform + ')' : ''), selected: i === 0 }));
        });
      };
      var q = el('input', { type: 'search', placeholder: 'Filter tracks', on: { input: function () {
        fill(q.value);
      } } });
      fill('');
      panel.append(el('p', { className: 'm', text: trackOpts.length ? 'Pick the layout:' : 'Which track?' }), q, sel,
        el('button', { className: 'b pr', text: 'Show laps', on: { click: function () {
          var id = +sel.value;
          var t = (cache.tracks || []).filter(function (x) {
            return x.id === id;
          })[0];
          if (t) pickTrack(t);
        } } }));
    }

    function pickTrack(t) {
      track = t;
      touch();
      loadTab('mine');
    }

    function loadTab(which) {
      tab = which;
      if (cache[which]) return render();
      busy = true;
      setStatus('Finding laps…');
      var q = '?tracks=' + track.id + (car ? '&cars=' + car.id : '') + (which === 'mine' ? '&drivers=me&group=none&limit=50' : '&group=driver&limit=20');
      api('/laps' + q).then(function (r) {
        var items = ((r && r.items) || []).slice().sort(function (a, b) {
          return (a.lapTime || 1e9) - (b.lapTime || 1e9);
        });
        cache[which] = items;
        busy = false;
        statusText = items.length ? '' : 'No laps found here' + (car ? ' in this car' : '') + '.';
        // start with the fastest clean lap you can open
        if (which === 'mine' && !Object.keys(picked).length) {
          var first = items.filter(function (l) {
            return l.canViewTelemetry !== false && l.clean !== false;
          })[0];
          if (first) picked[first.id] = first;
        }
        render();
      }).catch(fail);
    }

    function renderLaps() {
      panel.append(el('p', { className: 'm', text: core.trackLabel(track) + (car ? ' · ' + car.name : ' · any car') }));
      if (car) panel.append(el('button', { className: 'b', text: 'Show every car', on: { click: function () {
        car = null;
        cache.mine = cache.team = null;
        loadTab(tab);
      } } }));
      panel.append(el('div', { className: 'tabs' }, [
        el('button', { className: 'b' + (tab === 'mine' ? ' on' : ''), text: 'My laps', disabled: busy, on: { click: function () {
          loadTab('mine');
        } } }),
        el('button', { className: 'b' + (tab === 'team' ? ' on' : ''), text: 'Best per driver', disabled: busy, on: { click: function () {
          loadTab('team');
        } } }),
      ]));
      var items = cache[tab] || [];
      var n = Object.keys(picked).length;
      var tb = el('table');
      items.forEach(function (l, i) {
        var can = l.canViewTelemetry !== false;
        var box = el('input', { type: 'checkbox', checked: !!picked[l.id], disabled: !can || (!picked[l.id] && n >= MAX_SEND), on: { change: function () {
          if (box.checked) picked[l.id] = l;
          else delete picked[l.id];
          touch();
          render();
        } } });
        box.style.width = 'auto';
        var when = l.startTime ? new Date(l.startTime).toLocaleDateString() : '';
        tb.append(el('tr', { className: (can ? '' : 'off') + (i === 0 ? ' best' : ''), title: can ? '' : 'Telemetry not visible for this lap' }, [
          el('td', null, [box]),
          el('td', { className: 't', text: core.lapTime(l.lapTime) }),
          el('td', { text: tab === 'team' ? core.driverName(l.driver) : when }),
          el('td', { className: 'm', text: (l.car && l.car.name) || '' }),
          el('td', { className: 'm', text: l.clean === false ? 'unclean' : l.offtrack ? 'off' : '' }),
        ]));
      });
      panel.append(tb);
      panel.append(el('button', { className: 'b pr', disabled: busy || !n, text: (opener && nonce ? 'Send ' : 'Save ') + n + ' lap' + (n === 1 ? '' : 's'), on: { click: send } }));
      panel.append(el('p', { className: 'm', text: 'Up to ' + MAX_SEND + ' laps per send. Each lap is one request, spaced out to go easy on Garage 61.' }));
    }

    function send() {
      var laps = Object.keys(picked).map(function (k) {
        return picked[k];
      }).slice(0, MAX_SEND);
      if (!laps.length || busy) return;
      busy = true;
      var live = !!(opener && nonce);
      var i = 0;
      var next = function () {
        if (i >= laps.length) {
          if (live) toApp({ type: 'done', count: laps.length });
          dispose(laps.length + ' lap(s) ' + (live ? 'sent' : 'saved') + '. The token was forgotten.');
          return;
        }
        var l = laps[i];
        setStatus('Fetching lap ' + (i + 1) + ' of ' + laps.length + '…');
        api('/laps/' + encodeURIComponent(l.id) + '/csv', true).then(function (csv) {
          var text = core.withMeta(csv, l), name = core.fileName(l);
          if (live) {
            if (!toApp({ type: 'lap', name: name, csv: text })) throw new Error('The iSlopTrain tab was closed.');
          } else {
            var a = W.document.createElement('a');
            a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
            a.download = name;
            a.click();
            setTimeout(function () {
              URL.revokeObjectURL(a.href);
            }, 5000);
          }
          i++;
          next();
        }).catch(fail);
      };
      next();
    }

    function fail(err) {
      busy = false;
      setStatus((err && err.message) || String(err), true);
    }

    W.__istG61 = { focus: function () {
      host.scrollIntoView();
    } };
    touch();
    render();
  }

  /** The bookmarklet's javascript: URL (rebuilt from the function above). */
  const href = () => {
    // indentation and whole-line comments dropped: a third of the size (no string in bridge spans lines)
    const src = bridge.toString().split('\n').map((l) => l.trim()).filter((l) => l && !/^(\/\/|\/\*|\*)/.test(l)).join('\n');
    return 'javascript:' + encodeURIComponent('(' + src + ')(window);void 0');
  };

  /**
   * Message filter for the viewer's side: handle(event) returns the accepted message
   * ({ type: 'hello' | 'lap' | 'done' | 'cancel', ... }) or null.
   */
  function receiver(o) {
    let count = 0;
    return function (e) {
      if (!e || e.origin !== G61 || !o.source() || e.source !== o.source()) return null;
      const m = e.data;
      if (!m || typeof m !== 'object' || typeof m.type !== 'string') return null;
      if (m.type === 'ist-g61-hello') return { type: 'hello', v: m.v };
      if (m.v !== PROTO || m.nonce !== o.nonce) return null;
      if (m.type === 'ist-g61-lap') {
        if (typeof m.csv !== 'string' || !m.csv.length || m.csv.length > MAX_CSV || count >= MAX_SEND) return null;
        count++;
        const name = (String(m.name || 'garage61-lap').replace(/[^A-Za-z0-9 ._-]+/g, '').replace(/\.csv$/i, '').slice(0, 110) || 'garage61-lap') + '.csv';
        return { type: 'lap', name, csv: m.csv };
      }
      if (m.type === 'ist-g61-done') return { type: 'done' };
      if (m.type === 'ist-g61-cancel') return { type: 'cancel' };
      return null;
    };
  }

  function makeNonce() {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * The import panel. ctx: { track, car } of what's loaded (sent to the Garage 61
   * tab so it can find the same track); onFiles(files) gets the laps as File objects.
   * Returns { el, dispose }: call dispose when the panel goes away.
   */
  function panel(ctx, onFiles) {
    let win = null, nonce = null, handle = null, poll = 0, files = [];
    const status = h('p', { class: 'g61-status muted', 'aria-live': 'polite' }, '');
    const say = (t, err) => {
      status.textContent = t;
      status.classList.toggle('rv-err', !!err);
    };

    function stop() {
      window.removeEventListener('message', onMessage);
      clearInterval(poll);
      poll = 0;
      handle = null;
      nonce = null;
    }
    function finish(note) {
      const got = files;
      files = [];
      stop();
      if (win && !win.closed) win.close();
      win = null;
      if (got.length) onFiles(got);
      else if (note) say(note);
    }
    function onMessage(e) {
      if (!handle) return;
      const m = handle(e);
      if (!m) return;
      if (m.type === 'hello') {
        if (m.v !== PROTO) return say('That bookmark is from another version of iSlopTrain. Drag the button above to your bookmarks bar again.', true);
        win.postMessage({ type: 'ist-g61-ctx', v: PROTO, nonce, track: ctx.track || '', car: ctx.car || '' }, G61);
        say('Connected to the Garage 61 tab. Pick laps there.');
      } else if (m.type === 'lap') {
        files.push(new File([m.csv], m.name, { type: 'text/csv' }));
        say('Received ' + files.length + ' lap' + (files.length === 1 ? '' : 's') + '…');
      } else if (m.type === 'done') finish();
      else if (m.type === 'cancel') finish('Cancelled on Garage 61.');
    }
    function connect() {
      stop();
      files = [];
      win = window.open(G61 + '/app', 'ist-garage61');
      if (!win) return say('The browser blocked the new tab. Allow pop-ups for this page and try again.', true);
      nonce = makeNonce();
      handle = receiver({ source: () => win, nonce });
      window.addEventListener('message', onMessage);
      // the tab being closed is checked here, with no network call
      poll = setInterval(() => {
        if (!win || win.closed) finish(files.length ? null : 'The Garage 61 tab was closed.');
      }, 1000);
      say('Garage 61 is open in a new tab. Sign in if asked, then click the iSlopTrain bookmark there.');
    }

    const mark = h('a', { class: 'btn g61-mark', href: href(), title: 'Drag me to your bookmarks bar', onclick: (e) => {
      e.preventDefault();
      say('Drag this button to your bookmarks bar (Ctrl+Shift+B shows the bar), don’t click it here.');
    } }, '★ iSlopTrain ← G61');

    // ---- the main path: export by hand, drop here
    const take = (list) => {
      const csv = Array.from(list || []).filter((f) => /\.(csv|tsv|txt)$/i.test(f.name));
      if (!csv.length) return say('That isn’t a CSV file. Garage 61 exports laps as .csv.', true);
      finish();
      onFiles(csv);
    };
    const pick = () => {
      const input = h('input', { type: 'file', multiple: true, accept: '.csv', class: 'hidden' });
      input.addEventListener('change', () => input.files.length && take(input.files));
      document.body.append(input);
      input.click();
      setTimeout(() => input.remove(), 60000);
    };
    const drop = h('div', { class: 'g61-drop' },
      h('b', null, 'Drop Garage 61 CSV files here'),
      h('span', { class: 'muted small' }, 'One lap per file. Read in this browser, never uploaded.'),
      h('button', { class: 'btn primary', onclick: pick }, 'Choose files'));
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('rv-over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('rv-over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('rv-over');
      take(e.dataTransfer.files);
    });

    // ---- optional: the bookmarklet bridge, folded away
    const extra = h('details', { class: 'g61-extra' },
      h('summary', null, 'Optional: one-click import with a bookmark ', h('span', { class: 'muted small' }, '(needs a Garage 61 API token)')),
      h('p', { class: 'muted' }, 'If you’d rather not export files by hand: a bookmark that runs on garage61.net fetches the laps with your own API token and sends them here. Garage 61 doesn’t let other sites call its API, so this is the only way to do it from a browser.'),
      h('ol', { class: 'g61-steps' },
        h('li', null, 'Drag this to your bookmarks bar (once): ', mark),
        h('li', null, 'Get a personal access token from ', h('a', { href: G61 + '/developer/applications', target: '_blank', rel: 'noopener noreferrer' }, 'My applications'),
          ' on Garage 61. Your API application needs the ', h('code', null, 'driving_data'), ' permission, which Garage 61 approves.'),
        h('li', null, h('button', { class: 'btn', onclick: connect }, 'Open Garage 61'), ' then click the bookmark there, paste the token, and pick laps.')),
      status,
      h('p', { class: 'muted small' },
        'The token stays on garage61.net: iSlopTrain never sees it, and the bookmark forgets it when its panel closes. ' +
          (ctx.track ? 'The bookmark is told the track and car loaded here (' + [ctx.track, ctx.car].filter(Boolean).join(' · ') + ') to find matching laps. ' : '') +
          'Requests go one at a time, only when you click. Laps arrive as CSV and are read here like any dropped file.'),
      location.protocol === 'file:' ? h('p', { class: 'muted small' }, 'Tip: opened from a file, this page can’t be named as the only receiver of the laps. Serving it from localhost is safer.') : null);

    const el = h('div', { class: 'g61' },
      h('h2', null, 'Import from Garage 61'),
      h('p', { class: 'muted' }, 'Bring in laps from your Garage 61 account, yours or a teammate’s, to compare here.'),
      h('ol', { class: 'g61-steps' },
        h('li', null, h('a', { href: G61 + '/app', target: '_blank', rel: 'noopener noreferrer' }, 'Open Garage 61'), ' and sign in.'),
        h('li', null, 'Find the lap you want' + (ctx.track ? ' at ' + ctx.track : '') + ', open its telemetry, and export it as CSV. Repeat for each lap you want to compare.'),
        h('li', null, 'Drop the files below.')),
      drop,
      extra);

    return { el, dispose: () => finish() };
  }

  IST.Review.Garage61 = { panel, href, receiver, core: bridge(null, true), PROTO, MAX_SEND, MAX_CSV };
})();
