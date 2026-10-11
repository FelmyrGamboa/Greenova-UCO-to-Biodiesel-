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
| GET | `/api/live` | | Sensors, alarm, stage and purification state |
| WS | `/api/ws/live` | | Same as `/api/live`, every second |
| POST | `/api/alarm/clear` | | Clear the alarm banner |
| POST | `/api/demo/load-oil` | `{volumeMl}` | "Load demonstration sensor reading" (demo mode only) |
| POST | `/api/calculate` | `{oilMassG, ffa, methanolRatio?, catalyst}` | Chemical Quantity Calculator (same keys as `calculateQuantityCards`) |
| POST | `/api/calculate/after-esterification` | `{oilMassG, ffaAfter, stageDone, methanolRatio?, catalyst}` | Another stage, or exact transesterification amounts |
| POST | `/api/strip/read` | | FFA strip reader: `{ffa, warnings}` |
| GET | `/api/batches` | | Batch History (newest first) |
| GET | `/api/batches/next-id` | | `{id}` from the batch naming format |
| GET | `/api/batches/{id}` | | Batch Details |
| POST | `/api/batches` | DemoBatch fields (`id` and `date` optional) | `saveCompletedBatch` |
| PATCH | `/api/batches/{id}` | any batch fields | Correct a record |
| POST | `/api/batches/{id}/lab-result` | `{labResult: "Passed" or "Failed", labReference?}` | `updateBatchLabResult` |
| POST | `/api/batches/{id}/esterification-stages` | `{stage, ffaBefore, ffaAfter?, methanolMl, sulfuricAcidMl, acetoneMl}` | Record an esterification stage |
| GET | `/api/analytics/summary` | | Summary cards |
| GET | `/api/analytics/ranges` | | Best Parameters per FFA Range table |
| GET | `/api/analytics/recommended?ffa=5.2` | | `getRecommendedParametersForFfa` (or `null`) |
| GET | `/api/analytics/cost` | | Cost per Liter card and chart |
| GET | `/api/process/stage` | | Current stage state |
| POST | `/api/process/stage/start` | `{stage, batchId?, voltage?, time?, stirring?, oilMassG?}` | Start Esterification, Transesterification or Separation. `oilMassG` sets the batch's mesh bed flow time later |
| POST | `/api/process/stage/pause` · `resume` · `complete` · `emergency-stop` · `reset` | | Stage buttons ("Record completion" = `complete`) |
| GET | `/api/process/purification` | | Purification state |
| POST | `/api/process/purification/start` | `{heaterSubmerged?, targetTemperature?, batchId?, oilVolumeMl?}` | Start by hand. Normally not needed: purification starts by itself after separation when the level switch detects biodiesel. `heaterSubmerged: true` is the operator's confirmation, used only when there's no level switch |
| POST | `/api/process/purification/skip` · `abort` · `acknowledge` | | "Skip timer (demo)", Stop, and Acknowledge |
| POST | `/api/control/heater` · `electrode-power` | `{on}` | Manual hardware test (blocked while a stage runs) |
| POST | `/api/control/valve` | `{name: "mesh_bed", open}` | Manual hardware test |
| POST | `/api/control/motor` | `{name: "stirrer" or "centrifuge", duty: 0–1}` | Manual hardware test |
| POST | `/api/control/all-off` | | Emergency stop for everything |

Values: batch `status` is `Completed`, `Failed`, `In Progress` or `Cancelled`. `labResult` is `Pending`, `Passed`, `Failed` or `Not tested` (set automatically for Failed or Cancelled batches). Stage `state` is `ready`, `running`, `paused`, `complete` or `fault`. Purification `phase` is `ready`, `heating`, `hold`, `flow`, `drain`, `complete` or `fault`; it goes through them by itself (see README section 5). Range `status` is `No data`, `Testing` or `Proven`.

## How saving a batch works

The website saves the batch once, when the operator clicks "Confirm process finished" after purification (`POST /api/batches`, same fields as `saveCompletedBatch`). If the website started the stages and purification with the same `batchId`, the backend adds what the Pi measured for that batch:

- `temperature`: average transesterification temperature (replaces the website's 27 °C placeholder)
- `energy`: electrode energy from voltage × current (plus the heater, if `heaterPowerWatts` is set), when the website sends 0
- `purification`: the backend's record of the heating, hold, flow and drain, the planned flow time, and any warning
- `biodieselOutputMl` and `yield`: from the output load cell (`yield` = output mL ÷ oil mL × 100, as on the website)
- `materials` and `catalystToWeighG`: from the calculator formulas, when not sent
- `timeline`: every stage start, pause, resume, completion and stop, with times

Saving the same ID twice returns the saved batch unchanged.

## Example responses

`POST /api/calculate` with `{"oilMassG": 460, "ffa": 6, "catalyst": "NaOH"}`:

```json
{"oilMassG": 460, "oilVolumeMl": 500.0, "ffa": 6, "methanolRatio": 7, "catalyst": "NaOH",
 "ffaMassG": 27.6, "esterificationNeeded": true, "esterificationMethanolMl": 78.384,
 "sulfuricAcidMl": 0.7452, "sulfuricAcidG": 1.38, "acetoneMl": 50.0,
 "transesterificationMethanolMl": 148.0102, "catalystBaseG": 4.6, "neutralizationG": 0.6532,
 "catalystToWeighG": 5.3604, "purity": 98, "isEstimate": true, "warnings": []}
```

`POST /api/calculate/after-esterification` with FFA still above 1%: `{"action": "anotherStage", "stage": 2, "ffaMassG": 11.04, "esterificationMethanolMl": 62.7136, "sulfuricAcidMl": 0.2981, "sulfuricAcidG": 0.552, "acetoneMl": 100.0}`. At or below 1%: `{"action": "transesterification", "ffa": 0.5, "isEstimate": false, "transesterificationMethanolMl": 296.0193, "catalystBaseG": 9.2, "neutralizationG": 0.9154, "catalystToWeighG": 11.2393, "purity": 90, "acetoneMl": 100.0}`.

`/api/ws/live` message (also `GET /api/live`):

```json
{
  "mock": true, "timestamp": "2026-10-11T16:20:05", "alarm": null,
  "sensors": {"oilMassG": 460.0, "outputWeightG": 0.0, "temperature": 38.7, "voltage": 20.0, "current": 1.81,
              "stirrerRpm": 500, "centrifugeRpm": 0, "heaterSubmerged": true, "heaterOn": false, "electrodePowerOn": true,
              "meshBedValveOpen": false, "valves": {"mesh_bed": false},
              "motorDuty": {"stirrer": 0.556, "centrifuge": 0.0}, "timestamp": 1791700000.0},
  "stage": {"stage": "Esterification", "state": "running", "batchId": "B-2026-001", "voltage": 20, "timeMinutes": 30,
            "stirringRpm": 500, "speedRpm": null, "elapsedSeconds": 412, "remainingSeconds": 1388,
            "liveVoltage": 20.0, "liveCurrent": 1.81, "liveTemperature": 38.7, "liveRpm": 500,
            "averageTemperature": 35.2, "energyKwh": 0.0041, "faultReason": null},
  "purification": {"phase": "ready", "batchId": null, "automatic": false, "targetTemperature": null,
                   "liveTemperature": null, "startingTemperature": null, "highestTemperature": null,
                   "heatingTimeSeconds": 0, "holdTimeSeconds": 0, "holdTotalSeconds": 0, "holdRemainingSeconds": 0,
                   "expectedBiodieselMl": null, "plannedFlowSeconds": 0, "flowElapsedSeconds": 0,
                   "flowRemainingSeconds": 0, "drainElapsedSeconds": 0, "drainMaximumSeconds": 0,
                   "flowStableSeconds": 0, "outputWeightG": null, "flowRateGPerMinute": null,
                   "heaterOn": false, "valveOpen": false, "heaterOnSeconds": 0, "warning": null,
                   "safetyStopReason": null, "safetyStopOccurred": false, "record": null},
  "purificationAutoStart": null
}
```

Any sensor value can be `null` when there's no valid reading. `heaterSubmerged` is the level switch at the heater (`null` = no switch installed). `purificationAutoStart` is the batch ID waiting for purification to start by itself after separation. In purification, `outputWeightG` counts only the biodiesel collected in this run, `plannedFlowSeconds` = `expectedBiodieselMl` ÷ `meshBedFlowRate`, and `warning` flags a low output (check the mesh bed). `safetyStopReason` is written to follow "Heater stopped:", e.g. `temperature reading lost` or `temperature exceeded 75 °C`.

`GET /api/system/status`:

```json
{"mode": "demonstration", "ready": true, "readiness": 100,
 "tiles": [{"label": "Power Supply", "value": "Ready", "secondary": "Output off · 0–30 V DC", "state": "ready"},
           {"label": "Electrodes", "value": "Copper tube – stainless steel", "secondary": "Connected", "state": "ready"},
           {"label": "Stirrer", "value": "Ready", "secondary": "0 RPM", "state": "ready"},
           {"label": "Temperature Sensor", "value": "Online", "secondary": "27.0 °C · demonstration reading", "state": "ready"},
           {"label": "Load Cell", "value": "Online", "secondary": "460.0 g · demonstration mode", "state": "ready"},
           {"label": "Oil Input", "value": "460.0 g", "secondary": "Input channel ready · demonstration mode", "state": "ready"}],
 "devices": [{"label": "Raspberry Pi", "status": "Connected"}, {"label": "Temperature Sensor", "status": "Connected"},
             {"label": "Power relay", "status": "Ready"}, {"label": "Stirrer relay", "status": "Ready"},
             {"label": "Centrifuge controller", "status": "Ready"}, {"label": "Immersion heater", "status": "Ready"},
             {"label": "Mesh bed valve", "status": "Closed"}]}
```

`GET /api/analytics/ranges` (one row per FFA range; on the sample data):

```json
{"range": {"key": "2-4", "label": "2–4%", "min": 2.0, "max": 4.0}, "testedBatches": 2, "passedBatches": 2,
 "labPassRate": 100.0, "recommendedBatchId": "B-2026-022",
 "recommendedParameters": {"transesterificationVoltage": 30.0, "transesterificationTime": 65.0,
                           "transesterificationStirring": 470.0, "methanolRatio": 7.0},
 "esterificationRun": false, "averageYield": 88.75, "minimumYield": 88.4, "maximumYield": 89.1, "status": "Testing"}
```

`GET /api/analytics/summary`: `{"totalBatches": 6, "completed": 5, "completionRate": 83.33, "tested": 3, "passed": 3, "labPassRate": 100.0, "averageYield": 87.54}`

`GET /api/analytics/cost`: `{"batches": [{"id": "B-2026-020", "costPerLiter": 128.52}, {"id": "B-2026-022", "costPerLiter": 112.68}, {"id": "B-2026-024", "costPerLiter": 114.11}], "averageCost": 118.44, "dieselPrice": 55, "targetCost": 27.5, "tone": "red"}`
