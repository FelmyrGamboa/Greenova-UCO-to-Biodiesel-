# Greenova API

The FastAPI service runs on the Raspberry Pi that drives the machine, listens on port `8000` and serves the built frontend from the same origin when `frontend/dist` is present. Devices on the same Wi-Fi open `http://greenova.local:8000` or `http://<pi-address>:8000` without internet access. There is no demo or simulated mode and no demo endpoint.

## Core endpoints

- `GET /api/health` — backend health (`{"status": "ok"}`).
- `GET /api/live` and the WebSocket `/api/ws/live` (every second) — `sensors`, `alarm`, `stage`, `purification`, `pump`, `purificationAutoStart` (the batch whose purification starts by itself) and `purificationWaiting` (why it hasn't started yet: no temperature or output load cell reading, or an earlier safety stop to acknowledge; `null` otherwise).
- `GET /api/config` — the process configuration (same structure as `PROCESS_CONFIG` in `NewBatch.tsx`), including:
  - `separation`: `timeMinutes` / `speedRpm` (the defaults: Settings `separationTime`, `separationSpeed` capped at the centrifuge's maximum), `timeMin` 1, `timeMax` 180, `speedMin` 100, `speedMax` (the centrifuge's `max_rpm`, 2500), `settleSeconds` 60.
  - `purification`: `holdTemperature` 90, `holdBand` 3 (heater back on at 87 °C), `settleSeconds` 60, `methanolRemovalMinutes`, `contactMinutes`, `drainStableGrams` 2, `drainStableSeconds` 30, ...
  - `pumps`: `oilPump` (the machine has an oil pump), `stopStyle` `"manual"` (pumps run until Done), `maxRunMinutes` 30.
- `GET /api/settings` / `PUT /api/settings` — read and save existing settings fields (`separationTime` 1–180 min and `separationSpeed` are the Volume & Parameters defaults).
- `GET /api/batches`, `GET /api/batches/active`, `GET /api/batches/{batch_id}` — batch records and progress.
- `POST /api/batches/start` — create the one active batch.
- `PUT /api/batches/{batch_id}/progress` — persist the Process page state in `batch_progress.state_data`.
- `POST /api/batches/{batch_id}/cancel` — cancel an ongoing batch (every output is switched off).
- Batch lab-result endpoints update the batch's single `batch_lab_results` row in place and append history to `batch_timeline`.
- `GET /api/hardware` — Settings → Hardware: `backend` (`esp32` or `gpio`), `fault`, `controller` (ESP32: `online`, `port`, `temperature`, `leaseSeconds`, its `devices` and recent `messages`), `roles` (each Greenova job and the ESP32 device(s) doing it), `centrifuge` (Pi BTS7960: `rpm`, `targetRpm`, `duty`, `maxRpm`) and `loadCells`.
- `POST /api/hardware/load-cells/{key}/tare` and `POST /api/hardware/load-cells/{key}/calibrate` (`{"grams": 500}`) — Tare / Calibrate a load cell, about 3 s each; refused (409) while a process runs.

## The oil pump and the dispensers (stopped by the operator)

- `POST /api/process/pump/start` — `pump`: `oil` (the oil pump), `catalyst` (pump A = `dispenser1`: NaOH/KOH + methanol) or `acid` (pump B = `dispenser2`: H₂SO₄ + methanol), with `targetG` / `volumeMl` (the amount the operator measured into its container, for the record), `batchId` and `stage`. The pump runs until:
  - `POST /api/process/pump/finish` — **Done**: the container is empty; `phase` `done`, `deliveredG` = `targetG`;
  - `POST /api/process/pump/stop` — Stop: `phase` `stopped` (start it again for the rest);
  - 30 minutes without Done: `phase` `fault`, with an alarm.
- `GET /api/process/pump` — `pump`, `phase`, `targetG`, `volumeMl`, `deliveredG`, `elapsedSeconds`, `maxSeconds`, `faultReason`, `startedAt`.
- The website switches the oil pump on when the Oil Loading step opens, and pump A or B when its reaction stage opens.

## Stages and the hand-offs

- `POST /api/process/stage/start` — `stage`, `batchId`, the reaction settings (`voltage`, `time`, `stirring`, `current`), `oilMassG`, `adsorbent`, and the batch's separation: `separationTime` (min) and `separationSpeed` (RPM). Send them with the **Transesterification** start: the Pi uses them for the separation it starts by itself. A **Separation** start uses them directly (no settle).
- `POST /api/process/stage/{pause|resume|complete|emergency-stop|reset}`.
- When **Transesterification** completes, **Separation starts by itself**: `phase` `settling` for 60 s (`settleRemainingSeconds`, everything off), then `separating`: the reactor pump (`reactor_outlet`), the centrifuge (at `speedRpm`) and pumpin (`centrifuge_outlet`) run together for `timeMinutes`. All three stop at the end.
- When **Separation** completes, **purification starts by itself** (`purificationAutoStart`; with a level switch fitted, it waits for the biodiesel to cover the heater). Without a temperature or output load cell reading, or with an earlier purification safety stop not acknowledged, it waits with nothing on (`purificationWaiting`) and starts once that is fixed.
- **Purification:** methanol removal straight away (`methanolRemovalTime`; stirrer on, heater in 4 s pulses, the next one when the temperature is 0.2 °C below its highest point since the last pulse, none at or above 90 °C; `heaterPulses` counts them) → add adsorbent (`POST /api/process/purification/magnesol-added`) → contact at 200 RPM, heater off (`contactTime`) → `settle` (60 s, stirrer off) → `drain` (valve + pumpout) until the output load cell has been stable (±2 g) for 30 s → `complete`, and every output is switched off. `GET /api/process/purification`: `stirrerRpm` during `contact` only; `settleTotalSeconds` / `settleRemainingSeconds`; `stableSeconds` / `stableTargetSeconds` during the drain. `POST /api/process/purification/{start|abort|acknowledge}`.

## Persistence and schema

MySQL 8 is the only database (not MariaDB). The database is `greenova_db_ver2.sql`, imported once as it is; it also creates the backend's login, `greenova@localhost` with no password (see `../database.md`). Startup reads the `CREATE TABLE` statements of `greenova_db_ver2.sql` and checks that every table and column exists, but never creates or alters tables or rewrites the saved settings row. The purification settle is recorded in `batch_purification.settlingTimeSeconds`. Settings columns that are no longer used (`settlingTime`, `maxDrainTemperature`, `reactorDrainTime`, `centrifugeDrainTime`, `centrifugeSpinDownTime`, `pumpCatalystRate`, `pumpAcidRate`, `pumpNoFlowSeconds`) are kept and left as they are.

## Hardware

With `hardware.toml` `[actuators] backend = "esp32"` (the default) the ESP32 (`firmware/esp32_process_control`) switches the relays, the heater and the two mixers over USB serial, and the Pi drives the centrifuge (BTS7960) and reads the HX711 load cell. `[esp32.devices]` says which ESP32 output does which job. `/api/live` sensors also carry `controllerOnline`, `controllerError`, `controllerPort`, `rpmEstimated` (true: no RPM sensors, the RPM is the set speed) and `loadCellsFitted`.

## Safety

The backend owns every process interlock. The ESP32 only carries out commands: each output is switched on with the sketch's 5 s timer and refreshed every second, so it switches itself off when the Pi stops talking to it. No ESP32 status for 3.5 s, an output that doesn't follow its command, or a device missing from the sketch is a controller fault: the backend stops every process, switches everything off and raises an alarm (`/api/live` `alarm`). Verify the job mapping and fail-safe behavior before attaching heaters, electrodes, pumps, valves, or the centrifuge.
