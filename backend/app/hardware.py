"""Hardware layer.

MockHardware simulates the machine for demos and testing. PiHardware talks to the real pins.

The machine:
- Main reactor on the input load cell (oil and acetone are poured in by hand through the
  filtered inlet; the two dosing pumps add their premix): graphite-graphite electrodes on a DC
  power supply with a current limit, stirrer, temperature.
  Pump A ("catalyst") = NaOH/KOH dissolved in methanol. Pump B ("acid") = H2SO4 in methanol.
- Reactor outlet valve -> centrifuge (opens after transesterification).
- Centrifuge, and its outlet valve -> purification tank (opens after separation).
- Purification tank (dry wash with Magnesol or bentonite): immersion heater, dry wash stirrer, level switch
  at the heater; its outlet valve (named "mesh_bed" in the code) lets the biodiesel through the
  filter into the output container on the output load cell (the yield).

The safety rules live here, so they apply no matter who switches things (a process sequence,
a manual button on the website, or a bug):
- The heater runs only while the dry wash stirrer runs and the heater is submerged (level switch),
  and never with the purification outlet open. Stopping the stirrer or opening the outlet turns
  the heater off first.
- The dosing pumps can't run while the reactor outlet valve is open, and the reverse.
- The centrifuge outlet can't open while the centrifuge spins, and the centrifuge can't start
  while its outlet is open.
- watchdog() turns the heater or the electrodes off if the temperature is too high or lost.

Readings use the website's names: oilMassG (input load cell under the reactor), outputWeightG
(output load cell), temperature (°C), voltage (V), current (A), stirrerRpm, centrifugeRpm,
purificationStirrerRpm, heaterSubmerged (level switch: True = biodiesel covers the heater).
Any reading is None when there's no valid value or no sensor.
"""
import random
import threading
import time
from typing import Optional

from . import config

VALVES = ("reactor_outlet", "centrifuge_outlet", "mesh_bed")
MOTORS = ("stirrer", "centrifuge", "purification_stirrer")
PUMPS = ("catalyst", "acid")

VALVE_LABELS = {"reactor_outlet": "Reactor outlet valve", "centrifuge_outlet": "Centrifuge outlet valve",
                "mesh_bed": "Purification outlet valve"}
PUMP_LABELS = {"catalyst": "Pump A (NaOH/KOH + methanol)", "acid": "Pump B (H₂SO₄ + methanol)"}


class InterlockError(Exception):
    pass


class Hardware:
    def __init__(self):
        self.heater_on = False
        self.electrode_power_on = False
        self.valves = {name: False for name in VALVES}
        self.motor_duty = {name: 0.0 for name in MOTORS}
        self.pumps = {name: False for name in PUMPS}
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
        if self.current_limit_control:
            self._write_current_limit(amps)

    def set_supply_voltage(self, volts: float) -> None:
        """Sets the power supply's voltage when the Pi controls the supply (otherwise the operator does)."""
        if self.current_limit_control:
            self._write_voltage(volts)

    def set_valve(self, name: str, is_open: bool) -> None:
        if name not in self.valves:
            raise ValueError(f"Unknown valve: {name}")
        if is_open:
            if name == "mesh_bed" and self.heater_on:
                self.set_heater(False)
            if name == "reactor_outlet" and any(self.pumps.values()):
                raise InterlockError("The reactor outlet can't open while a dosing pump is running.")
            if name == "centrifuge_outlet" and self.motor_duty.get("centrifuge"):
                raise InterlockError("The centrifuge outlet can't open while the centrifuge is spinning.")
        self._write_valve(name, is_open)
        self.valves[name] = is_open

    def set_electrode_power(self, on: bool) -> None:
        self._write_electrode_power(on)
        self.electrode_power_on = on

    def set_motor(self, name: str, duty: float) -> None:
        if name not in self.motor_duty:
            raise ValueError(f"Unknown motor: {name}")
        duty = min(max(duty, 0.0), 1.0)
        if duty > 0 and name == "centrifuge" and self.valves.get("centrifuge_outlet"):
            raise InterlockError("The centrifuge can't start while its outlet valve is open.")
        if duty == 0 and name == "purification_stirrer" and self.heater_on:
            self.set_heater(False)          # the heater never runs without the stirrer
        self._write_motor(name, duty)
        self.motor_duty[name] = duty

    def set_pump(self, name: str, on: bool) -> None:
        if name not in self.pumps:
            raise ValueError(f"Unknown pump: {name}")
        if on and self.valves.get("reactor_outlet"):
            raise InterlockError("A dosing pump can't run while the reactor outlet valve is open.")
        if on and any(v for k, v in self.pumps.items() if k != name):
            raise InterlockError("Only one dosing pump runs at a time.")
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

    def watchdog(self, heater_max_c: float, reaction_max_c: float) -> Optional[str]:
        """Turns the heater or the electrodes off if something is wrong. Returns an alarm
        message, or None."""
        t = self.read().get("temperature")
        problem = None if t is not None else "temperature reading lost"
        if self.heater_on and (problem or t > heater_max_c):
            self.set_heater(False)
            return f"Heater stopped: {problem or f'temperature exceeded {heater_max_c:g} °C'}."
        if self.heater_on and self.read().get("heaterSubmerged") is False:
            self.set_heater(False)
            return "Heater stopped: biodiesel level dropped below the heater."
        if self.electrode_power_on and (problem or t > reaction_max_c):
            self.set_electrode_power(False)
            return f"Electrodes stopped: {problem or f'temperature exceeded {reaction_max_c:g} °C'}."
        return None

    # ----- implemented by MockHardware and PiHardware -----
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


class MockHardware(Hardware):
    """A simulated machine. Liquids move between the parts: pumps add premix to the reactor at
    about 80 g/min, the reactor outlet and the centrifuge outlet pass about 15 g/s (a batch in
    under a minute), and the
    purification outlet (through the filter) about 3 g/s. After separation, the biodiesel (85% of
    the oil's weight) flows on to the purification tank; glycerol and the rest stay in the
    centrifuge. The heater warms the biodiesel about 45 °C per minute (under 1.5 min to 90 °C).
    The electrode current stays just under the power supply's current limit.
    time_scale > 1 makes it run faster for demos."""
    AMBIENT_C = 27.0
    PUMP_G_PER_S = 80 / 60
    DRAIN_G_PER_S = 15.0
    OUTLET_G_PER_S = 3.0
    BIODIESEL_FRACTION = 0.85

    def __init__(self, time_scale: float = 1.0):
        super().__init__()
        self.time_scale = time_scale
        self._lock = threading.Lock()
        self._last = time.monotonic()
        self.temp_c = self.AMBIENT_C
        self.oil_g = 0.0          # oil loaded in this batch (sets how much biodiesel it makes)
        self.reactor_g = 0.0      # on the input load cell
        self.centrifuge_g = 0.0
        self.biodiesel_left_g = 0.0   # biodiesel still in the centrifuge
        self.tank_g = 0.0         # purification tank, above the outlet filter
        self.output_g = 0.0       # on the output load cell
        self.supply_voltage = 30.0
        self.supply_current_limit = 1.0   # set on the supply (by the Pi, or by hand in the simulation)

    # demo helpers (only used in demo mode)
    def demo_load_oil(self, volume_ml: float, density: float = 0.92) -> None:
        """A new batch: oil in the reactor, everything else empty."""
        with self._lock:
            self.oil_g = volume_ml * density
            self.reactor_g = self.oil_g
            self.centrifuge_g = self.biodiesel_left_g = self.tank_g = 0.0

    def demo_add(self, place: str, grams: float) -> None:
        with self._lock:
            if place == "reactor":
                self.reactor_g += grams
            else:
                self.tank_g += grams

    def demo_fill_tank(self, grams: float) -> None:
        with self._lock:
            self.tank_g = grams

    def demo_set_temperature(self, value: float) -> None:
        with self._lock:
            self.temp_c = value

    def demo_finish_flow(self) -> None:
        with self._lock:
            self.output_g += self.tank_g
            self.tank_g = 0.0

    def demo_finish_drain(self, valve: str) -> None:
        with self._lock:
            if valve == "reactor_outlet":
                self._move_to_centrifuge(self.reactor_g)
            elif valve == "centrifuge_outlet":
                self._move_to_tank(self.biodiesel_left_g)

    def _move_to_centrifuge(self, grams: float) -> None:
        grams = min(grams, self.reactor_g)
        share = grams / self.reactor_g if self.reactor_g else 0.0
        self.reactor_g -= grams
        self.centrifuge_g += grams
        # the oil's share of what moved becomes biodiesel after separation
        self.biodiesel_left_g += share * self.oil_g * self.BIODIESEL_FRACTION
        self.oil_g *= (1 - share)

    def _move_to_tank(self, grams: float) -> None:
        grams = min(grams, self.biodiesel_left_g, self.centrifuge_g)
        self.biodiesel_left_g -= grams
        self.centrifuge_g -= grams
        self.tank_g += grams

    def _advance(self) -> None:
        with self._lock:
            now = time.monotonic()
            dt = (now - self._last) * self.time_scale
            self._last = now
            if self.heater_on:
                self.temp_c += 0.75 * dt
            elif self.electrode_power_on:
                self.temp_c += (42.0 - self.temp_c) * min(0.002 * dt, 1.0)   # settles near 42 °C
            else:
                self.temp_c -= (self.temp_c - self.AMBIENT_C) * min(0.002 * dt, 1.0)
            if any(self.pumps.values()):
                self.reactor_g += self.PUMP_G_PER_S * dt
            if self.valves["reactor_outlet"] and self.reactor_g > 0:
                self._move_to_centrifuge(self.DRAIN_G_PER_S * dt)
            if self.valves["centrifuge_outlet"] and self.biodiesel_left_g > 0:
                self._move_to_tank(self.DRAIN_G_PER_S * dt)
            if self.valves["mesh_bed"] and self.tank_g > 0:
                moved = min(self.tank_g, self.OUTLET_G_PER_S * dt)
                self.tank_g -= moved
                self.output_g += moved

    def _read_sensors(self) -> dict:
        self._advance()
        on = self.electrode_power_on
        return {
            "oilMassG": round(self.reactor_g, 1),
            "outputWeightG": round(self.output_g, 1),
            "temperature": round(self.temp_c + random.uniform(-0.1, 0.1), 1),
            "voltage": self.supply_voltage if on else 0.0,
            "current": round(self.supply_current_limit * 0.9 + random.uniform(-0.02, 0.02), 2) if on else 0.0,
            "stirrerRpm": round(self.motor_duty["stirrer"] * 900),
            "centrifugeRpm": round(self.motor_duty["centrifuge"] * 3000),
            "purificationStirrerRpm": (round(self.motor_duty["purification_stirrer"] * 600 + random.uniform(-3, 2))
                                       if self.motor_duty["purification_stirrer"] else 0),
            "heaterSubmerged": self.tank_g > 30,   # simulated level switch at the heater's height
        }

    def _write_heater(self, on: bool) -> None:
        self._advance()

    def _write_electrode_power(self, on: bool) -> None:
        self._advance()

    def _write_valve(self, name: str, is_open: bool) -> None:
        self._advance()

    def _write_motor(self, name: str, duty: float) -> None:
        self._advance()

    def _write_pump(self, name: str, on: bool) -> None:
        self._advance()

    def _write_current_limit(self, amps: float) -> None:
        self.supply_current_limit = amps

    def _write_voltage(self, volts: float) -> None:
        self.supply_voltage = volts


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
        super().__init__()
        from gpiozero import Button, OutputDevice, PWMOutputDevice  # apt: python3-gpiozero python3-lgpio

        from . import drivers

        cfg = hw_config or config.HARDWARE
        problems = config.check_hardware(cfg)
        if problems:
            raise RuntimeError("hardware.toml: " + " ".join(problems))
        self.cfg = cfg
        active_high = cfg["relays"]["active_high"]
        self._closables: list = []

        def relay(pin):
            device = OutputDevice(pin, active_high=active_high, initial_value=False)
            self._closables.append(device)
            return device

        self._heater = relay(cfg["relays"]["heater"])
        self._electrodes = relay(cfg["relays"]["electrode_power"])
        self._pumps = {name: relay(cfg["pumps"][name]) for name in PUMPS}

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
            for key, c in cells.items():
                scale = drivers.HX711Scale(lgpio, chip, c["data_pin"], c["clock_pin"], c.get("offset", 0),
                                           c.get("scale", 1.0), c.get("samples", 3))
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
    if config.MOCK:
        return MockHardware(config.TIME_SCALE)

    actuator_backend = str(config.HARDWARE.get("actuators", {}).get("backend", "gpio")).lower()
    if actuator_backend == "esp32":
        # Fail closed: the supplied Pi/ESP32 pin lists do not yet map all Greenova process outputs
        # (three independently controlled valves and both named chemical pumps) to physical relays.
        # Returning PiHardware here would energize the legacy GPIO defaults, which conflict with
        # the newly supplied Pi BTS7960/HX711 assignments. Do not silently operate the wrong pins.
        raise RuntimeError(
            "The ESP32 hybrid actuator backend is not ready for live operation: confirm the "
            "Greenova relay aliases and implement the serial controller first. Keep GREENOVA_MOCK=1 "
            "until the wiring map, output-cell pins, and interlocks are validated.")
    if actuator_backend != "gpio":
        raise RuntimeError(f"Unknown hardware.toml actuators.backend={actuator_backend!r}; use 'gpio' or 'esp32'.")

    try:
        import gpiozero  # noqa: F401  (only installed on the Raspberry Pi)
    except ImportError:
        raise RuntimeError(
            "GREENOVA_MOCK=0 (hardware mode) only works on the Raspberry Pi with gpiozero installed. "
            "On a laptop, remove GREENOVA_MOCK (or set it to 1) to use demo mode.") from None
    return PiHardware()
