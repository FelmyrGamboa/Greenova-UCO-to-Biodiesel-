# Greenova update: changed files only

Copy these files over your project (same folders). Nothing else needs to change; `node_modules`, `.venv` and `greenova.db` stay as they are. Then restart the backend and the website.

## What changed

1. **After each drain the process goes on by itself.** Reactor outlet closes → separation starts (the Pi starts it); centrifuge outlet closes → purification starts; purification outlet closes → the batch is saved and Process Complete opens. Inputs and hands-on steps (FFA, re-check, oil, acetone, adsorbent) still wait for the operator. Settings → Esterification and Dosing → **After each drain** can switch it off.
2. **Purification adsorbent: Magnesol or bentonite**, chosen per batch in Volume & Parameters. Magnesol 1% of the oil weight (oil mL × 0.0092 g), bentonite 2% (oil mL × 0.0184 g); both doses and the default are in Settings → Purification. The amount shows on every screen, goes into the batch record, and into the cost per liter (new Magnesol price setting).
3. **Centrifuge outlet drain: 2 minutes** (was 3). An existing database with the old 3 min default is updated.
4. **Fixed "Field required" at Purification → Done.** The save always sends complete values, the backend accepts partial purification records, every error now names the field, and if the Pi still refuses, "Finish and keep the record in this browser" lets you finish.
5. **FFA rule: ≤ 1% goes straight to transesterification; above 1% goes to esterification first** (was 4%). Applied to the calculator, texts, translations, analytics ranges, sample batches and the backend.
6. **Whole numbers only** for FFA and every other input (Process page and Settings, enforced by the backend too). Current is now 1–2 A.
7. **Before You Start: the Continue button text is centered** (it was left-aligned on phones).
8. **Raspberry Pi and hardware ready:** all wiring in `backend/hardware.toml`, drivers for HX711 load cells, INA226/INA219 voltage and current, RPM sensors, DS18B20, 3-wire valves, brushless ESCs and USB power supplies, `setup-pi.sh`, and the `python -m app.hwtest` bench test and calibration tool.
9. **Documentation:** `docs/WEBSITE_GUIDE.md` (the whole website) and `docs/RASPBERRY_PI_SETUP.md` (hardware setup).

## Files

New:

- `docs/WEBSITE_GUIDE.md`, `docs/RASPBERRY_PI_SETUP.md`
- `backend/app/drivers.py`, `backend/app/hwtest.py`, `backend/hardware.example.toml`, `backend/setup-pi.sh`
- `backend/tests/test_pi_hardware.py`

Changed:

- Website: `frontend/src/pages/NewBatch.tsx`, `Settings.tsx`, `BatchHistory.tsx`, `BatchDetails.tsx`, `Dashboard.tsx`; `frontend/src/lib/api.ts`, `greenovaData.ts`, `fil.ts`; `frontend/src/index.css`
- Backend: `backend/app/api.py`, `main.py`, `models.py`, `calculations.py`, `purification.py`, `stages.py`, `hardware.py`, `config.py`, `db.py`, `analytics.py`, `seed.py`; `backend/greenova.service`, `backend/requirements-pi.txt`
- Tests: `backend/tests/test_api.py`, `backend/tests/test_core.py` (76 tests, all passing)
- Docs: `README.md`, `frontend/README.md`, `backend/README.md`, `backend/API.md`

## After copying

- Backend: restart it (`python main.py` or `start-backend.bat`). Run `python -m app.seed` once to update the FFA of the sample batches in an existing database.
- Website: `npm run dev` picks up the changes. For the Pi, `npm run build` and copy `frontend/dist`.
- Browser: the sample batches stored by the old version are shown with the new FFA values automatically.
