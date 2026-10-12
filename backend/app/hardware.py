"""Hardware layer.

MockHardware simulates the machine for demos and testing. PiHardware talks to the real pins.

The machine:
- Main reactor on the input load cell (oil and acetone are poured in by hand through the
  filtered inlet; the two dosing pumps add their premix): electrodes, stirrer, temperature.
  Pump A ("catalyst") = NaOH/KOH dissolved in methanol. Pump B ("acid") = H2SO4 in methanol.
- Reactor outlet valve -> centrifuge (opens after transesterification).
- Centrifuge, and its outlet valve -> purification tank (opens after separation).
- Purification tank: immersion heater, dry wash stirrer, level switch at the heater; its outlet
  valve ("mesh_bed") lets the biodiesel through the activated-bentonite mesh bed into the
  output container on the output load cell (the yield).

The safety rules live here, so they apply no matter who switches things (a process sequence,
a manual button on the website, or a bug):
- The heater can't turn on while the purification outlet valve is open; opening it turns the heater off.
- The dosing pumps can't run while the reactor outlet valve is open, and the reverse.
- The centrifuge outlet can't open while the centrifuge spins, and the centrifuge can't start
  while its outlet is open.
- watchdog() turns the heater or the electrodes off if the temperature is too high or lost.

Readings use the website's names: oilMassG (input load cell under the reactor), outputWeightG
(output load cell), temperature (°C), voltage (V), current (A), stirrerRpm, centrifugeRpm,
purificationStirrerRpm, heaterSubmerged (level switch: True = biodiesel covers the heater).
Any reading is None when there's no valid value or no sensor.
"""
import glob
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
        if on and self.valves.get("mesh_bed"):
            raise InterlockError("The heater can't turn on while the purification outlet valve is open.")
        self._write_heater(on)
        self.heater_on = on

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
        self.set_heater(False)
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

    def close(self) -> None:
        pass


class MockHardware(Hardware):
    """A simulated machine. Liquids move between the parts: pumps add premix to the reactor at
    about 80 g/min, the reactor outlet and the centrifuge outlet pass about 6 g/s, and the mesh
    bed about 35 g (40 mL) of biodiesel per minute. After separation, the biodiesel (85% of the
    oil's weight) flows on to the purification tank; glycerol and the rest stay in the
    centrifuge. The heater warms the biodiesel about 45 °C per minute (about a minute to 70 °C).
    time_scale > 1 makes it run faster for demos."""
    AMBIENT_C = 27.0
    PUMP_G_PER_S = 80 / 60
    DRAIN_G_PER_S = 6.0
    MESH_G_PER_S = 0.59
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
        self.tank_g = 0.0         # purification tank, above the mesh bed
        self.output_g = 0.0       # on the output load cell
        self.supply_voltage = 30.0

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
                moved = min(self.tank_g, self.MESH_G_PER_S * dt)
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
            "current": round(1.8 + random.uniform(-0.05, 0.05), 2) if on else 0.0,
            "stirrerRpm": round(self.motor_duty["stirrer"] * 900),
            "centrifugeRpm": round(self.motor_duty["centrifuge"] * 3000),
            "purificationStirrerRpm": round(self.motor_duty["purification_stirrer"] * 600),
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


class PiHardware(Hardware):
    """The real machine on the Raspberry Pi. Fill in the TODO readers for your sensors.
    Every reader returns None when there is no valid reading; the safety rules treat a missing
    temperature as a fault."""

    def __init__(self):
        super().__init__()
        from gpiozero import OutputDevice, PWMOutputDevice  # only available on the Pi

        pins, active_high = config.PINS, config.RELAY_ACTIVE_HIGH

        def relay(pin):
            return OutputDevice(pin, active_high=active_high, initial_value=False)

        self._heater = relay(pins["heater_relay"])
        self._electrodes = relay(pins["electrode_power_relay"])
        # TODO: motorized valves differ (2-wire spring return, 3-wire, H-bridge). This assumes
        # one relay per valve that opens it while ON. Change _write_valve if yours works differently.
        self._valves = {"reactor_outlet": relay(pins["valve_reactor_outlet"]),
                        "centrifuge_outlet": relay(pins["valve_centrifuge_outlet"]),
                        "mesh_bed": relay(pins["valve_mesh_bed"])}
        # The dosing pumps are switched by a relay or MOSFET each (ON = pumping).
        self._pumps = {"catalyst": relay(pins["pump_catalyst"]), "acid": relay(pins["pump_acid"])}
        self._motors = {"stirrer": PWMOutputDevice(pins["stirrer_pwm"], frequency=1000),
                        "centrifuge": PWMOutputDevice(pins["centrifuge_pwm"], frequency=1000),
                        "purification_stirrer": PWMOutputDevice(pins["purification_stirrer_pwm"], frequency=1000)}
        self._level = None
        if pins.get("heater_level_switch") is not None:
            from gpiozero import Button
            # Wire the float switch between the pin and GND; closed (pressed) = liquid present.
            self._level = Button(pins["heater_level_switch"], pull_up=True)

    def _write_heater(self, on: bool) -> None:
        self._heater.on() if on else self._heater.off()

    def _write_electrode_power(self, on: bool) -> None:
        self._electrodes.on() if on else self._electrodes.off()

    def _write_valve(self, name: str, is_open: bool) -> None:
        device = self._valves[name]
        device.on() if is_open else device.off()

    def _write_pump(self, name: str, on: bool) -> None:
        device = self._pumps[name]
        device.on() if on else device.off()

    def _write_motor(self, name: str, duty: float) -> None:
        self._motors[name].value = duty

    def _read_sensors(self) -> dict:
        return {
            "oilMassG": self._read_input_weight(),
            "outputWeightG": self._read_output_weight(),
            "temperature": self._read_temperature(),
            "voltage": self._read_electrode_voltage(),
            "current": self._read_electrode_current(),
            "stirrerRpm": self._read_rpm("stirrer"),
            "centrifugeRpm": self._read_rpm("centrifuge"),
            "purificationStirrerRpm": self._read_rpm("purification_stirrer"),
            "heaterSubmerged": None if self._level is None else bool(self._level.is_pressed),
        }

    def _read_temperature(self) -> Optional[float]:
        """Example for a waterproof DS18B20 probe (enable 1-Wire in raspi-config).
        Replace this if you use a different temperature sensor."""
        files = glob.glob("/sys/bus/w1/devices/28-*/w1_slave")
        if not files:
            return None
        try:
            with open(files[0]) as f:
                lines = f.read().splitlines()
            if len(lines) < 2 or not lines[0].endswith("YES"):
                return None
            return round(int(lines[1].split("t=")[1]) / 1000, 1)
        except (OSError, ValueError, IndexError):
            return None

    def _read_input_weight(self) -> Optional[float]:
        # TODO: HX711 load cell under the main reactor (grams; tare it with the reactor empty).
        # It weighs the oil and acetone poured in, and what the dosing pumps add.
        return None

    def _read_output_weight(self) -> Optional[float]:
        return None  # TODO: HX711 load cell under the biodiesel output container (grams)

    def _read_electrode_voltage(self) -> Optional[float]:
        return None  # TODO: for example an ADS1115 ADC with a voltage divider

    def _read_electrode_current(self) -> Optional[float]:
        return None  # TODO: for example an INA219 or ACS712 current sensor

    def _read_rpm(self, name: str) -> Optional[float]:
        return None  # TODO: count pulses from the RPM sensor of "stirrer", "centrifuge" or "purification_stirrer"

    def close(self) -> None:
        self.all_off()
        for device in [self._heater, self._electrodes, *self._valves.values(), *self._pumps.values(),
                       *self._motors.values(), *([self._level] if self._level else [])]:
            device.close()


def create_hardware() -> Hardware:
    if config.MOCK:
        return MockHardware(config.TIME_SCALE)
    try:
        import gpiozero  # noqa: F401  (only installed on the Raspberry Pi)
    except ImportError:
        raise RuntimeError(
            "GREENOVA_MOCK=0 (hardware mode) only works on the Raspberry Pi with gpiozero installed. "
            "On a laptop, remove GREENOVA_MOCK (or set it to 1) to use demo mode.") from None
    return PiHardware()
