# India Future Mobility Scenario

## Goal

Build a futuristic transport-planning simulator for India that compares city-center to
city-center journey times across:

- direct flights,
- one-stop flight connections with airport wait time,
- baseline conventional train at 50 km/h,
- high-speed rail at an assumed 200 km/h average speed,
- and mixed future-mobility scenarios that reveal where rail, flight, or both could
  reshape intercity travel.

## Data Scope

- Include Indian cities with population greater than 400,000.
- Add regional inclusions where the population threshold underrepresents geography,
  including Odisha cities such as Rourkela, Jharsuguda, Brahmapur, Sambalpur, and
  Balasore, plus selected northeast, Himalayan, central, and Kerala cities.
- Use city coordinates and population from a reproducible source.
- Use direct commercial flight routes where route data exists.
- For city pairs without direct flights, create one-stop flight connections through
  existing direct-flight legs.
- Model connection waits with a slider from 1 to 3 hours in 30-minute increments.
- Add city-center access and egress time around flights using a local traffic proxy
  based on city scale and airport/city-center distance.

## Flight Model

- Use existing direct-flight route data with scheduled time and carrier labels.
- Build a graph where nodes are cities and edges are direct flights.
- Edge weight is:
  - city-center to origin-airport access time,
  - 60 minutes of airport entry/process time,
  - direct scheduled flight time,
  - 30 minutes of airport exit/process time,
  - destination-airport to city-center egress time.
- For connecting itineraries, add the selected wait time at each transfer airport.
- Compute all-pair shortest paths for the selected wait time.
- Preserve carrier labels for direct segments and show the itinerary path.

## High-Speed Rail Model

- Treat high-speed rail as a scenario plan, not an existing service map.
- Use city-to-city great-circle air distance multiplied by 1.2 as the route-bend factor.
- Assume 200 km/h average speed.
- Score candidate city-pair corridors by demand, GDP proxy, population captured
  by nearby detours, and distance suitability.
- Consider geographically nearby intermediate cities for each candidate, but keep
  the candidate route within a 20% travel-time increase versus direct HSR.
- Build the physical network as shared track: reuse existing HSR segments when
  a candidate pair is still connected within the 20% detour bound; otherwise add
  the shortest candidate path needed.
- Use a greedy Steiner-style approximation to minimize total network length while
  keeping all selected candidate endpoints connected.
- After the physical HSR network is built, compute all-pair shortest paths and
  choose the top 150 HSR routes by a weighted score:
  - 30% normalized time saved,
  - 40% normalized population served,
  - 30% normalized economic impact.
- Economic impact is city GDP proxy multiplied by the selected HSR impact factor,
  parameterized from 1x to 3x.
- Compute all-pair shortest paths over that rail graph.

## Network Design Rationale

- Japan's Shinkansen pattern favors high-demand trunk corridors that link major
  cities and then extend outward.
- China's HSR buildout adds a larger grid and city-cluster logic, making
  regional connectivity and intermediate population capture important.
- This project uses a simple hybrid: high-demand candidate pairs for trunk demand,
  regional candidates for shorter corridors, bounded detour stops for intermediate
  population capture, and shared-track reuse to avoid duplicating parallel lines.

## Visual Experience

- Make the app feel futuristic and exploratory.
- Show India as a fixed-view Three.js map with zoom and hover.
- Provide multiple map overlays:
  - all direct flight paths,
  - GDP proxy city circles and towers,
  - population towers,
  - proposed HSR corridors.
- Include a wait-time slider with 1 to 3 hour waits in 30-minute intervals.
- Show shortest-path comparisons for selected origin/destination city pairs.
- Add a banner that showcases the biggest modeled gains and links into those pairs.
- Highlight where rail beats flight, where flight still wins, and where the gap is close.
- Keep the plot hover-friendly with large hit targets, tooltips, and linked hover state
  across chart, map, table, and summary panels.

## Implementation Notes

- Keep this as a local git repository and commit source states before publishing.
- Keep generated source data reproducible from scripts under `scripts/`.
- Keep bulky raw source dumps under `work/` and out of git.
- The app should clearly distinguish measured source data from scenario assumptions.
