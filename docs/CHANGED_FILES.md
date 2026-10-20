# Greenova update notes

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

