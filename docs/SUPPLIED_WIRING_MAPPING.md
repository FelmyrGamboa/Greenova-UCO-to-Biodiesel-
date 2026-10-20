# Supplied Raspberry Pi / ESP32 wiring map

This note records the GPIO assignments in the operator-supplied Raspberry Pi and ESP32 sketches. It does **not** mean the current Greenova backend is already driving these pins: the present `PiHardware` implementation still drives most process outputs directly from Pi GPIO, while the `[actuators].backend = "esp32"` configuration is not yet connected to a hybrid ESP32/Pi driver. Keep `GREENOVA_MOCK=1` until the controller mapping and interlocks have been integrated and bench-tested.

## Raspberry Pi (BCM numbering)

| Device | BCM GPIO |
|---|---:|
| BTS7960 `L_EN` | 23 |
| BTS7960 `R_EN` | 24 |
| BTS7960 `LPWM` | 25 |
| BTS7960 `RPWM` | 21 |
| HX711 `DT` | 17 |
| HX711 `SCK` | 27 |

The supplied Pi sketch controls the centrifuge locally through the BTS7960 and reads one HX711 load cell. The Greenova backend currently expects both reactor and output-container load cells; no second HX711 pin assignment was included in the supplied sketch.

### Pi GPIO conflicts that must be resolved

- The supplied HX711 `DT=17` conflicts with `backend/app/strip_reader.py`'s `LED_PIN = 17` for the strip reader.
- The supplied BTS7960 pins 23, 24 and 25 conflict with the current `hardware.example.toml` defaults for heater relay, purification outlet valve and electrode relay. GPIO21 is also a default optional RPM input.
- Because of these conflicts, do not simply copy the supplied Pi pin numbers into `hardware.toml` while using the current direct-GPIO output driver. The code needs the intended hybrid driver (ESP32 process outputs, Pi centrifuge/HX711) and conflict-free pin assignments first.

## ESP32-WROOM-32

### 8-channel relay module (from the supplied sketch)

| Relay channel | Sketch device name | ESP32 GPIO |
|---|---|---:|
| IN8 | `dispenser1` | 22 |
| IN7 | `dispenser2` | 21 |
| IN6 | `reactorpump` | 19 |
| IN5 | `pumpin` | 18 |
| IN4 | `oil` | 25 |
| IN3 | `pumpout` | 26 |
| IN2 | `valve` | 27 |
| IN1 | `electrode` | 13 |

### Other ESP32 connections

| Device | Pins |
|---|---|
| Separate heater relay input | GPIO15 |
| DS18B20 data | GPIO5 (4.7 kΩ pull-up to 3.3 V is required) |
| L298N Mixer 1 | `IN3=23`, `IN4=17`, `ENB=16` |
| L298N Mixer 2 | `IN1=33`, `IN2=14`, `ENA=32` |

The supplied sketch says relay inputs and the heater relay are active-HIGH (`RELAY_ACTIVE_LOW=false`, `HEATER_ACTIVE_LOW=false`). Verify this with the heater and electrode power physically disconnected before changing relay polarity.

## Greenova role mapping still needed before live use

The supplied ESP32 sketch names **one** generic `valve` output on GPIO27, but Greenova's automatic process requires independently controlled reactor outlet, centrifuge outlet and purification outlet valves. It also names six pump/dispenser relay outputs, whose chemical/process roles do not map unambiguously to Greenova's two dosing pumps. Do not guess those assignments. Confirm which physical relay channel drives each Greenova function, including whether each valve is a single relay/solenoid or a motorized open/close actuator.

The supplied pinout also places the centrifuge motor on the Pi while the earlier Greenova firmware scaffold was written for ESP32 motor control. The firmware/backend protocol and watchdog must be aligned with the chosen split-controller architecture before real outputs are enabled.
