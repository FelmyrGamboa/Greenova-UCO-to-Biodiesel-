# Greenova Backend (FastAPI)

The backend runs on the **Raspberry Pi that is wired to the machine**: the ESP32 controller on its USB port (relays, heater, the two mixers, the temperature probe) and, on the Pi's own pins, the centrifuge (BTS7960) and the HX711 output load cell. It runs the reaction, separation and purification stages with their safety rules, does the chemical calculations, stores the batch records in MySQL, and computes the analytics. The website only shows data and sends commands, so closing the browser never leaves the heater or electrodes on.

There is **no demo or simulated mode**: the website always drives the real machine. When the Pi can't be reached, the website says so (it has no sample data or local simulation). The automated tests use their own simulated machine (`tests/simulator.py`), which the backend never loads.

Batches use the same fields as `BatchData` in `frontend/src/lib/greenovaData.ts`, settings use the same keys as the Settings page, and the calculator and analytics follow exactly the same formulas as `NewBatch.tsx` and `BatchHistory.tsx`.

## 1. Install it on the Raspberry Pi

**Full guide: [`docs/RASPBERRY_PI_SETUP.md`](../docs/RASPBERRY_PI_SETUP.md)** (parts, wiring, every `hardware.toml` key, testing, calibration, troubleshooting) and [`docs/PI_DEPLOYMENT.md`](../docs/PI_DEPLOYMENT.md). In short:

```bash
cd ~/Greenova-UCO-to-Biodiesel-/backend
bash setup-pi.sh                              # packages, .venv, hardware.toml, the greenova service
sudo reboot
.venv/bin/python -m app.db                    # MySQL connection (backend/.env)
nano hardware.toml                            # [esp32.devices]: which ESP32 output does which job; load cell pins
.venv/bin/python -m app.hwtest check          # pin conflicts and the job list
.venv/bin/python -m app.hwtest esp32          # the ESP32 answers (outputs, temperature)
.venv/bin/python -m app.hwtest read           # every sensor
.venv/bin/python -m app.hwtest outputs        # each job's output (heater and supply unplugged!)
.venv/bin/python -m app.hwtest calibrate output    # or on the website: Settings -> Hardware
sudo systemctl enable --now greenova          # the website at http://<pi-address>:8000
journalctl -u greenova -f
```

**Database (once):** the backend uses **MySQL 8** (not MariaDB) with the database in `greenova_db_ver2.sql`, imported as it is (HeidiSQL: *File > Run SQL file*, or `mysql -u root -p < greenova_db_ver2.sql`). That file creates `greenova_db`, its tables and data, and the MySQL user `greenova@localhost` (no password), the backend's default login. MySQL can run on the Pi or on another computer (then set `DB_HOST`, `DB_USER`, `DB_PASSWORD` in `backend/.env`). See [`database.md`](../database.md).

By hand (on the Pi, from the backend folder): `python main.py` (uses `.venv` by itself, restarts on code changes) or `.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000`. Stop the `greenova` service first: only one program can use the ESP32's serial port and the GPIO pins.

Open **http://<pi-address>:8000/docs** to see every endpoint (see `API.md`).

## 2. The tests

```bash
pip install -r requirements-dev.txt
python -m pytest
```

They run anywhere (a laptop too): the process tests use `tests/simulator.py`, a simulated machine that runs up to 1000× faster; the ESP32 tests use a fake ESP32 and fake GPIO. The database tests log in like the backend (`greenova@localhost`, or `.env`) but use a separate database, `greenova_test`, built from the table definitions of `greenova_db_ver2.sql` and emptied before each test; your `greenova_db` is never touched. Without a reachable MySQL server those tests are skipped; without FastAPI the API tests are skipped.

## 3. What's in the folder

| File | What it does |
|---|---|
| `main.py` | `python main.py` starts the backend (uses `.venv` by itself, restarts on code changes) |
| `app/main.py` | The app: reads the sensors every second, runs the watchdog, stops everything when the ESP32 is lost, starts purification after separation, serves the website |
| `app/api.py` | All endpoints (see `API.md`) and the hand-offs between the processes |
| `app/calculations.py` | Esterification, transesterification and adsorbent amounts (same as `calculateQuantityCards`) |
| `app/analytics.py` | Statistical treatment: completion and lab pass rates; mean and range of yield and cost per liter (materials only) per FFA range; recommended (Proven) settings |
| `app/stages.py` | Esterification, Transesterification and Separation (settle, then reactor pump + centrifuge + pumpin) |
| `app/transfers.py` | The oil pump and the dispensers (pump A, pump B): on until the operator presses Done |
| `app/purification.py` | Purification: methanol removal straight away (heater in 4 s pulses) → add Magnesol → contact → settle → drain until the output load cell is stable for 30 s |
| `app/system.py` | System Status tiles and device list |
| `app/hardware.py` | Safety interlocks and the older all-on-the-Pi wiring (`PiHardware`, `backend = "gpio"`) |
| `app/esp32.py` | The machine (`backend = "esp32"`, the default): the ESP32 serial link (dead-man timer, status checks) and `Esp32Hardware` with the Pi's centrifuge and load cells |
| `app/drivers.py` | Pi sensor drivers: HX711 load cells, INA226/INA219 power monitor, RPM counters, DS18B20, serial power supply |
| `app/hwtest.py` | Bench test and calibration on the Pi: `python -m app.hwtest check / esp32 / read / outputs / pump / calibrate / i2c` |
| `app/models.py` | Settings and batch fields, with their default values |
| `app/db.py` | MySQL 8 storage: turns batches and settings into rows of the 8 tables and back; `python -m app.db` checks the connection |
| `app/config.py` | The MySQL login (`.env`/environment), CORS, the website folder, and the `hardware.toml` loader and checks |
| `hardware.example.toml` | Template for `hardware.toml`: the ESP32 jobs, the Pi's pins, sensors and calibration |
| `setup-pi.sh` | One-time setup on the Raspberry Pi (and the `greenova` service) |
| `greenova.service` | The systemd service that starts the backend when the Pi boots |
| `greenova_db_ver2.sql` | **The database** (MySQL 8 export): `greenova_db`, its 8 tables and data, and the user `greenova@localhost`. Import it once as it is; the backend checks its tables against this file |
| `.env.example` | Optional overrides for the MySQL login (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`) |
| `tests/simulator.py` | The tests' simulated machine (never used by the backend itself) |
| `tests/sample_batches.py` | Fixed sample batches for the analytics and database tests (never put in the database) |

## 4. The website

The website (`frontend`) is served by the backend from `frontend/dist`: build it once with Node.js 22 (`cd frontend && npm ci && npm run build`, on any computer) and copy the project to the Pi. Then the whole system is at `http://<pi-address>:8000` (or `http://greenova.local:8000`) on the Pi's touchscreen, a laptop or a phone on the same network, without internet.

For changing the website: `npm run dev` on a laptop, with `GREENOVA_API=http://<pi-address>:8000` so the dev server forwards `/api` to the Pi (`set GREENOVA_API=...` in Command Prompt, `$env:GREENOVA_API="..."` in PowerShell).

The **System** badge at the bottom of the sidebar shows **Connected** (the Pi answers) or **Pi offline**. While the Pi is offline the Process page shows "The Raspberry Pi can't be reached" and nothing can be started; a batch that is already running carries on on the Pi, and the page catches up when the connection is back.

## 5. The batch sequence

| Step | Who / what | What happens |
|---|---|---|
| Volume & Parameters | Operator | Target oil volume, FFA, reaction settings, the dry wash adsorbent, and the **separation time and centrifuge speed** for this batch (defaults: Settings `separationTime` / `separationSpeed`; speed at most the centrifuge's 2500 RPM). |
| Oil | Oil pump (`oil`) | The operator measures the target volume into the oil container. When the Oil Loading step opens, the oil pump **switches on by itself** and runs until the operator presses **Done – the oil container is empty**. (**Stop pump** stops it; start it again for the rest.) |
| Esterification dose | Pump B (`dispenser2`) | The operator measures the computed methanol + H₂SO₄ premix into container B. When the stage opens, pump B switches on and runs until **Done**. |
| Acetone | Operator | Optional: pour it through the inlet and press **Acetone added**, or **Continue without acetone**. |
| Esterification | Pi | Starts by itself after Done + the acetone choice. Electrodes and stirrer (`mixer1`) for the set time. Then the FFA re-check: at or below 3%, go on; above it, another stage. |
| Transesterification dose | Pump A (`dispenser1`) | NaOH/KOH dissolved in methanol, measured into container A; pump A runs until **Done**. |
| Transesterification | Pi | Starts by itself after Done + the acetone choice. |
| Settle | Pi | When transesterification finishes, the mixture **settles in the reactor for 1 minute** with everything off. |
| Separation | Pi | Then the **reactor pump** (`reactorpump`, reactor → centrifuge), the **centrifuge** (at the batch's speed) and **pumpin** (`pumpin`, centrifuge → purifier) run **together** for the batch's separation time, so the biodiesel goes straight on to the purifier. All three stop when the time is over. |
| Purification | Pi | Starts by itself as soon as separation has finished (everything is in the purifier): section 6. |
| Yield | Pi | The output load cell weighs the biodiesel container. When purification is done, everything is switched off and the website saves the batch (output volume and yield included) and shows Process Complete. |

**Pumps.** The oil pump and the dispensers have no automatic stop: the containers hold exactly the computed amount, and the operator presses Done when a container is empty. A pump left running for 30 minutes stops by itself with a fault (forgotten, or a blocked line). Only one pump into the reactor runs at a time, never while the reactor pump is running. After an emergency stop and a controller reset, the stage starts with its Start button instead of by itself.

**RPM.** There are no RPM sensors: the mixers and the centrifuge are driven open loop, and the RPM shown is the set speed (the ESP32 sketch's `MAX_RPM` 1544 for the mixers, `[centrifuge] max_rpm` 2500 for the centrifuge).

**If separation doesn't start by itself** (for example after a fault), the Separation step shows **Start separation now** after a few seconds; it uses the batch's time and speed, without the settle.

## 6. Purification (dry wash with Magnesol or bentonite)

After separation, purification runs by itself. The operator only adds the adsorbent (Magnesol or bentonite, chosen per batch) when asked. The API phase is still called `magnesol`:

| Step | What happens | Time |
|---|---|---|
| 1. Methanol removal | Starts at once (no heating step). Stirrer (`mixer2`) at 200 RPM; the heater runs in **4-second pulses**: on 4 s, off, the Pi waits for the temperature to rise to its highest point, and when it is getting lower (0.2 °C below that point) the next 4 s pulse, until the time is over. No pulse at or above 90 °C. The website shows "Prepare X g Magnesol". | `methanolRemovalTime` (10 min) |
| 2. Add adsorbent | Heater off, stirrer on. "Add X g Magnesol (1% of the oil weight)"; waits for **Confirm**. | Waits for the operator |
| 3. Contact | Stirred at **200 RPM** (the RPM is shown here and in methanol removal, as the ESP32 reports it), heater off. | `contactTime` |
| 4. Settle | Stirrer off: it settles for **1 minute**. | 60 s |
| 5. Drain | The **valve** opens and **pumpout** runs: purifier → filter → output container. Done **only** when the output load cell stays within ±2 g for **30 s** (counted once the flow has started). No time limit. | |
| 6. Done | Everything is switched off. "Low output – check the polishing filter" when less than 70% of the oil weight came out. | |

**Adsorbent** = oil volume (mL) × 0.92 g/mL × dose %, rounded to 0.1 g: Magnesol 1% = oil volume × 0.0092 g (500 mL → 4.6 g), bentonite 2% = × 0.0184 g. Settings → Purification has the two times, the two doses and the default adsorbent; the 4 s heater pulses (none from 90 °C), the 95 °C cutoff, the 200 RPM stirrer, the 1-minute settle and the drain rule are fixed in `app/purification.py`. The settle time is recorded in the `settlingTimeSeconds` column. Purification needs a reading from the output load cell (it is the only way the run completes).

With the optional level switch (`[level_switch]` in `hardware.toml`) the heater waits until biodiesel covers it; without one, purification starts at once (and a manual restart asks the operator to confirm that the heater is submerged).

## 7. Safety rules built in

- The heater runs only while the purification stirrer runs and the heater is submerged, and never while the purification outlet (valve + pumpout) is on. Stopping the stirrer or opening the valve turns the heater off first. Enforced in `hardware.py`, for every caller.
- Pumps into the reactor (oil, A, B) never run while the reactor pump empties it (and the reverse), and only one at a time.
- Every output is switched on with the ESP32's 5 s timer and refreshed every second: if the Pi, the backend or the USB cable stops, the ESP32 switches it off by itself. No status from the ESP32 for 3.5 s, or an output that doesn't follow its command, stops every process and switches everything off.
- Every second, a watchdog turns off the heater above **95 °C**, when the temperature reading is lost, or when the level switch reads dry.
- The reactions (esterification, transesterification) have **no temperature check**: they run with or without a temperature reading. They don't start while the ESP32 controller is offline or faulty, and a reaction stage faults on a measured current above the current setting (with a power monitor fitted); it needs a controller reset before the next start.
- Purification stops safely (heater, stirrer, valve and pumpout off) on lost temperature during methanol removal, above 95 °C, the level switch reading dry, an operator Stop, or any unexpected error; it won't start again until the stop is acknowledged.
- Emergency stop (website) stops the stage, the pumps and purification and switches every output off. On startup and shutdown everything is off.

The thermal fuse stays your hardware backup. Set the software maximum below the fuse rating, so the software trips first.
