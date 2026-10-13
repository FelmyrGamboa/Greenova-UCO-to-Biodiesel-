# Greenova Backend (FastAPI)

The backend runs on the Raspberry Pi. It reads the sensors, runs the reaction, separation and purification stages with their safety rules, does the chemical calculations, stores the batch records, and computes the analytics. The website only shows data and sends commands, so closing the browser never leaves the heater or electrodes on.

It speaks the website's language: batches use the same fields as `DemoBatch` in `src/lib/greenovaData.ts`, settings use the same keys as the Settings page, and the calculator and analytics follow exactly the same formulas and rules as `NewBatch.tsx` and `BatchHistory.tsx`. On the sample data, the backend and the website give identical numbers.

It starts in **demo mode** (simulated machine), so you can connect the website on a laptop before the hardware is ready.

## 1. Run it on your laptop (demo mode)

You need Python 3.10 or newer (3.11 works) and a **MySQL 8 server** (or MariaDB 10.11+): the batches and settings are stored in the `greenova_db` database, no longer in `greenova.db`.

**The database: just your MySQL password.** Put it after `DB_PASSWORD=` in `backend/.env` (`start-backend.bat` creates that file from `.env.example` and opens it the first time), or type it in `app/config.py`. The backend creates the `greenova_db` database and its tables by itself. `python -m app.db` checks the connection and says exactly what is wrong if it can't connect. If you have batches in an old `greenova.db`, copy them once with `python -m app.migrate_sqlite`. Guide: [`database.md`](../database.md).

**Simplest:** in the backend folder, run `python main.py`. It uses the `.venv` by itself (no need to activate it), starts the backend at http://localhost:8000, and restarts when you edit the code. The first time, create the `.venv` and install the packages as shown below.

**Or on Windows:** double-click `start-backend.bat`, or run it from Command Prompt. The first time, it creates `database.toml` (enter your MySQL password in it and run the file again), creates `.venv` and installs the packages. Then it checks the MySQL connection, loads the sample batches and starts the backend at http://localhost:8000. Leave the window open.

By hand:

```bash
cd backend
python -m venv .venv
# Windows:      .venv\Scripts\activate
# macOS/Linux:  source .venv/bin/activate
pip install -r requirements.txt  # includes PyMySQL and cryptography (MySQL driver)
copy .env.example .env           # Windows (cp on macOS/Linux): then type your MySQL password in .env
python -m app.db                 # checks the MySQL connection, creates the database and its tables
python -m app.seed               # loads the same 6 sample batches as the website
python -m uvicorn app.main:app --reload
```

Always start it from the backend folder. `python -m app.main` and `python app/main.py` work too, but they don't restart when you edit the code. On a laptop, don't set `GREENOVA_MOCK=0`: hardware mode needs the Raspberry Pi's GPIO, and the backend now tells you so instead of crashing.

Open **http://localhost:8000/docs**. Every endpoint is listed there with a "Try it out" button. Good first tries:

- `POST /api/calculate` with `{"oilMassG": 460, "ffa": 6, "catalyst": "NaOH"}`. Expect esterification methanol 130.6 mL (the uniform dose for 10% FFA) and NaOH up to 5.36 g. FFA is a whole percent: `"ffa": 2.5` is refused with "ffa: Use a whole number (no decimals)."
- `POST /api/demo/load-oil` with `{"volumeMl": 500}`, then `POST /api/process/purification/start` with `{}`, and `GET /api/process/purification` a few times to watch it heat, hold, flow and drain by itself.

To make the simulated machine run faster for demos, set a time scale before starting (20 = twenty times faster):

```bash
# Windows PowerShell:  $env:GREENOVA_TIME_SCALE="20"
# macOS/Linux:         export GREENOVA_TIME_SCALE=20
```

Run the tests:

```bash
pip install -r requirements-dev.txt
python -m pytest
```

The database tests log in like the backend (`.env` / `app/config.py`) but use a separate database, `greenova_test`, which they create and empty before each test; your `greenova_db` is never touched. Without a reachable MySQL server those tests are skipped.

Run it from the backend folder or from the repo root (`python -m pytest backend`). `conftest.py` makes `from app.main import app` work from both places, so the tests import `app.main`, not `backend.main`.

## 2. What's in the folder

| File | What it does |
|---|---|
| `main.py` | `python main.py` starts the backend (uses `.venv` by itself, restarts on code changes) |
| `app/main.py` | The app: reads the sensors every second, runs the watchdog, serves the website |
| `app/api.py` | All endpoints (see `API.md`) |
| `app/calculations.py` | Esterification, transesterification and Magnesol amounts (same as `calculateQuantityCards`) |
| `app/analytics.py` | Summary, best parameters per FFA range, recommended parameters, cost per liter |
| `app/stages.py` | Esterification, Transesterification and Separation: start, pause, resume, complete, emergency stop |
| `app/purification.py` | Automatic purification (dry wash with Magnesol): heating → methanol removal → add Magnesol → contact → settling → cooling → draining |
| `app/transfers.py` | Dosing pumps A and B (load a dose by weight) and the reactor and centrifuge outlet valves |
| `app/system.py` | System Status tiles and device list |
| `app/hardware.py` | Safety interlocks, the simulated machine, and the real Pi hardware (`PiHardware`, configured by `hardware.toml`) |
| `app/drivers.py` | Pi sensor drivers: HX711 load cells, INA226/INA219 power monitor, RPM counters, DS18B20, serial power supply |
| `app/hwtest.py` | Bench test and calibration on the Pi: `python -m app.hwtest check / read / outputs / calibrate / i2c` |
| `hardware.example.toml` | Template for `hardware.toml`: the Pi's pins, sensors and calibration |
| `setup-pi.sh` | One-time setup on the Raspberry Pi |
| `app/models.py` | Settings and batch fields, with their default values |
| `app/db.py` | MySQL storage: turns batches and settings into rows of the 7 tables and back; `python -m app.db` checks the connection |
| `schema.sql` | The MySQL tables (`greenova_db`): the backend creates any missing one by itself |
| `.env.example` | Template for `.env`: your MySQL login (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`) |
| `app/migrate_sqlite.py` | One-time copy of an old `greenova.db` (SQLite) into MySQL |
| `app/strip_reader.py` | FFA strip reader (TCS34725) |
| `app/seed.py` | The website's sample batches |
| `app/config.py` | Demo mode, the MySQL login (defaults; `.env` wins), allowed website addresses, and the `hardware.toml` loader |
| `frontend/dist` | Optional: the built website, served at `http://<pi-address>:8000` (section 4) |

## 3. Move it to the Raspberry Pi

**Full guide: [`docs/RASPBERRY_PI_SETUP.md`](../docs/RASPBERRY_PI_SETUP.md)** (parts list, wiring diagram and default pins, every `hardware.toml` key, testing, calibration, troubleshooting). In short:

```bash
cd ~/Greenova-UCO-to-Biodiesel-/backend
bash setup-pi.sh --with-mariadb               # packages, I2C + 1-Wire, .venv, hardware.toml, the service, MySQL (MariaDB)
sudo reboot
.venv/bin/python -m app.db                    # MySQL connection (backend/.env)
nano hardware.toml                            # your pins, relay type, valve/motor types, which sensors are fitted
.venv/bin/python -m app.hwtest check          # pin conflicts
.venv/bin/python -m app.hwtest read           # every sensor
.venv/bin/python -m app.hwtest outputs        # each relay/pump/valve/motor (heater and supply unplugged!)
.venv/bin/python -m app.hwtest calibrate reactor   # and: output
sudo systemctl enable --now greenova          # hardware mode (GREENOVA_MOCK=0), starts on boot
journalctl -u greenova -f
```

**All wiring lives in `hardware.toml`**, not in the code: pins (BCM numbers), `relays.active_high` (false for "low level trigger" boards), valves `single` (one relay) or `dual` (3-wire motorized ball valves), motors `pwm` or `esc` (brushless), the level switch, the DS18B20, both HX711 load cells with their calibration, the INA226/INA219 power monitor, the three RPM sensors, and the power supply (`manual`, or `serial` to set voltage and current over USB). A part that isn't enabled reads "—", and the backend works around it. The backend refuses to start if two parts share a pin.

**Strip reader:** enable I2C, and put `white_ref.csv` and `ffa_calibration.csv` (made with `python3 app/strip_reader.py white` and `cal`) inside the `app` folder. Readings are rounded to whole percent.

**If some sensors are wired to the ESP32:** have the ESP32 print one JSON line per second over USB, for example `{"oil_g": 461.2, "temp_c": 31.5}`, and read it in `PiHardware._read_sensors` with `pyserial`.

## 4. Connect the website

The website (the `frontend` folder) is already connected to this backend. Its `src/lib/api.ts` talks to the backend, and the Dashboard, Process, Batch History, Batch Details and Settings pages use it. There is nothing to copy.

**On your laptop, use two Command Prompt windows.**

Window 1, the backend:

```bat
cd backend
python main.py
```

Window 2, the website (needs Node.js 22):

```bat
cd frontend
npm install
npm run dev
```

`npm install` is only needed the first time. Then open **http://localhost:8443**. To open it on a phone on the same Wi-Fi, scan the QR code that `npm run dev` prints, or click **Open on phone** in the sidebar. See `frontend/README.md`. The website's dev server forwards every `/api` request to the backend on `localhost:8000`, so you don't need a `.env` file or any CORS setting.

The **System** badge at the bottom of the sidebar shows what the website is using:

| Badge | Meaning |
|---|---|
| **Backend · demo** | The backend is running in demo mode, so the machine is simulated |
| **Connected** | The backend is running on the Pi with the real hardware (`GREENOVA_MOCK=0`) |
| **Local demo** | The backend can't be reached, so the website uses its own sample data, as before |

**Backend on the Pi, website on the laptop:** before `npm run dev`, point the website at the Pi:

```bat
set GREENOVA_API=http://192.168.1.50:8000
```

In PowerShell, use `$env:GREENOVA_API="http://192.168.1.50:8000"` instead.

**Serving the website from the Pi:** run `npm run build` in `frontend` and restart the backend. It serves `frontend/dist` by itself (it also looks in `backend/frontend/dist`). Then the whole system is at `http://<pi-address>:8000` and works without internet.

**Figma Make preview:** the preview can't reach a backend on your computer, so there it shows "Local demo". If you change the design in Figma Make again, keep `src/lib/api.ts`, `src/contexts/LiveContext.tsx` and the changes in `vite.config.ts`. Otherwise a new export would lose the connection.

## 5. Dosing pumps, outlet valves and the batch sequence

| Step | Who does it | What happens |
|---|---|---|
| Oil | Operator | Pours the oil through the inlet filter. The reactor load cell weighs it. The button says **Continue to Esterification** (FFA above 1%) or **Continue to Transesterification** (1% or below): it records the oil weight and goes straight to that stage. FFA is entered as a whole percent. |
| Esterification dose | Pump B | The operator mixes the methanol and H₂SO₄ in tank B beforehand. When the stage opens, pump B loads the premix by itself and stops when the reactor load cell has gained its weight. If the pump faults, the website shows "Pump problem – check the line" and a **Retry** button. |
| Acetone | Operator | Poured through the inlet **after** the pump has finished (the pump doses by the reactor's weight, so pouring during pumping would stop it early). The website shows the weight gained against the target (10% of the oil volume, provisional). |
| Esterification | Pi | Starts by itself once the dose and the acetone are in. Electrodes and stirrer for the set time, at the set voltage and current (default 1 A, 1–2 A, whole amperes). Then the operator enters the FFA re-check: at or below 1%, go on; above it, another stage dosed for the reading (40:1, no new acetone). |
| Transesterification dose | Pump A | NaOH or KOH dissolved in the methanol in tank A, loaded by itself when the stage opens. The catalyst amount is exact here: it neutralizes the last re-check reading. |
| Transesterification | Pi | Starts by itself once loaded. Then the **reactor outlet valve opens by itself** for `reactorDrainTime` (default 1 min): reactor → centrifuge, and closes. |
| Separation | Pi | **Starts by itself as soon as the reactor outlet has closed** (`autoAdvance`, default on; the website moves on to it too). Centrifuge for the set time. When it has stopped (RPM ≈ 0, or `centrifugeSpinDownTime` without an RPM sensor), the **centrifuge outlet valve opens by itself** for `centrifugeDrainTime` (default **2 min**): biodiesel → purification tank. |
| Purification | Pi | Starts by itself once the centrifuge outlet has closed and the level switch sees biodiesel (section 6). |
| Yield | Pi | The output load cell weighs the biodiesel container. When the purification outlet has closed, the website saves the batch by itself (output volume and yield included) and shows Process Complete. |

**Uniform esterification dose.** The FFA strip reads only up to 5% (its darkest color). Every batch above 1% gets one dose, calculated as if the oil had `esterificationDesignFfa` (default 10%): per 100 mL of oil, about 26 mL methanol and 0.25 mL H₂SO₄. When the strip shows its darkest color, tick that on the website; the batch is recorded as "≥ 5%". The re-check after each stage decides the next one.

**Pumps.** Each pump has its own tank. Mix about 10% extra in the same proportions so the line stays full: the pump stops by weight, so only the dose enters. The pump stops with a fault when the load cell doesn't rise for `pumpNoFlowSeconds` (default 20 s: empty tank or blocked line) or after twice the expected time. Without a load cell reading, it doses by time at `pumpCatalystRate` / `pumpAcidRate` (mL/min). Only one pump runs at a time. After an emergency stop and a controller reset, the stage starts with its Start button instead of by itself.

**Valves.** The website shows each motorized valve as an **Open / Closed** indicator only; it has no buttons for them. An outlet time of 0 in Settings means the valve isn't used: move the liquid yourself. (`/api/control/valve` still exists for testing.)

**Choices to check against your machine** (change them if yours is different):
- The outlet valves stay open for a set time (they have no level sensor behind them).
- The purification stirrer runs at a fixed 200 RPM from heating to the end of contact, and is off for settling and draining.
- Each pump tank holds one batch's premix, mixed by the operator.

## 6. Automatic purification (dry wash with Magnesol or bentonite)

After separation, purification runs by itself. The operator only adds the adsorbent (Magnesol or bentonite, chosen per batch on the website) when asked. The steps are the same for both; the API phase is still called `magnesol`:

| Step | What happens | Time |
|---|---|---|
| 1. Heating | Stirrer on (200 RPM), then the heater, until **90 °C**. The website shows "Prepare X g Magnesol". | Fault if 90 °C isn't reached in 15 min |
| 2. Methanol removal | Hold 90 ±2 °C with the stirrer running, so leftover methanol evaporates | `methanolRemovalTime`, default **10 min** (5–30) |
| 3. Add adsorbent | Heater off, stirrer on. The website shows "Add X g Magnesol (1% of the oil weight)" or "Add X g Bentonite (2% …)" and waits for **Confirm** | Waits for the operator |
| 4. Contact | Stirring, heater off | `contactTime`, default **15 min** |
| 5. Settling | Stirrer off | `settlingTime`, default **10 min** |
| 6. Cooling | Only if needed: waits until the tank is at or below the water filter's limit | `maxDrainTemperature`, default **50 °C** |
| 7. Draining | The purification outlet valve opens: tank → filter → output container. Done when the output load cell stays within ±2 g for 30 s (counted once the flow has started), 20 min at most | |
| 8. Done | Valve closed. Warns "Low output – check the filter" when less than 70% of the oil weight came out. The website saves the batch by itself and shows Process Complete | |

**Adsorbent** = oil volume (mL) × 0.92 g/mL × dose %, rounded to 0.1 g. Magnesol 1% (`magnesolDose`) = oil volume × 0.0092 g (500 mL → 4.6 g); bentonite 2% (`bentoniteDose`) = oil volume × 0.0184 g (500 mL → 9.2 g). The same value is shown in Volume & Parameters. The batch record keeps `adsorbent` and `adsorbentG`, and the cost per liter counts `magnesolKg` or `bentoniteKg` (prices `magnesolPrice`, `bentonitePrice`).

Settings → Purification has the four times above, the two doses and the default adsorbent. The 90 °C hold, the 95 °C cutoff, the 200 RPM stirrer and the drain rule are fixed in `app/purification.py`.

It starts as soon as the centrifuge outlet has closed after separation **and** the level switch (`[level_switch]` in `hardware.toml`) detects biodiesel covering the heater. The switch is a float switch at the heater's height in the purification tank, wired between a GPIO pin and GND. Without a level switch, the website asks the operator to confirm once that the heater is submerged. That one check stays because an immersion heater that runs dry can start a fire.

The output weight counts only this batch's biodiesel, even if the collection container isn't empty.

To time a whole batch for a demo, start the backend with `GREENOVA_TIME_SCALE=20`. Then the 10-minute methanol removal takes 30 seconds.

## 7. Safety rules built in

- The heater runs only while the purification stirrer is running and the heater is submerged, and never while the purification outlet valve is open. Stopping the stirrer or opening the valve turns the heater off first. This is enforced in `hardware.py`, so it applies to every caller.
- The dosing pumps can't run while the reactor outlet is open (and the reverse), and only one pump runs at a time. The centrifuge can't spin with its outlet open, and its outlet can't open while it spins.
- Pumps don't run during a stage, and a stage can't start while a pump runs or an outlet valve drains. Emergency stop stops the pumps and closes every valve.
- Every second, a watchdog turns off the heater (above **95 °C**, or when the level switch reads dry) or the electrodes (above `reactionMaximumTemperature`, default 60 °C, below methanol's 64.7 °C boiling point) when the temperature is too high or the reading is lost.
- A reaction stage faults on lost temperature, over-temperature, or a measured current above the current setting (2 readings in a row): the electrodes stop and the website shows a warning. It needs a controller reset before the next start. Pause switches the electrodes and motor off.
- Purification stops safely (heater off, stirrer off, valve closed) on: lost temperature, above 95 °C, not reaching 90 °C within 15 min, the level switch reading dry while the heater is on, the stirrer reading under 100 RPM for more than 5 s while the heater is on, an operator Stop, or any unexpected error. It won't start again until the stop is acknowledged.
- Only one thing runs at a time: a stage can't start during purification, and the reverse. Manual controls are blocked while either runs.
- The heater only turns on with biodiesel covering it: the level switch must report it. Without a level switch, the operator confirms it once on the website. On startup and shutdown, everything is switched off.

The thermal fuse stays your hardware backup. Set the software maximum below the fuse rating, so the software trips first.
