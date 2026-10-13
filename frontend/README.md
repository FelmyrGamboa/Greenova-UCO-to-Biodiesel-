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
| Process | Batch ID, System Status tiles, the live reactor load cell and temperature, and recommended parameters. **Whole numbers only** for every input (FFA, volume, voltage, current 1–2 A, time, stirring). **FFA ≤ 1%** goes straight to transesterification; above 1% gets the uniform esterification dose (for 10% FFA) and an FFA re-check. The calculator shows the **dry wash adsorbent**, Magnesol (oil volume × 0.0092 g) or bentonite (× 0.0184 g), chosen per batch. Each reaction stage's pump loads its dose by itself and the stage starts once the dose and acetone are in. **After each drain the process goes on by itself:** the reactor outlet closes → the Pi starts the separation; the centrifuge outlet (2 min) closes → purification starts; the purification outlet closes → the batch is saved and Process Complete opens. The operator only adds the adsorbent when asked. Without the backend, the same sequence runs as a local demonstration. Full description: `docs/WEBSITE_GUIDE.md`. |
| Batch History | The batches and analytics, from the Pi's records |
| Batch Details | The record and its timeline. Lab results are saved to the Pi. |
| Settings | Saving writes to the Pi (whole numbers only). Device Status comes from the Pi. Purification: methanol removal, contact and settling times, max drain temperature, Magnesol and bentonite doses, default adsorbent. Esterification and Dosing: drain times (centrifuge 2 min) and **After each drain** (go on by itself, or wait for Start). |

The connection code:

- `src/lib/api.ts`: all backend calls, plus the fallback to local data.
- `src/contexts/LiveContext.tsx`: live readings.
- `vite.config.ts`: the `/api` forwarding.

## Put it on the Raspberry Pi

```bat
npm run build
```

Restart the backend: it serves the new `dist` folder by itself. The website is then at `http://<pi-address>:8000`.
