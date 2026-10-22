# ESP32 process controller

`esp32_process_control.ino` is the ESP32 sketch as supplied with the Pi control panel, with one change: `#define MIN_PWM 90` (was 0) and `minPwm` in its STATUS line (see Speeds below).
The Greenova backend on the Raspberry Pi talks to it over the USB cable with the sketch's own serial
commands (there is no demo mode). Greenova replaces the old Flask control panel (`pi-control`).

## Upload

1. Arduino IDE → Board: **ESP32 Dev Module** (ESP32 Arduino core 2.x or 3.x).
2. Library Manager: **OneWire** and **DallasTemperature**.
3. Upload, then plug the ESP32 into a USB port on the Raspberry Pi.
4. On the Pi: `cd backend && .venv/bin/python -m app.hwtest esp32` should list every output and
   the temperature once per second.

Only one program can use the serial port: close the Arduino Serial Monitor and stop the old control
panel (`sudo systemctl disable --now pi-control`; `setup-pi.sh` does it).

## Wiring (ESP32 GPIO numbers)

| Device id | Part | ESP32 pin | Greenova job |
|---|---|---|---|
| `dispenser1` | Relay IN8 | GPIO22 | Pump A (NaOH/KOH + methanol), until Done |
| `dispenser2` | Relay IN7 | GPIO21 | Pump B (H₂SO₄ + methanol), until Done |
| `reactorpump` | Relay IN6 | GPIO19 | Reactor → centrifuge (separation, after a 1 min settle) |
| `pumpin` | Relay IN5 | GPIO18 | Centrifuge → purifier (separation, with the centrifuge) |
| `oil` | Relay IN4 | GPIO25 | Oil pump into the reactor, until Done |
| `pumpout` | Relay IN3 | GPIO26 | Purifier → output container (with `valve`) |
| `valve` | Relay IN2 | GPIO27 | Opens after contact and a 1 min settle |
| `electrode` | Relay IN1 | GPIO13 | Electrode power |
| `heater` | Heater's own relay | GPIO5 | Immersion heater |
| `mixer1` | L298N ENB / IN3 / IN4 | GPIO16 / 23 / 17 | Reactor stirrer |
| `mixer2` | L298N ENA / IN1 / IN2 | GPIO32 / 33 / 14 | Dry wash stirrer |
| DS18B20 | Temperature (4.7 kΩ pull-up to 3.3 V) | GPIO4 | Temperature |

The Greenova jobs above are the defaults in `backend/hardware.toml` under `[esp32.devices]`. The centrifuge (BTS7960) and the HX711 load
cell are wired to the Raspberry Pi, not to the ESP32 (see `docs/RASPBERRY_PI_SETUP.md`).

## How Greenova uses it

- **Dead-man timer.** Every output is switched on as `heater on 5` (the sketch's timed ON) and the Pi
  repeats it every second while the output should stay on. If the Pi, the backend or the cable
  stops, the ESP32 switches that output off by itself within 5 s.
- **Status.** The Pi sends `json` every second; the `STATUS {...}` answer gives the temperature and
  every output's state. No answer for 3.5 s, an output that doesn't follow its command, or a device
  named in `hardware.toml` that the sketch doesn't have, stops every process and switches
  everything off. The website shows why (Output Controller tile, Settings → Hardware).
- **Speeds.** Mixer speeds are sent in the sketch's RPM (0–1544, `MAX_RPM`), always with the RPM
  (`mixer2 on 5 200`), never a bare `mixer2 on` (which would run at full speed). The RPM sent is
  exactly the set speed (mixer 2: 200 RPM; mixer 1: the stage's stirring speed), so the sketch's
  STATUS, its Serial Monitor `status` and its web page show the same RPM as the website. Each start
  begins with about 1 s at full speed (1544) so the motor gets going.
- **One change in the sketch: `#define MIN_PWM 90`** (was 0). The sketch turns RPM into PWM in a
  straight line from MIN_PWM (1 RPM) to 255 (1544 RPM); with 0, 200 RPM was PWM 33 and the mixers
  behind the L298N didn't turn. With 90, 200 RPM is PWM 111 and 700 RPM is PWM 164. STATUS also
  reports `minPwm`. **Upload the sketch again** after updating Greenova. Raise MIN_PWM if a mixer
  hums but doesn't turn at its lowest speed (`python -m app.hwtest mixer purification_stirrer`
  finds the value).
- **Wi-Fi page.** The sketch's own web page (if `WIFI_SSID` is filled in) can switch outputs without
  Greenova's safety rules. Greenova switches its outputs back off within a second when that happens,
  but it is safer to leave `WIFI_SSID` as `YOUR_WIFI_NAME` so the ESP32 never joins the network.
