"""Automatic purification: dry wash with an adsorbent, Magnesol (magnesium silicate) or
bentonite, chosen per batch on the website. The steps are the same for both; only the amount
differs (Settings magnesolDose / bentoniteDose, % of the oil weight). The step where the operator
adds it is still called "magnesol" in the code and the API, so older screens keep working.

Steps, one after the other, run by the Pi:
1. heating: the dry wash stirrer starts (200 RPM), then the heater, until the biodiesel reaches
   90 °C. At 90 °C the heater switches off and the run goes on to methanol removal. Stops with a
   fault if 90 °C isn't reached within 25 min.
2. methanol: the biodiesel stays at 90 °C for the methanol removal time (default 10 min), so
   leftover methanol evaporates: the heater switches back on only when it drops to 89 °C, and
   off again at 90 °C.
3. magnesol: heater off, stirrer on. The website shows "Add X g Magnesol (1% of the oil weight)";
   the sequence waits until the operator confirms.
4. contact: stirred for the contact time (default 10 min) with the heater off, so the biodiesel
   cools down.
5. drain: the stirrer stops and the purification outlet valve opens: tank -> polishing filter ->
   output container. The run is complete only when the output load cell reading has stayed within
   ±2 g for 30 s (counted once the biodiesel has started arriving). There is no time limit.
6. complete: the valve closes (api.py then closes the reactor and centrifuge outlets too, so
   every valve is closed). A "Low output – check the polishing filter" warning when less than 70%
   of the oil weight came out.

There is no settling or cooling step. Fixed: the 90 °C hold, the 95 °C cutoff, the 200 RPM
stirrer and the drain rule. Settings: methanolRemovalTime and contactTime.

The stirrer's RPM reading is reported (stirrerRpm) only during contact; in the other steps it is
null, so the website shows it only there.

Safety: the heater runs only while the stirrer runs and the heater is submerged (hardware.py
enforces it for every caller), and the valve never opens while the heater is on. Any fault turns
the heater and stirrer off and closes the valve; the operator must acknowledge it.

Phase names: "ready", "heating", "methanol", "magnesol", "contact", "drain", "complete" or
"fault". It runs on the Pi, so closing the website never leaves the heater on.
"""
import asyncio
from typing import Callable, Optional

from .hardware import Hardware
from .models import Settings

HOLD_TEMPERATURE_C = 90        # the heater switches off here (fixed)
HOLD_BAND_C = 1                # methanol removal: back on at 89 °C, off again at 90 °C
MAXIMUM_TEMPERATURE_C = 95     # software cutoff: the heater stops above this
HEATING_TIMEOUT_S = 25 * 60    # 90 °C must be reached within 25 min
STIRRING_SPEED_RPM = 200       # dry wash stirrer target (fixed)
STIRRER_STOPPED_RPM = 100      # with an RPM reading below this, the stirrer counts as not turning
STIRRER_GRACE_S = 5            # seconds the stirrer may read low (spin-up) before the heater stops
DRAIN_STABLE_G = 2             # draining is done when the output stays within ±2 g ...
DRAIN_STABLE_S = 30            # ... for 30 s (the only way the run completes)
LOW_OUTPUT_FRACTION = 0.7      # warn below 70% of the oil weight

RUNNING_PHASES = ("heating", "methanol", "magnesol", "contact", "drain")
RPM_PHASES = ("contact",)      # the only step whose stirrer RPM reading is reported


class SafetyStop(Exception):
    pass


class PurificationRunner:
    def __init__(self, hw: Hardware, time_scale: float = 1.0):
        self.hw = hw
        self.time_scale = time_scale
        self._task: Optional[asyncio.Task] = None
        self._skip = False
        self._magnesol_added: Optional[asyncio.Event] = None   # created in start()
        self._abort_reason = "stopped by operator"
        self._output_base = 0.0
        self._low_rpm_seconds = 0
        self.state = self._ready_state()

    @staticmethod
    def _ready_state() -> dict:
        return {"phase": "ready", "batchId": None, "automatic": False,
                "targetTemperature": HOLD_TEMPERATURE_C, "maximumTemperature": MAXIMUM_TEMPERATURE_C,
                "liveTemperature": None, "startingTemperature": None, "highestTemperature": None,
                "heatingTimeSeconds": 0, "heatingTimeoutSeconds": HEATING_TIMEOUT_S,
                "methanolTotalSeconds": 0, "methanolRemainingSeconds": 0,
                # adsorbent: "Magnesol" or "Bentonite"; adsorbentG is its amount (magnesolG = same value, older name)
                "adsorbent": "Magnesol", "adsorbentG": None,
                "magnesolG": None, "magnesolAdded": False, "magnesolWaitSeconds": 0,
                "contactTotalSeconds": 0, "contactRemainingSeconds": 0,
                # drain: done when stableSeconds reaches stableTargetSeconds (no time limit)
                "drainElapsedSeconds": 0, "stableSeconds": 0, "stableTargetSeconds": DRAIN_STABLE_S,
                "outputWeightG": None, "oilWeightG": None,
                # the current step's timer, for the website: seconds left and the step's length
                "stepRemainingSeconds": None, "stepTotalSeconds": None,
                "heaterOn": False, "valveOpen": False, "heaterOnSeconds": 0,
                # stirrerRpm: the RPM reading, during contact only (null in every other step)
                "stirrerOn": False, "stirrerRpm": None, "stirringSpeed": STIRRING_SPEED_RPM,
                "warning": None, "safetyStopReason": None, "safetyStopOccurred": False, "record": None}

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    # ----- controls -----
    def start(self, s: Settings, batch_id: Optional[str] = None,
              on_finish: Optional[Callable[[dict], None]] = None, oil_g: Optional[float] = None,
              magnesol_g: Optional[float] = None, automatic: bool = False,
              adsorbent: str = "Magnesol") -> None:
        """Starts the whole sequence. oil_g (the batch's oil) sets the low-output check;
        magnesol_g is the amount of the adsorbent (Magnesol or bentonite) to add."""
        if self.running:
            raise RuntimeError("Purification is already running.")
        if self.state["phase"] == "fault":
            raise RuntimeError("Acknowledge the safety stop first.")
        reading = self.hw.read()
        t = reading.get("temperature")
        if t is None:
            raise RuntimeError("No temperature reading. Check the temperature sensor.")
        if reading.get("outputWeightG") is None:
            raise RuntimeError("No reading from the output load cell. Purification finishes only when that "
                               "reading has been stable for 30 s, so check the output load cell first.")
        methanol = round(s.methanol_removal_time * 60)
        contact = round(s.contact_time * 60)
        self.state = {**self._ready_state(), "phase": "heating", "batchId": batch_id, "automatic": automatic,
                      "liveTemperature": t, "startingTemperature": t, "highestTemperature": t,
                      "methanolTotalSeconds": methanol, "methanolRemainingSeconds": methanol,
                      "contactTotalSeconds": contact, "contactRemainingSeconds": contact,
                      "adsorbent": adsorbent, "adsorbentG": magnesol_g,
                      "magnesolG": magnesol_g, "oilWeightG": round(oil_g, 1) if oil_g else None,
                      "stepRemainingSeconds": None, "stepTotalSeconds": None}
        self._skip = False
        self._magnesol_added = asyncio.Event()
        self._low_rpm_seconds = 0
        self._task = asyncio.create_task(self._run(s, on_finish))

    def confirm_magnesol(self) -> None:
        """The operator added the Magnesol ("Confirm" on the website)."""
        if not self.running or self.state["phase"] != "magnesol":
            raise RuntimeError("Purification isn't waiting for the Magnesol.")
        self._magnesol_added.set()

    def skip(self) -> None:
        """Demo mode only: finish the current step now ("Skip timer (demo)" on the website).
        It doesn't confirm the Magnesol: that stays the operator's step."""
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

    # ----- helpers -----
    def _take_skip(self) -> bool:
        skipped, self._skip = self._skip, False
        return skipped

    async def _tick(self) -> None:
        await asyncio.sleep(1 / self.time_scale)   # one second (faster in demo mode)
        if self.hw.heater_on:
            self.state["heaterOnSeconds"] += 1

    def _sync(self) -> None:
        reading = self.hw.read()
        self.state["heaterOn"] = self.hw.heater_on
        self.state["valveOpen"] = self.hw.valves.get("mesh_bed", False)
        self.state["stirrerOn"] = self.hw.motor_duty.get("purification_stirrer", 0) > 0
        # The RPM reading is only shown during contact (not during heating or methanol removal).
        self.state["stirrerRpm"] = (reading.get("purificationStirrerRpm") if self.state["stirrerOn"] else 0) \
            if self.state["phase"] in RPM_PHASES else None

    def _stir(self, s: Settings, on: bool) -> None:
        duty = STIRRING_SPEED_RPM / s.purification_stirrer_max_rpm if on else 0.0
        self.hw.set_motor("purification_stirrer", duty)   # stopping it turns the heater off first

    def _step(self, remaining: Optional[int], total: Optional[int]) -> None:
        self.state["stepRemainingSeconds"], self.state["stepTotalSeconds"] = remaining, total

    def _check(self, required: bool = True) -> Optional[float]:
        """Temperature, level switch and stirrer checks, every second."""
        reading = self.hw.read()
        t = reading.get("temperature")
        self.state["liveTemperature"] = t
        if t is None:
            if required:
                raise SafetyStop("temperature reading lost")
            return None
        if t > MAXIMUM_TEMPERATURE_C:
            raise SafetyStop(f"temperature exceeded {MAXIMUM_TEMPERATURE_C:g} °C")
        if self.hw.heater_on:
            if reading.get("heaterSubmerged") is False:
                raise SafetyStop("biodiesel level dropped below the heater")
            # Safety only (not shown): a fitted RPM sensor that reads a stalled stirrer stops the heater.
            rpm = reading.get("purificationStirrerRpm")
            self._low_rpm_seconds = self._low_rpm_seconds + 1 if rpm is not None and rpm < STIRRER_STOPPED_RPM else 0
            if self._low_rpm_seconds > STIRRER_GRACE_S:
                raise SafetyStop("the purification stirrer stopped turning")
        if self.state["highestTemperature"] is None or t > self.state["highestTemperature"]:
            self.state["highestTemperature"] = t
        return t

    def _collected(self) -> Optional[float]:
        """Biodiesel collected in this run: output load cell minus its reading when the valve opened."""
        raw = self.hw.read().get("outputWeightG")
        return None if raw is None else round(raw - self._output_base, 1)

    async def _countdown(self, key: str, check_required: bool = True) -> None:
        """Counts a timed step down (e.g. contact), one second at a time."""
        st = self.state
        total = st[key.replace("Remaining", "Total")]
        while st[key] > 0 and not self._take_skip():
            self._check(required=check_required)
            self._sync()
            self._step(st[key], total)
            await self._tick()
            st[key] -= 1
        self._step(0, total)

    # ----- the sequence -----
    async def _run(self, s: Settings, on_finish) -> None:
        cancelled = False
        st = self.state
        target = HOLD_TEMPERATURE_C
        try:
            # 1. Heating: valve closed, stirrer first, then the heater, until 90 °C; then the heater stops
            self.hw.set_valve("mesh_bed", False)
            self._stir(s, True)
            self.hw.set_heater(True)
            self._sync()
            while self._check() < target:
                if self._take_skip():
                    if hasattr(self.hw, "demo_set_temperature"):
                        self.hw.demo_set_temperature(target)
                        st["liveTemperature"] = st["highestTemperature"] = max(target, st["highestTemperature"])
                    break
                if st["heatingTimeSeconds"] >= HEATING_TIMEOUT_S:
                    raise SafetyStop(f"{target:g} °C not reached within {HEATING_TIMEOUT_S // 60} min")
                self._step(None, None)
                await self._tick()
                st["heatingTimeSeconds"] += 1
                self._sync()
            self.hw.set_heater(False)            # 90 °C reached: heater off
            self._sync()

            # 2. Methanol removal: stay at 90 °C (heater back on at 89 °C, off again at 90 °C)
            st["phase"] = "methanol"
            while st["methanolRemainingSeconds"] > 0 and not self._take_skip():
                t = self._check()
                if t >= target and self.hw.heater_on:
                    self.hw.set_heater(False)
                elif t <= target - HOLD_BAND_C and not self.hw.heater_on:
                    self.hw.set_heater(True)
                self._sync()
                self._step(st["methanolRemainingSeconds"], st["methanolTotalSeconds"])
                await self._tick()
                st["methanolRemainingSeconds"] -= 1

            # 3. Add Magnesol: heater off, stirrer on, wait for the operator
            self.hw.set_heater(False)
            st["phase"] = "magnesol"
            self._step(None, None)
            self._sync()
            while not self._magnesol_added.is_set():
                self._check(required=False)
                self._sync()
                await self._tick()
                st["magnesolWaitSeconds"] += 1
            st["magnesolAdded"] = True

            # 4. Contact: stirred, heater off, the biodiesel cools down
            st["phase"] = "contact"
            await self._countdown("contactRemainingSeconds", check_required=False)

            # 5. Drain: stirrer off, outlet open, until the output load cell has been stable for 30 s
            self._stir(s, False)                 # also keeps the heater off
            self.hw.set_heater(False)
            self._output_base = self.hw.read().get("outputWeightG") or 0.0
            self.hw.set_valve("mesh_bed", True)
            st["phase"] = "drain"
            self._step(None, None)
            self._sync()
            anchor, started = None, False
            while True:
                if self._take_skip():
                    if hasattr(self.hw, "demo_finish_flow"):
                        self.hw.demo_finish_flow()
                    break
                self._check(required=False)
                weight = self._collected()
                st["outputWeightG"] = weight
                if weight is None:            # no reading: nothing can count as stable
                    anchor, st["stableSeconds"] = None, 0
                else:
                    started = started or weight > DRAIN_STABLE_G
                    if anchor is not None and abs(weight - anchor) <= DRAIN_STABLE_G:
                        st["stableSeconds"] += 1
                    else:
                        anchor, st["stableSeconds"] = weight, 0
                    if started and st["stableSeconds"] >= DRAIN_STABLE_S:
                        break                 # nothing more comes out: drained
                self._sync()
                await self._tick()
                st["drainElapsedSeconds"] += 1
            self.hw.set_valve("mesh_bed", False)
            self.hw.refresh()
            st["outputWeightG"] = self._collected()
            st["warning"] = self._output_warning()
            st["phase"] = "complete"
            self._step(None, None)
        except SafetyStop as e:
            st["safetyStopReason"] = str(e)
        except asyncio.CancelledError:
            cancelled = True
            st["safetyStopReason"] = self._abort_reason
        except Exception as e:   # any bug or hardware error also ends in the safe state
            st["safetyStopReason"] = f"unexpected error: {e}"
        finally:
            self.hw.set_heater(False)
            self.hw.set_motor("purification_stirrer", 0.0)
            self.hw.set_valve("mesh_bed", False)
            self._sync()
        if st["safetyStopReason"]:
            st["phase"] = "fault"
            st["safetyStopOccurred"] = True
        st["stirrerRpm"] = None
        st["record"] = {
            "targetTemperature": target,
            "highestTemperature": st["highestTemperature"],
            "heatingTimeSeconds": st["heatingTimeSeconds"],
            "holdTimeSeconds": st["methanolTotalSeconds"] - st["methanolRemainingSeconds"],
            "magnesolG": st["magnesolG"],
            "adsorbent": st["adsorbent"],
            "adsorbentG": st["adsorbentG"],
            "magnesolAdded": st["magnesolAdded"],
            "contactTimeSeconds": st["contactTotalSeconds"] - st["contactRemainingSeconds"],
            # no settling or cooling step any more: their (NOT NULL) columns get 0
            "settlingTimeSeconds": 0,
            "coolingTimeSeconds": 0,
            "drainTimeSeconds": st["drainElapsedSeconds"],
            "automatic": st["automatic"],
            "warning": st["warning"],
            "safetyStopOccurred": st["safetyStopOccurred"],
            "safetyStopReason": st["safetyStopReason"],
            "outputWeightG": st["outputWeightG"],
            "oilWeightG": st["oilWeightG"],
            "heaterOnSeconds": st["heaterOnSeconds"],
            "stirringSpeed": STIRRING_SPEED_RPM,
        }
        if on_finish:
            on_finish(st["record"])
        if cancelled:
            raise asyncio.CancelledError

    def _output_warning(self) -> Optional[str]:
        """Less than 70% of the oil weight usually means the filter is blocked."""
        weight, oil = self.state["outputWeightG"], self.state["oilWeightG"]
        if weight is None or not oil:
            return None
        if weight < LOW_OUTPUT_FRACTION * oil:
            return f"Low output – check the polishing filter. {weight:.0f} g collected from {oil:.0f} g of oil."
        return None
