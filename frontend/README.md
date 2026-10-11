# Greenova Website

This is the Figma Make website, connected to the Greenova FastAPI backend. When the backend can't be reached, the website still works on its own sample data, as before.

## Run it (Windows)

You need **Node.js 22** (from nodejs.org). Start the backend first. See `greenova-backend/README.md`, section 1.

```bat
cd greenova-website
npm install
npm run dev
```

`npm install` is only needed the first time. Then open **http://localhost:8443**.

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
| Process | Batch ID, System Status tiles, live oil mass and temperature, and recommended parameters. The Esterification, Transesterification and Separation buttons control the backend, and the screen shows its live voltage, current, temperature and timer. When separation finishes, the page moves on to Purification and the Pi runs it by itself: heat to 70 °C, hold 25 min, mesh bed flow (batch volume ÷ 40 mL/min), drain. The operator only clicks **Confirm process finished**, and the batch is saved with the values the Pi measured. Without a level switch on the heater, the operator confirms once that the heater is submerged. Without the backend, the same sequence runs as a local demonstration. |
| Batch History | The batches and analytics, from the Pi's records |
| Batch Details | The record and its timeline. Lab results are saved to the Pi. |
| Settings | Saving writes to the Pi. Device Status comes from the Pi. |

The connection code:

- `src/lib/api.ts`: all backend calls, plus the fallback to local data.
- `src/contexts/LiveContext.tsx`: live readings.
- `vite.config.ts`: the `/api` forwarding.

## Put it on the Raspberry Pi

```bat
npm run build
```

Copy the `dist` folder to `greenova-backend/frontend/dist` and restart the backend. The website is then at `http://<pi-address>:8000`.
