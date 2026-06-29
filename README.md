# India Future Mobility — Scenario vs Real HSR

A self-contained static site that models a high-speed-rail **scenario** for India
and overlays it against the **real and proposed** bullet-train corridors for
contrast. The scenario network is recomputed in your browser from open data; the
real plan is the actual NHSRCL / Union Budget 2026-27 programme.

**Live:** https://drdebmath.github.io/Transport/

## What it shows

- A 3D map of India with switchable overlays: modeled **Scenario HSR** (demand
  network in three build phases), **Real HSR** (MAHSR drawn through its 12 actual
  stations + every approved/DPR/proposed corridor), **Contrast** (real corridors
  bright over the dimmed scenario), **GDP** and **Population** spike fields, and
  direct **Flights**.
- A scenario-vs-real comparison panel (track km, cost, cities served, GDP bonus)
  and how many real corridors the demand model independently picks.
- A corridor table with modeled HSR time, best current option, time saved, and
  population served. Sliders for build phase and economic impact factor.

## Architecture

No build step, no framework, no CDN — open `index.html` over any static server.

```
data/                  source data, split by type (JSON)
  cities.json          230 cities: coords, population, state GDP proxy, airport access
  flights.json         airports + direct flight edges
  geo_india.json       India outline + state lines (Survey of India / Natural Earth)
  corridors_real.json  MAHSR (12 stations) + 15 proposed corridors + status colors
  economy.json         cost basis + economy/speed constants
  sources.json         data provenance + modeling assumptions
src/
  model.js             scenario model — in-browser port of the original Node build
                       (Gabriel graph -> gravity demand -> flow -> stitched lines ->
                       km-budget phases + coverage connectors; all-pairs journey
                       times; scored corridor gains). Pure, no DOM.
  app.js               Three.js 3D map, overlays, controls, comparison panel, tables
  test_model.mjs       node self-check for the model
vendor/                three.js (local copy: three.module.js + three.core.min.js)
index.html             page shell + styles
```

## Run / test

```
python3 -m http.server 8000      # then open http://localhost:8000/
node src/test_model.mjs          # validate the scenario model
```

## Data notes

- The HSR scenario is a **modeled demand network**, not an official plan. Only the
  Mumbai–Ahmedabad corridor is drawn from its surveyed 12-station alignment; other
  real corridors use real endpoints/length with a schematic path through major
  cities.
- HSR/train times are modeled at 200 / 50 km/h; cost uses the Mumbai–Ahmedabad
  basis (~₹212.6 cr/km). GDP uplift is a market-access elasticity model calibrated
  to Japan Shinkansen & China HSR evidence — see [`ECONOMIC_MODEL.md`](ECONOMIC_MODEL.md).
- Journey times use the default 60-min connection wait. See `data/sources.json`
  for full provenance and assumptions.
