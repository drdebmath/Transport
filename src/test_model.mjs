// Self-check for the ported scenario model. Run: node src/test_model.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { computeScenario, scenarioMetrics, realPlanMetrics, planAgreement, ECONOMY } from "./model.js";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "../data");
const load = (f) => JSON.parse(readFileSync(join(DATA, f), "utf8"));
const data = { cities: load("cities.json"), flights: load("flights.json"), geo: load("geo_india.json") };
const corridorsReal = load("corridors_real.json");

const t0 = Date.now();
const model = computeScenario({ ...data, corridorsReal });
const ms = Date.now() - t0;
const assert = (c, m) => { if (!c) throw new Error("FAIL: " + m); };

assert(model.hsrRoutes.length > 0, "produced HSR corridor lines");
assert(model.railEdges.length > 0, "produced rail segments");
assert(model.topHsrGains.length === model.hsrRoutes.length, "scored every line");
assert(model.pairResults.length === 230 * 229, `all city pairs (${model.pairResults.length})`);
assert(model.railEdges.every((e) => [1, 2, 3].includes(e.phase)), "every segment has a phase");
assert(Object.keys(model.topHsrGainsByImpact).length === 5, "5 impact-factor rankings");

// impact factor re-sorts the ranking (econ-heavy differs from baseline)
const base = model.topHsrGainsByImpact["1"].map((l) => `${l.from}-${l.to}`).join(",");
const heavy = model.topHsrGainsByImpact["3"].map((l) => `${l.from}-${l.to}`).join(",");
assert(base !== heavy, "impact factor changes corridor order");

// metrics grow with phase
const m1 = scenarioMetrics(model, 1), m2 = scenarioMetrics(model, 2), m3 = scenarioMetrics(model, 3);
assert(m1.trackKm < m2.trackKm && m2.trackKm < m3.trackKm, "track km grows by phase");
assert(m3.gdpGrowthPct > ECONOMY.baseGdpGrowthPct, "GDP growth above base");

// market-access GDP model: positive, concave, monotonic; per-city in a sane band
const e1 = model.economicsByPhase[1], e3 = model.economicsByPhase[3];
assert(e3.netLevelPct > 0, "positive national GDP level uplift");
assert(e1.netLevelPct <= e3.netLevelPct, "uplift grows as the network grows");
assert(e3.grossLevelPct > e3.netLevelPct, "straw effect strips part of the gross uplift");
assert(e3.topCities[0].gdpUpliftPct < 30, `top city uplift in a sane band (${e3.topCities[0].gdpUpliftPct}%)`);

const real = realPlanMetrics(corridorsReal, model.realEconomics);
assert(real.corridorCount === corridorsReal.corridors.length, "real plan corridor count");
assert(model.realEconomics && real.gdpLevelUpliftPct >= 0, "real plan economics computed");
assert(e3.netLevelPct > real.gdpLevelUpliftPct, "full scenario out-lifts the smaller real plan");

const agree = planAgreement(model, corridorsReal);
assert(agree.matchedCount >= 0 && agree.matchedCount <= real.corridorCount, "agreement in range");

console.log(`ok: model checks pass (${ms} ms)`);
console.log(`  scenario: ${model.hsrRoutes.length} lines, ${model.railEdges.length} segments`);
console.log(`  full network: ${Math.round(m3.trackKm).toLocaleString()} km, ${m3.citiesServed} cities, ` +
  `cost ${(m3.buildCostCrore/100000).toFixed(1)} lakh cr`);
console.log(`  GDP level uplift (net): P1 +${m1.gdpLevelUpliftPct}% | P2 +${m2.gdpLevelUpliftPct}% | P3 +${m3.gdpLevelUpliftPct}% ` +
  `(gross +${m3.gdpLevelGrossPct}%, ~+${m3.gdpAnnualBonusPct}%/yr over ${ECONOMY.realizationYears}yr)`);
console.log(`  biggest city winners: ${m3.gdpTopCities.slice(0, 5).map((c) => `${c.name} +${c.gdpUpliftPct}%`).join(", ")}`);
console.log(`  phase track km: P1 ${Math.round(m1.trackKm)} | P2 ${Math.round(m2.trackKm)} | P3 ${Math.round(m3.trackKm)}`);
console.log(`  real plan: ${real.corridorCount} corridors, ${real.trackKm} km, ${real.citiesServed} cities, GDP level +${real.gdpLevelUpliftPct}%`);
console.log(`  real corridors echoed by scenario: ${agree.matchedCount}/${real.corridorCount} (${agree.matchedIds.join(", ")})`);
console.log(`  top scenario corridor: ${model.topHsrGains[0].fromName}->${model.topHsrGains[0].toName} ` +
  `(saves ${Math.round(model.topHsrGains[0].gainMinutes)} min)`);
