/*
 * Guided sessions: ordered playlists of drills with per-step setting overrides.
 * Structure follows a warm-up -> general -> specific progression, kept short
 * (spaced, frequent practice beats long blocks; Cepeda et al., 2006).
 *
 * Each session has a `group` (its section on the Sessions tab, in first-seen
 * order) and a one-line `blurb`. A session whose drills aren't all registered
 * is left off the menu, so playlists can name drills that are still in progress.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------ quick
  IST.registerSession({
    id: 'pre-race',
    group: 'Quick',
    name: 'Pre-drive',
    minutes: '~3 min',
    blurb: 'Wake up your reactions and put your eyes on the apex, right before you get in the car.',
    steps: [
      { drill: 'start-lights', settings: { trials: 5 } },
      { drill: 'apex-snap', settings: { duration: 120, feedback: 'every' } },
    ],
  });

  IST.registerSession({
    id: 'line-check',
    group: 'Quick',
    name: 'Line check',
    minutes: '~5 min',
    blurb: 'Plan the line through a few complexes, then go looking for the apexes at speed.',
    steps: [
      { drill: 'racing-line', settings: { questions: 4 } },
      { drill: 'apex-snap', settings: { duration: 120 } },
    ],
  });

  IST.registerSession({
    id: 'reset',
    group: 'Quick',
    name: 'Reset',
    minutes: '~4 min',
    blurb: 'Between races: shake off a bad stint, then a clean set of starts.',
    steps: [
      { drill: 'clean-slate', settings: { duration: 150, resetCue: true } },
      { drill: 'start-lights', settings: { trials: 5 } },
    ],
  });

  // ------------------------------------------------------------ daily
  IST.registerSession({
    id: 'daily',
    group: 'Daily',
    name: 'Daily vision',
    minutes: '~8 min',
    blurb: 'The core gaze routine: reactions, two-point focus, then apex snaps.',
    steps: [
      { drill: 'start-lights', settings: { trials: 6 } },
      { drill: 'two-point', settings: { trials: 30 } },
      { drill: 'apex-snap', settings: { duration: 180 } },
    ],
  });

  IST.registerSession({
    id: 'daily-mind',
    group: 'Daily',
    name: 'Daily mind',
    minutes: '~10 min',
    blurb: 'Racecraft and composure: draw the line, hold your eyes off the wall, recover from errors.',
    steps: [
      { drill: 'racing-line', settings: { questions: 5 } },
      { drill: 'eyes-off-wall', settings: { duration: 180 } },
      { drill: 'clean-slate', settings: { duration: 180 } },
    ],
  });

  IST.registerSession({
    id: 'full-circuit',
    group: 'Daily',
    name: 'Full circuit',
    minutes: '~15 min',
    blurb: 'One pass through every trainer, from simple to demanding. For days with more time.',
    steps: [
      { drill: 'start-lights', settings: { trials: 5 } },
      { drill: 'two-point', settings: { trials: 30 } },
      { drill: 'apex-snap', settings: { duration: 150 } },
      { drill: 'eyes-off-wall', settings: { duration: 180 } },
      { drill: 'clean-slate', settings: { duration: 180 } },
    ],
  });

  // ---------------------------------------------------------- pressure
  IST.registerSession({
    id: 'race-load',
    group: 'Pressure',
    name: 'Race pressure',
    minutes: '~7 min',
    blurb: 'Build the apex habit, then keep it with traffic, radio and spotter calls.',
    steps: [
      { drill: 'start-lights', settings: { trials: 5 } },
      { drill: 'apex-snap', settings: { duration: 120 } },
      { drill: 'apex-race', settings: { duration: 180 } },
    ],
  });

  IST.registerSession({
    id: 'composure',
    group: 'Pressure',
    name: 'Composure',
    minutes: '~9 min',
    blurb: 'Threats on the outside, a busy race, then errors you have to let go of.',
    steps: [
      { drill: 'eyes-off-wall', settings: { duration: 180 } },
      { drill: 'apex-race', settings: { duration: 180 } },
      { drill: 'clean-slate', settings: { duration: 180, resetCue: true } },
    ],
  });

  IST.registerSession({
    id: 'racecraft',
    group: 'Pressure',
    name: 'Racecraft',
    minutes: '~10 min',
    blurb: 'Work out the line, then hold it in clean air and in traffic.',
    steps: [
      { drill: 'racing-line', settings: { questions: 6 } },
      { drill: 'apex-snap', settings: { duration: 120 } },
      { drill: 'apex-race', settings: { duration: 180 } },
    ],
  });
})();
