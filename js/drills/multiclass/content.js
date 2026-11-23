/*
 * Class Traffic: palette, timings, labels, and the words and grade for
 * each option. Plain data and text, no drawing or state.
 *
 * Files in js/drills/multiclass/ load in this order and share the drill's
 * private namespace IST.Multiclass:
 *   content.js  this file
 *   ui.js       canvas widgets in the page's theme (box, caps, chip, keycap, button)
 *   replay.js   replay timeline: events, interpolation, stepping
 *   scene.js    the top-down map and the in-car view (mirror, relative box)
 *   screens.js  rule picker, quiz and replay screens
 *   stats.js    coach tips and the Stats page breakdowns
 *   drill.js    the drill definition, session state, input and results
 */
(function () {
  'use strict';
  const TL = IST.TrafficLab;
  const MC = (IST.Multiclass = {});
  // the main page's palette (css/style.css :root): slate structure, pastel meaning
  const COL = {
    text: '#eef0f4', text2: '#c9cfd9', dim: '#a1a9b7', ink: '#1f232a',
    bg: '#272c34', deep: '#1f232a', panel: '#323842', panel2: '#3c434f', line: '#4a525f', lineStrong: '#5d6675',
    quiz: '#f6d98f', mint: '#a6e3c4', lilac: '#c4b4ef', peach: '#f5b09a',
    fast: '#9fcbef', slow: '#f5b09a', good: '#a6e3c4', warn: '#f6d98f', bad: '#f09ca6',
  };
  const BUDGET = 8; // ms per frame spent building the next question
  const LEADUP = 2.2, DECIDE_HOLD = 1.6; // s of looped run-up to the decision frame, and the hold on it
  const HOLD = 1900; // ms paused at each event in the replay
  const REVEAL = 1500;
  const PREF = 'multiclass.rules';
  const RULE_IDS = ['hold', 'yield', 'pointby'];

  const EV = {
    close: { label: 'Closing', color: '#c4b4ef' },
    brake: { label: 'Braking', color: '#f5b09a' },
    turnin: { label: 'GT turns in', color: '#f6d98f' },
    apex: { label: 'Apex', color: '#9fcbef' },
    pass: { label: 'Pass complete', color: '#a6e3c4' },
    contact: { label: 'Contact', color: '#f09ca6' },
    squeeze: { label: 'Squeezed', color: '#f6d98f' },
    cut: { label: 'Cut across', color: '#f6d98f' },
    hard: { label: 'Hard braking', color: '#f6d98f' },
    exit: { label: 'Track-out', color: '#c4b4ef' },
    end: { label: 'End of the straight', color: '#eef0f4' },
  };
  const PRIO = { contact: 9, squeeze: 8, cut: 8, hard: 7, pass: 6, turnin: 5, brake: 4, apex: 3, close: 2, exit: 2, end: 10 };

  const SITS = {
    'f-straight': 'Faster car: the pass on the straight is on',
    'f-dive': 'Faster car: out-brake it',
    'f-outside': 'Faster car: round the outside',
    'f-follow': 'Faster car: wait for the exit',
    's-clear': 'Slower car: it\'ll clear before braking',
    's-committed': 'Slower car: it\'ll be alongside into the corner',
    's-behind': 'Slower car: stuck behind you',
  };
  const SIT_ORDER = Object.keys(SITS);
  const OPT_LABELS = {
    straight: 'Pass on the straight', dive: 'Out-brake on the inside', outside: 'Round the outside', follow: 'Follow it through',
    hold: 'Hold your line', letby: 'Ease off, let it by', room: 'Leave room', across: 'Move across', brakeMove: 'Move over under braking', defend: 'Cover the inside',
  };
  const OPT_ORDER = TL.FAST.concat(TL.SLOW);

  const kmh = (v) => Math.round(v * 3.6);
  const sec = (t) => (t >= 0 ? '+' : '−') + Math.abs(t).toFixed(2) + ' s';
  const m1 = (x) => (Math.abs(x) < 9.95 ? Math.abs(x).toFixed(1) : String(Math.round(Math.abs(x))));

  function shuffle(a, rnd) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---------------------------------------------------------------- texts
  function optText(q, id) {
    const side = q.side, T1 = 'T1';
    const pb = q.rules === 'pointby';
    switch (id) {
      case 'straight': return { label: 'Pass on the straight', sub: 'Pull out now, get clear and back on the racing line before braking.' };
      case 'dive': return { label: 'Out-brake it on the inside', sub: 'Pull out to the ' + side + ', stay there and brake later into ' + T1 + '.' };
      case 'outside': return { label: 'Round the outside', sub: 'Follow it in, then carry more speed on a wider line through ' + T1 + '.' };
      case 'follow': return { label: 'Follow it through, pass later', sub: 'Tuck in behind through the corner and use the straight after it.' };
      case 'hold': return { label: 'Hold your line', sub: 'Normal line, normal braking point. Let it choose where to pass.' };
      case 'letby': return pb
        ? { label: 'Point it by, ease off', sub: 'Point it by on the ' + side + ' and lift, staying on your line.' }
        : { label: 'Ease off, stay on your line', sub: 'Lift on the straight so it can get by before the braking zone.' };
      case 'room': return { label: 'Leave room on the inside', sub: 'Brake a little early and turn in late, behind it.' };
      case 'across': return { label: 'Move ' + side + ' to let it by', sub: 'Move off your line on the straight and ease off.' };
      case 'brakeMove': return { label: 'Move over under braking', sub: 'Brake, then move ' + side + ' so it can go round the outside.' };
      case 'defend': return { label: 'Cover the inside', sub: 'Move ' + side + ' before the braking zone and defend.' };
    }
    return { label: id, sub: '' };
  }

  /** Short verdict for a card, and its colour. */
  /*
   * Grades. The best call (fastest for you, no risk, allowed) gets full credit; a safe,
   * allowed answer close behind it still earns most of it, a slower safe one some.
   * Holding the faster car up where the rules say let it by, and anything risky, earn
   * little or nothing.
   */
  const CLOSE = 0.15; // s off the best call that still counts as a good call
  const GRADES = {
    best: { credit: 1, title: 'Responsible call' },
    close: { credit: 0.75, title: 'Good call' },
    safe: { credit: 0.4, title: 'Safe, but slow' },
    held: { credit: 0.25, title: 'Holds it up' },
    risky: { credit: 0, title: 'Not the call' },
  };
  function gradeOf(o) {
    if (o.correct) return 'best';
    if (!o.ok) return 'risky';
    if (o.held) return 'held';
    return o.cost <= CLOSE ? 'close' : 'safe';
  }

  function tagOf(o) {
    if (o.correct) return { text: 'Responsible', color: COL.good, kind: 'ok' };
    if (o.grade === 'close') return { text: 'Good call ' + sec(o.cost), color: COL.good, kind: 'near' };
    if (o.risk.level === 'contact') return { text: 'Contact', color: COL.bad, kind: 'contact' };
    if (o.offline) return { text: 'Unpredictable', color: COL.warn, kind: 'offline' };
    if (o.legal === false) return { text: 'Not allowed', color: COL.warn, kind: 'illegal' };
    if (o.risk.level === 'tight') return o.risk.why === 'squeeze' ? { text: 'Squeezed', color: COL.warn, kind: 'squeeze' } : o.risk.why === 'cut' ? { text: 'Cut across', color: COL.warn, kind: 'cut' } : { text: 'Hard braking', color: COL.warn, kind: 'hard' };
    if (o.held) return { text: 'Holds it up', color: COL.warn, kind: 'held' };
    return { text: 'Slower ' + sec(o.cost), color: COL.lilac, kind: 'slower' };
  }

  function explain(q, o) {
    const X = q.X, rk = o.risk, fast = q.role === 'fast';
    const where = (s) => TL.where(X, s);
    const me = q.me, other = fast ? 'the GT' : 'the prototype', Other = fast ? 'The GT' : 'The prototype';
    let risk = '';
    if (rk.level === 'contact') risk = 'Contact ' + where(rk.s) + (rk.gap < 0.1 ? ': the cars touch.' : ': only ' + rk.gap.toFixed(1) + ' m between the cars.');
    else if (rk.why === 'squeeze') risk = 'Squeezed ' + where(rk.s) + ': only ' + rk.gap.toFixed(1) + ' m between the cars.';
    else if (rk.why === 'cut') {
      const room = rk.clear < 1 ? 'with no room' : m1(rk.clear) + ' m in front';
      risk = rk.ahead === me ? 'You moved across ' + room + ' of ' + other + ' ' + where(rk.s) + ': it had to brake.' : Other + ' cut across ' + room + ' of you ' + where(rk.s) + ': you had to brake.';
    } else if (rk.why === 'hard') risk = (rk.who === me ? 'You' : Other) + ' had to brake harder than the car can ' + where(rk.s) + '.';
    if (fast) {
      if (o.legal === false) return 'Not allowed under point-by rules: passes only on a straight, when pointed by.' + (risk ? ' ' + risk : '');
      if (risk) return risk;
      const pass = o.r.pass ? 'Past ' + where(o.r.pass.s) : 'Stays behind it to the end of the straight';
      return pass + ', ' + sec(o.loss) + ' on a clear run' + (o.correct ? '. The fastest call with no risk.' : o.cost <= CLOSE ? ': safe, and only ' + o.cost.toFixed(2) + ' s off the best call.' : ': ' + sec(o.cost) + ' slower than the best call.');
    }
    if (o.offline) {
      const why = o.id === 'brakeMove' ? 'Moving off your line under braking: the prototype can\'t predict it.' : o.id === 'defend' ? 'Defending against a faster class is a move it can\'t predict, and it costs you.' : 'Moving off your line on the straight: the prototype can\'t know which side to take.';
      return why + (rk.level === 'contact' ? ' ' + risk : '');
    }
    if (risk) return (o.id === 'hold' && rk.level === 'contact' ? 'It was alongside: holding your line turns in on it. ' : '') + risk;
    const pass = o.r.pass ? 'It passes ' + where(o.r.pass.s) : 'It stays behind you';
    if (o.held) return pass + ' but you hold it up ' + o.other.toFixed(2) + ' s: under ' + TL.RULES[q.rules].name.toLowerCase() + ' rules you must let it by.';
    return pass + '; you lose ' + Math.max(0, o.loss).toFixed(2) + ' s' + (o.correct ? '. The least it can cost you, safely.' : o.cost <= CLOSE ? ': safe, and only ' + o.cost.toFixed(2) + ' s more than the best call.' : ', ' + o.cost.toFixed(2) + ' s more than the best call.');
  }

  Object.assign(MC, {
    COL, BUDGET, LEADUP, DECIDE_HOLD, HOLD, REVEAL, PREF, RULE_IDS, EV, PRIO, SITS, SIT_ORDER, OPT_LABELS, OPT_ORDER,
    kmh, sec, m1, shuffle, optText, CLOSE, GRADES, gradeOf, tagOf, explain,
  });
})();
