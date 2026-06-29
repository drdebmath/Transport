# India Future Mobility Planner

Interactive scenario model comparing Indian city-center journeys by flight,
conventional train, high-speed rail (HSR), and hybrid flight/HSR paths.

**Live:** https://drdebmath.github.io/Transport/

## What it shows

- A 3D map of India with four views: direct flight paths, GDP-proxy towers, a
  population density-spike field, and proposed HSR corridors as a flat phase map.
- HSR corridors as demand-flow through-lines in three cumulative build phases
  (trunk / regional / feeder), with per-segment travel times.
- A cost and economy panel: network track length, build cost, and modeled GDP
  growth rate for the selected phase.
- A sortable corridor table ranking each line by carried demand, population
  served, economic impact, and time saved.
- Sliders for airport transfer wait and HSR economic-impact factor.

## How journeys are timed

- Conventional train: 50 km/h over bent city-center distance.
- HSR: 200 km/h average plus a fixed 20-minute station overhead per journey.
- Flights: city-center airport access, 60 min before departure, flight time,
  30 min after arrival, and destination access; connections add a 1–3 h transfer
  wait.
- **Gain** is the time HSR saves versus the best current option — today's fastest
  of train or flight — not just the slow baseline train.

## Cost and economy model

- Build cost from the Mumbai–Ahmedabad bullet train: about Rs 1,08,000 crore for
  508 km (~Rs 212.6 crore/km). Phase cost = corridor HSR length × per-km cost.
- Economy assumes 6% baseline GDP growth, plus 0.5% per 1,000 km of HSR in service.
- City GDP is a state per-capita × population proxy, since city-level GDP is not
  consistently available.

## Data sources

- City coordinates and population: GeoNames India.
- State names: GeoNames admin-1 table.
- Flight routes and carriers: Jonty airline-route-data.
- State economic data: MoSPI state-wise SDP workbook (15 March 2024).
- India map: Survey of India.
- Cost basis: NHSRCL Mumbai–Ahmedabad bullet train project.

The HSR network is a modeled demand-flow scenario, not an official rail plan.
