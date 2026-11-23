/*
 * Guided sessions: ordered playlists of drills with per-step setting overrides.
 * Structure follows a warm-up -> general -> specific progression, kept short
 * (spaced, frequent practice beats long blocks; Cepeda et al., 2006).
 */
(function () {
  'use strict';

  IST.registerSession({
    id: 'daily',
    name: 'Daily',
    minutes: '~8 min',
    steps: [
      { drill: 'start-lights', settings: { trials: 6 } },
      { drill: 'two-point', settings: { trials: 30 } },
      { drill: 'apex-snap', settings: { duration: 180 } },
    ],
  });

  IST.registerSession({
    id: 'race-load',
    name: 'Race pressure',
    minutes: '~7 min',
    steps: [
      { drill: 'start-lights', settings: { trials: 5 } },
      { drill: 'apex-snap', settings: { duration: 120 } },
      { drill: 'apex-race', settings: { duration: 180 } },
    ],
  });

  IST.registerSession({
    id: 'pre-race',
    name: 'Pre-drive',
    minutes: '~3 min',
    steps: [
      { drill: 'start-lights', settings: { trials: 5 } },
      { drill: 'apex-snap', settings: { duration: 120, feedback: 'every' } },
    ],
  });
})();
