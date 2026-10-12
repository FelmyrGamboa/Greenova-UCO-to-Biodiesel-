# Greenova Website

This is the Figma Make website, connected to the Greenova FastAPI backend. When the backend can't be reached, the website still works on its own sample data, as before.

## Run it (Windows)

You need **Node.js 22** (from nodejs.org). Start the backend first. See `backend/README.md`, section 1.

Double-click `start-website.bat`, or in Command Prompt:

```bat
cd frontend
npm install
npm run dev
```

`npm install` is only needed the first time. Then open **http://localhost:8443**.

## Open it on your phone

The phone and this computer must be on the same Wi-Fi.

1. Start the backend (`python main.py`) and the website (`npm run dev`).
2. Scan the QR code that `npm run dev` prints in its window. You can also click **Open on phone** at the bottom of the sidebar, which shows the same QR code.
3. The address looks like `http://192.168.1.23:8443`. Your computer's number will be different.

If the phone can't open it, double-click **`check-phone-access.bat`** in the frontend folder while `npm run dev` is running. It checks the website, the network type and the firewall, says what's wrong, and offers to fix it. Windows asks for administrator permission before it changes anything. The usual causes are:

- **Windows Firewall:** the first time, Windows asks whether Node.js may use the network. Allow it on **Private networks**. Your Wi-Fi must be set to Private: Settings → Network & internet → Wi-Fi → your network → **Private network**.
- **School or public Wi-Fi** often blocks devices from reaching each other. Turn on your phone's hotspot, connect the computer to it, run `npm run dev` again, and scan the new QR code.

The phone talks only to the website on the computer, and the website forwards everything to the backend, so only port 8443 has to be reachable.

## Language

**Settings → Language**: English or Filipino (Tagalog). The page changes right away and the choice is remembered in the browser. Technical words stay in English (biodiesel, Magnesol, FFA, RPM, valve, pump, heater, stirrer, the chemical names and the stage names).

All text goes through `t()` from `src/lib/i18n.tsx`, with the English text as the key: `t("Start purification")`, or `t("Add {grams} g Magnesol", { grams: 4.6 })`. The Filipino text is in `src/lib/fil.ts`. To add or fix a translation, edit that file. Messages from the backend that contain numbers (alarms, fault reasons, timeline entries) are matched by the patterns at the end of `fil.ts`. Text without a translation shows in English, so nothing goes blank.

## Light and dark mode

Switch with the Light / Dark buttons at the bottom of the sidebar, or in **Settings → Interface theme**. The choice is remembered in the browser. All colors are CSS variables in `src/index.css` (one block for dark, one for light), so a color changes everywhere when you edit it there. The landing page always stays dark.

The dev server forwards every `/api` request to the backend at `http://localhost:8000`. To use a backend on the Raspberry Pi instead, run this before `npm run dev`:

```bat
set GREENOVA_API=http://192.168.1.50:8000
```

## What the System badge means

The badge is at the bottom of the sidebar.

| Badge | Meaning |
|---|---|
| **Backend · demo** | The backend is running in demo mode, so the machine is simulated |
| **Connected** | The backend is running on the Pi with the real hardware |
| **Local demo** | The backend isn't reachable, so the website uses its own sample data |

## What is connected

| Page | From the backend |
|---|---|
| All pages | Settings are loaded at startup. Live readings come once per second over `/api/ws/live`. A red banner shows safety alarms. |
| Dashboard | The batches, the current batch and stage, and the device status |
| Process | Batch ID, System Status tiles (with Ready / Not ready for the reactor stirrer, centrifuge motor, purification stirrer and heater), the live reactor load cell and temperature, and recommended parameters. **FFA:** tick "The strip shows its darkest color" when it reads 5% or more; the batch is recorded as "≥ 5%". Every batch above 4% gets the same esterification dose (calculated for 10% FFA). The calculator also shows **Magnesol (dry wash)** = oil volume × 0.0092 g. Each reaction stage has a **current setting** (default 1 A, 0.5–2 A); when the Pi can't set the power supply, the screen says "Set the power supply current to 1 A". **Oil Loading** has one button, "Continue to Esterification" or "Continue to Transesterification". **When a reaction stage opens**, its pump loads the dose by itself (pump B: H₂SO₄ + methanol; pump A: NaOH/KOH + methanol), then the screen asks for the acetone, and the stage starts by itself once both are in. If the pump faults: "Pump problem – check the line" and **Retry**. Live monitoring shows only time remaining, voltage, current, stirrer RPM and temperature. **After esterification**, the operator enters the FFA re-check: at or below 1%, transesterification uses the exact catalyst amount; above it, another stage is dosed for the reading. After transesterification the reactor outlet opens by itself for 1 minute and closes; only then does **Continue to Separation** appear. After separation the centrifuge outlet opens once the centrifuge has stopped. The valves show only Open / Closed. Then the Pi runs **purification** by itself: heating to 90 °C ("Prepare X g Magnesol"), methanol removal (10 min at 90 ±2 °C), **Add X g Magnesol** with a Confirm button, contact (15 min), settling (10 min), cooling to 50 °C if needed, and draining through the filter into the container on the output load cell (the collected weight shows only while draining). The operator clicks **Confirm process finished**, and the batch is saved with the values the Pi measured, the FFA re-checks and the yield. Without a level switch on the heater, the operator confirms once that the heater is submerged. Without the backend, the same sequence runs as a local demonstration (pumps and timers simulated, with "Skip (demo)" buttons). |
| Batch History | The batches and analytics, from the Pi's records |
| Batch Details | The record and its timeline. Lab results are saved to the Pi. |
| Settings | Saving writes to the Pi. Device Status comes from the Pi. Purification has only Methanol removal time, Contact time, Settling time and Max drain temperature; the rest is fixed. |

The connection code:

- `src/lib/api.ts`: all backend calls, plus the fallback to local data.
- `src/contexts/LiveContext.tsx`: live readings.
- `vite.config.ts`: the `/api` forwarding.

## Put it on the Raspberry Pi

```bat
npm run build
```

Restart the backend: it serves the new `dist` folder by itself. The website is then at `http://<pi-address>:8000`.
