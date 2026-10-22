"""Tests for the calculations, analytics, safety rules and process sequences.
Run from the greenova-backend folder:  python -m pytest"""
import asyncio

import pytest

from app import analytics, calculations, config, db
from tests import sample_batches as seed
from app.hardware import InterlockError
from app.models import Batch, Settings
from app.purification import PurificationRunner
from app.stages import REACTOR_SETTLE_S, StageError, StageRunner, separation_limits
from app.transfers import PumpRunner, TransferError
from tests.simulator import SimulatedMachine

S = Settings()


def run(coro, timeout=120):
    """asyncio.run with a time limit, so a process that never finishes fails the test instead of
    hanging the whole run."""
    return asyncio.run(asyncio.wait_for(coro, timeout))


def approx(value, expected, tol=0.01):
    return abs(value - expected) <= tol


# ---------- settings ----------
def test_settings_use_the_website_keys():
    s = Settings.model_validate({"methanolRemovalTime": 12, "format": "G-{YEAR}-{SEQ}",
                                 "kohPurity": 85, "ffaRangeBoundaries": [0, 3, 6]})
    dumped = s.dump()
    assert dumped["methanolRemovalTime"] == 12 and dumped["format"] == "G-{YEAR}-{SEQ}"
    assert dumped["kohPurity"] == 85 and dumped["ffaRangeBoundaries"] == "0,3,6"
    assert {"methanolRemovalTime", "contactTime", "settlingTime", "maxDrainTemperature", "provenBatchCount",
            "dieselPrice"} <= dumped.keys()
    # old purification keys saved by earlier versions are ignored
    assert Settings.model_validate({"meshBedFlowRate": 40, "purificationTargetTemperature": 70}).methanol_removal_time == 10


def test_purification_and_stage_defaults():
    # settling_time and max_drain_temperature are unused (no settling or cooling step) but kept:
    # the settings table has those columns.
    assert (S.methanol_removal_time, S.contact_time, S.settling_time, S.max_drain_temperature) == (10, 10, 0, 70)
    assert S.reactor_drain_time == 1 and S.centrifuge_drain_time == 2
    assert S.ffa_threshold == 3 and S.ffa_target == 3 and S.auto_advance is True
    for limits in (S.esterification, S.transesterification):
        assert (limits.voltage.min, limits.voltage.max) == (10, 30)
        assert (limits.time.min, limits.time.max, limits.time.default) == (30, 180, 120)
        assert (limits.current.min, limits.current.max, limits.current.default) == (1, 2, 1)   # whole amperes


def test_saved_settings_are_kept_as_they_are(mysql_db):
    """The settings row is read back exactly as saved (startup never rewrites it)."""
    old = Settings()
    old.esterification.voltage.min = 18
    old.reactor_drain_time = 3
    old.ffa_threshold = 4
    db.save_settings(old)
    s = db.get_settings()
    assert s.esterification.voltage.min == 18 and s.reactor_drain_time == 3 and s.ffa_threshold == 4


@pytest.mark.parametrize("bad", [{"ffaRangeBoundaries": "5"}, {"methanolRemovalTime": 4},
                                 {"methanolRemovalTime": 31}, {"maxDrainTemperature": 95}])
def test_settings_validation(bad):
    with pytest.raises(ValueError):
        Settings.model_validate(bad)


# ---------- calculations (same numbers as calculateQuantityCards on the website) ----------
def test_calculator_with_esterification():
    # The strip reads at most 5%, so every batch above 3% gets the uniform dose for 10% FFA
    q = calculations.quantity_cards(460, 5, 7, "NaOH", S)
    assert q["esterificationNeeded"] and q["isEstimate"] and q["uniformDose"] and q["doseFfa"] == 10
    assert approx(q["ffaMassG"], 46) and approx(q["esterificationMethanolMl"], 130.64)
    assert approx(q["sulfuricAcidMl"], 1.242, 0.0001) and approx(q["sulfuricAcidG"], 2.3)
    assert approx(q["acetoneMl"], 50) and approx(q["acetoneG"], 39.2) and approx(q["transesterificationMethanolMl"], 148.01)
    assert approx(q["catalystBaseG"], 4.6) and approx(q["neutralizationG"], 1.9596)
    assert approx(q["catalystToWeighG"], 6.69) and q["purity"] == 98
    # pump B premix: 130.64 mL methanol (103.47 g) + 1.242 mL H2SO4 (2.3 g)
    assert approx(q["esterificationPremixMl"], 131.88) and approx(q["esterificationPremixG"], 105.77)
    # pump A premix: 148.01 mL methanol (117.22 g) + 5.36 g NaOH
    assert approx(q["transesterificationPremixG"], 123.91)
    same = calculations.quantity_cards(460, 4, 7, "NaOH", S)     # all FFA values above 3% use the uniform dose
    assert same["esterificationMethanolMl"] == q["esterificationMethanolMl"]


def test_magnesol_amount():
    # oil mL × 0.92 × 1% = oil mL × 0.0092 g, rounded to 0.1 g
    assert [calculations.magnesol_g(ml, S) for ml in (100, 250, 500, 750, 1000)] == [0.9, 2.3, 4.6, 6.9, 9.2]
    assert calculations.quantity_cards(460, 3, 7, "NaOH", S)["magnesolG"] == 4.6


def test_bentonite_amount_and_materials():
    # bentonite: oil mL × 0.92 × 2% = oil mL × 0.0184 g
    assert [calculations.adsorbent_g(ml, "Bentonite", S) for ml in (100, 500, 1000)] == [1.8, 9.2, 18.4]
    q = calculations.quantity_cards(460, 1, 7, "NaOH", S, "Bentonite")
    assert q["adsorbent"] == "Bentonite" and q["adsorbentG"] == 9.2 and q["bentoniteG"] == 9.2 and q["magnesolG"] == 4.6
    assert calculations.quantity_cards(460, 1, 7, "NaOH", S)["adsorbent"] == "Magnesol"
    assert calculations.adsorbent_g(500, "Bentonite", Settings(bentonite_dose=5)) == 23.0
    m = calculations.materials(500, 1, False, 7, "NaOH", S, adsorbent="Bentonite")
    assert m.bentonite_kg == 0.0092 and m.magnesol_kg == 0
    m = calculations.materials(500, 1, False, 7, "NaOH", S)
    assert m.magnesol_kg == 0.0046 and m.bentonite_kg == 0


def test_design_ffa_setting():
    s = Settings(esterification_design_ffa=8)
    q = calculations.quantity_cards(460, 5, 7, "NaOH", s)
    assert q["doseFfa"] == 8 and approx(q["esterificationMethanolMl"], 104.51)
    with pytest.raises(ValueError):
        Settings(esterification_design_ffa=1)     # must be above the 3% threshold


def test_calculator_without_esterification():
    q = calculations.quantity_cards(460, 1, 7, "NaOH", S)
    assert not q["esterificationNeeded"] and not q["isEstimate"]
    assert approx(q["catalystToWeighG"], 5.36)
    assert calculations.quantity_cards(460, 0, 7, "NaOH", S)["esterificationNeeded"] is False


def test_ffa_3_percent_or_less_skips_esterification():
    # FFA <= 3% goes directly to transesterification; above 3% needs esterification.
    for ffa in (0, 1, 2, 3):
        assert not calculations.needs_esterification(ffa, S)
    assert calculations.needs_esterification(4, S)
    assert calculations.needs_esterification(5, S)


def test_after_esterification():
    # the re-check reading (which the strip can measure) doses stage 2, at 40:1; no new acetone
    nxt = calculations.after_esterification(920, 4, 1, 7, "KOH", S)
    assert nxt["action"] == "anotherStage" and nxt["stage"] == 2 and nxt["doseFfa"] == 4
    assert approx(nxt["esterificationMethanolMl"], 209.02) and approx(nxt["sulfuricAcidMl"], 0.994)
    assert nxt["acetoneMl"] == 0 and not nxt["uniformDose"]
    done = calculations.after_esterification(920, 3, 2, 7, "KOH", S)
    assert done["action"] == "transesterification" and done["ffa"] == 3
    assert approx(done["catalystToWeighG"], 16.32) and approx(done["transesterificationMethanolMl"], 296.02)


def test_warnings_for_oil_volume():
    assert calculations.quantity_cards(80, 3, 7, "KOH", S)["warnings"]
    assert not calculations.quantity_cards(1380, 3, 7, "KOH", S)["warnings"]   # 1500 mL: the minimum


# ---------- analytics (same rules as the website's Batch History) ----------
def _samples():
    return [seed.hydrate(row) for row in seed.DEMO_BATCHES]


def test_ffa_ranges_match_the_website():
    keys = [r["key"] for r in analytics.ffa_ranges(S)]
    labels = [r["label"] for r in analytics.ffa_ranges(S)]
    assert keys == ["0-4", "4-5", "5+"]
    assert labels[0] == "0–3% — straight to transesterification" and labels[1] == "4% — esterified" and labels[-1] == "5%+ — esterified"
    direct_range = analytics.ffa_ranges(S)[0]
    assert analytics.in_range(3.0, direct_range) and not analytics.in_range(4.0, direct_range)   # min <= FFA < max


def test_range_rows_on_sample_data():
    rows = {r["range"]["key"]: r for r in analytics.range_rows(_samples(), S)}
    # with whole-number FFA, 0-2% holds the 0% and 1% batches: the ones without esterification
    r = rows["0-4"]
    assert r["testedBatches"] == 2 and r["labPassRate"] == 100 and r["status"] == "Testing"
    # yield: mean and range of the completed batches in the range (B-2026-019, -022, -024)
    assert r["recommendedBatchId"] == "B-2026-022" and r["completedBatches"] == 3
    assert approx(r["averageYield"], 88.37) and r["minimumYield"] == 87.6 and r["maximumYield"] == 89.1
    assert r["yield"]["n"] == 3 and approx(r["costPerLiter"]["mean"], 102.66)
    assert r["energyKwh"]["n"] == 3 and approx(r["energyKwh"]["mean"], 1.96) and r["energyKwh"]["max"] == 2.16
    assert r["esterificationRun"] is False
    assert rows["4-5"]["recommendedParameters"]["esterificationVoltage"] == 20
    assert rows["5+"]["testedBatches"] == 0     # B-2026-023 is pending, B-2026-021 failed (not tested)
    assert rows["0-4"]["recommendedParameters"]["transesterificationTime"] == 65


def test_sample_batches_follow_the_rule():
    for row in seed.DEMO_BATCHES:
        assert float(row["ffa"]).is_integer()
        assert row["esterificationRun"] == (row["ffa"] > S.ffa_threshold)


def test_proven_status():
    base = seed.hydrate(seed.DEMO_BATCHES[0])          # B-2026-024, 1% FFA, Passed, 88.4%
    batches = [base.model_copy(update={"id": f"B-{i}", "yield_": y}) for i, y in enumerate([88.4, 87.0, 89.0])]
    rows = {r["range"]["key"]: r for r in analytics.range_rows(batches, S)}
    assert rows["0-4"]["status"] == "Proven"
    batches.append(base.model_copy(update={"id": "B-x", "yield_": 70.0, "lab_result": "Failed"}))
    rows = {r["range"]["key"]: r for r in analytics.range_rows(batches, S)}
    assert rows["0-4"]["status"] == "Testing"            # a failed batch with the same settings


def test_recommended_parameters():
    batches = _samples()
    p = analytics.recommended_parameters(1, batches, S)
    assert p["transesterificationTime"] == 65 and p["transesterificationStirring"] == 470
    assert "esterificationVoltage" not in p
    assert analytics.recommended_parameters(4, batches, S)["esterificationTime"] == 120
    assert analytics.recommended_parameters(5, batches, S) is None   # "5% and above": nothing tested yet
    assert analytics.recommended_parameters(3, batches, S)["transesterificationTime"] == 65   # 3% shares the direct-treatment band


def test_summary_and_cost():
    batches = sorted(_samples(), key=lambda b: b.date, reverse=True)
    summary = analytics.summary(batches)
    assert summary["totalBatches"] == 6 and summary["completed"] == 5
    assert approx(summary["completionRate"], 83.33) and summary["labPassRate"] == 100
    assert approx(summary["averageYield"], 87.54)
    assert summary["minimumYield"] == 85.7 and summary["maximumYield"] == 89.1   # mean and range
    cost = analytics.cost_report(batches, S)
    # completed batches, oldest first; materials + energy × electricity price, same formula as the website
    assert [r["id"] for r in cost["batches"]] == ["B-2026-019", "B-2026-020", "B-2026-022", "B-2026-023", "B-2026-024"]
    assert approx(next(r for r in cost["batches"] if r["id"] == "B-2026-024")["costPerLiter"], 101.62)
    assert approx(cost["minimumCost"], 98.53) and approx(cost["maximumCost"], 119.71)
    assert summary["energyKwh"] == {"n": 5, "mean": pytest.approx(1.862), "min": 1.52, "max": 2.16}
    assert cost["targetCost"] == 27.5


# ---------- safety ----------
def test_interlocks():
    hw = SimulatedMachine()
    hw.fill_tank(400)
    hw.refresh()
    with pytest.raises(InterlockError):
        hw.set_heater(True)                    # the heater needs the stirrer running
    hw.set_motor("purification_stirrer", 0.33)
    hw.set_heater(True)
    hw.set_valve("mesh_bed", True)            # opening the valve turns the heater off
    assert not hw.heater_on and hw.valves["mesh_bed"]
    with pytest.raises(InterlockError):
        hw.set_heater(True)
    hw.set_valve("mesh_bed", False)
    hw.set_heater(True)
    hw.set_motor("purification_stirrer", 0)   # stopping the stirrer turns the heater off
    assert not hw.heater_on


def test_heater_needs_biodiesel_at_the_level_switch():
    hw = SimulatedMachine(level_switch=True)
    hw.refresh()                              # empty purifier: the level switch reads dry
    hw.set_motor("purification_stirrer", 0.33)
    with pytest.raises(InterlockError):
        hw.set_heater(True)


def test_pump_and_transfer_interlocks():
    hw = SimulatedMachine()
    hw.set_pump("acid", True)
    with pytest.raises(InterlockError):
        hw.set_pump("catalyst", True)            # one pump into the reactor at a time
    with pytest.raises(InterlockError):
        hw.set_valve("reactor_outlet", True)     # the reactor pump can't run while one fills it
    hw.set_pump("acid", False)
    # separation: the reactor pump, the centrifuge and pumpin run together
    hw.set_motor("centrifuge", 0.9)
    hw.set_valve("centrifuge_outlet", True)
    hw.set_valve("reactor_outlet", True)
    with pytest.raises(InterlockError):
        hw.set_pump("oil", True)                 # nothing pumps into the reactor while it is emptied
    hw.all_off()
    assert not any(hw.valves.values()) and not any(hw.pumps.values()) and not any(hw.motor_duty.values())


def test_watchdog():
    hw = SimulatedMachine()
    hw.fill_tank(400)
    hw.refresh()
    hw.set_motor("purification_stirrer", 0.33)
    hw.set_heater(True)
    hw.set_temperature(97)
    hw.refresh()
    assert hw.watchdog(95, 60) == "Heater stopped: temperature exceeded 95 °C." and not hw.heater_on
    # the electrodes are not checked against the temperature (the reactions have no temperature check)
    hw.set_electrode_power(True)
    hw.set_temperature(80)
    hw.refresh()
    assert hw.watchdog(95, 60) is None and hw.electrode_power_on
    hw._read_sensors = lambda: {"temperature": None}
    hw.refresh()
    assert hw.watchdog(95, 60) is None and hw.electrode_power_on


# ---------- purification (dry wash with Magnesol) ----------
SCALE = 400   # run the simulated machine 400x faster
PHASES = ["methanol", "magnesol", "contact", "settle", "drain", "complete"]   # no heating step


async def _purify(runner, hw, fault=None, oil_g=460, magnesol_g=4.6, confirm=True, settings=S):
    """Runs a whole purification. The operator confirms the Magnesol when it's asked for."""
    async def sensor_loop():
        while True:
            hw.refresh()
            await asyncio.sleep(1 / runner.time_scale)
    loop = asyncio.create_task(sensor_loop())
    records, phases = [], []
    runner.start(settings, "B-test", records.append, oil_g=oil_g, magnesol_g=magnesol_g, automatic=True)
    if fault:   # a sensor goes wrong 20 simulated seconds into methanol removal
        await asyncio.sleep(0.05)
        read = hw._read_sensors
        hw._read_sensors = lambda: {**read(), **fault}
    while runner.running:
        phase = runner.state["phase"]
        if not phases or phases[-1] != phase:
            phases.append(phase)
        if phase == "magnesol" and confirm:
            runner.confirm_magnesol()
        await asyncio.sleep(0.002)
    phases.append(runner.state["phase"])
    loop.cancel()
    return records[0], phases


def _machine(scale=SCALE):
    """500 mL of oil, and its biodiesel (85% of the oil's weight) already in the purifier."""
    hw = SimulatedMachine(scale)
    hw.load_oil(500)
    hw.fill_tank(hw.oil_g * hw.BIODIESEL_FRACTION)
    hw.refresh()
    return hw


QUICK = Settings(methanol_removal_time=5, contact_time=1)


def _heater_log(hw, runner):
    """Records every heater switch: (simulated second, on, phase, latest reading) and checks the
    interlocks on every switch-on."""
    switches, violations = [], []
    write = hw._write_heater

    def guarded(on):
        if on and (hw.valves["mesh_bed"] or not hw.motor_duty["purification_stirrer"]):
            violations.append(True)
        st = runner.state
        switches.append((hw.seconds, on, st["phase"], hw.read().get("temperature"),
                         st["methanolTotalSeconds"] - st["methanolRemainingSeconds"]))   # the runner's own clock
        write(on)
    hw._write_heater = guarded
    return switches, violations


def _pulses(switches, with_off_reading=False):
    """[(on second, off second, reading when switched on)] for each heater pulse
    (+ the reading and the phase when switched off, with_off_reading)."""
    pulses, start = [], None
    for second, on, phase, t, clock in switches:
        if on and start is None:
            start = (second, t, clock)
        elif not on and start is not None:
            pulses.append((start[0], second, start[1]) + ((t, phase, clock - start[2]) if with_off_reading else ()))
            start = None
    return pulses


def _full_length(pulses_with_off):
    """Every pulse lasted 2 of the runner's seconds, except one cut at 90 °C or by the end of
    methanol removal."""
    return all(length == 4 or t_off >= 90 or phase != "methanol" for _, _, _, t_off, phase, length in pulses_with_off)


def test_purification_full_sequence():
    hw = _machine(100)
    runner = PurificationRunner(hw, 100)
    switches, violations = _heater_log(hw, runner)
    rec, phases = run(_purify(runner, hw))
    st = runner.state
    assert st["phase"] == "complete", st
    assert phases == PHASES                                    # straight to methanol removal; settle; drain
    assert not rec["safetyStopOccurred"] and rec["automatic"] and rec["warning"] is None
    assert rec["heatingTimeSeconds"] == 0                      # no heating step
    pulses = _pulses(switches)
    # the heater only ever ran during methanol removal, in 4-second pulses, the first one at once
    assert all(phase == "methanol" for _, on, phase, _, _ in switches if on)
    assert len(pulses) >= 5
    # 4 s each; shorter only when 90 °C was reached during the pulse
    assert _full_length(_pulses(switches, True)), pulses
    assert sum(p[-1] == 4 for p in _pulses(switches, True)) >= 5
    assert switches[0][1] is True and switches[0][3] < 28      # the first pulse at once, from room temperature
    assert all(t < 90 for _, _, t in pulses)                   # never a pulse at or above 90 °C
    assert st["heaterPulses"] == len(pulses)
    assert rec["holdTimeSeconds"] == 600                       # 10 min methanol removal
    assert rec["highestTemperature"] < 95                      # below the 95 °C cutoff
    assert rec["magnesolAdded"] and rec["magnesolG"] == 4.6
    assert rec["contactTimeSeconds"] == 600                    # contactTime 10 min
    assert rec["settlingTimeSeconds"] == 60 and rec["coolingTimeSeconds"] == 0
    assert 30 <= rec["drainTimeSeconds"] <= 200                # stable ±2 g for 30 s after the flow
    assert 385 < rec["outputWeightG"] < 395 and st["stableSeconds"] >= 30
    assert rec["stirringSpeed"] == 200 and rec["oilWeightG"] == 460
    assert not violations and not hw.heater_on and not hw.valves["mesh_bed"]
    assert hw.motor_duty["purification_stirrer"] == 0


def test_heater_pulses_wait_for_the_temperature_to_fall():
    """With a real heater the temperature keeps rising after a pulse. The next 4-second pulse comes
    only once the reading is getting lower: 0.2 °C below its highest point since the last pulse."""
    hw = SimulatedMachine(100, heater_lag=0.8)
    hw.load_oil(500)
    hw.fill_tank(hw.oil_g * hw.BIODIESEL_FRACTION)
    hw.set_temperature(60)
    readings = []
    read = hw._read_sensors

    def logged():
        r = read()
        readings.append((hw.seconds, r["temperature"]))
        return r
    hw._read_sensors = logged
    hw.refresh()
    runner = PurificationRunner(hw, 100)
    switches, violations = _heater_log(hw, runner)
    run(_purify(runner, hw, settings=QUICK))
    pulses = [p for p in _pulses(switches)]
    assert len(pulses) >= 3 and _full_length(_pulses(switches, True)) and not violations
    full = _pulses(switches, True)
    for (_, previous_off, _, t_off, _, _), (on, _, t_on) in zip(full, pulses[1:]):
        between = [t for second, t in readings if previous_off <= second <= on]
        peak = max(between)
        assert t_on <= peak - 0.2 + 1e-9, (previous_off, on, t_on, peak)    # it was getting lower
        if t_off < 89:                                                      # (not a pulse cut at 90 °C)
            assert peak > between[0]                                        # it rose after the pulse first
    assert all(phase == "methanol" for _, on, phase, _, _ in switches if on)


def test_no_heater_pulse_at_or_above_90():
    hw = _machine(400)
    hw.set_temperature(92)
    hw.refresh()
    runner = PurificationRunner(hw, 400)
    switches, _ = _heater_log(hw, runner)
    run(_purify(runner, hw, settings=QUICK))
    assert all(t < 90 for _, on, _, t, _ in switches if on)
    assert runner.state["phase"] == "complete"


def test_purification_waits_for_the_magnesol():
    hw = _machine()
    runner = PurificationRunner(hw, SCALE)
    seen = {}

    async def scenario():
        async def sensor_loop():
            while True:
                hw.refresh()
                await asyncio.sleep(1 / SCALE)
        loop = asyncio.create_task(sensor_loop())
        runner.start(S, "B-test", oil_g=460, magnesol_g=4.6)
        with pytest.raises(RuntimeError):
            runner.confirm_magnesol()                          # not asked for yet
        while runner.state["phase"] != "magnesol":
            assert runner.running, runner.state                # a safety stop would wait here forever
            st = runner.state
            if st["phase"] == "methanol" and st["methanolRemainingSeconds"] < st["methanolTotalSeconds"] - 2:
                seen.setdefault(st["phase"], set()).add((st["stirrerOn"], st["stirrerRpm"]))
            await asyncio.sleep(0.002)
        while runner.state["magnesolWaitSeconds"] <= 40:       # 40 simulated seconds: still waiting
            assert runner.running, runner.state
            await asyncio.sleep(0.002)
        st = runner.state
        seen["magnesol"] = (st["phase"], st["heaterOn"], st["stirrerOn"], st["magnesolWaitSeconds"] > 30,
                            st["stirrerRpm"])
        runner.confirm_magnesol()
        while runner.state["phase"] == "magnesol":
            await asyncio.sleep(0.002)
        seen["after"] = runner.state["phase"]
        while runner.state["contactRemainingSeconds"] >= runner.state["contactTotalSeconds"] - 1:
            await asyncio.sleep(0.002)                         # a couple of contact seconds
        st = runner.state
        seen["contact"] = (st["phase"], st["heaterOn"], st["stirrerOn"], st["stirrerRpm"] == 200)
        await runner.abort()
        loop.cancel()
    run(scenario())
    # methanol removal: the stirrer runs at 200 RPM and its RPM reading is reported
    assert "heating" not in seen and seen["methanol"] == {(True, 200)}
    assert seen["magnesol"] == ("magnesol", False, True, True, None)   # heater off, stirrer on, waiting
    assert seen["after"] == "contact"
    assert seen["contact"] == ("contact", False, True, True)           # stirred at 200 RPM, heater off


def test_purification_settles_then_drains():
    """After contact the stirrer stops for the 1 min settle; only then the valve and pumpout open."""
    hw = _machine()
    runner = PurificationRunner(hw, SCALE)
    opened_at, settle = [], []
    write = hw._write_valve

    def watch(name, is_open):
        if name == "mesh_bed" and is_open:
            opened_at.append((runner.state["phase"], runner.state["settleRemainingSeconds"],
                              hw.motor_duty["purification_stirrer"]))
        write(name, is_open)
    hw._write_valve = watch

    async def scenario():
        task = asyncio.create_task(_purify(runner, hw, settings=QUICK))
        while not task.done():
            st = runner.state
            if st["phase"] == "settle":
                settle.append((st["stirrerOn"], st["heaterOn"], st["valveOpen"], st["stepTotalSeconds"]))
            await asyncio.sleep(0.002)
        return await task
    rec, phases = run(scenario())
    assert phases == PHASES
    assert settle and all(item == (False, False, False, 60) for item in settle[1:])
    assert opened_at == [("settle", 0, 0.0)]                    # opened when the settle was over
    assert rec["settlingTimeSeconds"] == 60


def test_purification_finishes_only_when_the_output_is_stable():
    """A slow filter: the drain still runs until the output load cell has been stable for 30 s."""
    scale = 1000
    hw = _machine(scale)
    hw.OUTLET_G_PER_S = 0.3             # 391 g at 0.3 g/s: about 22 simulated minutes
    runner = PurificationRunner(hw, scale)
    rec, _ = run(_purify(runner, hw, settings=QUICK))
    assert runner.state["phase"] == "complete" and runner.state["stableSeconds"] >= 30
    assert rec["drainTimeSeconds"] > 20 * 60 and 385 < rec["outputWeightG"] < 395


def test_purification_needs_the_output_load_cell():
    hw = _machine()
    read = hw._read_sensors
    hw._read_sensors = lambda: {**read(), "outputWeightG": None}
    hw.refresh()
    runner = PurificationRunner(hw, SCALE)

    async def scenario():
        runner.start(S)
    with pytest.raises(RuntimeError, match="output load cell"):
        run(scenario())


def test_purification_warns_when_little_comes_out():
    hw = _machine(1000)
    hw.tank_g = 200.0          # a blocked filter lets only 200 g through (less than 70% of 460 g)
    runner = PurificationRunner(hw, 1000)
    rec, _ = run(_purify(runner, hw, settings=QUICK))
    assert runner.state["phase"] == "complete"
    assert rec["warning"].startswith("Low output – check the polishing filter")


def test_purification_counts_only_this_batch_output():
    hw = _machine(1000)
    hw.output_g = 250.0        # last batch's biodiesel still in the collection container
    runner = PurificationRunner(hw, 1000)
    rec, _ = run(_purify(runner, hw, settings=QUICK))
    assert 385 < rec["outputWeightG"] < 395 and rec["warning"] is None


@pytest.mark.parametrize("fault,reason", [({"temperature": None}, "temperature reading lost"),
                                          ({"temperature": 97.0}, "temperature exceeded 95 °C"),
                                          ({"heaterSubmerged": False}, "biodiesel level dropped below the heater")])
def test_purification_safety_stops(fault, reason):
    hw = _machine()
    runner = PurificationRunner(hw, SCALE)
    rec, _ = run(_purify(runner, hw, fault=fault))
    assert runner.state["phase"] == "fault" and rec["safetyStopReason"] == reason
    assert rec["safetyStopOccurred"] and not hw.heater_on and not hw.valves["mesh_bed"]
    assert hw.motor_duty["purification_stirrer"] == 0
    with pytest.raises(RuntimeError):         # must acknowledge first
        runner.start(S)
    runner.acknowledge()
    assert runner.state["phase"] == "ready"


def test_heater_stops_when_the_stirrer_stops_turning():
    hw = _machine()
    runner = PurificationRunner(hw, SCALE)
    rec, _ = run(_purify(runner, hw, fault={"purificationStirrerRpm": 0}))
    assert rec["safetyStopReason"] == "the purification stirrer stopped turning" and not hw.heater_on


def test_purification_abort():
    hw = _machine()
    runner = PurificationRunner(hw, SCALE)

    async def scenario():
        async def sensor_loop():
            while True:
                hw.refresh()
                await asyncio.sleep(1 / SCALE)
        loop = asyncio.create_task(sensor_loop())
        runner.start(S)
        await asyncio.sleep(0.05)
        await runner.abort()
        loop.cancel()
    run(scenario())
    assert runner.state["phase"] == "fault" and runner.state["safetyStopReason"] == "stopped by operator"
    assert not hw.heater_on


# ---------- reaction and separation stages ----------
def test_reaction_stage_pause_resume_complete():
    hw = _machine()
    runner = StageRunner(hw, 2000)
    events = []

    async def scenario():
        async def sensor_loop():
            while True:
                hw.refresh()
                await asyncio.sleep(0.0005)
        loop = asyncio.create_task(sensor_loop())
        runner.start("Transesterification", S, "B-test", 30, 120, 500, lambda label, st: events.append(label))
        assert hw.electrode_power_on and hw.motor_duty["stirrer"] > 0
        await asyncio.sleep(0.1)
        runner.pause()
        assert not hw.electrode_power_on and hw.motor_duty["stirrer"] == 0
        frozen = runner.state["elapsedSeconds"]
        await asyncio.sleep(0.05)
        assert runner.state["elapsedSeconds"] == frozen
        runner.resume()
        await asyncio.sleep(0.05)
        runner.complete()
        await asyncio.sleep(0.01)
        loop.cancel()
    run(scenario())
    st = runner.state
    assert st["state"] == "complete" and not hw.electrode_power_on and hw.motor_duty["stirrer"] == 0
    assert st["averageTemperature"] is not None and "energyKwh" not in st      # no energy figure
    assert events == ["Transesterification started", "Transesterification paused",
                      "Transesterification resumed", "Transesterification completed"]


def test_separation_settles_then_runs_the_reactor_pump_centrifuge_and_pumpin():
    hw = SimulatedMachine(400)
    hw.load_oil(500)                                       # 460 g of oil (+ premix) in the reactor
    hw.refresh()
    runner = StageRunner(hw, 400)
    events, seen = [], {}

    async def scenario():
        runner.start("Separation", S, "B-test", time_min=5, speed=2000,
                     on_event=lambda label, st: events.append(label), settle_seconds=REACTOR_SETTLE_S)
        st = runner.state
        seen["start"] = (st["phase"], st["settleRemainingSeconds"], hw.valves["reactor_outlet"],
                         hw.motor_duty["centrifuge"], hw.valves["centrifuge_outlet"])
        while runner.state["phase"] == "settling":
            assert runner.active, runner.state
            await asyncio.sleep(0.002)
        seen["running"] = (runner.state["elapsedSeconds"] <= 1, hw.valves["reactor_outlet"],
                           round(hw.motor_duty["centrifuge"], 2), hw.valves["centrifuge_outlet"])
        while runner.active:
            hw.refresh()
            await asyncio.sleep(1 / 400)
    run(scenario())
    assert seen["start"] == ("settling", 60, False, 0.0, False)       # 1 min settle, everything off
    assert seen["running"] == (True, True, 0.8, True)                 # 2000 / 2500 RPM, all three on
    st = runner.state
    assert st["state"] == "complete" and st["elapsedSeconds"] == 5 * 60 and st["speedRpm"] == 2000
    assert not hw.valves["reactor_outlet"] and not hw.valves["centrifuge_outlet"]
    assert hw.motor_duty["centrifuge"] == 0
    assert hw.reactor_g < 1 and 390 < hw.tank_g < 392                # the biodiesel went on to the purifier
    assert events == ["Separation started", "Separation pumps and centrifuge started", "Separation completed"]


def test_separation_pause_during_settle_keeps_everything_off():
    hw = SimulatedMachine(400)
    runner = StageRunner(hw, 400)

    async def scenario():
        runner.start("Separation", S, time_min=1, settle_seconds=60)
        runner.pause()
        runner.resume()                                     # still settling: nothing switches on
        assert not hw.valves["reactor_outlet"] and hw.motor_duty["centrifuge"] == 0
        await runner.emergency_stop()
    run(scenario())


def test_separation_limits():
    hw = SimulatedMachine()
    limits = separation_limits(hw, S)
    assert limits["speedMax"] == 2500 and limits["speedDefault"] == 2500     # Settings 2600 > the centrifuge's 2500
    assert limits["timeDefault"] == S.separation_time and limits["settleSeconds"] == 60
    for bad in ({"time_min": 0}, {"time_min": 181}, {"speed": 2600}, {"speed": 50}):
        with pytest.raises(StageError):
            run(_start_separation(StageRunner(SimulatedMachine()), **bad))


async def _start_separation(runner, **kwargs):
    runner.start("Separation", S, **kwargs)


def test_reactions_have_no_temperature_check():
    """Esterification keeps running when the temperature is high or there is no reading."""
    hw = _machine()
    runner = StageRunner(hw, 2000)

    async def scenario():
        runner.start("Esterification", S, voltage=20, time_min=30, stirring=500)
        hw.set_temperature(70)
        while runner.active and runner.state["elapsedSeconds"] < 60:
            await asyncio.sleep(0.005)
        hw._read_sensors = lambda: {"temperature": None}
        while runner.active:
            await asyncio.sleep(0.005)
    run(scenario())
    assert runner.state["state"] == "complete" and runner.state["faultReason"] is None

def test_stage_limits():
    runner = StageRunner(SimulatedMachine())
    with pytest.raises(StageError):
        run(_start_bad(runner))
    for bad in ({"voltage": 9}, {"current": 2.5}, {"time_min": 190}):
        with pytest.raises(StageError):
            run(_start_with(StageRunner(SimulatedMachine()), **bad))


async def _start_with(runner, **kwargs):
    runner.start("Esterification", S, **kwargs)


def test_overcurrent_stops_the_electrodes():
    hw = _machine()
    runner = StageRunner(hw, 2000)
    events = []

    async def scenario():
        runner.start("Transesterification", S, "B-test", 30, 120, 500, lambda label, st: events.append(label), current=1)
        assert runner.state["current"] == 1 and runner.state["currentLimitSet"] is False   # set by hand
        await asyncio.sleep(0.01)
        hw.supply_current_limit = 1.4          # the supply was set too high: 1.26 A flows
        while runner.active:
            hw.refresh()
            await asyncio.sleep(0.0005)
    run(scenario())
    st = runner.state
    assert st["state"] == "fault" and "above the 1 A setting" in st["faultReason"]
    assert not hw.electrode_power_on and hw.motor_duty["stirrer"] == 0
    assert events[-1].startswith("Transesterification stopped (current")


def test_pi_sets_the_current_limit_when_it_can(monkeypatch):
    monkeypatch.setattr(config, "POWER_SUPPLY_CURRENT_CONTROL", True)
    hw = SimulatedMachine()
    hw.supply_current_limit = 2.0
    runner = StageRunner(hw)

    async def scenario():
        runner.start("Esterification", S, current=1)
        assert runner.state["currentLimitSet"] is True and hw.supply_current_limit == 1
        await runner.emergency_stop()
    run(scenario())


async def _start_bad(runner):
    runner.start("Transesterification", S, voltage=35)


# ---------- oil pump and dispensers (stopped by the operator) ----------
async def _with_sensors(hw, coro):
    async def sensor_loop():
        while True:
            hw.refresh()
            await asyncio.sleep(1 / hw.time_scale)
    loop = asyncio.create_task(sensor_loop())
    try:
        return await coro
    finally:
        loop.cancel()


async def _until_done(runner):
    while runner.running:
        await asyncio.sleep(0.002)


def test_pump_runs_until_done_is_pressed():
    hw = SimulatedMachine(400)
    pump = PumpRunner(hw, 400)
    done = []

    async def scenario():
        pump.start("oil", 460, 500, "B-test", "Oil", done.append)
        assert hw.pumps["oil"] and pump.state["phase"] == "pumping"
        while pump.state["elapsedSeconds"] <= 120:           # 2 simulated minutes: still pumping
            assert pump.running, pump.state
            await asyncio.sleep(0.002)
        assert pump.running and hw.pumps["oil"] and pump.state["elapsedSeconds"] > 100
        pump.finish()                                        # the operator: the container is empty
        await _until_done(pump)
    run(_with_sensors(hw, scenario()))
    st = pump.state
    assert st["phase"] == "done" and done[0]["phase"] == "done" and not hw.pumps["oil"]
    assert st["deliveredG"] == 460 and st["targetG"] == 460 and st["volumeMl"] == 500


def test_pump_stop_and_start_again():
    hw = SimulatedMachine(400)
    pump = PumpRunner(hw, 400)

    async def scenario():
        pump.start("acid", 100, 120)
        await asyncio.sleep(0.05)
        await pump.stop()
        assert pump.state["phase"] == "stopped" and not hw.pumps["acid"] and pump.state["deliveredG"] == 0
        with pytest.raises(TransferError):
            pump.finish()                                    # nothing running
        pump.start("acid", 100, 120)
        with pytest.raises(TransferError):
            pump.start("catalyst", 100, 120)                 # one at a time
        pump.finish()
        await _until_done(pump)
    run(scenario())
    assert pump.state["phase"] == "done" and pump.state["deliveredG"] == 100


def test_forgotten_pump_stops_by_itself():
    hw = SimulatedMachine(4000)
    pump = PumpRunner(hw, 4000)

    async def scenario():
        pump.start("catalyst", 100, 120, max_minutes=2)
        await _until_done(pump)
    run(scenario())
    assert pump.state["phase"] == "fault" and "without Done" in pump.state["faultReason"]
    assert pump.state["elapsedSeconds"] == 120 and not hw.pumps["catalyst"]


def test_pump_cant_start_while_the_reactor_pump_runs():
    hw = SimulatedMachine()
    hw.set_valve("reactor_outlet", True)
    pump = PumpRunner(hw)

    async def scenario():
        pump.start("oil", 460, 500)
    with pytest.raises(InterlockError):
        run(scenario())
    assert pump.state["phase"] == "idle" and not hw.pumps["oil"]


# ---------- database ----------
def test_env_file_sets_the_mysql_login(tmp_path, monkeypatch):
    """backend/.env: KEY=value lines; quotes are removed, '#' inside a password stays, an empty
    value keeps the default from config.py, and a real environment variable wins."""
    for key in ("DB_TEST_A", "DB_TEST_B", "DB_TEST_C", "DB_TEST_D", "DB_TEST_E"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("DB_TEST_E", "from the environment")
    env = tmp_path / ".env"
    env.write_text('# my login\nDB_TEST_A=root\nDB_TEST_B="pass word#1"\nDB_TEST_C=\n'
                   "export DB_TEST_D=a=b\nDB_TEST_E=from the file\n", encoding="utf-8")
    config._load_env_file(env)
    import os
    assert os.environ["DB_TEST_A"] == "root" and os.environ["DB_TEST_B"] == "pass word#1"
    assert "DB_TEST_C" not in os.environ and os.environ["DB_TEST_D"] == "a=b"
    assert os.environ["DB_TEST_E"] == "from the environment"
    for key in ("DB_TEST_A", "DB_TEST_B", "DB_TEST_D"):
        monkeypatch.delenv(key, raising=False)


def test_database(mysql_db):
    assert db.next_batch_id("B-{YEAR}-{SEQ}", 2026) == "B-2026-001"
    for b in _samples():
        db.save_batch(b)
    assert db.next_batch_id("B-{YEAR}-{SEQ}", 2026) == "B-2026-025"
    assert db.next_batch_id("GV{SEQ}", 2026) == "GV001"
    got = db.get_batch("B-2026-024")
    assert got.yield_ == 88.4 and got.dump()["yield"] == 88.4 and got.materials.oil_l == 1
    assert [b.id for b in db.list_batches()][:2] == ["B-2026-024", "B-2026-023"]
    db.save_settings(Settings(methanol_removal_time=12))
    assert db.get_settings().methanol_removal_time == 12


def test_failed_batches_are_not_tested():
    b = Batch.model_validate({"id": "B-1", "date": "2026-10-11", "oilVolume": 500, "status": "Failed"})
    assert b.lab_result == "Not tested"


# ---------- energy used ----------
def test_energy_is_power_times_time_on():
    """No electricity meter: the energy is each part's power × the seconds it was on, counted at
    every sensor reading (once per second)."""
    from app.energy import EnergyMeter
    hw = SimulatedMachine()
    hw.fill_tank(400)
    meter = EnergyMeter({"stirrer_w": 24, "purification_stirrer_w": 20, "centrifuge_w": 120, "oil_pump_w": 24,
                         "catalyst_pump_w": 12, "acid_pump_w": 12, "reactor_pump_w": 24, "pumpin_w": 24,
                         "pumpout_w": 30})
    meter.heater_watts = 900
    clock = {"t": 0.0}

    def run(seconds, reading=None):
        for _ in range(seconds):
            clock["t"] += 1
            meter.update(hw, reading or {}, now=clock["t"])
    meter.update(hw, {}, now=0.0)
    start = meter.totals()
    hw.set_current_limit(1)
    hw.set_supply_voltage(30)                    # the stage's 30 V × 1 A on the CC/CV module
    hw.set_electrode_power(True)
    hw.set_motor("stirrer", 0.5)                 # half speed: half its 24 W
    run(3600)                                    # one hour
    hw.set_electrode_power(False)
    hw.set_motor("stirrer", 0)
    hw.set_motor("purification_stirrer", 1.0)
    hw.refresh()
    hw.set_heater(True)
    run(4)                                       # a 4 s heater pulse, mixer 2 on
    hw.set_heater(False)
    used = meter.used_since(start, meter.totals())
    assert used["electrodes"] == pytest.approx(30.0) and used["stirrer"] == pytest.approx(12.0)
    assert used["heater"] == pytest.approx(900 * 4 / 3600) and used["purification_stirrer"] == pytest.approx(20 * 4 / 3600)
    kwh, line = meter.describe(used)
    assert kwh == pytest.approx(0.043, abs=0.001) and line.startswith("Energy used: 0.043 kWh")
    assert "electrodes 0.030" in line and "mixer 1 0.012" in line and "heater 0.001" in line
    # a measured power monitor reading wins over the CC/CV setting
    hw.set_electrode_power(True)
    before = meter.totals()["electrodes"]
    run(2, {"voltage": 24.0, "current": 0.5})
    assert meter.totals()["electrodes"] - before == pytest.approx(24 * 0.5 * 2 / 3600)
    # a long gap (a pause, a restart) isn't counted as hours of on-time
    before = meter.totals()["electrodes"]
    meter.update(hw, {"voltage": 24.0, "current": 0.5}, now=clock["t"] + 600)
    assert meter.totals()["electrodes"] - before == pytest.approx(24 * 0.5 * 5 / 3600)


def test_a_stopped_stage_starts_again_without_a_reset():
    """No "controller reset required": after an emergency stop the stage can be started again."""
    hw = _machine()
    runner = StageRunner(hw, 2000)

    async def scenario():
        runner.start("Esterification", S, voltage=20, time_min=30, stirring=500)
        await runner.emergency_stop("emergency stop")
        assert runner.state["state"] == "fault" and not hw.electrode_power_on
        runner.start("Esterification", S, voltage=25, time_min=30, stirring=500)
        assert runner.state["state"] == "running" and runner.state["voltage"] == 25 and hw.electrode_power_on
        await runner.emergency_stop("test over")
    run(scenario())
