"""Esterification, Transesterification and Separation stages.

Matches the website's stage controls (NewBatch.tsx): state is "ready", "running", "paused",
"complete" or "fault", with Start, Pause, Resume, Record completion and Emergency stop.

- Reactions: electrode power relay ON and the stirrer running. They stop by themselves when the
  reaction time is over, and fault if the temperature passes reactionMaximumTemperature, or if
  the measured current stays above the current setting (default 1 A) for 2 seconds.
  When the Pi can set the power supply's current limit (config.POWER_SUPPLY_CURRENT_CONTROL), it
  sets it to the current setting at the start; otherwise the operator sets it on the supply.
- Separation (starts by itself when transesterification has finished): the mixture first
  settles in the reactor for 1 minute (REACTOR_SETTLE_S, everything off), then the reactor pump
  (reactor -> centrifuge), the centrifuge (at the batch's separation speed) and pumpin
  (centrifuge -> purifier) run together for the batch's separation time, so the biodiesel goes
  on to the purifier at once and doesn't stay in the centrifuge. All three stop at the end, and
  purification starts (api.py). The separation time and speed are set per batch on the website
  (Volume & Parameters), with Settings separationTime / separationSpeed as the defaults.
- Pause switches everything off and stops the timer; Resume switches it back on.
Stirrer and centrifuge speeds are set open-loop (PWM = RPM ÷ the RPM at full speed: the ESP32
sketch's MAX_RPM and [centrifuge] max_rpm in ESP32 mode, otherwise the max RPM in Settings) until
you add closed-loop control with your RPM sensors.
"""
import asyncio
from typing import Callable, Optional

from .hardware import Hardware
from .models import Settings

REACTIONS = ("Esterification", "Transesterification")
OVERCURRENT_SECONDS = 2   # readings in a row above the setting before the electrodes stop
REACTOR_SETTLE_S = 60     # after transesterification: settle in the reactor before separation
SEPARATION_TIME_MIN, SEPARATION_TIME_MAX = 1, 180      # minutes
SEPARATION_SPEED_MIN = 100                             # RPM (the maximum is the centrifuge's)


def separation_limits(hw: Hardware, s: Settings) -> dict:
    """The separation time and speed the website may set, and their defaults (the speed default
    is the Settings value, but never above what the centrifuge can do)."""
    top = float(hw.full_speed_rpm("centrifuge") or s.centrifuge_max_rpm)
    return {"timeMin": SEPARATION_TIME_MIN, "timeMax": SEPARATION_TIME_MAX,
            "timeDefault": min(max(float(s.separation_time), SEPARATION_TIME_MIN), SEPARATION_TIME_MAX),
            "speedMin": SEPARATION_SPEED_MIN, "speedMax": top,
            "speedDefault": min(max(float(s.separation_speed), SEPARATION_SPEED_MIN), top),
            "settleSeconds": REACTOR_SETTLE_S}


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
        self._over_current = 0
        self.state = self._ready_state()

    @staticmethod
    def _ready_state() -> dict:
        return {"stage": None, "state": "ready", "batchId": None, "voltage": None, "timeMinutes": None,
                "stirringRpm": None, "speedRpm": None, "current": None, "currentLimitSet": False, "elapsedSeconds": 0, "remainingSeconds": 0,
                # separation: "settling" (in the reactor, everything off) then "separating"
                "phase": None, "settleTotalSeconds": 0, "settleRemainingSeconds": 0,
                "liveVoltage": None, "liveCurrent": None, "liveTemperature": None, "liveRpm": None,
                "averageTemperature": None, "faultReason": None}

    @property
    def active(self) -> bool:
        return self.state["state"] in ("running", "paused")

    # ----- controls -----
    def start(self, stage: str, s: Settings, batch_id: Optional[str] = None,
              voltage: Optional[float] = None, time_min: Optional[float] = None,
              stirring: Optional[float] = None,
              on_event: Optional[Callable[[str, dict], None]] = None,
              current: Optional[float] = None, speed: Optional[float] = None,
              settle_seconds: int = 0) -> None:
        """Reactions: voltage, time_min, stirring and current (the website's values, else the
        Settings defaults). Separation: time_min and speed (the batch's values, else the
        defaults), after settle_seconds in the reactor."""
        if self.active:
            raise StageError(f"{self.state['stage']} is still {self.state['state']}.")
        if self.state["state"] == "fault":
            raise StageError("Fault — controller reset required.")
        if stage in REACTIONS:
            # Checked now, so the stage doesn't start and then fault a second later. (No temperature
            # check: the reactions run with or without a temperature reading.)
            fault = getattr(self.hw, "link_fault", None)
            if fault:
                raise StageError(f"{stage} can't start: {fault}.")
            limits =s.esterification if stage == "Esterification" else s.transesterification
            voltage = limits.voltage.default if voltage is None else voltage
            time_min = limits.time.default if time_min is None else time_min
            stirring = limits.stirring.default if stirring is None else stirring
            current = limits.current.default if current is None else current
            for name, value, limit in (("Voltage", voltage, limits.voltage), ("Reaction time", time_min, limits.time),
                                       ("Stirring speed", stirring, limits.stirring), ("Current", current, limits.current)):
                if not limit.min <= value <= limit.max:
                    raise StageError(f"{name} must be between {limit.min:g} and {limit.max:g}.")
            self.hw.set_current_limit(current)       # only when the Pi controls the supply
            self.hw.set_supply_voltage(voltage)      # likewise
            speed, settle_seconds = None, 0
        elif stage == "Separation":
            limits = separation_limits(self.hw, s)
            time_min = limits["timeDefault"] if time_min is None else time_min
            speed = limits["speedDefault"] if speed is None else speed
            if not limits["timeMin"] <= time_min <= limits["timeMax"]:
                raise StageError(f"Separation time must be between {limits['timeMin']:g} and {limits['timeMax']:g} min.")
            if not limits["speedMin"] <= speed <= limits["speedMax"]:
                raise StageError(f"Centrifuge speed must be between {limits['speedMin']:g} and {limits['speedMax']:g} RPM.")
            voltage, stirring, current = None, None, None
            settle_seconds = max(int(settle_seconds), 0)
        else:
            raise StageError(f"Unknown stage: {stage}")
        self._settings, self._on_event = s, on_event
        self._temperatures = []
        separation = stage == "Separation"
        self.state = {**self._ready_state(), "stage": stage, "state": "running", "batchId": batch_id,
                      "voltage": voltage, "timeMinutes": time_min, "stirringRpm": stirring, "speedRpm": speed,
                      "current": current, "currentLimitSet": current is not None and self.hw.current_limit_control,
                      "remainingSeconds": round(time_min * 60),
                      "phase": ("settling" if settle_seconds else "separating") if separation else None,
                      "settleTotalSeconds": settle_seconds, "settleRemainingSeconds": settle_seconds}
        self._over_current = 0
        try:
            self._outputs(True)               # InterlockError, or the ESP32 controller offline
        except Exception:
            try:
                self._outputs(False)
            except Exception:
                pass
            self.state = self._ready_state()  # not started: nothing left half on
            raise
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
            full = self.hw.full_speed_rpm("stirrer") or s.stirrer_max_rpm
            self.hw.set_motor("stirrer", self.state["stirringRpm"] / full if on else 0.0)
            self.hw.set_electrode_power(on)
        elif stage == "Separation":
            on = on and self.state["phase"] == "separating"     # everything stays off while it settles
            full = self.hw.full_speed_rpm("centrifuge") or s.centrifuge_max_rpm
            if on:      # the centrifuge first, then pumpin out of it, then the reactor pump into it
                self.hw.set_motor("centrifuge", self.state["speedRpm"] / full)
                self.hw.set_valve("centrifuge_outlet", True)
                self.hw.set_valve("reactor_outlet", True)
            else:       # the reactor pump first, so nothing more goes into a stopped centrifuge
                self.hw.set_valve("reactor_outlet", False)
                self.hw.set_motor("centrifuge", 0.0)
                self.hw.set_valve("centrifuge_outlet", False)

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
                await asyncio.sleep(1 / self.time_scale)   # one second (the tests' simulator runs faster)
                reading = self.hw.read()
                st["liveVoltage"], st["liveCurrent"] = reading.get("voltage"), reading.get("current")
                st["liveTemperature"] = t = reading.get("temperature")
                st["liveRpm"] = reading.get("centrifugeRpm" if st["stage"] == "Separation" else "stirrerRpm")
                if st["state"] != "running":
                    continue
                if st["phase"] == "settling":            # separation: settling in the reactor first
                    st["settleRemainingSeconds"] = max(st["settleRemainingSeconds"] - 1, 0)
                    if st["settleRemainingSeconds"] <= 0:
                        st["phase"] = "separating"
                        self._outputs(True)               # reactor pump + centrifuge + pumpin
                        self._event("pumps and centrifuge started")
                    continue
                st["elapsedSeconds"] += 1
                st["remainingSeconds"] = max(round(st["timeMinutes"] * 60) - st["elapsedSeconds"], 0)
                if st["stage"] in REACTIONS:
                    # no temperature checks in the reactions: the reading is only recorded (if there is one)
                    i = st["liveCurrent"]
                    self._over_current = self._over_current + 1 if i is not None and i > st["current"] else 0
                    if self._over_current >= OVERCURRENT_SECONDS:
                        self._finish("fault", f"current {i:.2f} A went above the {st['current']:g} A setting")
                        break
                    if t is not None:
                        self._temperatures.append(t)
                        st["averageTemperature"] = round(sum(self._temperatures) / len(self._temperatures), 1)
                if st["remainingSeconds"] <= 0:
                    self._finish("complete")
                    break
        except asyncio.CancelledError:
            raise
        except Exception as e:   # any bug or hardware error ends in the safe state
            self.hw.all_off()
            st["state"], st["faultReason"] = "fault", f"unexpected error: {e}"
