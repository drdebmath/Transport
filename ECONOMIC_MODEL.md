# GDP growth model

How the site turns an HSR network into a GDP number. Lives in `src/model.js`
(`marketAccessUplift`, `corridorNetworkEconomics`, and the per‑phase loop in
`computeScenario`); knobs in `ECONOMY` / `data/economy.json`.

## What changed and why

The old model was one line:

```
GDP growth % = 6% + 0.5% × (track_km / 1000)
```

It only knew **how much** track you laid, not **where**. Laying 1000 km of HSR
between two empty deserts scored exactly the same as 1000 km between Delhi and
Mumbai. It was also unbounded and linear — no diminishing returns, no losers, no
grounding in anything the Shinkansen or China's HSR actually did.

The new model scores **which cities get faster access to economic mass**, which
is what the empirical HSR literature actually measures.

## The mechanism (what Japan and China teach us)

HSR does not create GDP out of nothing. It does three measurable things:

1. **Raises market access** — a city can suddenly reach more economic mass within
   a usable travel time. Productivity and output respond to this ("agglomeration"
   / "wider economic benefits").
2. **Redistributes** — some of any one city's gain is pulled from elsewhere. In
   Japan this is the famous **straw effect** (ストロー効果): small towns on a new
   Shinkansen line can *lose* shops, offices and population to the big terminus.
3. **Saturates and diminishes** — the first trunk line (connecting the biggest
   masses) does most of the work; later feeders add little, and no single city's
   GDP responds to access without bound.

### Evidence used to calibrate

| Source | Finding | Feeds knob |
|---|---|---|
| **Japan — Shinkansen** (Tōkaidō 1964 →). Hayashi/Okada-style prefecture studies; stations correlate with higher employment/population growth, concentrated in services. | Connected places grow faster, but largely by pulling activity toward big nodes. | mechanism + λ (straw effect) |
| **Ahlfeldt & Feddersen, "From periphery to core" (2018)** — German high‑speed line as a market‑access shock. | County GDP rises with market access; implied **elasticity ≈ 0.12–0.18**, no net job creation (pure reallocation/productivity). | ε = 0.12 |
| **China — HSR DiD studies** (Zheng & Kahn 2013; many since, 2008 → 40,000 km). | Connected cities gain on the order of **+5–7% GDP / GDP‑per‑capita**, strongest in services and tourism. | ε and per‑city sanity band |
| **Qin, "No county left behind?" (2017)** — counties *bypassed* by upgraded lines. | Bypassed counties' GDP/per‑capita **fell ~3–5%** — direct evidence the gains are partly zero‑sum. | **λ = 0.65** (net retention) |
| **Graham et al.** agglomeration elasticities used in UK appraisal (~0.04–0.08 productivity‑to‑density). | Lower bound on how strongly density/access maps to productivity. | ε floor |

The HSR sweet spot in all of this is the **~1–3 hour** trip (where rail beats both
car and the airport‑to‑airport flight chain); that sets the time‑decay scale τ.

## The algorithm

For a given network we have, for every ordered city pair (i, j), the travel time
**before** HSR and **after** HSR:

- `before(i,j)` = min(baseline 50 km/h train, today's flight chain)
- `after(i,j)`  = min(baseline train, HSR + flight combo on this network)

(Both already computed by the all‑pairs Dijkstra the model runs for journey times.
"after" can only be ≤ "before" — the network is a superset of today's options.)

### Step 1 — Market access per city

Gravity accessibility with an exponential time‑decay and an **own‑mass anchor**
(the `GDP_i` term — keeps peripheral cities from starting at ~0 and showing
explosive percentage gains):

```
MA_i = GDP_i + Σ_{j≠i}  GDP_j · exp( − t_ij / τ )
```

- `GDP_j` = city GDP proxy (`cityGdpProxyCrore`)
- `τ` = `timeDecayMinutes` = 90 min → a 3 h trip keeps weight e⁻² ≈ 0.14, a 6 h
  trip e⁻⁴ ≈ 0.02. This is what concentrates the credit on the 1–3 h corridors.

Compute `MA_i^before` and `MA_i^after` with the two time matrices.

### Step 2 — City GDP level response (New Economic Geography form)

GDP scales with market access as `GDP ∝ MA^ε`, so the level change is a **log
difference** (exact for small changes, but tame for the big jumps a peripheral
city sees — this is the fix for the percentage blow‑up):

```
Δy_i = min( cap ,  ε · ( ln MA_i^after − ln MA_i^before ) )
```

- `ε` = `marketAccessElasticity` = 0.12 (GDP‑to‑market‑access elasticity)
- `cap` = `cityUpliftCapPct` = 25% — saturation ceiling; a single city's output
  can't respond to access without bound (land, labour, capacity).

This `Δy_i` is the **gross** one‑time GDP *level* uplift for city i.

### Step 3 — National uplift, net of redistribution

GDP‑weighted mean of the city upliffs (big economies count more), then strip the
zero‑sum redistribution share with λ:

```
gross_national = Σ_i GDP_i · Δy_i  /  Σ_i GDP_i
net_national   = λ · gross_national
```

- `λ` = `strawEffectRetention` = 0.65 → ~35% of local gains are treated as pulled
  from elsewhere (Qin 2017 / Japan straw effect), so only 65% is a true national
  addition.

### Step 4 — Report

- **One‑time GDP level uplift** (the headline): `net_national` %.
- **Annualised contribution**: `net_national / H`, with `H` =
  `realizationYears` = 15 (the level gain accrues over the build/ramp period). This
  is what the "+x %/yr over a 6 % base" growth figure now means.

### Diminishing returns are emergent

There is no hand‑tuned "returns decay" term. Phasing builds **trunk lines first**
(biggest mass pairs → biggest Δln MA), so the marginal GDP per phase falls out on
its own:

```
P1 +1.6%   →   P2 +2.8%   →   P3 +3.9%   (net level, full India scenario)
```

## Per‑phase and real‑plan

- **Scenario, per phase**: re‑run the combo all‑pairs on edges with `phase ≤ p`,
  recompute the uplift. `model.economicsByPhase = {1,2,3}`. Cumulative and concave.
- **Real plan** (`corridorNetworkEconomics`): snap each official corridor's
  stations to the nearest model city, lay HSR edges at the corridor's own top
  speed, run the *same* market‑access model. So scenario‑vs‑real is apples‑to‑
  apples (e.g. full scenario **+3.9%** vs the current real programme **+2.1%**).

## Calibration knobs (`ECONOMY` / `data/economy.json`)

| Knob | Value | Meaning | Anchored to |
|---|---|---|---|
| `marketAccessElasticity` ε | 0.12 | GDP elasticity to market access | Ahlfeldt‑Feddersen 0.12–0.18; China DiD magnitudes |
| `strawEffectRetention` λ | 0.65 | net national share after redistribution | Qin 2017 bypass losses |
| `timeDecayMinutes` τ | 90 | accessibility decay scale | HSR 1–3 h sweet spot |
| `cityUpliftCapPct` | 25 | per‑city saturation ceiling | China top‑gainer magnitudes |
| `realizationYears` H | 15 | years to realise the level gain | typical HSR ramp |

These are empirical and meant to be tuned — the real economy needs calibration a
minimal formula can't see. Self‑check: `npm test` (`node src/test_model.mjs`)
asserts the uplift is positive, concave across phases, net < gross, per‑city
within the band, and that the full scenario out‑lifts the smaller real plan.

## Honest limitations

- It's a **level shift annualised**, not a dynamic growth forecast — no feedback,
  no induced demand, no capacity/financing constraints (China's HSR debt is real
  and unmodelled).
- GDP is a state‑level proxy disaggregated to cities, not measured city GDP.
- Phase "after" times use that phase's network only, but a pair's gain is credited
  to the cumulative network — fine for a level metric, not a year‑by‑year path.
- Not an official forecast. It mirrors what the HSR literature finds, at the
  resolution of open data.
