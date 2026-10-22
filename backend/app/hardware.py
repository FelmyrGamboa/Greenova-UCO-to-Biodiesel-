"""Hardware layer: the real machine. There is no demo or simulated mode.

Esp32Hardware (esp32.py) is the machine with the ESP32 controller on USB plus the Pi's centrifuge
and load cell (hardware.toml [actuators] backend = "esp32", the default). PiHardware is the older
wiring with every output on the Pi's own pins (backend = "gpio"). (The automated tests use their
own simulated machine, tests/simulator.py.)

The machine (the names in the code; the ESP32 outputs are in hardware.toml [esp32.devices]):
- Main reactor: the oil pump ("oil") and the two dispensers add the oil and the premixes (the
  operator measures each one into its container and stops the pump when it has all gone in):
  pump A ("catalyst") = NaOH/KOH dissolved in methanol, pump B ("acid") = H2SO4 in methanol.
  Graphite-graphite electrodes on a DC power supply with a current limit, stirrer, temperature.
- Separation (continuous): the reactor pump ("reactor_outlet": reactor -> centrifuge), the
  centrifuge, and pumpin ("centrifuge_outlet": centrifuge -> purifier) run together.
- Purifier (dry wash with Magnesol or bentonite): immersion heater, dry wash stirrer, optional level
  switch at the heater; the purification outlet ("mesh_bed": the valve + pumpout) sends the
  biodiesel through the filter into the output container on the output load cell (the yield).

The safety rules live here, so they apply no matter who switches things (a process sequence,
a manual button on the website, or a bug):
- The heater runs only while the dry wash stirrer runs and the heater is submerged (level switch),
  and never with the purification outlet open. Stopping the stirrer or opening the outlet turns
  the heater off first.
- The pumps into the reactor (oil, A, B) can't run while the reactor pump is emptying it, and the
  reverse; only one of them runs at a time.
- watchdog() turns the heater or the electrodes off if the temperature is too high or lost.

Readings use the website's names: oilMassG (input load cell under the reactor), outputWeightG
(output load cell), temperature (°C), voltage (V), current (A), stirrerRpm, centrifugeRpm,
purificationStirrerRpm, heaterSubmerged (level switch: True = biodiesel covers the heater).
Any reading is None when there's no valid value or no sensor.
"""
import threading
import time
from typing import Optional

from . import config

VALVES = ("reactor_outlet", "centrifuge_outlet", "mesh_bed")
MOTORS = ("stirrer", "centrifuge", "purification_stirrer")
PUMPS = ("catalyst", "acid", "oil")      # "oil": the oil pump, when the machine has one

# reactor_outlet / centrifuge_outlet / mesh_bed are pumps (and a valve) on the ESP32 machine
VALVE_LABELS = {"reactor_outlet": "Reactor pump (reactor → centrifuge)",
                "centrifuge_outlet": "Pumpin (centrifuge → purifier)",
                "mesh_bed": "Purification outlet (valve + pumpout)"}
PUMP_LABELS = {"catalyst": "Pump A (NaOH/KOH + methanol)", "acid": "Pump B (H₂SO₄ + methanol)",
               "oil": "Oil pump"}


class InterlockError(Exception):
    pass


class Hardware:
    def __init__(self, pumps: tuple = PUMPS):
        self.heater_on = False
        self.electrode_power_on = False
        self.valves = {name: False for name in VALVES}
        self.motor_duty = {name: 0.0 for name in MOTORS}
        self.pumps = {name: False for name in pumps}      # only the pumps this machine has
        self.supply_setting: tuple = (None, None)          # the stage's (volts, amps) for the electrodes
        self._snapshot: Optional[dict] = None

    # ----- outputs, with interlocks -----
    def set_heater(self, on: bool) -> None:
        if on:
            if self.valves.get("mesh_bed"):
                raise InterlockError("The heater can't turn on while the purification outlet valve is open.")
            if not self.motor_duty.get("purification_stirrer"):
                raise InterlockError("The heater runs only while the purification stirrer is running.")
            if self.read().get("heaterSubmerged") is False:
                raise InterlockError("The heater can't turn on: the level switch doesn't detect biodiesel.")
        self._write_heater(on)
        self.heater_on = on

    @property
    def current_limit_control(self) -> bool:
        """True when the Pi can set the power supply's current limit."""
        return config.POWER_SUPPLY_CURRENT_CONTROL

    def set_current_limit(self, amps: float) -> None:
        self.supply_setting = (self.supply_setting[0], amps)   # also for the energy figure (energy.py)
        if self.current_limit_control:
            self._write_current_limit(amps)

    def set_supply_voltage(self, volts: float) -> None:
        """Sets the power supply's voltage when the Pi controls the supply (otherwise the operator does)."""
        self.supply_setting = (volts, self.supply_setting[1])
        if self.current_limit_control:
            self._write_voltage(volts)

    def set_valve(self, name: str, is_open: bool) -> None:
        if name not in self.valves:
            raise ValueError(f"Unknown valve: {name}")
        if is_open:
            if name == "mesh_bed" and self.heater_on:
                self.set_heater(False)
            if name == "reactor_outlet" and any(self.pumps.values()):
                raise InterlockError("The reactor pump can't run while a pump into the reactor is running.")
        self._write_valve(name, is_open)
        self.valves[name] = is_open

    def set_electrode_power(self, on: bool) -> None:
        self._write_electrode_power(on)
        self.electrode_power_on = on

    def set_motor(self, name: str, duty: float) -> None:
        if name not in self.motor_duty:
            raise ValueError(f"Unknown motor: {name}")
        duty = min(max(duty, 0.0), 1.0)
        if duty == 0 and name == "purification_stirrer" and self.heater_on:
            self.set_heater(False)          # the heater never runs without the stirrer
        self._write_motor(name, duty)
        self.motor_duty[name] = duty

    def set_pump(self, name: str, on: bool) -> None:
        if name not in self.pumps:
            if name in PUMPS:
                raise InterlockError(f"This machine has no {PUMP_LABELS[name].lower()} (hardware.toml).")
            raise ValueError(f"Unknown pump: {name}")
        if on and self.valves.get("reactor_outlet"):
            raise InterlockError("A pump into the reactor can't run while the reactor pump is emptying it.")
        if on and any(v for k, v in self.pumps.items() if k != name):
            raise InterlockError("Only one pump into the reactor runs at a time.")
        self._write_pump(name, on)
        self.pumps[name] = on

    def all_off(self) -> None:
        self.set_heater(False)          # first, so stopping the stirrer below is safe
        self.set_electrode_power(False)
        for name in self.pumps:
            self.set_pump(name, False)
        for name in self.motor_duty:
            self.set_motor(name, 0.0)
        for name in self.valves:
            self.set_valve(name, False)

    @property
    def has_oil_pump(self) -> bool:
        return "oil" in self.pumps

    def any_output_on(self) -> bool:
        return (self.heater_on or self.electrode_power_on or any(self.valves.values())
                or any(self.motor_duty.values()) or any(self.pumps.values()))

    # ----- what the hardware can tell about itself (ESP32 mode overrides these) -----
    @property
    def link_fault(self) -> Optional[str]:
        """Why the output controller can't be trusted right now (the ESP32 is offline, or an output
        didn't follow a command), or None. main.py stops every process when this is set."""
        return None

    def full_speed_rpm(self, name: str) -> Optional[float]:
        """RPM at full speed when the hardware knows it (the ESP32 sketch's MAX_RPM for the mixers,
        [centrifuge] max_rpm), or None to use the Settings value (stirrerMaxRpm ...)."""
        return None

    def rpm_is_measured(self, key: str) -> bool:
        """False when the RPM reading is only worked out from the speed setting (no RPM sensor)."""
        return True

    def describe(self) -> dict:
        """For the website's Settings -> Hardware card."""
        return {"backend": "gpio", "fault": self.link_fault, "controller": None,
                "roles": [], "centrifuge": None, "loadCells": self.load_cells()}

    def load_cells(self) -> list[dict]:
        return []

    def tare_load_cell(self, key: str) -> dict:
        raise NotImplementedError("Tare and calibration from the website need the ESP32 hardware mode. "
                                  "Use: python -m app.hwtest calibrate " + key)

    def calibrate_load_cell(self, key: str, grams: float) -> dict:
        raise NotImplementedError("Tare and calibration from the website need the ESP32 hardware mode. "
                                  "Use: python -m app.hwtest calibrate " + key)

    # ----- inputs -----
    def _output_states(self) -> dict:
        return {"heaterOn": self.heater_on, "electrodePowerOn": self.electrode_power_on,
                "meshBedValveOpen": self.valves.get("mesh_bed", False),
                "reactorValveOpen": self.valves.get("reactor_outlet", False),
                "centrifugeValveOpen": self.valves.get("centrifuge_outlet", False),
                "valves": dict(self.valves), "motorDuty": dict(self.motor_duty), "pumps": dict(self.pumps)}

    def refresh(self) -> dict:
        """Read every sensor. Called once per second by the sensor loop (in a thread)."""
        snap = self._read_sensors()
        snap["timestamp"] = time.time()
        self._snapshot = snap
        return {**snap, **self._output_states()}

    def read(self) -> dict:
        """The latest sensor readings (without waiting for the sensors), plus the current state
        of every output, so a switch shows up immediately."""
        if self._snapshot is None:
            return self.refresh()
        return {**self._snapshot, **self._output_states()}

    def watchdog(self, heater_max_c: float, reaction_max_c: Optional[float] = None) -> Optional[str]:
        """Turns the heater off if something is wrong (no temperature reading, too hot, level
        switch dry). Returns an alarm message, or None. The electrodes are not checked against the
        temperature (the reactions run without a temperature check); reaction_max_c is unused."""
        t = self.read().get("temperature")
        problem = None if t is not None else "temperature reading lost"
        if self.heater_on and (problem or t > heater_max_c):
            self.set_heater(False)
            return f"Heater stopped: {problem or f'temperature exceeded {heater_max_c:g} °C'}."
        if self.heater_on and self.read().get("heaterSubmerged") is False:
            self.set_heater(False)
            return "Heater stopped: biodiesel level dropped below the heater."
        return None

    # ----- implemented by Esp32Hardware and PiHardware (and the tests' simulated machine) -----
    def _read_sensors(self) -> dict:
        raise NotImplementedError

    def _write_heater(self, on: bool) -> None:
        raise NotImplementedError

    def _write_electrode_power(self, on: bool) -> None:
        raise NotImplementedError

    def _write_valve(self, name: str, is_open: bool) -> None:
        raise NotImplementedError

    def _write_motor(self, name: str, duty: float) -> None:
        raise NotImplementedError

    def _write_pump(self, name: str, on: bool) -> None:
        raise NotImplementedError

    def _write_current_limit(self, amps: float) -> None:
        raise NotImplementedError

    def _write_voltage(self, volts: float) -> None:
        pass

    def close(self) -> None:
        pass


class _Sampler:
    """Reads one slow sensor over and over in its own thread (a DS18B20 takes 0.75 s, an HX711
    about 0.3 s), so the 1-second sensor loop never waits. A value older than max_age_s counts
    as missing (None), so a sensor that stops answering trips the safety rules."""

    def __init__(self, name: str, read, period_s: float = 0.2, max_age_s: float = 5.0):
        self._read, self._period, self._max_age = read, period_s, max_age_s
        self._value, self._at = None, 0.0
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name=f"greenova-{name}", daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                value = self._read()
            except Exception:
                value = None
            if value is not None:
                self._value, self._at = value, time.monotonic()
            self._stop.wait(self._period)

    @property
    def value(self):
        return self._value if time.monotonic() - self._at <= self._max_age else None

    def close(self) -> None:
        self._stop.set()


class PiHardware(Hardware):
    """The real machine on the Raspberry Pi. Everything comes from hardware.toml (see
    hardware.example.toml and docs/RASPBERRY_PI_SETUP.md): pins, relay type, valve and motor
    types, which sensors are fitted, and their calibration. A sensor that is not enabled reads
    None, and the backend works around it (e.g. the pumps dose by time without a load cell).

    To use a sensor that isn't supported, replace the matching _read_... method below."""

    def __init__(self, hw_config: Optional[dict] = None):
        from gpiozero import Button, OutputDevice, PWMOutputDevice  # apt: python3-gpiozero python3-lgpio

        from . import drivers

        cfg = hw_config or config.HARDWARE
        problems = config.check_hardware(cfg, backend="gpio")
        if problems:
            raise RuntimeError("hardware.toml: " + " ".join(problems))
        super().__init__(tuple(name for name in PUMPS if cfg["pumps"].get(name) is not None))
        self.cfg = cfg
        active_high = cfg["relays"]["active_high"]
        self._closables: list = []

        def relay(pin):
            device = OutputDevice(pin, active_high=active_high, initial_value=False)
            self._closables.append(device)
            return device

        self._heater = relay(cfg["relays"]["heater"])
        self._electrodes = relay(cfg["relays"]["electrode_power"])
        self._pumps = {name: relay(cfg["pumps"][name]) for name in self.pumps}

        # Valves: "single" = one relay, ON = open (2-wire NC solenoid, spring return).
        #         "dual"   = 3-wire motorized ball valve: one relay powers OPEN, the other CLOSE.
        self._valves = {}
        for name, key in (("reactor_outlet", "reactor_outlet"), ("centrifuge_outlet", "centrifuge_outlet"),
                          ("mesh_bed", "purification_outlet")):
            v = cfg["valves"][key]
            if v.get("mode", "single") == "dual":
                self._valves[name] = ("dual", relay(v["open_pin"]), relay(v["close_pin"]))
            else:
                self._valves[name] = ("single", relay(v["pin"]), None)

        # Motors: "pwm" = duty 0-1 to a motor driver; "esc" = brushless ESC, 1.0-2.0 ms pulses at 50 Hz.
        self._motors = {}
        for name in MOTORS:
            m = cfg["motors"][name]
            if m.get("type", "pwm") == "esc":
                device = PWMOutputDevice(m["pin"], frequency=50, initial_value=0.05)   # 1 ms = stopped (arms the ESC)
            else:
                device = PWMOutputDevice(m["pin"], frequency=m.get("frequency", 1000))
            self._closables.append(device)
            self._motors[name] = (m.get("type", "pwm"), device)

        # Level switch (float switch at the heater's height): between the pin and GND.
        self._level = None
        self._level_closed_is_liquid = cfg["level_switch"].get("closed_means_liquid", True)
        if cfg["level_switch"].get("enabled"):
            self._level = Button(cfg["level_switch"]["pin"], pull_up=True)
            self._closables.append(self._level)

        # Slow sensors, each read in its own thread
        self._samplers: dict[str, _Sampler] = {}
        t = cfg["temperature"]
        if t.get("type", "ds18b20") == "ds18b20":
            self._samplers["temperature"] = _Sampler("temperature", lambda: drivers.read_ds18b20(t.get("sensor_id", "")), 0.1)
        elif t.get("type") not in ("none", "", None):
            raise RuntimeError(f"hardware.toml: temperature type {t.get('type')!r} is not supported (ds18b20 or none).")

        self._scales = {}
        cells = {k: c for k, c in cfg["load_cells"].items() if c.get("enabled")}
        if cells:
            lgpio, chip = drivers.open_gpiochip(cfg.get("gpiochip"))
            self._lgpio_chip = (lgpio, chip)
            store = drivers.CalibrationStore(config.CALIBRATION_FILE)   # python -m app.hwtest calibrate
            for key, c in cells.items():
                saved = store.get(key)
                scale = drivers.HX711Scale(lgpio, chip, c["data_pin"], c["clock_pin"], saved.get("offset", c.get("offset", 0)),
                                           saved.get("scale", c.get("scale", 1.0)), c.get("samples", 3))
                self._scales[key] = scale
                self._samplers[f"weight_{key}"] = _Sampler(f"weight-{key}", scale.read_grams, 0.05)

        self._power = None
        pm = cfg["power_monitor"]
        if pm.get("type", "none") not in ("none", "", None):
            self._power = drivers.PowerMonitor(pm["type"], pm.get("i2c_bus", 1), pm.get("address", 0x40),
                                               pm.get("shunt_ohms", 0.02))
            self._samplers["power"] = _Sampler("power", self._power.read_or_none, 0.2)

        self._rpm = {name: drivers.RpmCounter(r["pin"], r.get("pulses_per_rev", 1))
                     for name, r in cfg["rpm"].items() if r.get("enabled")}

        self._supply = None
        ps = cfg["power_supply"]
        if ps.get("control") == "serial":
            self._supply = drivers.SerialSupply(ps["port"], ps.get("baudrate", 9600), ps.get("voltage_command", ""),
                                                ps.get("current_command", ""), ps.get("output_on_command", ""),
                                                ps.get("output_off_command", ""))

    # ----- outputs -----
    def _write_heater(self, on: bool) -> None:
        self._heater.on() if on else self._heater.off()

    def _write_electrode_power(self, on: bool) -> None:
        self._electrodes.on() if on else self._electrodes.off()
        if self._supply:
            self._supply.output(on)

    def _write_valve(self, name: str, is_open: bool) -> None:
        mode, first, second = self._valves[name]
        if mode == "dual":                   # never power OPEN and CLOSE together
            if is_open:
                second.off()
                first.on()
            else:
                first.off()
                second.on()
        else:
            first.on() if is_open else first.off()

    def _write_pump(self, name: str, on: bool) -> None:
        device = self._pumps[name]
        device.on() if on else device.off()

    def _write_motor(self, name: str, duty: float) -> None:
        kind, device = self._motors[name]
        device.value = 0.05 + 0.05 * duty if kind == "esc" else duty   # ESC: 1 ms (stop) to 2 ms (full)

    def _write_current_limit(self, amps: float) -> None:
        if self._supply is None:
            # GREENOVA_PSU_CURRENT_CONTROL=1 without [power_supply] control = "serial": put your own code here.
            raise NotImplementedError("Set the power supply's current limit by hand, or set "
                                      "[power_supply] control = \"serial\" in hardware.toml.")
        self._supply.set_current(amps)

    def _write_voltage(self, volts: float) -> None:
        if self._supply is not None:
            self._supply.set_voltage(volts)

    # ----- sensors -----
    def _read_sensors(self) -> dict:
        volts, amps = self._read_power()
        return {
            "oilMassG": self._read_input_weight(),
            "outputWeightG": self._read_output_weight(),
            "temperature": self._read_temperature(),
            "voltage": volts,
            "current": amps,
            "stirrerRpm": self._read_rpm("stirrer"),
            "centrifugeRpm": self._read_rpm("centrifuge"),
            "purificationStirrerRpm": self._read_rpm("purification_stirrer"),
            "heaterSubmerged": self._read_level(),
        }

    def _sampled(self, key: str):
        sampler = self._samplers.get(key)
        return sampler.value if sampler else None

    def _read_temperature(self) -> Optional[float]:
        return self._sampled("temperature")

    def _read_input_weight(self) -> Optional[float]:
        """HX711 under the main reactor (grams, tared with the empty reactor)."""
        return self._sampled("weight_reactor")

    def _read_output_weight(self) -> Optional[float]:
        """HX711 under the biodiesel output container (grams)."""
        return self._sampled("weight_output")

    def _read_power(self) -> tuple[Optional[float], Optional[float]]:
        value = self._sampled("power")
        return value if value else (None, None)

    def _read_rpm(self, name: str) -> Optional[float]:
        counter = self._rpm.get(name)
        return counter.rpm() if counter else None

    def _read_level(self) -> Optional[bool]:
        if self._level is None:
            return None
        closed = bool(self._level.is_pressed)
        return closed if self._level_closed_is_liquid else not closed

    def close(self) -> None:
        self.all_off()
        for sampler in self._samplers.values():
            sampler.close()
        for item in [*self._scales.values(), *self._rpm.values(), *([self._power] if self._power else []),
                     *([self._supply] if self._supply else []), *self._closables]:
            try:
                item.close()
            except Exception:
                pass


def create_hardware() -> Hardware:
    """The real machine, from hardware.toml [actuators] backend: "esp32" (the ESP32 controller on
    USB + the Pi's centrifuge and load cell, see esp32.py) or "gpio" (the older wiring with
    everything on the Pi's pins). The backend runs on the Raspberry Pi only."""
    actuator_backend = config.actuator_backend(config.HARDWARE)
    if actuator_backend == "esp32":
        try:
            from .esp32 import Esp32Hardware
            return Esp32Hardware()
        except ImportError as e:
            raise RuntimeError(
                f"Hardware mode (ESP32) needs lgpio and pyserial on the Raspberry Pi: {e}. Run setup-pi.sh "
                "(sudo apt install python3-lgpio python3-serial). The backend runs on the Raspberry Pi that is wired to the machine."
            ) from None
        except Exception as e:
            if "busy" in str(e).lower():     # lgpio: another program holds the centrifuge / load cell pins
                raise RuntimeError(f"{e}: another program uses the Pi's GPIO pins. Stop the old control panel "
                                   "(sudo systemctl disable --now pi-control) and try again.") from None
            raise
    if actuator_backend != "gpio":
        raise RuntimeError(f"Unknown hardware.toml actuators.backend={actuator_backend!r}; use 'gpio' or 'esp32'.")

    try:
        import gpiozero  # noqa: F401  (only installed on the Raspberry Pi)
    except ImportError:
        raise RuntimeError(
            "backend = \"gpio\" needs the Raspberry Pi's gpiozero (sudo apt install python3-gpiozero). "
            "The backend runs on the Raspberry Pi that is wired to the machine.") from None
    return PiHardware()
