# Greenova API Reference

Base URL: `http://<pi-address>:8000` (or the same address as the website when the Pi serves it). Try every endpoint at `/docs`.

All JSON uses the website's names: the `DemoBatch` fields from `src/lib/greenovaData.ts`, the `greenova_settings` keys from the Settings page, and `PROCESS_CONFIG` from `NewBatch.tsx`. Errors return `{"detail": "message"}` with status 400 (bad input), 404 (not found), 409 (not allowed right now, e.g. a safety rule) or 500 (unexpected backend error, still JSON so the website shows the message). The website calls these through `src/lib/api.ts`.

**Storage.** Batches and settings are stored in the MySQL database `greenova_db` (see `database.md`); the JSON is the same as before. A value too long for its column is refused with 422 and the field's name: a batch `id` over 50 characters, a `labReference` over 100, or (400) a Settings text such as `systemName` over 150. `date` must be `YYYY-MM-DD`. Each lab result is kept as a new row of `batch_lab_results`; the newest one is the batch's `labResult`. If MySQL can't be reached, the batch endpoints answer 500 with the reason.

## Endpoints

| Method | Path | Body | Website use |
|---|---|---|---|
| GET | `/api/health` | | Is the backend up; `mock: true` in demo mode |
| GET | `/api/config` | | Same structure as `PROCESS_CONFIG`, plus the fixed purification values and `powerSupply.currentControl` |
| GET / PUT | `/api/settings` | some or all Settings keys | Settings page; PUT keeps the keys you leave out |
| GET | `/api/system/status` | | Before You Start tiles, Dashboard and Settings devices |
| GET | `/api/live` | | Sensors, alarm, stage, pump, drain and purification state |
| WS | `/api/ws/live` | | Same as `/api/live`, every second |
| POST | `/api/alarm/clear` | | Clear the alarm banner |
| POST | `/api/demo/load-oil` | `{volumeMl}` | "Load demonstration sensor reading": a new batch's oil in the reactor, everything else empty (demo mode only) |
| POST | `/api/demo/add` | `{place: "reactor" or "purificationTank", grams}` | "Pour acetone (demo)": something poured by hand lands on a simulated load cell (demo mode only) |
| POST | `/api/calculate` | `{oilMassG, ffa, methanolRatio?, catalyst}` | Chemical Quantity Calculator (same keys as `calculateQuantityCards`). Above 4% FFA the esterification dose is the uniform dose for `esterificationDesignFfa` (default 10%), whatever the FFA |
| POST | `/api/calculate/after-esterification` | `{oilMassG, ffaAfter, stageDone, methanolRatio?, catalyst}` | FFA re-check: another stage dosed for `ffaAfter` (40:1), or the exact transesterification amounts |
| POST | `/api/strip/read` | | FFA strip reader: `{ffa, warnings}` |
| GET | `/api/batches` | | Batch History (newest first; the batch in progress has `currentStage`) |
| GET | `/api/batches/next-id` | | `{id}` from the batch naming format |
| GET | `/api/batches/active` | | The batch in progress with its `progress` (`{stage, state, updatedAt}`), or `null` |
| POST | `/api/batches/start` | `{id?}` | "Start Batch": records an In Progress batch. **409** while another batch is in progress or the machine is busy |
| PUT | `/api/batches/{id}/progress` | `{stage, state, batch?}` | Where the Process page is, so the batch can be continued. **409** when it isn't in progress |
| POST | `/api/batches/{id}/cancel` | | Cancel the batch in progress (stays in history as Cancelled). **409** while the machine works |
| GET | `/api/batches/{id}` | | Batch Details |
| POST | `/api/batches` | DemoBatch fields (`id` and `date` optional) | `saveCompletedBatch` (completes the batch in progress in its own row) |
| PATCH | `/api/batches/{id}` | any batch fields | Correct a record (a finished batch can't be set back to In Progress) |
| POST | `/api/batches/{id}/lab-result` | `{labResult: "Passed" or "Failed", labReference?}` | `updateBatchLabResult` |
| POST | `/api/batches/{id}/esterification-stages` | `{stage, ffaBefore, ffaAfter?, doseFfa?, methanolMl, sulfuricAcidMl, acetoneMl}` | Record an esterification stage (the website sends them all with the batch) |
| GET | `/api/analytics/summary` | | Summary cards |
| GET | `/api/analytics/ranges` | | Best Parameters per FFA Range table |
| GET | `/api/analytics/recommended?ffa=5.2` | | `getRecommendedParametersForFfa` (or `null`) |
| GET | `/api/analytics/cost` | | Cost per Liter card and chart |
| GET | `/api/process/stage` | | Current stage state |
| POST | `/api/process/stage/start` | `{stage, batchId?, voltage?, time?, stirring?, current?, oilMassG?}` | Start Esterification, Transesterification or Separation. The website calls it by itself once the dose is loaded. `current` (A, default 1, 0.5–2) is the current setting: the electrodes stop when the measured current goes above it, and with `GREENOVA_PSU_CURRENT_CONTROL=1` the Pi also sets the power supply's current limit to it. `oilMassG` records the batch's oil for the Magnesol amount and the low-output check |
| POST | `/api/process/stage/pause` · `resume` · `complete` · `emergency-stop` · `reset` | | Stage buttons ("Record completion" = `complete`) |
| GET | `/api/process/pump` | | Dosing pump state |
| POST | `/api/process/pump/start` | `{pump: "catalyst" or "acid", targetG, volumeMl, batchId?, stage?}` | The website calls it by itself when a reaction stage opens (and on **Retry** after a pump fault): adds one premixed dose and stops when the reactor load cell has gained `targetG`. `volumeMl` sets the time limit (and the dose time without a load cell). Refused during a stage or while the reactor drains |
| POST | `/api/process/pump/stop` · `skip` | | Stop the pump; "Skip (demo)" = the rest arrives at once (demo mode only) |
| GET | `/api/process/drain` | | Outlet valve state |
| POST | `/api/process/drain/start` | `{valve: "reactor_outlet" or "centrifuge_outlet", batchId?}` | Opens an outlet for its drain time. They open by themselves after transesterification and separation; the website shows only an Open / Closed indicator and doesn't call this |
| POST | `/api/process/drain/stop` · `skip` | | Close the outlet now; `skip` = everything arrives now (demo mode only). Not used by the website |
| GET | `/api/process/purification` | | Purification state |
| POST | `/api/process/purification/start` | `{heaterSubmerged?, batchId?, oilVolumeMl?}` | Start by hand. Normally not needed: purification starts by itself after separation when the level switch detects biodiesel. `heaterSubmerged: true` is the operator's confirmation, used only when there's no level switch |
| POST | `/api/process/purification/magnesol-added` | | **Confirm** on "Add X g Magnesol": purification goes on to the contact step. 409 when it isn't waiting for the Magnesol |
| POST | `/api/process/purification/skip` · `abort` · `acknowledge` | | "Skip timer (demo)" (doesn't skip the Magnesol step), Stop, and Acknowledge |
| POST | `/api/control/heater` · `electrode-power` | `{on}` | Manual hardware test (blocked while a stage runs) |
| POST | `/api/control/valve` | `{name: "reactor_outlet", "centrifuge_outlet" or "mesh_bed", open}` | Manual hardware test (`mesh_bed` = the purification outlet) |
| POST | `/api/control/motor` | `{name: "stirrer", "centrifuge" or "purification_stirrer", duty: 0–1}` | Manual hardware test |
| POST | `/api/control/pump` | `{name: "catalyst" or "acid", on}` | Manual hardware test: priming or cleaning a pump line |
| POST | `/api/control/all-off` | | Emergency stop for everything: stage, pumps, valves, purification |

Values: batch `status` is `Completed`, `Failed`, `In Progress` or `Cancelled`. `labResult` is `Pending`, `Passed`, `Failed` or `Not tested` (set automatically for Failed or Cancelled batches). Stage `state` is `ready`, `running`, `paused`, `complete` or `fault`. Purification `phase` is `ready`, `heating`, `methanol`, `magnesol`, `contact`, `settling`, `cooling`, `drain`, `complete` or `fault`; it goes through them by itself (see README section 6). Pump `phase` is `idle`, `pumping`, `done`, `fault` or `stopped`. Drain `phase` is `idle`, `waiting` (for the centrifuge to stop), `draining`, `done`, `stopped` or `fault`. Range `status` is `No data`, `Testing` or `Proven`.

## How saving a batch works

The website saves the batch once, when the operator clicks "Confirm process finished" after purification (`POST /api/batches`, same fields as `saveCompletedBatch`). If the website started the stages and purification with the same `batchId`, the backend adds what the Pi measured for that batch:

- `temperature`: average transesterification temperature (replaces the website's 27 °C placeholder)
- `energy`: electrode energy from voltage × current (plus the heater, if `heaterPowerWatts` is set), when the website sends 0
- `purification`: the backend's record of the dry wash: `targetTemperature` (90), `highestTemperature`, `heatingTimeSeconds`, `holdTimeSeconds` (methanol removal), `magnesolG`, `magnesolAdded`, `contactTimeSeconds`, `settlingTimeSeconds`, `coolingTimeSeconds`, `drainTimeSeconds`, `outputWeightG`, `oilWeightG`, `stirringSpeed`, `heaterOnSeconds`, any `warning` and safety stop
- `biodieselOutputMl` and `yield`: from the output load cell (`yield` = output mL ÷ oil mL × 100, as on the website)
- `materials` and `catalystToWeighG`: from the calculator formulas, when not sent
- `timeline`: every stage start, pause, resume, completion and stop, each pump load ("Pump B loaded 105.7 g for Esterification 1"), each outlet valve opening and closing, and "Magnesol added (4.6 g)", with times

The website also sends `ffa` and `ffaAboveStrip` (true = the strip showed its darkest color, so `ffa` is the strip's maximum and the batch counts in the "5% and above" range), `esterificationStages` (each stage's dose and its FFA re-check), `oilMassG` (recorded at oil loading) and the exact `catalystToWeighG`.

Saving the same ID twice returns the saved batch unchanged.

## One batch at a time

Only one batch can be processed at a time:

1. **Start.** "Start Batch" on the Process page calls `POST /api/batches/start`. The batch is saved at once with status `In Progress` (so Batch History shows it), with a "Batch started" timeline event. While it is in progress, `POST /api/batches/start` (and `POST /api/batches` with `status: "In Progress"`) answers **409** "Batch B-2026-004 is still in progress…". It also answers 409 while the machine is still busy (a stage, pump, valve or purification running). MySQL checks this too (a locked read in `db.start_batch`), so two starts at the same moment can't both get in.
2. **Continue.** The Process page saves where it is (`PUT /api/batches/{id}/progress`) every few seconds and at each new step: its own state, plus the batch's setup so far (oil, FFA, parameters). The Dashboard, Batch History and the Process page read `GET /api/batches/active`, so the batch is continued, from any device, instead of started again. Stages, pumps, valves and purification refuse another `batchId` (409) while a batch is in progress, and what they do is added to the ongoing batch's timeline as it happens.
3. **Complete or cancel.** `POST /api/batches` with the ongoing batch's ID completes it **in its own row**: it keeps its start time, its timeline and the Pi's purification record, and its progress row is removed. `POST /api/batches/{id}/cancel` marks it `Cancelled` (lab result `Not tested`). Either way a new batch can be started.

## Example responses

`POST /api/calculate` with `{"oilMassG": 460, "ffa": 5, "catalyst": "NaOH"}` (any FFA above 4% gives the same esterification dose):

```json
{"oilMassG": 460.0, "oilVolumeMl": 500.0, "ffa": 5.0, "methanolRatio": 7.0, "catalyst": "NaOH",
 "ffaMassG": 46.0, "doseFfa": 10, "uniformDose": true, "esterificationNeeded": true,
 "esterificationMethanolMl": 130.64, "sulfuricAcidMl": 1.242, "sulfuricAcidG": 2.3,
 "acetoneMl": 50.0, "acetoneG": 39.2, "esterificationPremixMl": 131.882, "esterificationPremixG": 105.7669,
 "transesterificationMethanolMl": 148.0102, "catalystBaseG": 4.6, "neutralizationG": 0.6532,
 "catalystToWeighG": 5.3604, "purity": 98, "transesterificationAcetoneMl": 50.0,
 "transesterificationPremixMl": 148.0102, "transesterificationPremixG": 122.5845,
 "magnesolG": 4.6, "isEstimate": true, "warnings": []}
```

`ffaMassG` is the FFA the dose is for (`doseFfa`), not the measured FFA. `magnesolG` = oil volume × 0.0092 g (1% of the biodiesel), rounded to 0.1 g. `esterificationPremixG` is what pump B must add (methanol + H₂SO₄); `transesterificationPremixG` is what pump A must add (methanol + NaOH/KOH).

`POST /api/calculate/after-esterification` with the re-check still above 1% (`ffaAfter: 1.5`, `stageDone: 1`):

```json
{"action": "anotherStage", "stage": 2, "doseFfa": 1.5, "uniformDose": false, "ffaMassG": 6.9,
 "esterificationMethanolMl": 39.192, "sulfuricAcidMl": 0.1863, "sulfuricAcidG": 0.345,
 "acetoneMl": 0.0, "acetoneG": 0.0, "esterificationPremixMl": 39.3783, "esterificationPremixG": 31.3851}
```

At or below 1% (`ffaAfter: 0.8`, `stageDone: 2`):

```json
{"action": "transesterification", "ffa": 0.8, "isEstimate": false, "transesterificationMethanolMl": 148.0102,
 "catalystBaseG": 4.6, "neutralizationG": 0.5226, "catalystToWeighG": 5.2271, "purity": 98,
 "acetoneMl": 50.0, "acetoneG": 39.2, "transesterificationPremixMl": 148.0102, "transesterificationPremixG": 122.4512}
```

`/api/ws/live` message (also `GET /api/live`), while pump B loads a dose (`stage` and `purification` as before):

```json
{
  "mock": true, "timestamp": "2026-10-12T23:45:37", "alarm": null,
  "sensors": {"oilMassG": 462.4, "outputWeightG": 0.0, "temperature": 27.0, "voltage": 0.0, "current": 0.0,
              "stirrerRpm": 0, "centrifugeRpm": 0, "purificationStirrerRpm": 0, "heaterSubmerged": false,
              "heaterOn": false, "electrodePowerOn": false,
              "meshBedValveOpen": false, "reactorValveOpen": false, "centrifugeValveOpen": false,
              "valves": {"reactor_outlet": false, "centrifuge_outlet": false, "mesh_bed": false},
              "motorDuty": {"stirrer": 0.0, "centrifuge": 0.0, "purification_stirrer": 0.0},
              "pumps": {"catalyst": false, "acid": true}, "timestamp": 1791819937.36},
  "stage": {"stage": null, "state": "ready", "...": "..."},
  "pump": {"pump": "acid", "phase": "pumping", "batchId": "B-2026-025", "stage": "Esterification 1",
           "targetG": 105.8, "volumeMl": 131.9, "deliveredG": 2.4, "startWeightG": 460.0, "byTime": false,
           "elapsedSeconds": 2, "maxSeconds": 188, "faultReason": null, "startedAt": "2026-10-12T23:45:35.584"},
  "drain": {"valve": null, "phase": "idle", "batchId": null, "elapsedSeconds": 0, "totalSeconds": 0,
            "remainingSeconds": 0, "waitingFor": null, "waitedSeconds": 0, "faultReason": null, "startedAt": null},
  "purification": {"phase": "ready", "...": "...", "stirrerOn": false, "stirrerRpm": null, "stirringSpeed": 200},
  "purificationAutoStart": null
}
```

Any sensor value can be `null` when there's no valid reading. `oilMassG` is the reactor load cell: the oil, then everything poured or pumped in. `outputWeightG` is the load cell under the biodiesel container. `heaterSubmerged` is the level switch at the heater (`null` = no switch installed). `purificationAutoStart` is the batch ID waiting for purification to start by itself (set when the centrifuge outlet has closed). In `pump`, `startedAt` tells one run from the next (the website adds up a dose loaded in parts).

In `stage`, `current` is the current setting and `currentLimitSet` is true when the Pi set the power supply's limit itself. A stage stopped by over-current has `state: "fault"` and `faultReason` like `current 1.12 A went above the 1 A setting`, and the alarm reads "Electrodes stopped: ...".

`purification` while it heats (shortened):

```json
{"phase": "heating", "batchId": "B-2026-025", "automatic": true, "targetTemperature": 90, "maximumTemperature": 95,
 "liveTemperature": 67.3, "heatingTimeSeconds": 41, "heatingTimeoutSeconds": 900,
 "methanolTotalSeconds": 600, "methanolRemainingSeconds": 600, "magnesolG": 4.6, "magnesolAdded": false,
 "contactTotalSeconds": 900, "settlingTotalSeconds": 600, "maxDrainTemperature": 50,
 "drainElapsedSeconds": 0, "drainMaximumSeconds": 1200, "stableSeconds": 0, "outputWeightG": 0.0, "oilWeightG": 460.0,
 "stepRemainingSeconds": null, "stepTotalSeconds": null, "heaterOn": true, "valveOpen": false,
 "stirrerOn": true, "stirrerRpm": 198, "stirringSpeed": 200, "warning": null, "safetyStopReason": null}
```

`outputWeightG` counts only the biodiesel collected in this run. `stepRemainingSeconds` is the countdown of the current timed step (methanol removal, contact or settling). `warning` is "Low output – check the filter. ..." when less than 70% of `oilWeightG` came out. `safetyStopReason` is written to follow "Heater stopped:", e.g. `temperature reading lost`, `temperature exceeded 95 °C` or `the purification stirrer stopped turning`.

`GET /api/config` → `purification` (fixed values, except the four Settings times) and `powerSupply`:

```json
{"purification": {"holdTemperature": 90, "holdBand": 2, "maximumTemperature": 95, "heatingTimeoutMinutes": 15.0,
                  "methanolRemovalMinutes": 10.0, "contactMinutes": 15.0, "settlingMinutes": 10.0, "maxDrainTemperature": 50.0,
                  "stirringSpeedRpm": 200, "drainStableGrams": 2, "drainStableSeconds": 30, "drainMaximumMinutes": 20.0,
                  "lowOutputFraction": 0.7, "magnesolGramsPerMlOil": 0.0092, "thermalFuseRating": null, "automatic": true},
 "powerSupply": {"currentControl": false}}
```

Both reaction stages in `/api/config` have `voltage` 10–30 V, `time` 30–180 min (default 120) and `current` 0.5–2 A (default 1).

`GET /api/system/status` (shortened):

```json
{"mode": "demonstration", "ready": true, "readiness": 100,
 "tiles": [{"label": "Power Supply", "value": "Ready", "secondary": "Output off · 0–30 V DC", "state": "ready"},
           {"label": "Reactor Load Cell", "value": "Online", "secondary": "462.4 g in the reactor · demonstration mode", "state": "ready"},
           {"label": "Dosing Pumps", "value": "Pumping", "secondary": "Pump B (H₂SO₄ + methanol) running", "state": "ready"},
           {"label": "Outlet Valves", "value": "All closed", "secondary": "Reactor, centrifuge and purification outlets", "state": "ready"},
           {"label": "Output Load Cell", "value": "Online", "secondary": "0.0 g in the biodiesel container", "state": "ready"}],
 "devices": [{"label": "Reactor load cell", "status": "462.4 g"}, {"label": "Output load cell", "status": "0.0 g"},
             {"label": "Pump A (NaOH/KOH + methanol)", "status": "Ready"}, {"label": "Pump B (H₂SO₄ + methanol)", "status": "Pumping"},
             {"label": "Reactor outlet valve", "status": "Closed"}, {"label": "Centrifuge outlet valve", "status": "Closed"},
             {"label": "Dry wash stirrer", "status": "Ready"}, {"label": "Purification outlet valve", "status": "Closed"}]}
```

The tiles are Power Supply, Electrodes ("Graphite – graphite"), Reactor Stirrer, Centrifuge Motor, Purification Stirrer, Heater, Temperature Sensor, Reactor Load Cell, Oil Input, Dosing Pumps, Outlet Valves and Output Load Cell. A motor tile is `Ready` when its RPM sensor gives a reading (`Stopped · RPM sensor online` or `Running · 198 RPM`) and `Not ready` without one. The Heater tile is `Not ready` without a temperature reading or after a purification safety stop that hasn't been acknowledged.

`GET /api/analytics/ranges` (one row per FFA range: `0–2%`, `2–4%`, `4–5%`, `5% and above`; on the sample data):

```json
{"range": {"key": "4-5", "label": "4–5%", "min": 4.0, "max": 5.0}, "testedBatches": 1, "passedBatches": 1,
 "labPassRate": 100.0, "recommendedBatchId": "B-2026-020",
 "recommendedParameters": {"esterificationVoltage": 20.0, "esterificationTime": 120.0, "esterificationStirring": 500.0,
                           "transesterificationVoltage": 30.0, "transesterificationTime": 54.0,
                           "transesterificationStirring": 420.0, "methanolRatio": 7.0},
 "esterificationRun": true, "averageYield": 85.7, "minimumYield": 85.7, "maximumYield": 85.7, "status": "Testing"}
```

`GET /api/analytics/summary`: `{"totalBatches": 6, "completed": 5, "completionRate": 83.33, "tested": 3, "passed": 3, "labPassRate": 100.0, "averageYield": 87.54}`

`GET /api/analytics/cost`: `{"batches": [{"id": "B-2026-020", "costPerLiter": 140.23}, {"id": "B-2026-022", "costPerLiter": 112.68}, {"id": "B-2026-024", "costPerLiter": 114.11}], "averageCost": 122.34, "dieselPrice": 55, "targetCost": 27.5, "tone": "red"}`

## New settings

| Key | Default | Meaning |
|---|---|---|
| `esterificationDesignFfa` | 10 | % FFA the uniform first esterification dose is calculated for (above `ffaThreshold`, at most 30) |
| `stripMaxFfa` | 5 | % the strip's darkest color stands for |
| `pumpCatalystRate` · `pumpAcidRate` | 100 | mL/min of pump A and B: the time limit, and the dose time without a load cell |
| `pumpNoFlowSeconds` | 20 | a pump stops with a fault when the reactor weight doesn't rise for this long |
| `reactorDrainTime` | 1 | minutes the reactor outlet stays open after transesterification (0 = moved by hand) |
| `centrifugeDrainTime` | 3 | minutes the centrifuge outlet stays open after separation (0 = moved by hand) |
| `centrifugeSpinDownTime` | 30 | seconds to wait after separation before opening the centrifuge outlet, when there's no RPM reading |
| `methanolRemovalTime` | 10 | minutes at 90 ±2 °C (5–30) |
| `contactTime` | 15 | minutes of stirring with the Magnesol, heater off (1–60) |
| `settlingTime` | 10 | minutes with the stirrer off (0–60) |
| `maxDrainTemperature` | 50 | °C: the outlet opens only at or below this (the water filter's limit, 30–85) |
| `ffaRangeBoundaries` | `0,2,4,5` | FFA ranges for the analytics; the last one is "5% and above" |

## Changes in this version

- **FFA ≤ 1%** skips esterification (`ffaThreshold` 1, was 4). `GET /api/config` also returns `wholeNumberInputs: true` and `autoAdvance`.
- **Whole numbers only** for operator inputs: `ffa` / `ffaAfter` in `/api/calculate*`, `voltage`, `time`, `stirring` and `current` in `/api/process/stage/start` (current limits are now 1–2 A), and the Settings page keys in `PUT /api/settings`. A decimal is refused: 422 `"ffa: Use a whole number (no decimals)."` or 400 `"contactTime must be a whole number (no decimals)."`. `/api/strip/read` returns a whole percent.
- **Readable validation errors:** every 422 has `detail` as one sentence naming each field (`"targetG: Field required"`), plus `errors` with the raw list.
- **Adsorbent:** `adsorbent` (`"Magnesol"` or `"Bentonite"`) can be sent with `/api/calculate`, `/api/process/stage/start` (kept for the batch, used when purification starts by itself) and `/api/process/purification/start`. The purification state and record have `adsorbent` and `adsorbentG` (`magnesolG` holds the same amount, under its old name). `/api/calculate` returns `magnesolG`, `bentoniteG`, `adsorbent`, `adsorbentG`, `adsorbentDosePct`. Batches have `adsorbent`; `materials` has `magnesolKg` next to `bentoniteKg`. New settings: `magnesolDose` (1), `bentoniteDose` (2), `defaultAdsorbent` (Magnesol), `magnesolPrice` (250 ₱/kg, placeholder).
- **Auto-advance:** when the reactor outlet has closed after transesterification, the Pi starts the separation by itself (setting `autoAdvance`, default true). The timeline gets "Separation started"; a problem becomes the alarm "Separation did not start by itself: …".
- **Centrifuge outlet** default `centrifugeDrainTime` 2 min (was 3; a saved 3 becomes 2).
- **Saving a batch never fails on the purification record:** every `purification` field has a default, the Pi's measured record is merged with the website's, and `oilVolume` is filled in from `oilMassG` when it's missing.
