/*
 * Traffic Lab: a faster and a slower class car through one corner complex.
 *
 *   TL.cars(rnd)                          jittered prototype + GT models
 *   TL.setup(geo, ideal, cars)            free runs, brake points, key positions
 *   TL.fastPath(ctx, id, pull, sF0)       prototype path for an option ('straight' | 'dive' | 'outside' | 'follow')
 *   TL.slowPath(ctx, id, sS0)             GT path for an option ('hold' | 'letby' | 'room' | 'across' | 'brakeMove' | 'defend')
 *   TL.run(ctx, F, S, o)                  both cars stepped together at 60 Hz -> trajectories, contact, gaps, losses
 *   TL.risk(r)                            'safe' | 'tight' | 'contact' (+ where and why)
 *
 * Each car follows a fixed path (lateral position along the track) at the
 * speed IST.LineLab's lap-time model gives for its own car on that path,
 * except that it can't drive through the car ahead: in the same lane it
 * follows with the Intelligent Driver Model's gap rule (2 m + 0.25 s, more
 * when closing) and brakes harder than 4 m/s^2 only if it must. Nothing else reacts, so
 * an option's outcome shows what happens if you commit to it while the
 * other car does what it set out to do.
 *
 * Risk: bodies (4.8 x 2.0 m) less than 0.25 m apart while side by side is
 * contact; less than 0.9 m, a car moving into the other's lane with less
 * room than lets the car behind settle without braking harder than 4 m/s^2,
 * or a car needing more than its full braking, is "tight". Neither counts as a responsible choice.
 */
(function () {
  'use strict';
  const U = IST.util, LL = IST.LineLab;
  const HW = LL.HW, DS = LL.DS, NMAX = LL.NMAX;
  const CARLEN = 4.8, CARW = 2.0;
  const DT = 1 / 60, T_MAX = 45;
  const CONTACT = 0.25, TIGHT = 0.9;
  const LANE = CARW + 0.5; // centre-to-centre lateral distance below which cars share a lane
  const PASS = 3.3 / HW; // passing lane: 3.3 m inside the car being passed (1.3 m between bodies)
  // a prototype has the aero to brake and corner harder than Pick the Line's car; the GT has less of both and less power
  const PROTO = Object.assign({}, LL.CAR, { aLat: 14.5, aBrake: 17, vIn: 70, name: 'Prototype' });
  const GT = { aLat: 11.8, aBrake: 12.2, aTrac: 7.8, power: 250, drag: 0.0008, vMax: 82, vIn: 61, name: 'GT' };

  const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const ramp = (s, a, b) => (b <= a ? (s >= b ? 1 : 0) : smoother(U.clamp((s - a) / (b - a), 0, 1)));
  const bump = (s, a, b, c, d) => Math.min(ramp(s, a, b), 1 - ramp(s, c, d));
  const smax = (a, b) => (a + b + Math.sqrt((a - b) * (a - b) + 0.0036)) / 2;
  const smin = (a, b) => (a + b - Math.sqrt((a - b) * (a - b) + 0.0036)) / 2;
  const want = (v) => 2 + 0.25 * v; // m of clear road a following car keeps (~0.3 s at speed)
  /*
   * Car following, after the Intelligent Driver Model's interaction term
   * (Treiber, Hennecke & Helbing, 2000) with a kinematic closing term: the
   * gap wanted grows by the distance needed to match speeds at 4 m/s^2, so a
   * faster car pulling in ahead needs no reaction and a slower one moving
   * across in front does. Returns the acceleration it asks for.
   */
  const IDM_A = 5, IDM_B = 4;
  const gapWanted = (v, close) => Math.max(2, want(v) + (Math.sign(close) * close * close) / (2 * IDM_B));
  /** Outside the wanted gap the car's own acceleration fades in as it closes; inside it, it brakes. */
  const follow = (v, close, g, accFree) => {
    const r2 = Math.pow(gapWanted(v, close) / Math.max(0.1, g), 2);
    return r2 < 1 ? Math.max(0, accFree) * (1 - r2) : -IDM_A * (r2 - 1);
  };
  /** Room (m) the car behind needs so it never has to brake harder than IDM_B. */
  const roomNeeded = (v, close) => gapWanted(v, close) / Math.sqrt(1 + IDM_B / IDM_A);
  /** Smallest gap (m, bumper to bumper) at which a car closing at dv on one at v needn't brake yet. */
  const minStartGap = (v, dv) => gapWanted(v, dv) + 2;
  const moveLen = (v) => U.clamp(1.6 * v, 45, 140); // m to move one lane across (~1.6 s, < 5 m/s^2 sideways)


  /** Prototype and GT with a little variety in the speed gap. */
  function cars(rnd) {
    const j = (a, b) => (rnd ? U.lerp(a, b, rnd()) : 1);
    const pf = j(0.94, 1.06), gf = j(0.9, 1.08), grip = j(0.97, 1.03);
    return {
      fast: Object.assign({}, PROTO, { power: PROTO.power * pf }),
      slow: Object.assign({}, GT, { power: GT.power * gf, aLat: GT.aLat * grip, vIn: GT.vIn * Math.cbrt(gf) }),
    };
  }

  function shape(geo, f) {
    const out = new Float64Array(geo.N + 1);
    for (let i = 0; i <= geo.N; i++) out[i] = U.clamp(f(i * DS, i), -NMAX, NMAX);
    return out;
  }

  /** A car on a path: free speed profile from the lap-time model, plus its phases. */
  function plan(geo, car, n, id) {
    const sim = LL.simulate(geo, n, { full: true, car, vIn: car.vIn });
    // centreline metres per metre driven: positions are compared along the centreline
    const r = new Float64Array(sim.iStop + 1);
    for (let i = 0; i < sim.iStop; i++) r[i] = DS / Math.max(1e-6, Math.hypot(sim.px[i + 1] - sim.px[i], sim.py[i + 1] - sim.py[i]));
    r[sim.iStop] = r[sim.iStop - 1];
    sim.r = r;
    const L = { id, car, n, sim };
    L.ph = LL.phases(geo, L);
    return L;
  }

  const vAt = (p, s) => LL.sampleAt(p.sim.v, p.sim, s);
  const kAt = (p, s) => LL.sampleAt(p.sim.k, p.sim, s);
  const rAt = (p, s) => LL.sampleAt(p.sim.r, p.sim, s);
  const latAt = (p, s) => LL.sampleN(p.n, U.clamp(s, 0, p.sim.iStop * DS), p.sim.iStop) * HW;

  function brakeOf(L, ci) {
    const b = L.ph.find((p) => p.kind === 'brake' && p.ci === ci);
    return b ? b.s : L.corners[ci].ti * DS - 30;
  }

  /** Key positions for a complex: both cars' free runs on the ideal line, brake points, turn-in, apex, track-out. */
  function setup(geo, ideal, cs) {
    const F = plan(geo, cs.fast, ideal.n, 'free'), S = plan(geo, cs.slow, ideal.n, 'free');
    const C = geo.corners, last = C.length - 1;
    const fi = F.corners[0], si = S.corners[0], fl = F.corners[last];
    return {
      geo, ideal, cars: cs, freeF: F, freeS: S, dir: C[0].dir, dirLast: C[last].dir,
      bF: brakeOf(F, 0), bS: brakeOf(S, 0),
      tiS: si.ti * DS, apF: fi.ia * DS, apS: si.ia * DS,
      tiF: fi.ti * DS, toF: fi.to != null ? fi.to * DS : fi.ia * DS + 45,
      outF: fl.to != null ? fl.to * DS : fl.ia * DS + 50,
      cache: {},
    };
  }

  // ------------------------------------------------------------------ paths
  /**
   * Prototype paths. pull = [a, b]: where it moves out to the passing lane
   * (before the decision point in the slower car's questions, so the mirror
   * shows which side it has chosen).
   */
  function fastPath(X, id, pull) {
    const geo = X.geo, nI = X.ideal.n, d = X.dir;
    const back1 = X.bF - 10, back0 = back1 - moveLen(vAt(X.freeF, back1));
    const key = id + ':' + (pull ? pull[0].toFixed(1) : '');
    if (X.cache[key]) return X.cache[key];
    let n;
    if (id === 'straight') n = shape(geo, (s, i) => nI[i] + d * PASS * bump(s, pull[0], pull[1], back0, back1));
    else if (id === 'dive') {
      n = shape(geo, (s, i) => {
        const lane = nI[i] + d * PASS * ramp(s, pull[0], pull[1]);
        const tgt = U.lerp(lane, d * 0.35, ramp(s, back0, X.bF));
        const m = d * smax(d * tgt, d * nI[i]);
        return U.lerp(m, nI[i], ramp(s, X.apF - 4, X.apF + 6));
      });
    } else if (id === 'outside') {
      const w0 = X.tiF, w1 = X.tiF + 0.5 * (X.apF - X.tiF), w2 = X.apF + 0.3 * (X.toF - X.apF), w3 = X.toF;
      n = shape(geo, (s, i) => U.lerp(nI[i], d * smin(d * nI[i], 0), bump(s, w0, w1, w2, w3)));
    } else {
      const dl = X.dirLast, a = X.outF + 10;
      // the car is still accelerating out of the corner: size the move for the speed it will have
      n = shape(geo, (s, i) => nI[i] + dl * PASS * ramp(s, a, a + moveLen(vAt(X.freeF, a + 120))));
    }
    return (X.cache[key] = plan(geo, X.cars.fast, n, id));
  }

  /** GT paths for the slower car's options (lift is applied in run()). */
  function slowPath(X, id, sS0) {
    const geo = X.geo, nI = X.ideal.n, d = X.dir, c0 = geo.corners[0];
    const key = 'gt:' + id + ':' + sS0.toFixed(1);
    if (X.cache[key]) return X.cache[key];
    let n = nI;
    const insideFrom = (tgt) => shape(geo, (s, i) => U.lerp(d * smax(d * tgt(s, i), d * nI[i]), nI[i], ramp(s, X.apS - 4, X.apS + 6)));
    const L = moveLen(vAt(X.freeS, sS0));
    if (id === 'room') {
      // wait on the outside: turn in ~15 m late (Pick the Line's late turn-in) and give up the kerb at the apex
      const IL = X.idealL || (X.idealL = LL.lineFrom(geo, nI, null, {}));
      const late = LL.applyFlaw(geo, IL, 'late', 0, 0.45) || nI;
      n = shape(geo, (s, i) => U.lerp(late[i], d * smin(d * late[i], 0.6), bump(s, c0.startPos - 30, c0.startPos, c0.endPos, c0.endPos + 30)));
    }
    else if (id === 'across') n = shape(geo, (s, i) => nI[i] + d * PASS * bump(s, sS0 + 5, sS0 + 5 + L, X.bS - 30 - L, X.bS - 30));
    else if (id === 'brakeMove') n = insideFrom((s, i) => U.lerp(nI[i], d * 0.45, ramp(s, X.bS, X.bS + 45)));
    else if (id === 'defend') n = insideFrom((s, i) => U.lerp(nI[i] + d * 0.62 * ramp(s, sS0 + 5, sS0 + 5 + L), d * 0.3, ramp(s, X.bS - 50, X.bS)));
    return (X.cache[key] = plan(geo, X.cars.slow, n, id));
  }

  // -------------------------------------------------------------- two cars
  /**
   * F (faster car) and S (slower car): { plan, s0, lift?: {decel, maxT} }.
   * o.light skips the trajectory record (for searches).
   */
  function run(X, F, S, o) {
    o = o || {};
    const geo = X.geo, sEnd = geo.sEnd, stopAt = sEnd + 25;
    const mk = (x) => ({ p: x.plan, s0: x.s0, s: x.s0, v: vAt(x.plan, x.s0), lift: x.lift ? Object.assign({ on: true }, x.lift) : null, hard: null, finish: null });
    const cs = [mk(F), mk(S)];
    const rec = o.light ? null : { t: [], sF: [], vF: [], lF: [], sS: [], vS: [], lS: [] };
    const r = { contact: null, minGap: Infinity, minGapS: null, cut: null, pass: null, onset: null, dsTurn: null, alongside: 0 };
    let t = 0, prevLane = null, prevLat = null;
    for (let step = 0; t < T_MAX; step++) {
      const a = cs[0], b = cs[1];
      const lat = [latAt(a.p, a.s), latAt(b.p, b.s)];
      if (rec) {
        rec.t.push(t);
        rec.sF.push(a.s); rec.vF.push(a.v); rec.lF.push(lat[0]);
        rec.sS.push(b.s); rec.vS.push(b.v); rec.lS.push(lat[1]);
      }
      const ds = a.s - b.s, dl = Math.abs(lat[0] - lat[1]);
      // sharing a lane = the car in front is on the following car's path where it is now
      const ahead = ds >= 0 ? a : b, behind = ds >= 0 ? b : a;
      const lane = Math.abs(latAt(behind.p, ahead.s) - latAt(ahead.p, ahead.s)) < LANE;
      if (Math.abs(ds) < CARLEN && Math.min(a.s, b.s) < sEnd) {
        const gap = dl - CARW;
        r.alongside += DT;
        if (gap < r.minGap) {
          r.minGap = gap;
          r.minGapS = b.s;
        }
        if (gap < CONTACT && !r.contact) r.contact = { t, s: b.s, gap };
      }
      // lanes come together with the cars nose to tail: who moved, and was there room
      if (prevLane === false && lane && Math.min(a.s, b.s) < sEnd) {
        const g = Math.abs(ds) - CARLEN, need = roomNeeded(behind.v, behind.v - ahead.v);
        const moverF = prevLat ? Math.abs(lat[0] - prevLat[0]) > Math.abs(lat[1] - prevLat[1]) : true;
        // lead: room the faster car left in front of the slower one (negative = not past)
        const lead = ds >= 0 ? g - need : -g - CARLEN - need;
        const ev = { t, s: b.s, g, need, margin: g - need, lead, ahead: ds >= 0 ? 'F' : 'S', moverF };
        if (!r.onset) r.onset = ev;
        // a cut is the car in front moving across without room; the car behind tucking in is its own follow
        if (g >= 0 && ev.margin < 0 && (ev.ahead === 'F') === moverF && (!r.cut || ev.margin < r.cut.margin)) r.cut = ev;
      }
      if (!r.pass && ds >= CARLEN) r.pass = { t, s: b.s };
      if (r.dsTurn == null && b.s >= X.tiS) r.dsTurn = ds;
      prevLane = lane;
      prevLat = lat;
      if (a.s >= stopAt && b.s >= stopAt) break;

      // the car in front moves first, so the one behind reacts to its brake lights, not a frame late
      const next = [0, 0], lead = a.s >= b.s ? 0 : 1;
      for (const i of [lead, 1 - lead]) {
        const c = cs[i], d = cs[1 - i], car = c.p.car, dv = i === lead ? d.v : next[1 - i];
        const vd = vAt(c.p, c.s + c.v * rAt(c.p, c.s) * DT);
        const k = kAt(c.p, c.s), u = (c.v * c.v * Math.abs(k)) / car.aLat, ell = u < 1 ? Math.sqrt(1 - u * u) : 0;
        const acc = Math.min(car.aTrac, car.power / Math.max(c.v, 1)) * ell - car.drag * c.v * c.v;
        let cap = Math.min(vd, c.v + Math.max(0, acc) * DT);
        // lift / early braking: from c.lift.fromS (default at once) until the other car is clear ahead or maxT is up
        const lf = c.lift;
        if (lf && lf.on && c.s >= (lf.fromS || 0)) {
          if (lf.t0 == null) lf.t0 = t;
          if (t - lf.t0 > lf.maxT || d.s - c.s > CARLEN + 4) lf.on = false;
          else cap = Math.min(cap, c.v - lf.decel * DT);
        }
        const gap = d.s - c.s;
        if (gap > 0 && gap < 160 && lane && c.s < sEnd) {
          // brake lights: react to where the car in front's speed is heading over the next 0.4 s
          const vl = i === lead ? d.v : dv + ((dv - d.v) / DT) * 0.4;
          const fc = c.v + follow(c.v, c.v - vl, gap - CARLEN, acc) * DT;
          if (fc < cap) cap = fc;
        }
        const floor = c.v - (car.aBrake + car.drag * c.v * c.v) * DT * 1.1;
        // more than full braking: a frame or two is reaction, a real shortfall is a near miss
        if (cap < floor - 1e-6) {
          c.short = (c.short || 0) + (floor - cap);
          if (c.short > 1.5 && !c.hard && c.s < sEnd) c.hard = { t, s: c.s };
          cap = floor;
        } else c.short = Math.max(0, (c.short || 0) - 0.05);
        next[i] = Math.max(0, cap);
      }
      for (let i = 0; i < 2; i++) {
        const c = cs[i], s1 = c.s + ((c.v + next[i]) / 2) * rAt(c.p, c.s) * DT;
        if (c.finish == null && s1 >= sEnd) c.finish = t + (DT * (sEnd - c.s)) / Math.max(1e-6, s1 - c.s);
        c.s = s1;
        c.v = next[i];
      }
      t += DT;
    }
    const freeT = (p, s0) => LL.timeAt(p.sim, sEnd) - LL.timeAt(p.sim, s0);
    const fin = cs.map((c) => (c.finish != null ? c.finish : t));
    r.loss = [fin[0] - freeT(X.freeF, cs[0].s0), fin[1] - freeT(X.freeS, cs[1].s0)];
    r.finish = fin;
    r.hard = [cs[0].hard, cs[1].hard];
    r.T = t;
    if (rec) {
      r.rec = {};
      for (const k in rec) r.rec[k] = Float32Array.from(rec[k]);
      r.rec.n = rec.t.length;
    }
    return r;
  }

  /** How dangerous the outcome was, and where. */
  function risk(r) {
    if (r.contact) return { level: 'contact', why: 'contact', s: r.contact.s, gap: r.contact.gap };
    if (r.minGap < TIGHT) return { level: 'tight', why: 'squeeze', s: r.minGapS, gap: r.minGap };
    if (r.cut) return { level: 'tight', why: 'cut', s: r.cut.s, clear: r.cut.g, moverF: r.cut.moverF, ahead: r.cut.ahead };
    const h = r.hard[0] || r.hard[1];
    if (h) return { level: 'tight', why: 'hard', s: h.s, who: r.hard[0] ? 'F' : 'S' };
    return { level: 'safe' };
  }

  /** Where on the complex a position is, in words (relative to the slower car's first corner). */
  function where(X, s) {
    const C = X.geo.corners;
    if (s < X.bS - 15) return 'on the straight';
    if (s < X.tiS - 3) return 'in the braking zone';
    for (let ci = 0; ci < C.length; ci++) {
      const c = C[ci], T = 'T' + (ci + 1);
      if (s < c.startPos + 0.25 * (c.endPos - c.startPos) && (ci === 0 || s > C[ci - 1].endPos)) return 'at ' + T + ' turn-in';
      if (s < c.startPos + 0.7 * (c.endPos - c.startPos)) return 'at the ' + T + ' apex';
      if (s < c.endPos + 25) return 'on the ' + T + ' exit';
    }
    return 'on the straight after';
  }

  // ============================================================ questions
  /** dir +1 = right-hander; each is mirrored at random. Long approaches: passes take a few hundred metres. */
  const SCENARIOS = [
    { id: 'hairpin', name: 'Hairpin', items: [['s', 1000], ['c', 1, 16, 175], ['s', 450]], lv: 1 },
    { id: 'ninety', name: 'Right angle', items: [['s', 1000], ['c', 1, 32, 90], ['s', 450]], lv: 1 },
    { id: 'tighten', name: 'Tightening corner', items: [['s', 980], ['c', 1, 55, 120, 'tighten'], ['s', 420]], lv: 2 },
    { id: 'sweeper', name: 'Fast sweeper', items: [['s', 980], ['c', 1, 110, 70], ['s', 420]], lv: 2 },
    { id: 'chicane', name: 'Chicane', items: [['s', 1000], ['c', 1, 28, 50], ['s', 5], ['c', -1, 28, 55], ['s', 420]], lv: 3 },
    { id: 'double', name: 'Double apex', items: [['s', 980], ['c', 1, 45, 85], ['s', 25], ['c', 1, 32, 95], ['s', 450]], lv: 3 },
    { id: 'chute', name: 'Two corners, short chute', items: [['s', 1000], ['c', 1, 30, 90], ['s', 70], ['c', -1, 25, 90], ['s', 420]], lv: 4 },
  ];

  /**
   * Rule sets for blue flags and overtaking. Simplified styles, not any
   * series' wording. What changes between them is what the slower car owes
   * the faster one, and where the faster one may pass.
   */
  const RULES = {
    hold: {
      id: 'hold', name: 'Hold your line', short: 'Hold your line',
      text: 'Blue flags are information. The slower car stays predictable on its normal line and pace; the faster car picks where to pass and is responsible for a clean pass.',
      like: 'The usual expectation in multiclass endurance racing and most sim leagues.',
    },
    yield: {
      id: 'yield', name: 'Blue flag: give way', short: 'Give way',
      text: 'The slower car must let the faster one by at the first safe chance: ease off on a straight and stay on its line, not move across. Holding it up is an offence.',
      like: 'Closest to FIA-style blue flags for cars being lapped.',
    },
    pointby: {
      id: 'pointby', name: 'Point-by', short: 'Point-by',
      text: 'Passing only on straights and only after the slower car points the faster one by, to the side it should pass on. No passing in braking zones or corners.',
      like: 'Track days and novice run groups.',
    },
  };

  const FAST = ['straight', 'dive', 'outside', 'follow'];
  const SLOW = ['hold', 'letby', 'room', 'across', 'brakeMove', 'defend'];
  const OFFLINE = { across: 1, brakeMove: 1, defend: 1 }; // moving off the line where the faster car can't predict it
  const LIFT = { decel: 2.5, maxT: 3.5 };
  /** Pass lead bands (m of room left in front of the slower car when cutting back): smaller = closer call. */
  const BANDS = [null, [14, 40], [9, 28], [6, 19], [4, 13], [2, 8], [0.8, 5]];
  const MAX_LEVEL = BANDS.length - 1;
  const CLEAR = 0.05; // s the right answer must beat the next acceptable one by

  /**
   * Expensive part, shared by both roles: the complex and its line. The line
   * is solved on a copy with a short approach (same corners, so the same
   * line; much less straight to simulate on every step of the search), then
   * moved onto the long approach. Yields to spread the work over frames.
   */
  function* complexGen(spec, rnd) {
    const j = (a, b) => U.lerp(a, b, rnd());
    const items = spec.items.map((it, idx) => {
      if (it[0] === 's') return ['s', it[1] * (idx === 0 || idx === spec.items.length - 1 ? j(0.9, 1.1) : j(0.7, 1.3))];
      return ['c', it[1], it[2] * j(0.87, 1.13), Math.min(178, it[3] * j(0.93, 1.07)), it[4]];
    });
    const mirror = rnd() < 0.5;
    const geo = LL.build({ id: spec.id, items }, { mirror });
    const gs = LL.build({ id: spec.id, items: [['s', 260]].concat(items.slice(1)) }, { mirror });
    const L = yield* LL.solveGen(gs);
    const off = Math.round((geo.corners[0].startPos - gs.corners[0].startPos) / DS);
    const n = new Float64Array(geo.N + 1);
    for (let i = 0; i <= geo.N; i++) n[i] = L.n[U.clamp(i - off, 0, gs.N)];
    return { spec, geo, ideal: { n } };
  }

  function shuffle(a, rnd) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** Prototype plan with the pass lane taken before (already out, visible in the mirror) or after the decision. */
  function fastPlan(X, id, sF0, before) {
    const L = moveLen(vAt(X.freeF, sF0));
    return fastPath(X, id, before ? [Math.max(0, sF0 - L), sF0 - 4] : [sF0 + 5, sF0 + 5 + L]);
  }

  function* fastOutcomes(X, sF0, sS0, rules) {
    const hold = { plan: X.freeS, s0: sS0 }, out = [];
    for (const id of FAST) {
      const fp = fastPlan(X, id, sF0, false);
      const r = run(X, { plan: fp, s0: sF0 }, hold);
      const rk = risk(r);
      const legal = rules !== 'pointby' || id === 'straight' || id === 'follow';
      out.push({ id, r, plan: id, fp, sp: X.freeS, risk: rk, legal, loss: r.loss[0], other: r.loss[1], ok: rk.level === 'safe' && legal });
      yield;
    }
    return out;
  }

  function* slowOutcomes(X, sF0, sS0, rules, type) {
    const before = type !== 'behind';
    const base = type === 'clear' ? 'straight' : type === 'committed' ? 'dive' : 'follow';
    const replanSet = rules === 'pointby' ? ['straight', 'follow'] : FAST;
    const out = [];
    for (const id of SLOW) {
      const gtPlan = id === 'hold' || id === 'letby' ? X.freeS : slowPath(X, id, sS0);
      // leaving room = braking a little early so a car alongside clears, then a later turn-in
      const lift = id === 'letby' || id === 'across' ? LIFT : id === 'room' ? { decel: 4, maxT: 4, fromS: X.bS - 60 } : null;
      const S = { plan: gtPlan, s0: sS0, lift };
      let fp = fastPlan(X, base, sF0, before), plan = base;
      let r = run(X, { plan: fp, s0: sF0 }, S);
      if (id === 'letby') {
        // easing off on your line is a signal it can see: it takes the best safe pass that offers
        let best = null;
        for (const pid of replanSet) {
          const p2 = pid === base ? fp : fastPlan(X, pid, sF0, before && (pid === 'straight' || pid === 'dive'));
          const rr = pid === base ? r : run(X, { plan: p2, s0: sF0 }, S);
          if (risk(rr).level === 'safe' && (!best || rr.loss[0] < best.r.loss[0])) best = { r: rr, pid, p2 };
          yield;
        }
        if (best) {
          r = best.r;
          plan = best.pid;
          fp = best.p2;
        }
      }
      const rk = risk(r);
      out.push({ id, r, plan, fp, sp: gtPlan, risk: rk, offline: !!OFFLINE[id], loss: r.loss[1], other: r.loss[0], ok: rk.level === 'safe' && !OFFLINE[id] });
      yield;
    }
    return out;
  }

  /** Mark the responsible answer; null if there isn't a clear one. */
  function judge(q) {
    const O = q.opts;
    let acc = O.filter((o) => o.ok);
    if (!acc.length) return false;
    if (q.role === 'slow' && q.rules !== 'hold') {
      // must not hold the faster car up when a safe way to let it by exists
      const pMin = Math.min.apply(null, acc.map((o) => o.other));
      acc.forEach((o) => (o.held = o.other > pMin + 0.25));
      acc = acc.filter((o) => !o.held);
    }
    acc.sort((a, b) => a.loss - b.loss);
    if (acc.length > 1 && acc[1].loss - acc[0].loss < CLEAR) return false;
    acc[0].correct = true;
    q.best = acc[0];
    O.forEach((o) => (o.cost = o.correct ? 0 : Math.max(0, o.loss - acc[0].loss)));
    return true;
  }

  function sitOf(q) {
    return q.role === 'fast' ? 'f-' + q.best.id : 's-' + q.type;
  }

  /**
   * One question for `role` ('fast' | 'slow') under `rules`, tuned to `level`.
   * cx is a complexGen result (reused across tries). Returns null if no gap fits.
   */
  function* questionGen(cx, level, role, rules, rnd) {
    const X = setup(cx.geo, cx.ideal, cars(rnd));
    const band = BANDS[U.clamp(level, 1, MAX_LEVEL)];
    let type = 'fast';
    if (role === 'slow') {
      const w = rules === 'pointby' ? { behind: 1 } : rules === 'hold' ? { committed: 0.45, clear: 0.3, behind: 0.25 } : { committed: 0.3, clear: 0.25, behind: 0.45 };
      let x = rnd() * Object.values(w).reduce((a, b) => a + b, 0);
      for (const k in w) if ((x -= w[k]) <= 0 || k === 'behind') { type = k; break; }
    }
    const before = type === 'clear' || type === 'committed';
    // the pass on the straight is on (+) or not (−); + is the harder one to set up, so it gets first go a bit more often
    let sign = type === 'clear' ? 1 : type === 'committed' ? -1 : rnd() < 0.6 ? 1 : -1;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt && (type === 'fast' || type === 'behind')) sign = -sign;
      // decision point: a long run-up when the pass on the straight should be on
      const vF = vAt(X.freeF, X.bS - 500), vS = vAt(X.freeS, X.bS - 500);
      const gMin = before ? 6 : minStartGap(vS, vF - vS);
      const dMax = X.bS - 15 - moveLen(vF) - CARLEN - gMin - 40;
      if (dMax < 420) return null;
      const D = sign > 0 ? U.lerp(Math.max(420, dMax - 260), dMax, rnd()) : U.lerp(420, Math.min(dMax, 620), rnd());
      const sS0 = X.bS - D, vS0 = vAt(X.freeS, sS0), vF0 = vAt(X.freeF, sS0);
      // sweep the starting gap: how much room the pass on the straight leaves
      const cands = [];
      let k = 0;
      for (let g = gMin; g <= gMin + 90; g += 1.5) {
        const sF0 = sS0 - CARLEN - g;
        if (sF0 - moveLen(vF0) < 10) break;
        const S = { plan: X.freeS, s0: sS0, lift: type === 'behind' ? LIFT : null };
        const r = run(X, { plan: fastPlan(X, 'straight', sF0, before), s0: sF0 }, S, { light: true });
        const lead = r.onset ? r.onset.lead : r.pass ? 50 : -50;
        if (sign * lead >= band[0] && sign * lead <= band[1]) cands.push({ g, sF0, lead });
        if (++k % 4 === 0) yield;
      }
      shuffle(cands, rnd);
      for (const c of cands.slice(0, 3)) {
        const q = {
          spec: cx.spec, geo: cx.geo, X, role, rules, level, type,
          sS0, sF0: c.sF0, gap: c.g, lead: c.lead, vF0: vAt(X.freeF, c.sF0), vS0,
          side: X.dir > 0 ? 'right' : 'left',
        };
        q.opts = role === 'fast' ? yield* fastOutcomes(X, c.sF0, sS0, rules) : yield* slowOutcomes(X, c.sF0, sS0, rules, type);
        if (type === 'clear' && q.opts[0].risk.level !== 'safe') continue; // it must really be a clean pass if you hold
        if (type === 'committed' && q.opts[0].risk.level === 'safe') continue; // holding your line must not be enough
        if (!judge(q)) continue;
        q.sit = sitOf(q);
        return q;
      }
    }
    return null;
  }

  IST.TrafficLab = {
    CARLEN, CARW, DT, CONTACT, TIGHT, LANE, PASS, PROTO, GT, moveLen, minStartGap, want, roomNeeded,
    SCENARIOS, RULES, FAST, SLOW, OFFLINE, BANDS, MAX_LEVEL,
    cars, plan, setup, fastPath, slowPath, fastPlan, run, risk, where, latAt, vAt, brakeOf,
    complexGen, questionGen,
  };
})();
