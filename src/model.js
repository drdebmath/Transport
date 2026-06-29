// Scenario model — a faithful in-browser port of the original Node build script
// (Codex build-mobility-scenario.mjs), reading the pre-extracted JSON in data/
// instead of raw GeoNames/flight/Excel sources. Same algorithm: Gabriel graph of
// design nodes -> gravity demand -> flow assignment -> stitched through-lines ->
// km-budget phases + coverage connectors, then all-pairs journey times and scored
// corridor gains.
//
// Pure functions only (no DOM/Three/fetch) so it runs in node tests too.
// ponytail: journey times are computed at the default 60-min connection wait
// (WAIT_OPTIONS[0]); the corridor network/ranking is wait-independent. Add the
// other waits to the loop below if the wait slider is ever wanted.

// --- constants (verbatim from the build script) ---
const MEGAPOLIS_RADIUS_KM = 50;
const HIGH_SPEED_KMH = 200;
const BASELINE_TRAIN_KMH = 50;
const HSR_OVERHEAD_MINUTES = 20;
const RAIL_BEND_FACTOR = 1.2;
const TOP_HSR_CORRIDOR_COUNT = 150;
const PHASE_COUNTS = [50, 100, 150];
const HSR_MIN_CORRIDOR_KM = 100;
const FLIGHT_ENTRY_BUFFER_MINUTES = 60;
const FLIGHT_EXIT_BUFFER_MINUTES = 30;
const WAIT_OPTIONS = [60, 90, 120, 150, 180];
const DESIGN_CLUSTER_KM = 40;
const DEMAND_GDP_WEIGHT = 0.4;
const DEMAND_DISTANCE_DECAY = 1.0;
const LINE_TURN_ANGLE_MAX_DEG = 42;
const LINE_MAX_RAIL_KM = 1700;
const LINE_MAX_CITIES = 14;
const LINE_MIN_FLOW_QUANTILE = 0.5;
const PHASE_KM_BUDGETS = [7000, 16000];
const HSR_IMPACT_FACTORS = [1, 1.5, 2, 2.5, 3];
const DEFAULT_HSR_IMPACT_FACTOR = 1;
const SCORE_WEIGHTS = { timeSaved: 0.3, populationServed: 0.4, economicImpact: 0.3 };

export const PHASE_META = [
  { id: 1, label: "Phase 1", blurb: "Trunk lines", color: "#42f5d7" },
  { id: 2, label: "Phase 2", blurb: "Regional lines", color: "#ffd166" },
  { id: 3, label: "Phase 3", blurb: "Feeder lines", color: "#ff4fd8" },
];
export const ECONOMY = {
  costPerKmCrore: round(108000 / 508, 2),
  baseGdpGrowthPct: 6,
  // --- market-access GDP model (replaces the flat 0.5%/1000km heuristic) ---
  // GDP responds to how much faster a city can reach national economic mass, not
  // to raw track length. Knobs are empirical (see ECONOMIC_MODEL.md) — leave them
  // tunable; the physical economy needs calibration a minimal model can't see.
  marketAccessElasticity: 0.12, // ε: elasticity of city GDP to market access (Ahlfeldt-Feddersen ~0.12–0.18; China HSR DiD ~+5–7% per connected city)
  strawEffectRetention: 0.65,   // λ: net national share after redistribution / "straw effect" (Qin 2017: bypassed counties lose ~⅓ of what connected ones gain)
  timeDecayMinutes: 90,         // τ: accessibility time-decay scale — HSR's 1–3h sweet spot
  realizationYears: 15,         // H: years over which the one-time GDP level gain is realized
  cityUpliftCapPct: 25,         // saturation ceiling: a single city's GDP can't respond to access without bound (land/labour/capacity)
};

function round(value, digits = 2) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function haversineKm(a, b) {
  const radius = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function bentRailKm(from, to) { return haversineKm(from, to) * RAIL_BEND_FACTOR; }
function trainMinutes(from, to, speedKmh) { return Math.round((bentRailKm(from, to) / speedKmh) * 60); }

const nodeCity = (id) => `city:${id}`;
const nodeDepart = (iata) => `dep:${iata}`;
const nodeArrive = (iata) => `arr:${iata}`;
const minutesTo = (v) => (Number.isFinite(v) ? Math.round(v) : null);

function addEdge(adj, from, to, weight, meta = null) {
  if (!adj.has(from)) adj.set(from, []);
  adj.get(from).push({ to, weight, meta });
}

function dijkstra(adj, start) {
  const dist = new Map([[start, 0]]);
  const visited = new Set();
  const queue = [{ node: start, dist: 0 }];
  while (queue.length) {
    queue.sort((a, b) => b.dist - a.dist);
    const current = queue.pop();
    if (!current || visited.has(current.node)) continue;
    visited.add(current.node);
    for (const edge of adj.get(current.node) ?? []) {
      const nextDist = current.dist + edge.weight;
      if (nextDist < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, nextDist);
        queue.push({ node: edge.to, dist: nextDist });
      }
    }
  }
  return { dist };
}

function bearingDeg(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const phi1 = toRad(a.lat), phi2 = toRad(b.lat), dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180) / Math.PI;
}
function angleBetween(b1, b2) {
  const diff = Math.abs(b1 - b2) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function dijkstraTree(adjacency, source, edgeWeight) {
  const n = adjacency.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const visited = new Uint8Array(n);
  dist[source] = 0;
  const queue = [{ node: source, d: 0 }];
  while (queue.length) {
    let bestIndex = 0;
    for (let i = 1; i < queue.length; i += 1) if (queue[i].d < queue[bestIndex].d) bestIndex = i;
    const { node } = queue.splice(bestIndex, 1)[0];
    if (visited[node]) continue;
    visited[node] = 1;
    for (const next of adjacency[node]) {
      const nd = dist[node] + edgeWeight(node, next);
      if (nd < dist[next]) { dist[next] = nd; prev[next] = node; queue.push({ node: next, d: nd }); }
    }
  }
  return { dist, prev };
}

// Point-in-India tester built from the outline rings in geo_india.json.
function buildInsideIndia(mapLines) {
  const rings = [];
  for (const line of mapLines) {
    if (!line.outline) continue;
    const pts = line.points;
    if (pts.length < 4) continue;
    let minx = 180, miny = 90, maxx = -180, maxy = -90;
    for (const [x, y] of pts) {
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
    rings.push({ pts, minx, miny, maxx, maxy });
  }
  const pointInRing = (lon, lat, ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  return (lon, lat) => {
    for (const r of rings) {
      if (lon < r.minx || lon > r.maxx || lat < r.miny || lat > r.maxy) continue;
      if (pointInRing(lon, lat, r.pts)) return true;
    }
    return false;
  };
}

// Twin city pairs: cities that are one functional metro but sit too far apart
// (or geometrically split) for the automatic 40 km megalopolis merge to do the
// right thing — e.g. Patna & Arrah (47.6 km, one Ganga corridor). Unlike a plain
// merge (which parks the node on the dominant city and can fall off the trunk),
// a twin pair fuses the members into one node but lets the data pick the anchor
// location (the on-corridor member) and the display name (the dominant city).
//   twins.json entry: { members:[...names], name, primary?, anchorAt? }
function applyTwinPairs(cities, twins = []) {
  if (!twins?.length) return cities;
  const byName = new Map(cities.map((c) => [c.name, c]));
  const removed = new Set();
  const fused = [];
  for (const twin of twins) {
    const members = (twin.members || []).map((n) => byName.get(n)).filter(Boolean);
    if (members.length < 2) continue; // both must be present to fuse
    const primary = byName.get(twin.primary ?? twin.members[0]) ?? members[0];
    const anchor = byName.get(twin.anchorAt ?? twin.primary ?? twin.members[0]) ?? primary;
    for (const m of members) removed.add(m.id);
    fused.push({
      ...primary, // keep id, state, airport, traffic from the dominant city
      name: twin.name ?? primary.name,
      lat: anchor.lat, lon: anchor.lon,
      population: members.reduce((s, c) => s + c.population, 0),
      cityGdpProxyCrore: round(members.reduce((s, c) => s + c.cityGdpProxyCrore, 0), 2),
      twinMembers: members.map((c) => c.name),
    });
  }
  return [...cities.filter((c) => !removed.has(c.id)), ...fused];
}

function buildDesignNodes(inputCities) {
  const sorted = [...inputCities].sort(
    (a, b) => b.population - a.population || a.name.localeCompare(b.name),
  );
  const assigned = new Set();
  const nodes = [];
  for (const seed of sorted) {
    if (assigned.has(seed.id)) continue;
    assigned.add(seed.id);
    const members = [seed];
    for (const other of sorted) {
      if (assigned.has(other.id)) continue;
      if (haversineKm(seed, other) <= DESIGN_CLUSTER_KM) { assigned.add(other.id); members.push(other); }
    }
    nodes.push({
      id: seed.id, name: seed.name, lat: seed.lat, lon: seed.lon,
      population: members.reduce((s, c) => s + c.population, 0),
      cityGdpProxyCrore: members.reduce((s, c) => s + c.cityGdpProxyCrore, 0),
      memberIds: members.map((c) => c.id),
    });
  }
  return nodes;
}

function buildSteinerHsrNetwork(inputCities, coverage = {}) {
  const cities = buildDesignNodes(inputCities);
  const n = cities.length;
  const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const nodeByCityId = new Map();
  cities.forEach((node, idx) => node.memberIds.forEach((mid) => nodeByCityId.set(mid, idx)));
  const targetNodes = (ids) =>
    [...new Set([...(ids ?? [])].map((id) => nodeByCityId.get(id)).filter((i) => i !== undefined))];
  const phase2Targets = targetNodes(coverage.phase2TargetIds);
  const phase3Targets = targetNodes(coverage.coverageTargetIds);

  const insideIndia = coverage.insideIndia ?? (() => true);
  const segmentOnLand = (i, j) => {
    const a = cities[i], b = cities[j], samples = 16;
    for (let s = 1; s <= samples; s += 1) {
      const t = s / (samples + 1);
      if (!insideIndia(a.lon + (b.lon - a.lon) * t, a.lat + (b.lat - a.lat) * t)) return false;
    }
    return true;
  };

  const dist = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i += 1)
    for (let j = i + 1; j < n; j += 1) { const d = haversineKm(cities[i], cities[j]); dist[i][j] = d; dist[j][i] = d; }

  const adjacency = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i += 1)
    for (let j = i + 1; j < n; j += 1) {
      const r2 = dist[i][j] * dist[i][j];
      let keep = true;
      for (let k = 0; k < n; k += 1) {
        if (k === i || k === j) continue;
        if (dist[i][k] * dist[i][k] + dist[j][k] * dist[j][k] < r2) { keep = false; break; }
      }
      if (keep && segmentOnLand(i, j)) { adjacency[i].push(j); adjacency[j].push(i); }
    }

  const componentIds = () => {
    const id = new Int32Array(n).fill(-1);
    let count = 0;
    for (let s = 0; s < n; s += 1) {
      if (id[s] !== -1) continue;
      id[s] = count;
      const stack = [s];
      while (stack.length) { const u = stack.pop(); for (const v of adjacency[u]) if (id[v] === -1) { id[v] = count; stack.push(v); } }
      count += 1;
    }
    return { id, count };
  };
  for (;;) {
    const { id, count } = componentIds();
    if (count <= 1) break;
    let best = null;
    for (let i = 0; i < n; i += 1)
      for (let j = i + 1; j < n; j += 1) {
        if (id[i] === id[j] || (best && dist[i][j] >= best.d)) continue;
        if (segmentOnLand(i, j)) best = { i, j, d: dist[i][j] };
      }
    if (!best) break;
    adjacency[best.i].push(best.j); adjacency[best.j].push(best.i);
  }

  const maxPop = Math.max(...cities.map((c) => c.population), 1);
  const maxGdp = Math.max(...cities.map((c) => c.cityGdpProxyCrore), 1);
  const mass = cities.map(
    (c) => (1 - DEMAND_GDP_WEIGHT) * (c.population / maxPop) + DEMAND_GDP_WEIGHT * (c.cityGdpProxyCrore / maxGdp),
  );

  const edgeWeight = (u, v) => dist[u][v];
  const flow = new Map();
  for (let s = 0; s < n; s += 1) {
    const { prev } = dijkstraTree(adjacency, s, edgeWeight);
    for (let t = s + 1; t < n; t += 1) {
      const d = dist[s][t];
      if (d < HSR_MIN_CORRIDOR_KM) continue;
      const demand = (mass[s] * mass[t]) / Math.pow(d, DEMAND_DISTANCE_DECAY);
      let cur = t;
      while (cur !== s && prev[cur] !== -1) { const key = edgeKey(cur, prev[cur]); flow.set(key, (flow.get(key) ?? 0) + demand); cur = prev[cur]; }
    }
  }

  const flowEntries = [...flow.entries()].map(([key, value]) => {
    const [a, b] = key.split("|").map(Number);
    return { a, b, key, flow: value, km: dist[a][b] };
  });
  const sortedFlows = flowEntries.map((e) => e.flow).sort((x, y) => x - y);
  const threshold = sortedFlows[Math.floor(sortedFlows.length * LINE_MIN_FLOW_QUANTILE)] ?? 0;
  const buildable = flowEntries.filter((e) => e.flow >= threshold);

  const buildAdj = new Map();
  for (const e of buildable) {
    if (!buildAdj.has(e.a)) buildAdj.set(e.a, []);
    if (!buildAdj.has(e.b)) buildAdj.set(e.b, []);
    buildAdj.get(e.a).push(e); buildAdj.get(e.b).push(e);
  }

  const used = new Set();
  const otherEnd = (e, node) => (e.a === node ? e.b : e.a);
  const extend = (seq, atStart, budget) => {
    let remaining = budget;
    for (;;) {
      if (seq.length >= LINE_MAX_CITIES) break;
      const current = atStart ? seq[0] : seq[seq.length - 1];
      const previous = atStart ? seq[1] : seq[seq.length - 2];
      let best = null;
      for (const e of buildAdj.get(current) ?? []) {
        if (used.has(e.key)) continue;
        const next = otherEnd(e, current);
        if (seq.includes(next)) continue;
        if (dist[current][next] > remaining) continue;
        const turn = angleBetween(bearingDeg(cities[previous], cities[current]), bearingDeg(cities[current], cities[next]));
        if (turn > LINE_TURN_ANGLE_MAX_DEG) continue;
        if (!best || e.flow > best.flow) best = { ...e, next };
      }
      if (!best) break;
      used.add(best.key);
      remaining -= dist[current][best.next];
      if (atStart) seq.unshift(best.next); else seq.push(best.next);
    }
    return remaining;
  };

  const makeLine = (nodeSeq, reason) => {
    let railKm = 0, personKm = 0, flowSum = 0, peakFlow = 0;
    for (let i = 0; i < nodeSeq.length - 1; i += 1) {
      const km = dist[nodeSeq[i]][nodeSeq[i + 1]];
      const f = flow.get(edgeKey(nodeSeq[i], nodeSeq[i + 1])) ?? 0;
      railKm += km * RAIL_BEND_FACTOR; personKm += f * km; flowSum += f; if (f > peakFlow) peakFlow = f;
    }
    let servedDemand = 0;
    for (let i = 0; i < nodeSeq.length; i += 1)
      for (let j = i + 1; j < nodeSeq.length; j += 1) {
        const d = dist[nodeSeq[i]][nodeSeq[j]];
        if (d <= 0) continue;
        servedDemand += (mass[nodeSeq[i]] * mass[nodeSeq[j]]) / Math.pow(d, DEMAND_DISTANCE_DECAY);
      }
    const citiesOnLine = nodeSeq.map((idx) => cities[idx]);
    return {
      nodeSeq, citiesOnLine, viaCities: citiesOnLine.slice(1, -1),
      railKm, personKm, flowSum, peakFlow, lineDemand: servedDemand,
      servedPopulation: citiesOnLine.reduce((s, c) => s + c.population, 0),
      servedGdp: citiesOnLine.reduce((s, c) => s + c.cityGdpProxyCrore, 0),
      endA: citiesOnLine[0], endB: citiesOnLine[citiesOnLine.length - 1],
      directKm: haversineKm(citiesOnLine[0], citiesOnLine[citiesOnLine.length - 1]),
      reason: reason ?? "demand",
    };
  };

  const maxRawKm = LINE_MAX_RAIL_KM / RAIL_BEND_FACTOR;
  const lineObjects = [];
  for (const seed of [...buildable].sort((a, b) => b.flow - a.flow)) {
    if (used.has(seed.key)) continue;
    used.add(seed.key);
    const nodeSeq = [seed.a, seed.b];
    let budget = maxRawKm - dist[seed.a][seed.b];
    budget = extend(nodeSeq, false, budget);
    extend(nodeSeq, true, budget);
    lineObjects.push(makeLine(nodeSeq, "demand"));
  }

  lineObjects.sort((a, b) => b.lineDemand - a.lineDemand || b.personKm - a.personKm);
  let cumKm = 0;
  for (const line of lineObjects) {
    cumKm += line.railKm;
    line.phase = cumKm <= PHASE_KM_BUDGETS[0] ? 1 : cumKm <= PHASE_KM_BUDGETS[1] ? 2 : 3;
  }

  const connectorLines = [];
  const connectedAt = (maxPhase) => {
    const set = new Set();
    for (const line of [...lineObjects, ...connectorLines]) if (line.phase <= maxPhase) for (const idx of line.nodeSeq) set.add(idx);
    return set;
  };
  const connectTarget = (targetIdx, phase) => {
    if (targetIdx === undefined || targetIdx < 0) return;
    const connected = connectedAt(phase);
    if (connected.has(targetIdx) || connected.size === 0) return;
    const { dist: dd, prev } = dijkstraTree(adjacency, targetIdx, (u, v) => dist[u][v]);
    let attach = -1, attachDist = Infinity;
    for (const idx of connected) if (dd[idx] < attachDist) { attachDist = dd[idx]; attach = idx; }
    let bridgeTo = -1;
    if (attach === -1 || !Number.isFinite(attachDist)) {
      let best = null;
      for (let u = 0; u < n; u += 1) {
        if (!Number.isFinite(dd[u])) continue;
        for (const v of connected) { if (best && dist[u][v] >= best.d) continue; if (segmentOnLand(u, v)) best = { u, v, d: dist[u][v] }; }
      }
      if (!best) return;
      attach = best.u; bridgeTo = best.v;
    }
    const path = [attach];
    let cur = attach;
    while (cur !== targetIdx && prev[cur] !== -1) { cur = prev[cur]; path.push(cur); }
    path.reverse();
    if (bridgeTo !== -1) path.push(bridgeTo);
    if (path.length < 2) return;
    const line = makeLine(path, "coverage-connector");
    line.phase = phase; connectorLines.push(line);
  };
  for (const idx of phase2Targets) connectTarget(idx, 2);
  for (const idx of phase3Targets) connectTarget(idx, 3);

  const allLines = [...lineObjects, ...connectorLines];
  allLines.sort((a, b) => a.phase - b.phase || b.lineDemand - a.lineDemand || b.personKm - a.personKm);
  allLines.forEach((line, index) => { line.rank = index + 1; });

  const reasonForPhase = (p) => (p === 1 ? "trunk-corridor" : p === 2 ? "regional-corridor" : "feeder-corridor");
  const reasonForLine = (line) => (line.reason === "coverage-connector" ? "coverage-connector" : reasonForPhase(line.phase));

  const selectedRoutes = allLines.map((line) => ({
    rank: line.rank, phase: line.phase,
    anchorFrom: line.endA.id, anchorTo: line.endB.id,
    anchorFromName: line.endA.name, anchorToName: line.endB.name,
    nodeIds: line.citiesOnLine.map((c) => c.id), nodeNames: line.citiesOnLine.map((c) => c.name),
    viaIds: line.viaCities.map((c) => c.id), viaNames: line.viaCities.map((c) => c.name),
    directKm: round(line.directKm, 1), routeKm: round(line.railKm / RAIL_BEND_FACTOR, 1), railKm: round(line.railKm, 1),
    minutes: Math.round((line.railKm / HIGH_SPEED_KMH) * 60) + HSR_OVERHEAD_MINUTES,
    cityCount: line.citiesOnLine.length, servedPopulation: line.servedPopulation,
    servedGdpProxyCrore: round(line.servedGdp, 2), personKmDemand: Math.round(line.personKm),
    flowDemand: round(line.flowSum, 4), peakFlow: round(line.peakFlow, 6), lineDemand: round(line.lineDemand, 6),
    reason: reasonForLine(line),
  }));

  const edgeMap = new Map();
  for (const line of allLines) {
    const lineName = `${line.endA.name} to ${line.endB.name}`;
    for (let i = 0; i < line.nodeSeq.length - 1; i += 1) {
      const a = cities[line.nodeSeq[i]], b = cities[line.nodeSeq[i + 1]];
      const key = [a.id, b.id].sort().join("|");
      const km = dist[line.nodeSeq[i]][line.nodeSeq[i + 1]];
      const railKm = km * RAIL_BEND_FACTOR;
      const segFlow = flow.get(edgeKey(line.nodeSeq[i], line.nodeSeq[i + 1])) ?? 0;
      const existing = edgeMap.get(key);
      if (existing) {
        if (!existing.routeRanks.includes(line.rank)) existing.routeRanks.push(line.rank);
        if (!existing.routeNames.includes(lineName)) existing.routeNames.push(lineName);
        existing.phase = Math.min(existing.phase, line.phase);
        existing.flow = Math.max(existing.flow, round(segFlow, 4));
        existing.reason = reasonForPhase(existing.phase);
      } else {
        edgeMap.set(key, {
          from: a.id, to: b.id, fromName: a.name, toName: b.name,
          distanceKm: round(km, 1), railKm: round(railKm, 1),
          minutes: Math.round((railKm / HIGH_SPEED_KMH) * 60),
          reason: reasonForPhase(line.phase), phase: line.phase,
          connector: line.reason === "coverage-connector", flow: round(segFlow, 4),
          routeRanks: [line.rank], routeNames: [lineName],
          anchorFromName: line.endA.name, anchorToName: line.endB.name,
        });
      }
    }
  }
  const railEdges = [...edgeMap.values()]
    .map((edge) => ({ ...edge, routeRanks: [...edge.routeRanks].sort((a, b) => a - b), routeNames: [...edge.routeNames].sort() }))
    .sort((a, b) => a.phase - b.phase || b.flow - a.flow)
    .map((edge, index) => ({ rank: index + 1, ...edge }));

  const anchorCities = [...new Set(allLines.flatMap((line) => line.nodeSeq))]
    .map((idx) => cities[idx])
    .sort((a, b) => b.population - a.population || a.name.localeCompare(b.name));

  return { anchorCities, selectedRoutes, railEdges };
}

function buildAdjacency({ cities, flightEdges, railEdges, waitMinutes, mode }) {
  const adj = new Map();
  if (mode === "flight" || mode === "combo") {
    for (const city of cities) {
      addEdge(adj, nodeCity(city.id), nodeDepart(city.nearestAirportIata), city.airportAccessMinutes + FLIGHT_ENTRY_BUFFER_MINUTES);
      addEdge(adj, nodeArrive(city.nearestAirportIata), nodeCity(city.id), city.airportAccessMinutes + FLIGHT_EXIT_BUFFER_MINUTES);
    }
    for (const edge of flightEdges) addEdge(adj, nodeDepart(edge.from), nodeArrive(edge.to), edge.minutes);
    const airportCodes = new Set(flightEdges.flatMap((e) => [e.from, e.to]));
    for (const iata of airportCodes) {
      addEdge(adj, nodeArrive(iata), nodeDepart(iata), waitMinutes);
      addEdge(adj, nodeDepart(iata), nodeArrive(iata), 0);
    }
  }
  if (mode === "rail" || mode === "combo") {
    for (const edge of railEdges) {
      addEdge(adj, nodeCity(edge.from), nodeCity(edge.to), edge.minutes);
      addEdge(adj, nodeCity(edge.to), nodeCity(edge.from), edge.minutes);
    }
  }
  return adj;
}

function scoreLines(lines, impactFactor) {
  const maxLineDemand = Math.max(...lines.map((l) => l.lineDemand), 1e-9);
  const maxPopulation = Math.max(...lines.map((l) => l.servedPopulation), 1);
  const maxGdp = Math.max(...lines.map((l) => l.cityGdpProxyCrore), 1);
  return lines
    .map((line) => {
      const demandScore = line.lineDemand / maxLineDemand;
      const populationScore = line.servedPopulation / maxPopulation;
      const economicScore = Math.min(1, (line.cityGdpProxyCrore / maxGdp) * impactFactor);
      const timeScore = Math.min(1, Math.max(0, line.gainMinutes) / Math.max(line.baselineTrainMinutes, 1));
      const routeScore = (0.45 * demandScore + 0.2 * populationScore + 0.2 * economicScore + 0.15 * timeScore) * 100;
      return {
        ...line, hsrImpactFactor: impactFactor,
        economicImpactProxyCrore: round(line.cityGdpProxyCrore * impactFactor, 2),
        demandScore: round(demandScore, 4), timeScore: round(timeScore, 4),
        populationScore: round(populationScore, 4), economicScore: round(economicScore, 4),
        routeScore: round(routeScore, 2),
      };
    })
    .sort((a, b) => b.routeScore - a.routeScore || b.lineDemand - a.lineDemand)
    .map((line, index) => ({ ...line, rank: index + 1 }));
}

// ---- market-access GDP model -------------------------------------------------
// HSR raises GDP by shrinking travel time to economic mass. For each city i:
//   MA_i = GDP_i + Σ_{j≠i} GDP_j · exp(−t_ij / τ)       (gravity accessibility,
//          with the own-mass term anchoring the base so peripheral cities don't
//          start near zero and show explosive % gains)
// HSR cuts t_ij, so MA_i rises. In New-Economic-Geography form GDP ∝ MA^ε, so the
// level response is a LOG difference (tames huge jumps, exact for small ones):
//   Δy_i = ε · ( ln MA_i^after − ln MA_i^before ),  capped at a saturation ceiling.
// National uplift is the GDP-weighted mean of Δy_i, scaled by λ to strip the
// redistribution ("straw") share that is zero-sum across cities. Concavity is
// emergent: trunk lines connect the biggest masses first (largest Δln MA), feeders
// add little — no hand-tuned diminishing-returns exponent needed.
// beforeMinutes/afterMinutes: (cityA, cityB) -> travel minutes (after ≤ before).
function marketAccessUplift(cities, beforeMinutes, afterMinutes) {
  const tau = ECONOMY.timeDecayMinutes;
  const cap = ECONOMY.cityUpliftCapPct;
  const mass = cities.map((c) => Math.max(c.cityGdpProxyCrore, 0));
  let weighted = 0, totalGdp = 0;
  const perCity = [];
  for (let i = 0; i < cities.length; i += 1) {
    let maBefore = mass[i], maAfter = mass[i]; // own-mass anchor (t=0, weight 1)
    for (let j = 0; j < cities.length; j += 1) {
      if (i === j) continue;
      const tb = beforeMinutes(cities[i], cities[j]);
      if (!Number.isFinite(tb)) continue;
      const taRaw = afterMinutes(cities[i], cities[j]);
      const ta = Number.isFinite(taRaw) ? Math.min(taRaw, tb) : tb; // network is a superset; never worse
      maBefore += mass[j] * Math.exp(-tb / tau);
      maAfter += mass[j] * Math.exp(-ta / tau);
    }
    const dLogMa = maBefore > 0 ? Math.log(maAfter / maBefore) : 0; // Δln MA ≥ 0
    const cityUpliftPct = Math.min(cap, ECONOMY.marketAccessElasticity * dLogMa * 100); // gross % level, saturated
    weighted += mass[i] * cityUpliftPct;
    totalGdp += mass[i];
    perCity.push({ id: cities[i].id, name: cities[i].name, marketAccessGainPct: round((Math.exp(dLogMa) - 1) * 100, 2), gdpUpliftPct: round(cityUpliftPct, 3) });
  }
  const grossLevelPct = totalGdp > 0 ? weighted / totalGdp : 0;
  const netLevelPct = grossLevelPct * ECONOMY.strawEffectRetention;
  perCity.sort((a, b) => b.gdpUpliftPct - a.gdpUpliftPct);
  return {
    grossLevelPct: round(grossLevelPct, 3),
    netLevelPct: round(netLevelPct, 3),
    annualGrowthBonusPct: round(netLevelPct / ECONOMY.realizationYears, 3),
    topCities: perCity.slice(0, 15),
  };
}

// Same model applied to an arbitrary corridor list (used for the real plan): snap
// each corridor's stations onto the nearest model city, lay HSR edges, run combo
// all-pairs, and measure the market-access uplift. Reuses the caller's flight
// all-pairs when given (flights are rail-independent).
export function corridorNetworkEconomics(corridors, cities, flightEdges, { flightByOrigin = null, wait = WAIT_OPTIONS[0] } = {}) {
  const snap = (lon, lat) => {
    let best = null;
    for (const c of cities) { const d = haversineKm({ lon, lat }, c); if (!best || d < best.d) best = { c, d }; }
    return best && best.d <= 60 ? best.c : null;
  };
  const edges = [];
  for (const corr of corridors) {
    const speed = corr.topSpeedKmh || HIGH_SPEED_KMH;
    const snapped = corr.stations.map((s) => snap(s.lon, s.lat)).filter(Boolean);
    for (let k = 0; k < snapped.length - 1; k += 1) {
      const a = snapped[k], b = snapped[k + 1];
      if (a.id === b.id) continue;
      edges.push({ from: a.id, to: b.id, minutes: Math.round((bentRailKm(a, b) / speed) * 60) });
    }
  }
  let flights = flightByOrigin;
  if (!flights) {
    const fAdj = buildAdjacency({ cities, flightEdges, railEdges: [], waitMinutes: wait, mode: "flight" });
    flights = new Map();
    for (const c of cities) flights.set(c.id, dijkstra(fAdj, nodeCity(c.id)).dist);
  }
  const cAdj = buildAdjacency({ cities, flightEdges, railEdges: edges, waitMinutes: wait, mode: "combo" });
  const combo = new Map();
  for (const c of cities) combo.set(c.id, dijkstra(cAdj, nodeCity(c.id)).dist);
  const baseT = (a, b) => trainMinutes(a, b, BASELINE_TRAIN_KMH);
  const beforeT = (a, b) => Math.min(baseT(a, b), minutesTo(flights.get(a.id)?.get(nodeCity(b.id))) ?? Infinity);
  const afterT = (a, b) => Math.min(baseT(a, b), minutesTo(combo.get(a.id)?.get(nodeCity(b.id))) ?? Infinity);
  return marketAccessUplift(cities, beforeT, afterT);
}

// --- orchestration: cities + flights + geo -> full scenario model ---
export function computeScenario(data, { wait = WAIT_OPTIONS[0] } = {}) {
  const cities = applyTwinPairs(data.cities, data.twins);
  const flightEdges = data.flights.edges;
  const domesticAirports = data.flights.airports;

  // flight all-pairs at the default wait
  const flightAdj = buildAdjacency({ cities, flightEdges, railEdges: [], waitMinutes: wait, mode: "flight" });
  const flightByOrigin = new Map();
  for (const city of cities) flightByOrigin.set(city.id, dijkstra(flightAdj, nodeCity(city.id)).dist);

  // coverage targets: airport-served cities + state capitals; NE gateway by phase 2
  const STATE_CAPITAL_NAMES = new Set([
    "Itanagar", "Guwahati", "Dispur", "Patna", "Raipur", "Panaji", "Mormugao", "Gandhinagar",
    "Ahmedabad", "Chandigarh", "Shimla", "Ranchi", "Bengaluru", "Thiruvananthapuram", "Bhopal",
    "Mumbai", "Imphal", "Shillong", "Aizawl", "Kohima", "Bhubaneswar", "Jaipur", "Gangtok",
    "Chennai", "Hyderabad", "Agartala", "Lucknow", "Dehradun", "Kolkata", "Delhi", "New Delhi",
    "Vijayawada", "Amaravati", "Srinagar", "Puducherry",
  ]);
  const airportNodeCityIds = new Set();
  for (const airport of domesticAirports) {
    let best = null;
    for (const city of cities) { const d = haversineKm(airport, city); if (!best || d < best.d) best = { city, d }; }
    if (best) airportNodeCityIds.add(best.city.id);
  }
  const capitalCityIds = new Set(cities.filter((c) => STATE_CAPITAL_NAMES.has(c.name)).map((c) => c.id));
  const northeastGatewayIds = new Set(cities.filter((c) => c.name === "Guwahati").map((c) => c.id));
  const coverageTargetIds = new Set([...airportNodeCityIds, ...capitalCityIds]);

  const insideIndia = buildInsideIndia(data.geo);
  const hsr = buildSteinerHsrNetwork(cities, { coverageTargetIds, phase2TargetIds: northeastGatewayIds, insideIndia });
  const hsrRoutes = hsr.selectedRoutes;
  const railEdges = hsr.railEdges;
  const hsrAnchorCities = hsr.anchorCities.map((c, i) => ({ rank: i + 1, id: c.id, name: c.name, population: c.population, lat: c.lat, lon: c.lon }));

  // rail + combo all-pairs at the default wait
  const railAdj = buildAdjacency({ cities, flightEdges, railEdges, waitMinutes: wait, mode: "rail" });
  const railDistances = new Map();
  for (const city of cities) railDistances.set(city.id, dijkstra(railAdj, nodeCity(city.id)).dist);
  const comboAdj = buildAdjacency({ cities, flightEdges, railEdges, waitMinutes: wait, mode: "combo" });
  const comboByOrigin = new Map();
  for (const city of cities) comboByOrigin.set(city.id, dijkstra(comboAdj, nodeCity(city.id)).dist);

  // per-phase market-access GDP uplift (cumulative: edges with phase ≤ p).
  // "before" = today's best of baseline train or flight; "after" = best of that
  // plus the HSR+flight combo network built up to phase p.
  const baseMin = (a, b) => trainMinutes(a, b, BASELINE_TRAIN_KMH);
  const flightMinOf = (a, b) => minutesTo(flightByOrigin.get(a.id)?.get(nodeCity(b.id)));
  const beforeMin = (a, b) => Math.min(baseMin(a, b), flightMinOf(a, b) ?? Infinity);
  const economicsByPhase = {};
  for (const p of [1, 2, 3]) {
    const edgesP = railEdges.filter((e) => e.phase <= p);
    const adjP = buildAdjacency({ cities, flightEdges, railEdges: edgesP, waitMinutes: wait, mode: "combo" });
    const comboP = new Map();
    for (const city of cities) comboP.set(city.id, dijkstra(adjP, nodeCity(city.id)).dist);
    const afterMin = (a, b) => Math.min(baseMin(a, b), minutesTo(comboP.get(a.id)?.get(nodeCity(b.id))) ?? Infinity);
    economicsByPhase[p] = marketAccessUplift(cities, beforeMin, afterMin);
  }
  const realEconomics = data.corridorsReal
    ? corridorNetworkEconomics(data.corridorsReal.corridors, cities, flightEdges, { flightByOrigin, wait })
    : null;

  const directAirportRouteSet = new Set(flightEdges.map((e) => `${e.from}|${e.to}`));
  const railEdgeSet = new Set(railEdges.flatMap((e) => [`${e.from}|${e.to}`, `${e.to}|${e.from}`]));
  const cityById = new Map(cities.map((c) => [c.id, c]));
  const pairResultById = new Map();
  const pairResults = [];
  for (let i = 0; i < cities.length; i += 1) {
    for (let j = 0; j < cities.length; j += 1) {
      if (i === j) continue;
      const from = cities[i], to = cities[j];
      const baselineTrainMinutes = trainMinutes(from, to, BASELINE_TRAIN_KMH);
      const hsrDirectMinutes = trainMinutes(from, to, HIGH_SPEED_KMH) + HSR_OVERHEAD_MINUTES;
      const railRaw = minutesTo(railDistances.get(from.id)?.get(nodeCity(to.id)));
      const railMinutes = railRaw === null ? null : railRaw + HSR_OVERHEAD_MINUTES;
      const flightMin = minutesTo(flightByOrigin.get(from.id)?.get(nodeCity(to.id)));
      const comboRaw = minutesTo(comboByOrigin.get(from.id)?.get(nodeCity(to.id)));
      const comboMin = comboRaw === null ? null : comboRaw + HSR_OVERHEAD_MINUTES;
      const currentBestBaselineMinutes = Math.min(baselineTrainMinutes, flightMin ?? Infinity);
      const bestMinutes = Math.min(baselineTrainMinutes, railMinutes ?? Infinity, flightMin ?? Infinity, comboMin ?? Infinity);
      const bestMode = bestMinutes === baselineTrainMinutes ? "baseline"
        : bestMinutes === railMinutes ? "rail" : bestMinutes === flightMin ? "flight" : "combo";
      const pair = {
        id: `${from.id}__${to.id}`, from: from.id, to: to.id, fromName: from.name, toName: to.name,
        distanceKm: round(haversineKm(from, to), 1),
        directFlight: directAirportRouteSet.has(`${from.nearestAirportIata}|${to.nearestAirportIata}`),
        hsrCorridor: railEdgeSet.has(`${from.id}|${to.id}`),
        baselineTrainMinutes, hsrDirectMinutes, railMinutes, flightMinutes: flightMin, comboMinutes: comboMin, bestMode,
        currentBestBaselineMinutes: Number.isFinite(currentBestBaselineMinutes) ? Math.round(currentBestBaselineMinutes) : null,
        railVsFlightMinutes: railMinutes !== null && flightMin !== null ? railMinutes - flightMin : null,
      };
      pairResults.push(pair);
      pairResultById.set(pair.id, pair);
    }
  }

  // per-line gains (lineGainBase) + scored corridors by impact factor
  const lineGainBase = hsrRoutes.map((line) => {
    const fromCity = cityById.get(line.anchorFrom), toCity = cityById.get(line.anchorTo);
    const pair = pairResultById.get(`${line.anchorFrom}__${line.anchorTo}`) ?? pairResultById.get(`${line.anchorTo}__${line.anchorFrom}`) ?? null;
    const baselineTrainMinutes = pair ? pair.baselineTrainMinutes : Math.round(((line.directKm * RAIL_BEND_FACTOR) / BASELINE_TRAIN_KMH) * 60);
    const railNetworkMinutes = line.minutes;
    const currentBestMinutes = pair && pair.currentBestBaselineMinutes != null ? pair.currentBestBaselineMinutes : baselineTrainMinutes;
    const gainMinutes = currentBestMinutes - railNetworkMinutes;
    return {
      phase: line.phase, from: line.anchorFrom, to: line.anchorTo, fromName: line.anchorFromName, toName: line.anchorToName,
      fromStateName: fromCity?.stateName ?? "Unknown", toStateName: toCity?.stateName ?? "Unknown",
      viaNames: line.viaNames, cityCount: line.cityCount, distanceKm: line.directKm, railKm: line.railKm,
      baselineTrainMinutes,
      hsrDirectMinutes: pair ? pair.hsrDirectMinutes : Math.round(((line.directKm * RAIL_BEND_FACTOR) / HIGH_SPEED_KMH) * 60) + HSR_OVERHEAD_MINUTES,
      railNetworkMinutes, flightMinutes: pair ? pair.flightMinutes : null, currentBestMinutes,
      gainMinutes, gainVsCurrentBestMinutes: gainMinutes, gainOverBaselineMinutes: baselineTrainMinutes - railNetworkMinutes,
      endpointPopulation: (fromCity?.population ?? 0) + (toCity?.population ?? 0),
      servedPopulation: line.servedPopulation, personKmDemand: line.personKmDemand, flowDemand: line.flowDemand,
      peakFlow: line.peakFlow, lineDemand: line.lineDemand, cityGdpProxyCrore: line.servedGdpProxyCrore,
      directFlight: pair ? pair.directFlight : false,
    };
  });

  const topHsrGainsByImpact = Object.fromEntries(
    HSR_IMPACT_FACTORS.map((f) => [String(f), scoreLines(lineGainBase, f)]),
  );
  const topHsrGains = topHsrGainsByImpact[String(DEFAULT_HSR_IMPACT_FACTOR)];

  return {
    cities, airports: domesticAirports, flightEdges, mapLines: data.geo,
    hsrAnchorCities, hsrRoutes, railEdges, pairResults, topHsrGains, topHsrGainsByImpact,
    impactFactors: HSR_IMPACT_FACTORS, economicsByPhase, realEconomics,
  };
}

// Cumulative scenario metrics for phase <= maxPhase (track from railEdges; cities,
// population, GDP, time saved from the corridor lines in that phase).
export function scenarioMetrics(model, maxPhase) {
  const edges = model.railEdges.filter((e) => e.phase <= maxPhase);
  const trackKm = edges.reduce((s, e) => s + e.railKm, 0);
  const lines = model.topHsrGains.filter((l) => l.phase <= maxPhase);
  const cityIds = new Set();
  const cityById = new Map(model.cities.map((c) => [c.id, c]));
  for (const e of edges) { cityIds.add(e.from); cityIds.add(e.to); }
  let population = 0, gdp = 0;
  for (const id of cityIds) { const c = cityById.get(id); if (c) { population += c.population; gdp += c.cityGdpProxyCrore; } }
  const timeSaved = lines.reduce((s, l) => s + Math.max(0, l.gainMinutes), 0);
  const econ = model.economicsByPhase?.[Math.min(Math.max(maxPhase, 1), 3)]
    ?? { netLevelPct: 0, grossLevelPct: 0, annualGrowthBonusPct: 0, topCities: [] };
  return {
    corridorCount: lines.length, trackKm, buildCostCrore: trackKm * ECONOMY.costPerKmCrore,
    citiesServed: cityIds.size, population, gdpServedCrore: gdp,
    gdpGrowthPct: ECONOMY.baseGdpGrowthPct + econ.annualGrowthBonusPct,
    gdpLevelUpliftPct: econ.netLevelPct, gdpLevelGrossPct: econ.grossLevelPct,
    gdpAnnualBonusPct: econ.annualGrowthBonusPct, gdpTopCities: econ.topCities,
    totalTimeSavedMinutes: timeSaved, avgGainMinutes: lines.length ? timeSaved / lines.length : 0,
  };
}

export function realPlanMetrics(corridorsReal, realEconomics = null) {
  const corr = corridorsReal.corridors;
  const cities = new Set();
  let trackKm = 0;
  const byStatus = {};
  for (const c of corr) { trackKm += c.lengthKm; for (const s of c.stations) cities.add(s.name); byStatus[c.status] = (byStatus[c.status] || 0) + 1; }
  const annualBonus = realEconomics?.annualGrowthBonusPct ?? 0;
  return {
    corridorCount: corr.length, trackKm, buildCostCrore: trackKm * ECONOMY.costPerKmCrore,
    citiesServed: cities.size, gdpGrowthPct: ECONOMY.baseGdpGrowthPct + annualBonus,
    gdpLevelUpliftPct: realEconomics?.netLevelPct ?? 0, gdpAnnualBonusPct: annualBonus, byStatus,
  };
}

// Real corridors echoed by the scenario network (both endpoints map to a scenario
// city within ~60 km and a rail path connects them).
export function planAgreement(model, corridorsReal) {
  const adj = new Map();
  for (const e of model.railEdges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from).push(e.to); adj.get(e.to).push(e.from);
  }
  const connected = (a, b) => {
    if (a === b) return false;
    const seen = new Set([a]); const stack = [a];
    while (stack.length) { const u = stack.pop(); if (u === b) return true; for (const v of adj.get(u) ?? []) if (!seen.has(v)) { seen.add(v); stack.push(v); } }
    return false;
  };
  const nearest = (lon, lat) => {
    let best = null;
    for (const c of model.cities) { const d = haversineKm({ lon, lat }, c); if (!best || d < best.d) best = { id: c.id, d }; }
    return best && best.d <= 60 ? best.id : null;
  };
  const matched = [];
  for (const rc of corridorsReal.corridors) {
    const a = nearest(rc.stations[0].lon, rc.stations[0].lat);
    const b = nearest(rc.stations[rc.stations.length - 1].lon, rc.stations[rc.stations.length - 1].lat);
    if (a && b && connected(a, b)) matched.push(rc.id);
  }
  return { matchedIds: matched, matchedCount: matched.length };
}
