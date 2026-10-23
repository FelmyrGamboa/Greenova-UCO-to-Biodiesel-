# Supplied Raspberry Pi / ESP32 wiring map

This records the wiring in the operator-supplied Pi control panel (`app.py`, `config.json`) and ESP32
sketch (`esp32_process_control.ino`), and how the Greenova backend uses it (`[actuators] backend =
"esp32"`, the default; see `RASPBERRY_PI_SETUP.md`). There is no demo mode: the website always drives
this machine. The sketch is in
`firmware/esp32_process_control/`: the team's updated sketch (2026-10-23), where every output is a
relay and a 4-channel relay board replaces the L298N. Greenova replaces the Flask control panel.

## Raspberry Pi (BCM numbering), driven by the Greenova backend

| Device | BCM GPIO | hardware.toml |
|---|---:|---|
| BTS7960 `L_EN` | 23 | `[motor_driver] l_en` |
| BTS7960 `R_EN` | 24 | `[motor_driver] r_en` |
| BTS7960 `LPWM` | 25 | `[motor_driver] lpwm` |
| BTS7960 `RPWM` | 21 | `[motor_driver] rpwm` |
| HX711 `DT` | 17 | `[load_cells.output] data_pin` |
| HX711 `SCK` | 27 | `[load_cells.output] clock_pin` |

The one BTS7960 drives mixer 1, mixer 2 and the centrifuge, one at a time: its output goes through
the ESP32's 4-channel relay (`mixer1`, `mixer2`, `centrifuge`) to the motor whose relay is on. Open
loop, PWM 1 kHz on RPWM (forward), straight to the set RPM: duty = the set RPM ÷ that motor's RPM at
100 % PWM (`[motor_driver.max_rpm]`: 1544, 1544, 2500 by default). The relay closes first and the PWM
starts 0.3 s later; the PWM stops before the relay opens.

Load cell: the control panel's calibration (`offset` 41028.54,
`calibration_factor` 145759) is used as the starting point; that factor is counts per **kg**, so
Greenova's `scale` (counts per gram) is 145.759. Re-calibrate from Settings → Hardware.

The supplied wiring has one HX711. Greenova uses it as the **output** load cell (purification ends on
its stable reading). The reactor load cell is optional (suggested DT GPIO5 / SCK GPIO6) and not
needed: the operator measures the oil and each premix into its container, and the oil pump and the
dispensers run until the operator presses Done.

Open loop: there are no RPM sensors, so the centrifuge and the mixers run at their set speed and the
website shows that speed as the RPM reading (the centrifuge speed is set per batch, at most its
`max_rpm`; mixer 1 per stage; mixer 2 always 200 RPM).

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
| IN1 | `electrode` | 32 | Electrode power |
| Heater relay | `heater` | 5 | Immersion heater |
| 4-ch IN1 | `mixer1` | 16 | Connects the Pi's BTS7960 to mixer 1 (reactor stirrer) |
| 4-ch IN2 | `mixer2` | 17 | Connects the BTS7960 to mixer 2 (dry wash stirrer) |
| 4-ch IN3 | `extra` | 13 | Not used |
| 4-ch IN4 | `centrifuge` | 14 | Connects the BTS7960 to the centrifuge |
| DS18B20 | (temperature) | 15 | Temperature (purification heater) |

In this sketch the 8-channel board and the heater relay switch ON with a HIGH input
(`RELAY_ACTIVE_LOW` / `HEATER_ACTIVE_LOW` false) and the 4-channel board with a LOW input
(`RELAY4_ACTIVE_LOW` true); every output is off at boot. Every output is on/off: the ESP32 sets no
speed. (The sketch's `#define` comments say IN3 = centrifuge, IN4 = extra, but its device table puts
`centrifuge` on IN4 / GPIO14: wire the centrifuge to IN4.)

Changes from the earlier pin lists: the L298N was replaced by the 4-channel relay board; `electrode`
moved from GPIO13 to GPIO32 (GPIO13 is now 4-channel IN3); the DS18B20 moved from GPIO4 to GPIO15.

## Job mapping

Confirmed by the operator (2026-10-20): `oil` dispenses the oil (automated oil input), `pumpin` pumps
from the centrifuge to the purifier, `pumpout` from the purifier to the output container, and
`valve` opens after purification. `reactorpump` (reactor → centrifuge) and which dispenser holds
which premix are the remaining assumptions: check them with `python -m app.hwtest outputs` (heater
and electrode supply unplugged) and change `[esp32.devices]` in `backend/hardware.toml` if needed.

When each output runs (2026-10-21):
- `oil`, `dispenser1`, `dispenser2`: switched on when their step opens; off when the operator presses
  Done (a 30-minute limit stops a forgotten pump with a fault).
- `reactorpump`, `centrifuge` (with the BTS7960 at the batch's speed) and `pumpin`: together, after
  transesterification and a 1-minute settle in the reactor, for the batch's separation time (Volume &
  Parameters); all three stop then.
- `mixer1` (with the BTS7960 at the stage's stirring speed): esterification and transesterification.
- `heater`: purification methanol removal, in 4-second pulses (the next one when the temperature is getting lower; none from 90 °C).
- `mixer2` (with the BTS7960 at 200 RPM): methanol removal, the Magnesol prompt and contact; off for
  the 1-minute settle and the drain.
- `valve` + `pumpout`: after the settle, until the output load cell is stable for 30 s.

## Protocol

USB serial, 115200 baud, the sketch's own text commands: `<device> on [seconds]`, `<device> off`,
`alloff`, and `json` (answer: one `STATUS {...}` line with the temperature and every output's `id`,
`label`, `on` and `remaining`). Greenova switches outputs on with a 5 s timer and refreshes it every
second (dead-man), asks for `json` every second, and treats 3.5 s without an answer as a controller
fault that stops every process.
