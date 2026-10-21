"""The pumps into the reactor, stopped by the operator.

The oil pump ("oil"), pump A ("catalyst": NaOH/KOH dissolved in methanol) and pump B ("acid":
H2SO4 in methanol) each empty a container that the operator has filled with the exact amount from
the website's calculation. The pump is switched on when its step opens on the website (Oil Loading,
or the reaction stage's loading) and stays on until the operator presses:
- Done (finish()): everything has been pumped in; the dose counts as loaded (deliveredG = targetG),
- Stop (stop()): it stops now and can be started again for the rest.
A pump left running for MAX_RUN_MINUTES stops by itself with a fault (a forgotten or empty pump).

The transfers after the reactor (the reactor pump, the centrifuge and pumpin) run with the
separation stage (stages.py), and the purification outlet with purification (purification.py).
"""
import asyncio
from datetime import datetime
from typing import Callable, Optional

from .hardware import Hardware, InterlockError, PUMP_LABELS

MAX_RUN_MINUTES = 30    # safety stop for a pump nobody switched off


class TransferError(Exception):
    pass


class PumpRunner:
    def __init__(self, hw: Hardware, time_scale: float = 1.0):
        self.hw = hw
        self.time_scale = time_scale            # tests only (the simulated machine runs faster)
        self._task: Optional[asyncio.Task] = None
        self._stop_reason = "stopped by operator"
        self._finish = False
        self.state = self._idle_state()

    @staticmethod
    def _idle_state() -> dict:
        return {"pump": None, "phase": "idle", "batchId": None, "stage": None, "targetG": 0.0,
                "volumeMl": 0.0, "deliveredG": 0.0, "elapsedSeconds": 0, "maxSeconds": 0,
                "faultReason": None, "startedAt": None}

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def start(self, pump: str, target_g: float, volume_ml: float, batch_id: Optional[str] = None,
              stage: Optional[str] = None, on_finish: Optional[Callable[[dict], None]] = None,
              max_minutes: float = MAX_RUN_MINUTES) -> None:
        """Switches the pump on. target_g / volume_ml: the amount the operator measured into its
        container (for the record). Raises TransferError or InterlockError."""
        if self.running:
            raise TransferError(f"{PUMP_LABELS[self.state['pump']]} is already running.")
        self.state = {**self._idle_state(), "pump": pump, "phase": "pumping", "batchId": batch_id,
                      "stage": stage, "targetG": round(target_g, 1), "volumeMl": round(volume_ml, 1),
                      "maxSeconds": round(max_minutes * 60),
                      # tells this run apart from the previous one (the website adds the runs up)
                      "startedAt": datetime.now().isoformat(timespec="milliseconds")}
        self._finish = False
        try:
            self.hw.set_pump(pump, True)   # InterlockError when it isn't allowed (or the controller is offline)
        except Exception:
            self.state = self._idle_state()
            raise
        self._task = asyncio.create_task(self._run(on_finish))

    def finish(self) -> None:
        """Done: the operator has seen the container empty; everything is in the reactor."""
        if not self.running:
            raise TransferError("No pump is running.")
        self._finish = True

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

    async def _run(self, on_finish) -> None:
        st = self.state
        cancelled = False
        try:
            while not self._finish:
                await asyncio.sleep(1 / self.time_scale)   # one second
                st["elapsedSeconds"] += 1
                if self._finish:
                    break
                if st["elapsedSeconds"] >= st["maxSeconds"]:
                    raise TransferError(f"it ran for {st['maxSeconds'] // 60} min without Done being pressed "
                                        "(is the container empty, or the line blocked?)")
            st["deliveredG"] = st["targetG"]             # the measured amount has all gone in
            st["phase"] = "done"
        except asyncio.CancelledError:
            cancelled = True
            st["phase"], st["faultReason"] = "stopped", self._stop_reason
        except (TransferError, InterlockError) as e:
            st["phase"], st["faultReason"] = "fault", str(e)
        except Exception as e:   # a hardware error: the pump goes off
            st["phase"], st["faultReason"] = "fault", f"unexpected error: {e}"
        finally:
            try:
                self.hw.set_pump(st["pump"], False)
            except Exception:
                pass
        if on_finish:
            try:
                on_finish(dict(st))
            except Exception:
                pass
        if cancelled:
            raise asyncio.CancelledError


__all__ = ["PumpRunner", "TransferError", "InterlockError", "MAX_RUN_MINUTES"]
