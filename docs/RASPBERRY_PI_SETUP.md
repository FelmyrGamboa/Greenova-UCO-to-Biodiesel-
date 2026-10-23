# Raspberry Pi setup

The website always drives the real machine: the Greenova backend on the Raspberry Pi talks to the ESP32 controller over USB (relays) and drives the motor driver (one BTS7960 for mixer 1, mixer 2 and the centrifuge) and the output load cell from the Pi's own pins. There is no demo or simulated mode.

## The process on the machine

| Step | Outputs | Ends when |
|---|---|---|
| Oil Loading | `oil` (oil pump) | the operator presses **Done** (the oil container, filled with the measured target volume, is empty) |
| Esterification dose | `dispenser2` (pump B: H₂SO₄ + methanol) | **Done** (container B, filled with the computed premix, is empty) |
| Esterification | `electrode`, `mixer1` (relay) + the BTS7960 at the stage's stirring speed | the reaction time |
| Transesterification dose | `dispenser1` (pump A: NaOH/KOH + methanol) | **Done** |
| Transesterification | `electrode`, `mixer1` (relay) + the BTS7960 at the stage's stirring speed | the reaction time |
| Settle | nothing (everything off) | 1 minute |
| Separation | `reactorpump` + `centrifuge` (relay) with the BTS7960 at the batch's speed + `pumpin`, together | the batch's separation time (set in Volume & Parameters) |
| Methanol removal | `mixer2` (relay) + the BTS7960 at 200 RPM, `heater` in 4-second pulses (none from 90 °C) | `methanolRemovalTime` (10 min) |
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
| ESP32 (`firmware/esp32_process_control/esp32_process_control.ino`, the team's relay-only sketch) | 8-channel relay board, the heater's own relay, the 4-channel relay board that picks the motor (mixer1, mixer2, centrifuge; extra unused), DS18B20 temperature | USB cable to the Pi, text commands at 115200 baud |
| Raspberry Pi | ONE BTS7960 motor driver for mixer 1, mixer 2 and the centrifuge (sets the speed of whichever motor's relay is on, one at a time), HX711 load cell(s) | its own GPIO pins, with lgpio |

### Wiring

Raspberry Pi (BCM numbers):

| Part | Signal | GPIO | Physical pin |
|---|---|---:|---:|
| Motor driver BTS7960 (mixer 1, mixer 2, centrifuge) | L_EN | 23 | 16 |
| | R_EN | 24 | 18 |
| | LPWM | 25 | 22 |
| | RPWM | 21 | 40 |
| Output load cell HX711 (VCC to **3.3 V**) | DT | 17 | 11 |
| | SCK | 27 | 13 |
| Optional reactor load cell HX711 | DT / SCK | 5 / 6 | 29 / 31 |
| Optional level switch (to GND) | | 26 | 37 |

ESP32 outputs: see `firmware/esp32_process_control/README.md` (8-channel relay: `dispenser1` GPIO22, `dispenser2` 21, `reactorpump` 19, `pumpin` 18, `oil` 25, `pumpout` 26, `valve` 27, `electrode` **32**; `heater` 5; 4-channel relay: `mixer1` 16, `mixer2` 17, `extra` 13, `centrifuge` 14; DS18B20 on **GPIO15**). The BTS7960's motor output goes to the common side of the three motor relays on the 4-channel board, and each relay's switched side to its motor (mixer 1, mixer 2, centrifuge). Connect the Pi's GND to the BTS7960 and HX711 grounds.

### Which ESP32 output does which job

`backend/hardware.toml` → `[esp32.devices]` names the sketch's device for each Greenova job. The defaults:

| Greenova job | ESP32 device | When |
|---|---|---|
| Oil pump (oil container → reactor) | `oil` | Oil Loading, until Done |
| Pump B (H₂SO₄ + methanol) | `dispenser2` | each esterification dose, until Done |
| Pump A (NaOH/KOH + methanol) | `dispenser1` | the transesterification dose, until Done |
| Electrode power | `electrode` | reaction stages |
| Mixer 1 (reactor stirrer), speed from the Pi's BTS7960 | `mixer1` | reaction stages (the stage's stirring speed) |
| Reactor pump (reactor → centrifuge) | `reactorpump` | separation (after the 1 min settle), with the centrifuge |
| Pumpin (centrifuge → purifier) | `pumpin` | separation, with the centrifuge |
| Immersion heater | `heater` | purification methanol removal, 4-second pulses (the next one when the temperature is getting lower; none from 90 °C) |
| Mixer 2 (dry wash stirrer), speed from the BTS7960 | `mixer2` | purification methanol removal, the Magnesol prompt and contact (always 200 RPM) |
| Centrifuge, speed from the BTS7960 | `centrifuge` | separation (the batch's speed) |
| Purification outlet (purifier → output container) | `valve` + `pumpout` | after contact and the 1 min settle, until the output load cell is stable for 30 s |

Check which dispenser holds which premix. Change any line to match the real machine (`""` = not fitted, `["valve", "pumpout"]` = outputs that work together). `[esp32.max_on_seconds]` can give an output an extra time limit (the ESP32 switches it off by itself), but it isn't needed: every output is switched off by its process step.

### Safety

- Every interlock stays in the backend (heater only with the dry wash stirrer and never with the purification outlet on; the oil pump and pumps A/B one at a time and never while the reactor pump runs; temperature cutoffs). The ESP32 only carries out commands.
- **Dead-man timer.** Every ESP32 output is switched on with the sketch's timed ON (`heater on 5`) and refreshed every second. If the backend, the Pi or the USB cable stops, the ESP32 switches the output off by itself within 5 s (`lease_seconds`).
- **Controller faults stop everything.** No status from the ESP32 for 3.5 s, an output that doesn't follow its command, or a device in `[esp32.devices]` the sketch doesn't have: the backend stops the stage, purification and pumps, switches everything off and shows why (alarm, the **Output Controller** tile, Settings → Hardware). Nothing switches back on by itself when the ESP32 returns: the stopped stage shows **Stopped** and the reason, and its **Start … again** button runs it again (no controller reset needed).
- The sketch's own Wi-Fi page can switch outputs past these rules. The team's sketch has a Wi-Fi name and password filled in, so anyone on that network can open it. Greenova switches its outputs back off within a second, but setting `WIFI_SSID` back to `YOUR_WIFI_NAME` keeps the ESP32 off the network.
- **Motors: one BTS7960, picked by the relays.** Mixer 1, mixer 2 and the centrifuge share the Pi's BTS7960 (`[motor_driver]` in `hardware.toml`). A motor starts with its ESP32 relay, then the Pi's PWM `relay_settle_s` (0.3 s) later; it stops with the PWM first, then the relay, so the relays never switch under current. Only one motor runs at a time (a second one is refused). Every start goes straight to the set speed: mixer 1 the stage's stirring speed, mixer 2 always 200 RPM, the centrifuge the batch's separation speed.
- RPM is open loop (there are no speed sensors): duty = the set RPM ÷ that motor's RPM at 100 % PWM (`[motor_driver.max_rpm]`: mixer 1 and mixer 2 1544, the centrifuge 2500 by default), and the website shows the set speed as the RPM reading. **Measure each motor's speed at 100 % PWM once** (tachometer) and put it there, so the set RPM is the real RPM. If a motor hums but doesn't turn at a low setting, raise its `[motor_driver.min_duty]` (e.g. 15–25 %). Bench test: `python -m app.hwtest motor stirrer 500 10` (Docker: `bash start-machine.sh --test-motors`).

### Load cells

The output load cell (DT 17 / SCK 27) is required: purification ends when its reading has been stable for 30 s. The starting calibration comes from the Pi control panel's `config.json` (`offset` 41028.54, `calibration_factor` 145759). That file labels the factor "g", but 145759 counts per gram would put the whole range of the load cell under about 15 g, so it is used as a per-**kilogram** factor (`scale = 145.759` counts per gram). If it is really per gram, every weight reads 1000 times too small and draining never counts as started, so **re-calibrate on the Pi before the first batch** and check a known weight: **Settings → Hardware → Output load cell** (or `python -m app.hwtest calibrate output`):

1. Empty it (only the empty output container on it) and press **Tare**. Keep it still: it waits 1 s, then averages 4 s.
2. Put a known weight on it, type its grams and press **Calibrate**. **Calibrate** only works after a Tare in the same sitting, because an old zero (the container moved, the cell drifted) gives a wrong scale. Add more known weights the same way (e.g. 200 g, 500 g, 1000 g, near what you will weigh): each one is a point, and the scale is the best fit through all of them. The table shows what each weight reads and its error.
3. Put a known weight on it and press **Check**: it shows the reading and the error (within 0.5 % or 1 g counts as accurate) and changes nothing.

The result is saved in `backend/data/loadcell_calibration.json` (Docker) or `backend/loadcell_calibration.json` and wins over `hardware.toml`. Calibrate only while no process runs, with nothing touching the scale or its container.

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

Other `hardware.toml` sections: `[power_monitor]` (optional INA226 for the electrode voltage and current readings; without it the over-current stop can't work), `[power_supply]` (manual knobs, or serial control on the supply's own USB port). The sections at the end of the file (`[relays]`, `[pumps]`, `[valves]`, `[motors]`, `[temperature]`, `[rpm.*]`) are only for `backend = "gpio"`, the older wiring with every output on the Pi's own pins. Older `[oil_pump]`, `[separation]` and `[purification]` sections in an existing `hardware.toml` are ignored.

### Only one program may use the ESP32 and the pins

Stop the old Pi control panel for good before starting Greenova. It opens the same USB serial port and claims the same GPIO pins (centrifuge 23/24/25/21, HX711 17/27): with both running, the ESP32's answers are split between them (controller faults that stop separation) and the centrifuge or the load cell don't work.

```bash
sudo systemctl disable --now pi-control
rm -f ~/.config/autostart/pi-control.desktop
pkill -f pi_control/app.py
```

Greenova now names the cause when a pin is taken ("GPIO 23 (centrifuge L_EN) is busy: another program is using it…").

### Running the backend in Docker

Use the files in `dockerfiles/` (`docker-compose.yaml`, `backend.Dockerfile`, `frontend.Dockerfile`, `mysql-init/`, `start-machine.sh`) and start everything with one command on the Pi:

```bash
cd ~/Desktop/Greenova-UCO-to-Biodiesel-/dockerfiles
bash start-machine.sh                  # stop what's in the way, build, start, check the hardware
bash start-machine.sh --check          # only the hardware check
bash start-machine.sh --test-outputs   # each output on for 2 s (heater and electrode supply unplugged)
```

It stops the old Pi control panel and a native `greenova` service (both would take the ESP32's port and the pins), shows the ESP32's port and the GPIO chips, builds and starts MySQL, the backend and the website, then prints **OK** or **FIX** with what to do for the ESP32 controller, the temperature, the centrifuge and the output load cell.

- `backend.Dockerfile` installs everything the machine needs: pyserial (the ESP32) and lgpio (the motor driver, load cell), on Python 3.11 (lgpio has no ready-made package for 3.13). The build stops if one is missing. An image built for the old demo mode has neither pyserial nor the hardware settings, so nothing on the machine moves.
- The backend container gets the whole `/dev` (`privileged: true`), so it finds the ESP32 as `/dev/ttyUSB0` or `/dev/ttyACM0` (also after a replug) and the header's GPIO chip on a Pi 4 or Pi 5 by itself. No `GPIO_CHIP` or device list to edit.
- `backend/data` holds `hardware.toml` (optional: without it the built-in pins are used, which match the supplied wiring) and `loadcell_calibration.json` (Tare / Calibrate), so they survive a rebuild.
- A few seconds after it starts, the backend writes a **Hardware check:** line for each part to its log (`docker compose logs backend`), including the motor driver.
- **The website opens by itself** in the Pi's browser after `docker compose up`, once `open-website.sh` is installed: `start-machine.sh` does it, or by hand once `bash open-website.sh --install` (from the `dockerfiles` folder, on the Pi's desktop). It starts with the desktop and opens `http://localhost:8443` each time the website comes up (`docker compose up`, a restart, a reboot). `bash open-website.sh --install --kiosk` opens it full screen; `bash open-website.sh --uninstall` removes it. (A Docker container can't open the Pi's browser, so this small helper runs on the desktop.)

### When an esterification or transesterification stage stops

There is no "Fault — controller reset required" any more: a stage that stopped shows **Stopped** with the reason, and its **Start … again** button runs it again straight away (no reset). The reactions don't check the temperature, so a missing DS18B20 reading can't stop them. A reaction doesn't start while the ESP32 controller is offline or faulty (the page says why). The usual reason for a stop is the ESP32 restarting: when the backend sees its boot messages it says "the ESP32 stopped answering: its supply voltage dipped (brownout)…". That happens when mixer 1 (its 1 s start at full speed) or the electrode relay switches on and the ESP32, the relay board and the L298N share the Pi's USB power. Give them their own 5 V supply (GND shared) and use a short, good USB data cable, then press **Start … again**.

### When separation doesn't go on to purification

Purification starts by itself the moment the separation timer ends. It needs a **temperature reading** (the ESP32's DS18B20 on GPIO15) and an **output load cell reading** (HX711 on 17/27), and an earlier purification safety stop must have been acknowledged. If one is missing it does not give up: nothing is switched on, the Purification step shows **Purification is waiting** with the reason (and an **Acknowledge** button for an earlier stop), and it starts as soon as that is fixed. The **Before You Start** tiles show the same problems before a batch begins (Temperature Sensor, Output Load Cell, Heater, Output Controller).

If separation itself doesn't start, the alarm says why ("Separation did not start by itself: …"); the usual causes are the ESP32 offline (**Output Controller** tile) or the centrifuge pins (see above). The backend log has every reason: `journalctl -u greenova -f`, or `docker compose logs -f backend`.

## MySQL

The database is MySQL 8 (not MariaDB): `backend/greenova_db_ver2.sql`, imported once as it is (see `../database.md`). It creates `greenova_db`, its eight tables and data, and the user `greenova@localhost` the backend logs in with. Startup reads the table definitions of that file and checks the tables and columns without altering anything.

## Verification

From `backend`, run `python -m pytest`: the process tests run on the tests' own simulated machine (`tests/simulator.py`), and `tests/test_esp32.py` runs the ESP32 mode against a simulated ESP32 and simulated GPIO. Before the first real batch: check every job's output with `hwtest outputs` (heater and electrode supply unplugged), unplug the ESP32's USB cable once while a stirrer runs and check that it stops within 5 s and the website shows the controller fault, run the oil pump and each dispenser once with water and press Done, run a short separation (1 min) to check that the reactor pump, the centrifuge and pumpin start together after the 1 min settle and stop together, and check every interlock.
