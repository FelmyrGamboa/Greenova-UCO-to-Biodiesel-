# Supplied Raspberry Pi / ESP32 wiring map

This records the wiring in the operator-supplied Pi control panel (`app.py`, `config.json`) and ESP32
sketch (`esp32_process_control.ino`), and how the Greenova backend uses it (`[actuators] backend =
"esp32"`, the default; see `RASPBERRY_PI_SETUP.md`). There is no demo mode: the website always drives
this machine. The sketch is in
`firmware/esp32_process_control/`, with one change: `MIN_PWM 90` (was 0), so the mixers turn at low speeds and report the exact RPM they were set to. Greenova replaces the Flask control panel.

## Raspberry Pi (BCM numbering), driven by the Greenova backend

| Device | BCM GPIO | hardware.toml |
|---|---:|---|
| BTS7960 `L_EN` | 23 | `[centrifuge] l_en` |
| BTS7960 `R_EN` | 24 | `[centrifuge] r_en` |
| BTS7960 `LPWM` | 25 | `[centrifuge] lpwm` |
| BTS7960 `RPWM` | 21 | `[centrifuge] rpwm` |
| HX711 `DT` | 17 | `[load_cells.output] data_pin` |
| HX711 `SCK` | 27 | `[load_cells.output] clock_pin` |

Centrifuge: open loop, 0–2500 RPM (`max_rpm`), PWM 1 kHz on RPWM (forward), 3 s soft start and stop,
as in the control panel. Load cell: the control panel's calibration (`offset` 41028.54,
`calibration_factor` 145759) is used as the starting point; that factor is counts per **kg**, so
Greenova's `scale` (counts per gram) is 145.759. Re-calibrate from Settings → Hardware.

The supplied wiring has one HX711. Greenova uses it as the **output** load cell (purification ends on
its stable reading). The reactor load cell is optional (suggested DT GPIO5 / SCK GPIO6) and not
needed: the operator measures the oil and each premix into its container, and the oil pump and the
dispensers run until the operator presses Done.

Open loop: there are no RPM sensors, so the centrifuge and the mixers run at their set speed and the
website shows that speed as the RPM reading (the centrifuge speed is set per batch, at most 2500 RPM).

The FFA colour-sensor strip reader (TCS34725) is not fitted, so it was removed; the FFA test strip
is read by eye and entered on the website. The older all-on-the-Pi defaults (heater relay 23,
electrode relay 25 ...) are used only with `backend = "gpio"`.

## ESP32-WROOM-32 (`esp32_process_control.ino`)

| Relay channel | Device id | ESP32 GPIO | Greenova job (default `[esp32.devices]`) |
|---|---|---:|---|
| IN8 | `dispenser1` | 22 | Pump A: NaOH/KOH + methanol (transesterification dose, until Done) |
| IN7 | `dispenser2` | 21 | Pump B: H₂SO₄ + methanol (esterification dose, until Done) |
| IN6 | `reactorpump` | 19 | Reactor pump (reactor → centrifuge), during separation |
| IN5 | `pumpin` | 18 | Pumpin (centrifuge → purifier), during separation |
| IN4 | `oil` | 25 | Oil pump (Oil Loading, until Done) |
| IN3 | `pumpout` | 26 | Purification outlet, with `valve`: purifier → output container |
| IN2 | `valve` | 27 | Purification outlet: opens after contact and the 1 min settle |
| IN1 | `electrode` | 13 | Electrode power |
| Heater relay | `heater` | 5 | Immersion heater |
| L298N ENB / IN3 / IN4 | `mixer1` | 16 / 23 / 17 | Reactor stirrer |
| L298N ENA / IN1 / IN2 | `mixer2` | 32 / 33 / 14 | Dry wash stirrer |
| DS18B20 | (temperature) | 4 | Temperature (reaction cutoff and purification heater) |

Relays and the heater relay are active-LOW in this sketch (`RELAY_ACTIVE_LOW` / `HEATER_ACTIVE_LOW`
true); every output is off at boot. Mixer speed is in RPM, 0–1544 (`MAX_RPM`), open loop.

Changes from the earlier (Oct 16) pin list: the heater relay moved from GPIO15 to GPIO5, and the
DS18B20 from GPIO5 to GPIO4 (one pin can't do both); the relays are now active-LOW.

## Job mapping

Confirmed by the operator (2026-10-20): `oil` dispenses the oil (automated oil input), `pumpin` pumps
from the centrifuge to the purifier, `pumpout` from the purifier to the output container, and
`valve` opens after purification. `reactorpump` (reactor → centrifuge) and which dispenser holds
which premix are the remaining assumptions: check them with `python -m app.hwtest outputs` (heater
and electrode supply unplugged) and change `[esp32.devices]` in `backend/hardware.toml` if needed.

When each output runs (2026-10-21):
- `oil`, `dispenser1`, `dispenser2`: switched on when their step opens; off when the operator presses
  Done (a 30-minute limit stops a forgotten pump with a fault).
- `reactorpump`, the centrifuge and `pumpin`: together, after transesterification and a 1-minute
  settle in the reactor, for the batch's separation time (Volume & Parameters); all three stop then.
- `heater`: purification methanol removal, in 4-second pulses (the next one when the temperature is getting lower; none from 90 °C).
- `mixer2`: heating, methanol removal, the Magnesol prompt and contact (200 RPM); off for the
  1-minute settle and the drain.
- `valve` + `pumpout`: after the settle, until the output load cell is stable for 30 s.

## Protocol

USB serial, 115200 baud, the sketch's own text commands: `<device> on [seconds]`, `<device> off`,
`mixerN on <seconds> <rpm>`, `alloff`, and `json` (answer: one `STATUS {...}` line with the
temperature and every output). Greenova switches outputs on with a 5 s timer and refreshes it every
second (dead-man), asks for `json` every second, and treats 3.5 s without an answer as a controller
fault that stops every process.
