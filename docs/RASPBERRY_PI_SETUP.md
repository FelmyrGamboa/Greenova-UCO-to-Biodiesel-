# Raspberry Pi setup

The website always drives the real machine: the Greenova backend on the Raspberry Pi talks to the ESP32 controller over USB and drives the centrifuge and the output load cell from the Pi's own pins. There is no demo or simulated mode.

## The process on the machine

| Step | Outputs | Ends when |
|---|---|---|
| Oil Loading | `oil` (oil pump) | the operator presses **Done** (the oil container, filled with the measured target volume, is empty) |
| Esterification dose | `dispenser2` (pump B: H₂SO₄ + methanol) | **Done** (container B, filled with the computed premix, is empty) |
| Esterification | `electrode`, `mixer1` | the reaction time |
| Transesterification dose | `dispenser1` (pump A: NaOH/KOH + methanol) | **Done** |
| Transesterification | `electrode`, `mixer1` | the reaction time |
| Settle | nothing (everything off) | 1 minute |
| Separation | `reactorpump` + the centrifuge (BTS7960 on the Pi, at the batch's speed) + `pumpin`, together | the batch's separation time (set in Volume & Parameters) |
| Purification: heating | `mixer2` (200 RPM), `heater` | 90 °C (the heater switches off) |
| Methanol removal | `mixer2`, `heater` on at 87 °C / off at 90 °C | `methanolRemovalTime` (10 min) |
| Add Magnesol | `mixer2` (heater off) | the operator confirms |
| Contact | `mixer2` at 200 RPM | `contactTime` |
| Settle | nothing | 1 minute |
| Drain | `valve` + `pumpout` | the output load cell is stable (±2 g) for 30 s; then everything is switched off |

The oil pump and the dispensers switch on by themselves when their step opens and run until the operator presses Done (a pump left on for 30 minutes stops with a fault). The reactor stage starts by itself after Done and the optional acetone. Separation and purification start by themselves. Because the biodiesel is pumped into the purifier while the centrifuge runs, purification starts when separation has finished. Confirm the wiring, the job mapping and every interlock on the machine before a production run.

## Build the website before installing on the Pi

The backend serves the production website from `frontend/dist`; it does not run the Vite development server in production. On a computer with Node.js 22, run from the repository root:

```bash
cd frontend
npm ci
npm run build
```

Confirm `frontend/dist/index.html` exists, then copy the whole project to the Pi with that `dist` folder included. The Pi install script checks for this file and stops with instructions if it is missing. You do not need Node.js on the Pi merely to serve the built website.

## Install and start

Run `backend/setup-pi.sh` on Raspberry Pi OS Bookworm. The script installs the Python environment (with lgpio and pyserial for the hardware) and the `greenova` service, and stops and disables the old Flask control panel (`pi-control` service or desktop autostart), because only one program can use the ESP32's serial port and the GPIO pins. It does not install a database server (the database is MySQL 8 from `backend/greenova_db_ver2.sql`, see `../database.md`). Optional `--kiosk` configures Chromium to open `http://localhost:8000` full-screen on the 7-inch HDMI touchscreen at boot. Keep `backend/.env` private. (`--hardware` is still accepted and does nothing extra; `--demo` was removed.)

## Wi-Fi access

The service listens on port 8000. Install/enable Avahi (mDNS) so `http://$(hostname).local:8000` resolves on the local network; `greenova.local` works only if you name the Pi `greenova` (for example, `sudo hostnamectl set-hostname greenova`). Any phone, tablet, or laptop on the same Wi-Fi can open the interface; internet is not required. When the Pi can't be reached, the website says so ("Pi offline"); a running batch carries on on the Pi.

## The ESP32 controller and the Pi

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
| Oil pump (oil container → reactor) | `oil` | Oil Loading, until Done |
| Pump B (H₂SO₄ + methanol) | `dispenser2` | each esterification dose, until Done |
| Pump A (NaOH/KOH + methanol) | `dispenser1` | the transesterification dose, until Done |
| Electrode power | `electrode` | reaction stages |
| Reactor stirrer | `mixer1` | reaction stages |
| Reactor pump (reactor → centrifuge) | `reactorpump` | separation (after the 1 min settle), with the centrifuge |
| Pumpin (centrifuge → purifier) | `pumpin` | separation, with the centrifuge |
| Immersion heater | `heater` | purification heating and methanol removal (87–90 °C) |
| Dry wash stirrer | `mixer2` | purification heating, methanol removal, the Magnesol prompt and contact (200 RPM) |
| Purification outlet (purifier → output container) | `valve` + `pumpout` | after contact and the 1 min settle, until the output load cell is stable for 30 s |

Check which dispenser holds which premix. Change any line to match the real machine (`""` = not fitted, `["valve", "pumpout"]` = outputs that work together). `[esp32.max_on_seconds]` can give an output an extra time limit (the ESP32 switches it off by itself), but it isn't needed: every output is switched off by its process step.

### Safety

- Every interlock stays in the backend (heater only with the dry wash stirrer and never with the purification outlet on; the oil pump and pumps A/B one at a time and never while the reactor pump runs; temperature cutoffs). The ESP32 only carries out commands.
- **Dead-man timer.** Every ESP32 output is switched on with the sketch's timed ON (`heater on 5`) and refreshed every second. If the backend, the Pi or the USB cable stops, the ESP32 switches the output off by itself within 5 s (`lease_seconds`).
- **Controller faults stop everything.** No status from the ESP32 for 3.5 s, an output that doesn't follow its command, or a device in `[esp32.devices]` the sketch doesn't have: the backend stops the stage, purification and pumps, switches everything off and shows why (alarm, the **Output Controller** tile, Settings → Hardware). Nothing switches back on by itself when the ESP32 returns.
- The sketch's own Wi-Fi page can switch outputs past these rules. Greenova switches its outputs back off within a second, but leave `WIFI_SSID` as `YOUR_WIFI_NAME` so the ESP32 stays off the network.
- RPM is open loop (there are no speed sensors): the mixers and the centrifuge are driven at the set speed, and the website shows that speed as the RPM reading. Mixers use the sketch's RPM (`MAX_RPM` 1544); the centrifuge is PWM from `[centrifuge] max_rpm` (2500), so a batch's centrifuge speed can be at most 2500 RPM.

### Load cells

The output load cell (DT 17 / SCK 27) is required: purification ends when its reading has been stable for 30 s. The starting calibration comes from the Pi control panel's `config.json` (`offset` 41028.54; its `calibration_factor` 145759 is per **kilogram**, so `scale = 145.759` counts per gram). Re-calibrate on the Pi before the first batch: **Settings → Hardware → Output load cell**: empty the container and press **Tare**, then put a known weight on it, type its grams and press **Calibrate** (or `python -m app.hwtest calibrate output`). The result is saved in `backend/loadcell_calibration.json` and wins over `hardware.toml`.

The reactor load cell is optional (`[load_cells.reactor] enabled = false`) and not needed: the operator measures the oil and each premix into its container and presses Done when it is empty.

### First start

```bash
cd ~/Greenova-UCO-to-Biodiesel/backend
bash setup-pi.sh && sudo reboot                     # dialout and gpio groups
.venv/bin/python -m app.hwtest check                # pins, conflicts, the job -> ESP32 device list
.venv/bin/python -m app.hwtest esp32                # the ESP32 answers: outputs and temperature every second
.venv/bin/python -m app.hwtest outputs              # heater and electrode supply UNPLUGGED, centrifuge rotor out
.venv/bin/python -m app.hwtest calibrate output
sudo systemctl enable --now greenova && journalctl -u greenova -f
```

`hwtest outputs` switches each job's output for 2 s and says which ESP32 device it is, so you can see that the right relay, pump or mixer moves. `hwtest pump oil 60` runs a pump into a measuring jug, to check it (the flow is only for reference). Then open **Settings → Hardware** on the website: the ESP32 should be online, and the job table shows what Greenova asked for next to what the ESP32 reports.

Other `hardware.toml` sections: `[power_monitor]` (optional INA226 for the electrode voltage and current; without it energy stays zero and the over-current stop can't work), `[power_supply]` (manual knobs, or serial control on the supply's own USB port). The sections at the end of the file (`[relays]`, `[pumps]`, `[valves]`, `[motors]`, `[temperature]`, `[rpm.*]`) are only for `backend = "gpio"`, the older wiring with every output on the Pi's own pins. Older `[oil_pump]`, `[separation]` and `[purification]` sections in an existing `hardware.toml` are ignored.

## MySQL

The database is MySQL 8 (not MariaDB): `backend/greenova_db_ver2.sql`, imported once as it is (see `../database.md`). It creates `greenova_db`, its eight tables and data, and the user `greenova@localhost` the backend logs in with. Startup reads the table definitions of that file and checks the tables and columns without altering anything.

## Verification

From `backend`, run `python -m pytest`: the process tests run on the tests' own simulated machine (`tests/simulator.py`), and `tests/test_esp32.py` runs the ESP32 mode against a simulated ESP32 and simulated GPIO. Before the first real batch: check every job's output with `hwtest outputs` (heater and electrode supply unplugged), unplug the ESP32's USB cable once while a stirrer runs and check that it stops within 5 s and the website shows the controller fault, run the oil pump and each dispenser once with water and press Done, run a short separation (1 min) to check that the reactor pump, the centrifuge and pumpin start together after the 1 min settle and stop together, and check every interlock.
