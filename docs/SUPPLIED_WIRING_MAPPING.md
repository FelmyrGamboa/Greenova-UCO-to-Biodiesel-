# Supplied Raspberry Pi / ESP32 wiring map

This records the wiring in the operator-supplied Pi control panel (`app.py`, `config.json`) and ESP32
sketch (`esp32_process_control.ino`), and how the Greenova backend now uses it in hardware mode
(`[actuators] backend = "esp32"`, see `RASPBERRY_PI_SETUP.md`). The sketch is in
`firmware/esp32_process_control/`, unchanged. Greenova replaces the Flask control panel.

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
its stable reading). The reactor load cell is optional (suggested DT GPIO5 / SCK GPIO6); without it
the oil pump and pumps A and B load by time at their measured flow rates.

The FFA colour-sensor strip reader (TCS34725) is not fitted, so it was removed; the FFA test strip
is read by eye and entered on the website. The older all-on-the-Pi defaults (heater relay 23,
electrode relay 25 ...) are used only with `backend = "gpio"`.

## ESP32-WROOM-32 (`esp32_process_control.ino`)

| Relay channel | Device id | ESP32 GPIO | Greenova job (default `[esp32.devices]`) |
|---|---|---:|---|
| IN8 | `dispenser1` | 22 | Pump A: NaOH/KOH + methanol |
| IN7 | `dispenser2` | 21 | Pump B: H₂SO₄ + methanol |
| IN6 | `reactorpump` | 19 | Reactor outlet (reactor → centrifuge) |
| IN5 | `pumpin` | 18 | Centrifuge outlet (centrifuge → purifier) |
| IN4 | `oil` | 25 | Oil pump (automated oil input into the reactor) |
| IN3 | `pumpout` | 26 | Purification outlet, with `valve`: purifier → output container |
| IN2 | `valve` | 27 | Purification outlet: opens after purification (contact) |
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

`reactorpump` and `pumpin` are pumps that run until the batch is complete (there is no transfer
time), so they run dry once their tank is empty. To stop one after a set time instead, set it under
`[esp32.max_on_seconds]`.

## Protocol

USB serial, 115200 baud, the sketch's own text commands: `<device> on [seconds]`, `<device> off`,
`mixerN on <seconds> <rpm>`, `alloff`, and `json` (answer: one `STATUS {...}` line with the
temperature and every output). Greenova switches outputs on with a 5 s timer and refreshes it every
second (dead-man), asks for `json` every second, and treats 3.5 s without an answer as a controller
fault that stops every process.
