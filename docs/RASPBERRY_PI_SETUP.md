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

Run `backend/setup-pi.sh` on Raspberry Pi OS Bookworm. The script installs the Python environment and service; it does not install a database server (the database is MySQL 8 from `backend/greenova_db_ver2.sql`, see `../database.md`). Optional `--kiosk` configures Chromium to open `http://localhost:8000` full-screen on the 7-inch HDMI touchscreen at boot. Keep `backend/.env` private. The installed service deliberately runs with `GREENOVA_MOCK=1`: the website is live on the Pi and accessible over Wi-Fi, but process readings and transitions are simulated and no physical outputs are activated.

## Wi-Fi access

The service listens on port 8000. Install/enable Avahi (mDNS) so `http://$(hostname).local:8000` resolves on the local network; `greenova.local` works only if you name the Pi `greenova` (for example, `sudo hostnamectl set-hostname greenova`). Any phone, tablet, or laptop on the same Wi-Fi can open the interface; internet is not required. The Dashboard should show the Pi address and QR code for opening the site on another device.

## Controller and wiring

The latest operator-supplied pin list and known conflicts are recorded in [`SUPPLIED_WIRING_MAPPING.md`](SUPPLIED_WIRING_MAPPING.md). Read it before changing pins: that pinout conflicts with the current direct-GPIO defaults. Keep the live website in demo mode for now; do not enable real hardware until the hybrid controller and valve-role mapping are confirmed.


The operator-supplied sketches describe a split controller: the ESP32 runs the 8-channel relay module, heater relay, two L298N mixers and a DS18B20 on GPIO5; the Raspberry Pi directly drives the BTS7960 centrifuge and reads one HX711 on BCM GPIO17/27. The complete Greenova application still expects two independent load cells and three independent process outlet valves. The supplied sketch labels only one generic `valve` relay, and the current direct-GPIO backend is not yet wired to the ESP32 serial bridge. Review `SUPPLIED_WIRING_MAPPING.md`; keep the live demo active and do not enable real hardware using this pinout until the relay roles and hybrid driver are completed and bench-tested.

Configure `backend/hardware.toml` using `backend/hardware.example.toml` as the template:

- `[actuators]`: `backend = "esp32"` (default) or `"gpio"` for the legacy Pi GPIO wiring, plus serial `port` and `baudrate = 115200`.
- `[load_cells.reactor]` and `[load_cells.output]`: HX711 pins, calibration, `capacity_kg = 5`, and `vessel_kg` (empty vessel mass after tare).
- `[temperature]`: DS18B20 bus. Set `reactor_sensor_id` and `purification_sensor_id` to distinct probe IDs where available. One probe can be shared by both readings, with a warning shown before starting.
- `[leds]`: Pi GPIO BCM pins for green (ready/running) and red (alarm).
- `[separation]`: spin-up 15 s, stable band 20 g, stable time 60 s.
- `[purification]`: heating timeout 25 min. The drain has no time limit: it ends when the output load cell is stable for 30 s.

The 60 °C electrode cutoff uses the reactor probe; the purification hold uses the purification probe. `production_batches.temperature_c` records the average transesterification reactor temperature. Without an INA226, energy remains zero. INA226, RPM sensors, and the level switch are optional. The purification outlet valve is optional; without it the operator opens the drain by hand and the process ends when output weight is steady. The output load cell is required for purification.

## ESP32 serial protocol and safety

The Greenova ESP32 firmware scaffold uses newline-delimited JSON at 115200 baud (`relay`, `pwm`, `allOff`, `heartbeat`, and `hwtest`). The supplied Pi sketch uses a different legacy text protocol and is not drop-in compatible. The firmware watchdog is intended to switch outputs off at boot and after 2 seconds without messages; the backend-side hybrid serial driver, heartbeat-fault alarm, and final output aliases still require integration. Interlocks must remain in the backend; firmware must not decide whether an operation is safe.

The firmware pin table now records the supplied physical pin values where clear, but leaves chemical-pump roles and Greenova outlet-valve aliases unassigned where the supplied labels do not establish the function. Confirm those assignments from the final circuit and bench-test before connecting real actuators. Run `python -m app.hwtest check` and follow the hardware test instructions with heater/electrode power disconnected.

## MySQL

The database is MySQL 8 (not MariaDB): `backend/greenova_db_ver2.sql`, imported once as it is (see `../database.md`). It creates `greenova_db`, its eight tables and data, and the user `greenova@localhost` the backend logs in with. Startup reads the table definitions of that file and checks the tables and columns without altering anything.

## Verification

From `backend`, run `python -m pytest`. For a demo browser walkthrough, set `GREENOVA_MOCK=1` and `GREENOVA_TIME_SCALE=20`, then check both FFA pathways at 1,500 and 5,000 mL in English and Filipino. The Pi service defaults to this simulation mode and can be used as a live Wi-Fi website demo while hardware connections are finalized. Before changing to real hardware mode, verify the complete pin map, all outputs off on startup and serial disconnect, and every interlock with the heater/electrode power disconnected.
