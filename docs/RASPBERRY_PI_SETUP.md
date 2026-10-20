# Raspberry Pi setup
## Automatic valve handoffs

There is no drain time. When transesterification completes, Greenova opens the motorized reactor outlet (reactor → centrifuge) and starts separation at once; the outlet stays open. When separation completes, the centrifuge outlet waits for the centrifuge to stop, opens to the purification tank and stays open, and purification starts at once. Purification: heating until 90 °C (the heater switches off there), methanol removal at 90 °C, add the adsorbent, contact (stirred, heater off), then the polishing-filter outlet opens right away (no settling, no cooling). The run is complete only when the output load cell reading has been stable for 30 s; then every valve closes (purification, reactor and centrifuge outlets). A fault, an emergency stop or a cancel also closes them. Because purification starts while the tank is still filling, **fit the level switch**: with it the heater waits until the biodiesel covers it; without it the heater switches on at once. Purification needs the output load cell, since its stable reading is what ends the run. Confirm actual valve travel, wiring, valve end stops, and safety interlocks on the machine before a production run.


## Build the website before installing on the Pi

The backend serves the production website from `frontend/dist`; it does not run the Vite development server in production. On a computer with Node.js 22, run from the repository root:

```bash
cd frontend
npm ci
npm run build
```

Confirm `frontend/dist/index.html` exists, then copy the whole project to the Pi with that `dist` folder included. The Pi install script checks for this file and stops with instructions if it is missing. You do not need Node.js on the Pi merely to serve the built website.

## Install and start

Run `backend/setup-pi.sh` on Raspberry Pi OS Bookworm. The script installs the Python environment (with lgpio and pyserial for the hardware) and the `greenova` service; it does not install a database server (the database is MySQL 8 from `backend/greenova_db_ver2.sql`, see `../database.md`). Optional `--kiosk` configures Chromium to open `http://localhost:8000` full-screen on the 7-inch HDMI touchscreen at boot. Keep `backend/.env` private.

- `bash setup-pi.sh` installs the service in **demo mode** (`GREENOVA_MOCK=1`): the website is live over Wi-Fi, but the process is simulated and nothing is switched.
- `bash setup-pi.sh --hardware` installs it in **hardware mode** (`GREENOVA_MOCK=0`): the website drives the real machine through the ESP32 controller and the Pi's centrifuge and load cell (next section). It also stops and disables the old Flask control panel (`pi-control` service or desktop autostart), because only one program can use the ESP32's serial port and the GPIO pins.
- `bash setup-pi.sh --demo` switches back. After either, `sudo systemctl restart greenova`.

## Wi-Fi access

The service listens on port 8000. Install/enable Avahi (mDNS) so `http://$(hostname).local:8000` resolves on the local network; `greenova.local` works only if you name the Pi `greenova` (for example, `sudo hostnamectl set-hostname greenova`). Any phone, tablet, or laptop on the same Wi-Fi can open the interface; internet is not required. The Dashboard should show the Pi address and QR code for opening the site on another device.

## Hardware mode: the ESP32 controller and the Pi

The machine is split between two boards, and the Greenova backend on the Pi drives both:

| Board | What it does | How |
|---|---|---|
| ESP32 (`firmware/esp32_process_control/esp32_process_control.ino`, unchanged) | 8-channel relay board, the heater's own relay, mixer 1 and 2 on the L298N (speed in RPM), DS18B20 temperature | USB cable to the Pi, text commands at 115200 baud |
| Raspberry Pi | Centrifuge on the BTS7960 (soft start/stop, 0–2500 RPM), HX711 load cell(s) | its own GPIO pins, with lgpio |

### Wiring

Raspberry Pi (BCM numbers):

| Part | Signal | GPIO | Physical pin |
|---|---|---:|---:|
| Centrifuge BTS7960 | L_EN | 23 | 16 |
| | R_EN | 24 | 18 |
| | LPWM | 25 | 22 |
| | RPWM | 21 | 40 |
| Output load cell HX711 (VCC to **3.3 V**) | DT | 17 | 11 |
| | SCK | 27 | 13 |
| Optional reactor load cell HX711 | DT / SCK | 5 / 6 | 29 / 31 |
| Optional level switch (to GND) | | 26 | 37 |

ESP32 outputs: see `firmware/esp32_process_control/README.md` (`dispenser1` GPIO22, `dispenser2` 21, `reactorpump` 19, `pumpin` 18, `oil` 25, `pumpout` 26, `valve` 27, `electrode` 13, `heater` 5, `mixer1` ENB16/IN3 23/IN4 17, `mixer2` ENA32/IN1 33/IN2 14, DS18B20 on GPIO4). Connect the Pi's GND to the BTS7960 and HX711 grounds.

### Which ESP32 output does which job

`backend/hardware.toml` → `[esp32.devices]` names the sketch's device for each Greenova job. The defaults:

| Greenova job | ESP32 device | When |
|---|---|---|
| Oil pump (oil tank → reactor) | `oil` | Oil Loading step |
| Pump B (H₂SO₄ + methanol) | `dispenser2` | each esterification dose |
| Pump A (NaOH/KOH + methanol) | `dispenser1` | the transesterification dose |
| Electrode power | `electrode` | reaction stages |
| Reactor stirrer | `mixer1` | reaction stages |
| Reactor outlet (reactor → centrifuge) | `reactorpump` | from the end of transesterification |
| Centrifuge outlet (centrifuge → purifier) | `pumpin` | from the end of separation (after the spin-down wait) |
| Immersion heater | `heater` | purification heating and methanol removal |
| Dry wash stirrer | `mixer2` | purification until the drain |
| Purification outlet (purifier → output container) | `valve` + `pumpout` | after purification (contact): the valve opens and pumpout pumps to the output container until the output load cell is stable for 30 s |

Check which dispenser holds which premix. Change any line to match the real machine (`""` = not fitted, `["valve", "pumpout"]` = outputs that work together). There is no transfer time: `reactorpump` and `pumpin` keep running until the batch is complete, then every output stops. Once their tank is empty they run dry until then; to stop one after a set time instead, give it a run time under `[esp32.max_on_seconds]` (for example `reactor_outlet = 300`) and the ESP32 switches it off by itself after that long.

### Safety

- Every interlock stays in the backend (heater only with the dry wash stirrer and never with the outlet open; the oil pump and pumps A/B one at a time and never with the reactor outlet open; no centrifuge outlet while it spins; temperature cutoffs). The ESP32 only carries out commands.
- **Dead-man timer.** Every ESP32 output is switched on with the sketch's timed ON (`heater on 5`) and refreshed every second. If the backend, the Pi or the USB cable stops, the ESP32 switches the output off by itself within 5 s (`lease_seconds`).
- **Controller faults stop everything.** No status from the ESP32 for 3.5 s, an output that doesn't follow its command, or a device in `[esp32.devices]` the sketch doesn't have: the backend stops the stage, purification, pumps and outlets, switches everything off and shows why (alarm, the **Output Controller** tile, Settings → Hardware). Nothing switches back on by itself when the ESP32 returns.
- The sketch's own Wi-Fi page can switch outputs past these rules. Greenova switches its outputs back off within a second, but leave `WIFI_SSID` as `YOUR_WIFI_NAME` so the ESP32 stays off the network.
- RPM is open loop (there are no speed sensors): the website shows the speed each motor was set to. The centrifuge outlet therefore always waits the **Centrifuge spin-down wait** (Settings) after the centrifuge stops.
- Speeds are sent on each board's own scale: mixers in the sketch's RPM (`MAX_RPM` 1544), the centrifuge as PWM from `[centrifuge] max_rpm` (2500). The stirrer and centrifuge max-RPM settings in the database are not used in this mode.

### Load cells

The output load cell (DT 17 / SCK 27) is required: purification ends when its reading has been stable for 30 s. The starting calibration comes from the Pi control panel's `config.json` (`offset` 41028.54; its `calibration_factor` 145759 is per **kilogram**, so `scale = 145.759` counts per gram). Re-calibrate on the Pi before the first batch: **Settings → Hardware → Output load cell**: empty the container and press **Tare**, then put a known weight on it, type its grams and press **Calibrate** (or `python -m app.hwtest calibrate output`). The result is saved in `backend/loadcell_calibration.json` and wins over `hardware.toml`.

The reactor load cell is optional (`[load_cells.reactor] enabled = false` by default). Without it, the oil pump and pumps A and B load **by time** at their flow rates, and the acetone check is skipped. With a second HX711 wired (suggested DT 5 / SCK 6), set `enabled = true` and calibrate it the same way: the pumps then stop on the weight instead.

### Oil pump and pump rates

Oil Loading is automatic: the operator presses **Start oil pump**, and the oil pump loads the target volume (Stop and Continue loading are there too). Without a reactor load cell it runs for volume ÷ rate, so measure each pump's flow once with a measuring jug:

```bash
.venv/bin/python -m app.hwtest pump oil 60        # runs the oil pump 60 s; type the mL in the jug
.venv/bin/python -m app.hwtest pump catalyst 30   # pump A; and: pump acid 30 (pump B)
```

Put the oil pump's mL/min in `hardware.toml` (`[oil_pump] rate_ml_per_min`, default 500) and pumps A and B's on the website (Settings → Pump A / Pump B rate).

### First start in hardware mode

```bash
cd ~/Greenova-UCO-to-Biodiesel/backend
bash setup-pi.sh --hardware && sudo reboot          # dialout and gpio groups
.venv/bin/python -m app.hwtest check                # pins, conflicts, the job -> ESP32 device list
.venv/bin/python -m app.hwtest esp32                # the ESP32 answers: outputs and temperature every second
.venv/bin/python -m app.hwtest outputs              # heater and electrode supply UNPLUGGED, centrifuge rotor out
.venv/bin/python -m app.hwtest calibrate output
.venv/bin/python -m app.hwtest pump oil 60          # oil pump flow -> [oil_pump] rate_ml_per_min
sudo systemctl enable --now greenova && journalctl -u greenova -f
```

`hwtest outputs` switches each job's output for 2 s and says which ESP32 device it is, so you can see that the right relay, pump or mixer moves. Then open **Settings → Hardware** on the website: the ESP32 should be online, and the job table shows what Greenova asked for next to what the ESP32 reports.

Other `hardware.toml` sections: `[separation]` (spin-up 15 s, stable band 20 g, stable time 60 s), `[purification]` (heating timeout 25 min; the drain has no time limit), `[power_monitor]` (optional INA226 for the electrode voltage and current; without it energy stays zero and the over-current stop can't work), `[power_supply]` (manual knobs, or serial control on the supply's own USB port). The sections at the end of the file (`[relays]`, `[pumps]`, `[valves]`, `[motors]`, `[temperature]`, `[rpm.*]`) are only for `backend = "gpio"`, the older wiring with every output on the Pi's own pins.

## MySQL

The database is MySQL 8 (not MariaDB): `backend/greenova_db_ver2.sql`, imported once as it is (see `../database.md`). It creates `greenova_db`, its eight tables and data, and the user `greenova@localhost` the backend logs in with. Startup reads the table definitions of that file and checks the tables and columns without altering anything.

## Verification

From `backend`, run `python -m pytest` (`tests/test_esp32.py` runs the ESP32 mode against a simulated ESP32 and simulated GPIO). For a demo browser walkthrough, set `GREENOVA_MOCK=1` and `GREENOVA_TIME_SCALE=20`, then check both FFA pathways at 1,500 and 5,000 mL in English and Filipino. Before the first real batch: check every job's output with `hwtest outputs` (heater and electrode supply unplugged), unplug the ESP32's USB cable once while a stirrer runs and check that it stops within 5 s and the website shows the controller fault, and check every interlock.
