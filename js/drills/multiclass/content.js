/*
 * Class Traffic: palette, timings, labels, and the words and grade for
 * each option, plus the spotter-style briefing for each situation. Plain
 * data and text, no drawing or state.
 *
 * Files in js/drills/multiclass/ load in this order and share the drill's
 * private namespace IST.Multiclass:
 *   content.js  this file
 *   ui.js       this drill's own widgets (verdict glyph and chip) on top of IST.CanvasUI
 *   replay.js   replay timeline: events, interpolation, stepping
 *   scene.js    the top-down map, the in-car view (mirror, relative box) and the approach strip
 *   screens.js  rule picker, quiz and replay screens
 *   stats.js    coach tips and the Stats page breakdowns
 *   drill.js    the drill definition, session state, input and results
 */
(function () {
  'use strict';
  const TL = IST.TrafficLab;
  const MC = (IST.Multiclass = {});
  // the app's palette (IST.Theme), plus what each colour means in this drill
  const TH = IST.Theme;
  const COL = Object.assign({}, TH, {
    quiz: TH.gold, fast: TH.sky, slow: TH.peach, good: TH.mint, warn: TH.butter, bad: TH.rose,
    gt2: '#e7b8d8', limp: '#b9bfca', // a second GT, and a GT limping to the pits
  });
  const BUDGET = 8; // ms per frame spent building the next question
  const LEADUP = 2.2, DECIDE_HOLD = 1.6; // s of looped run-up to the decision frame, and the hold on it
  const HOLD = 1900; // ms paused at each event in the replay
  const REVEAL = 1500;
  const PREF = 'multiclass.rules';
  const RULE_IDS = ['hold', 'yield', 'pointby'];

  const EV = {
    close: { label: 'Closing', color: TH.lilac },
    brake: { label: 'Braking', color: TH.peach },
    turnin: { label: 'GT turns in', color: TH.butter },
    apex: { label: 'Apex', color: TH.sky },
    pass: { label: 'Pass complete', color: TH.mint },
    contact: { label: 'Contact', color: TH.rose },
    squeeze: { label: 'Squeezed', color: TH.butter },
    cut: { label: 'Cut across', color: TH.butter },
    hard: { label: 'Hard braking', color: TH.butter },
    exit: { label: 'Track-out', color: TH.lilac },
    end: { label: 'End of the straight', color: TH.text },
  };
  const PRIO = { contact: 9, squeeze: 8, cut: 8, hard: 7, pass: 6, turnin: 5, brake: 4, apex: 3, close: 2, exit: 2, end: 10 };

  const SITS = {
    'f-straight': 'Faster car: the pass on the straight is on',
    'f-dive': 'Faster car: out-brake it',
    'f-outside': 'Faster car: round the outside',
    'f-follow': 'Faster car: wait for the exit',
    'f-late': 'Faster car: you noticed late',
    'f-pair': 'Faster car: two GTs fighting',
    's-clear': 'Slower car: it\'ll clear before braking',
    's-committed': 'Slower car: it\'ll be alongside into the corner',
    's-behind': 'Slower car: stuck behind you',
    's-marginal': 'Slower car: it\'s lining up a late dive',
    's-late': 'Slower car: you noticed late',
    's-traffic': 'Slower car: catching a slow car, prototype behind',
  };
  const SIT_ORDER = Object.keys(SITS);
  const OPT_LABELS = {
    straight: 'Pass on the straight', dive: 'Out-brake on the inside', outside: 'Round the outside', follow: 'Slow in, pass on the exit',
    hold: 'Hold your line', letby: 'Ease off, let it by', room: 'Leave room', across: 'Move across', early: 'Brake early to let it by', defend: 'Cover the inside early',
    overtake: 'Pass the slow car now', after: 'Let the prototype by, then pass',
    brakeMove: 'Move over under braking', // no longer offered; kept so old sessions still read in Stats
  };
  const OPT_ORDER = TL.FAST.concat(TL.SLOW, ['overtake', 'after', 'brakeMove']);

  const kmh = IST.util.kmh, sec = IST.util.signedSec;
  const m1 = (x) => (Math.abs(x) < 9.95 ? Math.abs(x).toFixed(1) : String(Math.round(Math.abs(x))));
  const r10 = (x) => Math.round(x / 10) * 10;

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
      case 'straight': return { label: q.variant === 'pair' ? 'Pass both on the straight' : 'Pass on the straight', sub: 'Pull out now, get clear and back on the racing line before braking.' };
      case 'dive': return { label: 'Out-brake it on the inside', sub: 'Commit to the ' + side + ' now, stay there and brake later into ' + T1 + '.' };
      case 'outside': return { label: 'Round the outside', sub: 'Follow it in, then carry more speed on a wider line through ' + T1 + ', leaving it room.' };
      case 'follow': return { label: 'Slow in, pass on the exit', sub: 'Lift early, tuck in behind through ' + T1 + ' and get it on the way out.' };
      case 'hold': return q.variant === 'traffic'
        ? { label: 'Stay behind the slow car', sub: 'Follow it on your line to ' + T1 + ' and pass it later.' }
        : { label: 'Hold your line', sub: 'Normal line, normal braking point. Let it choose where to pass.' };
      case 'letby': return pb
        ? { label: 'Point it by, ease off', sub: 'Point it by on the ' + side + ' and lift, staying on your line.' }
        : { label: 'Ease off, stay on your line', sub: 'Lift on the straight so it can get by before the braking zone.' };
      case 'room': return { label: 'Leave room on the inside', sub: 'Brake a little early and turn in late, behind it.' };
      case 'across': return { label: 'Move ' + side + ' to let it by', sub: 'Move off your line on the straight and ease off.' };
      case 'early': return { label: 'Brake early to let it by', sub: 'Brake well before your normal point so it can get past into ' + T1 + '.' };
      case 'defend': return { label: 'Cover the inside early', sub: 'One move ' + side + ' before the braking zone, then brake in a straight line and turn in from there.' };
      case 'overtake': return { label: 'Pass the slow car now', sub: 'Pull out to the ' + side + ' and get past it before the braking zone.' };
      case 'after': return { label: 'Let the prototype by, then pass', sub: 'Wait behind the slow car until the prototype is through, then pull out.' };
    }
    return { label: id, sub: '' };
  }

  // ------------------------------------------------------------- briefing
  const CAUSES = {
    radio: 'Your engineer was on the radio about fuel.',
    dash: 'You were changing brake bias.',
    fight: 'You were watching the GT you\'re racing.',
    mind: 'Your mind wandered on the long straight.',
  };
  const cornerName = (q) => q.spec.name.toLowerCase() + ', ' + q.side;

  /**
   * The situation in words, the way a spotter would call it, plus the few numbers
   * it rests on. The decisive fact is where the prototype reaches the GT if both
   * hold their pace, against the GT's braking board.
   */
  function brief(q) {
    const X = q.X, fast = q.role === 'fast', c = q.catch;
    const gapS = (q.gap + TL.CARLEN) / q.vF0, dv = kmh(q.vF0 - q.vS0);
    const bd = Math.round(X.bF - X.bS);
    let reach, reachV, reachS;
    if (!c) {
      reach = fast ? 'At this pace you won\'t reach it before ' + 'T1.' : 'At this pace it won\'t reach you before T1.';
      reachV = 'Not before T1';
      reachS = '';
    } else if (c.t < 0.4) {
      reach = fast ? 'You\'re already on its gearbox.' : 'It\'s already on your gearbox.';
      reachV = 'Now';
      reachS = 'on the gearbox';
    } else if (c.toBrake > 30) {
      reach = (fast ? 'You reach it' : 'It reaches you') + ' about ' + r10(c.toBrake) + ' m before ' + (fast ? 'its' : 'your') + ' braking board.';
      reachV = r10(c.toBrake) + ' m';
      reachS = 'before the board';
    } else if (c.toBrake > -30) {
      reach = (fast ? 'You reach it' : 'It reaches you') + ' right at the braking board.';
      reachV = 'At the board';
      reachS = 'braking side by side';
    } else {
      reach = (fast ? 'You only reach it' : 'It only reaches you') + ' in the braking zone.';
      reachV = 'Braking zone';
      reachS = r10(-c.toBrake) + ' m in';
    }
    const T1 = 'T1 (' + cornerName(q) + ')';
    let call;
    const tiles = [];
    if (fast) {
      const e = q.extra && q.extra[0];
      call = (q.variant === 'pair'
        ? 'Two GTs nose to tail, ' + ((e.ds - TL.CARLEN) / q.vS0).toFixed(1) + ' s apart, racing each other. The rear one is ' + gapS.toFixed(1) + ' s ahead of you'
        : 'GT ' + gapS.toFixed(1) + ' s ahead') + ', and you\'re ' + dv + ' km/h quicker. ' + reach + ' Into ' + T1 + ' you brake ' + (Math.abs(bd) < 10 ? 'at about the same point.' : Math.abs(bd) + ' m ' + (bd > 0 ? 'later.' : 'earlier.'));
      tiles.push({ k: 'GAP AHEAD', v: Math.round(q.gap) + ' m', s: gapS.toFixed(2) + ' s' });
      tiles.push({ k: 'CLOSING', v: '+' + dv, s: 'km/h' });
      tiles.push({ k: 'YOU REACH IT', v: reachV, s: reachS });
      if (q.variant === 'pair') tiles.push({ k: 'GT AHEAD OF IT', v: ((e.ds - TL.CARLEN) / q.vS0).toFixed(1) + ' s', s: 'fighting' });
      else tiles.push({ k: 'YOU BRAKE', v: Math.abs(bd) < 10 ? 'Same' : Math.abs(bd) + ' m', s: Math.abs(bd) < 10 ? 'point' : bd > 0 ? 'later' : 'earlier' });
    } else {
      const mirror = q.type === 'behind' ? 'It\'s right behind you.' : q.type === 'marginal' ? 'It\'s right behind you, lining up the inside.' : 'It has pulled out to your ' + q.side + '.';
      let lead = '';
      if (q.variant === 'traffic') {
        const e = q.extra[0], vx = TL.vAt(e.plan, e.s0), gx = e.ds - TL.CARLEN;
        lead = 'A GT is limping to the pits ' + Math.round(gx) + ' m ahead, ' + kmh(q.vS0 - vx) + ' km/h slower than you. ';
        tiles.push({ k: 'SLOW CAR', v: Math.round(gx) + ' m', s: '−' + kmh(q.vS0 - vx) + ' km/h' });
      }
      call = lead + 'Prototype ' + gapS.toFixed(1) + ' s behind, closing ' + dv + ' km/h. ' + mirror + ' ' + reach.replace('your braking board', 'your braking board for ' + T1);
      tiles.unshift({ k: 'GAP BEHIND', v: Math.round(q.gap) + ' m', s: gapS.toFixed(2) + ' s' }, { k: 'CLOSING', v: '+' + dv, s: 'km/h' });
      tiles.push({ k: 'IT REACHES YOU', v: reachV, s: reachS });
      if (q.variant !== 'traffic') tiles.push(q.type === 'behind' ? { k: 'MIRROR', v: 'Behind', s: 'on your line' } : q.type === 'marginal' ? { k: 'MIRROR', v: 'Behind', s: 'eyeing the ' + q.side } : { k: 'MIRROR', v: 'Pulled out', s: 'to your ' + q.side });
    }
    if (q.variant === 'late') call = CAUSES[q.cause] + ' You\'ve only just seen it. ' + call;
    return { call, tiles: tiles.slice(0, 4), late: q.variant === 'late' };
  }

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
    // a defensive move nobody needed isn't a good call, however little it costs
    return o.cost <= CLOSE && o.id !== 'defend' ? 'close' : 'safe';
  }

  /** Short verdict for a card, its colour and its glyph. */
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

  /** What a car is called in the explanations, from your seat. */
  function nameOf(q, id) {
    if (id === q.me) return 'you';
    if (id === 'F') return 'the prototype';
    if (id === 'S') return 'the GT';
    return q.variant === 'traffic' ? 'the slow car' : 'the other GT';
  }
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

  function explain(q, o) {
    const X = q.X, rk = o.risk, fast = q.role === 'fast';
    const where = (s) => TL.where(X, s);
    const me = q.me;
    let risk = '';
    if (rk.level === 'contact') {
      const who = rk.who || [], w = who.find((id) => id !== 'F' && id !== 'S');
      const gapT = rk.gap < 0.1 ? ': the cars touch.' : ': only ' + rk.gap.toFixed(1) + ' m between the cars.';
      // two other cars touching is still down to your move, but it isn't your car in the contact
      risk = who.length && who.indexOf(me) < 0
        ? cap(nameOf(q, who[0])) + ' and ' + nameOf(q, who[1]) + ' make contact ' + where(rk.s) + gapT
        : 'Contact ' + (w ? 'with ' + nameOf(q, w) + ' ' : '') + where(rk.s) + gapT;
    } else if (rk.why === 'squeeze') risk = 'Squeezed ' + where(rk.s) + ': only ' + rk.gap.toFixed(1) + ' m between the cars.';
    else if (rk.why === 'cut') {
      const room = rk.clear < 1 ? 'with no room' : m1(rk.clear) + ' m in front';
      const mover = rk.mover || rk.ahead, behind = rk.behind;
      const turnedIn = mover === me && (o.id === 'hold' || o.id === 'room') && /turn-in|apex/.test(where(rk.s));
      risk = turnedIn
        ? 'It had dived up the inside: turning in on your line cut across it ' + where(rk.s) + ' and it had to brake.'
        : mover === me
        ? 'You moved across ' + room + ' of ' + (behind ? nameOf(q, behind) : fast ? 'the GT' : 'the prototype') + ' ' + where(rk.s) + ': it had to brake.'
        : cap(nameOf(q, mover)) + ' cut across ' + room + ' of ' + (behind ? nameOf(q, behind) : 'you') + ' ' + where(rk.s) + ': ' + (behind && behind !== me ? 'it' : 'you') + ' had to brake.';
    } else if (rk.why === 'hard') risk = (rk.who === me ? 'You' : rk.who === 'X' ? cap(nameOf(q, 'X0')) : cap(nameOf(q, rk.who))) + ' had to brake harder than the car can ' + where(rk.s) + '.';
    if (fast) {
      if (o.legal === false) return 'Not allowed under point-by rules: passes only on a straight, when pointed by.' + (risk ? ' ' + risk : '');
      if (risk) return risk;
      const p = q.variant === 'pair' ? o.r.passAll : o.r.pass;
      const pass = p ? 'Past ' + (q.variant === 'pair' ? 'both ' : '') + where(p.s) : 'Stays behind to the end of the straight';
      return pass + ', ' + sec(o.loss) + ' on a clear run' + (o.correct ? '. The fastest call with no risk.' : o.cost <= CLOSE ? ': safe, and only ' + o.cost.toFixed(2) + ' s off the best call.' : ': ' + sec(o.cost) + ' slower than the best call.');
    }
    if (o.offline) {
      const why = o.id === 'early' ? 'Braking early where the prototype expects you at full speed: it can\'t predict it.'
        : o.id === 'defend' ? 'It has already pulled out to that side: covering now moves you into its path.'
        : 'Moving off your line on the straight: the prototype can\'t know which side to take.';
      return why + (rk.level !== 'safe' ? ' ' + risk : '');
    }
    if (risk) return (o.id === 'hold' && rk.level === 'contact' && q.variant !== 'traffic' ? 'It was alongside: holding your line turns in on it. ' : '') + risk;
    if (o.id === 'defend' && o.correct) return 'One early move, before braking: it sees the inside is shut and waits for the exit. ' + (o.r.pass ? 'It passes ' + where(o.r.pass.s) : 'It stays behind you') + '; you lose only ' + Math.max(0, o.loss).toFixed(2) + ' s.';
    const pass = o.r.pass ? 'It passes ' + where(o.r.pass.s) : 'It stays behind you';
    if (o.held) return pass + ' but you hold it up ' + o.other.toFixed(2) + ' s: under ' + TL.RULES[q.rules].name.toLowerCase() + ' rules you must let it by.';
    return pass + '; you lose ' + Math.max(0, o.loss).toFixed(2) + ' s' + (o.correct ? '. The least it can cost you, safely.' : o.cost <= CLOSE ? ': safe, and only ' + o.cost.toFixed(2) + ' s more than the best call.' : ', ' + o.cost.toFixed(2) + ' s more than the best call.');
  }

  Object.assign(MC, {
    COL, BUDGET, LEADUP, DECIDE_HOLD, HOLD, REVEAL, PREF, RULE_IDS, EV, PRIO, SITS, SIT_ORDER, OPT_LABELS, OPT_ORDER,
    kmh, sec, m1, shuffle, optText, brief, CLOSE, GRADES, gradeOf, tagOf, explain,
  });
})();
