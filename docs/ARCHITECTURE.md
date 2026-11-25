# Architecture

A guide for whoever maintains this next. It covers how the pieces fit together; each file's header comment covers what that file does, and [METHODOLOGY.md](METHODOLOGY.md) covers why the drills are built the way they are.

## The shape of it

- **No build, no dependencies.** Every file is a classic `<script>` loaded by `index.html`, so the app runs from `file://` or any static server. There are no ES modules and no bundler.
- **One global, `window.IST`.** Each file is an IIFE (`(function () { 'use strict'; … })();`) that reads what it needs from `IST` and adds what it provides. For example, `track.js` sets `IST.Track` and `IST.TrackRenderer`, and `line-lab.js` sets `IST.LineLab`.
- **Load order is the dependency graph.** A file may use, *at load time*, only what loaded before it in `index.html`. At run time (inside functions) anything is available. If you add a file, put its `<script>` after everything it reads at load time.
- **Drills are plugins.** A drill calls `IST.registerDrill(def)`. The menu card, settings form, info panel, results table, deltas, trend line and Stats page are all generated from `def`. The app shell rarely needs to change when a drill is added.

## Layers (in load order)

| Layer | Files | Owns |
|---|---|---|
| core | `js/core/` | namespace + registry (`ist.js`), helpers (`util.js`), persistence (`storage.js`), adaptive staircase, input → abstract actions, the drill runner (canvas, loop, pause), Stats analysis and the history helpers drills share (`analysis.js`) |
| render | `js/render/` | arrows/text/HUD primitives (`symbols.js`), the palette and page-style canvas widgets (`canvas-ui.js`), procedural circuits + pseudo-3D renderer (`track.js`), vector cockpit (`cockpit.js`), shared in-car view settings (`view.js`) |
| components | `js/components/` | models and layers shared by several drills (below) |
| drills | `js/drills/` | one file per small drill, one folder per large one |
| sessions | `js/sessions.js` | guided playlists: drill + setting overrides per step |
| app / ui | `js/app.js`, `js/ui/` | menu, settings, controls, data, results; Stats page; charts; View screen |
| review | `js/review/` | the Review tab's 3D lap viewer (below). Not a drill: it saves nothing and has no results |

### Shared components

| Component | What it is | Used by |
|---|---|---|
| `IST.LineLab` | corner complexes, a quasi-steady-state lap-time model, the minimum-time line solver, flawed lines, the corner-by-corner verdict, top-down drawing | Draw the Line, Class Traffic (through TrafficLab) |
| `IST.TrafficLab` | a prototype and a GT (plus an optional third car) on one complex, calibrated to IMSA/WEC class gaps, car following, contact/squeeze/cut-off detection, question generation | Class Traffic |
| `IST.Track` / `IST.TrackRenderer` | generated circuits and the in-car renderer | Apex Snap family, Two-Point Focus, the replays, View screen |
| `IST.RaceLayer` | traffic, relative box, dash, radio/spotter, audio | Apex Snap: Race Mode; `drawCar` is reused by the replays |
| `IST.HazardLayer` | threats on the outside of corners (walls, wrecks, yellows, spins), and the live-hazard call windows | Eyes Off the Wall, Call the Hazard |
| `IST.Theme` / `IST.CanvasUI` | the one palette (slate and pastels as in `css/style.css`, plus the hit / miss / gold signals), and canvas widgets in the page's style: backdrop, box, pane, caps label, key cap, button, wrapped text, hit-testing | Draw the Line and Class Traffic screens; signal colours in every drill |
| `IST.Juice` | chain, multiplier tiers, score, grades, tones, callouts | every drill (Clean Slate draws its own chain from Juice's tiers and sounds) |
| `IST.View` / `IST.Cockpit` | FOV, horizon, seat position, cockpit drawing; the one rule for whether a trackside board can take a flash (`IST.View.board`) | every drill with `usesView: true`; flash validity in the Apex Snap family, hazard probes, Two-Point and the View screen |

## A session, end to end

1. **Start.** The menu calls `startDrill(def, overrides)` in `app.js`. Settings are the drill's defaults, overlaid by the saved settings, overlaid by a guided session's overrides.
2. **Run.** `IST.Runner.run(def, settings)` owns the canvas and the `requestAnimationFrame` loop. It calls `def.create(ctx)` once, then each frame `update(dt, clock, ts)` (skipped while paused) and `render(g, W, H, ts, paused)`, and passes input to `onAction(action, t, src)`. `ctx` gives the drill its settings, `history` (its past results), `W`/`H`, `clock()` (unpaused ms), `frameInterval()` and `finish()`.
3. **Finish.** The drill calls `ctx.finish()`, or the player picks Finish from the pause menu. The runner calls `result()`, stamps it with date, drill id, settings, duration and refresh rate, and resolves.
4. **Save.** `IST.Storage.addResult` appends it to localStorage (`isloptrain.v1`). Only the latest 300 sessions per drill are kept, and only the latest 50 keep their per-trial `detail`.
5. **Results screen.** Built from `def.metrics` and `result.summary`, with deltas against the previous session and tips from `def.coach(summary, result, history)`.
6. **Stats page.** `IST.Analysis.drillReport(def, results)` does the generic work (trends, PBs, consistency) from `def.metrics`, then merges in `def.analyze(results, A)` for drill-specific breakdowns, notes and in-sim advice.

### The drill definition

Required: `id`, `name`, `create(ctx)`. Commonly also `tab` (`vision` | `mind` | `reflex`), `category`, `tagline`, `description`, `research`, `info`, `settings`, `metrics` (one marked `primary`), `levelFor`, `coach`, `analyze`, `pointer: true` (the drill is clicked or drawn in, so the cursor is never hidden), and `usesView: true` (it shows the in-car view). The README has a minimal example.

The instance from `create(ctx)` implements `update`, `render`, `onAction` and `result`, plus optionally `onPause`, `onResume`, `destroy` and `debug()`. `debug()` exposes internal state for dev tools and the tests.

### Saved data is long-lived

`result.summary` is what Stats reads, possibly years later. **Renaming or repurposing a summary key silently breaks history**: old sessions show as missing, and trend lines restart. Add new keys instead, and handle old ones in `analyze` if needed. Draw the Line does this already: it filters out old multiple-choice sessions by `summary.mode`. There is no schema version or migration step yet.

## Large drills are folders

Draw the Line, Class Traffic and Clean Slate are each split across a folder under `js/drills/`. The files share a private namespace (`IST.RacingLine`, `IST.Multiclass`, `IST.CleanSlate`) and load in the order listed in that folder's `content.js`. They follow the same roles:

| File | Role | State |
|---|---|---|
| `content.js` | palette, timings, labels, text and grading. Plain data and pure functions | none |
| `ui.js` (Class Traffic) | the widgets only that drill uses (verdict glyphs, livery chip), added to the shared `IST.CanvasUI` set | none |
| `replay.js` | the replay timeline: which moments to pause on, and stepping through them | works on the replay object it's given |
| `scene.js` | the top-down map and the in-car view | none; `createScene(env)` binds view settings, and the question and replay come in as arguments |
| `screens.js` | each screen of the drill (picker, quiz/drawing, result, replay) | reads the drill state, calls back through `act`, and writes only hit boxes and the drawing area for input |
| `stats.js` | `coach` and `analyze`; for Clean Slate also the session summary | none |
| `drill.js` | the definition, session state, flow, input and `result()` | owns it |
| `sketch.js` (Draw the Line) | turning pointer strokes into a drawn line | works on the drill state |
| `view.js` (Clean Slate) | all drawing | reads a live `run` object (getters over the engine's variables) |

The rule of thumb: **`drill.js` owns the state and changes it; everything else is handed what it needs.** When something looks wrong on screen, start in `screens.js` or `scene.js`. When the flow or the scoring is wrong, start in `drill.js`. When the wording or a grade is wrong, start in `content.js`.

Smaller drills stay as single files. When one grows past a few hundred lines with distinct parts, split it the same way.

### Variants share a `create()`

`apex-snap.js` registers a base definition and a Race Mode copy (`Object.assign({}, BASE, RACE)`) with `raceMode: true`. `eyes-off-wall.js` copies `IST.ApexSnap.BASE` with `hazardMode: true`. One engine serves three menu entries, so a change to Apex Snap's `create()` affects all three.

## Background work

Solving a racing line takes seconds, so it's written as a generator that `yield`s every so often (`LineLab.solveGen`, `TrafficLab.complexGen` / `questionGen`, each drill's `questionGen`). The drill's `pump()` runs it for a fixed budget of milliseconds per frame (`BUDGET`), so the next question builds while you answer the current one. For synchronous use, as in the tests, `LineLab.run(gen)` drives a generator to completion.

### Helpers every drill shares

Reach for these before writing a loop over `ctx.history` or a new counter:

- `IST.Analysis.latest(history, ...keys)`: where a level or threshold carries over from (the newest session that has one). `IST.Analysis.best(history, key, better)`: the record to beat.
- `IST.Analysis.tally(rows, keyFn, hitFn)` and `count(tally, key, hit)`: the `{ bucket: [n, hits] }` shape that `sumTallies` and `items` read back on the Stats page.
- `IST.Analysis.lastN(results)`: the "Last N sessions" subtitle.
- `Sym.hud(g, text, x, align)`: the session readout in a top corner (time left, trial count, speed).
- `IST.Theme.hit` / `.miss` / `.gold`: right, wrong, and records or selection. Don't type the hex.

## The Review tab (`js/review/`)

A telemetry viewer, kept apart from the drills. Nothing outside the folder depends on it except three lines in `app.js` (screen, tab, card buttons) and `css/review.css`.

| Path | Role |
|---|---|
| `telemetry/common.js` | `IST.Telemetry`: the factory registry, channel aliases, unit conversion, the common session record, `T.LAP_CHANNELS` (every channel a lap carries) and `T.STEP_CHANNELS` (resampled by nearest, never blended) |
| `telemetry/ibt.js`, `motec.js`, `csv.js` | one parser per format, each producing that session record |
| `telemetry/derive.js` | handling channels worked out at the native rate before laps are cut: balance (understeer angle, steering gain fitted per stint), sideslip and its excess, wheel slip, grip used, coasting, entry/mid/exit phase; `T.events(lap)` turns them into per-lap events (understeer, oversteer, lockups, ABS, kerbs...) |
| `telemetry/laps.js` | positions (world, GPS, or dead-reckoned), lap boundaries, resampling every metre; `T.process(name, buf)` is the whole pipeline for one file |
| `telemetry/loader.js` | `IST.Telemetry.load(files)`: runs the pipeline in a Web Worker |
| `track.js` | map geometry, no network: the true centreline under a lap from OSM raceway lines, and the rigid fit that places non-GPS laps on them |
| `mapdata.js` | the only network code, behind the Map option: OSM raceways (Overpass), track-name lookup (Nominatim), Esri imagery tiles; raceways cached in localStorage |
| `compare.js` | lines laps up on the reference's distance grid; delta, time gain rate, events, gear shifts, track centre (map or laps), each lap's offset from it, corners and complexes (for the apex cameras) |
| `demo.js` | a generated session as CSV text, for trying the viewer |
| `garage61.js` | the Garage 61 import panel: a guided CSV drop, and an optional bookmarklet bridge. Garage 61's API sends no CORS headers, so the bookmarklet runs on garage61.net (same-origin API calls with the user's personal token, serial and rate-limit aware) and posts lap CSVs back to the tab that opened it; this page only accepts them from that tab, from garage61.net, with a per-connection nonce. The token never reaches this page. The bookmarklet is `bridge()` stringified, so like the telemetry factories it may use nothing outside its own body |
| `conditions.js` | the compared laps' track conditions (`lap.cond`, from the parsers) and which differ past a tolerance, for the Conditions panel |
| `stance.js` | how a car's body sits on the road at a point on a lap: dive, roll and heave from ride heights, or estimated from g by car type |
| `layers.js` | what the 3D view can draw on the laps: line-colour maps, fence choices, the marker catalogue (attitude: body slip from vx / vy), event labels |
| `gl/` | the WebGL layer: `math.js` (matrices), `renderer.js` (a flat-colour and a textured shader, buffers, draw list), `camera.js` (orbit, and easing toward a follow rig), `rigs.js` (where each follow camera wants to be: chase, top, side, apex, complex), `scene.js` (track, lines (painted by a channel or in lap colour), fences (inputs, balance, grip, one lap's delta), event halos, gear posts, attitude arrows and slip wedges from a comparison), `cars.js` (a low-poly model per car type, placed on the road with the body's dive, roll and heave from `stance.js`), `maplayer.js` (satellite tiles draped on a terrain built from the track's heights) |
| `traces.js` | the 2D trace strip under the 3D view: a lane registry (catalogue order, per-tyre picks, ABS / coasting / balance shading) |
| `overlay.js` | the 2D labels over the 3D view: car chips with the gap, cursor posts, event pips and chips, lap tags, gear numbers; labels fade rather than pop |
| `page.js` | `IST.Review.open()`: the page, lap list, lanes box, Layers drawer, cursor readout, and the glue between them |

**Telemetry files are factories.** Each file in `telemetry/` (except `loader.js`) registers `function (T) { … }` with `IST.Telemetry.def`, and may use nothing outside its own body: `loader.js` stringifies them into a Blob Worker so a 100 MB `.ibt` parses off the main thread and it still works from `file://`. The tests run the same source in a bare sandbox to keep that true. To add a format, add a factory that sets `T.formats.<name> = { label, exts, sniff, parse }` returning `T.session(...)`, and a `<script>` before `laps.js`.

**The cursor is an index on the reference lap's grid.** The stage, the traces and the readout all take it; `page.js` owns it. The 3D view also keeps a fractional copy (`cursorF`) so playback and the follow cameras move smoothly between metres; cars are placed by time (where each lap was when the reference reached the cursor), posts and the readout by distance.

## Conventions

- **File header comments** say what the file models, its public surface, its limits, and the research it rests on. Keep them current when behaviour changes.
- **Units:** metres, seconds and m/s inside the models; ms for timing; km/h only in display text. On a complex, `s` is metres along the centreline and `n` is lateral position (−1 left edge, +1 right edge; ×`HW` for metres).
- **Seeded randomness:** use `U.rng(seed)` rather than `Math.random()` in anything a test or replay might want to reproduce.
- **Settings types:** `number` (with `min`/`max`/`step`), `select` (with `options: [[value, label], …]`) and `bool`.

## Tests

```powershell
node --test
```

See [tests/README.md](../tests/README.md) for what belongs there. In short, tests pin claims the app makes to the player: the staircase finds the threshold it reports, the ideal line really is fastest, Class Traffic's "responsible call" is safe and allowed, saved history is trimmed only as documented, and guided sessions name real drills and settings. `drills.test.js` plays every drill headless through a short session with scripted input, and is the safety net for refactoring. If you rename something a drill's render path uses, it fails there.

## Known rough edges

- **World and car colours are still literals.** Screens and feedback use `IST.Theme`, but the track themes, `cockpit.js`, `race-layer.js` and `hazard-layer.js` paint the scenery, liveries and dash with their own hex values. They're pictures of things rather than UI, so they were left alone.
- **Clean Slate keeps its own chain and score.** It uses Juice's tiers and sounds but counts the chain itself, because it runs on the drill clock (so a pause can't break timing) and charges a rising penalty for errors in a row. If another drill needs either, move them into `IST.Juice` rather than copying.
- **The in-session level ladder is written twice.** Draw the Line and Class Traffic each step their level 2-down / 1-up in a few lines of `drill.js`.
- **No schema version on saved data** (see above).
- **Analysis thresholds** (minimum counts, "weak spot" margins) live inline in `analysis.js` and each drill's `analyze`, with their reasoning in comments.
