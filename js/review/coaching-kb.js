/*
 * The Coaching tab's knowledge: what each telemetry pattern means, a cue to try on track, the
 * drills that train it, and where the advice comes from. Plain data, read by coaching.js.
 * Each entry says only what its sources say; anything the app adds is worded as the data's reading.
 */
(function () {
  'use strict';
  IST.Review = IST.Review || {};

  const SOURCES = {
    kasdorpBasics: ['Yuri Kasdorp, Simracing 101: the fundamentals of driving fast', 'https://www.youtube.com/watch?v=CnNAf4fkJdA'],
    kasdorpBraking: ['Yuri Kasdorp, Simracing 101: straight-line braking', 'https://www.youtube.com/watch?v=1ymN0j28-V8'],
    kasdorpTrail: ['Yuri Kasdorp, Simracing 101: trail braking', 'https://www.youtube.com/watch?v=nejxq6KbaZY'],
    kasdorpThrottle: ['Yuri Kasdorp, Simracing 101: throttle', 'https://www.youtube.com/watch?v=ez-hVdngdgc'],
    bentleyData: ['Ross Bentley, Speed Secrets: Coaching with Data', 'https://rossbentley.substack.com/p/speed-secrets-coaching-with-data'],
    bentleyPractice: ['Ross Bentley, Speed Secrets: How to Practice', 'https://rossbentley.substack.com/p/speed-secrets-how-to-practice'],
    vonMoltke: ['Dion von Moltke, Finding Low-Hanging Fruit in Your Data (NASA Speed News)', 'https://nasaspeed.news/columns/driver-instruction/finding-low-hanging-fruit-in-your-data/'],
    driver61: ['Scott Mansell (Driver61), Prioritising Circuit Corners', 'https://driver61.com/uni/prioritising-corners/'],
    autosport: ['Autosport, Simulator secrets: how to master the art of braking (coached by Ben Barker)', 'https://www.autosport.com/performance/feature/7152/simulator-secrets-how-to-master-the-art-of-braking'],
    wulf: ['Wulf (2013), Attentional focus and motor learning: a review of 15 years, Int. Review of Sport and Exercise Psychology 6(1)', 'https://doi.org/10.1080/1750984X.2012.723728'],
    guidance: ['Salmoni, Schmidt and Walter (1984), Knowledge of results and motor learning, Psychological Bulletin 95(3)', 'https://doi.org/10.1037/0033-2909.95.3.355'],
  };

  /**
   * Patterns, matched in coaching.js against the quickest lap through each corner (your best there, or the reference) and only where the lap lost time.
   * phase: where the time it explains is lost ('entry' up to the comparison lap's slowest point, 'exit' after it, 'any').
   */
  const PATTERNS = {
    trail: {
      title: 'Brake released before the turn', icon: 'brake', phase: 'entry',
      cue: 'Carry the brake past turn-in and let it go as the steering goes on: the more you steer, the less brake, reaching almost nothing at the apex.',
      why: 'Against the comparison lap, the brake came off earlier relative to turn-in. Kasdorp calls trail braking the tool for rotating the car: coming off the brakes early and waiting for the apex lets the weight move back and the car understeers. How long to trail depends on the corner (he releases slower for wide corners, faster for tight ones), so this compares against the comparison lap in the same corner, not a fixed rule.',
      sources: ['kasdorpTrail', 'kasdorpBasics'], drills: ['pedalCal', 'oneCorner'],
    },
    entryUs: {
      title: 'Understeer into the corner', icon: 'us', phase: 'entry',
      cue: 'At turn-in the wheel should load up, then the rear go light and follow. If the wheel goes light and the nose runs wide, there was too little weight on the front: keep more brake into the turn rather than adding lock.',
      why: 'The balance channel measured more understeer on entry than the comparison lap. Both Kasdorp and the Autosport session put entry understeer down to braking technique more often than the car: a release that unloads the front tyres. Kasdorp adds that brake bias set so all four tyres lock together is usually too far forward, which also pushes on entry.',
      sources: ['kasdorpTrail', 'autosport', 'kasdorpBraking'], drills: ['releaseLadder', 'turnInFeel'],
    },
    cliff: {
      title: 'Brake let go all at once', icon: 'brake', phase: 'entry',
      cue: 'Let the pedal up like a hill, not a cliff.',
      why: 'The comparison lap took noticeably longer to come off the brake here. Ben Barker\'s coaching in the Autosport session was exactly this, "a hill, not a cliff", and Bentley\'s fix for a square-bottomed speed trace was to experiment with the timing and rate of the release. Kasdorp notes the right rate depends on the corner: slower for wide corners, faster for tight ones.',
      sources: ['autosport', 'bentleyData', 'kasdorpTrail'], drills: ['releaseLadder', 'pedalCal'],
    },
    overslow: {
      title: 'Slower than needed at the apex', icon: 'speed', phase: 'entry',
      cue: 'If you find yourself letting the brake off early to keep the car rolling, arrive faster next lap rather than braking later in the turn. If the evidence shows much more lock, turn in so the car is rotated by the apex instead of winding on more steering.',
      why: 'The lap was slower than the comparison lap at the apex, either using less of the car\'s grip there (under the limit) or with far more steering lock, where the front tyres scrub off speed. Driver61 names over-slowing fast corners as a common amateur error, and Kasdorp\'s rule for the next lap is: had to release more brake, arrive faster; missed the apex, arrive slower.',
      sources: ['driver61', 'kasdorpTrail'], drills: ['oneCorner', 'loseRear'],
    },
    softPeak: {
      title: 'Slow to build brake pressure', icon: 'brake', phase: 'entry',
      cue: 'Get to your peak pressure sooner, the way the comparison lap does in this car.',
      why: 'Pressure came later or lower than on the comparison lap in the same car. Von Moltke wants peak pressure "nearly right away" then a steady release, but Kasdorp shows the right trace depends on the car: a quick peak then bleed for downforce cars, a more gradual build held just under ABS for heavy cars in iRacing. So this only compares against the comparison lap, never against a fixed shape.',
      sources: ['kasdorpBraking', 'vonMoltke'], drills: ['pedalCal', 'crispBrake'],
    },
    lift: {
      title: 'Lifting before the brakes', icon: 'lift', phase: 'entry',
      cue: 'Go from full throttle to firm brake in one quick step across, with no pause on top.',
      why: 'The throttle came off well before the brake went on, longer than on the comparison lap. Von Moltke reads this as a "rounded top" on the speed trace, and Bentley found the same as acceleration flattening before braking. Von Moltke\'s fix: back off to a brake point you trust, make the change crisp, then move deeper gradually.',
      sources: ['vonMoltke', 'bentleyData'], drills: ['crispBrake'],
    },
    unusedIn: {
      title: 'Grip left unused on the way in', icon: 'grip', phase: 'entry',
      cue: 'Keep the tyres working all the way to the apex: as braking fades, turning should take its place, with no moment where the car just rolls.',
      why: 'From braking to the apex this lap used a smaller share of the car\'s grip than the comparison lap (grip used is combined g against the most this car reached at that speed in the session). Kasdorp describes each tyre as having a fixed amount of grip to share between braking, turning and throttle, with the aim of keeping all four at the limit through the corner. Time on neither pedal is shown when it is part of the gap; some neutral moment is normal in some corners, so it is only counted against the comparison lap.',
      sources: ['kasdorpBasics'], drills: ['oneCorner', 'loseRear'],
    },
    overdrive: {
      title: 'Fast in, slow out', icon: 'speed', phase: 'exit',
      cue: 'Arrive a little slower so the car is rotated and pointed at the apex. Never fix a missed apex by braking harder in the turn.',
      why: 'Time gained on the way in was lost, and more, on the way out. Kasdorp\'s rule is to arrive slower when the apex is missed, and Driver61 ranks the exit first when a long straight follows, since speed lost there is carried all the way down it.',
      sources: ['kasdorpTrail', 'driver61'], drills: ['exitFirst', 'oneCorner'],
    },
    lateThrottle: {
      title: 'Late or slow onto the throttle', icon: 'throttle', phase: 'exit',
      cue: 'As the car finishes rotating, pick up the throttle firmly to about half, then only add.',
      why: 'Against the comparison lap, the throttle came back later or built more slowly. Kasdorp calls too slow or too late the most common throttle fault: it kills the rotation and the car understeers out. His method is 50 to 70 % quickly, timed with the rotation, then only adding. Bentley\'s one-lap data review found the same kind of gain: more of the lap at full throttle.',
      sources: ['kasdorpThrottle', 'bentleyData'], drills: ['throttleTiming', 'exitFirst'],
    },
    partThrottle: {
      title: 'Off full throttle where the quicker lap was flat', icon: 'throttle', phase: 'any',
      cue: 'Commit once the car is pointed: throttle only goes up until the next braking point.',
      why: 'The comparison lap was flat out where this lap was not, outside the braking zones, with no sign the car was pushing. Each lift is listed with where it was and what it cost, counting the speed carried down to the next braking point. Bentley\'s one-lap data review found more full-throttle time was the main gain, and Kasdorp\'s throttle rule is to pick it up once and only add.',
      sources: ['bentleyData', 'kasdorpThrottle'], drills: ['throttleTiming', 'oneCorner'],
    },
    lineLift: {
      title: 'Lifting because the car was pushing', icon: 'us', phase: 'any',
      cue: 'Fix the entry, not the throttle: a touch less speed into the turn, or a turn-in that gets the car rotated early, so you can stay flat without extra lock.',
      why: 'The lift came with far more steering lock or understeer than the comparison lap had there, so the car was running wide and the lift was the cure, not the fault. Kasdorp ties understeer to too little weight on the front and a missed entry, and his rule for a missed apex is a slower arrival. Forcing the throttle here would only widen the line.',
      sources: ['kasdorpTrail', 'kasdorpBasics'], drills: ['turnInFeel', 'oneCorner'],
    },
    lateBuild: {
      title: 'Brake building into the turn', icon: 'brake', phase: 'entry',
      cue: 'Once you\'re on the brake, pressure only goes down. If you need more near turn-in, it belonged at the start: hit your peak harder and earlier, then bleed it off.',
      why: 'The pressure peaked late in the braking zone, or eased and then rose again before turn-in, where the comparison lap peaked early. Von Moltke wants peak pressure nearly right away, then a steady release. Kasdorp makes the braking zone\'s job setting the speed for turn-in, and the tyres take the most brake while the car is still straight, so pressure added near turn-in is braking done at the wrong moment.',
      sources: ['vonMoltke', 'kasdorpBraking'], drills: ['crispBrake', 'pedalCal'],
    },
    brakeAfterTurn: {
      title: 'Brake added after turning in', icon: 'brake', phase: 'entry',
      cue: 'Make your speed call while the wheel is straight. If you\'re fast at your check point, squeeze harder there. Once you turn, the brake only comes off. If it\'s still too quick, apex a little later rather than braking more.',
      why: 'After turn-in the brake went back up, where the comparison lap only eased off. Kasdorp\'s trail braking is the more you steer, the less brake, and his fix for a missed apex is not braking harder but arriving slower next lap. With the wheel turned, the front tyres are already using their grip to turn, so extra brake there pushes the car wide.',
      sources: ['kasdorpTrail', 'kasdorpBasics'], drills: ['checkPoint', 'pedalCal'],
    },
    early: {
      title: 'Braking earlier and arriving slower', icon: 'brake', phase: 'entry',
      cue: 'Brake later and arrive at the turn-in faster. If you then have to let the brake off sooner to make the apex, that is speed you were leaving.',
      why: 'Most of the time lost on entry was gone before turn-in: the brakes went on well before the comparison lap\'s, or the car reached its turn-in clearly slower. Kasdorp\'s rule is: had to release more brake, arrive faster. Trail braking and brake build are not judged here, as the slower arrival explains them.',
      sources: ['kasdorpTrail', 'kasdorpBasics'], drills: ['oneCorner', 'refPoints'],
    },
    unusedOut: {
      title: 'Grip left unused on the way out', icon: 'grip', phase: 'exit',
      cue: 'Use the exit: let the car run out to the edge as the throttle goes down, rather than holding a tight line on part throttle.',
      why: 'On the way out this lap used a smaller share of the car\'s grip than the comparison lap without the throttle being clearly later, so the car was below its limit on exit. Kasdorp\'s aim is all four tyres at the limit through every phase, throttle included.',
      sources: ['kasdorpBasics', 'kasdorpThrottle'], drills: ['throttleTiming'],
    },
    pump: {
      title: 'Throttle on, off, on again', icon: 'throttle', phase: 'exit',
      cue: 'Throttle only goes up. If you had to lift, the first squeeze came before the car had rotated enough.',
      why: 'The throttle went down and came back up again more often than on the comparison lap. Kasdorp\'s throttle rule is to pick it up once, timed with the rotation, and never lift and re-apply.',
      sources: ['kasdorpThrottle'], drills: ['throttleTiming', 'oneCorner'],
    },
    exitOs: {
      title: 'Rear stepping out on exit', icon: 'os', phase: 'exit',
      cue: 'Match pedal to wheel: the more lock you hold, the less throttle the rear can take. Faster corners take a firmer throttle than slow ones.',
      why: 'The balance or wheel-speed channels flagged a slide or wheelspin on exit that the comparison lap did not have. Kasdorp lists too aggressive a pickup as the second throttle fault, and notes the slower the corner, the gentler the pickup has to be.',
      sources: ['kasdorpThrottle'], drills: ['throttleTiming'],
    },
    lock: {
      title: 'Locking a wheel', icon: 'lock', phase: 'entry',
      cue: 'To catch a lock, let well off the pedal, not just a little.',
      why: 'A wheel locked here that did not on the comparison lap. Kasdorp points out that recovering a lock needs a release well below the peak pressure, and that in iRacing riding the ABS also costs front grip and heats the tyres over a stint.',
      sources: ['kasdorpBraking'], drills: ['pedalCal', 'crispBrake'],
    },
    off: {
      title: 'Off track or wide', icon: 'off', phase: 'any',
      cue: 'If you were faster than the comparison lap here, arrive slower; if not, look further round the corner, by time rather than distance.',
      why: 'The lap left the track where the comparison lap did not. When the lap was also faster at the slowest point, that is shown, as speed is the likely cause. Otherwise the Autosport session and Driver61 both point at vision: eyes not far enough round the corner.',
      sources: ['autosport', 'driver61', 'kasdorpTrail'], drills: ['apex-snap', 'two-point'],
    },
    inconsistent: {
      title: 'Different every lap', icon: 'spread', phase: 'any',
      cue: 'Same speed, same spot, same angle at turn-in, every lap. Brake a touch earlier if that is what it takes.',
      why: 'Time on this stretch varies a lot from lap to lap. Kasdorp\'s first zone is about arriving at turn-in at the same speed, spot and angle every lap, and he says braking a little earlier for consistency is worth it, since the brake point matters least.',
      sources: ['kasdorpBasics'], drills: ['oneCorner', 'refPoints'],
    },
  };

  /** Drills for the next session. app: an IST drill id the button opens; else steps to do in the sim. */
  const DRILLS = {
    pedalCal: { name: 'Pedal calibration', how: 'Parked or on a straight: hit 70 to 90 % brake quickly without overshooting, then let it down to 5 to 10 % and hold it, without looking at the input display. Check, repeat.', sources: ['kasdorpTrail'] },
    oneCorner: { name: 'One-corner reps', how: 'Use the sim\'s reset to run the named corner again and again, changing one thing per run.', sources: ['kasdorpTrail', 'autosport'] },
    loseRear: { name: 'Find the edge on entry', how: 'On a slow corner, trail more brake each lap until the rear steps out on the brake alone, then dial back to just short of that.', sources: ['kasdorpBasics'] },
    releaseLadder: { name: 'Brake release experiments', how: 'Same brake point, a few laps each with a quicker and a slower release. Notice which lets the car turn with the least steering.', sources: ['bentleyData'] },
    turnInFeel: { name: 'Turn-in feel', how: 'A few laps paying attention only to turn-in: the wheel should get heavy, then the rear go light and follow, like a shopping cart\'s back wheels.', sources: ['kasdorpBasics'] },
    checkPoint: { name: 'Check-point laps', how: 'Pick a mark a few car lengths before turn-in. For a few laps the only goal is to make the speed call there, squeezing harder if needed, and never add brake once the wheel turns.', sources: ['kasdorpTrail', 'kasdorpBasics'] },
    crispBrake: { name: 'Back off and commit', how: 'Take a brake point you are sure of, go from full throttle to hard brake in one step, and only move deeper once that is crisp every lap.', sources: ['vonMoltke'] },
    throttleTiming: { name: 'Throttle timing', how: 'On the named corner, pick up 50 to 70 % in one movement as the car finishes rotating, then only add. Check the rotation from the chase camera: the rear wing against the mirror edge.', sources: ['kasdorpThrottle'] },
    exitFirst: { name: 'Exit-first laps', how: 'At the corner named, give up some entry speed on purpose. Count the lap a success when you reach full throttle sooner.', sources: ['driver61', 'kasdorpTrail'] },
    refPoints: { name: 'Same turn-in every lap', how: 'A few laps at a comfortable pace aiming only for the same speed, spot and angle at turn-in on the named corners.', sources: ['kasdorpBasics'] },
    'apex-snap': { app: 'apex-snap', name: 'Apex Snap', how: 'Here in the app: train moving your eyes on to the next apex early.', sources: ['driver61'] },
    'two-point': { app: 'two-point', name: 'Two-Point Focus', how: 'Here in the app: keep your eyes far while noticing what is near.', sources: ['autosport'] },
  };

  /** How the tab gives feedback, shown under "How this coaching works". */
  const PRINCIPLES = [
    ['Against the quickest lap through each corner, where it cost time', 'Each of your laps is compared, corner by corner, with the quickest lap through that corner: your own best there, or the reference lap if it was quicker. A check only counts where your lap lost time there, so a difference that cost nothing is not called a fault. The reference lap itself is never coached.', []],
    ['One or two things', 'In his data example Bentley picks just two changes from a lap, and would ideally give them one session each. The tab leads with one.', ['bentleyData']],
    ['Patterns, not every lap', 'Advice comes from what repeats across laps. Feedback after every attempt tends to make learners depend on it; summaries over several attempts are retained better.', ['guidance']],
    ['Cues about the car, not your body', 'Cues describe what the car should do or feel like. Focusing on the effect of a movement learns faster than focusing on the movement itself.', ['wulf']],
    ['Rotation over brake points', 'Kasdorp puts most of the lap time in getting the car to rotate between turn-in and apex, and calls the brake point the least important part.', ['kasdorpBasics', 'kasdorpTrail']],
    ['Exits onto straights first', 'Speed lost onto a long straight is carried down all of it, so those corners rank first.', ['driver61']],
    ['Practise in blocks, then reflect', 'Bentley: practise individual skills rather than chasing lap time, in blocks of about 20 minutes with breaks, and spend 5 to 10 minutes reflecting after a session.', ['bentleyPractice']],
  ];

  IST.Review.CoachKB = { SOURCES, PATTERNS, DRILLS, PRINCIPLES };
})();
