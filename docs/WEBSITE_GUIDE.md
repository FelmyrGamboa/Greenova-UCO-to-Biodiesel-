# Greenova website guide
## Automatic process handoffs and acetone

There is no drain time. The reactor outlet valve opens when transesterification finishes and separation starts at once; the outlet stays open. When separation finishes, the centrifuge outlet opens after the spin-down safety wait (the outlet must not open while the centrifuge turns), stays open, and purification starts at once. A fitted level switch that reports “not submerged” holds purification heating until the biodiesel covers the heater. The old saved `autoAdvance` value is kept in the database but no longer pauses the sequence, and the old reactor/centrifuge drain-time columns are kept but not used.

Purification: heating to 90 °C (the heater switches off at 90 °C), methanol removal at 90 °C, add the adsorbent when asked, contact (stirred, heater off, the biodiesel cools down), then the motorized polishing-filter outlet (`mesh_bed`) opens right away and sends biodiesel to the output container. There is no settling or cooling step. Purification is complete only when the output load cell reading has been stable for 30 s; then every valve closes and the batch finishes automatically. The stirrer's RPM reading is shown only during contact.

Acetone is optional for each reaction dose. After the dosing pump has finished, the operator may pour the displayed amount (when using acetone) or choose **Continue without acetone**. The reaction starts automatically once the required premix has loaded and acetone has either been added or explicitly skipped. When no reactor load-cell reading is available, acetone does not block the batch.


## Opening the website

The Raspberry Pi serves the website and API on port 8000. From any phone, laptop, or tablet on the same Wi-Fi, open `http://greenova.local:8000` or `http://<pi-address>:8000`. Internet access is not required. The Dashboard should show the local address and QR code when the network helper is available. On the Pi touchscreen, optional kiosk mode opens `http://localhost:8000` full-screen.

## Process workflow

1. **Before You Start:** check PPE, ventilation, reactor condition, both filters, load-cell tare, and temperature-probe availability. The polishing filter housing can be hot.
2. **Volume & Parameters:** choose a whole-number oil volume from 1,500 to 5,000 mL and enter the FFA test-strip result (read by eye) as a whole percent. **Oil Loading** then loads that volume with the oil pump. FFA at or below the configured limit (default 3%) goes straight to transesterification. FFA above the limit is esterified and re-checked after each stage.
3. **Dosing and reaction:** follow the calculated chemistry quantities and machine state. The application stores progress so a running batch can be continued after navigating away or reopening the website.
4. **Separation:** when transesterification finishes, the reactor outlet opens and the centrifuge starts at once. The mixture follows reactor → centrifuge → 5 µm filter → purification tank. Keep hands clear of rotating equipment and never bypass interlocks.
5. **Purification:** heat to 90 °C (heater off there), remove methanol at 90 °C, add adsorbent, mix for the contact time with the heater off, then drain through the 5 µm polishing filter to the output container until the output load cell is stable for 30 s. There is no cooling step, so the biodiesel reaches the filter warm: check the polishing-filter housing's temperature rating.
6. **Complete:** review the batch, timeline, output, warnings, and laboratory result.

## Continue an ongoing batch

The Process page checks `GET /api/batches/active` and restores the `batch_progress` JSON. The live sensor stream is independent; a slow live stream must not prevent the persisted progress from restoring. If a batch remains active, continue that batch or cancel it deliberately before starting another. Do not start a second batch while the machine may still contain chemicals or be running.

## Hardware mode (the real machine)

When the backend runs in hardware mode, the website drives the real machine: the ESP32 controller (relays, heater, mixers, temperature) over USB and the Pi's centrifuge and load cell.

- **Before You Start** shows an **Output Controller** tile: the ESP32 must be online. The motor tiles say "set to … RPM": there are no RPM sensors, so the RPM shown is the speed each motor was set to.
- **Settings → Hardware** shows the ESP32 link (port, temperature), which ESP32 output does each job and whether the ESP32 confirms it, the centrifuge, and the load cells with **Tare** and **Calibrate** (only while no process runs).
- **Oil Loading is automatic** (the oil pump): Volume & Parameters uses the target volume for the quantities; on Oil Loading the operator presses **Start oil pump** and continues once it shows "Oil loaded". Without a reactor load cell (the default wiring has one HX711, under the output container) the oil pump and the dosing pumps load by time at their measured rates. A machine without an oil pump (`oil_pump = ""`) falls back to pouring the target volume and pressing **I poured … mL**.
- If the ESP32 stops answering (cable, power, reset) or an output doesn't follow its command, every process stops, every output switches off (the ESP32 also stops its outputs by itself within 5 s) and an alarm says why. Nothing restarts by itself: fix the cause, then continue from the Process page.

## Settings

- Transesterification FFA limit: whole number 1–3%, default 3%; the same value is saved as the re-check target.
- Target batch volume: 1,500–5,000 mL.
- Purification: methanol removal and contact times. There is no settling or cooling step (the old settling time and maximum drain temperature are kept in the database but not used).
- Separation time limit: 60 minutes by default.
- Energy estimate: existing `heaterPowerWatts`, code default 900 W.

The settings come from the settings row of the MySQL database (`greenova_db_ver2.sql`), used as it is. See `../database.md`.

## Language and appearance

Use the language selector for English or Filipino and the theme selector for light or dark mode. Demo mode and the local browser demo fallback remain available. Whole-number fields reject decimal input where required.

## Troubleshooting

- If the Process page is stuck on its loading message, refresh after confirming the backend is reachable. The page should now restore once the active-batch request settles, independently of live telemetry.
- If the backend cannot connect, check `backend/.env`, then run `python -m app.db` from `backend`.
- If the website loads but sensor values are unavailable, check `GET /api/health`, the live connection, and `backend/hardware.toml`.
- Output Controller "Offline": check the ESP32's USB cable and power, and that no other program (Arduino Serial Monitor, the old `pi-control` panel) has its port open. Settings → Hardware shows the reason and the ESP32's last messages.
- Never test outputs with the heater or electrode supply connected unless the hardware test procedure explicitly calls for it.
