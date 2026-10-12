# Greenova API Reference

Base URL: `http://<pi-address>:8000` (or the same address as the website when the Pi serves it). Try every endpoint at `/docs`.

All JSON uses the website's names: the `DemoBatch` fields from `src/lib/greenovaData.ts`, the `greenova_settings` keys from the Settings page, and `PROCESS_CONFIG` from `NewBatch.tsx`. Errors return `{"detail": "message"}` with status 400 (bad input), 404 (not found), 409 (not allowed right now, e.g. a safety rule) or 500 (unexpected backend error, still JSON so the website shows the message). The website calls these through `src/lib/api.ts`.

## Endpoints

| Method | Path | Body | Website use |
|---|---|---|---|
| GET | `/api/health` | | Is the backend up; `mock: true` in demo mode |
| GET | `/api/config` | | Same structure as `PROCESS_CONFIG` |
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
| GET | `/api/batches` | | Batch History (newest first) |
| GET | `/api/batches/next-id` | | `{id}` from the batch naming format |
| GET | `/api/batches/{id}` | | Batch Details |
| POST | `/api/batches` | DemoBatch fields (`id` and `date` optional) | `saveCompletedBatch` |
| PATCH | `/api/batches/{id}` | any batch fields | Correct a record |
| POST | `/api/batches/{id}/lab-result` | `{labResult: "Passed" or "Failed", labReference?}` | `updateBatchLabResult` |
| POST | `/api/batches/{id}/esterification-stages` | `{stage, ffaBefore, ffaAfter?, doseFfa?, methanolMl, sulfuricAcidMl, acetoneMl}` | Record an esterification stage (the website sends them all with the batch) |
| GET | `/api/analytics/summary` | | Summary cards |
| GET | `/api/analytics/ranges` | | Best Parameters per FFA Range table |
| GET | `/api/analytics/recommended?ffa=5.2` | | `getRecommendedParametersForFfa` (or `null`) |
| GET | `/api/analytics/cost` | | Cost per Liter card and chart |
| GET | `/api/process/stage` | | Current stage state |
| POST | `/api/process/stage/start` | `{stage, batchId?, voltage?, time?, stirring?, oilMassG?}` | Start Esterification, Transesterification or Separation. `oilMassG` sets the batch's mesh bed flow time later |
| POST | `/api/process/stage/pause` · `resume` · `complete` · `emergency-stop` · `reset` | | Stage buttons ("Record completion" = `complete`) |
| GET | `/api/process/pump` | | Dosing pump state |
| POST | `/api/process/pump/start` | `{pump: "catalyst" or "acid", targetG, volumeMl, batchId?, stage?}` | "Load with pump A/B": adds one premixed dose and stops when the reactor load cell has gained `targetG`. `volumeMl` sets the time limit (and the dose time without a load cell). Refused during a stage or while the reactor drains |
| POST | `/api/process/pump/stop` · `skip` | | Stop the pump; "Skip (demo)" = the rest arrives at once (demo mode only) |
| GET | `/api/process/drain` | | Outlet valve state |
| POST | `/api/process/drain/start` | `{valve: "reactor_outlet" or "centrifuge_outlet", batchId?}` | "Open again": opens an outlet for its drain time. They open by themselves after transesterification and separation |
| POST | `/api/process/drain/stop` · `skip` | | "Close now"; "Skip (demo)" = everything arrives now (demo mode only) |
| GET | `/api/process/purification` | | Purification state |
| POST | `/api/process/purification/start` | `{heaterSubmerged?, targetTemperature?, batchId?, oilVolumeMl?}` | Start by hand. Normally not needed: purification starts by itself after separation when the level switch detects biodiesel. `heaterSubmerged: true` is the operator's confirmation, used only when there's no level switch |
| POST | `/api/process/purification/skip` · `abort` · `acknowledge` | | "Skip timer (demo)", Stop, and Acknowledge |
| POST | `/api/control/heater` · `electrode-power` | `{on}` | Manual hardware test (blocked while a stage runs) |
| POST | `/api/control/valve` | `{name: "reactor_outlet", "centrifuge_outlet" or "mesh_bed", open}` | Manual hardware test (`mesh_bed` = the purification outlet) |
| POST | `/api/control/motor` | `{name: "stirrer", "centrifuge" or "purification_stirrer", duty: 0–1}` | Manual hardware test |
| POST | `/api/control/pump` | `{name: "catalyst" or "acid", on}` | Manual hardware test: priming or cleaning a pump line |
| POST | `/api/control/all-off` | | Emergency stop for everything: stage, pumps, valves, purification |

Values: batch `status` is `Completed`, `Failed`, `In Progress` or `Cancelled`. `labResult` is `Pending`, `Passed`, `Failed` or `Not tested` (set automatically for Failed or Cancelled batches). Stage `state` is `ready`, `running`, `paused`, `complete` or `fault`. Purification `phase` is `ready`, `heating`, `hold`, `flow`, `drain`, `complete` or `fault`; it goes through them by itself (see README section 6). Pump `phase` is `idle`, `pumping`, `done`, `fault` or `stopped`. Drain `phase` is `idle`, `waiting` (for the centrifuge to stop), `draining`, `done`, `stopped` or `fault`. Range `status` is `No data`, `Testing` or `Proven`.

## How saving a batch works

The website saves the batch once, when the operator clicks "Confirm process finished" after purification (`POST /api/batches`, same fields as `saveCompletedBatch`). If the website started the stages and purification with the same `batchId`, the backend adds what the Pi measured for that batch:

- `temperature`: average transesterification temperature (replaces the website's 27 °C placeholder)
- `energy`: electrode energy from voltage × current (plus the heater, if `heaterPowerWatts` is set), when the website sends 0
- `purification`: the backend's record of the heating, hold, flow and drain, the planned flow time, and any warning
- `biodieselOutputMl` and `yield`: from the output load cell (`yield` = output mL ÷ oil mL × 100, as on the website)
- `materials` and `catalystToWeighG`: from the calculator formulas, when not sent
- `timeline`: every stage start, pause, resume, completion and stop, each pump load ("Pump B loaded 105.7 g for Esterification 1") and each outlet valve opening and closing, with times

The website also sends `ffa` and `ffaAboveStrip` (true = the strip showed its darkest color, so `ffa` is the strip's maximum and the batch counts in the "5% and above" range), `esterificationStages` (each stage's dose and its FFA re-check), `oilMassG` (recorded at oil loading) and the exact `catalystToWeighG`.

Saving the same ID twice returns the saved batch unchanged.

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
 "isEstimate": true, "warnings": []}
```

`ffaMassG` is the FFA the dose is for (`doseFfa`), not the measured FFA. `esterificationPremixG` is what pump B must add (methanol + H₂SO₄); `transesterificationPremixG` is what pump A must add (methanol + NaOH/KOH).

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
  "purification": {"phase": "ready", "...": "...", "stirrerOn": false, "stirrerRpm": null, "stirringSpeed": 0},
  "purificationAutoStart": null
}
```

Any sensor value can be `null` when there's no valid reading. `oilMassG` is the reactor load cell: the oil, then everything poured or pumped in. `outputWeightG` is the load cell under the biodiesel container. `heaterSubmerged` is the level switch at the heater (`null` = no switch installed). `purificationAutoStart` is the batch ID waiting for purification to start by itself (set when the centrifuge outlet has closed). In purification, `outputWeightG` counts only the biodiesel collected in this run, `plannedFlowSeconds` = `expectedBiodieselMl` ÷ `meshBedFlowRate`, `stirrerOn` / `stirrerRpm` are the dry wash stirrer, and `warning` flags a low output (check the mesh bed). `safetyStopReason` is written to follow "Heater stopped:", e.g. `temperature reading lost` or `temperature exceeded 75 °C`. In `pump`, `startedAt` tells one run from the next (the website adds up a dose loaded in parts).

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

The tiles are Power Supply, Electrodes, Stirrer, Temperature Sensor, Reactor Load Cell, Oil Input, Dosing Pumps, Outlet Valves and Output Load Cell.

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
| `reactorDrainTime` · `centrifugeDrainTime` | 3 | minutes each outlet stays open (0 = moved by hand) |
| `centrifugeSpinDownTime` | 30 | seconds to wait after separation before opening the centrifuge outlet, when there's no RPM reading |
| `purificationStirringSpeed` | 300 | RPM of the dry wash stirrer during heating and hold (0 = off) |
| `ffaRangeBoundaries` | `0,2,4,5` | FFA ranges for the analytics; the last one is "5% and above" |
