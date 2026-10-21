# Greenova update notes

## 2026-10-21 (3): Docker setup for the real machine

- New `dockerfiles/backend.Dockerfile`: Python 3.11 with FastAPI, PyMySQL, **pyserial** and **lgpio** (the build stops if one is missing). The old demo image had no pyserial, so the ESP32 stayed offline and no mixer, pump, electrode relay or heater could switch on, and separation (with the centrifuge) never started.
- New `dockerfiles/docker-compose.yaml`: the backend gets `/dev` (`privileged: true`) and finds the ESP32's port and the Pi's GPIO chip by itself; no demo settings (`GREENOVA_MOCK`, seed); settings and calibration in `backend/data`.
- New `dockerfiles/start-machine.sh`: stops the old Pi control panel and a native greenova service, checks the ESP32 port and GPIO chips, builds and starts, then prints OK / FIX for the ESP32, temperature, centrifuge and output load cell (`--check`, `--test-outputs`).
- Backend: a **Hardware check:** log line per part a few seconds after the start; Greenova's info lines now reach the log under uvicorn; `hwtest outputs` names the reactor pump, pumpin and valve + pumpout. `backend/.dockerignore`, `data/` in `.gitignore`.

**Files**: `dockerfiles/backend.Dockerfile`, `docker-compose.yaml`, `start-machine.sh` (new); `backend/.dockerignore` (new), `.gitignore`, `app/main.py`, `app/hwtest.py`; `docs/RASPBERRY_PI_SETUP.md`, `docs/CHANGED_FILES.md`.

## 2026-10-21 (2): purification waits instead of stalling; clearer hardware errors

- **Purification never gives up or stalls silently after separation.** It needs a temperature reading, an output load cell reading, and no earlier purification safety stop left unacknowledged. Before, a missing reading cancelled the automatic start (only an alarm), and an earlier run's safety stop (also an operator **Stop**) blocked it with no message and no button for the new batch. Now it waits with nothing switched on, shows **Purification is waiting** and the reason on the Purification step (`purificationWaiting` in `/api/live`, plus one alarm per reason) with an **Acknowledge** button for an earlier stop, and starts by itself once it is fixed; the alarm clears when it starts.
- A purification Stop at the very moment it starts now also ends in a clean safety stop (it used to stay "heating").
- Hardware errors name their cause: a GPIO pin claimed by another program ("GPIO 23 (centrifuge L_EN) is busy… stop the old Pi control panel"), a forced `gpiochip` / `GPIO_CHIP` that isn't the Pi's header chip, a `/dev/gpiochipN` missing in Docker.
- Docker: Tare/Calibrate work with `loadcell_calibration.json` mounted as a file (written in place) or created by Docker as a folder (kept inside it); a `hardware.toml` folder is reported and the default pins are used.
- Docs: `RASPBERRY_PI_SETUP.md` has "Only one program may use the ESP32 and the pins", "Running the backend in Docker" and "When separation doesn't go on to purification"; the load cell factor note explains the 145759 "g" label.

**Files**: `backend/app/api.py`, `main.py`, `purification.py`, `drivers.py`, `config.py`; `backend/tests/simulator.py`, `test_api.py`, `test_esp32.py`; `frontend/src/pages/NewBatch.tsx`, `lib/api.ts`, `lib/fil.ts`; `docs/RASPBERRY_PI_SETUP.md`, `docs/CHANGED_FILES.md`.

## 2026-10-21: no demo mode; pumps until Done; settle + separation with three outputs; purification 87–90 °C and a settle

**No demo mode.** The website always drives the real machine through the Raspberry Pi (ESP32 controller + the Pi's centrifuge and load cell).
- Backend: `GREENOVA_MOCK`, `GREENOVA_TIME_SCALE`, the simulated machine (`MockHardware`), `/api/demo/*`, the "Skip" endpoints (`/process/pump/skip`, `/process/purification/skip`) and `mock` in `/api/live`, `/api/health`, `/api/hardware` were removed. `setup-pi.sh` always installs for the machine (`--demo` removed, `--hardware` kept as a no-op); `greenova.service` and `.env.example` lost `GREENOVA_MOCK`. `start-backend.bat` (backend on a Windows laptop) was removed: the backend needs the Pi's hardware. `app/seed.py` (sample batches) moved to `tests/sample_batches.py`; the tests' own simulated machine is `tests/simulator.py`.
- Website: no local simulation, no sample batches, no browser-stored batches or "keep in this browser". When the Pi can't be reached, the Process page shows "The Raspberry Pi can't be reached" (a running batch carries on on the Pi; the page catches up when it is back), the sidebar shows **Pi offline**, and Dashboard / Batch History / Batch Details / Settings say so instead of showing demo values. `Monitor.tsx`, `SimBadge.tsx` and `Guide.tsx` (unused, demo-only) were removed.

**Oil pump and dispensers: stopped by the operator.** The operator measures the computed amount into each container. The oil pump switches on by itself when Oil Loading opens, pump A/B (dispenser1/dispenser2) when their reaction stage opens; each runs until **Done** (`POST /api/process/pump/finish`). **Stop pump** stops it (start it again for the rest). A pump left on for 30 min stops with a fault. No more stopping by weight or time (`[oil_pump] rate_ml_per_min` and the pump rate / no-flow settings are no longer used). Acetone is a confirmation: **Acetone added** or **Continue without acetone**; then the reaction starts by itself.

**Separation.** Volume & Parameters has a new **5. Separation (centrifuge)** card: the batch's separation time (1–180 min) and centrifuge speed (100–2500 RPM), starting from Settings → Default separation time / Default centrifuge speed (the database's 2600 RPM is capped at the centrifuge's 2500). They are sent with the Transesterification start (`separationTime`, `separationSpeed`). When transesterification finishes, the mixture **settles 1 minute** in the reactor (everything off), then the **reactor pump, the centrifuge and pumpin run together** for the separation time, so the biodiesel goes straight on to the purifier; all three stop at the end and purification starts by itself. The old transfer-outlet logic (`DrainRunner`, `/api/process/drain/*`, the spin-down wait) was removed. RPM stays open loop: the centrifuge RPM shown is its set speed.

**Purification.** Heating to 90 °C (heater off), methanol removal kept at **87–90 °C** (heater back on at 87 °C; `holdBand` 3), add Magnesol (operator confirms), contact at 200 RPM with the heater off, a **1-minute settle** (stirrer off, new phase `settle`, recorded in `settlingTimeSeconds`), then the valve + pumpout until the output load cell is stable for 30 s. Then every output is switched off.

**Tests and checks.** `tests/test_core.py`, `test_api.py`, `test_esp32.py`, `test_pi_hardware.py` rewritten for the new flow on `tests/simulator.py`. The simulated machine moves on one simulated second per sensor reading (not by the computer's clock), so the tests give the same result on Windows, whose timers are only accurate to about 16 ms. Two outdated expectations were corrected (the 1500 mL minimum oil volume, and the sample batch's cost per liter, which uses the same formula as the website).

**Files**: `backend/app/api.py`, `config.py`, `hardware.py`, `main.py`, `models.py`, `purification.py`, `stages.py`, `system.py`, `transfers.py`, `hwtest.py`, `drivers.py`, `seed.py` (→ `tests/sample_batches.py`); `backend/tests/simulator.py` (new), `test_core.py`, `test_api.py`, `test_esp32.py`, `test_pi_hardware.py`, `test_mysql.py`; `backend/hardware.example.toml`, `setup-pi.sh`, `greenova.service`, `.env.example`, `start-backend.bat` (removed), `README.md`, `API.md`; `frontend/src/pages/NewBatch.tsx`, `Dashboard.tsx`, `Settings.tsx`, `BatchDetails.tsx`, `BatchHistory.tsx`, `Monitor.tsx` / `Guide.tsx` (removed); `frontend/src/components/Sidebar.tsx`, `HardwarePanel.tsx`, `SimBadge.tsx` (removed); `frontend/src/contexts/LiveContext.tsx`; `frontend/src/lib/api.ts`, `greenovaData.ts`, `fil.ts`; `frontend/vite.config.ts`, `start-website.bat`, `README.md`; `firmware/esp32_process_control/README.md`; `database.md`; `docs/*.md`.

## 2026-10-20 (3): the operator's ESP32 job list, automated oil input, no colour sensor

- `[esp32.devices]` defaults now follow the machine: `oil` = oil pump into the reactor, `reactorpump` = reactor → centrifuge, `pumpin` = centrifuge → purifier, `valve` + `pumpout` = purification outlet (after contact the valve opens and pumpout pumps to the output container). Every ESP32 output now has a job.
- Automated oil input: new oil pump (`oil` pump, job `oil_pump`). The Oil Loading step has **Start oil pump** / Stop / Continue loading; it stops on the reactor load cell's weight, or without one after the volume at `[oil_pump] rate_ml_per_min` (new, default 500). Before the oil is in, the quantities use the target volume. Same interlocks as pumps A/B: one pump into the reactor at a time, never with the reactor outlet open. Without an oil pump (`oil_pump = ""`), the old manual pour stays. The demo machine has an oil pump too.
- `python -m app.hwtest pump <oil|catalyst|acid> <seconds>`: runs a pump into a jug to measure its mL/min.
- Removed the FFA colour-sensor strip reader (TCS34725): `backend/app/strip_reader.py`, `POST /api/strip/read`, `[strip_reader]` in `hardware.toml`, `adafruit-circuitpython-tcs34725`, and `readFfaStrip` in the website's API client. The FFA test strip is still read by eye and entered on the website.

**Files**: `backend/app/hardware.py`, `esp32.py`, `config.py`, `api.py`, `models.py`, `transfers.py`, `system.py`, `hwtest.py`; `app/strip_reader.py` (removed); `backend/hardware.example.toml`, `requirements-pi.txt`, `setup-pi.sh`, `README.md`, `API.md`, `tests/test_esp32.py`, `test_api.py`, `test_pi_hardware.py`; `frontend/src/pages/NewBatch.tsx`, `lib/api.ts`, `lib/fil.ts`; `firmware/esp32_process_control/README.md`; `docs/RASPBERRY_PI_SETUP.md`, `SUPPLIED_WIRING_MAPPING.md`, `WEBSITE_GUIDE.md`.

## 2026-10-20 (2): real hardware: the ESP32 controller and the Pi's centrifuge and load cell

The backend now drives the real machine in hardware mode (`GREENOVA_MOCK=0`, `[actuators] backend = "esp32"`), using the supplied Pi control panel's wiring and ESP32 sketch. The Flask control panel is replaced by the Greenova website.

**Hardware**
- New `backend/app/esp32.py`: the USB serial link to the ESP32 (the sketch's own text commands, `STATUS` lines, auto-detected port, reconnects by itself) and `Esp32Hardware`: relays, heater and mixers through the ESP32, centrifuge (BTS7960, soft ramp, 0–2500 RPM) and HX711 load cell on the Pi's pins with lgpio, temperature from the ESP32's DS18B20. All interlocks still come from `Hardware`.
- Dead-man timer without changing the sketch: outputs are switched on with its timed ON (`heater on 5`) and refreshed every second, so the ESP32 switches them off by itself within 5 s if the Pi stops.
- Controller faults (no status for 3.5 s, an output that doesn't follow, a device the sketch doesn't have) stop every process and switch everything off (`main.py`), with an alarm. Outputs Greenova wants off are switched back off if something else turns them on.
- `[esp32.devices]` in `hardware.toml` maps each job to an ESP32 device (defaults: heater, electrode, dispenser1 = pump A, dispenser2 = pump B, reactorpump = reactor outlet, pumpout = centrifuge outlet, valve = purification outlet, mixer1 = reactor stirrer, mixer2 = dry wash stirrer). `[esp32.max_on_seconds]` limits an outlet that is really a pump.
- Load cells: Tare and Calibrate from the website (Settings → Hardware) or `hwtest calibrate`, saved in `backend/loadcell_calibration.json`. Default output cell: DT 17 / SCK 27 with the control panel's calibration (factor 145759 per kg = 145.759 counts per gram). The reactor load cell is optional.
- Speeds use each board's own full-speed RPM (sketch `MAX_RPM` 1544, `[centrifuge] max_rpm` 2500). RPM is open loop, so the centrifuge outlet always waits the spin-down time.
- Pins: the FFA strip reader's LED moved from GPIO17 (now HX711 DT) to GPIO22 (`[strip_reader] led_pin`). Pin checks follow the backend in use.
- `hwtest`: new `esp32` command; `check`, `outputs` and `calibrate` work in ESP32 mode.
- `setup-pi.sh --hardware` / `--demo`; hardware mode also stops the old `pi-control` service. Installs `python3-serial`.
- `firmware/esp32_process_control/esp32_process_control.ino`: the supplied sketch, unchanged (with a README). The old placeholder `firmware/esp32_actuators/` (JSON protocol, unassigned pins) was removed.

**Website**
- Settings: new **Hardware** card (ESP32 link, job → ESP32 output table with what the ESP32 reports, centrifuge, load cells with Tare / Calibrate).
- Before You Start: **Output Controller** tile; motor tiles show the speed they were set to; a reactor load cell that isn't fitted is shown as "Not fitted" (ready).
- Without a reactor load cell, the oil is confirmed by volume on Oil Loading ("I poured … mL").
- New endpoints: `GET /api/hardware`, `POST /api/hardware/load-cells/{key}/tare`, `.../calibrate`.

**Files**: `backend/app/esp32.py` (new), `drivers.py`, `hardware.py`, `config.py`, `api.py`, `main.py`, `models.py`, `system.py`, `stages.py`, `purification.py`, `transfers.py`, `hwtest.py`, `strip_reader.py`; `backend/hardware.example.toml`, `setup-pi.sh`, `greenova.service`, `requirements-pi.txt`, `.gitignore`, `README.md`, `API.md`, `tests/test_esp32.py` (new), `tests/test_pi_hardware.py`; `firmware/esp32_process_control/`; `frontend/src/components/HardwarePanel.tsx` (new), `pages/Settings.tsx`, `pages/NewBatch.tsx`, `lib/api.ts`, `lib/fil.ts`; `docs/RASPBERRY_PI_SETUP.md`, `PI_DEPLOYMENT.md`, `SUPPLIED_WIRING_MAPPING.md`, `WEBSITE_GUIDE.md`.

## 2026-10-20: valves stay open between processes, purification without settling/cooling, MySQL 8 database

**Process**
- No drain time for any transfer. When transesterification finishes, the reactor outlet opens and separation starts at once. When separation finishes (and the centrifuge has stopped), the centrifuge outlet opens and purification starts at once. The outlets stay open; when purification has finished every valve closes (purification, reactor and centrifuge outlets). A purification stop, an emergency stop or a batch cancel also closes them. The manual drain confirmation option was removed.
- Purification: heating until 90 °C, where the heater switches off; methanol removal at 90 °C for `methanolRemovalTime` (heater back on at 89 °C, off at 90 °C); prompt to add Magnesol/bentonite; contact for `contactTime`, stirred with the heater off (cools down); then the outlet opens right away. Settling and cooling were removed. The run is complete only when the output load cell has been stable (±2 g) for 30 s, with no time limit (the old 30-minute drain maximum is gone). Purification refuses to start without an output load cell reading.
- The stirrer's RPM reading is shown only during contact (not during heating or methanol removal). The stirrer still runs during heating, because the heater interlock requires it.
- Settings page: the Settling time and Max drain temperature fields were removed. Their database columns, like `reactorDrainTime` / `centrifugeDrainTime`, are kept and left as they are.

**Database**
- MySQL 8 only (not MariaDB). `backend/greenova_db_ver2.sql` is the supplied file, byte for byte. The backend reads its `CREATE TABLE` statements to check the database at startup (read only).
- The default login is the user the SQL file creates: `greenova@localhost`, no password, database `greenova_db`. No `.env` is needed on the MySQL computer.
- Removed: `backend/schema.sql` (the MariaDB-compatible copy with different defaults), `backend/create_app_user.sql` (`greenova_app` user), `backend/sql/2026-10-16_settings.sql` and `backend/sql/2026-10-19_ffa_thresholds.sql` (settings-changing scripts), the `--with-mariadb` option of `setup-pi.sh`, the automatic `app.seed` run in `start-backend.bat`, and the backend creating a missing database at startup.
- Tests: `greenova_test` is now built from the table definitions of `greenova_db_ver2.sql`; a new static test checks that every column the backend writes exists in the dump and that the dump's settings row loads.

**Files**: `backend/app/purification.py`, `transfers.py`, `api.py`, `models.py`, `system.py`, `db.py`, `config.py`; `backend/greenova_db_ver2.sql`, `.env.example`, `hardware.example.toml`, `setup-pi.sh`, `start-backend.bat`, `greenova.service`, `requirements.txt`, `README.md`, `API.md`, `conftest.py`, `tests/*`; `database.md`; `frontend/src/pages/NewBatch.tsx`, `Dashboard.tsx`, `Settings.tsx`, `frontend/src/lib/api.ts`, `fil.ts`; `docs/*.md`.

## Earlier notes

## Important behavior

- (Superseded on 2026-10-20: `schema.sql` was removed; the backend uses `greenova_db_ver2.sql` itself.) The database remains the supplied eight-table MySQL schema. `backend/schema.sql` mirrors the HeidiSQL dump's table definitions except for the MariaDB-incompatible `utf8mb4_0900_ai_ci` collation. Startup checks the schema and does not `ALTER TABLE`, add columns, merge lab rows, or rewrite saved settings.
- (Superseded on 2026-10-20: removed; the settings row of `greenova_db_ver2.sql` is used as it is.) The one-time settings update was `backend/sql/2026-10-16_settings.sql`.
- Transesterification FFA cutoff and re-check target default to 3%. Batch-volume code defaults are 1,500–5,000 mL. Purification defaults are 10-minute contact, 0-minute settling, and 70 °C drain limit. Separation limit defaults to 60 minutes; heater estimate defaults to 900 W.
- Process restoration no longer waits for the live sensor connection before restoring persisted batch progress. This addresses the Process page remaining at “Checking for a batch in progress…” when the live connection is delayed.
- Removed the obsolete migration module and its migration-only tests/references. MySQL is the sole database backend.
- Removed the on-screen manual “Set the current to 1A” prompt.
- Added ESP32 bridge firmware scaffold and hardware configuration keys; pins marked TODO must be confirmed against the final Cirkit schematic before connecting loads.

## Files changed

- `frontend/src/pages/NewBatch.tsx`: the detailed chemical quantity calculations are now in a collapsed, touch-friendly disclosure row so the Process setup is compact by default. `frontend/src/lib/fil.ts` adds its Filipino label.
- `docs/SUPPLIED_WIRING_MAPPING.md` and root copy: records the pin numbers from the supplied Pi/ESP32 sketches, plus explicit pin conflicts and unresolved valve/pump semantic mappings.
- `firmware/esp32_actuators/esp32_actuators.ino`: records the supplied physical ESP32 GPIOs, drives the two named L298N mixers, reads the DS18B20 on GPIO5, supports JSON `hwtest`, and leaves Greenova process output roles unassigned where the supplied wiring does not establish them.
- `backend/app/hardware.py` / `backend/app/config.py`: fail closed in live mode when `actuators.backend = "esp32"` because the current application still lacks the hybrid serial driver and complete physical role map; it no longer silently falls back to legacy Pi GPIO outputs that conflict with the new wiring. `backend/tests/test_pi_hardware.py` tests this guard.

See the repository's modified files. Main changes are in `backend/app/db.py`, `backend/app/config.py`, `backend/app/models.py`, `backend/app/api.py`, `backend/schema.sql`, `backend/sql/2026-10-16_settings.sql`, `backend/hardware.example.toml`, `firmware/esp32_actuators/esp32_actuators.ino`, `frontend/src/pages/NewBatch.tsx`, `frontend/src/pages/Settings.tsx`, `frontend/src/lib/fil.ts`, `frontend/src/lib/greenovaData.ts`, and the root/docs copies of the setup guides and database guide.

## Hardware configuration keys added

- `[actuators] backend`, `port`, `baudrate`
- `[leds] green`, `red`
- `[load_cells.reactor] capacity_kg`, `vessel_kg`
- `[load_cells.output] capacity_kg`, `vessel_kg`
- `[separation] spin_up_seconds`, `stable_grams`, `stable_seconds`
- `[purification] heating_timeout_minutes`, `drain_max_minutes`

## ESP32 pin table status

The supplied pin table now has the physical pin values for the ESP32 relays, heater, DS18B20 and two L298N mixers. Greenova-specific pump and three-valve aliases remain TODO because the supplied sketch names one generic valve and does not identify the roles of the dispenser/pump relay channels. The Pi drives the BTS7960 in the newly supplied sketch. Do not run live hardware until relay roles, the missing output-cell wiring, serial protocol integration and GPIO conflicts are resolved and bench-tested.

## Database confirmation

No table or column is intentionally added, removed, renamed, or retyped. No index, key, check, or default is changed by application startup. The schema file has eight tables: `production_batches`, `batch_lab_results`, `batch_materials`, `batch_progress`, `batch_purification`, `batch_timeline`, `esterification_stages`, and `settings`.

## Validation status

Python compilation passed. The schema contract and Pi hardware tests pass (9 tests total). The full `python -m pytest` suite was attempted but test collection stops because PyMySQL is not installed (network access prevented installing it); the targeted schema-contract and Pi hardware tests pass. The frontend production build could not run because the archive's `node_modules` is missing the platform-specific Rolldown native binding. A live MySQL schema-preservation test and browser walkthrough still need to be run in the project's configured environment.

## Follow-up: automatic motorized-valve handoffs and optional acetone

- `backend/app/api.py`: automatically advances to separation after the reactor transfer and arms purification after the centrifuge transfer regardless of legacy saved auto-advance preferences; optional absent level-switch support is handled without overriding an explicit “not submerged” signal.
- `frontend/src/pages/NewBatch.tsx`: automatic handoffs also match in the local demo; acetone can be poured or explicitly skipped after the premix loads.
- `frontend/src/pages/Settings.tsx`: removed the operator pause selector and timed outlet fields from the Settings page while preserving their stored columns/values for compatibility.
- `frontend/src/lib/fil.ts`: added Filipino labels for optional acetone and skipping it.
- `docs/WEBSITE_GUIDE.md`, `WEBSITE_GUIDE.md`, `docs/RASPBERRY_PI_SETUP.md`, `RASPBERRY_PI_SETUP.md`: documented the valve handoffs and optional acetone behavior.

