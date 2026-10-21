# Greenova Website

This is the Figma Make website for the Greenova machine. It always works with the Greenova backend on the Raspberry Pi that drives the machine (the ESP32 controller and the Pi's centrifuge and load cell). There is no demo mode and no sample data: when the Pi can't be reached, the website says so.

On the machine you don't run this folder at all: build it once (`npm run build`) and the backend on the Pi serves `dist` at `http://<pi-address>:8000` (section "Put it on the Raspberry Pi"). The steps below are for changing the website on a laptop.

## Run it (Windows)

You need **Node.js 22** (from nodejs.org) and the Raspberry Pi running the backend on the same network. Point the website at the Pi, then start it (Command Prompt):

```bat
cd frontend
set GREENOVA_API=http://192.168.1.50:8000
npm install
npm run dev
```

(Use the Pi's address; in PowerShell: `$env:GREENOVA_API="http://192.168.1.50:8000"`.) `start-website.bat` does the same once `GREENOVA_API` is set.

`npm install` is only needed the first time. Then open **http://localhost:8443**.

## Open it on your phone

The phone and this computer must be on the same Wi-Fi.

1. Start the website (`npm run dev`, with `GREENOVA_API` pointing at the Pi).
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

The dev server forwards every `/api` request to `GREENOVA_API` (default `http://localhost:8000`, i.e. when you run `npm run dev` on the Pi itself).

## What the System badge means

The badge is at the bottom of the sidebar.

| Badge | Meaning |
|---|---|
| **Connected** | The Raspberry Pi answers: the website drives the real machine |
| **Connecting…** | The page has just opened |
| **Pi offline** | The Pi can't be reached: the Process page says so and nothing can be started (a running batch carries on on the Pi) |

## What is connected

| Page | From the backend |
|---|---|
| All pages | Settings are loaded at startup. Live readings come once per second over `/api/ws/live`. A red banner shows safety alarms. |
| Dashboard | The batches, the current batch and stage, and the device status |
| Process | Batch ID, System Status tiles, live readings and recommended parameters. **Whole numbers only** for every input. **FFA ≤ 3%** goes straight to transesterification; above 3% gets the uniform first esterification dose and an FFA re-check. Volume & Parameters also sets the batch's **separation time and centrifuge speed**. The **oil pump and the dispensers** switch on by themselves on their step and run until the operator presses **Done** (the container, filled with the computed amount, is empty); then the optional acetone (**Acetone added** / **Continue without acetone**) and the reaction starts by itself. After transesterification: 1 min settle, then the reactor pump, the centrifuge and pumpin together for the separation time; then purification by itself (methanol removal with 2 s heater pulses, Magnesol, contact, 1 min settle, valve + pumpout until the output is stable for 30 s). Full description: `docs/WEBSITE_GUIDE.md`. |
| Batch History | The batches and analytics, from the Pi's records |
| Batch Details | The record and its timeline. Lab results are saved to the Pi. |
| Settings | Saving writes to the Pi (whole numbers only; not possible while it is offline). Device Status and Hardware come from the Pi. Default separation time and centrifuge speed; purification times, doses and default adsorbent. |

The connection code:

- `src/lib/api.ts`: all backend calls (no local fallback).
- `src/contexts/LiveContext.tsx`: live readings.
- `vite.config.ts`: the `/api` forwarding.

## Put it on the Raspberry Pi

```bat
npm run build
```

Restart the backend: it serves the new `dist` folder by itself. The website is then at `http://<pi-address>:8000`.
