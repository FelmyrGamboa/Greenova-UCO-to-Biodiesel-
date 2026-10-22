# Greenova website guide

The website controls the real machine through the Raspberry Pi: the ESP32 controller (relays, heater, mixers, temperature) on the Pi's USB port, and the Pi's own centrifuge and output load cell. There is no demo mode and no sample data: everything you see comes from the Pi, and Batch History shows only the batches the machine ran.

## Opening the website

The Raspberry Pi serves the website and API on port 8000. From any phone, laptop, or tablet on the same Wi-Fi, open `http://greenova.local:8000` or `http://<pi-address>:8000`. Internet access is not required. On the Pi touchscreen, optional kiosk mode opens `http://localhost:8000` full-screen. With Docker (`dockerfiles/start-machine.sh`), the website is on port 8443 and opens by itself in the Pi's browser once it answers, and again after every reboot (`bash open-website.sh` opens it by hand).

The **System** badge in the sidebar shows **Connected** or **Pi offline**. While the Pi can't be reached, the Process page says so and nothing can be started; Batch History and the Dashboard are empty until it is back. A batch that is already running carries on on the Pi, and the Process page catches up as soon as the connection returns.

## Process workflow

1. **Before You Start:** the live device tiles from the Pi (the ESP32 must be online), and the safety guidance. Check PPE, ventilation, the filters and the containers. **Start Batch** records the batch as In Progress.
2. **Volume & Parameters:** a whole-number oil volume from 1,500 to 5,000 mL, the FFA test-strip result (whole percent; 3% or below goes straight to transesterification, above 3% is esterified and re-checked), the reaction settings, the dry wash adsorbent, and **5. Separation (centrifuge)**: the separation time (1–180 min) and the centrifuge speed (100–2500 RPM) for this batch. They start from Settings (default separation time and centrifuge speed).
3. **Oil Loading:** measure exactly the target volume of oil into the oil container. The oil pump switches on by itself and empties it into the reactor. Press **Done – the oil container is empty** when it is empty. **Stop pump** stops it (then **Start the oil pump again**). Continue once it shows "Oil loaded".
4. **Esterification / Transesterification:** measure the premix shown (methanol + H₂SO₄ in container B, or NaOH/KOH dissolved in methanol in container A) into its container. The dispenser switches on by itself when the stage opens; press **Done – container B/A is empty** when it is empty. Then the optional acetone: pour it through the inlet and press **Acetone added**, or **Continue without acetone**. Set the electrode power supply (the CC/CV module, by hand) to the voltage and current limit the page shows for this stage (from Volume & Parameters) and press **Supply set to … V**. The reaction then starts by itself. After esterification, enter the FFA re-check.
5. **Separation:** when transesterification finishes, the mixture settles in the reactor for 1 minute (everything off, countdown shown). Then the reactor pump, the centrifuge and pumpin start together and run for the batch's separation time: the biodiesel goes straight on to the purifier while the centrifuge separates the glycerol. The centrifuge RPM shown is its set speed (there is no RPM sensor; it is exact once the 3 s soft start is over). When the time is over, all three stop. Keep hands clear of rotating equipment and never bypass interlocks.
6. **Purification** (starts by itself when separation has finished): methanol removal straight away (stirred at 200 RPM, the heater in 4-second pulses: the next pulse when the temperature is getting lower again, none from 90 °C), **Add X g Magnesol** → **Confirm**, contact at 200 RPM with the heater off, a 1-minute settle (stirrer off), then the valve opens and pumpout sends the biodiesel through the polishing filter to the output container until the output load cell has been stable for 30 s. Then everything switches off and the batch is saved.
7. **Process Complete:** the batch, its separation time and speed, the purification times, the output and yield, and any warning. Record the lab result later in Batch History.

If a stage is stopped (emergency stop, over-current, the ESP32 offline), it shows **Stopped** and a **Start again** button: no controller reset is needed. If separation doesn't start by itself (for example after a stop), the Separation step shows **Start separation now** after a few seconds. If purification was stopped, acknowledge the stop and use **Start purification again**.

## Continue an ongoing batch

The Process page checks `GET /api/batches/active` and restores the saved progress (on the Pi), so a batch can be continued after leaving the page, a reload, or on another device. If a batch remains active, continue that batch or cancel it deliberately before starting another. Do not start a second batch while the machine may still contain chemicals or be running.

## Hardware

- **Before You Start** shows an **Output Controller** tile: the ESP32 must be online. There are no RPM sensors: the mixer RPM shown is the RPM the ESP32 itself reports (exactly the set speed: 200 for mixer 2, the stage's stirring speed for mixer 1, e.g. 500), and the centrifuge RPM is its set speed.
- **Open on phone** (sidebar) shows a QR code of the website on the Raspberry Pi, `http://192.168.254.129:<port>` (`frontend/src/lib/pi.ts`); `npm run dev` prints the same QR code.
- **Settings → Hardware** shows the ESP32 link (port, temperature), which ESP32 output does each job and whether the ESP32 confirms it, the centrifuge, and the load cells (only while no process runs): empty the container, press **1. Tare (empty)**, then put a known weight on, type its grams and press **2. Add weight**; add two or three different weights (for example 200, 500 and 1000 g). **Last calibration** shows each weight's error in grams. While the machine is idle, the zero follows small drifts by itself.
- If the ESP32 stops answering (cable, power, reset) or an output doesn't follow its command, every process stops, every output switches off (the ESP32 also stops its outputs by itself within 5 s) and an alarm says why. Nothing restarts by itself: fix the cause, then continue from the Process page.

## Settings

- Default separation time (1–180 min) and default centrifuge speed (100–2500 RPM): the values a new batch starts with in Volume & Parameters.
- Target batch volume: 1,500–5,000 mL.
- Electricity price (₱/kWh) and heater power (W, from the heater's label): used for the energy and the cost per liter.
- Purification: methanol removal (5–30 min) and contact times, the Magnesol and bentonite doses, and the default adsorbent. Fixed: the 4-second heater pulses, the 95 °C cutoff, the 200 RPM stirrer and the 1-minute settle.

Settings are saved on the Pi (MySQL `greenova_db_ver2.sql`, used as it is); saving needs the Pi to be connected. See `../database.md`.

## Batch History and analytics

- **History:** every batch with its date, oil volume, FFA, yield, energy used (kWh), duration, status and lab result. The energy is computed by the Pi as each part's power × the time it was on (heater, electrodes, mixers, centrifuge, pumps); the batch's timeline shows each part's share.
- **Analytics** follows the statistical treatment of the study: frequencies and percentages (completion rate = completed ÷ finished batches; lab pass rate = Passed ÷ lab-tested batches), and means and ranges (minimum–maximum) of the yield, the energy used and the cost per liter, per FFA range and overall. Cost per liter = (materials used × Settings prices + energy × electricity price) ÷ liters of biodiesel, compared with the target of half the diesel price. **Results per FFA Range** also gives the recommended settings (highest mean yield among Passed batches) and the status: **Proven** when at least 3 lab-tested batches with the same settings all Passed with yields within ±2 percentage points of their mean. Two charts: yield per batch (lab result by color) and FFA vs. yield (association only, not causation).

## Language and appearance

Use the language selector for English or Filipino and the theme selector for light or dark mode. Whole-number fields reject decimal input where required.

## Troubleshooting

- "The Raspberry Pi can't be reached": check that the Pi is on and on the same network, and `sudo systemctl status greenova` on the Pi.
- If the backend cannot connect to MySQL, check `backend/.env`, then run `python -m app.db` from `backend`.
- Output Controller "Offline": check the ESP32's USB cable and power, and that no other program (Arduino Serial Monitor, the old `pi-control` panel) has its port open. Settings → Hardware shows the reason and the ESP32's last messages.
- A pump that runs 30 minutes without Done stops with a fault: check the container and the line, then start it again.
- Never test outputs with the heater or electrode supply connected unless the hardware test procedure explicitly calls for it.
