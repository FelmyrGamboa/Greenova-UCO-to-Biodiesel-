# Greenova Backend (FastAPI)

The backend runs on the Raspberry Pi. It reads the sensors, runs the reaction, separation and purification stages with their safety rules, does the chemical calculations, stores the batch records, and computes the analytics. The website only shows data and sends commands, so closing the browser never leaves the heater or electrodes on.

It speaks the website's language: batches use the same fields as `DemoBatch` in `src/lib/greenovaData.ts`, settings use the same keys as the Settings page, and the calculator and analytics follow exactly the same formulas and rules as `NewBatch.tsx` and `BatchHistory.tsx`. On the sample data, the backend and the website give identical numbers.

It starts in **demo mode** (simulated machine), so you can connect the website on a laptop before the hardware is ready.

## 1. Run it on your laptop (demo mode)

You need Python 3.10 or newer.

```bash
cd greenova-backend
python -m venv .venv
# Windows:      .venv\Scripts\activate
# macOS/Linux:  source .venv/bin/activate
pip install -r requirements.txt
python -m app.seed               # loads the same 6 sample batches as the website
uvicorn app.main:app --reload
```

Open **http://localhost:8000/docs**. Every endpoint is listed there with a "Try it out" button. Good first tries:

- `POST /api/calculate` with `{"oilMassG": 460, "ffa": 6, "catalyst": "NaOH"}`. Expect esterification methanol 78.4 mL and NaOH up to 5.36 g.
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

## 2. What's in the folder

| File | What it does |
|---|---|
| `app/main.py` | Starts the app, reads the sensors every second, runs the watchdog, serves the website |
| `app/api.py` | All endpoints (see `API.md`) |
| `app/calculations.py` | Esterification and transesterification amounts (same as `calculateQuantityCards`) |
| `app/analytics.py` | Summary, best parameters per FFA range, recommended parameters, cost per liter |
| `app/stages.py` | Esterification, Transesterification and Separation: start, pause, resume, complete, emergency stop |
| `app/purification.py` | Automatic purification: heating → hold → mesh bed flow → drain |
| `app/system.py` | System Status tiles and device list |
| `app/hardware.py` | Safety interlocks, the simulated machine, and the real Pi hardware |
| `app/models.py` | Settings and batch fields, with their default values |
| `app/db.py` | SQLite storage (`greenova.db`) |
| `app/strip_reader.py` | FFA strip reader (TCS34725) |
| `app/seed.py` | The website's sample batches |
| `app/config.py` | Demo mode, GPIO pins, relay type, allowed website addresses |
| `frontend/dist` | Optional: the built website, served at `http://<pi-address>:8000` (section 4) |

## 3. Move it to the Raspberry Pi

Copy the folder to the Pi (USB stick, `scp`, or GitHub), then:

```bash
sudo apt update
sudo apt install -y python3-venv python3-gpiozero python3-lgpio
cd ~/greenova-backend
python3 -m venv --system-site-packages .venv   # lets the venv use the Pi's GPIO libraries
source .venv/bin/activate
pip install -r requirements.txt -r requirements-pi.txt
```

Then, in this order:

1. **Set your pins** in `app/config.py` (`PINS`): heater relay, electrode power relay, mesh bed valve, stirrer and centrifuge PWM, and the heater level switch (section 5). GPIO17 is already used by the strip reader's LED.
2. **Check the relay type with the heater and power supply unplugged.** Many relay modules switch ON when the input is LOW. If a relay clicks on when the backend starts, set `RELAY_ACTIVE_HIGH = False`.
3. **Fill in the sensor readers** marked `TODO` in `app/hardware.py` (`PiHardware`): load cells, electrode voltage and current, RPM. The temperature reader is written for a waterproof DS18B20 probe. Enable 1-Wire with `sudo raspi-config` → Interface Options → 1-Wire, or replace it with your sensor's code. Each reader returns `None` when there's no valid reading. A missing temperature stops the heater and the electrodes.
4. **Strip reader:** enable I2C in `raspi-config`, and put `white_ref.csv` and `ffa_calibration.csv` (made with `python3 app/strip_reader.py white` and `cal`) inside the `app` folder.
5. **Start in hardware mode:**
   ```bash
   GREENOVA_MOCK=0 uvicorn app.main:app --host 0.0.0.0 --port 8000
   ```
6. From a laptop on the same Wi-Fi, open `http://<pi-address>:8000/docs`. Find the address with `hostname -I` on the Pi.
7. **Test each output on its own** with the `/api/control/...` endpoints: heater and electrodes unplugged first, then the valve, then the motors. Use `/api/control/all-off` to stop everything.

**Start automatically when the Pi boots:** edit the user and paths in `greenova.service`, then:

```bash
sudo cp greenova.service /etc/systemd/system/
sudo systemctl enable --now greenova
journalctl -u greenova -f        # watch the logs
```

**If some sensors are wired to the ESP32:** have the ESP32 print one JSON line per second over USB, for example `{"oil_g": 461.2, "temp_c": 31.5}`, and read it in `PiHardware._read_sensors` with `pyserial`.

## 4. Connect the website

The website (the `greenova-website` folder) is already connected to this backend. Its `src/lib/api.ts` talks to the backend, and the Dashboard, Process, Batch History, Batch Details and Settings pages use it. There is nothing to copy.

**On your laptop, use two Command Prompt windows.**

Window 1, the backend:

```bat
cd greenova-backend
.venv\Scripts\activate
python -m uvicorn app.main:app --reload
```

Window 2, the website (needs Node.js 22):

```bat
cd greenova-website
npm install
npm run dev
```

`npm install` is only needed the first time. Then open **http://localhost:8443**. The website's dev server forwards every `/api` request to the backend on `localhost:8000`, so you don't need a `.env` file or any CORS setting.

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

**Serving the website from the Pi:** run `npm run build` in `greenova-website`, copy its `dist` folder to `greenova-backend/frontend/dist`, and restart the backend. Then the whole system is at `http://<pi-address>:8000` and works without internet.

**Figma Make preview:** the preview can't reach a backend on your computer, so there it shows "Local demo". If you change the design in Figma Make again, keep `src/lib/api.ts`, `src/contexts/LiveContext.tsx` and the changes in `vite.config.ts`. Otherwise a new export would lose the connection.

## 5. Automatic purification

After separation, purification runs by itself. No operator confirmations are needed until the end:

| Phase | What happens | Setting (Settings → Purification) |
|---|---|---|
| Heating | Heater on, valve closed, until the target. About 1 minute with a heater sized for the batch. | Target temperature, default **70 °C**. Heating time limit, default 10 min |
| Hold | Target ±1 °C, so leftover methanol evaporates | Hold at target, default **25 min** |
| Mesh bed flow | Heater off, then the valve opens. Flow time = batch volume ÷ flow rate. The biodiesel volume is about the oil volume, e.g. 500 mL ÷ 40 mL/min = 12.5 min. | Mesh bed flow rate, default **40 mL/min** |
| Drain | Valve stays open until the output weight stops changing for 1 minute, then closes | Drain time, default 3 min at most |
| Complete | The operator confirms on the website that the process is finished, and the batch is saved | |

It starts as soon as separation is complete **and** the level switch (`heater_level_switch` in `app/config.py`) detects biodiesel covering the heater. The switch is a float switch at the heater's height in the purification tank, wired between a GPIO pin and GND. Without a level switch, the website asks the operator to confirm once that the heater is submerged. That one check stays because an immersion heater that runs dry can start a fire.

The batch volume comes from the oil measured when the batch's first stage started. The output weight counts only this batch's biodiesel, even if the collection container isn't empty. When less than half the expected weight comes out, the website shows a warning to check the mesh bed for clogging.

To time a whole batch for a demo, start the backend with `GREENOVA_TIME_SCALE=20`. Then the 25-minute hold takes about 75 seconds.

## 6. Safety rules built in

- The heater can't turn on while the mesh bed valve is open, and opening the valve turns the heater off first. This is enforced in `hardware.py`, so it applies to every caller.
- Every second, a watchdog turns off the heater (above 75 °C by default) or the electrodes (above `reactionMaximumTemperature`, default 60 °C, below methanol's 64.7 °C boiling point) when the temperature is too high or the reading is lost.
- A reaction stage faults on lost temperature or over-temperature, and needs a controller reset before the next start. Pause switches the electrodes and motor off.
- Purification stops safely (heater off, valve closed) on: lost temperature, over-temperature, not reaching the target within `heatingTimeout` (default 10 min), the level switch reading dry while the heater is on, an operator Stop, or any unexpected error. It won't start again until the stop is acknowledged.
- Only one thing runs at a time: a stage can't start during purification, and the reverse. Manual controls are blocked while either runs.
- The heater only turns on with biodiesel covering it: the level switch must report it. Without a level switch, the operator confirms it once on the website. On startup and shutdown, everything is switched off.

The thermal fuse stays your hardware backup. Set the software maximum below the fuse rating, so the software trips first.
