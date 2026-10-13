"""Moving liquids: the dosing pumps and the outlet valves.

PumpRunner loads one dose into the main reactor with pump A (NaOH/KOH + methanol) or pump B
(H2SO4 + methanol). It stops when the reactor's load cell has risen by the dose's weight. Without
a load cell reading it runs for the dose's volume at the pump's rate instead. It faults when
nothing arrives (empty tank, blocked line) or when it takes much longer than expected.

DrainRunner opens an outlet valve for a set time, then closes it:
- reactor outlet after transesterification (reactor -> centrifuge),
- centrifuge outlet after separation (centrifuge -> purification tank). It first waits for the
  centrifuge to stop: until its RPM reads (almost) 0, or for the spin-down time without an RPM sensor.

Both run on the Pi, so closing the website never leaves a pump on or a valve open.
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
        self.hw.set_pump(pump, True)       # raises InterlockError when it isn't allowed
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
                        self.hw.demo_add("reactor", max(st["targetG"] - st["deliveredG"], 0.0))
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


class DrainRunner:
    def __init__(self, hw: Hardware, time_scale: float = 1.0):
        self.hw = hw
        self.time_scale = time_scale
        self._task: Optional[asyncio.Task] = None
        self._skip = False
        self._stop_reason = "stopped"
        self._on_open: Optional[Callable[[], None]] = None
        self.state = self._idle_state()

    @staticmethod
    def _idle_state() -> dict:
        return {"valve": None, "phase": "idle", "batchId": None, "elapsedSeconds": 0,
                "totalSeconds": 0, "remainingSeconds": 0, "waitingFor": None, "waitedSeconds": 0,
                "faultReason": None, "startedAt": None}

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def start(self, valve: str, seconds: float, batch_id: Optional[str] = None,
              on_finish: Optional[Callable[[dict], None]] = None,
              wait_rpm: Optional[str] = None, spin_down_seconds: float = 0,
              on_open: Optional[Callable[[], None]] = None) -> None:
        """wait_rpm: the RPM reading to wait for (e.g. "centrifugeRpm") before opening. Without
        that reading, it waits spin_down_seconds instead. on_open is called when the valve opens."""
        if self.running:
            raise TransferError(f"The {self.state['valve'].replace('_', ' ')} is still draining.")
        total = round(seconds)
        self.state = {**self._idle_state(), "valve": valve, "phase": "waiting" if wait_rpm else "draining",
                      "batchId": batch_id, "totalSeconds": total, "remainingSeconds": total,
                      "waitingFor": "the centrifuge to stop" if wait_rpm else None,
                      "startedAt": datetime.now().isoformat(timespec="milliseconds")}
        self._skip = False
        self._on_open = on_open
        if not wait_rpm:
            self.hw.set_valve(valve, True)     # raises InterlockError when it isn't allowed
            if on_open:
                on_open()
        self._task = asyncio.create_task(self._run(on_finish, wait_rpm, spin_down_seconds))

    def skip(self) -> None:
        """Demo mode only: finish draining now."""
        if self.running:
            self._skip = True

    async def stop(self, reason: str = "stopped") -> None:
        if self.running:
            self._stop_reason = reason
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _wait_until_stopped(self, rpm_key: str, spin_down_seconds: float) -> None:
        st = self.state
        limit = max(120, spin_down_seconds * 4)
        while True:
            rpm = self.hw.read().get(rpm_key)
            if self._skip or (rpm is not None and rpm <= STOPPED_RPM) \
                    or (rpm is None and st["waitedSeconds"] >= spin_down_seconds):
                return
            if st["waitedSeconds"] >= limit:
                raise TransferError(f"the centrifuge still reads {rpm:g} RPM after {limit:g} s")
            await asyncio.sleep(1 / self.time_scale)
            st["waitedSeconds"] += 1

    async def _run(self, on_finish, wait_rpm: Optional[str] = None, spin_down_seconds: float = 0) -> None:
        st = self.state
        cancelled = False
        try:
            if wait_rpm:
                await self._wait_until_stopped(wait_rpm, spin_down_seconds)
                st["phase"], st["waitingFor"] = "draining", None
                self.hw.set_valve(st["valve"], True)
                if self._on_open:
                    self._on_open()
            while st["remainingSeconds"] > 0:
                if self._skip:
                    if hasattr(self.hw, "demo_finish_drain"):
                        self.hw.demo_finish_drain(st["valve"])
                    break
                await asyncio.sleep(1 / self.time_scale)
                st["elapsedSeconds"] += 1
                st["remainingSeconds"] = max(st["totalSeconds"] - st["elapsedSeconds"], 0)
            st["remainingSeconds"] = 0
            st["phase"] = "done"
        except asyncio.CancelledError:
            cancelled = True
            st["phase"], st["faultReason"] = "stopped", self._stop_reason
        except (TransferError, InterlockError) as e:
            st["phase"], st["faultReason"] = "fault", str(e)
        except Exception as e:
            st["phase"], st["faultReason"] = "fault", f"unexpected error: {e}"
        finally:
            self.hw.set_valve(st["valve"], False)
        if on_finish:
            on_finish(dict(st))
        if cancelled:
            raise asyncio.CancelledError


__all__ = ["PumpRunner", "DrainRunner", "TransferError", "InterlockError"]
