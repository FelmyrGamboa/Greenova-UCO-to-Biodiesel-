"""Automatic purification: heating → hold → mesh bed flow → drain → complete.

It runs by itself, without operator confirmations:
1. Heating: heater on, valve closed, until the target (default 70 °C). With a heater sized for the
   batch this takes about a minute.
2. Hold: the target ±1 °C for the hold time (default 25 min), so leftover methanol evaporates.
3. Mesh bed flow: heater off, then the valve opens for the planned flow time = the batch's
   biodiesel volume (about its oil volume) ÷ the mesh bed flow rate (default 40 mL/min).
4. Drain: the valve stays open until the output weight stops changing for a minute (at most the
   drain time, default 3 min), then closes.
The operator only confirms on the website that the process is finished.

Phase and field names match the website's Purification step (NewBatch.tsx):
phase is "ready", "heating", "hold", "flow", "drain", "complete" or "fault".

It runs on the Pi, not in the browser, so closing the website never leaves the heater on.
Any fault turns the heater off and closes the valve; the operator must acknowledge it.
"""
import asyncio
from collections import deque
from typing import Callable, Optional

from .hardware import Hardware
from .models import Settings

RUNNING_PHASES = ("heating", "hold", "flow", "drain")


class SafetyStop(Exception):
    pass


class PurificationRunner:
    def __init__(self, hw: Hardware, time_scale: float = 1.0):
        self.hw = hw
        self.time_scale = time_scale
        self._task: Optional[asyncio.Task] = None
        self._skip = False
        self._abort_reason = "stopped by operator"
        self._output_base = 0.0
        self.state = self._ready_state()

    @staticmethod
    def _ready_state() -> dict:
        return {"phase": "ready", "batchId": None, "automatic": False, "targetTemperature": None,
                "liveTemperature": None, "startingTemperature": None, "highestTemperature": None,
                "heatingTimeSeconds": 0, "holdTimeSeconds": 0, "holdTotalSeconds": 0, "holdRemainingSeconds": 0,
                "expectedBiodieselMl": None, "plannedFlowSeconds": 0, "flowElapsedSeconds": 0,
                "flowRemainingSeconds": 0, "drainElapsedSeconds": 0, "drainMaximumSeconds": 0,
                "flowStableSeconds": 0, "outputWeightG": None, "flowRateGPerMinute": None,
                "heaterOn": False, "valveOpen": False, "heaterOnSeconds": 0, "warning": None,
                "safetyStopReason": None, "safetyStopOccurred": False, "record": None}

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    # ----- controls -----
    def start(self, s: Settings, target: float, batch_id: Optional[str] = None,
              on_finish: Optional[Callable[[dict], None]] = None, biodiesel_ml: Optional[float] = None,
              automatic: bool = False) -> None:
        """Starts the whole sequence. biodiesel_ml (about the oil volume) sets the flow time."""
        if self.running:
            raise RuntimeError("Purification is already running.")
        if self.state["phase"] == "fault":
            raise RuntimeError("Acknowledge the safety stop first.")
        if not 40 <= target <= 70:
            raise RuntimeError("Target temperature must be between 40 and 70 °C.")
        if target >= s.purification_maximum_temperature:
            raise RuntimeError(f"Target must be below the {s.purification_maximum_temperature:g} °C cutoff.")
        t = self.hw.read().get("temperature")
        if t is None:
            raise RuntimeError("No temperature reading. Check the temperature sensor.")
        planned = s.planned_flow_seconds(biodiesel_ml)
        hold = round(s.purification_hold_time * 60)
        self.state = {**self._ready_state(), "phase": "heating", "batchId": batch_id, "automatic": automatic,
                      "targetTemperature": target, "liveTemperature": t, "startingTemperature": t,
                      "highestTemperature": t, "holdTotalSeconds": hold, "holdRemainingSeconds": hold,
                      "expectedBiodieselMl": round(biodiesel_ml, 1) if biodiesel_ml else None,
                      "plannedFlowSeconds": planned, "flowRemainingSeconds": planned,
                      "drainMaximumSeconds": round(s.drain_time * 60)}
        self._skip = False
        self._task = asyncio.create_task(self._run(s, target, on_finish))

    def skip(self) -> None:
        """Demo mode only: finish the current phase now ("Skip timer (demo)" on the website)."""
        if self.running:
            self._skip = True

    async def abort(self, reason: str = "stopped by operator") -> None:
        if self.running:
            self._abort_reason = reason
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    def acknowledge(self) -> None:
        if self.running:
            raise RuntimeError("Purification is running.")
        self.state = self._ready_state()

    # ----- sequence -----
    def _take_skip(self) -> bool:
        skipped, self._skip = self._skip, False
        return skipped

    async def _tick(self) -> None:
        await asyncio.sleep(1 / self.time_scale)   # one second (faster in demo mode)
        if self.hw.heater_on:
            self.state["heaterOnSeconds"] += 1

    def _sync(self) -> None:
        self.state["heaterOn"] = self.hw.heater_on
        self.state["valveOpen"] = self.hw.valves.get("mesh_bed", False)

    def _check_temperature(self, s: Settings, required: bool = True) -> Optional[float]:
        t = self.hw.read().get("temperature")
        self.state["liveTemperature"] = t
        if t is None:
            if required:
                raise SafetyStop("temperature reading lost")
            return None
        if t > s.purification_maximum_temperature:
            raise SafetyStop(f"temperature exceeded {s.purification_maximum_temperature:g} °C")
        if self.hw.heater_on and self.hw.read().get("heaterSubmerged") is False:
            raise SafetyStop("biodiesel level dropped below the heater")
        if self.state["highestTemperature"] is None or t > self.state["highestTemperature"]:
            self.state["highestTemperature"] = t
        return t

    def _collected(self) -> Optional[float]:
        """Biodiesel collected in this run: output load cell minus its reading when the valve opened."""
        raw = self.hw.read().get("outputWeightG")
        return None if raw is None else round(raw - self._output_base, 1)

    def _track_output(self, history: deque) -> Optional[float]:
        """Output weight, flow rate over the last minute, and seconds without change."""
        st = self.state
        weight = self._collected()
        st["outputWeightG"] = weight
        if weight is not None:
            st["flowStableSeconds"] = (st["flowStableSeconds"] + 1
                                       if history and abs(weight - history[-1]) < 0.5 else 0)
            history.append(weight)
            if len(history) > 1:
                st["flowRateGPerMinute"] = round((history[-1] - history[0]) / ((len(history) - 1) / 60), 1)
        return weight

    async def _run(self, s: Settings, target: float, on_finish) -> None:
        cancelled = False
        st = self.state
        try:
            # 1. Heating: valve closed, heater on until the target is reached
            self.hw.set_valve("mesh_bed", False)
            self.hw.set_heater(True)
            self._sync()
            while self._check_temperature(s) < target:
                if self._take_skip():
                    if hasattr(self.hw, "demo_set_temperature"):
                        self.hw.demo_set_temperature(target)
                        st["liveTemperature"] = st["highestTemperature"] = max(target, st["highestTemperature"])
                    break
                if st["heatingTimeSeconds"] >= s.heating_timeout * 60:
                    raise SafetyStop(f"target not reached within {s.heating_timeout:g} min")
                await self._tick()
                st["heatingTimeSeconds"] += 1

            # 2. Hold at target ±1 °C so leftover methanol evaporates
            st["phase"] = "hold"
            while st["holdRemainingSeconds"] > 0 and not self._take_skip():
                t = self._check_temperature(s)
                if t <= target - 1 and not self.hw.heater_on:
                    self.hw.set_heater(True)
                elif t >= target + 1 and self.hw.heater_on:
                    self.hw.set_heater(False)
                self._sync()
                await self._tick()
                st["holdRemainingSeconds"] -= 1
            st["holdTimeSeconds"] = st["holdTotalSeconds"] - st["holdRemainingSeconds"]

            # 3. Mesh bed flow: heater off first, then open the valve for the planned time
            self.hw.set_heater(False)
            self._output_base = self.hw.read().get("outputWeightG") or 0.0
            self.hw.set_valve("mesh_bed", True)
            st["phase"] = "flow"
            self._sync()
            history = deque(maxlen=61)   # output weight over the last minute
            while st["flowElapsedSeconds"] < st["plannedFlowSeconds"]:
                if self._take_skip():
                    if hasattr(self.hw, "demo_finish_flow"):
                        self.hw.demo_finish_flow()
                    st["flowElapsedSeconds"] = st["plannedFlowSeconds"]
                    break
                self._check_temperature(s, required=False)   # heater is off: only the maximum matters
                self._track_output(history)
                await self._tick()
                st["flowElapsedSeconds"] += 1
                st["flowRemainingSeconds"] = st["plannedFlowSeconds"] - st["flowElapsedSeconds"]
            st["flowRemainingSeconds"] = 0

            # 4. Drain: valve still open until the output weight stops changing (or the drain time)
            st["phase"] = "drain"
            st["flowStableSeconds"] = 0
            history.clear()
            while st["drainElapsedSeconds"] < st["drainMaximumSeconds"]:
                if self._take_skip():
                    break
                self._check_temperature(s, required=False)
                weight = self._track_output(history)
                if weight is not None and st["flowStableSeconds"] >= s.flow_stable_seconds:
                    break   # nothing more comes out: drained
                await self._tick()
                st["drainElapsedSeconds"] += 1
            self.hw.set_valve("mesh_bed", False)
            self.hw.refresh()
            st["outputWeightG"] = self._collected()
            st["flowRateGPerMinute"] = 0
            st["warning"] = self._output_warning(s)
            st["phase"] = "complete"
        except SafetyStop as e:
            st["safetyStopReason"] = str(e)
        except asyncio.CancelledError:
            cancelled = True
            st["safetyStopReason"] = self._abort_reason
        except Exception as e:   # any bug or hardware error also ends in the safe state
            st["safetyStopReason"] = f"unexpected error: {e}"
        finally:
            self.hw.set_heater(False)
            self.hw.set_valve("mesh_bed", False)
            self._sync()
        if st["safetyStopReason"]:
            st["phase"] = "fault"
            st["safetyStopOccurred"] = True
        st["record"] = {
            "targetTemperature": target,
            "highestTemperature": st["highestTemperature"],
            "heatingTimeSeconds": st["heatingTimeSeconds"],
            "holdTimeSeconds": st["holdTimeSeconds"],
            "flowTimeSeconds": st["flowElapsedSeconds"],
            "drainTimeSeconds": st["drainElapsedSeconds"],
            "expectedBiodieselMl": st["expectedBiodieselMl"],
            "plannedFlowSeconds": st["plannedFlowSeconds"],
            "automatic": st["automatic"],
            "warning": st["warning"],
            "safetyStopOccurred": st["safetyStopOccurred"],
            "safetyStopReason": st["safetyStopReason"],
            "outputWeightG": st["outputWeightG"],
            "heaterOnSeconds": st["heaterOnSeconds"],
        }
        if on_finish:
            on_finish(st["record"])
        if cancelled:
            raise asyncio.CancelledError

    def _output_warning(self, s: Settings) -> Optional[str]:
        """Less than half the expected output usually means the mesh bed is clogged."""
        st = self.state
        weight, expected_ml = st["outputWeightG"], st["expectedBiodieselMl"]
        if weight is None or not expected_ml:
            return None
        expected_g = expected_ml * s.biodiesel_density
        if weight < 0.5 * expected_g:
            return (f"Only {weight:.0f} g came out of about {expected_g:.0f} g expected. "
                    "Check the mesh bed for clogging.")
        return None
