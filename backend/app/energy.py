"""Energy used by a batch, worked out by the Pi: power × the time each output was on.

There is no electricity meter on the machine, so the energy is computed (not guessed and not left
at 0): every second the sensor loop adds, for each output that is on,

    energy (Wh) += power (W) × 1 s ÷ 3600

- Immersion heater: Settings → Heater power (900 W), for every second it is on (the 4 s pulses).
- Electrodes: the measured voltage × current when a power monitor (INA226) is fitted; otherwise
  the stage's voltage × its current limit (the values the CC/CV module is set to, from Volume &
  Parameters). That is the most the supply can deliver, so the figure is an upper bound.
- Mixers 1 and 2 and the centrifuge: their rated power × the speed setting (duty, 0-1).
- Oil pump, dispensers A and B, reactor pump, pumpin, valve + pumpout: their rated power while on.

The rated powers are in hardware.toml [energy] (watts, from each part's label or datasheet). The
batch's total goes into its record (production_batches.energy, kWh) with a timeline line that
shows each part's share, so every number can be checked.
"""
import threading
import time
from typing import Optional

from . import config

# part key -> label in the batch record
PARTS = {
    "heater": "heater",
    "electrodes": "electrodes",
    "stirrer": "mixer 1",
    "purification_stirrer": "mixer 2",
    "centrifuge": "centrifuge",
    "oil": "oil pump",
    "catalyst": "dispenser A",
    "acid": "dispenser B",
    "reactor_outlet": "reactor pump",
    "centrifuge_outlet": "pumpin",
    "mesh_bed": "valve + pumpout",
}
MAX_STEP_S = 5.0          # a longer gap between readings (a pause, a restart) isn't counted as on-time


class EnergyMeter:
    def __init__(self, ratings: Optional[dict] = None, time_scale: float = 1.0):
        self.ratings = {k: float(v) for k, v in (ratings if ratings is not None else
                                                 config.HARDWARE.get("energy", {})).items()}
        self.heater_watts = 900.0              # Settings → Heater power (set by the sensor loop)
        self.time_scale = time_scale
        self._wh = {key: 0.0 for key in PARTS}
        self._last: Optional[float] = None
        self._lock = threading.Lock()

    def watts(self, hw, reading: dict) -> dict:
        """Power of each part right now (W)."""
        r = self.ratings
        p = {key: 0.0 for key in PARTS}
        if hw.heater_on:
            p["heater"] = self.heater_watts
        if hw.electrode_power_on:
            volts, amps = reading.get("voltage"), reading.get("current")
            if volts is not None and amps is not None:
                p["electrodes"] = float(volts) * float(amps)            # measured (power monitor)
            else:
                volts, amps = hw.supply_setting
                p["electrodes"] = float(volts or 0) * float(amps or 0)  # the CC/CV setting
        for name in ("stirrer", "purification_stirrer", "centrifuge"):
            p[name] = r.get(f"{name}_w", 0.0) * float(hw.motor_duty.get(name, 0.0))
        for name in ("oil", "catalyst", "acid"):
            if hw.pumps.get(name):
                p[name] = r.get(f"{name}_pump_w", 0.0)
        for valve, key in (("reactor_outlet", "reactor_pump_w"), ("centrifuge_outlet", "pumpin_w"),
                           ("mesh_bed", "pumpout_w")):
            if hw.valves.get(valve):
                p[valve] = r.get(key, 0.0)
        return p

    def update(self, hw, reading: dict, now: Optional[float] = None) -> None:
        """Called once per sensor reading: adds what was on since the last call."""
        now = time.monotonic() if now is None else now
        with self._lock:
            if self._last is not None:
                seconds = min((now - self._last) * self.time_scale, MAX_STEP_S)
                for key, watts in self.watts(hw, reading).items():
                    self._wh[key] += watts * seconds / 3600
            self._last = now

    def totals(self) -> dict:
        """Wh per part since the backend started."""
        with self._lock:
            return dict(self._wh)

    @staticmethod
    def used_since(start: Optional[dict], now: dict) -> dict:
        start = start or {}
        return {key: max(0.0, now.get(key, 0.0) - start.get(key, 0.0)) for key in PARTS}

    @staticmethod
    def describe(used_wh: dict) -> tuple[float, str]:
        """(kWh, the timeline line with each part's share)."""
        total_kwh = sum(used_wh.values()) / 1000
        parts = [f"{PARTS[k]} {v / 1000:.3f}" for k, v in used_wh.items() if v >= 0.5]
        if not parts:
            return round(total_kwh, 3), f"Energy used: {total_kwh:.3f} kWh (nothing was switched on)"
        return round(total_kwh, 3), f"Energy used: {total_kwh:.3f} kWh (power × time on: {', '.join(parts)} kWh)"
