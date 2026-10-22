"""A simulated machine for the automated tests only (the website always drives the real machine).

Liquids move between the parts: the oil pump fills the reactor at about 460 g/min and pumps A and
B add premix at about 80 g/min (until the test presses Done), the reactor pump and pumpin pass
about 15 g/s, and the purification outlet (the valve + pumpout, through the filter) about 3 g/s.
The oil's share that reaches the centrifuge becomes biodiesel (85% of its weight) and flows on to
the purifier through pumpin; glycerol and the rest stay in the centrifuge. The heater warms the
biodiesel about 45 °C per minute and it cools slowly when the heater is off.

Simulated time doesn't follow the computer's clock: every sensor reading (refresh(), called once per
"second" by the tests' sensor loop, like main.py's) moves the machine on by exactly one simulated
second. The runners tick once per "second" too, so the two stay in step on any computer (Windows
timers are only accurate to about 16 ms, which would otherwise let the machine run ahead of or
behind the runners). time_scale is only how fast the tests' loops go (the runners use the same).
"""
import random
import threading

from app.hardware import Hardware


class SimulatedMachine(Hardware):
    AMBIENT_C = 27.0
    OIL_G_PER_S = 500 * 0.92 / 60
    PUMP_G_PER_S = 80 / 60
    DRAIN_G_PER_S = 15.0
    OUTLET_G_PER_S = 3.0
    BIODIESEL_FRACTION = 0.85

    def __init__(self, time_scale: float = 1.0, level_switch: bool = False, heater_lag: float = 0.0):
        super().__init__()
        # heater_lag 0: the heater warms the reading at once. > 0: its heat first goes into the
        # heater and the tank and reaches the probe a share (1 - heater_lag) per second later, so the
        # temperature keeps rising after a pulse, peaks and then falls (like the real immersion heater).
        self.heater_lag = heater_lag
        self.heat_store = 0.0
        self.time_scale = time_scale
        self.level_switch = level_switch   # True: a float switch at the heater (reads the purifier level)
        self._lock = threading.Lock()
        self.seconds = 0          # simulated seconds so far (one per sensor reading)
        self.temp_c = self.AMBIENT_C
        self.oil_g = 0.0          # oil loaded in this batch (sets how much biodiesel it makes)
        self.reactor_g = 0.0      # what is in the reactor
        self.centrifuge_g = 0.0
        self.biodiesel_left_g = 0.0   # biodiesel still in the centrifuge
        self.tank_g = 0.0         # purifier, above the outlet filter
        self.output_g = 0.0       # on the output load cell
        self.supply_voltage = 30.0
        self.supply_current_limit = 1.0
        self.unplugged: set = set()   # sensor readings that come back as None (see unplug)

    # ----- test helpers -----
    def load_oil(self, volume_ml: float, density: float = 0.92) -> None:
        """A new batch: oil in the reactor, everything else empty."""
        with self._lock:
            self.oil_g = volume_ml * density
            self.reactor_g = self.oil_g
            self.centrifuge_g = self.biodiesel_left_g = self.tank_g = 0.0

    def fill_tank(self, grams: float) -> None:
        with self._lock:
            self.tank_g = grams

    def set_temperature(self, value: float) -> None:
        with self._lock:
            self.temp_c = value

    def unplug(self, *readings: str) -> None:
        """Those readings ("temperature", "outputWeightG") give None, like a sensor that is not connected."""
        self.unplugged.update(readings)

    def plug_in(self, *readings: str) -> None:
        self.unplugged.difference_update(readings)

    def finish_flow(self) -> None:
        with self._lock:
            self.output_g += self.tank_g
            self.tank_g = 0.0

    # ----- the simulation -----
    def _move_to_centrifuge(self, grams: float) -> None:
        grams = min(grams, self.reactor_g)
        share = grams / self.reactor_g if self.reactor_g else 0.0
        self.reactor_g -= grams
        self.centrifuge_g += grams
        self.biodiesel_left_g += share * self.oil_g * self.BIODIESEL_FRACTION
        self.oil_g *= (1 - share)

    def _move_to_tank(self, grams: float) -> None:
        grams = min(grams, self.biodiesel_left_g, self.centrifuge_g)
        self.biodiesel_left_g -= grams
        self.centrifuge_g -= grams
        self.tank_g += grams

    def _advance(self, dt: float = 1.0) -> None:
        """Moves the machine on by dt simulated seconds (0: only takes note of a switched output)."""
        with self._lock:
            self.seconds += dt
            if self.heater_lag:
                if self.heater_on:
                    self.heat_store += 0.75 * dt
                passed = self.heat_store * (1 - self.heater_lag ** dt)
                self.heat_store -= passed
                self.temp_c += passed - (self.temp_c - self.AMBIENT_C) * min(0.002 * dt, 1.0)
            elif self.heater_on:
                self.temp_c += 0.75 * dt
            elif self.electrode_power_on:
                self.temp_c += (42.0 - self.temp_c) * min(0.002 * dt, 1.0)   # settles near 42 °C
            else:
                self.temp_c -= (self.temp_c - self.AMBIENT_C) * min(0.002 * dt, 1.0)
            if self.pumps.get("oil"):
                self.reactor_g += self.OIL_G_PER_S * dt
                self.oil_g += self.OIL_G_PER_S * dt
            elif any(self.pumps.values()):
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
        reading = {
            "oilMassG": None,          # no reactor load cell (as on the real machine)
            "outputWeightG": round(self.output_g, 1),
            "temperature": round(self.temp_c + random.uniform(-0.1, 0.1), 1),
            "voltage": self.supply_voltage if on else 0.0,
            "current": round(self.supply_current_limit * 0.9 + random.uniform(-0.02, 0.02), 2) if on else 0.0,
            "stirrerRpm": round(self.motor_duty["stirrer"] * 1544),
            "centrifugeRpm": round(self.motor_duty["centrifuge"] * 2500),
            "purificationStirrerRpm": round(self.motor_duty["purification_stirrer"] * 1544),
            "heaterSubmerged": self.tank_g > 30 if self.level_switch else None,   # optional float switch
            "rpmEstimated": True,                          # no RPM sensors: the RPM is the set speed
            "loadCellsFitted": {"output": True, "reactor": False},
        }
        return {key: None if key in self.unplugged else value for key, value in reading.items()}

    # the simulated power supply follows the stage's settings (as if the operator set them)
    def set_current_limit(self, amps: float) -> None:
        self.supply_current_limit = amps

    def set_supply_voltage(self, volts: float) -> None:
        self.supply_voltage = volts

    def full_speed_rpm(self, name: str):
        return {"stirrer": 1544, "purification_stirrer": 1544, "centrifuge": 2500}.get(name)

    def rpm_is_measured(self, key: str) -> bool:
        return False                   # open loop, as on the real machine

    def describe(self) -> dict:
        return {**super().describe(), "backend": "simulated"}

    def _write_heater(self, on: bool) -> None:
        self._advance(0)

    def _write_electrode_power(self, on: bool) -> None:
        self._advance(0)

    def _write_valve(self, name: str, is_open: bool) -> None:
        self._advance(0)

    def _write_motor(self, name: str, duty: float) -> None:
        self._advance(0)

    def _write_pump(self, name: str, on: bool) -> None:
        self._advance(0)
        if name == "oil" and on and self.reactor_g < 1:
            with self._lock:                # oil into an empty reactor = a new batch
                self.oil_g = 0.0
                self.centrifuge_g = self.biodiesel_left_g = self.tank_g = 0.0

    def _write_current_limit(self, amps: float) -> None:
        self.supply_current_limit = amps

    def _write_voltage(self, volts: float) -> None:
        self.supply_voltage = volts


MockHardware = SimulatedMachine
