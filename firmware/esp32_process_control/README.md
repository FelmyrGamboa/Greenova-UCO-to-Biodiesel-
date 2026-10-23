# ESP32 process controller

`esp32_process_control.ino` is the team's updated sketch (`esp32_process_controller3.ino`): every
output is a plain relay, on or off. The 4-channel relay board replaces the L298N, so the ESP32 no
longer sets any motor speed. The Greenova backend on the Raspberry Pi talks to it over the USB
cable with the sketch's own serial commands (there is no demo mode).

## Upload

1. Arduino IDE → Board: **ESP32 Dev Module** (ESP32 Arduino core 2.x or 3.x).
2. Library Manager: **OneWire** and **DallasTemperature**.
3. Upload, then plug the ESP32 into a USB port on the Raspberry Pi.
4. On the Pi: `cd backend && .venv/bin/python -m app.hwtest esp32` (Docker: stop the backend first)
   should list every output and the temperature once per second.

Only one program can use the serial port: close the Arduino Serial Monitor and stop the old control
panel (`sudo systemctl disable --now pi-control`; `setup-pi.sh` does it).

## Wiring (ESP32 GPIO numbers)

| Device id | Part | ESP32 pin | Greenova job |
|---|---|---|---|
| `dispenser1` | 8-ch relay IN8 | GPIO22 | Pump A (NaOH/KOH + methanol), until Done |
| `dispenser2` | 8-ch relay IN7 | GPIO21 | Pump B (H₂SO₄ + methanol), until Done |
| `reactorpump` | 8-ch relay IN6 | GPIO19 | Reactor → centrifuge (separation, after a 1 min settle) |
| `pumpin` | 8-ch relay IN5 | GPIO18 | Centrifuge → purifier (separation, with the centrifuge) |
| `oil` | 8-ch relay IN4 | GPIO25 | Oil pump into the reactor, until Done |
| `pumpout` | 8-ch relay IN3 | GPIO26 | Purifier → output container (with `valve`) |
| `valve` | 8-ch relay IN2 | GPIO27 | Opens after contact and a 1 min settle |
| `electrode` | 8-ch relay IN1 | **GPIO32** (moved from 13) | Electrode power |
| `heater` | Heater's own relay | GPIO5 | Immersion heater |
| `mixer1` | 4-ch relay IN1 | GPIO16 | Connects the Pi's BTS7960 to mixer 1 (reactor stirrer) |
| `mixer2` | 4-ch relay IN2 | GPIO17 | Connects the BTS7960 to mixer 2 (dry wash stirrer) |
| `extra` | 4-ch relay IN3 | GPIO13 | Not used by Greenova (switched off by the emergency stop) |
| `centrifuge` | 4-ch relay IN4 | GPIO14 | Connects the BTS7960 to the centrifuge |
| DS18B20 | Temperature (4.7 kΩ pull-up to 3.3 V) | **GPIO15** | Temperature |

Relay polarity in the sketch: the 8-channel board and the heater relay switch ON with a HIGH input
(`RELAY_ACTIVE_LOW false`, `HEATER_ACTIVE_LOW false`), the 4-channel board with a LOW input
(`RELAY4_ACTIVE_LOW true`). If a relay is on when it should be off, flip that board's setting.

Note: the `#define` comments at the top of the sketch say IN3 = Centrifuge and IN4 = Extra, but the
device table (what the sketch actually does) puts `extra` on IN3 (GPIO13) and `centrifuge` on IN4
(GPIO14). Wire the centrifuge to **IN4**, or swap the two pins in the device table.

The Greenova jobs above are the defaults in `backend/hardware.toml` under `[esp32.devices]`. The
BTS7960 motor driver and the HX711 load cell are wired to the Raspberry Pi, not to the ESP32 (see
`docs/RASPBERRY_PI_SETUP.md`).

## The motors: one BTS7960 on the Pi, picked by the 4-channel relay

Mixer 1, mixer 2 and the centrifuge share **one BTS7960** on the Raspberry Pi (L_EN 23, R_EN 24,
LPWM 25, RPWM 21). Its output goes through the 4-channel relay to one motor at a time:

- To start a motor, Greenova switches that motor's relay on (`mixer1 on 5`), waits
  `relay_settle_s` (0.3 s) so the relay closes without current, then the Pi sets the BTS7960's PWM:
  duty = the set RPM ÷ that motor's RPM at 100 % PWM (`[motor_driver.max_rpm]` in `hardware.toml`).
- To stop it, the Pi switches the PWM off first, then the relay opens.
- Only one motor runs at a time: Greenova refuses to start a second one while another runs (the
  process never needs two at once).
- Speeds: mixer 1 = the stage's stirring speed (Volume & Parameters), mixer 2 = always 200 RPM, the
  centrifuge = the batch's separation speed. There is no RPM sensor: the RPM shown is the speed the
  Pi drives the motor at.

## How Greenova uses the ESP32

- **Dead-man timer.** Every output is switched on as `heater on 5` (the sketch's timed ON) and the Pi
  repeats it every second while the output should stay on. If the Pi, the backend or the cable
  stops, the ESP32 switches that output off by itself within 5 s (a motor relay too, which cuts that
  motor's power).
- **Status.** The Pi sends `json` every second; the `STATUS {...}` answer gives the temperature and
  every output's state (`id`, `label`, `on`, `remaining`). No answer for 3.5 s, an output that
  doesn't follow its command, or a device named in `hardware.toml` that the sketch doesn't have,
  stops every process and switches everything off. The website shows why (Output Controller tile,
  Settings → Hardware).
- **Wi-Fi page.** This sketch has a Wi-Fi name and password filled in, so the ESP32 joins that
  network and its own web page (and `/api/set`) can switch any relay without Greenova's safety rules,
  for anyone on that network. Greenova switches its outputs back off within a second when that
  happens. To keep the ESP32 off the network, set `WIFI_SSID` back to `YOUR_WIFI_NAME`. Don't share
  the sketch with the password in it.
