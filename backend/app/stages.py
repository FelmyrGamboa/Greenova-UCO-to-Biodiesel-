"""Esterification, Transesterification and Separation stages.

Matches the website's stage controls (NewBatch.tsx): state is "ready", "running", "paused",
"complete" or "fault", with Start, Pause, Resume, Record completion and Emergency stop.

- Reactions: electrode power relay ON and the stirrer running. They stop by themselves when the
  reaction time is over, and fault if the temperature passes reactionMaximumTemperature.
- Separation: the centrifuge runs for separationTime at separationSpeed.
- Pause switches everything off and stops the timer; Resume switches it back on.
Stirrer and centrifuge speeds are set open-loop (PWM = RPM ÷ max RPM in Settings) until you
add closed-loop control with your RPM sensors.
"""
import asyncio
from typing import Callable, Optional

from .hardware import Hardware
from .models import Settings

REACTIONS = ("Esterification", "Transesterification")


class StageError(Exception):
    pass


class StageRunner:
    def __init__(self, hw: Hardware, time_scale: float = 1.0):
        self.hw = hw
        self.time_scale = time_scale
        self._task: Optional[asyncio.Task] = None
        self._settings: Optional[Settings] = None
        self._on_event: Optional[Callable[[str, dict], None]] = None
        self._temperatures: list[float] = []
        self.state = self._ready_state()

    @staticmethod
    def _ready_state() -> dict:
        return {"stage": None, "state": "ready", "batchId": None, "voltage": None, "timeMinutes": None,
                "stirringRpm": None, "speedRpm": None, "elapsedSeconds": 0, "remainingSeconds": 0,
                "liveVoltage": None, "liveCurrent": None, "liveTemperature": None, "liveRpm": None,
                "averageTemperature": None, "energyKwh": 0.0, "faultReason": None}

    @property
    def active(self) -> bool:
        return self.state["state"] in ("running", "paused")

    # ----- controls -----
    def start(self, stage: str, s: Settings, batch_id: Optional[str] = None,
              voltage: Optional[float] = None, time_min: Optional[float] = None,
              stirring: Optional[float] = None,
              on_event: Optional[Callable[[str, dict], None]] = None) -> None:
        if self.active:
            raise StageError(f"{self.state['stage']} is still {self.state['state']}.")
        if self.state["state"] == "fault":
            raise StageError("Fault — controller reset required.")
        if stage in REACTIONS:
            limits = s.esterification if stage == "Esterification" else s.transesterification
            voltage = limits.voltage.default if voltage is None else voltage
            time_min = limits.time.default if time_min is None else time_min
            stirring = limits.stirring.default if stirring is None else stirring
            for name, value, limit in (("Voltage", voltage, limits.voltage), ("Reaction time", time_min, limits.time),
                                       ("Stirring speed", stirring, limits.stirring)):
                if not limit.min <= value <= limit.max:
                    raise StageError(f"{name} must be between {limit.min:g} and {limit.max:g}.")
            if hasattr(self.hw, "supply_voltage"):
                self.hw.supply_voltage = voltage      # demo: the simulated supply follows the setting
        else:
            voltage, stirring, time_min = None, None, s.separation_time
        self._settings, self._on_event = s, on_event
        self._temperatures = []
        self.state = {**self._ready_state(), "stage": stage, "state": "running", "batchId": batch_id,
                      "voltage": voltage, "timeMinutes": time_min, "stirringRpm": stirring,
                      "speedRpm": s.separation_speed if stage == "Separation" else None,
                      "remainingSeconds": round(time_min * 60)}
        self._outputs(True)
        self._event("started")
        self._task = asyncio.create_task(self._run())

    def pause(self) -> None:
        if self.state["state"] != "running":
            raise StageError("Only a running stage can be paused.")
        self._outputs(False)
        self.state["state"] = "paused"
        self._event("paused")

    def resume(self) -> None:
        if self.state["state"] != "paused":
            raise StageError("Only a paused stage can be resumed.")
        self._outputs(True)
        self.state["state"] = "running"
        self._event("resumed")

    def complete(self) -> None:
        """"Record completion" on the website, or the timer running out."""
        if not self.active:
            raise StageError("No stage is running.")
        self._finish("complete")

    async def emergency_stop(self, reason: str = "emergency stop") -> None:
        self.hw.all_off()
        if self.active:
            self._finish("fault", reason)
        await self._stop_task()

    def reset(self) -> None:
        """"Controller reset" after a fault, or before the next stage."""
        if self.active:
            raise StageError("Stop the running stage first.")
        self.state = self._ready_state()

    # ----- internals -----
    def _outputs(self, on: bool) -> None:
        s, stage = self._settings, self.state["stage"]
        if stage in REACTIONS:
            self.hw.set_motor("stirrer", self.state["stirringRpm"] / s.stirrer_max_rpm if on else 0.0)
            self.hw.set_electrode_power(on)
        elif stage == "Separation":
            self.hw.set_motor("centrifuge", s.separation_speed / s.centrifuge_max_rpm if on else 0.0)

    def _event(self, what: str) -> None:
        if self._on_event and self.state["batchId"]:
            self._on_event(f"{self.state['stage']} {what}", dict(self.state))

    def _finish(self, result: str, reason: Optional[str] = None) -> None:
        self._outputs(False)
        if self.state["stage"] in REACTIONS:
            self.hw.set_electrode_power(False)
        self.state["state"] = result
        self.state["faultReason"] = reason
        self._event("completed" if result == "complete" else f"stopped ({reason})")

    async def _stop_task(self) -> None:
        if self._task and not self._task.done() and self._task is not asyncio.current_task():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _run(self) -> None:
        st, s = self.state, self._settings
        try:
            while st["state"] in ("running", "paused"):
                await asyncio.sleep(1 / self.time_scale)   # one second (faster in demo mode)
                reading = self.hw.read()
                st["liveVoltage"], st["liveCurrent"] = reading.get("voltage"), reading.get("current")
                st["liveTemperature"] = t = reading.get("temperature")
                st["liveRpm"] = reading.get("centrifugeRpm" if st["stage"] == "Separation" else "stirrerRpm")
                if st["state"] != "running":
                    continue
                st["elapsedSeconds"] += 1
                st["remainingSeconds"] = max(round(st["timeMinutes"] * 60) - st["elapsedSeconds"], 0)
                if st["stage"] in REACTIONS:
                    if t is None:
                        self._finish("fault", "temperature reading lost")
                        break
                    if t > s.reaction_maximum_temperature:
                        self._finish("fault", f"temperature exceeded {s.reaction_maximum_temperature:g} °C")
                        break
                    self._temperatures.append(t)
                    st["averageTemperature"] = round(sum(self._temperatures) / len(self._temperatures), 1)
                    if st["liveVoltage"] is not None and st["liveCurrent"] is not None:
                        st["energyKwh"] += st["liveVoltage"] * st["liveCurrent"] / 3_600_000   # 1 s of V × A
                if st["remainingSeconds"] <= 0:
                    self._finish("complete")
                    break
        except asyncio.CancelledError:
            raise
        except Exception as e:   # any bug or hardware error ends in the safe state
            self.hw.all_off()
            st["state"], st["faultReason"] = "fault", f"unexpected error: {e}"
