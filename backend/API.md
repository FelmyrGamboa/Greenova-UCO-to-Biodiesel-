# Greenova API

The FastAPI service listens on port `8000` and serves the built frontend from the same origin when `frontend/dist` is present. On the Raspberry Pi, devices on the same Wi-Fi can open `http://greenova.local:8000` or `http://<pi-address>:8000` without internet access.

## Core endpoints

- `GET /api/health` — backend health.
- `GET /api/live` (WebSocket) — live sensor, stage, alarm, and purification state.
- `GET /api/settings` / `PUT /api/settings` — read and save existing settings fields.
- `GET /api/batches`, `GET /api/batches/active`, `GET /api/batches/{batch_id}` — batch records and progress.
- `POST /api/batches/start` — create the one active batch.
- `PUT /api/batches/{batch_id}/progress` — persist the Process page state in `batch_progress.state_data`.
- `POST /api/batches/{batch_id}/cancel` — cancel an ongoing batch.
- Batch lab-result endpoints update the batch's single `batch_lab_results` row in place and append history to `batch_timeline`.
- Hardware endpoints cover dosing, reaction stages, valves, purification, sensors, and demo readings. Backend interlocks are authoritative for manual and automatic control.

## Process handoffs (no drain time)

- When **Transesterification** completes, the reactor outlet opens and **Separation starts at once**. The outlet stays open.
- When **Separation** completes and the centrifuge has stopped, the centrifuge outlet opens and **purification starts at once** (with a level switch fitted, the heater waits for the biodiesel to cover it). The outlet stays open.
- **Purification:** heating (heater off at 90 °C) → methanol removal at 90 °C (`methanolRemovalTime`) → add adsorbent (`POST /api/process/purification/magnesol-added`) → contact, stirred with the heater off (`contactTime`) → drain. There is no settling or cooling. The run completes only when the output load cell has been stable (±2 g) for 30 s, with no time limit. Then **every valve closes** (purification, reactor and centrifuge outlets). A purification stop, an emergency stop or a batch cancel closes them too.
- `GET /api/process/purification`: `stirrerRpm` is reported during `contact` only (null in the other phases); `stableSeconds` / `stableTargetSeconds` show the drain's progress.
- `GET /api/process/drain`: the transfer outlets. `openValves` lists the open ones; `phase` is `waiting` while the centrifuge outlet waits for the centrifuge to stop, then `open`. `POST /api/process/drain/start` opens one by hand and goes on to the next process (if it didn't open by itself); `POST /api/process/drain/stop` closes both; `POST /api/process/drain/skip` (demo) moves the liquid at once. The manual drain confirmation (`/drain/complete`, `manualDrainHold`) was removed.

## Persistence and schema

MySQL 8 is the only database (not MariaDB). The database is `greenova_db_ver2.sql`, imported once as it is; it also creates the backend's login, `greenova@localhost` with no password (see `../database.md`). Startup reads the `CREATE TABLE` statements of `greenova_db_ver2.sql` and checks that every table and column exists, but never creates or alters tables or rewrites the saved settings row. Do not add schema changes to API startup code. The unused settings columns (`settlingTime`, `maxDrainTemperature`, `reactorDrainTime`, `centrifugeDrainTime`) are kept and left as they are.

## Demo mode

`GREENOVA_MOCK=1` enables the simulated machine. `GREENOVA_TIME_SCALE=20` speeds up demo timing for walkthroughs. The browser's local demo fallback remains available when the backend is offline.

## Safety

The backend owns process interlocks and watchdog behavior. ESP32 firmware only executes serial commands and switches outputs off on boot or after a two-second communication timeout. Verify hardware pins and fail-safe behavior before attaching heaters, electrodes, pumps, valves, or the centrifuge.
