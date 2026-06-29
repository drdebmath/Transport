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

  // ---- restore state from the URL (shareable / bookmarkable views) ----
  const VIEWS = ["scenario", "real", "contrast", "gdp", "population", "flights"];
  const params = new URLSearchParams(location.search);
  const clampInt = (v, lo, hi, dflt) => (Number.isInteger(+v) && +v >= lo && +v <= hi ? +v : dflt);
  const state = {
    view: VIEWS.includes(params.get("view")) ? params.get("view") : "scenario",
    phase: clampInt(params.get("phase"), 1, 3, 3),
    impact: clampInt(params.get("impact"), 0, 4, 0),
  };
  const writeURL = () =>
    history.replaceState(null, "", "?" + new URLSearchParams({ view: state.view, phase: state.phase, impact: state.impact }));
  // reflect restored state into the controls
  $("phase").value = state.phase; $("phaseVal").textContent = "P" + state.phase;
  $("impact").value = state.impact; $("impactVal").textContent = IMPACTS[state.impact].toFixed(1) + "×";
  const syncViews = () => {
    for (const x of $("views").children) {
      const on = x.dataset.view === state.view;
      x.classList.toggle("active", on);
      x.setAttribute("aria-pressed", String(on));
    }
  };

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
    writeURL();
  }

  // ---- theme (persisted; defaults to OS preference) ----
  let themeName = localStorage.getItem("theme") || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  const applyThemeAll = () => {
    document.documentElement.dataset.theme = themeName;
    viz.applyTheme(themeName);
    $("theme").textContent = themeName === "light" ? "🌙 Dark" : "☀ Light";
  };
  $("theme").addEventListener("click", () => {
    themeName = themeName === "light" ? "dark" : "light";
    localStorage.setItem("theme", themeName);
    applyThemeAll();
  });
  applyThemeAll();

  // ---- controls ----
  $("views").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state.view = b.dataset.view;
    syncViews();
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
  $("reset").addEventListener("click", () => viz.resetView());
  // sortable corridor table — delegated so it survives table re-renders
  $("corrTable").addEventListener("click", (e) => {
    const th = e.target.closest("th.sortable");
    if (th && $("corrTable").contains(th)) sortTable($("corrTable"), th);
  });
  syncViews();

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
  // per-view tilt: near top-down "front" map for line layers, slanted for 3D towers.
  // phi = angle from vertical; small = top-down, large = horizontal.
  orbit.targetPhi = orbit.phi;
  const VIEW_PHI = { gdp: 0.92, population: 0.92 }; // others fall back to front
  const FRONT_PHI = 0.18;
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
  const amb = new THREE.AmbientLight(0xbfe9ff, 0.85);
  scene.add(amb);
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(6, 14, 8);
  scene.add(dir);

  // base map
  const baseGroup = new THREE.Group();
  scene.add(baseGroup);
  const fillMat = new THREE.MeshStandardMaterial({ color: 0x1c3056, transparent: true, opacity: 0.95, roughness: 0.9 });
  const outlineMat = new THREE.LineBasicMaterial({ color: 0x6f93d6, transparent: true, opacity: 0.95 });
  const stateMat = new THREE.LineBasicMaterial({ color: 0x3a5489, transparent: true, opacity: 0.7 });
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
  let lastView = "scenario";
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Always-on labels for the largest cities, so the map is readable at a glance.
  function addCityLabels() {
    const top = [...model.cities].sort((a, b) => b.population - a.population).slice(0, 8);
    for (const c of top) {
      const cv = document.createElement("canvas");
      cv.width = 256; cv.height = 64;
      const cx = cv.getContext("2d");
      cx.font = "bold 34px system-ui, sans-serif";
      cx.fillStyle = labelColor();
      cx.textBaseline = "middle";
      cx.fillText(c.name, 6, 34);
      const tex = new THREE.CanvasTexture(cv);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
      const p = project(c.lon, c.lat, 0);
      sp.position.set(p.x, 0.15, p.z);
      sp.scale.set(1.6, 0.4, 1);
      sp.renderOrder = 10;
      labelsGroup.add(sp);
    }
  }
  const labelsGroup = new THREE.Group();
  scene.add(labelsGroup);

  // ---- theming (dark / light): recolors the 3D scene to match the CSS theme ----
  const THEMES = {
    dark:  { fill: 0x1c3056, outline: 0x6f93d6, state: 0x3a5489, label: "#dbe6fb", amb: 0xbfe9ff },
    light: { fill: 0xc9d8f2, outline: 0x3f5f9c, state: 0x90a8d2, label: "#16233f", amb: 0xffffff },
  };
  let theme = THEMES.dark;
  function labelColor() { return theme.label; }
  function rebuildLabels() {
    for (const o of [...labelsGroup.children]) { labelsGroup.remove(o); o.material?.map?.dispose?.(); o.material?.dispose?.(); }
    addCityLabels();
  }
  function applyTheme(name) {
    theme = THEMES[name] || THEMES.dark;
    fillMat.color.setHex(theme.fill);
    outlineMat.color.setHex(theme.outline);
    stateMat.color.setHex(theme.state);
    amb.color.setHex(theme.amb);
    rebuildLabels();
  }

  function clearOverlay() {
    for (const o of [...overlay.children]) {
      overlay.remove(o);
      o.geometry?.dispose?.();
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else o.material?.dispose?.();
    }
    hover = [];
  }

  // WebGL ignores line width, so solid corridors are drawn as thin tubes
  // (real geometry) for visible thickness; dashed "proposed" lines stay dashes.
  function addTube(points, color, opacity, radius) {
    const curve = new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.04);
    const g = new THREE.TubeGeometry(curve, Math.max(1, (points.length - 1) * 6), radius, 7, false);
    const m = new THREE.MeshStandardMaterial({ color, transparent: true, opacity, emissive: color, emissiveIntensity: 0.4, roughness: 0.5 });
    overlay.add(new THREE.Mesh(g, m));
  }

  function addLine(a, bp, color, opacity, y, dashed, radius = 0.055) {
    if (dashed) {
      const g = new THREE.BufferGeometry().setFromPoints([project(a.lon, a.lat, y), project(bp.lon, bp.lat, y)]);
      const ln = new THREE.Line(g, new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 0.22, gapSize: 0.16 }));
      ln.computeLineDistances();
      overlay.add(ln);
      return;
    }
    addTube([project(a.lon, a.lat, y), project(bp.lon, bp.lat, y)], color, opacity, radius);
  }

  function addPolyline(stations, color, opacity, y, dashed, width) {
    const v = stations.map((s) => project(s.lon, s.lat, y));
    if (dashed) {
      const ln = new THREE.Line(new THREE.BufferGeometry().setFromPoints(v), new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 0.22, gapSize: 0.16 }));
      ln.computeLineDistances();
      overlay.add(ln);
    } else {
      addTube(v, color, opacity, 0.04 + (width || 2) * 0.014);
    }
    for (const s of v) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), new THREE.MeshBasicMaterial({ color }));
      dot.position.copy(s);
      overlay.add(dot);
    }
  }

  // Elevated arc between two points — used for flights so they read as
  // flight paths rather than flat lines overlapping the rail layer.
  function addArc(a, bp, color, opacity, baseY) {
    const pa = project(a.lon, a.lat, baseY), pb = project(bp.lon, bp.lat, baseY);
    const mid = pa.clone().add(pb).multiplyScalar(0.5);
    mid.y += 0.35 + pa.distanceTo(pb) * 0.18; // longer hops arc higher
    const pts = new THREE.QuadraticBezierCurve3(pa, mid, pb).getPoints(24);
    const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
    overlay.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), m));
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
    lastView = state.view;
    orbit.targetPhi = VIEW_PHI[state.view] ?? FRONT_PHI;
    const drawScenario = (dim) => {
      const seen = new Set();
      for (const e of model.railEdges) {
        if (e.phase > state.phase) continue;
        const from = cityById.get(e.from), to = cityById.get(e.to);
        if (!from || !to) continue;
        addLine(from, to, new THREE.Color(phaseColor(e.phase)), dim ? 0.32 : (e.connector ? 0.5 : 0.85), 0.22, false, e.connector ? 0.04 : 0.06);
        for (const c of [from, to]) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          hover.push({ pos: project(c.lon, c.lat, 0.22), title: c.name, detail: `${c.stateName} · pop ${fmt(c.population)}` });
        }
      }
    };
    const drawReal = (bright) => {
      const meta = corridorsReal.statusMeta;
      for (const c of corridorsReal.corridors) {
        const col = new THREE.Color(meta[c.status].color);
        addPolyline(c.stations, col, bright ? (c.exact ? 1 : 0.9) : 0.85, c.exact ? 0.34 : 0.3, c.status === "proposed", c.exact ? 3 : 2);
        for (const s of c.stations)
          hover.push({ pos: project(s.lon, s.lat, c.exact ? 0.34 : 0.3), title: s.name, detail: `${c.name} · ${meta[c.status].label}` });
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
        if (f && t) addArc(f, t, col, 0.3, 0.16);
      }
      for (const a of model.airports)
        hover.push({ pos: project(a.lon, a.lat, 0.16), title: a.iata, detail: a.name || a.city || "airport" });
    }
  }

  // interaction (mouse + touch, incl. two-finger pinch-zoom)
  let drag = null, lx = 0, ly = 0, pinchDist = 0;
  const el = renderer.domElement;
  const pointers = new Map();
  const spread = () => { const p = [...pointers.values()]; return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); };
  const zoomBy = (f) => { orbit.radius = Math.min(40, Math.max(6, orbit.radius * f)); updateCamera(); };
  el.addEventListener("pointerdown", (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    el.setPointerCapture(e.pointerId);
    if (pointers.size === 2) { drag = null; pinchDist = spread(); return; }
    drag = e.shiftKey || e.button === 2 ? "pan" : "rot"; lx = e.clientX; ly = e.clientY; el.style.cursor = "grabbing";
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (!pointers.size) { drag = null; el.style.cursor = "grab"; }
    try { el.releasePointerCapture(e.pointerId); } catch {}
  };
  el.addEventListener("pointerup", endPointer);
  el.addEventListener("pointercancel", endPointer);
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  el.addEventListener("pointermove", (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const d = spread();
      if (pinchDist) zoomBy(pinchDist / d);
      pinchDist = d;
      $("tip").style.display = "none";
      return;
    }
    if (drag) {
      const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
      if (drag === "rot") {
        orbit.theta -= dx * 0.005;
        orbit.phi = Math.min(Math.PI / 2.05, Math.max(0.15, orbit.phi - dy * 0.005));
        orbit.targetPhi = orbit.phi; // manual drag wins, stop tweening
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
  el.addEventListener("wheel", (e) => { e.preventDefault(); zoomBy(1 + Math.sign(e.deltaY) * 0.08); }, { passive: false });

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
  (function loop() {
    requestAnimationFrame(loop);
    if (Math.abs(orbit.phi - orbit.targetPhi) > 0.001) {
      orbit.phi += (orbit.targetPhi - orbit.phi) * (reduceMotion ? 1 : 0.12);
      updateCamera();
    }
    renderer.render(scene, camera);
  })();

  function resetView() {
    orbit.theta = home.theta; orbit.radius = home.radius;
    orbit.target.set(0, 0, 0);
    orbit.targetPhi = VIEW_PHI[lastView] ?? FRONT_PHI;
    if (reduceMotion) { orbit.phi = orbit.targetPhi; }
    updateCamera();
  }

  return { setOverlay, resetView, applyTheme };
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

// Click-to-sort by any column. Numeric cells carry a data-sort raw value;
// everything else falls back to text. Toggles asc/desc on repeat clicks.
function sortTable(table, th) {
  const ths = [...th.parentElement.children];
  const i = ths.indexOf(th);
  const tbody = table.tBodies[0];
  if (!tbody) return;
  const asc = !th.classList.contains("sort-asc");
  for (const h of ths) h.classList.remove("sort-asc", "sort-desc");
  th.classList.add(asc ? "sort-asc" : "sort-desc");
  const val = (tr) => { const td = tr.children[i]; return td ? (td.dataset.sort ?? td.textContent ?? "") : ""; };
  const rows = [...tbody.rows].sort((a, b) => {
    const va = val(a), vb = val(b), na = parseFloat(va), nb = parseFloat(vb);
    const bothNum = va !== "" && vb !== "" && !Number.isNaN(na) && !Number.isNaN(nb);
    const c = bothNum ? na - nb : String(va).toLowerCase().localeCompare(String(vb).toLowerCase());
    return asc ? c : -c;
  });
  for (const r of rows) tbody.appendChild(r);
}

function renderScenarioTable(model, state) {
  $("tableTitle").textContent = `Top scenario corridors (impact ${IMPACTS[state.impact].toFixed(1)}×)`;
  const list = model.topHsrGainsByImpact[String(IMPACTS[state.impact])].filter((l) => l.phase <= state.phase).slice(0, 40);
  const head = `<thead><tr><th class="sortable">#</th><th class="sortable">Corridor</th><th class="num sortable">Phase</th><th class="num sortable">Rail km</th>` +
    `<th class="num sortable">HSR</th><th class="num sortable">Best now</th><th class="num sortable">Saved</th><th class="num sortable">Pop served</th><th class="num sortable">Score</th></tr></thead>`;
  const body = list.map((l) => {
    const col = phaseColor(l.phase);
    const via = l.viaNames?.length ? ` <span class="note">via ${l.viaNames.slice(0, 3).join(", ")}${l.viaNames.length > 3 ? "…" : ""}</span>` : "";
    return `<tr><td data-sort="${l.rank}">${l.rank}</td><td><i class="swatch" style="background:${col}"></i>${l.fromName} – ${l.toName}${via}</td>` +
      `<td class="num" data-sort="${l.phase}">P${l.phase}</td><td class="num" data-sort="${l.railKm}">${fmt(l.railKm)}</td><td class="num" data-sort="${l.railNetworkMinutes}">${fmtMin(l.railNetworkMinutes)}</td>` +
      `<td class="num" data-sort="${l.currentBestMinutes}">${fmtMin(l.currentBestMinutes)}</td><td class="num" data-sort="${l.gainMinutes}">${fmtMin(l.gainMinutes)}</td>` +
      `<td class="num" data-sort="${l.servedPopulation}">${fmt(l.servedPopulation)}</td><td class="num" data-sort="${l.routeScore}">${l.routeScore}</td></tr>`;
  }).join("");
  $("corrTable").innerHTML = head + `<tbody>${body}</tbody>`;
}

function renderRealTable(corridorsReal, agreement) {
  $("tableTitle").textContent = "Real & proposed corridors";
  const matched = new Set(agreement.matchedIds);
  const order = { "under-construction": 0, approved: 1, dpr: 2, proposed: 3 };
  const meta = corridorsReal.statusMeta;
  const list = [...corridorsReal.corridors].sort((a, b) => order[a.status] - order[b.status] || b.lengthKm - a.lengthKm);
  const head = `<thead><tr><th class="sortable">Corridor</th><th class="sortable">Status</th><th class="num sortable">km</th><th class="num sortable">km/h</th>` +
    `<th class="num sortable">Target</th><th class="num sortable">Stops</th><th class="sortable">In scenario?</th><th class="sortable">Notes</th></tr></thead>`;
  const body = list.map((c) => {
    const m = meta[c.status];
    return `<tr><td><i class="swatch" style="background:${m.color}"></i>${c.name}</td><td>${m.label}</td>` +
      `<td class="num" data-sort="${c.lengthKm}">${fmt(c.lengthKm)}</td><td class="num" data-sort="${c.topSpeedKmh}">${c.topSpeedKmh}</td><td class="num" data-sort="${c.targetYear || 0}">${c.targetYear || "—"}</td>` +
      `<td class="num" data-sort="${c.stations.length}">${c.stations.length}</td><td>${matched.has(c.id) ? "✓ echoed" : "—"}</td><td class="note">${c.note}</td></tr>`;
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
