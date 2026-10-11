"""Hardware layer.

MockHardware simulates the machine for demos and testing. PiHardware talks to the real pins.

The safety rules live here, so they apply no matter who switches things (a process sequence,
a manual button on the website, or a bug):
- The heater can't turn on while the mesh bed valve is open.
- Opening the mesh bed valve turns the heater off first.
- watchdog() turns the heater off if the temperature is too high or the reading is lost.

Readings use the website's names: oilMassG, outputWeightG, temperature (°C), voltage (V),
current (A), stirrerRpm, centrifugeRpm, heaterSubmerged (level switch: True = biodiesel covers
the heater). Any reading is None when there's no valid value or no sensor.
"""
import glob
import random
import threading
import time
from typing import Optional

from . import config

VALVES = ("mesh_bed",)            # TODO: add your other valves, e.g. "reactor_out", "glycerol_out"
MOTORS = ("stirrer", "centrifuge")


class InterlockError(Exception):
    pass


class Hardware:
    def __init__(self):
        self.heater_on = False
        self.electrode_power_on = False
        self.valves = {name: False for name in VALVES}
        self.motor_duty = {name: 0.0 for name in MOTORS}
        self._snapshot: Optional[dict] = None

    # ----- outputs, with interlocks -----
    def set_heater(self, on: bool) -> None:
        if on and self.valves.get("mesh_bed"):
            raise InterlockError("The heater can't turn on while the mesh bed valve is open.")
        self._write_heater(on)
        self.heater_on = on

    def set_valve(self, name: str, is_open: bool) -> None:
        if name not in self.valves:
            raise ValueError(f"Unknown valve: {name}")
        if is_open and name == "mesh_bed" and self.heater_on:
            self.set_heater(False)
        self._write_valve(name, is_open)
        self.valves[name] = is_open

    def set_electrode_power(self, on: bool) -> None:
        self._write_electrode_power(on)
        self.electrode_power_on = on

    def set_motor(self, name: str, duty: float) -> None:
        if name not in self.motor_duty:
            raise ValueError(f"Unknown motor: {name}")
        duty = min(max(duty, 0.0), 1.0)
        self._write_motor(name, duty)
        self.motor_duty[name] = duty

    def all_off(self) -> None:
        self.set_heater(False)
        self.set_electrode_power(False)
        for name in self.valves:
            self.set_valve(name, False)
        for name in self.motor_duty:
            self.set_motor(name, 0.0)

    # ----- inputs -----
    def _output_states(self) -> dict:
        return {"heaterOn": self.heater_on, "electrodePowerOn": self.electrode_power_on,
                "meshBedValveOpen": self.valves.get("mesh_bed", False), "valves": dict(self.valves),
                "motorDuty": dict(self.motor_duty)}

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

    def close(self) -> None:
        pass


class MockHardware(Hardware):
    """A simulated machine. The heater warms the biodiesel about 45 °C per minute (about a minute
    to 70 °C), electrolysis warms the reactor slowly, and the mesh bed passes about 35 g
    (40 mL) of biodiesel per minute.
    time_scale > 1 makes it run faster for demos."""
    AMBIENT_C = 27.0

    def __init__(self, time_scale: float = 1.0):
        super().__init__()
        self.time_scale = time_scale
        self._lock = threading.Lock()
        self._last = time.monotonic()
        self.temp_c = self.AMBIENT_C
        self.oil_g = 0.0          # "Load demonstration sensor reading" sets this
        self.tank_g = 0.0         # biodiesel waiting above the mesh bed
        self.output_g = 0.0
        self.supply_voltage = 30.0

    # demo helpers (only used in demo mode)
    def demo_load_oil(self, volume_ml: float, density: float = 0.92) -> None:
        with self._lock:
            self.oil_g = volume_ml * density
            self.tank_g = self.oil_g * 0.85     # about 89% yield by volume after purification
            self.output_g = 0.0

    def demo_set_temperature(self, value: float) -> None:
        with self._lock:
            self.temp_c = value

    def demo_finish_flow(self) -> None:
        with self._lock:
            self.output_g += self.tank_g
            self.tank_g = 0.0

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
            if self.valves["mesh_bed"] and self.tank_g > 0:
                moved = min(self.tank_g, 0.59 * dt)
                self.tank_g -= moved
                self.output_g += moved

    def _read_sensors(self) -> dict:
        self._advance()
        on = self.electrode_power_on
        return {
            "oilMassG": round(self.oil_g, 1),
            "outputWeightG": round(self.output_g, 1),
            "temperature": round(self.temp_c + random.uniform(-0.1, 0.1), 1),
            "voltage": self.supply_voltage if on else 0.0,
            "current": round(1.8 + random.uniform(-0.05, 0.05), 2) if on else 0.0,
            "stirrerRpm": round(self.motor_duty["stirrer"] * 900),
            "centrifugeRpm": round(self.motor_duty["centrifuge"] * 3000),
            "heaterSubmerged": self.tank_g > 0,   # simulated level switch
        }

    def _write_heater(self, on: bool) -> None:
        self._advance()

    def _write_electrode_power(self, on: bool) -> None:
        self._advance()

    def _write_valve(self, name: str, is_open: bool) -> None:
        self._advance()

    def _write_motor(self, name: str, duty: float) -> None:
        self._advance()


class PiHardware(Hardware):
    """The real machine on the Raspberry Pi. Fill in the TODO readers for your sensors.
    Every reader returns None when there is no valid reading; the safety rules treat a missing
    temperature as a fault."""

    def __init__(self):
        super().__init__()
        from gpiozero import OutputDevice, PWMOutputDevice  # only available on the Pi

        pins, active_high = config.PINS, config.RELAY_ACTIVE_HIGH
        self._heater = OutputDevice(pins["heater_relay"], active_high=active_high, initial_value=False)
        self._electrodes = OutputDevice(pins["electrode_power_relay"], active_high=active_high,
                                        initial_value=False)
        # TODO: motorized valves differ (2-wire spring return, 3-wire, H-bridge). This assumes
        # one relay that opens the valve while ON. Change _write_valve if yours works differently.
        self._valves = {"mesh_bed": OutputDevice(pins["valve_mesh_bed"], active_high=active_high,
                                                 initial_value=False)}
        self._motors = {"stirrer": PWMOutputDevice(pins["stirrer_pwm"], frequency=1000),
                        "centrifuge": PWMOutputDevice(pins["centrifuge_pwm"], frequency=1000)}
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

    def _write_motor(self, name: str, duty: float) -> None:
        self._motors[name].value = duty

    def _read_sensors(self) -> dict:
        return {
            "oilMassG": self._read_oil_mass(),
            "outputWeightG": self._read_output_weight(),
            "temperature": self._read_temperature(),
            "voltage": self._read_electrode_voltage(),
            "current": self._read_electrode_current(),
            "stirrerRpm": self._read_rpm("stirrer"),
            "centrifugeRpm": self._read_rpm("centrifuge"),
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

    def _read_oil_mass(self) -> Optional[float]:
        return None  # TODO: HX711 load cell under the oil input (grams)

    def _read_output_weight(self) -> Optional[float]:
        return None  # TODO: HX711 load cell under the biodiesel output (grams)

    def _read_electrode_voltage(self) -> Optional[float]:
        return None  # TODO: for example an ADS1115 ADC with a voltage divider

    def _read_electrode_current(self) -> Optional[float]:
        return None  # TODO: for example an INA219 or ACS712 current sensor

    def _read_rpm(self, name: str) -> Optional[float]:
        return None  # TODO: count pulses from your RPM sensor

    def close(self) -> None:
        self.all_off()
        for device in [self._heater, self._electrodes, *self._valves.values(), *self._motors.values(),
                       *([self._level] if self._level else [])]:
            device.close()


def create_hardware() -> Hardware:
    return MockHardware(config.TIME_SCALE) if config.MOCK else PiHardware()
