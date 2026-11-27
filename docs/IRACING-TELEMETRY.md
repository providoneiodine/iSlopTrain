# iRacing telemetry: how it works underneath

Notes for the Lap Viewer's `.ibt` support and for any live-session work. Checked on 2026-11-27 against the sources at the end and against real `.ibt` files (Spa 992 Cup, Road America FR2.0).

## Recording

- **Alt+L** arms telemetry at any time; you don't need to be in the car. The on-screen icon lights when you enter the car, and recording runs only while you are in it.
- Each time you enter the car a **new file** is started in `Documents\iRacing\telemetry\`, named `car_track session date time.ibt`. Leaving the car (Esc to garage, tow, end of session) closes it.
- Recording can also be toggled by another program through the SDK broadcast message `irsdk_BroadcastTelemCommand` (stop 0, start 1, restart 2 = close this file and start a new one).
- Disk telemetry is **60 Hz**. A few channels carry 360 Hz sub-samples as 6-element arrays with an `_ST` suffix (seen: `SteeringWheelTorque_ST[6]`). The `irsdkLog360Hz` app.ini switch some forums mention is about the live feed for force-feedback tools; it is not documented by iRacing and we haven't relied on it.
- iRacing's own guide (the Atlas quickstart) only covers loading `.ibt` into McLaren ATLAS. Its useful idea is ATLAS's `TDiff`: time difference between two laps plotted against distance, which is what our delta lane already does.

## The `.ibt` layout

Same structs as the live shared memory (`irsdk_defines.h`), little-endian:

| Offset | What |
|---|---|
| 0 | `irsdk_header`, 112 B: ver (2), status, tickRate (60), sessionInfoUpdate, sessionInfoLen, sessionInfoOffset, numVars, varHeaderOffset, numBuf (1 on disk), bufLen, varBuf[0].bufOffset at byte 52 |
| 112 | `irsdk_diskSubHeader`: sessionStartDate (time_t), startTime, endTime (double), lapCount, recordCount |
| 144 | numVars × 144 B var headers: type, offset, count, countAsTime, name[32], desc[64], unit[32] |
| sessionInfoOffset | session YAML (weekend, drivers, setup) |
| bufOffset | recordCount × bufLen bytes, one row per 60 Hz tick |

Measured: the YAML sits **before** the data (`sessionInfoOffset + sessionInfoLen == bufOffset` in both files), so the file only grows at the end while recording. The disk sub-header's endTime, lapCount and recordCount are filled in when the file is closed. `ibt.js` already falls back to `(fileSize − bufOffset) / bufLen` rows when recordCount is missing, so it can parse a file that is still being written.

## Channels worth knowing

Units are SI unless noted (m/s, rad, m/s², 0–1 for "%" channels). Of the ~290 channels in a 2026 file, these matter for coaching:

- **Driver input vs car input.** `Throttle` / `Brake` are what the car got; `ThrottleRaw` / `BrakeRaw` / `ClutchRaw` / `HandbrakeRaw` are the pedals. In the Spa file, Throttle exceeded ThrottleRaw on 217 samples (auto-blip on downshifts) and Brake differed from BrakeRaw on 1,557. The Lap Viewer reads the Raw ones (see below).
- **Official lap times.** `LapLastLapTime`, `LapBestLapTime`, `LapCurrentLapTime`, `LapCompleted`. iRacing's live deltas are logged too: `LapDeltaToBestLap`, `…ToOptimalLap`, `…ToSessionBestLap` (each with `_OK` validity and `_DD` rate).
- **Mistakes.** `PlayerCarMyIncidentCount` (running x-count, steps on each incident), `PlayerIncidents` (bitfield of the incident type), `PlayerTrackSurface` (off track / on track / pit), `EnterExitReset`, `PlayerCarTowTime`.
- **Stint state.** `IsOnTrack`, `IsOnTrackCar`, `OnPitRoad`, `SessionNum`, `SessionState`, `SessionFlags`.
- **Car.** `SteeringWheelAngleMax` (lock), `ShiftIndicatorPct`, `ShiftGrindRPM`, `FuelLevel`, `FuelUsePerHour`, tyre surface temps `xxtempL/M/R`, carcass temps `xxtempCL/CM/CR`, wear `xxwearL/M/R`, `xxshockDefl` / `xxshockVel` (kerb strikes, bottoming), `CFSRrideHeight`.

## Refinements made to the parser

1. **Pedals are read from `ThrottleRaw` / `BrakeRaw`** (falling back to `Throttle` / `Brake`), so auto-blips no longer look like throttle stabs.
2. **Incidents per lap** (`lap.inc`) from steps in `PlayerCarMyIncidentCount`, shown as an `Nx` badge on the lap row and in the stint summary.
3. **Tows** (`lap.tow`) from `PlayerCarTowTime`, named in the reset icon's tooltip.
4. **Fuel per lap** (`lap.fuel`) from `FuelLevel`, in the lap time's tooltip.
5. Our lap times were checked against `LapLastLapTime`: they match within 1 ms on both test files, so nothing changed there.

## Listening to a live session (feasibility)

The goal: set a reference lap, Alt+L, drive a stint, tab back and get pointed feedback on those laps.

A browser page can't read iRacing's live shared memory (`Local\IRSDKMemMapFileName`) on its own. There are three ways in:

| Route | How | Latency | Install | Verdict |
|---|---|---|---|---|
| **A. Folder watch, per stint** | Existing `watch.js` sees the new `.ibt` once iRacing closes it (leaving the car), loads it, compares each lap with the pinned reference and builds a stint report | When you leave the car | None (Chrome/Edge) | **Covers the described workflow today**, with work on the report side only |
| **B. Tail the growing file** | Same folder handle, re-read the file every few seconds and parse new rows (the layout allows it, see above) | Seconds, if iRacing flushes as it goes | None | Possible for a "live lap list" while driving; needs a test on a real PC that Windows sharing and iRacing's buffering allow it |
| **C. Local bridge** | Small helper (Python `pyirsdk` or Node) reads shared memory at 60 Hz and serves it on `ws://localhost`; the page connects | Real time | A helper the user runs | Only needed for in-car feedback (audio cues, overlay). Chrome will ask once for local-network access |

### Recommendation (built: Stint mode)

Build **A** first. The user's flow (tab back after the stint) doesn't need real-time data: every time you leave the car iRacing closes a file, and the watch already picks that up. What's missing is the stint layer:

1. A "Stint mode" toggle on the watch card that auto-loads each new file instead of asking.
2. Every full lap compared with the pinned reference lap (existing corner compare and coaching).
3. A stint summary: lap times and deltas, consistency, the 2–3 corners losing the most time across the stint, recurring coaching flags ("braked early into T1 on 4 of 6 laps"), incidents, and one focus for the next stint.

Then try **B** with a 10-minute test on the user's PC (start a session, Alt+L, drive, watch the file size from the browser). If it grows in place, laps can appear as they're completed. **C** stays on the shelf unless in-car audio feedback is wanted.

## Sources

- iRacing, *Getting started with iRacing telemetry* (Atlas quickstart): https://ir-core-sites.iracing.com/members/atlas/atlas_quickstart.pdf
- `pyirsdk` (mirrors `irsdk_defines.h`: shared-memory names, header structs, broadcast messages): https://github.com/kutu/pyirsdk
- node-irsdk: https://github.com/apihlaja/node-irsdk
- iRacing WebSocket bridge example: https://github.com/eklynx/iRacingWebSocketTelemetry
- 360 Hz app.ini discussion: https://www.simxperience.com/forum/accuforce-v2-community-q-a-3/increasing-telemetry-rate-to-360hz-in-iracing-app-ini-makes-steering-super-sluggish-528
