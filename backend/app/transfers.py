"""Moving liquids: the dosing pumps and the outlet valves.

PumpRunner loads one dose into the main reactor with pump A (NaOH/KOH + methanol) or pump B
(H2SO4 + methanol), or the batch's oil with the oil pump. It stops when the reactor's load cell has risen by the dose's weight. Without
a load cell reading it runs for the dose's volume at the pump's rate instead. It faults when
nothing arrives (empty tank, blocked line) or when it takes much longer than expected.

DrainRunner opens a transfer outlet when a process finishes and LEAVES IT OPEN (there is no drain
time): the next process starts right away, and every valve is closed only when the batch's
purification has finished (close_all), or on a fault, an emergency stop or a cancel.
- reactor outlet after transesterification (reactor -> centrifuge),
- centrifuge outlet after separation (centrifuge -> purification tank). It first waits for the
  centrifuge to stop (the outlet must not open while it spins): until its RPM reads (almost) 0,
  or for the spin-down time without an RPM sensor (also in ESP32 mode, where the centrifuge's
  RPM is only worked out from its speed setting).

Both run on the Pi, so closing the website never leaves a pump on, and a fault or an emergency
stop always closes the valves.
"""
import asyncio
from datetime import datetime
from typing import Callable, Optional

from .hardware import Hardware, InterlockError

STOP_EARLY_G = 0.5      # stop this much before the target: what's in the line still drips in
FLOW_STEP_G = 1.0       # the load cell must rise at least this much ...
                        # ... within pump_no_flow_seconds, or the pump stops with a fault
STOPPED_RPM = 50        # below this the centrifuge counts as stopped


class TransferError(Exception):
    pass


class PumpRunner:
    def __init__(self, hw: Hardware, time_scale: float = 1.0):
        self.hw = hw
        self.time_scale = time_scale
        self._task: Optional[asyncio.Task] = None
        self._stop_reason = "stopped by operator"
        self._skip = False
        self.state = self._idle_state()

    @staticmethod
    def _idle_state() -> dict:
        return {"pump": None, "phase": "idle", "batchId": None, "stage": None, "targetG": 0.0,
                "volumeMl": 0.0, "deliveredG": 0.0, "startWeightG": None, "byTime": False,
                "elapsedSeconds": 0, "maxSeconds": 0, "faultReason": None, "startedAt": None}

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def start(self, pump: str, target_g: float, volume_ml: float, rate_ml_min: float,
              no_flow_seconds: float, batch_id: Optional[str] = None, stage: Optional[str] = None,
              on_finish: Optional[Callable[[dict], None]] = None) -> None:
        if self.running:
            raise TransferError("A dosing pump is already running.")
        weight = self.hw.read().get("oilMassG")
        expected_s = volume_ml / rate_ml_min * 60
        self.state = {**self._idle_state(), "pump": pump, "phase": "pumping", "batchId": batch_id,
                      "stage": stage, "targetG": round(target_g, 1), "volumeMl": round(volume_ml, 1),
                      "startWeightG": weight, "byTime": weight is None,
                      "maxSeconds": round(expected_s * 2 + 30),
                      # tells this run apart from the previous one (the website adds up partial loads)
                      "startedAt": datetime.now().isoformat(timespec="milliseconds")}
        self._skip = False
        try:
            self.hw.set_pump(pump, True)   # raises InterlockError when it isn't allowed (or the controller is offline)
        except Exception:
            self.state = self._idle_state()
            raise
        self._task = asyncio.create_task(self._run(expected_s, no_flow_seconds, on_finish))

    def skip(self) -> None:
        """Demo mode only: finish loading now (the rest of the dose arrives at once)."""
        if self.running:
            self._skip = True

    async def stop(self, reason: str = "stopped by operator") -> None:
        if self.running:
            self._stop_reason = reason
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    def reset(self) -> None:
        if not self.running:
            self.state = self._idle_state()

    async def _run(self, expected_s: float, no_flow_seconds: float, on_finish) -> None:
        st = self.state
        cancelled = False
        last_rise_g, last_rise_s = 0.0, 0
        try:
            while True:
                await asyncio.sleep(1 / self.time_scale)   # one second (faster in demo mode)
                st["elapsedSeconds"] += 1
                if self._skip:
                    if not st["byTime"] and hasattr(self.hw, "demo_add"):
                        self.hw.demo_add("oil" if st["pump"] == "oil" else "reactor",
                                         max(st["targetG"] - st["deliveredG"], 0.0))
                        self.hw.refresh()
                    st["deliveredG"] = st["targetG"]
                    break
                if st["byTime"]:
                    st["deliveredG"] = round(min(st["elapsedSeconds"] / expected_s, 1) * st["targetG"], 1)
                    if st["elapsedSeconds"] >= expected_s:
                        break
                    continue
                weight = self.hw.read().get("oilMassG")
                if weight is None:
                    raise TransferError("the reactor load cell stopped giving readings")
                st["deliveredG"] = round(max(weight - st["startWeightG"], 0.0), 1)
                if st["deliveredG"] >= st["targetG"] - STOP_EARLY_G:
                    break
                if st["deliveredG"] >= last_rise_g + FLOW_STEP_G:
                    last_rise_g, last_rise_s = st["deliveredG"], st["elapsedSeconds"]
                elif st["elapsedSeconds"] - last_rise_s >= no_flow_seconds:
                    raise TransferError("nothing is arriving in the reactor (empty pump tank or blocked line?)")
                if st["elapsedSeconds"] >= st["maxSeconds"]:
                    raise TransferError("it took much longer than expected (check the pump and its line)")
            st["phase"] = "done"
        except TransferError as e:
            st["phase"], st["faultReason"] = "fault", str(e)
        except asyncio.CancelledError:
            cancelled = True
            st["phase"], st["faultReason"] = "stopped", self._stop_reason
        except Exception as e:   # any bug or hardware error also ends with the pump off
            st["phase"], st["faultReason"] = "fault", f"unexpected error: {e}"
        finally:
            for name in self.hw.pumps:
                self.hw.set_pump(name, False)
        if on_finish:
            on_finish(dict(st))
        if cancelled:
            raise asyncio.CancelledError


TRANSFER_VALVES = ("reactor_outlet", "centrifuge_outlet")


class DrainRunner:
    """The two transfer outlets. open() opens one (after the centrifuge has stopped, for the
    centrifuge outlet) and leaves it open; close_all() closes both. running is True only while
    an outlet is waiting for the centrifuge to stop.

    state: {"valve": the outlet opened last, "phase": "idle" | "waiting" | "open" | "closed" |
    "stopped" | "fault", "batchId", "waitingFor", "waitedSeconds", "openValves": [...],
    "faultReason", "startedAt"}."""

    def __init__(self, hw: Hardware, time_scale: float = 1.0):
        self.hw = hw
        self.time_scale = time_scale
        self._task: Optional[asyncio.Task] = None
        self._skip = False
        self._stop_reason = "stopped"
        self.state = self._idle_state()

    @staticmethod
    def _idle_state() -> dict:
        return {"valve": None, "phase": "idle", "batchId": None, "waitingFor": None, "waitedSeconds": 0,
                "openValves": [], "faultReason": None, "startedAt": None}

    @property
    def running(self) -> bool:
        """True while an outlet waits for the centrifuge to stop before it opens."""
        return self._task is not None and not self._task.done()

    def open_valves(self) -> list[str]:
        return [name for name in TRANSFER_VALVES if self.hw.valves.get(name)]

    def _refresh_open(self) -> None:
        self.state["openValves"] = self.open_valves()

    def snapshot(self) -> dict:
        """The state, with the outlets that are open right now (an emergency stop or a fault may
        have closed them by other means)."""
        return {**self.state, "openValves": self.open_valves()}

    def open(self, valve: str, batch_id: Optional[str] = None, on_open: Optional[Callable[[], None]] = None,
             wait_rpm: Optional[str] = None, spin_down_seconds: float = 0,
             on_fault: Optional[Callable[[str], None]] = None) -> None:
        """Opens a transfer outlet and leaves it open. With wait_rpm, it first waits for the
        centrifuge to stop (RPM at or below 50, or spin_down_seconds without an RPM reading).
        on_open runs once the valve is open (the next process starts there); on_fault runs if it
        can't open. Raises InterlockError when the valve isn't allowed to open right now."""
        if valve not in TRANSFER_VALVES:
            raise ValueError(f"Unknown transfer valve: {valve}")
        if self.running:
            raise TransferError(f"The {self.state['valve'].replace('_', ' ')} is still waiting for the centrifuge to stop.")
        self.state = {**self._idle_state(), "valve": valve, "phase": "waiting" if wait_rpm else "open",
                      "batchId": batch_id, "waitingFor": "the centrifuge to stop" if wait_rpm else None,
                      "startedAt": datetime.now().isoformat(timespec="milliseconds")}
        self._skip = False
        if not wait_rpm:
            try:
                self.hw.set_valve(valve, True)     # raises InterlockError when it isn't allowed
            except InterlockError as e:
                self.state["phase"], self.state["faultReason"] = "fault", str(e)
                self._refresh_open()
                raise
            self._refresh_open()
            if on_open:
                on_open()
            return
        self._refresh_open()
        self._task = asyncio.create_task(self._open_after_stop(wait_rpm, spin_down_seconds, on_open, on_fault))

    def close_all(self) -> list[str]:
        """Closes both transfer outlets (and cancels an outlet still waiting for the centrifuge,
        so it doesn't open later). Returns the ones that were open."""
        if self.running:
            self._task.cancel()
        was_open = self.open_valves()
        for name in TRANSFER_VALVES:
            self.hw.set_valve(name, False)
        if self.state["phase"] in ("open", "waiting") or was_open:
            self.state["phase"] = "closed"
        self.state["waitingFor"] = None
        self._refresh_open()
        return was_open

    def skip(self) -> None:
        """Demo mode only: the centrifuge counts as stopped now, and whatever is still flowing
        through an open outlet arrives at once."""
        self._skip = True
        if hasattr(self.hw, "demo_finish_drain"):
            for name in self.open_valves():
                self.hw.demo_finish_drain(name)

    async def stop(self, reason: str = "stopped") -> list[str]:
        """Stops a wait for the centrifuge and closes both outlets (emergency stop, operator,
        shutdown). Returns the outlets that were open."""
        self._stop_reason = reason
        task = self._task if self.running else None
        was_open = self.close_all()
        if task is not None:
            try:
                await task
            except asyncio.CancelledError:
                pass
        return was_open

    async def _wait_until_stopped(self, rpm_key: str, spin_down_seconds: float) -> None:
        st = self.state
        limit = max(120, spin_down_seconds * 4)
        while True:
            # an RPM worked out from the speed setting (no sensor) can't show the rotor coasting: wait the time
            rpm = self.hw.read().get(rpm_key) if self.hw.rpm_is_measured(rpm_key) else None
            if self._skip or (rpm is not None and rpm <= STOPPED_RPM) \
                    or (rpm is None and st["waitedSeconds"] >= spin_down_seconds):
                return
            if st["waitedSeconds"] >= limit:
                raise TransferError(f"the centrifuge still reads {rpm:g} RPM after {limit:g} s")
            await asyncio.sleep(1 / self.time_scale)
            st["waitedSeconds"] += 1

    async def _open_after_stop(self, rpm_key: str, spin_down_seconds: float,
                               on_open: Optional[Callable[[], None]],
                               on_fault: Optional[Callable[[str], None]]) -> None:
        st = self.state
        try:
            await self._wait_until_stopped(rpm_key, spin_down_seconds)
            self.hw.set_valve(st["valve"], True)
            st["phase"], st["waitingFor"] = "open", None
            self._refresh_open()
        except asyncio.CancelledError:
            st["phase"], st["waitingFor"], st["faultReason"] = "stopped", None, self._stop_reason
            raise
        except Exception as e:   # TransferError, InterlockError, or a hardware error: the valve stays closed
            self.hw.set_valve(st["valve"], False)
            st["phase"], st["waitingFor"] = "fault", None
            st["faultReason"] = str(e) if isinstance(e, (TransferError, InterlockError)) else f"unexpected error: {e}"
            self._refresh_open()
            if on_fault:
                on_fault(st["faultReason"])
            return
        if on_open:
            on_open()


__all__ = ["PumpRunner", "DrainRunner", "TransferError", "InterlockError"]
