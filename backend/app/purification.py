"""Automatic purification: dry wash with an adsorbent, Magnesol (magnesium silicate) or
bentonite, chosen per batch on the website. The steps are the same for both; only the amount
differs (Settings magnesolDose / bentoniteDose, % of the oil weight). The step where the operator
adds it is still called "magnesol" in the code and the API, so older screens keep working.

It starts by itself when the separation stage has finished (the centrifuge timer is over and
pumpin has sent everything to the purifier). Steps, one after the other, run by the Pi:
1. methanol: methanol removal starts at once (no separate heating step) and lasts the methanol
   removal time (default 10 min). The dry wash stirrer runs (200 RPM) and the heater works in
   4-second pulses: on for 4 s, then off; the Pi watches the temperature rise to its highest
   point, and when it is getting lower again (0.2 °C below that highest reading) the heater gets
   the next 4-second pulse, and so on until the 10 minutes are over. No pulse at or above 90 °C.
2. magnesol: heater off, stirrer on. The website shows "Add X g Magnesol (1% of the oil weight)";
   the sequence waits until the operator confirms that it was added.
3. contact: stirred at 200 RPM for the contact time (default 10 min) with the heater off.
4. settle: the stirrer stops and the biodiesel settles for 1 minute (PURIFIER_SETTLE_S).
5. drain: the valve opens and pumpout runs (the purification outlet): purifier -> polishing
   filter -> output container. The run is complete only when the output load cell reading has
   stayed within ±2 g for 30 s (counted once the biodiesel has started arriving). No time limit.
6. complete: the valve closes and pumpout stops (api.py then switches every output off). A "Low
   output – check the polishing filter" warning when less than 70% of the oil weight came out.

Fixed: the 4 s heater pulses, the 90 °C pulse limit, the 95 °C cutoff, the 200 RPM stirrer, the
1 min settle and the drain rule. Settings: methanolRemovalTime and contactTime.

The stirrer's RPM reading is reported (stirrerRpm) only during contact; in the other steps it is
null, so the website shows it only there.

Safety: the heater runs only while the stirrer runs and the heater is submerged (hardware.py
enforces it for every caller), and the valve never opens while the heater is on. No temperature
reading during methanol removal, or above 95 °C: safety stop. Any fault turns the heater and
stirrer off and closes the valve; the operator must acknowledge it.

Phase names: "ready", "methanol", "magnesol", "contact", "settle", "drain",
"complete" or "fault". It runs on the Pi, so closing the website never leaves the heater on.
"""
import asyncio
from typing import Callable, Optional

from .hardware import Hardware
from .models import Settings

HOLD_TEMPERATURE_C = 90        # no heater pulse at or above this (a pulse in progress stops here)
HEATER_PULSE_S = 4             # methanol removal: the heater is switched on for 4 s at a time ...
PULSE_DROP_C = 0.2             # ... again once the reading is this far below its highest point
MAXIMUM_TEMPERATURE_C = 95     # software cutoff: the heater stops above this
STIRRING_SPEED_RPM = 200       # dry wash stirrer target (fixed)
STIRRER_STOPPED_RPM = 100      # with an RPM reading below this, the stirrer counts as not turning
STIRRER_GRACE_S = 5            # seconds the stirrer may read low (spin-up) before the heater stops
DRAIN_STABLE_G = 2             # draining is done when the output stays within ±2 g ...
DRAIN_STABLE_S = 30            # ... for 30 s (the only way the run completes)
LOW_OUTPUT_FRACTION = 0.7      # warn below 70% of the oil weight
PURIFIER_SETTLE_S = 60         # after contact: the stirrer stops and it settles for 1 min

RUNNING_PHASES = ("methanol", "magnesol", "contact", "settle", "drain")
RPM_PHASES = ("contact",)      # the only step whose stirrer RPM reading is reported


class SafetyStop(Exception):
    pass


class PurificationRunner:
    def __init__(self, hw: Hardware, time_scale: float = 1.0):
        self.hw = hw
        self.time_scale = time_scale
        self._task: Optional[asyncio.Task] = None
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
                # no heating step any more: heatingTimeSeconds stays 0 (the record's column needs a value)
                "heatingTimeSeconds": 0, "heaterPulseSeconds": HEATER_PULSE_S, "heaterPulses": 0,
                "pulsePeakTemperature": None,
                "methanolTotalSeconds": 0, "methanolRemainingSeconds": 0,
                # adsorbent: "Magnesol" or "Bentonite"; adsorbentG is its amount (magnesolG = same value, older name)
                "adsorbent": "Magnesol", "adsorbentG": None,
                "magnesolG": None, "magnesolAdded": False, "magnesolWaitSeconds": 0,
                "contactTotalSeconds": 0, "contactRemainingSeconds": 0,
                "settleTotalSeconds": PURIFIER_SETTLE_S, "settleRemainingSeconds": PURIFIER_SETTLE_S,
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
        self.state = {**self._ready_state(), "phase": "methanol", "batchId": batch_id, "automatic": automatic,
                      "liveTemperature": t, "startingTemperature": t, "highestTemperature": t,
                      "methanolTotalSeconds": methanol, "methanolRemainingSeconds": methanol,
                      "contactTotalSeconds": contact, "contactRemainingSeconds": contact,
                      "adsorbent": adsorbent, "adsorbentG": magnesol_g,
                      "magnesolG": magnesol_g, "oilWeightG": round(oil_g, 1) if oil_g else None,
                      "stepRemainingSeconds": None, "stepTotalSeconds": None}
        self._magnesol_added = asyncio.Event()
        self._low_rpm_seconds = 0
        self._task = asyncio.create_task(self._run(s, on_finish))

    def confirm_magnesol(self) -> None:
        """The operator added the Magnesol ("Confirm" on the website)."""
        if not self.running or self.state["phase"] != "magnesol":
            raise RuntimeError("Purification isn't waiting for the Magnesol.")
        self._magnesol_added.set()

    async def abort(self, reason: str = "stopped by operator") -> None:
        if self.running:
            self._abort_reason = reason
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            if self.state["phase"] in RUNNING_PHASES and not self.state["safetyStopReason"]:
                # stopped before its first step ran (same moment as the start): nothing was on yet
                self.hw.set_heater(False)
                self.hw.set_motor("purification_stirrer", 0.0)
                self.hw.set_valve("mesh_bed", False)
                self.state.update(phase="fault", safetyStopReason=reason, safetyStopOccurred=True)

    def acknowledge(self) -> None:
        if self.running:
            raise RuntimeError("Purification is running.")
        self.state = self._ready_state()

    # ----- helpers -----
    async def _tick(self) -> None:
        await asyncio.sleep(1 / self.time_scale)   # one second (the tests' simulator runs faster)
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
        full = self.hw.full_speed_rpm("purification_stirrer") or s.purification_stirrer_max_rpm
        duty = STIRRING_SPEED_RPM / full if on else 0.0
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
        # during methanol removal the heater pulses on and off: these checks hold for the whole step
        if self.hw.heater_on or self.state["phase"] == "methanol":
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
        while st[key] > 0:
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
            # 1. Methanol removal, straight away: valve closed, stirrer on, heater in 4-second pulses.
            #    Pulse -> the temperature rises to its highest point -> once it is getting lower
            #    (PULSE_DROP_C below that point) -> the next pulse. Until the time is over.
            self.hw.set_valve("mesh_bed", False)
            self._stir(s, True)
            self._sync()
            pulse_left = 0          # seconds of the running pulse still to go
            peak = None             # highest reading since the last pulse ended
            first = True            # the first pulse right at the start
            while st["methanolRemainingSeconds"] > 0:
                t = self._check()
                if self.hw.heater_on:
                    if pulse_left <= 0 or t >= target:
                        self.hw.set_heater(False)            # the 2 s are over (or 90 °C reached)
                        peak = t
                else:
                    peak = t if peak is None else max(peak, t)
                    falling = t <= peak - PULSE_DROP_C
                    if (first or falling) and t < target:
                        self.hw.set_heater(True)
                        pulse_left = HEATER_PULSE_S
                        first = False
                        st["heaterPulses"] += 1
                st["pulsePeakTemperature"] = peak
                self._sync()
                self._step(st["methanolRemainingSeconds"], st["methanolTotalSeconds"])
                await self._tick()
                st["methanolRemainingSeconds"] -= 1
                if self.hw.heater_on:
                    pulse_left -= 1

            # 2. Add Magnesol: heater off, stirrer on, wait for the operator
            st["phase"] = "magnesol"
            self.hw.set_heater(False)
            self._step(None, None)
            self._sync()
            while not self._magnesol_added.is_set():
                self._check(required=False)
                self._sync()
                await self._tick()
                st["magnesolWaitSeconds"] += 1
            st["magnesolAdded"] = True

            # 3. Contact: stirred at 200 RPM, heater off
            st["phase"] = "contact"
            await self._countdown("contactRemainingSeconds", check_required=False)

            # 4. Settle: stirrer off for 1 min
            self._stir(s, False)                 # also keeps the heater off
            self.hw.set_heater(False)
            st["phase"] = "settle"
            await self._countdown("settleRemainingSeconds", check_required=False)

            # 5. Drain: valve open + pumpout, until the output load cell has been stable for 30 s
            self._output_base = self.hw.read().get("outputWeightG") or 0.0
            self.hw.set_valve("mesh_bed", True)
            st["phase"] = "drain"
            self._step(None, None)
            self._sync()
            anchor, started = None, False
            while True:
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
            "settlingTimeSeconds": st["settleTotalSeconds"] - st["settleRemainingSeconds"],
            "coolingTimeSeconds": 0,             # no cooling step (its NOT NULL column gets 0)
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
