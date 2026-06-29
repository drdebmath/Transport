// Vanilla Three.js front-end. Loads data/*.json, computes the scenario model
// (src/model.js) in the browser, renders the 3D India map with switchable overlays
// (scenario HSR, real HSR, contrast, GDP, population, flights) and the comparison
// panel + corridor table. No build step.
import * as THREE from "../vendor/three.module.js";
import {
  computeScenario, scenarioMetrics, realPlanMetrics, planAgreement,
  haversineKm, PHASE_META, ECONOMY,
} from "./model.js";

const $ = (id) => document.getElementById(id);
const fmt = (n) => new Intl.NumberFormat("en-IN").format(Math.round(n));
const fmtCr = (cr) => (cr >= 100000 ? `₹${(cr / 100000).toFixed(2)} lakh cr` : `₹${fmt(cr)} cr`);
const fmtMin = (m) => {
  if (m == null || !Number.isFinite(m)) return "—";
  const neg = m < 0;
  const r = Math.round(Math.abs(m)), h = Math.floor(r / 60), mm = r % 60;
  return (neg ? "−" : "") + (h ? `${h}h ${String(mm).padStart(2, "0")}m` : `${mm}m`);
};
const phaseColor = (p) => PHASE_META[Math.min(Math.max(p, 1), 3) - 1].color;

const IMPACTS = [1, 1.5, 2, 2.5, 3];

async function loadJSON(f) {
  const r = await fetch(`./data/${f}`);
  if (!r.ok) throw new Error(`load ${f}: ${r.status}`);
  return r.json();
}

(async function main() {
  const [cities, flights, geo, economy, corridorsReal, sources] = await Promise.all(
    ["cities.json", "flights.json", "geo_india.json", "economy.json", "corridors_real.json", "sources.json"].map(loadJSON),
  );
  // compute on next frame so the "Computing…" message paints first
  await new Promise((r) => setTimeout(r, 30));
  const model = computeScenario({ cities, flights, geo, corridorsReal });
  const real = realPlanMetrics(corridorsReal, model.realEconomics);
  const agreement = planAgreement(model, corridorsReal);
  $("loading").style.display = "none";

  const viz = setupScene($("map"), geo, model);
  const state = { view: "scenario", phase: 3, impact: 0 };

  // ---- projection bounds (match the original) ----
  function render() {
    viz.setOverlay(state, { model, corridorsReal, agreement });
    updateLegend(state);
    updatePanels(state, { model, real, corridorsReal, agreement, economy });
    // phase control only relevant for scenario/contrast
    const phaseRelevant = state.view === "scenario" || state.view === "contrast";
    $("phaseCtl").style.opacity = phaseRelevant ? 1 : 0.4;
    $("phase").disabled = !phaseRelevant;
    const impactRelevant = state.view !== "flights";
    $("impactCtl").style.opacity = impactRelevant ? 1 : 0.4;
  }

  // ---- controls ----
  $("views").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state.view = b.dataset.view;
    for (const x of $("views").children) x.classList.toggle("active", x === b);
    render();
  });
  $("phase").addEventListener("input", (e) => {
    state.phase = +e.target.value;
    $("phaseVal").textContent = "P" + state.phase;
    render();
  });
  $("impact").addEventListener("input", (e) => {
    state.impact = +e.target.value;
    $("impactVal").textContent = IMPACTS[state.impact].toFixed(1) + "×";
    render();
  });

  renderSources(sources);
  $("footer").textContent =
    `Scenario recomputed in-browser from open data (${model.cities.length} cities, ${model.flightEdges.length} flight links). ` +
    `The HSR network is a modeled demand scenario; the real plan is the official NHSRCL / Budget 2026-27 programme. Not an official rail plan.`;
  render();
})().catch((err) => {
  $("loading").textContent = "Error: " + err.message;
  console.error(err);
});

// ================= scene =================
function setupScene(container, geo, model) {
  const cityById = new Map(model.cities.map((c) => [c.id, c]));
  const pts = [...geo.flatMap((l) => l.points), ...model.cities.map((c) => [c.lon, c.lat])];
  const b = {
    minLon: Math.min(...pts.map((p) => p[0])) - 0.8, maxLon: Math.max(...pts.map((p) => p[0])) + 0.8,
    minLat: Math.min(...pts.map((p) => p[1])) - 0.8, maxLat: Math.max(...pts.map((p) => p[1])) + 0.8,
  };
  const W = 18, D = 16;
  const sc = (v, mn, mx, a, z) => (mx === mn ? (a + z) / 2 : a + ((v - mn) / (mx - mn)) * (z - a));
  const project = (lon, lat, y = 0) =>
    new THREE.Vector3(sc(lon, b.minLon, b.maxLon, -W / 2, W / 2), y, sc(lat, b.minLat, b.maxLat, D / 2, -D / 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  const home = { radius: Math.hypot(14, 16), theta: 0, phi: Math.acos(14 / Math.hypot(14, 16)) };
  const orbit = { ...home, target: new THREE.Vector3(0, 0, 0) };
  const updateCamera = () => {
    const s = Math.sin(orbit.phi);
    camera.position.set(
      orbit.target.x + orbit.radius * s * Math.sin(orbit.theta),
      orbit.target.y + orbit.radius * Math.cos(orbit.phi),
      orbit.target.z + orbit.radius * s * Math.cos(orbit.theta),
    );
    camera.lookAt(orbit.target);
    camera.updateProjectionMatrix();
  };
  updateCamera();

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.appendChild(renderer.domElement);
  scene.add(new THREE.AmbientLight(0xbfe9ff, 0.85));
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(6, 14, 8);
  scene.add(dir);

  // base map
  const baseGroup = new THREE.Group();
  scene.add(baseGroup);
  const fillMat = new THREE.MeshStandardMaterial({ color: 0x0e1830, transparent: true, opacity: 0.85, roughness: 0.95 });
  const outlineMat = new THREE.LineBasicMaterial({ color: 0x2b3e63, transparent: true, opacity: 0.7 });
  const stateMat = new THREE.LineBasicMaterial({ color: 0x1c2c49, transparent: true, opacity: 0.55 });
  for (const line of geo) {
    const proj = line.points.map(([lo, la]) => project(lo, la, 0));
    if (proj.length < 3) continue;
    if (line.outline) {
      const shape = new THREE.Shape(proj.map((p) => new THREE.Vector2(p.x, p.z)));
      const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape), fillMat);
      fill.rotation.x = Math.PI / 2;
      fill.position.y = -0.015;
      baseGroup.add(fill);
    }
    baseGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(proj), line.outline ? outlineMat : stateMat));
  }

  const overlay = new THREE.Group();
  scene.add(overlay);
  let hover = []; // {pos, title, detail}

  function clearOverlay() {
    for (const o of [...overlay.children]) {
      overlay.remove(o);
      o.geometry?.dispose?.();
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else o.material?.dispose?.();
    }
    hover = [];
  }

  function addLine(a, bp, color, opacity, y, dashed) {
    const g = new THREE.BufferGeometry().setFromPoints([project(a.lon, a.lat, y), project(bp.lon, bp.lat, y)]);
    let m;
    if (dashed) {
      m = new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 0.22, gapSize: 0.16 });
      const ln = new THREE.Line(g, m);
      ln.computeLineDistances();
      overlay.add(ln);
      return;
    }
    m = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
    overlay.add(new THREE.Line(g, m));
  }

  function addPolyline(stations, color, opacity, y, dashed, width) {
    const v = stations.map((s) => project(s.lon, s.lat, y));
    const g = new THREE.BufferGeometry().setFromPoints(v);
    const m = dashed
      ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 0.22, gapSize: 0.16 })
      : new THREE.LineBasicMaterial({ color, transparent: true, opacity });
    const ln = new THREE.Line(g, m);
    if (dashed) ln.computeLineDistances();
    overlay.add(ln);
    for (const s of v) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), new THREE.MeshBasicMaterial({ color }));
      dot.position.copy(s);
      overlay.add(dot);
    }
  }

  function addTowers(kind) {
    const maxPop = Math.max(...model.cities.map((c) => c.population));
    const maxGdp = Math.max(...model.cities.map((c) => c.cityGdpProxyCrore));
    for (const c of model.cities) {
      const isGdp = kind === "gdp";
      const val = isGdp ? c.cityGdpProxyCrore : c.population;
      const norm = Math.max(0.02, val / (isGdp ? maxGdp : maxPop));
      const h = 0.12 + Math.pow(norm, 0.45) * 5.4;
      const r = 0.02 + norm * 0.03;
      const col = isGdp
        ? new THREE.Color(0x2bd4a7).lerp(new THREE.Color(0xffcf33), Math.pow(norm, 0.6))
        : new THREE.Color(0x9a8cf0).lerp(new THREE.Color(0xff2fc8), Math.pow(norm, 0.6));
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(r, h, 7),
        new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.4, roughness: 0.35 }),
      );
      const p = project(c.lon, c.lat, 0);
      cone.position.set(p.x, h / 2 + 0.02, p.z);
      overlay.add(cone);
      hover.push({
        pos: new THREE.Vector3(p.x, h + 0.2, p.z),
        title: c.name,
        detail: isGdp ? `${c.stateName} · GDP proxy ${fmt(c.cityGdpProxyCrore)} cr` : `${c.stateName} · pop ${fmt(c.population)}`,
      });
    }
  }

  function setOverlay(state, { model, corridorsReal, agreement }) {
    clearOverlay();
    const drawScenario = (dim) => {
      const seen = new Set();
      for (const e of model.railEdges) {
        if (e.phase > state.phase) continue;
        const from = cityById.get(e.from), to = cityById.get(e.to);
        if (!from || !to) continue;
        addLine(from, to, new THREE.Color(phaseColor(e.phase)), dim ? 0.32 : (e.connector ? 0.5 : 0.8), 0.22, false);
        for (const c of [from, to]) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          hover.push({ pos: project(c.lon, c.lat, 0.22), title: c.name, detail: `${c.stateName} · pop ${fmt(c.population)}` });
        }
      }
    };
    const drawReal = (bright) => {
      const matched = new Set(agreement.matchedIds);
      const meta = corridorsReal.statusMeta;
      for (const c of corridorsReal.corridors) {
        const col = new THREE.Color(meta[c.status].color);
        addPolyline(c.stations, col, bright ? (c.exact ? 1 : 0.9) : 0.85, c.exact ? 0.34 : 0.3, c.status === "proposed", c.exact ? 3 : 2);
        for (const s of c.stations)
          hover.push({ pos: project(s.lon, s.lat, c.exact ? 0.34 : 0.3), title: s.name, detail: `${c.name} · ${meta[c.status].label}` });
        void matched;
      }
    };
    if (state.view === "scenario") drawScenario(false);
    else if (state.view === "real") drawReal(true);
    else if (state.view === "contrast") { drawScenario(true); drawReal(true); }
    else if (state.view === "gdp") addTowers("gdp");
    else if (state.view === "population") addTowers("population");
    else if (state.view === "flights") {
      const air = new Map(model.airports.map((a) => [a.iata, a]));
      const col = new THREE.Color(0xff4fd8);
      for (const e of model.flightEdges) {
        const f = air.get(e.from), t = air.get(e.to);
        if (f && t) addLine(f, t, col, 0.18, 0.16, false);
      }
      for (const a of model.airports)
        hover.push({ pos: project(a.lon, a.lat, 0.16), title: a.iata, detail: a.name || a.city || "airport" });
    }
  }

  // interaction
  let drag = null, lx = 0, ly = 0;
  const el = renderer.domElement;
  el.addEventListener("pointerdown", (e) => { drag = e.shiftKey || e.button === 2 ? "pan" : "rot"; lx = e.clientX; ly = e.clientY; el.setPointerCapture(e.pointerId); el.style.cursor = "grabbing"; });
  el.addEventListener("pointerup", (e) => { drag = null; el.style.cursor = "grab"; try { el.releasePointerCapture(e.pointerId); } catch {} });
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  el.addEventListener("pointermove", (e) => {
    if (drag) {
      const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
      if (drag === "rot") {
        orbit.theta -= dx * 0.005;
        orbit.phi = Math.min(Math.PI / 2.05, Math.max(0.15, orbit.phi - dy * 0.005));
      } else {
        const panScale = orbit.radius * 0.0011;
        orbit.target.x -= dx * panScale * Math.cos(orbit.theta);
        orbit.target.z += dx * panScale * Math.sin(orbit.theta);
        orbit.target.x -= dy * panScale * Math.sin(orbit.theta);
        orbit.target.z -= dy * panScale * Math.cos(orbit.theta);
      }
      updateCamera();
      $("tip").style.display = "none";
    } else {
      showTip(e);
    }
  });
  el.addEventListener("wheel", (e) => { e.preventDefault(); orbit.radius = Math.min(40, Math.max(6, orbit.radius * (1 + Math.sign(e.deltaY) * 0.08))); updateCamera(); }, { passive: false });

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function showTip(e) {
    if (!hover.length) { $("tip").style.display = "none"; return; }
    const rect = el.getBoundingClientRect();
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    ray.setFromCamera(ndc, camera);
    let best = null;
    for (const h of hover) {
      const sp = h.pos.clone().project(camera);
      const px = (sp.x * 0.5 + 0.5) * rect.width, py = (-sp.y * 0.5 + 0.5) * rect.height;
      const d = Math.hypot(px - (e.clientX - rect.left), py - (e.clientY - rect.top));
      if (d < 14 && (!best || d < best.d)) best = { h, d, px, py };
    }
    const tip = $("tip");
    if (best) {
      tip.innerHTML = `<b>${best.h.title}</b><br>${best.h.detail}`;
      tip.style.left = best.px + 12 + "px";
      tip.style.top = best.py + "px";
      tip.style.display = "block";
    } else tip.style.display = "none";
  }

  function resize() {
    const r = container.getBoundingClientRect();
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / Math.max(1, r.height);
    updateCamera();
  }
  new ResizeObserver(resize).observe(container);
  resize();
  (function loop() { requestAnimationFrame(loop); renderer.render(scene, camera); })();

  return { setOverlay };
}

// ================= panels =================
function updateLegend(state) {
  const L = $("legend");
  if (state.view === "scenario" || state.view === "contrast") {
    let html = PHASE_META.map((p) => `<span style="color:${p.color}"><i style="background:${p.color}"></i>${p.label}: ${p.blurb}</span>`).join("");
    if (state.view === "contrast")
      html += `<span style="color:#18e0c4"><i style="background:#18e0c4"></i>Real: under construction</span>` +
        `<span style="color:#ffd166"><i style="background:#ffd166"></i>Real: approved</span>` +
        `<span style="color:#b388ff"><i class="dash" style="color:#b388ff"></i>Real: proposed</span>` +
        `<span class="note">scenario lines dimmed</span>`;
    L.innerHTML = html;
  } else if (state.view === "real") {
    L.innerHTML =
      `<span style="color:#18e0c4"><i style="background:#18e0c4"></i>Under construction</span>` +
      `<span style="color:#ffd166"><i style="background:#ffd166"></i>Approved / DPR cleared</span>` +
      `<span style="color:#f7895b"><i style="background:#f7895b"></i>DPR under preparation</span>` +
      `<span style="color:#b388ff"><i class="dash" style="color:#b388ff"></i>Proposed (Budget 2026-27)</span>`;
  } else if (state.view === "gdp") L.innerHTML = `<span>City GDP proxy — teal (low) → gold (high)</span>`;
  else if (state.view === "population") L.innerHTML = `<span>Population — lavender (low) → magenta (high)</span>`;
  else L.innerHTML = `<span style="color:#ff4fd8"><i style="background:#ff4fd8"></i>Direct flight routes</span>`;
}

function updatePanels(state, { model, real, corridorsReal, agreement, economy }) {
  const sm = scenarioMetrics(model, state.phase);
  // comparison table (scenario phase vs real plan)
  const rows = [
    ["Corridors / lines", sm.corridorCount, real.corridorCount],
    ["Track length", `${fmt(sm.trackKm)} km`, `${fmt(real.trackKm)} km`],
    ["Build cost", fmtCr(sm.buildCostCrore), fmtCr(real.buildCostCrore)],
    ["Cities served", sm.citiesServed, real.citiesServed],
    ["GDP level uplift", `+${sm.gdpLevelUpliftPct.toFixed(2)}%`, `+${real.gdpLevelUpliftPct.toFixed(2)}%`],
  ];
  $("cmpBody").innerHTML = rows
    .map(([k, s, r]) => `<tr><td>${k}</td><td class="s">${s}</td><td class="r">${r}</td></tr>`)
    .join("");
  $("cmpTitle").textContent = `Scenario (through phase ${state.phase}) vs real plan`;
  $("agree").innerHTML =
    `<b>${agreement.matchedCount} of ${real.corridorCount}</b> real/proposed corridors are echoed by the modeled scenario network — ` +
    `where the demand model independently picks the same city pairs the government is actually building.`;

  // scenario snapshot metrics
  $("metrics").innerHTML = [
    [`${fmt(sm.trackKm)} km`, "modeled track"],
    [`${sm.citiesServed}`, "cities connected"],
    [fmtCr(sm.buildCostCrore), "build cost"],
    [`+${sm.gdpLevelUpliftPct.toFixed(2)}%`, "GDP level (one-time)"],
    [fmtMin(sm.avgGainMinutes), "avg time saved / corridor"],
    [`${sm.corridorCount}`, "corridors in phase"],
  ].map(([v, l]) => `<div class="metric"><div class="big">${v}</div><div class="lbl">${l}</div></div>`).join("");
  $("metricNote").textContent =
    `Time saved is against today's best of train or flight. Cost on the Mumbai-Ahmedabad basis (₹${economy.costPerKmCrore}/km). ` +
    `GDP is a market-access model (ε=${ECONOMY.marketAccessElasticity} GDP-to-access elasticity, ${Math.round(ECONOMY.strawEffectRetention * 100)}% net of ` +
    `redistribution), calibrated to Japan Shinkansen & China HSR evidence; the one-time level gain accrues over ~${ECONOMY.realizationYears} yr.`;

  // corridor table
  if (state.view === "real") renderRealTable(corridorsReal, agreement);
  else renderScenarioTable(model, state);
}

function renderScenarioTable(model, state) {
  $("tableTitle").textContent = `Top scenario corridors (impact ${IMPACTS[state.impact].toFixed(1)}×)`;
  const list = model.topHsrGainsByImpact[String(IMPACTS[state.impact])].filter((l) => l.phase <= state.phase).slice(0, 40);
  const head = `<thead><tr><th>#</th><th>Corridor</th><th class="num">Phase</th><th class="num">Rail km</th>` +
    `<th class="num">HSR</th><th class="num">Best now</th><th class="num">Saved</th><th class="num">Pop served</th><th class="num">Score</th></tr></thead>`;
  const body = list.map((l) => {
    const col = phaseColor(l.phase);
    const via = l.viaNames?.length ? ` <span class="note">via ${l.viaNames.slice(0, 3).join(", ")}${l.viaNames.length > 3 ? "…" : ""}</span>` : "";
    return `<tr><td>${l.rank}</td><td><i class="swatch" style="background:${col}"></i>${l.fromName} – ${l.toName}${via}</td>` +
      `<td class="num">P${l.phase}</td><td class="num">${fmt(l.railKm)}</td><td class="num">${fmtMin(l.railNetworkMinutes)}</td>` +
      `<td class="num">${fmtMin(l.currentBestMinutes)}</td><td class="num">${fmtMin(l.gainMinutes)}</td>` +
      `<td class="num">${fmt(l.servedPopulation)}</td><td class="num">${l.routeScore}</td></tr>`;
  }).join("");
  $("corrTable").innerHTML = head + `<tbody>${body}</tbody>`;
}

function renderRealTable(corridorsReal, agreement) {
  $("tableTitle").textContent = "Real & proposed corridors";
  const matched = new Set(agreement.matchedIds);
  const order = { "under-construction": 0, approved: 1, dpr: 2, proposed: 3 };
  const meta = corridorsReal.statusMeta;
  const list = [...corridorsReal.corridors].sort((a, b) => order[a.status] - order[b.status] || b.lengthKm - a.lengthKm);
  const head = `<thead><tr><th>Corridor</th><th>Status</th><th class="num">km</th><th class="num">km/h</th>` +
    `<th class="num">Target</th><th class="num">Stops</th><th>In scenario?</th><th>Notes</th></tr></thead>`;
  const body = list.map((c) => {
    const m = meta[c.status];
    return `<tr><td><i class="swatch" style="background:${m.color}"></i>${c.name}</td><td>${m.label}</td>` +
      `<td class="num">${fmt(c.lengthKm)}</td><td class="num">${c.topSpeedKmh}</td><td class="num">${c.targetYear || "—"}</td>` +
      `<td class="num">${c.stations.length}</td><td>${matched.has(c.id) ? "✓ echoed" : "—"}</td><td class="note">${c.note}</td></tr>`;
  }).join("");
  $("corrTable").innerHTML = head + `<tbody>${body}</tbody>`;
}

function renderSources(sources) {
  const link = (s) => `<li><a href="${s.href}">${s.label}</a></li>`;
  const ds = sources.datasetSources || sources.sources || [];
  const cs = sources.corridorSources || [];
  $("sources").innerHTML =
    (cs.length ? `<h3 class="note">Corridor data (news / official)</h3><ul>${cs.map(link).join("")}</ul>` : "") +
    `<h3 class="note">Underlying datasets</h3><ul>${ds.map(link).join("")}</ul>` +
    `<details><summary>Modeling assumptions</summary><ul>${(sources.assumptions || []).map((a) => `<li class="note">${a}</li>`).join("")}</ul></details>`;
}
