# Bundled track data

Circuit outlines that ship with the site, so the Lap Viewer's Map option doesn't need to ask OpenStreetMap's volunteer servers (Overpass, Nominatim) for the usual iRacing circuits. Tracks not listed here are still looked up live, as before.

- `index.json`: each circuit's name, rough centre and radius, and the iRacing layouts (`ids`, `names`) that belong to it. `osm: false` means OpenStreetMap has no circuit there (Oran Park, built over), so the app shows no map without asking.
- `osm/<id>.json`: the circuit's `highway=raceway` ways within that radius, pit lanes left out, as polylines at 1e-6 degree precision.
- `bundle.js`: `index.json` and every `osm/<id>.json` as one script, for the app opened from `file://` (where it can't fetch JSON). Written by every run of the script; `--js` rewrites just this file.
- `lovely/` (only when built with `--corners`): a copy of Lovely Track Data's iRacing corner files.

Regenerate from the repo root (Node 18+):

```powershell
node scripts/bundle-tracks.js
```

Add or fix a circuit in [scripts/tracks.json](../../scripts/tracks.json), then run the script with its id to refresh just that one.

## Licence

The raceway geometry is © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) and is made available under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/). This extract is a derivative database and is shared under the same licence.

Lovely Track Data ([github.com/Lovely-Sim-Racing/lovely-track-data](https://github.com/Lovely-Sim-Racing/lovely-track-data)) publishes no licence, so it isn't copied here by default; the app reads it from GitHub. Only build with `--corners` once its maintainers have agreed.
