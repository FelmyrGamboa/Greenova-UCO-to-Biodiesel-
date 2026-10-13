# Greenova website guide

Greenova runs a small electrochemical biodiesel machine that turns used cooking oil (UCO) into biodiesel, and keeps a record of every batch. This guide covers the whole website: how to run it, every page and process step, the rules and calculations behind each number, the settings, where the data lives, and where to change things in the code.

For the Raspberry Pi wiring and hardware setup, see [RASPBERRY_PI_SETUP.md](RASPBERRY_PI_SETUP.md). For every API endpoint, see [backend/API.md](../backend/API.md).

---

## 1. The system in one picture

```
 Browser (laptop, tablet or phone)
   React website  (frontend/)
        │  /api requests + live data every second (/api/ws/live)
        ▼
 FastAPI backend  (backend/)  ── runs on the Raspberry Pi
   stages · pumps · valves · purification · safety watchdog
   calculations · analytics  ◄──►  MySQL database greenova_db
        │                          (MySQL 8 on the laptop or MariaDB on the Pi; database.md)
        ▼
 Machine: reactor (electrodes, stirrer, load cell) → centrifuge → purification tank → output container
```

The website shows data and sends commands; the backend does the work and enforces the safety rules. If the backend can't be reached, the website still works on its own as a **local demo** with sample data, so it can be shown anywhere.

## 2. Running it

### On a laptop (demo, no hardware)

Two windows:

```bat
cd backend
python main.py              :: backend at http://localhost:8000 (simulated machine)
```

```bat
cd frontend
npm install                 :: first time only
npm run dev                 :: website at http://localhost:8443
```

On Windows you can also double-click `backend/start-backend.bat` and `frontend/start-website.bat`. To make the simulated machine faster for a demo, start the backend with `GREENOVA_TIME_SCALE=20`.

### On the Raspberry Pi (real machine)

Follow [RASPBERRY_PI_SETUP.md](RASPBERRY_PI_SETUP.md). The Pi serves the built website itself at `http://<pi-address>:8000`, with no internet needed.

### On a phone

Same Wi-Fi as the computer or the Pi. Scan the QR code that `npm run dev` prints, or click **Open on phone** in the sidebar. With the Pi: open `http://<pi-address>:8000`.

### Which mode am I in? (the System badge, bottom of the sidebar)

| Badge | Meaning |
|---|---|
| **Connected** | Backend on the Pi with the real hardware |
| **Backend · demo** | Backend running with the simulated machine |
| **Local demo** | No backend reachable: the website simulates everything itself and stores data in this browser |

## 3. Pages

### 3.1 Landing page (`/`)

Introduction to Greenova (how it works, features). **Get Started** opens the Dashboard.

### 3.2 Dashboard (`/dashboard`)

The current batch and stage, what the pumps, valves and purification are doing right now, device status, and recent batch performance (total batches, success rate, average yield). **Start New Process** opens the Process page. A red **Safety alarm** banner appears on every page when the backend reports one (e.g. "Heater stopped: temperature exceeded 95 °C"); **Clear** dismisses it.

### 3.3 Process (`/process`): running a batch

The process is a guided sequence. The stepper at the top shows where you are. Esterification appears only when the FFA needs it.

**Before You Start → Volume & Parameters → Oil Loading → (Esterification) → Transesterification → Separation → Purification → Process Complete**

What needs the operator, and what happens by itself:

| Step | Operator | Automatic |
|---|---|---|
| Before You Start | Review the System Status tiles and the safety guidance; **Continue** | The Pi checks every device |
| Volume & Parameters | Target volume, FFA from the test strip, catalyst, methanol ratio, **dry wash adsorbent (Magnesol or bentonite)**, reaction settings | Live oil weight, all chemical amounts, recommended settings from past batches |
| Oil Loading | Pour the oil through the inlet filter; **Continue** once the target is reached (±2%) | Load cell weighs it |
| Esterification (FFA above 1%) | Mix methanol + H₂SO₄ in tank B; pour the acetone when asked; enter the **FFA re-check** after the stage | Pump B loads the dose; the stage starts once the dose and acetone are in; electrodes and stirrer for the set time |
| Transesterification | Mix NaOH/KOH in methanol in tank A; pour the acetone | Pump A loads the dose; the stage starts by itself; then the **reactor outlet drains into the centrifuge (1 min)** |
| Separation | — | **Starts by itself when the reactor outlet closes**; centrifuge 10 min at 2,600 RPM; then the **centrifuge outlet drains into the purification tank (2 min)** |
| Purification | Add the adsorbent when asked and press **Confirm** | Heating, methanol removal, contact, settling, cooling, **draining** through the filter |
| Process Complete | Read the summary | **The batch is saved by itself** when the purification outlet has closed |

After every drain the process goes straight on to the next stage. The only things that wait for the operator are the inputs and the hands-on steps (FFA, re-check, oil, acetone, adsorbent). This can be switched off in Settings (**After each drain → Wait for the operator's Start**).

#### Before You Start

Twelve System Status tiles (power supply, electrodes, the three motors, heater, temperature sensor, reactor load cell, oil input, dosing pumps, outlet valves, output load cell), each Ready / Checking / Fault. Below them, the safety guidance for chemicals (methanol, H₂SO₄, NaOH/KOH, acetone, Magnesol/bentonite dust), electrical and process safety, and emergency response.

#### Volume & Parameters

1. **Oil Input:** the live oil mass from the reactor load cell and the volume (÷ 0.92 g/mL). Target batch volume 100–1,000 mL. In demo mode, **Load demonstration sensor reading** fills it in.
2. **FFA Measurement:** enter the strip result as a **whole percent** (0, 1, 2…). If the strip shows its darkest color, tick the box: the batch is recorded as "≥ 5%". The **pathway decision** follows the rule: **FFA ≤ 1% → straight to transesterification; FFA above 1% → esterification first**.
3. **Chemical Quantity Calculator:** methanol ratio (6–9:1, default 7:1) and catalyst (NaOH or KOH), then the esterification, transesterification and purification amounts (section 5). Choose the **dry wash adsorbent** here: Magnesol (1% of the oil weight) or bentonite (2%).
4. **Reaction Parameters:** voltage, current, reaction time and stirring speed for each stage, pre-filled with the best lab-passed settings for this FFA range (if any).

**Whole numbers only.** Every number the operator types (volume, FFA, re-check FFA, voltage, current, time, stirring, and every value in Settings) must be a whole number. Letters can't be typed; a decimal shows "Use a whole number (no decimals)." and blocks Continue, so 2.5 never silently becomes 25. The backend refuses decimals too.

| Setting | Esterification | Transesterification |
|---|---|---|
| Voltage | 10–30 V (default 20) | 10–30 V (default 30) |
| Current | 1–2 A (default 1) | 1–2 A (default 1) |
| Reaction time | 30–180 min (default 120) | 30–180 min (default 120) |
| Stirring speed | 400–700 RPM (default 500) | 400–700 RPM (default 500) |

#### Oil Loading

Shows the target, the live mass and volume, and the status (Waiting for oil / Oil detected / Target quantity reached). The **Continue to Esterification** or **Continue to Transesterification** button records the oil weight; all later amounts use it.

#### Esterification (only when FFA is above 1%)

The FFA strip can't read above 5%, so **every** batch above 1% gets the same first dose, calculated as if the oil had the design FFA (default 10%). When the stage opens, pump B loads the premix by itself and stops at its weight; the screen then asks for the acetone (pour it **after** the pump has finished, because the pump doses by weight). The stage starts by itself. Live monitoring shows time remaining, voltage, current, stirrer RPM and temperature.

After the stage, test the oil layer with a new strip and enter the **FFA re-check**:

- at or below 1%: **Continue to Transesterification** (the catalyst amount is now exact);
- above 1%: **Prepare esterification stage 2**, dosed for the reading at 40:1 methanol, no new acetone.

#### Transesterification

Pump A loads the NaOH/KOH + methanol premix, the operator pours the acetone, and the stage starts by itself. When it finishes, the reactor outlet valve opens for 1 minute (reactor → centrifuge) and closes, and the page **goes on to Separation by itself**. With a reactor outlet time of 0 in Settings (liquid moved by hand), a **Continue to Separation** button appears instead.

#### Separation

The centrifuge **starts by itself** once the reactor outlet has closed: the Pi starts it, so it happens even if the page is closed. (If the Pi hasn't started it within a few seconds, a Start button appears.) It runs 10 minutes at 2,600 RPM. When it has stopped, the centrifuge outlet opens for **2 minutes** (centrifuge → purification tank), and the page moves on to Purification.

#### Purification (dry wash)

It runs by itself; the operator only adds the adsorbent:

| Step | What happens | Time |
|---|---|---|
| Heating | Stirrer on (200 RPM), heater on, until 90 °C. The page says "Prepare X g Magnesol/Bentonite" | Fault if not reached in 15 min |
| Methanol removal | Hold 90 ±2 °C | Settings, default 10 min |
| Add adsorbent | Heater off, stirrer on. "Add X g Bentonite (2% of the oil weight)" → **Confirm** | Waits for the operator |
| Contact | Stirring, heater off | Settings, default 15 min |
| Settling | Stirrer off | Settings, default 10 min |
| Cooling | Only if needed, until the max drain temperature | Settings, default 50 °C |
| Draining | Outlet open through the filter into the output container | Until the weight is stable ±2 g for 30 s (max 20 min) |
| Done | Valve closed; **the batch is saved and Process Complete opens by itself** | |

Purification starts as soon as the centrifuge outlet has closed and the level switch sees biodiesel covering the heater. Without a level switch, the operator ticks "the heater is fully submerged" and presses **Start purification**. **Stop** ends it safely (heater off, stirrer off, valve closed); a safety stop must be **acknowledged** before starting again.

If the Pi refuses to save the batch, the message names the exact field (for example "purification → heatingTimeSeconds: Field required"), with **Try saving again** and **Finish and keep the record in this browser**, so the operator is never stuck at the end.

#### Process Complete

The summary: batch ID, oil volume and mass, FFA (and each re-check), pathway, durations, chemical totals, separation, purification (adsorbent, amount, 90 °C, step times), biodiesel output and yield (output load cell), average reaction temperature, energy, and any **Low output – check the filter** warning (less than 70% of the oil weight came out). The lab result starts as Pending.

### 3.4 Batch History (`/batches`)

**History tab:** total batches, completion rate, lab pass rate, average yield, and the table of all batches (ID, date, oil volume, FFA, yield, duration, energy, status, lab test).

**Analytics tab:** Yield Comparison, Energy and Processing Time, FFA % vs. Yield and Cost per Liter charts (association only, not causation), and **Best Parameters per FFA Range**. Ranges come from the FFA range boundaries setting (default `0,2,4,5`); with whole-number FFA these are **0–1% (no esterification), 2–3%, 4%, and 5% and above**. Per range: tested batches, lab pass rate, yields, the recommended batch and its settings, and a status:

- **No data**: no lab-tested batch in the range;
- **Testing**: lab results exist, but not yet proven;
- **Proven**: at least *N* batches (default 3) with the same settings, all lab-passed, all within ±2 percentage points of their average yield.

The recommended settings fill in Volume & Parameters for the next batch in that range.

### 3.5 Batch Details (`/batches/<id>`)

The full record: oil, yield, duration, energy, process parameters (starting FFA and each re-check, temperature, reaction time, stirring, current, adsorbent and amount, output), the **lab result** (record Passed/Failed and the lab reference number when the certificate arrives), and the timeline of everything the Pi did (each pump load, valve opening and closing, stage start/stop, "Bentonite added (9.2 g)", …).

### 3.6 Settings (`/settings`)

Saving writes to the Pi (and a copy to this browser); offline, only to this browser. Every number is a whole number.

| Group | Setting | Default | Meaning |
|---|---|---|---|
| General | System name, operator, theme, language, units | — | Theme and language apply at once |
| Analytics | FFA range boundaries | `0,2,4,5` | Range edges for Best Parameters |
| | Batches required for Proven | 3 | |
| | Yield tolerance | ±2 pp | |
| | Prices: oil, methanol, KOH, NaOH, H₂SO₄, acetone, bentonite, **Magnesol**, electricity, diesel | 45 ₱/L, 70 ₱/L, 180 ₱/kg, 160 ₱/kg, 120 ₱/L, 100 ₱/L, 80 ₱/kg, **250 ₱/kg (placeholder)**, 12 ₱/kWh, 55 ₱/L | Cost per liter |
| Process Defaults | Batch naming format | `B-{YEAR}-{SEQ}` | |
| Esterification and Dosing | Design FFA for the dose | 10% | First esterification dose |
| | Strip maximum (darkest color) | 5% | |
| | Pump A / pump B rate | 100 mL/min | Time limit, and dosing by time without a load cell |
| | Reactor outlet open after transesterification | 1 min | 0 = by hand |
| | Centrifuge outlet open after separation | **2 min** | 0 = by hand |
| | Centrifuge spin-down wait | 30 s | Only without an RPM sensor |
| | **After each drain** | Go on by itself | Or wait for the operator's Start |
| Purification | Methanol removal time | 10 min (5–30) | |
| | Contact time | 15 min (1–60) | |
| | Settling time | 10 min (0–60) | |
| | Max drain temperature | 50 °C (30–85) | Water filter limit |
| | **Magnesol dose** | 1% of oil | 1–10% |
| | **Bentonite dose** | 2% of oil | 1–10% |
| | **Default adsorbent** | Magnesol | Pre-selected on new batches |
| Device Status | — | — | Live state of each device from the Pi |
| Data | Export Batch Data | — | Downloads all batches as JSON |

Backend-only values (change them at `http://<backend>:8000/docs` → `PUT /api/settings`): oil density 0.92, biodiesel density 0.88, oil volume 100–1,000 mL, FFA threshold 1%, FFA target 1%, catalyst loading 1%, acetone 10% of oil volume, separation 10 min / 2,600 RPM, reaction maximum temperature 60 °C, motor full-speed RPMs, pump no-flow time 20 s, heater power for the energy figure, oil molar mass 880 g/mol (about 660 for coconut oil), KOH purity 90%, NaOH purity 98%.

## 4. The rules in one place

| Rule | Value | Where it's enforced |
|---|---|---|
| Esterification needed | **FFA above 1%** (FFA ≤ 1% → transesterification directly) | `PROCESS_CONFIG.ffaThreshold` (website), `ffa_threshold` (backend) |
| Operator inputs | **Whole numbers only** | Website fields and Settings save; backend request checks |
| First esterification dose | Design FFA (10%), the same for every oil above 1% | Strip reads only up to 5% |
| Re-check target | ≤ 1% before transesterification | `ffaTarget` |
| After a drain | Next stage starts by itself | Setting **After each drain** (`autoAdvance`) |
| Reactor outlet | 1 min after transesterification | `reactorDrainTime` |
| Centrifuge outlet | **2 min** after separation, once the centrifuge has stopped | `centrifugeDrainTime` |
| Purification hold | 90 ±2 °C, heater cutoff 95 °C, stirrer 200 RPM | fixed, `purification.py` |
| Electrodes | Stop above 60 °C, on lost temperature, or above the current setting for 2 readings | `stages.py` |

## 5. Calculations

All amounts use the oil weight from the reactor load cell. Example: **500 mL of oil = 460 g** (× 0.92 g/mL).

| Quantity | Formula | 500 mL example |
|---|---|---|
| Oil volume | oil g ÷ 0.92 | 500 mL |
| FFA mass (stage 1) | oil g × design FFA (10%) | 46 g |
| Esterification methanol, stage 1 (20:1) | FFA g × 2.84 mL | 130.6 mL |
| Esterification methanol, later stages (40:1) | oil g × re-check % × 5.68 mL | 3% → 78.4 mL |
| Sulfuric acid (98%) | FFA g × 0.027 mL (0.05 g/g) | 1.24 mL (2.3 g) |
| Acetone (provisional) | 10% of the oil volume, stage 1 and transesterification | 50 mL |
| Pump B premix weight | methanol mL × 0.792 + H₂SO₄ g | 105.8 g |
| Transesterification methanol | oil g × ratio × 40.45 ÷ 880 | 7:1 → 148.0 mL |
| Catalyst | (oil g × 1% + oil g × FFA% × 0.142 NaOH / 0.199 KOH) ÷ purity | NaOH, FFA 1% → 5.36 g |
| Pump A premix weight | methanol mL × 0.792 + catalyst g | 122.6 g |
| **Magnesol** | oil mL × 0.92 × 1% = oil mL × 0.0092 | **4.6 g** |
| **Bentonite** | oil mL × 0.92 × 2% = oil mL × 0.0184 | **9.2 g** |
| Biodiesel output | output g ÷ 0.88 | 391 g → 444.3 mL |
| Yield | output mL ÷ oil mL × 100 | 88.9% |
| Cost per liter | Σ(material × price) + energy × electricity price, ÷ liters of biodiesel | Batch History → Analytics |

With esterification, the catalyst shown before the stage is an "up to" amount (neutralizing the 1% target); after the re-check it is exact (neutralizing the measured value). The FFA is treated as oleic acid. Sources and derivations: `Calculations_GREENOVA.md`.

**Adsorbent doses.** Magnesol at 1% of the oil weight was the best dose in Faccini et al. (the Dallas Group patent covers 0.5–4%). Studies of bentonite for dry washing biodiesel range from 1% (10 min contact) to 10 wt% for acid-activated bentonite (20 min at room temperature), so 2% is a starting point: adjust **Bentonite dose** in Settings after your own lab results.

## 6. Safety features

- Heater only with the dry wash stirrer running and the heater covered (level switch), never with the purification outlet open; stops above 95 °C, on lost temperature, or when the stirrer stops turning.
- Electrodes stop above 60 °C (methanol boils at 64.7 °C), on lost temperature, or over the current setting.
- Pumps never run during a stage or with the reactor outlet open; only one pump at a time; a pump stops when nothing arrives for 20 s.
- The centrifuge can't spin with its outlet open, and the outlet can't open while it spins.
- One thing at a time: no stage during purification and no purification during a stage.
- Emergency stop everywhere; everything switches off when the backend starts or stops.

These rules live in `backend/app/hardware.py`, so they apply to every caller, including manual test commands.

## 7. Data

| Where | What |
|---|---|
| MySQL database `greenova_db` (MySQL 8 on the laptop, or MariaDB on the Pi) | Batches in 6 related tables (`production_batches` with its lab results, materials, purification record, timeline and esterification stages) and the settings in the `settings` table. Setup and table guide: [`database.md`](../database.md). The old `backend/greenova.db` (SQLite) is no longer used; `python -m app.migrate_sqlite` copies it into MySQL once |
| Browser localStorage | A copy of the settings, the language and theme, and (in local demo mode only) the batches |
| Settings → Export Batch Data | All batches as `greenova-batches.json` |

The sample batches (B-2026-019 to B-2026-024) are loaded by `python -m app.seed`. They follow the current rules (whole-number FFA; 1% batches without esterification). Running the seed again on an older database updates the sample FFA values.

## 8. Language and theme

**Settings → Language**: English or Filipino (Tagalog); technical words stay in English. All text goes through `t()` with the English text as the key; translations are in `frontend/src/lib/fil.ts`. **Light / Dark** at the bottom of the sidebar or in Settings; colors are CSS variables in `frontend/src/index.css`.

## 9. Code map

| File | What it does |
|---|---|
| `frontend/src/pages/NewBatch.tsx` | The Process page: every step, the calculator, auto-advance, saving the batch |
| `frontend/src/pages/Dashboard.tsx`, `BatchHistory.tsx`, `BatchDetails.tsx`, `Settings.tsx` | The other pages |
| `frontend/src/lib/api.ts` | Every backend call, with the local fallback |
| `frontend/src/lib/greenovaData.ts` | Sample batches and local (offline) storage |
| `frontend/src/lib/i18n.tsx`, `fil.ts` | Language switching and the Filipino text |
| `frontend/src/contexts/LiveContext.tsx` | Live data from the backend |
| `backend/app/api.py` | All endpoints, the batch sequence (drains, auto-start), saving batches |
| `backend/app/calculations.py` | Chemical amounts (same formulas as the website) |
| `backend/app/stages.py`, `transfers.py`, `purification.py` | Reaction/separation stages, pumps and valves, the dry wash |
| `backend/app/models.py` | Settings and batch fields with defaults and limits |
| `backend/app/hardware.py`, `drivers.py`, `hwtest.py` | Interlocks, simulated and real hardware, bench tests |
| `backend/hardware.toml` | The Pi's wiring (pins, sensors, calibration) |
| `backend/tests/` | Automated tests: `python -m pytest` in `backend` |

### Where to change common things

| To change | Edit |
|---|---|
| The FFA threshold (1%) | `ffaThreshold` in `NewBatch.tsx` `PROCESS_CONFIG` and `ffa_threshold` in `backend/app/models.py` |
| Adsorbent doses | Settings → Purification (no code change) |
| Drain times, auto-advance | Settings → Esterification and Dosing |
| Stage limits (voltage, time, stirring, current) | `PROCESS_CONFIG` in `NewBatch.tsx` and `_esterification_limits` / `_transesterification_limits` in `models.py` |
| A text or translation | The `t("…")` text in the page, and the same key in `fil.ts` |
| Pins and sensors | `backend/hardware.toml` |

## 10. Troubleshooting

| Problem | Fix |
|---|---|
| Badge says Local demo while the backend runs | Start the backend first, then reload; with the Pi, `set GREENOVA_API=http://<pi>:8000` before `npm run dev` |
| "Use a whole number (no decimals)" | Type 3, not 3.5 (all inputs are whole numbers) |
| "Field required" or another validation message | It now names the field. Check that the website and backend are the same version |
| Separation didn't start by itself | Check Settings → After each drain; with a reactor outlet time of 0, use Continue/Start |
| Purification waits forever | No level switch: tick "the heater is fully submerged" and press Start purification |
| Phone can't open the site | Same Wi-Fi; run `frontend/check-phone-access.bat` on Windows |

## 11. What changed in this version

- **FFA rule:** ≤ 1% goes straight to transesterification; above 1% is esterified first (was 4%). Sample batches, texts and translations follow it.
- **Whole numbers only** for FFA and every other input, on the website and in the backend. Current is now 1–2 A.
- **Goes on by itself after each drain:** reactor drain → separation starts; centrifuge drain → purification starts; purification drain → the batch is saved and Process Complete opens.
- **Bentonite or Magnesol** for the dry wash, with doses in Settings, the amount on every screen, in the record and in the cost per liter.
- **Centrifuge outlet 2 minutes** (was 3); existing databases with the old default are updated.
- **Fixed:** the batch save at the end of purification could stop with "Field required". The save now always sends complete values, the backend accepts partial purification records, errors name the field, and the operator can always finish.
- **Before You Start:** the Continue button text is centered (on phones it was left-aligned).
- **Raspberry Pi ready:** `hardware.toml`, drivers for HX711, INA226/INA219, RPM sensors, DS18B20, 3-wire valves, ESCs and serial power supplies, `setup-pi.sh`, and the `hwtest` tool.
