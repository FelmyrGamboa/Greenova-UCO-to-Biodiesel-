# Greenova on the Raspberry Pi: hardware integration guide

This guide takes the Greenova system from "runs on my laptop in demo mode" to "runs the real machine on a Raspberry Pi". It says what to buy, how to wire it, which file to change, and how to test every part before the first batch.

**The short version:**

1. Wire the parts (section 3).
2. On the Pi: `bash setup-pi.sh` (section 5).
3. Describe your wiring in **`backend/hardware.toml`**. It is the only file you edit for pins, sensors and calibration (section 6).
4. Test with `python -m app.hwtest` (check → read → outputs → calibrate).
5. `sudo systemctl enable --now greenova`, then open `http://<pi-address>:8000`.

> **Safety first.** This machine combines methanol (flammable, toxic), sulfuric acid, caustic catalysts, a 90 °C heater and mains power. Software interlocks are a second line of defence, never the only one. Keep the thermal fuse, use a contactor/SSR rated for the heater, and never leave a batch unattended. Test every output with the heater and the power supply unplugged first.

---

## 1. How the pieces fit together

```
            Phone / laptop browser  (http://<pi-address>:8000)
                          │  Wi-Fi
┌─────────────────────────┴──────────────────────────────────────┐
│ Raspberry Pi 4 / Pi 5 (Raspberry Pi OS Bookworm)                 │
│   greenova service = FastAPI backend + the built website         │
│   • runs every stage, the safety interlocks and the watchdog     │
│   • stores batches and settings in backend/greenova.db           │
└──┬──────────────┬───────────────┬──────────────┬────────────────┘
   │ GPIO (relays)│ GPIO (PWM)    │ GPIO (inputs)│ I2C / 1-Wire / USB
   ▼              ▼               ▼              ▼
 heater SSR     reactor stirrer  HX711 ×2       INA226 (electrode V, A)
 electrode relay centrifuge      RPM sensors ×3 DS18B20 temperature
 pump A, pump B  dry wash stirrer level switch  TCS34725 strip reader
 3 outlet valves                               power supply (USB, optional)
```

The website never switches anything directly: it sends commands to the backend, and the backend checks the interlocks first. Closing the browser never leaves the heater, electrodes, pumps or valves on, because the sequences run on the Pi.

## 2. Parts list

| Part | Recommended | Connects to | Notes |
|---|---|---|---|
| Controller | Raspberry Pi 4 (2 GB+) or Pi 5, 32 GB SD card, official PSU | — | Raspberry Pi OS **Bookworm** (64-bit). Python 3.11 is included. |
| Relay board | 8-channel opto-isolated 5 V relay module | GPIO (heater, electrodes, pumps, valves) | Note whether it is "low level trigger" (active low): set `relays.active_high = false` then. |
| Heater switching | SSR or contactor rated for the heater (e.g. 25 A SSR with heatsink), plus the **thermal fuse** in series | heater relay output | The Pi's relay drives the SSR/contactor, never the heater current directly. |
| Electrode power | 0–30 V DC bench supply with current limit | electrode relay (or its USB port) | Manual knobs work (the website reminds you of the current). USB/serial control is optional (section 6.10). |
| Dosing pumps A and B | 12 V peristaltic pumps + relay or logic-level MOSFET module | `pumps.catalyst`, `pumps.acid` | Chemical-resistant tubing (Viton/PTFE for methanol). |
| Outlet valves ×3 | 12 V motorized ball valves (2-wire spring return, or 3-wire CR03) or NC solenoid valves | `valves.*` | 3-wire valves need two relays each (`mode = "dual"`). |
| Motors ×3 | DC motors + motor driver/MOSFET PWM board, or brushless + ESC | `motors.*` PWM pins | Reactor stirrer, centrifuge, dry wash stirrer. |
| Load cells ×2 | Load cell (1–5 kg) + **HX711** board each | `load_cells.reactor`, `load_cells.output` | Power the HX711 from **3.3 V**. |
| Temperature | Waterproof **DS18B20** probe + 4.7 kΩ resistor | GPIO4 (1-Wire) | Stainless probe in the purification tank. |
| Electrode voltage/current | **INA226** board with a **0.02 Ω** shunt | I2C (GPIO2/3), address 0x40 | INA219 works only up to 26 V. Many INA226 boards ship with 0.1 Ω (0.8 A max): replace the shunt for 2 A. |
| RPM sensors ×3 | Hall sensor (A3144/KY-003) + magnet on the shaft, or IR slot sensor | `rpm.*` | Needed for the Ready tiles of the three motors. |
| Level switch | Float switch at the heater's height in the purification tank | `level_switch.pin` | Optional, recommended: purification then starts by itself and the heater stops if the level drops. |
| FFA strip reader | TCS34725 color sensor board | I2C + GPIO17 (LED) | Already supported by `app/strip_reader.py`. |

## 3. Wiring

### 3.1 Default pins

All numbers in `hardware.toml` are **BCM GPIO numbers**, not header pin numbers. Run `pinout` on the Pi to see the header. These are the defaults; change any of them in `hardware.toml`.

| BCM | Header pin | Device | `hardware.toml` key | Type |
|---|---|---|---|---|
| GPIO23 | 16 | Heater relay (→ SSR/contactor) | `relays.heater` | output |
| GPIO25 | 22 | Electrode power relay | `relays.electrode_power` | output |
| GPIO5 | 29 | Pump A (NaOH/KOH + methanol) | `pumps.catalyst` | output |
| GPIO6 | 31 | Pump B (H₂SO₄ + methanol) | `pumps.acid` | output |
| GPIO16 | 36 | Reactor outlet valve | `valves.reactor_outlet` | output |
| GPIO20 | 38 | Centrifuge outlet valve | `valves.centrifuge_outlet` | output |
| GPIO24 | 18 | Purification outlet valve | `valves.purification_outlet` | output |
| GPIO18 | 12 | Reactor stirrer PWM | `motors.stirrer` | PWM |
| GPIO13 | 33 | Centrifuge PWM / ESC | `motors.centrifuge` | PWM |
| GPIO12 | 32 | Dry wash stirrer PWM | `motors.purification_stirrer` | PWM |
| GPIO27 | 13 | HX711 reactor DT | `load_cells.reactor.data_pin` | input |
| GPIO22 | 15 | HX711 reactor SCK | `load_cells.reactor.clock_pin` | output |
| GPIO10 | 19 | HX711 output DT | `load_cells.output.data_pin` | input |
| GPIO9 | 21 | HX711 output SCK | `load_cells.output.clock_pin` | output |
| GPIO21 | 40 | Reactor stirrer RPM | `rpm.stirrer.pin` | input |
| GPIO19 | 35 | Centrifuge RPM | `rpm.centrifuge.pin` | input |
| GPIO7 | 26 | Dry wash stirrer RPM | `rpm.purification_stirrer.pin` | input |
| GPIO26 | 37 | Level switch (to GND) | `level_switch.pin` | input |
| GPIO4 | 7 | DS18B20 data (1-Wire) | fixed | 1-Wire |
| GPIO2 / GPIO3 | 3 / 5 | I2C SDA / SCL (INA226, TCS34725) | fixed | I2C |
| GPIO17 | 11 | Strip reader LED | fixed (`strip_reader.py`) | output |

Power pins: 3.3 V on pins 1 and 17, 5 V on pins 2 and 4, GND on pins 6, 9, 14, 20, 25, 30, 34, 39.

`python -m app.hwtest check` refuses a configuration where two parts share a pin or a part uses a reserved pin.

### 3.2 How each part is wired

- **Relay board:** VCC → 5 V, GND → GND, IN1…IN8 → the output pins above. If the board has a JD-VCC jumper, power the relay coils from a separate 5 V supply for isolation. Relay contacts switch the 12 V pumps/valves or the SSR input, never anything directly from the Pi.
- **Pumps and valves on 12 V:** a flyback diode across each DC motor/solenoid (1N4007, stripe to +) if your relay/MOSFET board doesn't have one.
- **Heater:** relay → SSR/contactor control input; SSR/contactor → heater, in series with the **thermal fuse**. Use the right wire gauge and an RCD/GFCI on the mains side.
- **Motors (PWM):** Pi PWM pin → motor driver PWM/IN input. Motor driver powered from its own supply; **connect its GND to the Pi's GND**.
- **Brushless centrifuge with an ESC:** ESC signal → PWM pin, ESC ground → Pi GND, set `type = "esc"`. Do not connect the ESC's 5 V (BEC) wire to the Pi's 5 V. Arm and test without the rotor.
- **HX711:** VCC → **3.3 V** (not 5 V: the Pi's pins are 3.3 V), GND → GND, DT → data pin, SCK → clock pin. Load cell: red E+, black E−, white A−, green A+ (colors vary; if the reading goes down when you add weight, a negative `scale` fixes it).
- **DS18B20:** red → 3.3 V, black → GND, yellow → GPIO4, with a **4.7 kΩ resistor between yellow and 3.3 V**.
- **INA226:** VCC → 3.3 V, GND → GND, SDA → GPIO2, SCL → GPIO3. Put the shunt in series with the electrode **positive** line (VIN+ toward the supply, VIN− toward the electrodes), and connect the INA226's VBUS to the supply's positive side so it reads the voltage.
- **RPM sensor (hall, 3-wire):** VCC → 3.3 V, GND → GND, OUT → the RPM pin (the Pi's pull-up is used). Glue one magnet per `pulses_per_rev` on the shaft or pulley.
- **Level switch:** between the level pin and GND. Closed = biodiesel covers the heater (`closed_means_liquid = true`). If yours opens when it floats up, set it to `false`.
- **Power supply over USB (optional):** USB cable to the Pi; it usually appears as `/dev/ttyUSB0` or `/dev/ttyACM0` (`ls /dev/tty*` before and after plugging it in).

## 4. What runs where (the software side)

| File | What it does | Edit it? |
|---|---|---|
| `backend/hardware.toml` | **Your wiring**: pins, relay type, valve and motor types, which sensors are fitted, calibration | **Yes** |
| `backend/hardware.example.toml` | Commented template with the defaults | No (copy it) |
| `backend/setup-pi.sh` | One-time setup on the Pi | No |
| `backend/greenova.service` | Service template (setup-pi.sh fills in the user and folder) | Rarely |
| `backend/app/hwtest.py` | Bench test and calibration tool | No |
| `backend/app/drivers.py` | HX711, INA226/INA219, RPM counter, DS18B20, serial power supply | Only for a sensor that isn't supported |
| `backend/app/hardware.py` | Safety interlocks, the simulated machine, and `PiHardware` (reads `hardware.toml`) | Only for a sensor that isn't supported |
| `backend/app/config.py` | Demo/hardware mode, database path, the hardware.toml loader and pin checks | No |
| `backend/app/strip_reader.py` | FFA strip reader | Wait time/gain only |

## 5. Step-by-step setup

### 5.1 Prepare the Pi

1. Flash **Raspberry Pi OS (64-bit, Bookworm)** with Raspberry Pi Imager. In its settings, set the hostname (e.g. `greenova`), your username and password, Wi-Fi, and enable SSH.
2. Boot the Pi and log in (`ssh <user>@greenova.local`).

### 5.2 Copy the project

```bash
git clone https://github.com/<you>/Greenova-UCO-to-Biodiesel-.git   # or copy the folder with a USB stick / scp
cd Greenova-UCO-to-Biodiesel-/backend
```

### 5.3 Run the setup script

```bash
bash setup-pi.sh
sudo reboot            # once, so I2C, 1-Wire and the gpio/i2c/dialout groups take effect
```

It installs `python3-gpiozero`, `python3-lgpio` and `i2c-tools`, turns on I2C and 1-Wire, adds you to the `gpio`, `i2c` and `dialout` groups, creates `.venv` (with access to the Pi's GPIO libraries), installs `requirements.txt` and `requirements-pi.txt` (strip reader, `smbus2`, `pyserial`), copies `hardware.example.toml` to `hardware.toml`, and installs the `greenova` service (not started yet).

### 5.4 Describe your wiring

```bash
nano hardware.toml
```

Change the pins that differ from section 3.1, set `relays.active_high`, the valve `mode`s and motor `type`s, and turn on (`enabled = true`) each sensor you have actually connected. Leave a sensor `enabled = false` until it is wired: a missing sensor simply reads "—" and the backend works around it. Section 6 explains every key.

### 5.5 Check and test, one part at a time

Stop the service while testing (only one program can use the pins): `sudo systemctl stop greenova`.

```bash
.venv/bin/python -m app.hwtest check      # pins in use, sensors on/off, conflicts
.venv/bin/python -m app.hwtest i2c        # should list 0x40 (INA226) and 0x29 (strip reader)
.venv/bin/python -m app.hwtest read       # all readings once per second (Ctrl+C)
.venv/bin/python -m app.hwtest outputs    # clicks each relay, pump, valve and motor for 2 s, asking first
```

`outputs` talks to the pins directly, without the process interlocks, so **unplug the heater and the electrode supply output and remove the centrifuge rotor first**. Listen for each relay, check the right pump runs, watch each valve open and close (it waits 8 s for motorized valves), and check each motor turns at about 30%.

What a good `read` looks like with everything fitted: `temperature` near room temperature, `oilMassG` near 0 with the empty reactor, `voltage`/`current` 0 with the supply off, RPMs 0 with the motors stopped, `heaterSubmerged=False` with an empty tank. Lift the float switch by hand: it should change to `True`.

### 5.6 Calibrate the load cells

```bash
.venv/bin/python -m app.hwtest calibrate reactor
.venv/bin/python -m app.hwtest calibrate output
```

Each one asks you to empty the cell (empty reactor / empty container in place), then put a known weight on it (a 500 g or 1 kg reference, or a measured volume of water: 1 mL ≈ 1 g). It prints the `offset` and `scale` to paste under `[load_cells.reactor]` / `[load_cells.output]`, with `enabled = true`. Check with `hwtest read` that the reading matches the known weight within a gram or two.

The reactor load cell must be tared with the **empty reactor** in place: the website reads the oil, acetone and pump doses as the weight gained.

### 5.7 Calibrate the FFA strip reader

As before (see `app/strip_reader.py`): `python3 app/strip_reader.py white` with the white card, then `cal <ffa>` for each known sample. Readings are rounded to whole percent, like the operator's entry.

### 5.8 Put the website on the Pi

On your PC (where `npm install` already works):

```bat
cd frontend
npm run build
```

Copy the `frontend/dist` folder to the same place on the Pi (`Greenova-UCO-to-Biodiesel-/frontend/dist`), e.g. `scp -r dist <user>@greenova.local:~/Greenova-UCO-to-Biodiesel-/frontend/`. The backend serves it by itself, so the whole system works without internet at `http://<pi-address>:8000`.

### 5.9 Start the service

```bash
sudo systemctl enable --now greenova
journalctl -u greenova -f          # live log; Ctrl+C to leave it
```

Open `http://greenova.local:8000` (or `http://<address from hostname -I>:8000`) on a phone or laptop on the same Wi-Fi. The sidebar badge should say **Connected** (not "Backend · demo"). On **Process → Before You Start**, every System Status tile should be Ready for the parts you fitted.

### 5.10 First runs

1. **Water run:** water instead of oil, empty pump tanks replaced with water, heater unplugged. Walk through a whole batch and check each pump stops at its dose weight and each valve drains in its time.
2. **Heater test:** water in the purification tank covering the heater, stirrer running: start purification and watch it hold 90 ±2 °C and stop at 95 °C if you force it.
3. Only then a real batch, attended.

## 6. `hardware.toml` reference

### 6.1 `gpiochip`

Leave it out: the backend finds the header's GPIO chip on a Pi 4 and a Pi 5. Set `gpiochip = 0` (Pi 4) or `gpiochip = 4` (Pi 5 on older kernels) only if it says it can't find it.

### 6.2 `[relays]`

| Key | Default | Meaning |
|---|---|---|
| `active_high` | `true` | `false` for "low level trigger" relay boards. If a relay clicks ON when the backend starts, this is wrong. |
| `heater` | 23 | Heater relay (drives the SSR/contactor) |
| `electrode_power` | 25 | Electrode power supply output relay |

### 6.3 `[pumps]`

`catalyst = 5` (pump A), `acid = 6` (pump B). ON = pumping. Only one pump runs at a time, never while the reactor outlet is open.

### 6.4 `[valves]`

Each valve is `{ mode = "single", pin = N }` or `{ mode = "dual", open_pin = N, close_pin = M }`.

- `single`: relay ON = open. For 2-wire normally-closed solenoid valves and spring-return motorized valves.
- `dual`: 3-wire motorized ball valves (open wire, close wire, common). The backend never powers OPEN and CLOSE together; the valve's own end switches stop its motor.

### 6.5 `[motors]`

Each motor is `{ type = "pwm", pin = N, frequency = 1000 }` or `{ type = "esc", pin = N }`.

- `pwm`: duty 0–100% to a motor driver or MOSFET.
- `esc`: 50 Hz servo pulses, 1.0 ms = stop, 2.0 ms = full speed.

Speeds are open-loop: duty = target RPM ÷ max RPM. Set your motors' real full-speed RPM in the backend settings `stirrerMaxRpm` (default 900), `centrifugeMaxRpm` (3000) and `purificationStirrerMaxRpm` (600). Change them on `http://<pi>:8000/docs` → `PUT /api/settings`, e.g. `{"centrifugeMaxRpm": 3200}`. Measure full speed with `hwtest read` and the RPM sensor.

### 6.6 `[level_switch]`

`enabled`, `pin` (26), `closed_means_liquid` (`true`). With it, purification starts by itself after separation, and the heater can't turn on (or stops) when the biodiesel doesn't cover it. Without it, the operator ticks "the heater is fully submerged" on the website once per batch.

### 6.7 `[temperature]`

`type = "ds18b20"` or `"none"`; `sensor_id` picks one probe (`ls /sys/bus/w1/devices/` lists them as `28-…`). With `"none"` the heater and electrodes never switch on: no temperature reading is treated as a fault.

### 6.8 `[load_cells.reactor]` and `[load_cells.output]`

`enabled`, `data_pin`, `clock_pin`, `offset`, `scale`, `samples` (median of 3 by default). Without the reactor load cell, the pumps dose by time at the pump rates in Settings; without the output load cell, the yield isn't measured.

### 6.9 `[power_monitor]`

`type` (`"ina226"`, `"ina219"` or `"none"`), `i2c_bus` (1), `address` (`0x40`), `shunt_ohms` (0.02). It gives the live voltage and current, the energy used, and the **over-current stop** (the electrodes stop when the current stays above the stage's current setting for 2 readings). Without it, the over-current stop can't work, so set the supply's own current limit carefully.

### 6.10 `[power_supply]`

- `control = "manual"` (default): you set the voltage and current on the supply. Before each reaction stage the website shows "Set the power supply current to 1 A".
- `control = "serial"`: the Pi sets the voltage and current itself at the start of each stage. Set `port`, `baudrate` and the command templates your supply understands (check its manual):

| Supply | `voltage_command` | `current_command` | `output_on_command` / `output_off_command` |
|---|---|---|---|
| SCPI (most lab supplies) | `"VOLT {volts:.2f}\n"` | `"CURR {amps:.2f}\n"` | `"OUTP ON\n"` / `"OUTP OFF\n"` |
| Korad KA3005P and clones | `"VSET1:{volts:.2f}"` | `"ISET1:{amps:.3f}"` | `"OUT1"` / `"OUT0"` |

Leave the on/off commands empty if the electrode relay switches the output.

## 7. What to change for your machine

| Your situation | What to change |
|---|---|
| Relays turn ON when the input is LOW | `[relays] active_high = false` |
| Different pins | The pin numbers in `hardware.toml`, then `hwtest check` |
| 3-wire motorized ball valves | `valves.<name> = { mode = "dual", open_pin = …, close_pin = … }` |
| Brushless centrifuge with an ESC | `motors.centrifuge = { type = "esc", pin = 13 }` |
| Motors don't reach the set RPM | `stirrerMaxRpm`, `centrifugeMaxRpm`, `purificationStirrerMaxRpm` (section 6.5) |
| Power supply with USB | `[power_supply] control = "serial"` + its commands |
| No level switch yet | Leave `level_switch.enabled = false` (operator confirms) |
| Pumps dose too slowly / time out | Settings → Esterification and Dosing → pump rates (mL/min) |
| Outlets drain too briefly or too long | Settings → reactor outlet time (default 1 min) and centrifuge outlet time (default **2 min**) |
| Next stage shouldn't start by itself | Settings → Esterification and Dosing → **After each drain** → "Wait for the operator's Start" |
| A sensor that isn't supported (e.g. a thermocouple with MAX31865, an ADS1115) | Replace the matching `_read_...` method of `PiHardware` in `app/hardware.py`; it must return `None` when there's no valid value |
| Some sensors on an ESP32 | Have the ESP32 print one JSON line per second over USB (`{"oil_g": 461.2, "temp_c": 31.5}`) and read it with `pyserial` in `PiHardware._read_sensors` |

## 8. What the Pi does by itself during a batch

| After… | The Pi… |
|---|---|
| A reaction stage opens | Loads the dose with pump A or B by the reactor's weight gain (the website starts the stage once the dose and the acetone are in) |
| Transesterification | Opens the reactor outlet for `reactorDrainTime` (1 min), closes it, then **starts the separation by itself** (setting `autoAdvance`) |
| Separation | Waits until the centrifuge has stopped, opens the centrifuge outlet for `centrifugeDrainTime` (**2 min**), closes it |
| The centrifuge outlet closes | Starts purification as soon as the level switch sees biodiesel at the heater |
| Purification drains | Closes the outlet; the website then saves the batch and shows Process Complete |

If the website is closed in between, the Pi carries on; reopening the website shows the current state.

## 9. Updating the software

```bash
cd ~/Greenova-UCO-to-Biodiesel-
git pull                                  # or copy the changed files
cd backend && .venv/bin/pip install -r requirements.txt -r requirements-pi.txt
sudo systemctl restart greenova
```

Your `hardware.toml` and `greenova.db` stay as they are. For website changes, build `frontend/dist` on the PC again and copy it over.

## 10. Troubleshooting

| Problem | Likely cause and fix |
|---|---|
| `hardware.toml: GPIO… is used twice` | Two parts on one pin: change one, run `hwtest check` |
| A relay is ON as soon as the backend starts | `active_high` is wrong for your relay board |
| `Raspberry Pi GPIO chip not found` | Set `gpiochip = 0` (Pi 4) or `4` (Pi 5) |
| `GPIO busy` / `lgpio.error` in `hwtest` | The service is running: `sudo systemctl stop greenova` |
| Temperature "No reading" | 1-Wire off (`sudo raspi-config` → Interface Options → 1-Wire, reboot), missing 4.7 kΩ pull-up, or wrong `sensor_id` |
| Load cell reads None | HX711 on 5 V instead of 3.3 V, DT/SCK swapped, or wrong pins |
| Load cell drifts or jumps | Shielded wires, firm mounting, keep the HX711 away from the motor and heater wiring; raise `samples` to 5 |
| Weight goes down when you add weight | Make `scale` negative (or swap A+ and A−) |
| `hwtest i2c` finds nothing | I2C off, SDA/SCL swapped, or the board powered from 5 V without level shifting |
| Current reads 0.8 A at most | INA226 board still has the 0.1 Ω shunt: fit 0.02 Ω and set `shunt_ohms = 0.02` |
| RPM always 0 | Magnet too far from the hall sensor, or the sensor needs VCC; check with a multimeter that OUT goes low when the magnet passes |
| Purification never starts by itself | No level switch (`enabled = false`): tick the confirmation on the website; or the switch is wired the other way (`closed_means_liquid`) |
| Website shows "Backend · demo" on the Pi | The service runs without `GREENOVA_MOCK=0`: check `/etc/systemd/system/greenova.service` |
| Phone can't open the website | Same Wi-Fi? Use the address from `hostname -I`, port 8000 |
| Logs | `journalctl -u greenova -f` |
