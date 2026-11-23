# iSlopTrain: sim-racing trainer (proof of concept)

> [!WARNING]
> ## ⚠️ This project is vibecoded
>
> **Almost all of the code in this repository was written by an AI coding assistant**, directed through prompts rather than typed by hand. Treat it as experimental software: expect rough edges, and review anything before you reuse it.
>
> ### AI disclosure rating: **AI-dev-B**
>
> Rated on the scale proposed by Benn Jordan in [*We Should Standardize Vibe Coding Ethics*](https://www.bennjordan.com/blog/we-should-standardize-vibe-coding-ethics). **AI-dev-B** means AI-written code is used throughout the software, including in areas that an experienced developer could not fully verify or understand.
>
> | Rating | Meaning (summarised) |
> |---|---|
> | NoAI | No AI used at all |
> | AI-aux | AI used only for auxiliary tasks (workflow, tooling); no AI-written code |
> | AI-UI | AI-written code limited to the UI or graphics |
> | AI-dev-A | AI-written code throughout, verified and understood by an experienced developer |
> | **AI-dev-B** ◀ | **AI-written code throughout, including parts the developer can't fully verify** |
> | AI-dev-C | Mostly AI-written, supervised by a novice developer |
> | AI-V | Entirely AI-written; support depends on AI |

A growing suite of short, adaptive sim-racing training drills, grouped into three tabs:

- **Vision:** getting your eyes to the next apex early and keeping attention wide.
- **Mind:** holding the apex under threat, recovering from a run of mistakes and reading the racing line.
- **Reflex:** start reactions and a daily readiness check.

The drills draw on driver eye-tracking research, sport psychology, vehicle-dynamics modelling and established motor-learning principles. More modules are planned. See [docs/METHODOLOGY.md](docs/METHODOLOGY.md).

No dependencies, no build step: plain HTML + Canvas 2D + classic scripts.

## Run it

Open `index.html` in Chrome/Edge (works from `file://`), or serve the folder:

```powershell
python -m http.server 8765
```

then go to http://localhost:8765. Run fullscreen on the monitor you race on and set each drill's FOV to match your sim.

## Drills

| Drill | Tab | Trains | Primary metric |
|---|---|---|---|
| **Start Lights** (warm-up) | Reflex | Alertness, simple visual reaction, no anticipating | Median reaction (ms) |
| **Two-Point Focus** | Vision | Far fixation + peripheral near-field awareness (UFOV-style) | Exposure threshold (ms) |
| **Apex Snap** (core) | Vision | "Clip the apex → eyes to the next apex" reflex at speed, optional peripheral dual task | Flash threshold (ms), Snap score |
| **Apex Snap: Race Mode** (under load) | Vision | The same reflex with traffic (brake lights, car alongside), a relative timing box, dash (shift lights, delta, warnings), engineer radio, spotter calls, optional engine/speech audio. Confirm only for threats (go/no-go) | Load cost (ms), threats caught |
| **Eyes Off the Wall** | Mind | Holding the apex while a threat on the outside competes for your eyes: walls, wrecks, waved yellows, spinning cars. Threat level adapts between sessions. Optional self-talk comparison | Eyes captured (%), threat cost |
| **Clean Slate** | Mind | Recovering from a run of errors. Rhythm-game lane: rows of arrows scroll to a hit line on a beat; press the blue arrow's direction (orange = opposite) in the hit window, with a chain multiplier and timing grades. Unannounced bursts (squeeze, rush, clutter, flip, double hit) force real mistakes, then difficulty snaps back so the dip afterwards is yours. Burst and distraction ladders (1-6) adapt between sessions. Optional reset cue | Recovery (rows), error chaining, post-error shift |
| **Pick the Line** | Mind | Reading the racing line. A corner complex from above with 4 or 6 lines; pick the fastest to the end of the straight. Wrong lines are real mistakes (early / late turn-in, narrow entry, missed apex, narrow exit, the wrong corner prioritised) with their time loss computed by a lap-time model, and they get closer to the ideal as the level rises. After each answer, replay any line from the driver's seat beside the top-down view and a speed trace, paused at braking, turn-in, apex and track-out | Line level, fastest line found (%) |

Circuits are generated fresh each run from a corner vocabulary: kinks, sweepers, tight corners, hairpins, decreasing- and increasing-radius corners, chicanes, esses and double apexes. Each driving drill also has **Track** (Mixed / Technical / Fast) and **Elevation** (Flat / Rolling / Hilly, with blind crests and compressions) settings. The corner types, mixes and elevation profiles are defined in `track.js` (`CORNER_TYPES`, `MIXES`, `ELEVATION`).

Guided sessions chain drills: **Daily** (~8 min), **Race pressure** (~7 min) and **Pre-drive** (~3 min).

Controls: arrows / WASD to answer, Space / Enter to confirm, Esc to pause, **F** to toggle fullscreen (never automatic unless enabled under Data). Standard gamepads work automatically. Wheels and button boxes can be bound under **Controls** (buttons, POV hats, axes).

**Game feel:** every drill builds a chain with multiplier tiers, scores points (with bonuses for early snaps, short flashes and fast starts), plays rising tones and calls out new best chains and PB pace. The results screen grades each session S / A / B / C against your own history, with record badges, a score count-up and a short highlight on records. **Data → Game feel** sets Full, Silent or Off; "summary only" feedback keeps it hidden during a drill. Design rules: METHODOLOGY section 5c.

## Stats page

**Stats** in the header (or **Full stats →** on any results screen) opens an aim-trainer-style dashboard:

- **Filters:** time range (7 / 30 / 90 days / all) and drill. They scope everything below them.
- **Overview:** sessions, training time, active days, current streak, and an activity calendar.
- **Notes:** what got better or worse (recent block vs the previous block), new personal bests, plateaus, consistency, and readiness ("slower than your norm today").
- **Work on in-sim:** prioritised advice for real driving, generated from your weakest areas, with the evidence behind each item and a button to keep training it. Examples: early-flash misses, weak corner types (hairpins, chicanes, decreasing radius…), left/right asymmetry, high-speed corners, blind crests, tunnel vision, HUD load cost, missed spotter threats, jump starts.
- **Per-drill deep dive:** primary metric (sessions plus 5-session average, PB marked), small multiples for every other metric, weak-spot breakdowns, and a full session table.

Apex Snap breakdowns: accuracy by flash timing, corner type, left/right, approach speed and blind crest. Eyes Off the Wall: where your eyes were on hazard probes, clean vs hazard corners, accuracy and capture by hazard type, sudden vs already-there hazards, and capture by self-talk cue. Pick the Line: accuracy by corner complex and which wrong lines you pick most. Clean Slate: recovery curves (accuracy and speed for the 8 rows after a burst, recent vs earlier sessions), rows to recover by burst type, error rate after a correct answer vs after an error, blue vs orange accuracy, accuracy by distraction type, and reset cue vs none. Two-Point Focus: far vs peripheral, and flag side. Start Lights: reaction-time distribution.

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
js/components/hazard-layer.js  outside-of-corner threats with a decoy board (walls, wrecks, yellows, spins), threat levels
js/components/juice.js  shared game feel: chain tiers, score, grades, tones, callouts
js/components/line-lab.js  corner complexes, lap-time model, minimum-time line solver, flawed lines, top-down drawing
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

Variants can share one `create()`: `apex-snap.js` registers a base definition and a Race Mode copy (`Object.assign({}, BASE, RACE)`) that sets `raceMode: true` and adds settings/metrics. `IST.RaceLayer` can be bolted onto any driving drill the same way. `eyes-off-wall.js` does the same from another tab: it copies `IST.ApexSnap.BASE`, sets `hazardMode: true` and `tab: 'mind'`, and supplies `levelFor()` and `hazardSummary()` for `IST.HazardLayer`.

Each drill instance exposes `debug()` for dev-tools inspection and automated checks.

## Data

Stored in this browser's localStorage under `isloptrain.v1` (session summaries, recent per-trial detail, settings, bindings).
