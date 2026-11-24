/*
 * Traffic Lab: a faster and a slower class car through one corner complex,
 * sometimes with a third car in the mix.
 *
 *   TL.cars(rnd)                          jittered prototype + GT models (+ a slow GT for traffic)
 *   TL.setup(geo, ideal, cars)            free runs, brake points, key positions
 *   TL.fastPath(X, id, pull)              prototype path for an option ('straight' | 'dive' | 'outside' | 'follow')
 *   TL.slowPath(X, id, sS0, from)         GT path for an option ('hold' | 'letby' | 'room' | 'across' | 'early' | 'defend' | 'overtake' | 'after')
 *   TL.run(X, F, S, o)                    every car stepped together at 60 Hz -> trajectories, contact, gaps, losses
 *   TL.risk(r)                            'safe' | 'tight' | 'contact' (+ where and why)
 *   TL.catchAt(X, sF0, sS0)               where the prototype reaches the GT if both hold their pace
 *   TL.plausible(q)                       null, or why a generated situation doesn't look like real racing
 *
 * Each car follows a fixed path (lateral position along the track) at the
 * speed IST.LineLab's lap-time model gives for its own car on that path,
 * except that it can't drive through the car ahead: in the same lane it
 * follows with the Intelligent Driver Model's gap rule (2 m + 0.25 s, more
 * when closing) and brakes harder than 4 m/s^2 only if it must. In the GT's
 * questions the prototype also won't steer back into a third car it's still
 * alongside (it waits out in the passing lane). Nothing else reacts, so an
 * option's outcome shows what happens if you commit to it while the others do
 * what they set out to do.
 *
 * Risk: bodies (4.8 x 2.0 m) less than 0.25 m apart while side by side is
 * contact; less than 0.9 m, a car moving into another's lane with less room
 * than lets the car behind settle without braking harder than 4 m/s^2, or a
 * car needing more than its full braking, is "tight". Neither counts as a
 * responsible choice.
 *
 * Calibration (LMH/LMDh prototype vs LMGT3/GTD, both under Balance of
 * Performance). Published figures, rounded; GT3 braking and cornering are
 * estimates from typical GT3 data, not a published source:
 *   top speed      Le Mans 2024 Hypercar speed trap 340-345 km/h, best LMGT3
 *                  ~296 km/h (2025 practice). Here, on a high-downforce
 *                  setup, the asymptotes are ~320 and ~285 km/h.
 *   braking        Hypercar peak ~3 g (Brembo); GT3 ~2 g with ABS. Both
 *                  fall off at low speed with the downforce (~1.9 g / ~1.5 g
 *                  at 100 km/h).
 *   cornering      prototype ~2 g slow / ~3.2 g fast, GT3 ~1.6 g / ~2.2 g.
 *   lap time       Le Mans pole ~3:24 vs ~3:55, about 13-15 % (Daytona
 *                  GTP vs GTD is similar, ~12 %).
 * Because the GT is slower on the approach, it brakes about as late in
 * metres as the prototype, sometimes later (reported at Le Mans in 2024),
 * even though it decelerates far less hard: the prototype's advantage is
 * the corner and the run out of it, not a later braking point.
 */
(function () {
  'use strict';
  const U = IST.util, LL = IST.LineLab;
  const HW = LL.HW, DS = LL.DS, NMAX = LL.NMAX;
  const CARLEN = 4.8, CARW = 2.0;
  const DT = 1 / 60, T_MAX = 45;
  const CONTACT = 0.25, TIGHT = 0.9;
  const YIELD_GAP = 1.0, SLIDE = 2.5; // a yielding car keeps >= 1 m off a car alongside; slides back at 2.5 m/s
  const LANE = CARW + 0.5; // centre-to-centre lateral distance below which cars share a lane
  const PASS = 3.3 / HW; // passing lane: 3.3 m inside the car being passed (1.3 m between bodies)
  // per-kg power (W/kg at the wheels), drag (1/m), grip and braking in m/s^2 plus downforce terms per (m/s)^2
  const PROTO = { name: 'Prototype', aLat: 18.3, dfLat: 0.0028, aBrake: 17.2, dfBrake: 0.00125, aTrac: 10, power: 390, drag: 0.00056, vMax: 95, vIn: 62 };
  const GT = { name: 'GT', aLat: 14.8, dfLat: 0.0018, aBrake: 13.9, dfBrake: 0.00046, aTrac: 8, power: 255, drag: 0.00051, vMax: 84, vIn: 55 };
  // a GT limping back to the pits (damage, a slow puncture): about 60 km/h down at the end of the straight
  const SLOWCAR = Object.assign({}, GT, { name: 'Slow GT', power: GT.power * 0.42, vIn: 40 });

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

  /** Prototype and GT with a little variety in the speed gap (BoP, fuel, tyres). */
  function cars(rnd) {
    const j = (a, b) => (rnd ? U.lerp(a, b, rnd()) : 1);
    const pf = j(0.95, 1.05), gf = j(0.93, 1.06), grip = j(0.97, 1.03);
    return {
      fast: Object.assign({}, PROTO, { power: PROTO.power * pf }),
      slow: Object.assign({}, GT, { power: GT.power * gf, aLat: GT.aLat * grip, vIn: GT.vIn * Math.cbrt(gf) }),
      limp: Object.assign({}, SLOWCAR, { power: SLOWCAR.power * j(0.9, 1.1) }),
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
  /** Where a car that was at s0 on a plan's free run is t seconds later. */
  const posAfter = (p, s0, t) => LL.posAtTime(p.sim, LL.timeAt(p.sim, s0) + t);

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
      extra: [], // third cars for this question: [{ plan, ds (m ahead of the GT's start), kind }]
      cache: {},
    };
  }
  /** The limping GT's free run (built on first use). */
  const limpPlan = (X) => X.limp || (X.limp = plan(X.geo, X.cars.limp, X.ideal.n, 'limp'));

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

  /** GT paths for the slower car's options (lifts and early braking are applied in run()). from: where 'after' pulls out. */
  function slowPath(X, id, sS0, from) {
    const geo = X.geo, nI = X.ideal.n, d = X.dir, c0 = geo.corners[0];
    const key = 'gt:' + id + ':' + sS0.toFixed(1) + ':' + (from != null ? from.toFixed(1) : '');
    if (X.cache[key]) return X.cache[key];
    let n = nI;
    const insideFrom = (tgt) => shape(geo, (s, i) => U.lerp(d * smax(d * tgt(s, i), d * nI[i]), nI[i], ramp(s, X.apS - 4, X.apS + 6)));
    const L = moveLen(vAt(X.freeS, sS0));
    const laneBetween = (a) => shape(geo, (s, i) => nI[i] + d * PASS * bump(s, a, a + L, X.bS - 30 - L, X.bS - 30));
    if (id === 'room') {
      // wait on the outside: turn in ~15 m late (Pick the Line's late turn-in) and give up the kerb at the apex
      const IL = X.idealL || (X.idealL = LL.lineFrom(geo, nI, null, {}));
      const late = LL.applyFlaw(geo, IL, 'late', 0, 0.45) || nI;
      n = shape(geo, (s, i) => U.lerp(late[i], d * smin(d * late[i], 0.6), bump(s, c0.startPos - 30, c0.startPos, c0.endPos, c0.endPos + 30)));
    } else if (id === 'across' || id === 'overtake') n = laneBetween(sS0 + 5);
    else if (id === 'after') n = laneBetween(from);
    else if (id === 'defend') {
      // one move toward the inside, done before the braking zone: just enough that there's no car-width gap
      // on the inside, held through straight-line braking, then easing back onto the line by the apex:
      // a tighter entry, not a weave
      const a0 = Math.max(sS0 + 5, X.bS - 60 - L);
      n = shape(geo, (s, i) => nI[i] + d * 0.55 * bump(s, a0, a0 + L, X.tiS - 10, X.apS));
    }
    return (X.cache[key] = plan(geo, X.cars.slow, n, id));
  }

  // ------------------------------------------------------------- the run
  /**
   * F (faster car) and S (slower car): { plan, s0, lift?: {decel, maxT, fromS?}, yields? },
   * plus X.extra, third cars placed relative to the GT's start. o.light skips the
   * trajectory record (for searches); o.ref picks which car's pass the
   * prototype is measured against for `onset` (1 = the GT, 2 = the first extra).
   */
  function run(X, F, S, o) {
    o = o || {};
    const geo = X.geo, sEnd = geo.sEnd, stopAt = sEnd + 25;
    // off: metres the car is held off its path (see yields below)
    const mk = (x, id) => ({ id, p: x.plan, s0: x.s0, s: x.s0, v: vAt(x.plan, x.s0), lift: x.lift ? Object.assign({ on: true }, x.lift) : null, hard: null, finish: null, short: 0, off: 0, yields: !!x.yields });
    const cs = [mk(F, 'F'), mk(S, 'S')];
    X.extra.forEach((e, k) => cs.push(mk({ plan: e.plan, s0: S.s0 + e.ds }, 'X' + k)));
    const N = cs.length, ref = o.ref && o.ref < N ? o.ref : 1;
    const rec = o.light ? null : { t: [], sF: [], vF: [], lF: [], sS: [], vS: [], lS: [], x: cs.slice(2).map(() => ({ s: [], v: [], l: [] })) };
    const r = { contact: null, minGap: Infinity, minGapS: null, cut: null, pass: null, passAll: null, onset: null, dsTurn: null, alongside: 0 };
    const pairs = [];
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) pairs.push({ i, j, prev: null, prevLat: null });
    // sharing a lane = the car in front is on the following car's path where it is now
    const laneOf = (c, d) => Math.abs(latAt(c.p, d.s) + c.off - latAt(d.p, d.s) - d.off) < LANE;
    let t = 0;
    for (let step = 0; t < T_MAX; step++) {
      const lat = cs.map((c) => latAt(c.p, c.s) + c.off);
      if (rec) {
        rec.t.push(t);
        rec.sF.push(cs[0].s); rec.vF.push(cs[0].v); rec.lF.push(lat[0]);
        rec.sS.push(cs[1].s); rec.vS.push(cs[1].v); rec.lS.push(lat[1]);
        for (let k = 2; k < N; k++) {
          rec.x[k - 2].s.push(cs[k].s); rec.x[k - 2].v.push(cs[k].v); rec.x[k - 2].l.push(lat[k]);
        }
      }
      for (const P of pairs) {
        const a = cs[P.i], b = cs[P.j], ds = a.s - b.s, dl = Math.abs(lat[P.i] - lat[P.j]);
        const ahead = ds >= 0 ? a : b, behind = ds >= 0 ? b : a;
        const lane = laneOf(behind, ahead);
        const live = Math.min(a.s, b.s) < sEnd;
        if (Math.abs(ds) < CARLEN && live) {
          const gap = dl - CARW;
          if (P.i === 0 && P.j === 1) r.alongside += DT;
          if (gap < r.minGap) {
            r.minGap = gap;
            r.minGapS = b.s;
          }
          if (gap < CONTACT && !r.contact) r.contact = { t, s: b.s, gap, who: [a.id, b.id] };
        }
        // lanes come together with the cars nose to tail: who moved, and was there room
        if (P.prev === false && lane && live) {
          const g = Math.abs(ds) - CARLEN, need = roomNeeded(behind.v, behind.v - ahead.v);
          const moverA = P.prevLat ? Math.abs(lat[P.i] - P.prevLat[0]) > Math.abs(lat[P.j] - P.prevLat[1]) : P.i === 0;
          const mover = moverA ? a : b;
          // lead: room the faster car left in front of the slower one (negative = not past)
          const ev = { t, s: b.s, g, need, margin: g - need, lead: ds >= 0 ? g - need : -g - CARLEN - need, ahead: ahead.id, behind: behind.id, mover: mover.id, moverF: mover.id === 'F' };
          if (P.i === 0 && P.j === ref && !r.onset) r.onset = ev;
          // a cut is the car in front moving across without room; the car behind tucking in is its own follow
          if (g >= 0 && ev.margin < 0 && mover === ahead && (!r.cut || ev.margin < r.cut.margin)) r.cut = ev;
        }
        P.prev = lane;
        P.prevLat = [lat[P.i], lat[P.j]];
      }
      const F0 = cs[0];
      if (!r.pass && F0.s - cs[1].s >= CARLEN) r.pass = { t, s: cs[1].s };
      if (!r.passAll && cs.every((c, k) => !k || F0.s - c.s >= CARLEN)) r.passAll = { t, s: cs[1].s };
      if (r.dsTurn == null && cs[1].s >= X.tiS) r.dsTurn = F0.s - cs[1].s;
      if (cs.every((c) => c.s >= stopAt)) break;

      // front to back, so each car reacts to the brake lights ahead of it, not a frame late
      const order = cs.map((_, k) => k).sort((x, y) => cs[y].s - cs[x].s);
      const next = new Array(N);
      for (const i of order) {
        const c = cs[i], car = c.p.car;
        const vd = vAt(c.p, c.s + c.v * rAt(c.p, c.s) * DT);
        const k = kAt(c.p, c.s), u = (c.v * c.v * Math.abs(k)) / LL.latA(car, c.v), ell = u < 1 ? Math.sqrt(1 - u * u) : 0;
        const acc = Math.min(car.aTrac, car.power / Math.max(c.v, 1)) * ell - car.drag * c.v * c.v;
        let cap = Math.min(vd, c.v + Math.max(0, acc) * DT);
        // lift / early braking: from c.lift.fromS (default at once) until the prototype is clear ahead or maxT is up
        const lf = c.lift;
        if (lf && lf.on && c.s >= (lf.fromS || 0)) {
          if (lf.t0 == null) lf.t0 = t;
          if (t - lf.t0 > lf.maxT || (!lf.stay && F0.s - c.s > CARLEN + 4)) lf.on = false;
          else cap = Math.min(cap, c.v - lf.decel * DT);
        }
        // the nearest car ahead in this car's lane
        let d = null;
        for (let m = 0; m < N; m++) {
          const e = cs[m];
          if (m === i || e.s <= c.s || e.s - c.s > 160) continue;
          if ((!d || e.s < cs[d].s) && laneOf(c, e)) d = m;
        }
        // waiting to get back onto its path behind a car it's alongside: it drops back behind it
        if (c.held != null && cs[c.held].s > c.s && (d == null || cs[c.held].s < cs[d].s)) d = c.held;
        if (d != null && c.s < sEnd) {
          const e = cs[d], dv = next[d];
          // brake lights: react to where the car in front's speed is heading over the next 0.4 s
          const vl = dv + ((dv - e.v) / DT) * 0.4;
          const fc = c.v + follow(c.v, c.v - vl, e.s - c.s - CARLEN, acc) * DT;
          if (fc < cap) cap = fc;
        }
        const floor = c.v - (LL.brkA(car, c.v) + car.drag * c.v * c.v) * DT * 1.1;
        // more than full braking: a frame or two is reaction, a real shortfall is a near miss
        if (cap < floor - 1e-6) {
          c.short += floor - cap;
          if (c.short > 1.5 && !c.hard && c.s < sEnd) c.hard = { t, s: c.s };
          cap = floor;
        } else c.short = Math.max(0, c.short - 0.05);
        next[i] = Math.max(0, cap);
      }
      for (let i = 0; i < N; i++) {
        const c = cs[i], s1 = c.s + ((c.v + next[i]) / 2) * rAt(c.p, c.s) * DT;
        if (c.finish == null && s1 >= sEnd) c.finish = t + (DT * (sEnd - c.s)) / Math.max(1e-6, s1 - c.s);
        c.s = s1;
        c.v = next[i];
      }
      // a car that yields doesn't steer into a third car it's alongside: its path's move back to
      // the line is scripted by position, so when it's held up in the passing lane it waits out
      // there until it's clear, then slides back onto its path
      for (let i = 0; i < N; i++) {
        const c = cs[i];
        if (!c.yields) continue;
        const base = latAt(c.p, c.s), l0 = lat[i];
        const block = (L) => cs.findIndex((e, m) => {
          if (m < 2 || Math.abs(e.s - c.s) > CARLEN + 3) return false;
          const le = latAt(e.p, e.s) + e.off, g1 = Math.abs(L - le);
          return g1 < Math.abs(l0 - le) && g1 - CARW < YIELD_GAP;
        });
        const off = c.off - Math.sign(c.off) * Math.min(Math.abs(c.off), SLIDE * DT);
        const b = block(base + off);
        c.held = b < 0 ? null : b;
        c.off = b < 0 ? off : l0 - base;
      }
      t += DT;
    }
    const freeT = (p, s0) => LL.timeAt(p.sim, sEnd) - LL.timeAt(p.sim, s0);
    const fin = cs.map((c) => (c.finish != null ? c.finish : t));
    r.loss = [fin[0] - freeT(X.freeF, cs[0].s0), fin[1] - freeT(X.freeS, cs[1].s0)];
    r.finish = fin;
    r.hard = [cs[0].hard, cs[1].hard];
    r.hardX = cs.slice(2).map((c) => c.hard).find((h) => h) || null;
    r.T = t;
    if (rec) {
      r.rec = {};
      for (const k in rec) if (k !== 'x') r.rec[k] = Float32Array.from(rec[k]);
      r.rec.x = rec.x.map((e) => ({ s: Float32Array.from(e.s), v: Float32Array.from(e.v), l: Float32Array.from(e.l) }));
      r.rec.n = rec.t.length;
    }
    return r;
  }

  /** How dangerous the outcome was, and where. */
  function risk(r) {
    if (r.contact) return { level: 'contact', why: 'contact', s: r.contact.s, gap: r.contact.gap, who: r.contact.who };
    if (r.minGap < TIGHT) return { level: 'tight', why: 'squeeze', s: r.minGapS, gap: r.minGap };
    if (r.cut) return { level: 'tight', why: 'cut', s: r.cut.s, clear: r.cut.g, moverF: r.cut.moverF, ahead: r.cut.ahead, behind: r.cut.behind, mover: r.cut.mover };
    const h = r.hard[0] || r.hard[1] || r.hardX;
    if (h) return { level: 'tight', why: 'hard', s: h.s, who: r.hard[0] ? 'F' : r.hard[1] ? 'S' : 'X' };
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

  /**
   * If both cars hold their pace (their free runs from sF0 and sS0), when and where the
   * prototype's nose reaches the GT's rear bumper. t = 0 when it's already there;
   * null if it doesn't get there before the end of the complex.
   */
  function catchAt(X, sF0, sS0) {
    for (let t = 0; t < 25; t += 0.05) {
      const sF = posAfter(X.freeF, sF0, t), sS = posAfter(X.freeS, sS0, t);
      if (sF >= sS - CARLEN) return { t, s: sS, sF, toBrake: X.bS - sS };
      if (sS >= X.geo.sEnd) break;
    }
    return null;
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
  const SLOW = ['hold', 'letby', 'room', 'across', 'early', 'defend'];
  const SLOW_TRAFFIC = ['hold', 'overtake', 'after', 'across'];
  // moving off the line or off the expected braking point where the faster car can't predict it
  const OFFLINE = { across: 1, early: 1 };
  /*
   * Covering the inside is a real option for a GT, not always a mistake: one early,
   * decisive move before the braking zone, while the prototype is still behind and
   * hasn't committed, tells it the dive isn't on and it sets up the exit instead
   * (Gentilozzi, Sportscar365 2018: GTs needn't give up the inside of every corner;
   * Baldwin 2025: a GT covering the bus stop, so he passed on the exit). It's
   * unpredictable once the prototype has already pulled out to that side.
   */
  const offlineFor = (id, type) => !!OFFLINE[id] || (id === 'defend' && (type === 'clear' || type === 'committed' || type === 'traffic'));
  const LIFT = { decel: 2.5, maxT: 3.5 };
  /** Pass lead bands (m of room left in front of the slower car when cutting back): smaller = closer call. */
  const BANDS = [null, [14, 40], [9, 28], [6, 19], [4, 13], [2, 8], [0.8, 5]];
  const MAX_LEVEL = BANDS.length - 1;
  const CLEAR = 0.05; // s the right answer must beat the next acceptable one by
  /**
   * Variants on top of the plain two-car read:
   *   late     you notice late (radio, a dash setting, a fight in your own class, a wandering mind):
   *            the decision comes much nearer the braking zone, with a few seconds to make it
   *   pair     prototype only: two GTs nose to tail in their own battle
   *   traffic  GT only: you're catching a GT limping back to the pits while a prototype closes
   */
  const VARIANTS = ['normal', 'late', 'pair', 'traffic'];
  const LATE_CAUSES = ['radio', 'dash', 'fight', 'mind'];
  // s to answer a late call, by level: room to read three cars and get into the race at first, a snap call at the top
  const LATE_TIME = [null, 16, 15, 13, 11, 9, 7];

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

  /** Prototype following a GT's path through the corner (its defensive line), then the 'follow' exit pass. */
  function tuckPlan(X, gtPlan) {
    const key = 'tuck:' + gtPlan.id + ':' + gtPlan.n[0].toFixed(3) + ':' + gtPlan.sim.iStop;
    if (X.cache[key]) return X.cache[key];
    const f = fastPath(X, 'follow'), a = X.apS + 10, b = X.apS + 60;
    const n = shape(X.geo, (s, i) => U.lerp(gtPlan.n[i], f.n[i], ramp(s, a, b)));
    return (X.cache[key] = plan(X.geo, X.cars.fast, n, 'follow'));
  }

  function* fastOutcomes(X, sF0, sS0, rules, ref) {
    const hold = { plan: X.freeS, s0: sS0 }, out = [];
    for (const id of FAST) {
      const fp = fastPlan(X, id, sF0, false);
      const r = run(X, { plan: fp, s0: sF0 }, hold, { ref });
      const rk = risk(r);
      const legal = rules !== 'pointby' || id === 'straight' || id === 'follow';
      out.push({ id, r, plan: id, fp, sp: X.freeS, risk: rk, legal, loss: r.loss[0], other: r.loss[1], ok: rk.level === 'safe' && legal });
      yield;
    }
    return out;
  }

  function* slowOutcomes(X, sF0, sS0, rules, type) {
    const before = type === 'clear' || type === 'committed' || type === 'traffic';
    // marginal: it's right behind and lining up a late dive, which it takes if the inside is left open
    const base = type === 'clear' || type === 'traffic' ? 'straight' : type === 'committed' || type === 'marginal' ? 'dive' : 'follow';
    // in traffic it's already out in the passing lane (you can see it in the mirror): it can stay out or dive, not vanish back behind you
    const replanSet = type === 'traffic' ? ['straight', 'dive'] : rules === 'pointby' ? ['straight', 'follow'] : FAST;
    const ids = type === 'traffic' ? SLOW_TRAFFIC : SLOW;
    const out = [];
    let passFrom = null;
    for (const id of ids) {
      let gtPlan;
      if (id === 'hold' || id === 'letby' || id === 'early') gtPlan = X.freeS;
      else if (id === 'after') {
        // pull out once the prototype is through, if that leaves room to pass before braking
        if (passFrom == null) continue;
        gtPlan = slowPath(X, 'after', sS0, passFrom);
      } else gtPlan = slowPath(X, id, sS0);
      // leaving room = braking a little early so a car alongside clears, then a later turn-in;
      // braking early to let it by = ~1 g well before the board, where the car behind expects full speed
      const lift = id === 'letby' || id === 'across' ? LIFT
        // leaving room: a touch earlier on the brakes (~3 m/s^2 extra for under 2 s, until it's clear), then a later turn-in behind it
        : id === 'room' ? { decel: 3, maxT: 1.8, fromS: X.bS - 40 }
        : id === 'early' ? { decel: 9.5, maxT: 2.5, fromS: X.bS - 110, stay: true }
        // staying behind a slow car means lifting early to settle behind it, not braking late
        : (id === 'hold' || id === 'after') && type === 'traffic' ? { decel: 3, maxT: 4, stay: true } : null;
      const S = { plan: gtPlan, s0: sS0, lift };
      let fp = fastPlan(X, base, sF0, before), plan = base;
      // covering the inside early is a signal it sees in time too: with the dive shut, it picks another way by
      const replan = id === 'letby' || type === 'traffic' || (id === 'defend' && type === 'marginal');
      let r = run(X, { plan: fp, s0: sF0, yields: true }, S, { light: replan });
      if (replan) {
        // easing off on your line is a signal it can see: it takes the best safe pass that offers.
        // In traffic it's reading three cars anyway: it takes the best safe pass whatever you do,
        // so what goes wrong is down to your move (pulling out into it), not its plan
        let best = null;
        const cands = id === 'defend' ? replanSet.filter((p) => p !== 'dive').concat(['tuck']) : replanSet;
        for (const pid of cands) {
          // tuck: fall in behind on the GT's own (defensive) line, then pass on the exit as 'follow' does
          const p2 = pid === 'tuck' ? tuckPlan(X, gtPlan) : pid === base ? fp : fastPlan(X, pid, sF0, before && (pid === 'straight' || pid === 'dive'));
          const rr = pid === base ? r : run(X, { plan: p2, s0: sF0, yields: true }, S, { light: true });
          if (risk(rr).level === 'safe' && (!best || rr.loss[0] < best.r.loss[0])) best = { r: rr, pid, p2 };
          yield;
        }
        if (best) {
          plan = best.pid === 'tuck' ? 'follow' : best.pid;
          fp = best.p2;
        }
        r = run(X, { plan: fp, s0: sF0, yields: true }, S); // again with the record, for the replay
      }
      if (id === 'hold' && type === 'traffic' && r.pass) {
        // where the GT could pull out behind the prototype: it's a car length clear and still has a straight to use
        const i = r.rec ? Array.prototype.findIndex.call(r.rec.sF, (sf, k) => sf - r.rec.sS[k] > CARLEN + 8) : -1;
        const sA = i >= 0 ? r.rec.sS[i] + 5 : null;
        if (sA != null && sA + 2 * moveLen(vAt(X.freeS, sA)) < X.bS - 50) passFrom = sA;
      }
      const rk = risk(r);
      out.push({ id, r, plan, fp, sp: gtPlan, lift, risk: rk, offline: offlineFor(id, type), loss: r.loss[1], other: r.loss[0], ok: rk.level === 'safe' && !offlineFor(id, type) });
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

  /**
   * Does the situation look like real multiclass racing? Ranges from the class gaps
   * above: on a straight a prototype closes on a GT at roughly 10-70 km/h (most
   * at the top of the straight, more out of slow corners), a gap worth deciding about
   * is under ~3 s, the GT is at speed, and the prototype gets there within ~12 s.
   * Returns null when it does, or the reason it doesn't.
   */
  function plausible(q) {
    const X = q.X, dv = (q.vF0 - q.vS0) * 3.6;
    if (dv < 10) return 'closing under 10 km/h';
    if (dv > 75) return 'closing over 75 km/h';
    if (q.vS0 * 3.6 < 170) return 'GT not at speed';
    if ((q.gap + CARLEN) / q.vF0 > 3) return 'gap over 3 s';
    const bd = X.bF - X.bS;
    if (bd < -40 || bd > 80) return 'braking points ' + Math.round(bd) + ' m apart';
    const c = q.catch;
    if (!c && q.type !== 'behind') return 'never catches';
    if (c && c.t > 12) return 'catches in ' + c.t.toFixed(1) + ' s';
    if (q.variant === 'traffic') {
      const L = limpPlan(X), e = X.extra[0], dvx = (q.vS0 - vAt(L, q.sS0 + e.ds)) * 3.6;
      if (dvx < 25 || dvx > 90) return 'closing on the slow car ' + Math.round(dvx) + ' km/h';
    }
    if (q.variant === 'pair') {
      const e = X.extra[0], g2 = (e.ds - CARLEN) / q.vS0;
      if (g2 < 0.15 || g2 > 1.2) return 'GT pair ' + g2.toFixed(2) + ' s apart';
    }
    return null;
  }

  function sitOf(q) {
    if (q.variant === 'traffic') return 's-traffic';
    if (q.variant === 'pair') return 'f-pair';
    if (q.variant === 'late') return q.role === 'fast' ? 'f-late' : 's-late';
    return q.role === 'fast' ? 'f-' + q.best.id : 's-' + q.type;
  }

  /** Which variant, from the level (silly cases from level 2) and the role. */
  function pickVariant(level, role, rnd) {
    const w = { normal: 1, late: level >= 2 ? 0.28 : 0.12, pair: role === 'fast' && level >= 2 ? 0.3 : 0, traffic: role === 'slow' && level >= 2 ? 0.3 : 0 };
    let x = rnd() * (w.normal + w.late + w.pair + w.traffic);
    for (const k of VARIANTS) if ((x -= w[k]) <= 0) return k;
    return 'normal';
  }

  /**
   * One question for `role` ('fast' | 'slow') under `rules`, tuned to `level`.
   * cx is a complexGen result (reused across tries). o.variant and o.type force a
   * variant or GT situation (tests). Returns null if no situation fits.
   */
  function* questionGen(cx, level, role, rules, rnd, o) {
    const X = setup(cx.geo, cx.ideal, cars(rnd));
    const band = BANDS[U.clamp(level, 1, MAX_LEVEL)];
    const variant = (o && o.variant) || pickVariant(level, role, rnd);
    if ((variant === 'pair' && role !== 'fast') || (variant === 'traffic' && role !== 'slow')) return null;
    let type = 'fast';
    if (variant === 'traffic') type = 'traffic';
    else if (role === 'slow') {
      const w = variant === 'late' ? { committed: 0.6, behind: 0.4 }
        : rules === 'pointby' ? { behind: 1 } : rules === 'hold' ? { committed: 0.4, clear: 0.25, marginal: 0.2, behind: 0.2 } : { committed: 0.3, clear: 0.25, behind: 0.45 };
      if (rules === 'pointby') type = 'behind';
      else {
        let x = rnd() * Object.values(w).reduce((a, b) => a + b, 0);
        for (const k in w) if ((x -= w[k]) <= 0 || k === 'behind') { type = k; break; }
      }
    }
    if (o && o.type && role === 'slow' && variant !== 'traffic') type = o.type; // tests
    const before = type === 'clear' || type === 'committed' || type === 'traffic';
    const ref = variant === 'pair' ? 2 : 1;
    if (variant === 'pair') X.extra = [{ plan: X.freeS, ds: CARLEN + U.lerp(12, 30, rnd()), kind: 'gt2' }];
    if (variant === 'traffic') X.extra = [{ plan: limpPlan(X), ds: CARLEN + U.lerp(35, 80, rnd()), kind: 'limp' }];
    const late = variant === 'late';
    // traffic: half the time you've room to pass the slow car first, half the time you haven't
    const wantPass = rnd() < 0.5;
    // the pass on the straight is on (+) or not (−); + is the harder one to set up, so it gets first go a bit more often
    let sign = type === 'clear' ? 1 : type === 'committed' || type === 'marginal' || late ? -1 : rnd() < 0.6 ? 1 : -1;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt && !late && (type === 'fast' || type === 'behind')) sign = -sign;
      const vF = vAt(X.freeF, X.bS - 500), vS = vAt(X.freeS, X.bS - 500);
      const gMin = before ? 6 : minStartGap(vS, vF - vS);
      // decision point: a long run-up when the pass on the straight should be on; a short one when you noticed late
      let D;
      if (late) D = U.lerp(170, 300, rnd());
      else {
        const dMax = X.bS - 15 - moveLen(vF) - CARLEN - gMin - 40 - (X.extra[0] ? X.extra[0].ds : 0);
        if (dMax < 420) return null;
        D = sign > 0 ? U.lerp(Math.max(420, dMax - 260), dMax, rnd()) : U.lerp(420, Math.min(dMax, 620), rnd());
      }
      const sS0 = X.bS - D, vS0 = vAt(X.freeS, sS0), vF0 = vAt(X.freeF, sS0);
      // sweep the starting gap: how much room the pass on the straight leaves
      const cands = [];
      let k = 0;
      const free = late || variant === 'traffic' || variant === 'pair' || type === 'marginal'; // no pass band: the judge alone decides
      const gTop = late ? gMin + 40 : variant === 'traffic' ? gMin + 160 : gMin + 90;
      for (let g = gMin; g <= gTop; g += late ? 2 : 1.5) {
        const sF0 = sS0 - CARLEN - g;
        if (sF0 - moveLen(vF0) < 10) break;
        if (free) {
          // no band to narrow it: keep only gaps it closes in a believable time
          const c = catchAt(X, sF0, sS0);
          if (c && c.t <= 12) cands.push({ g, sF0, lead: 0 });
        }
        else {
          const S = { plan: X.freeS, s0: sS0, lift: type === 'behind' ? LIFT : null };
          const r = run(X, { plan: fastPlan(X, 'straight', sF0, before), s0: sF0 }, S, { light: true, ref });
          const lead = r.onset ? r.onset.lead : r.pass ? 50 : -50;
          if (sign * lead >= band[0] && sign * lead <= band[1]) cands.push({ g, sF0, lead });
        }
        if (++k % 4 === 0) yield;
      }
      shuffle(cands, rnd);
      // traffic: a close prototype says wait, a distant one leaves room to pass first; aim for one or the other
      if (variant === 'traffic') {
        const half = Math.ceil(cands.length / 2), byGap = cands.slice().sort((a, b) => a.g - b.g);
        cands.splice(0, cands.length, ...shuffle(wantPass ? byGap.slice(cands.length - half) : byGap.slice(0, Math.ceil(cands.length / 4)), rnd));
      }
      for (const c of cands.slice(0, free ? 6 : 3)) {
        const q = {
          spec: cx.spec, geo: cx.geo, X, role, rules, level, type, variant,
          sS0, sF0: c.sF0, gap: c.g, lead: c.lead, vF0: vAt(X.freeF, c.sF0), vS0,
          side: X.dir > 0 ? 'right' : 'left',
          extra: X.extra.map((e) => Object.assign({ s0: sS0 + e.ds }, e)),
          cause: late ? LATE_CAUSES[Math.floor(rnd() * LATE_CAUSES.length)] : null,
          timeLimit: late ? LATE_TIME[U.clamp(level, 1, MAX_LEVEL)] : 0,
        };
        q.catch = catchAt(X, c.sF0, sS0);
        const why = plausible(q);
        if (why) { if (o && o.log) o.log(why); continue; }
        q.opts = role === 'fast' ? yield* fastOutcomes(X, c.sF0, sS0, rules, ref) : yield* slowOutcomes(X, c.sF0, sS0, rules, type);
        if (type === 'clear' && q.opts[0].risk.level !== 'safe') continue; // it must really be a clean pass if you hold
        if ((type === 'committed' || type === 'marginal') && q.opts[0].risk.level === 'safe') continue; // holding your line must not be enough
        const log = (w) => o && o.log && o.log(w + ' [' + q.opts.map((x) => x.id + ':' + (x.risk.why || 'safe')).join(' ') + ']');
        if (!judge(q)) { log('no clear call'); continue; }
        q.sit = sitOf(q);
        return q;
      }
    }
    return null;
  }

  IST.TrafficLab = {
    CARLEN, CARW, DT, CONTACT, TIGHT, LANE, PASS, PROTO, GT, SLOWCAR, moveLen, minStartGap, want, roomNeeded,
    SCENARIOS, RULES, FAST, SLOW, SLOW_TRAFFIC, OFFLINE, BANDS, MAX_LEVEL, VARIANTS, LATE_CAUSES, LATE_TIME,
    cars, plan, setup, fastPath, slowPath, fastPlan, run, risk, where, latAt, vAt, posAfter, brakeOf, catchAt, plausible,
    complexGen, questionGen,
  };
})();
