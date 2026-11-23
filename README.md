# iSlopTrain: Vision Trainer (proof of concept)

The first module of a planned suite of sim-racing training tools. It trains the habit of **getting your eyes to the next apex early** and keeping attention wide, using short adaptive drills based on driver eye-tracking research and established motor-learning principles. See [docs/METHODOLOGY.md](docs/METHODOLOGY.md).

No dependencies, no build step: plain HTML + Canvas 2D + classic scripts.

## Run it

Open `index.html` in Chrome/Edge (works from `file://`), or serve the folder:

```powershell
python -m http.server 8765
```

then go to http://localhost:8765. Run fullscreen on the monitor you race on and set each drill's FOV to match your sim.

## Drills

| Drill | Trains | Primary metric |
|---|---|---|
| **Start Lights** (warm-up) | Alertness, simple visual reaction, no anticipating | Median reaction (ms) |
| **Two-Point Focus** | Far fixation + peripheral near-field awareness (UFOV-style) | Exposure threshold (ms) |
| **Apex Snap** (core) | "Clip the apex → eyes to the next apex" reflex at speed, optional peripheral dual task | Flash threshold (ms), Snap score |
| **Apex Snap: Race Mode** (under load) | The same reflex with traffic (brake lights, car alongside), a relative timing box, dash (shift lights, delta, warnings), engineer radio, spotter calls, optional engine/speech audio. Confirm only for threats (go/no-go) | Load cost (ms), threats caught |

Circuits are generated fresh each run from a corner vocabulary: kinks, sweepers, tight corners, hairpins, decreasing- and increasing-radius corners, chicanes, esses and double apexes. Each driving drill also has **Track** (Mixed / Technical / Fast) and **Elevation** (Flat / Rolling / Hilly, with blind crests and compressions) settings. The corner types, mixes and elevation profiles are defined in `track.js` (`CORNER_TYPES`, `MIXES`, `ELEVATION`).

Guided sessions chain drills: **Daily** (~8 min), **Race pressure** (~7 min) and **Pre-drive** (~3 min).

Controls: arrows / WASD to answer, Space / Enter to confirm, Esc to pause, **F** to toggle fullscreen (never automatic unless enabled under Data). Standard gamepads work automatically. Wheels and button boxes can be bound under **Controls** (buttons, POV hats, axes).

## Stats page

**Stats** in the header (or **Full stats →** on any results screen) opens an aim-trainer-style dashboard:

- **Filters:** time range (7 / 30 / 90 days / all) and drill. They scope everything below them.
- **Overview:** sessions, training time, active days, current streak, and an activity calendar.
- **Notes:** what got better or worse (recent block vs the previous block), new personal bests, plateaus, consistency, and readiness ("slower than your norm today").
- **Work on in-sim:** prioritised advice for real driving, generated from your weakest areas, with the evidence behind each item and a button to keep training it. Examples: early-flash misses, weak corner types (hairpins, chicanes, decreasing radius…), left/right asymmetry, high-speed corners, blind crests, tunnel vision, HUD load cost, missed spotter threats, jump starts.
- **Per-drill deep dive:** primary metric (sessions plus 5-session average, PB marked), small multiples for every other metric, weak-spot breakdowns, and a full session table.

Apex Snap breakdowns: accuracy by flash timing, corner type, left/right, approach speed and blind crest. Two-Point Focus: far vs peripheral, and flag side. Start Lights: reaction-time distribution.

Per-trial detail is stored for the latest 50 sessions of each drill, and summaries for the latest 300. Drills plug into the stats page through an optional `analyze(results, A)` on their definition (see `js/core/analysis.js`).

## Structure

```
index.html            page shell + script order
css/style.css         styles + type scale (Allo variable font, weight/roundness axes)
fonts/allo/           Allo by Josh Puckett (SIL OFL 1.1, see OFL.txt)
js/core/ist.js        namespace (window.IST) + drill/session registry
js/core/util.js       math, stats, seeded RNG, DOM helper
js/core/storage.js    localStorage persistence (summaries, settings, bindings)
js/core/staircase.js  adaptive 2-down/1-up staircase
js/core/input.js      keyboard + gamepad/wheel -> abstract actions, binding learner
js/core/runner.js     canvas, loop, pause, drill lifecycle
js/core/analysis.js   trends, PBs, weak spots, in-sim advice library (TIPS)
js/ui/charts.js       dependency-free SVG charts (line, bars, histogram, calendar) with hover tooltips
js/ui/stats.js        Stats page
js/render/symbols.js  arrows, pattern masks, boards, flags, HUD text
js/render/track.js    procedural circuit + speed profile + racing line + pseudo-3D renderer (themes)
js/components/race-layer.js  reusable race clutter: traffic, relative box, dash, radio/spotter, audio
js/drills/*.js        one file per drill
js/sessions.js        guided session playlists
js/app.js             menu, settings, controls, data, results (all generated from definitions)
```

## Adding a drill (or an alternative interface)

Create `js/drills/my-drill.js`, add a `<script>` tag before `sessions.js`, and register it:

```js
IST.registerDrill({
  id: 'my-drill', name: 'My Drill', category: 'Core', tagline: '…', description: '…',
  research: [{ point: '…', source: '…' }],
  settings: [{ key: 'trials', label: 'Trials', type: 'number', default: 30, min: 5, max: 100 }], // number | select | bool
  metrics: [{ key: 'threshold', label: 'Threshold', unit: 'ms', digits: 0, better: 'lower', primary: true }],
  coach(summary) { return ['tip…']; },
  create(ctx) {               // ctx: settings, history, W, H, clock(), frameInterval(), finish()
    return {
      update(dt, clock, ts) {},
      render(g, W, H, ts, paused) {},
      onAction(action, t) {},  // 'up'|'down'|'left'|'right'|'confirm'
      onPause() {},
      result() { return { summary: { threshold: 123 } }; },
    };
  },
});
```

The menu card, settings form, "why it works" panel, results table, deltas vs last session, trend line and coaching all come from the definition. To try a different look for an existing drill, either add a theme to `THEMES` in `track.js` (exposed via the `style` setting) or copy the drill file under a new `id` and change its rendering.

Variants can share one `create()`: `apex-snap.js` registers a base definition and a Race Mode copy (`Object.assign({}, BASE, RACE)`) that sets `raceMode: true` and adds settings/metrics. `IST.RaceLayer` can be bolted onto any driving drill the same way.

Each drill instance exposes `debug()` for dev-tools inspection and automated checks.

## Data

Stored in this browser's localStorage under `isloptrain.v1` (session summaries, recent per-trial detail, settings, bindings).
