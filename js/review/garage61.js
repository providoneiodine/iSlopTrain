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
 *   - "Find similar laps" uses the site's own /api/internal search and CSV export with
 *     the signed-in session, since unapproved API apps only see their own team's laps.
 *     Same queue and spacing; at most SIM_PAGES searches per click.
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
    var PROTO = 1, MAX_SEND = 5, MIN_GAP = 1100, IDLE = 10 * 60 * 1000, SIM_PAGES = 5, SIM_LIMIT = 100, ROWS = 15;
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
      /**
       * Other drivers' laps up to `quicker` seconds faster than yours (ref: { lapTime }),
       * fastest first, with unclean or off-track laps after the clean ones.
       */
      faster: function (laps, ref, quicker) {
        var t = ref && ref.lapTime;
        if (!(t > 0) || !(quicker > 0)) return [];
        return (laps || []).filter(function (l) {
          return l && l.lapTime > 0 && l.lapTime < t && t - l.lapTime <= quicker + 1e-9 && l.canViewTelemetry !== false;
        }).map(function (l) {
          return { l: l, k: (l.clean === false || l.offtrack ? 1000 : 0) + l.lapTime };
        }).sort(function (a, b) {
          return a.k - b.k;
        }).map(function (x) {
          return x.l;
        });
      },
      /** A lap from the site's internal search, in the public API's shape (plus a few extras). */
      fromInternal: function (x, track, car) {
        var d = x.driver || {};
        return {
          id: x.id, internal: true, lapTime: x.lap_time, startTime: x.start_time, clean: x.clean,
          // the search leaves can_view_telemetry out (not false) on laps whose CSV it refuses
          canViewTelemetry: x.can_view_telemetry === true && x.have_samples !== false,
          trackTemp: x.track_temp, airTemp: x.weather_air_temp, windVel: x.weather_wind_vel, relativeHumidity: x.weather_relative_humidity,
          precipitation: x.weather_precipitation, clouds: x.weather_cloud_cover,
          driver: { firstName: d.firstname || '', lastName: d.lastname || '', slug: d.slug || '', nickName: d.firstname || d.lastname ? '' : x.driver_name || '' },
          rating: x.driver_rating, fuel: x.fuel_level, season: x.season,
          sectors: (x.sectors || []).map(function (q) {
            return q && !q.incomplete ? q.sector_time : null;
          }),
          track: track, car: car,
        };
      },
      /** The slider's range in seconds for a lap time: 5 % of it, between 1 and 10 s. */
      quickerMax: function (t) {
        return Math.max(1, Math.min(10, Math.round(t * 0.05)));
      },
      /** How long ago a lap was driven, short ("3 d", "5 mo"). */
      age: function (iso, now) {
        var ms = (now || Date.now()) - Date.parse(iso);
        if (!isFinite(ms) || ms < 0) return '';
        var d = ms / 864e5;
        return d < 1 ? 'today' : d < 45 ? Math.round(d) + ' d' : d < 730 ? Math.round(d / 30.4) + ' mo' : Math.round(d / 365) + ' y';
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
    var cache = { tracks: null, cars: null, mine: null, team: null, similar: null };
    var track = null, car = null, tab = 'mine', picked = {}, busy = false, quicker = 0, pg = 0;
    var nextAt = 0, idleT = 0, queue = Promise.resolve(), asFiles = false, deafT = 0;
    var opener = null, me = null;
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
        // /internal/ is the site's own API: the signed-in session, no token
        var own = path.indexOf('/internal/') === 0, accept = asText ? 'text/csv' : 'application/json';
        return fetch('/api' + (own ? '' : '/v1') + path, {
          headers: own ? { Accept: accept } : { Authorization: 'Bearer ' + token, Accept: accept },
          credentials: own ? 'include' : 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
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
        if (res.status === 401 && path.indexOf('/internal/') === 0) throw new Error('Sign in to Garage 61 in this tab to search other drivers’ laps.');
        if (res.status === 401) {
          token = null;
          throw new Error('Garage 61 rejected the token. Check it on My applications.');
        }
        if (res.status === 403 && path.indexOf('/internal/') === 0) {
          var no = new Error('Garage 61 won’t share this lap’s telemetry.');
          no.refused = true;
          throw no;
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
      clearTimeout(deafT);
      var num = function (v) {
        return typeof v === 'number' && isFinite(v) ? v : null;
      };
      ctx = { track: typeof m.track === 'string' ? m.track.slice(0, 200) : '', car: typeof m.car === 'string' ? m.car.slice(0, 200) : '',
        lapTime: num(m.lapTime), trackTemp: num(m.trackTemp), airTemp: num(m.airTemp) };
      if (ctx.lapTime) quicker = Math.min(1.5, core.quickerMax(ctx.lapTime));
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
      // the viewer only answers while its Garage 61 panel is waiting for this tab
      deafT = setTimeout(function () {
        if (!nonce) setStatus('iSlopTrain isn’t listening. There, open Import from Garage 61 and press Open Garage 61, then click the bookmark again.', true);
      }, 4000);
    }

    // ------------------------------------------------------------ panel (shadow DOM, textContent only)
    var host = W.document.createElement('div');
    // centred over a dimmed page: this tab is only open to pick laps
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px;background:rgba(12,14,18,.6);';
    var root = host.attachShadow({ mode: 'closed' });
    var style = W.document.createElement('style');
    style.textContent = [
      '*{box-sizing:border-box;font:14px/1.45 system-ui,sans-serif}',
      '.p{width:min(760px,100%);max-height:calc(100vh - 48px);overflow:auto;background:#272c34;color:#eef0f4;border:1px solid #5d6675;border-top:4px solid #f6d98f;box-shadow:8px 8px 0 rgba(0,0,0,.35);padding:22px 26px}',
      '.hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.hd b{font-size:19px}',
      '.x{background:none;border:0;color:#a1a9b7;font-size:24px;line-height:1;cursor:pointer;padding:4px 8px}',
      '.m{color:#a1a9b7;font-size:13px;margin:8px 0}.e{color:#f2a7b5}',
      'input,select{width:100%;background:#1f232a;color:#eef0f4;border:1px solid #4a525f;padding:9px 10px;margin:4px 0}',
      'button.b{background:#3c434f;color:#eef0f4;border:1px solid #5d6675;padding:9px 16px;cursor:pointer;margin:8px 8px 0 0}',
      'button.pr{background:#f6d98f;color:#1f232a;border-color:#f6d98f;font-weight:700}',
      'button:disabled{opacity:.45;cursor:default}',
      '.tabs{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 8px}.tabs button{flex:1 1 140px;margin:0}.tabs .on{border-color:#f6d98f;color:#f6d98f}',
      'table{width:100%;border-collapse:collapse;margin-top:4px;color:inherit}td{padding:8px 6px;border-top:1px solid #3c434f;vertical-align:middle}td.d{font-variant-numeric:tabular-nums;color:#a1a9b7}',
      'td.t{font-variant-numeric:tabular-nums;font-weight:600}tr.off{opacity:.4}tr.best td.t{color:#f6d98f}',
      'th{color:#a1a9b7;font-size:12px;font-weight:400;text-align:left;padding:4px 6px}tr.warn td.t{color:#a1a9b7}',
      '.sl{margin:10px 0 2px}.sl b{display:block;font-weight:600;margin-bottom:4px}.sl input{accent-color:#f6d98f;padding:0;border:0;background:none}',
      '.pg{display:flex;align-items:center;gap:10px}.pg button{margin:8px 0 0}.pg span{margin-top:8px}',
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
      cache = { tracks: null, cars: null, mine: null, team: null, similar: null };
      picked = {};
      clearTimeout(idleT);
      clearTimeout(deafT);
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
        // usually a sign-in page (Discord, Google…) cut this tab off from the one that opened it
        panel.append(el('p', { className: 'm e', text: 'This tab isn’t linked to iSlopTrain, so laps can’t go straight there. Signing in here cuts the link. You’re signed in now, so go back to iSlopTrain, press Open Garage 61 (in Import from Garage 61), and click the bookmark in the tab it opens.' }));
      } else if (!nonce) {
        panel.append(el('p', { className: 'm', text: 'Waiting for the iSlopTrain tab…' }));
      } else if (ctx.track) {
        panel.append(el('p', { className: 'm', text: 'Loaded in iSlopTrain: ' + ctx.track + (ctx.car ? ' · ' + ctx.car : '') + (ctx.lapTime ? ' · best ' + core.lapTime(ctx.lapTime) : '') }));
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
      // with a lap loaded in iSlopTrain, a faster reference is what you're usually after
      loadTab(ctx.lapTime ? 'similar' : 'mine');
    }

    function loadTab(which) {
      // your own laps are already in iSlopTrain, so a reference pick starts empty
      if (which !== tab) pg = 0;
      if (which === 'similar' && tab !== 'similar') picked = {};
      tab = which;
      if (cache[which]) return render();
      busy = true;
      setStatus('Finding laps…');
      if (which === 'similar') return loadSimilar();
      var q = '?tracks=' + track.id + (car ? '&cars=' + car.id : '') + (which === 'mine' ? '&drivers=me&group=none&limit=50' : which === 'similar' ? '&group=driver&limit=100' : '&group=driver&limit=20');
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

    /**
     * Other drivers' best laps from the site's search, page by page until the laps get
     * slower than yours (the search lists the fastest first) or SIM_PAGES is reached.
     */
    function loadSimilar() {
      var got = [], seen = {}, page = 0;
      var who = me ? Promise.resolve(me) : api('/me').then(function (m) {
        return (me = m || {});
      }, function () {
        return (me = {});
      });
      var next = function () {
        var q = '/internal/laps?clean=1&tracks=' + track.id + (car ? '&cars=' + car.id : '') + '&weight_penalty_min=0&power_adjust_max=0&age=-1&limit=' + SIM_LIMIT + '&offset=' + page * SIM_LIMIT;
        setStatus('Searching other drivers’ laps' + (page ? ' (page ' + (page + 1) + ')' : '') + '…');
        return api(q).then(function (r) {
          var items = (r && r.items) || [], fresh = 0;
          items.forEach(function (x) {
            if (!x || !x.id || seen[x.id]) return;
            seen[x.id] = 1;
            fresh++;
            if (!(me.slug && x.driver && x.driver.slug === me.slug)) got.push(core.fromInternal(x, track, car));
          });
          page++;
          var slowest = items.length ? items[items.length - 1].lap_time : 0;
          // stop when a page adds nothing new (no paging), is short, or already passes your time
          if (fresh && items.length >= SIM_LIMIT && slowest < ctx.lapTime && page < SIM_PAGES) return next();
        });
      };
      who.then(next).then(function () {
        cache.similar = got;
        busy = false;
        statusText = '';
        render();
      }).catch(fail);
    }

    function renderLaps() {
      panel.append(el('p', { className: 'm', text: core.trackLabel(track) + (car ? ' · ' + car.name : ' · any car') }));
      if (car) panel.append(el('button', { className: 'b', text: 'Show every car', on: { click: function () {
        car = null;
        cache.mine = cache.team = cache.similar = null;
        loadTab(tab);
      } } }));
      panel.append(el('div', { className: 'tabs' }, [
        el('button', { className: 'b' + (tab === 'mine' ? ' on' : ''), text: 'My laps', disabled: busy, on: { click: function () {
          loadTab('mine');
        } } }),
        el('button', { className: 'b' + (tab === 'team' ? ' on' : ''), text: 'Best per driver', disabled: busy, on: { click: function () {
          loadTab('team');
        } } }),
        el('button', { className: 'b' + (tab === 'similar' ? ' on' : ''), text: 'Find similar laps', disabled: busy || !ctx.lapTime,
          title: ctx.lapTime ? 'Other drivers’ laps a little faster than your ' + core.lapTime(ctx.lapTime) : 'Load a lap in iSlopTrain first', on: { click: function () {
            loadTab('similar');
          } } }),
      ]));
      var sim = tab === 'similar' && ctx.lapTime > 0;
      var n = Object.keys(picked).length;
      var tb = el('table'), pager = el('div', { className: 'pg' });
      var fill = function () {
        tb.textContent = '';
        var all = sim ? core.faster(cache.similar, ctx, quicker) : cache[tab] || [];
        var pages = Math.max(1, Math.ceil(all.length / ROWS));
        if (pg >= pages) pg = pages - 1;
        var items = all.slice(pg * ROWS, pg * ROWS + ROWS);
        if (sim) tb.append(el('tr', { className: 'h' }, ['', 'Lap', 'Faster', 'Driver', 'iRating', 'Track', 'Air', 'Fuel', 'Driven', ''].map(function (t) {
          return el('th', { text: t });
        })));
        items.forEach(function (l, i) {
          var can = l.canViewTelemetry !== false;
          var box = el('input', { type: 'checkbox', checked: !!picked[l.id], disabled: !can || (!picked[l.id] && n >= MAX_SEND), on: { change: function () {
            if (box.checked) picked[l.id] = l;
            else delete picked[l.id];
            touch();
            render();
          } } });
          box.style.width = 'auto';
          i += pg * ROWS;
          var flag = l.clean === false ? 'unclean' : l.offtrack ? 'off track' : l.precipitation > 0 ? 'rain' : '';
          if (!sim) {
            var when = l.startTime ? new Date(l.startTime).toLocaleDateString() : '';
            tb.append(el('tr', { className: (can ? '' : 'off') + (i === 0 ? ' best' : ''), title: can ? '' : 'Telemetry not visible for this lap' }, [
              el('td', null, [box]),
              el('td', { className: 't', text: core.lapTime(l.lapTime) }),
              el('td', { text: tab === 'team' ? core.driverName(l.driver) : when }),
              el('td', { className: 'm', text: (l.car && l.car.name) || '' }),
              el('td', { className: 'm', text: flag === 'rain' ? '' : flag }),
            ]));
            return;
          }
          var tt = typeof l.trackTemp === 'number' ? l.trackTemp : null, at = typeof l.airTemp === 'number' ? l.airTemp : null;
          var dT = tt != null && ctx.trackTemp != null ? tt - ctx.trackTemp : null;
          var secs = (l.sectors || []).map(function (v, k) {
            return 'S' + (k + 1) + ' ' + (v > 0 ? v.toFixed(3) : '–');
          }).join('  ');
          tb.append(el('tr', { className: flag ? 'warn' : '', title: secs }, [
            el('td', null, [box]),
            el('td', { className: 't', text: core.lapTime(l.lapTime) }),
            el('td', { className: 'd', text: '−' + (ctx.lapTime - l.lapTime).toFixed(3) }),
            el('td', { text: core.driverName(l.driver) }),
            el('td', { className: 'm', text: l.rating > 0 ? String(l.rating) : '–' }),
            el('td', { className: 'm' + (dT != null && Math.abs(dT) > 3 ? ' e' : ''), title: dT != null ? (dT >= 0 ? '+' : '') + dT.toFixed(1) + ' °C vs yours' : '', text: tt != null ? tt.toFixed(0) + ' °C' : '–' }),
            el('td', { className: 'm', text: at != null ? at.toFixed(0) + ' °C' : '–' }),
            el('td', { className: 'm', title: 'Fuel in the tank at the start of the lap: more is heavier and slower', text: l.fuel > 0 ? l.fuel.toFixed(1) + ' L' : '–' }),
            el('td', { className: 'm', title: l.startTime ? new Date(l.startTime).toLocaleString() : '', text: l.startTime ? core.age(l.startTime) : '–' }),
            el('td', { className: 'm' + (flag ? ' e' : ''), text: flag }),
          ]));
        });
        if (sim && cache.similar && !items.length) tb.append(el('tr', null, [el('td', { className: 'm', colSpan: 10, text: 'No other drivers within ' + quicker.toFixed(1) + ' s of your lap here. Drag the slider for more.' })]));
        pager.textContent = '';
        if (pages > 1) {
          var go = function (d) {
            return function () {
              pg += d;
              touch();
              fill();
            };
          };
          pager.append(el('button', { className: 'b', text: '‹ Faster', disabled: pg === 0, on: { click: go(-1) } }),
            el('span', { className: 'm', text: (pg * ROWS + 1) + '–' + Math.min(all.length, pg * ROWS + ROWS) + ' of ' + all.length }),
            el('button', { className: 'b', text: 'Slower ›', disabled: pg >= pages - 1, on: { click: go(1) } }));
        }
      };
      if (sim) {
        var max = core.quickerMax(ctx.lapTime);
        var lbl = el('b', { text: '' });
        var setLbl = function () {
          lbl.textContent = 'Up to ' + quicker.toFixed(1) + ' s faster than your ' + core.lapTime(ctx.lapTime);
        };
        setLbl();
        var range = el('input', { type: 'range', min: '0.1', max: String(max), step: '0.1', value: String(quicker), 'aria-label': 'Seconds faster than your lap', on: { input: function () {
          quicker = +range.value;
          pg = 0;
          setLbl();
          touch();
          fill();
        } } });
        panel.append(el('div', { className: 'sl' }, [lbl, range]));
        panel.append(el('p', { className: 'm', text: 'Other drivers’ best clean laps, fastest first. Track temperature more than 3 °C from yours' + (ctx.trackTemp != null ? ' (' + ctx.trackTemp.toFixed(0) + ' °C)' : '') + ' is marked, and a lot more or less fuel than you ran changes the pace. Hover a row for its sectors.' }));
      }
      fill();
      panel.append(tb, pager);
      var live = !!(opener && nonce), s = n + ' lap' + (n === 1 ? '' : 's');
      panel.append(el('button', { className: 'b pr', disabled: busy || !n || !live, text: 'Send ' + s, on: { click: send } }));
      if (!live) panel.append(el('button', { className: 'b', disabled: busy || !n, text: 'Save ' + s + ' as CSV files', on: { click: function () {
        asFiles = true;
        send();
      } } }));
      panel.append(el('p', { className: 'm', text: 'Up to ' + MAX_SEND + ' laps per send. Each lap is one request, spaced out to go easy on Garage 61.' }));
    }

    function send() {
      var laps = Object.keys(picked).map(function (k) {
        return picked[k];
      }).slice(0, MAX_SEND);
      if (!laps.length || busy) return;
      var live = !!(opener && nonce);
      if (!live && !asFiles) return;
      busy = true;
      var i = 0, skipped = [];
      var next = function () {
        if (i >= laps.length) {
          var n = laps.length - skipped.length;
          // a refused lap is skipped, not fatal; if every lap was refused, stay open to pick others
          if (!n) {
            busy = false;
            skipped.forEach(function (l) {
              delete picked[l.id];
            });
            return setStatus('Garage 61 won’t share telemetry for ' + skipped.map(function (l) {
              return core.driverName(l.driver);
            }).join(', ') + '. Pick other laps.', true);
          }
          if (live) toApp({ type: 'done', count: n });
          dispose(n + ' lap(s) ' + (live ? 'sent' : 'saved') + (skipped.length ? ', ' + skipped.length + ' refused by Garage 61' : '') + '. The token was forgotten.');
          return;
        }
        var l = laps[i];
        setStatus('Fetching lap ' + (i + 1) + ' of ' + laps.length + '…');
        api((l.internal ? '/internal' : '') + '/laps/' + encodeURIComponent(l.id) + '/csv', true).then(function (csv) {
          if (l.internal && !/speed|lapdistpct/i.test(String(csv).slice(0, 4000))) throw new Error('Garage 61 sent ' + core.driverName(l.driver) + '’s lap in a format iSlopTrain doesn’t read.');
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
        }).catch(function (err) {
          if (!err || !err.refused) return fail(err);
          skipped.push(l);
          i++;
          next();
        });
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
    function finish(note, err) {
      const got = files;
      files = [];
      stop();
      if (win && !win.closed) win.close();
      win = null;
      if (got.length) onFiles(got);
      else if (note) say(note, err);
    }
    function onMessage(e) {
      if (!handle) return;
      const m = handle(e);
      if (!m) return;
      if (m.type === 'hello') {
        if (m.v !== PROTO) return say('That bookmark is from another version of iSlopTrain. Drag the button above to your bookmarks bar again.', true);
        win.postMessage({ type: 'ist-g61-ctx', v: PROTO, nonce, track: ctx.track || '', car: ctx.car || '', lapTime: ctx.lapTime || 0, trackTemp: ctx.trackTemp, airTemp: ctx.airTemp }, G61);
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
        if (!win || win.closed) finish(files.length ? null : 'Lost the Garage 61 tab: it was closed, or signing in there cut the link. If you’re signed in now, press Open Garage 61 again.', true);
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
        h('li', null, 'Sign in to Garage 61 first if you aren’t (signing in inside the tab below cuts its link here). Then ', h('button', { class: 'btn', onclick: connect }, 'Open Garage 61'), ', click the bookmark there, paste the token, and pick laps.')),
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
        // opened by connect() rather than a plain link, so the tab stays linked if the bookmark is used there later
        h('li', null, h('a', { href: G61 + '/app', onclick: (e) => {
          e.preventDefault();
          connect();
        } }, 'Open Garage 61'), ' and sign in.'),
        h('li', null, 'Find the lap you want' + (ctx.track ? ' at ' + ctx.track : '') + ', open its telemetry, and export it as CSV. Repeat for each lap you want to compare.'),
        h('li', null, 'Drop the files below.')),
      drop,
      extra);

    return { el, dispose: () => finish() };
  }

  IST.Review.Garage61 = { panel, href, receiver, core: bridge(null, true), PROTO, MAX_SEND, MAX_CSV };
})();
