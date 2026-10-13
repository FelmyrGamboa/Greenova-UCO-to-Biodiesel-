"""Tests for the calculations, analytics, safety rules and process sequences.
Run from the greenova-backend folder:  python -m pytest"""
import asyncio

import pytest

from app import analytics, calculations, config, db, seed
from app.hardware import InterlockError, MockHardware
from app.models import Batch, Settings
from app.purification import PurificationRunner
from app.stages import StageError, StageRunner
from app.transfers import DrainRunner, PumpRunner

S = Settings()


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
    assert (S.methanol_removal_time, S.contact_time, S.settling_time, S.max_drain_temperature) == (10, 15, 10, 50)
    assert S.reactor_drain_time == 1 and S.centrifuge_drain_time == 2
    assert S.ffa_threshold == 1 and S.auto_advance is True
    for limits in (S.esterification, S.transesterification):
        assert (limits.voltage.min, limits.voltage.max) == (10, 30)
        assert (limits.time.min, limits.time.max, limits.time.default) == (30, 180, 120)
        assert (limits.current.min, limits.current.max, limits.current.default) == (1, 2, 1)   # whole amperes


def test_old_saved_settings_get_the_new_defaults(tmp_path):
    config.DB_PATH = tmp_path / "old.db"
    db.init_db()
    old = Settings()
    old.esterification.voltage.min = 18
    old.esterification.time.max = 120
    old.transesterification.voltage.min = 18
    old.reactor_drain_time = 3
    old.centrifuge_drain_time = 3
    old.ffa_threshold = 4
    old.esterification.current.min = 0.5
    db.save_settings(old)
    s = db.get_settings()
    assert s.esterification.voltage.min == 10 and s.esterification.time.max == 180
    assert s.transesterification.voltage.min == 10 and s.reactor_drain_time == 1
    assert s.centrifuge_drain_time == 2 and s.ffa_threshold == 1 and s.esterification.current.min == 1


@pytest.mark.parametrize("bad", [{"ffaRangeBoundaries": "5"}, {"methanolRemovalTime": 4},
                                 {"methanolRemovalTime": 31}, {"maxDrainTemperature": 95}])
def test_settings_validation(bad):
    with pytest.raises(ValueError):
        Settings.model_validate(bad)


# ---------- calculations (same numbers as calculateQuantityCards on the website) ----------
def test_calculator_with_esterification():
    # The strip reads at most 5%, so every batch above 1% gets the uniform dose for 10% FFA
    q = calculations.quantity_cards(460, 6, 7, "NaOH", S)
    assert q["esterificationNeeded"] and q["isEstimate"] and q["uniformDose"] and q["doseFfa"] == 10
    assert approx(q["ffaMassG"], 46) and approx(q["esterificationMethanolMl"], 130.64)
    assert approx(q["sulfuricAcidMl"], 1.242, 0.0001) and approx(q["sulfuricAcidG"], 2.3)
    assert approx(q["acetoneMl"], 50) and approx(q["acetoneG"], 39.2) and approx(q["transesterificationMethanolMl"], 148.01)
    assert approx(q["catalystBaseG"], 4.6) and approx(q["neutralizationG"], 0.6532)
    assert approx(q["catalystToWeighG"], 5.36) and q["purity"] == 98
    # pump B premix: 130.64 mL methanol (103.47 g) + 1.242 mL H2SO4 (2.3 g)
    assert approx(q["esterificationPremixMl"], 131.88) and approx(q["esterificationPremixG"], 105.77)
    # pump A premix: 148.01 mL methanol (117.22 g) + 5.36 g NaOH
    assert approx(q["transesterificationPremixG"], 122.58)
    same = calculations.quantity_cards(460, 2, 7, "NaOH", S)     # any FFA above 1%: the same dose
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
        Settings(esterification_design_ffa=1)     # must be above the 1% threshold


def test_calculator_without_esterification():
    q = calculations.quantity_cards(460, 1, 7, "NaOH", S)
    assert not q["esterificationNeeded"] and not q["isEstimate"]
    assert approx(q["catalystToWeighG"], 5.36)
    assert calculations.quantity_cards(460, 0, 7, "NaOH", S)["esterificationNeeded"] is False


def test_ffa_1_percent_or_less_skips_esterification():
    # FFA <= 1%: straight to transesterification; anything higher: esterification first
    assert not calculations.needs_esterification(0, S)
    assert not calculations.needs_esterification(1, S)
    assert calculations.needs_esterification(2, S)
    assert calculations.needs_esterification(3, S)


def test_after_esterification():
    # the re-check reading (which the strip can measure) doses stage 2, at 40:1; no new acetone
    nxt = calculations.after_esterification(920, 1.2, 1, 7, "KOH", S)
    assert nxt["action"] == "anotherStage" and nxt["stage"] == 2 and nxt["doseFfa"] == 1.2
    assert approx(nxt["esterificationMethanolMl"], 62.71) and approx(nxt["sulfuricAcidMl"], 0.298)
    assert nxt["acetoneMl"] == 0 and not nxt["uniformDose"]
    done = calculations.after_esterification(920, 0.5, 2, 7, "KOH", S)
    assert done["action"] == "transesterification"
    assert approx(done["catalystToWeighG"], 11.24) and approx(done["transesterificationMethanolMl"], 296.02)


def test_warnings_for_oil_volume():
    assert calculations.quantity_cards(80, 3, 7, "KOH", S)["warnings"]
    assert not calculations.quantity_cards(460, 3, 7, "KOH", S)["warnings"]


# ---------- analytics (same rules as the website's Batch History) ----------
def _samples():
    return [seed.hydrate(row) for row in seed.DEMO_BATCHES]


def test_ffa_ranges_match_the_website():
    keys = [r["key"] for r in analytics.ffa_ranges(S)]
    labels = [r["label"] for r in analytics.ffa_ranges(S)]
    assert keys == ["0-2", "2-4", "4-5", "5+"]
    assert labels[1] == "2–4%" and labels[-1] == "5% and above"
    r24 = analytics.ffa_ranges(S)[1]
    assert analytics.in_range(2.0, r24) and not analytics.in_range(4.0, r24)   # min <= FFA < max


def test_range_rows_on_sample_data():
    rows = {r["range"]["key"]: r for r in analytics.range_rows(_samples(), S)}
    # with whole-number FFA, 0-2% holds the 0% and 1% batches: the ones without esterification
    r = rows["0-2"]
    assert r["testedBatches"] == 2 and r["labPassRate"] == 100 and r["status"] == "Testing"
    assert r["recommendedBatchId"] == "B-2026-022" and approx(r["averageYield"], 88.75)
    assert r["minimumYield"] == 88.4 and r["maximumYield"] == 89.1
    assert r["esterificationRun"] is False
    assert rows["4-5"]["recommendedParameters"]["esterificationVoltage"] == 20
    assert rows["5+"]["testedBatches"] == 0     # B-2026-023 is pending, B-2026-021 failed (not tested)
    assert rows["2-4"]["status"] == "No data" and rows["2-4"]["recommendedParameters"] is None


def test_sample_batches_follow_the_rule():
    for row in seed.DEMO_BATCHES:
        assert float(row["ffa"]).is_integer()
        assert row["esterificationRun"] == (row["ffa"] > S.ffa_threshold)


def test_proven_status():
    base = seed.hydrate(seed.DEMO_BATCHES[0])          # B-2026-024, 1% FFA, Passed, 88.4%
    batches = [base.model_copy(update={"id": f"B-{i}", "yield_": y}) for i, y in enumerate([88.4, 87.0, 89.0])]
    rows = {r["range"]["key"]: r for r in analytics.range_rows(batches, S)}
    assert rows["0-2"]["status"] == "Proven"
    batches.append(base.model_copy(update={"id": "B-x", "yield_": 70.0, "lab_result": "Failed"}))
    rows = {r["range"]["key"]: r for r in analytics.range_rows(batches, S)}
    assert rows["0-2"]["status"] == "Testing"            # a failed batch with the same settings


def test_recommended_parameters():
    batches = _samples()
    p = analytics.recommended_parameters(1, batches, S)
    assert p["transesterificationTime"] == 65 and p["transesterificationStirring"] == 470
    assert "esterificationVoltage" not in p
    assert analytics.recommended_parameters(4, batches, S)["esterificationTime"] == 120
    assert analytics.recommended_parameters(5, batches, S) is None   # "5% and above": nothing tested yet
    assert analytics.recommended_parameters(3, batches, S) is None   # 2-4%: no samples


def test_summary_and_cost():
    batches = sorted(_samples(), key=lambda b: b.date, reverse=True)
    summary = analytics.summary(batches)
    assert summary["totalBatches"] == 6 and summary["completed"] == 5
    assert approx(summary["completionRate"], 83.33) and summary["labPassRate"] == 100
    assert approx(summary["averageYield"], 87.54)
    cost = analytics.cost_report(batches, S)
    assert [r["id"] for r in cost["batches"]] == ["B-2026-020", "B-2026-022", "B-2026-024"]
    assert approx(next(r for r in cost["batches"] if r["id"] == "B-2026-024")["costPerLiter"], 114.11)
    assert cost["targetCost"] == 27.5


# ---------- safety ----------
def test_interlocks():
    hw = MockHardware()
    hw.demo_fill_tank(400)
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
    hw = MockHardware()
    hw.refresh()                              # empty tank: the level switch reads dry
    hw.set_motor("purification_stirrer", 0.33)
    with pytest.raises(InterlockError):
        hw.set_heater(True)


def test_pump_and_valve_interlocks():
    hw = MockHardware()
    hw.set_pump("acid", True)
    with pytest.raises(InterlockError):
        hw.set_pump("catalyst", True)            # one pump at a time
    with pytest.raises(InterlockError):
        hw.set_valve("reactor_outlet", True)     # not while a pump fills the reactor
    hw.set_pump("acid", False)
    hw.set_valve("reactor_outlet", True)
    with pytest.raises(InterlockError):
        hw.set_pump("catalyst", True)            # not while the reactor drains
    hw.set_motor("centrifuge", 0.9)
    with pytest.raises(InterlockError):
        hw.set_valve("centrifuge_outlet", True)  # not while the centrifuge spins
    hw.set_motor("centrifuge", 0)
    hw.set_valve("centrifuge_outlet", True)
    with pytest.raises(InterlockError):
        hw.set_motor("centrifuge", 0.9)
    hw.all_off()
    assert not any(hw.valves.values()) and not any(hw.pumps.values()) and not any(hw.motor_duty.values())


def test_watchdog():
    hw = MockHardware()
    hw.demo_fill_tank(400)
    hw.refresh()
    hw.set_motor("purification_stirrer", 0.33)
    hw.set_heater(True)
    hw.demo_set_temperature(97)
    hw.refresh()
    assert hw.watchdog(95, 60) == "Heater stopped: temperature exceeded 95 °C." and not hw.heater_on
    hw.set_electrode_power(True)
    assert hw.watchdog(95, 60).startswith("Electrodes stopped") and not hw.electrode_power_on


# ---------- purification (dry wash with Magnesol) ----------
SCALE = 400   # run the simulated machine 400x faster


async def _purify(runner, hw, fault=None, skip=False, oil_g=460, magnesol_g=4.6, confirm=True, settings=S):
    """Runs a whole purification. The operator confirms the Magnesol when it's asked for."""
    async def sensor_loop():
        while True:
            hw.refresh()
            await asyncio.sleep(1 / runner.time_scale)
    loop = asyncio.create_task(sensor_loop())
    records, phases = [], []
    runner.start(settings, "B-test", records.append, oil_g=oil_g, magnesol_g=magnesol_g, automatic=True)
    if fault:   # a sensor goes wrong 20 simulated seconds into heating
        await asyncio.sleep(0.05)
        read = hw._read_sensors
        hw._read_sensors = lambda: {**read(), **fault}
    while runner.running:
        phase = runner.state["phase"]
        if not phases or phases[-1] != phase:
            phases.append(phase)
        if phase == "magnesol" and confirm:
            runner.confirm_magnesol()
        elif skip:
            runner.skip()
        await asyncio.sleep(0.002)
    phases.append(runner.state["phase"])
    loop.cancel()
    return records[0], phases


def _demo_hw(scale=SCALE):
    """500 mL of oil, and its biodiesel (85% of the oil's weight) already in the purification tank."""
    hw = MockHardware(scale)
    hw.demo_load_oil(500)
    hw.demo_fill_tank(hw.oil_g * hw.BIODIESEL_FRACTION)
    hw.refresh()
    return hw


def test_purification_full_sequence():
    # 100x (not 400x): finer simulated steps, so the ±2 °C hold isn't skewed by timer jitter
    hw = _demo_hw(100)
    violations = []
    write = hw._write_heater

    def guarded(on):
        if on and (hw.valves["mesh_bed"] or not hw.motor_duty["purification_stirrer"]):
            violations.append(True)
        write(on)
    hw._write_heater = guarded
    runner = PurificationRunner(hw, 100)
    rec, phases = asyncio.run(_purify(runner, hw))
    st = runner.state
    assert st["phase"] == "complete", st
    # the temperature is under 50 °C after contact and settling, so the cooling step is skipped
    assert phases == ["heating", "methanol", "magnesol", "contact", "settling", "drain", "complete"]
    assert not rec["safetyStopOccurred"] and rec["automatic"] and rec["warning"] is None
    assert rec["heatingTimeSeconds"] <= 100                    # 27 -> 90 °C at 45 °C per minute
    assert rec["holdTimeSeconds"] == 600                       # 10 min methanol removal
    assert 90 <= rec["highestTemperature"] < 93                # 90 ±2 °C, below the 95 °C cutoff
    assert rec["magnesolAdded"] and rec["magnesolG"] == 4.6
    assert rec["contactTimeSeconds"] == 900 and rec["settlingTimeSeconds"] == 600
    assert rec["coolingTimeSeconds"] == 0
    assert 30 <= rec["drainTimeSeconds"] <= 200                # stable ±2 g for 30 s after the flow
    assert 385 < rec["outputWeightG"] < 395 and st["stableSeconds"] >= 30
    assert rec["stirringSpeed"] == 200 and rec["oilWeightG"] == 460
    assert not violations and not hw.heater_on and not hw.valves["mesh_bed"]
    assert hw.motor_duty["purification_stirrer"] == 0


def test_purification_waits_for_the_magnesol():
    hw = _demo_hw()
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
            st = runner.state
            if st["phase"] in ("heating", "methanol") and st["heatingTimeSeconds"] > 2:
                seen.setdefault(st["phase"], set()).add((st["stirrerOn"], st["stirrerRpm"] is not None and 195 <= st["stirrerRpm"] <= 202))
            await asyncio.sleep(0.002)
        await asyncio.sleep(0.2)                               # 80 simulated seconds: still waiting
        st = runner.state
        seen["magnesol"] = (st["phase"], st["heaterOn"], st["stirrerOn"], st["magnesolWaitSeconds"] > 30)
        runner.confirm_magnesol()
        while runner.state["phase"] == "magnesol":
            await asyncio.sleep(0.002)
        seen["after"] = runner.state["phase"]
        await runner.abort()
        loop.cancel()
    asyncio.run(scenario())
    assert seen["heating"] == {(True, True)} and seen["methanol"] == {(True, True)}   # 200 RPM, "198 / 200"
    assert seen["magnesol"] == ("magnesol", False, True, True)   # heater off, stirrer on, waiting
    assert seen["after"] == "contact"


def test_purification_cools_before_draining():
    hw = _demo_hw()
    runner = PurificationRunner(hw, SCALE)
    short = Settings(contact_time=1, settling_time=0)          # still hot when settling ends
    rec, phases = asyncio.run(_purify(runner, hw, settings=short))
    assert runner.state["phase"] == "complete" and "cooling" in phases
    assert rec["coolingTimeSeconds"] > 60 and rec["highestTemperature"] >= 90


def test_purification_warns_when_little_comes_out():
    hw = _demo_hw()
    hw.tank_g = 200.0          # a blocked filter lets only 200 g through (less than 70% of 460 g)
    runner = PurificationRunner(hw, SCALE)
    rec, _ = asyncio.run(_purify(runner, hw, skip=True))   # skip the timers: only the result matters
    assert runner.state["phase"] == "complete" and rec["warning"].startswith("Low output – check the filter")


def test_purification_counts_only_this_batch_output():
    hw = _demo_hw()
    hw.output_g = 250.0        # last batch's biodiesel still in the collection container
    runner = PurificationRunner(hw, SCALE)
    rec, _ = asyncio.run(_purify(runner, hw, skip=True))
    assert 385 < rec["outputWeightG"] < 395 and rec["warning"] is None


@pytest.mark.parametrize("fault,reason", [({"temperature": None}, "temperature reading lost"),
                                          ({"temperature": 97.0}, "temperature exceeded 95 °C"),
                                          ({"heaterSubmerged": False}, "biodiesel level dropped below the heater")])
def test_purification_safety_stops(fault, reason):
    hw = _demo_hw()
    runner = PurificationRunner(hw, SCALE)
    rec, _ = asyncio.run(_purify(runner, hw, fault=fault))
    assert runner.state["phase"] == "fault" and rec["safetyStopReason"] == reason
    assert rec["safetyStopOccurred"] and not hw.heater_on and not hw.valves["mesh_bed"]
    assert hw.motor_duty["purification_stirrer"] == 0
    with pytest.raises(RuntimeError):         # must acknowledge first
        runner.start(S)
    runner.acknowledge()
    assert runner.state["phase"] == "ready"


def test_heater_stops_when_the_stirrer_stops_turning():
    hw = _demo_hw()
    runner = PurificationRunner(hw, SCALE)
    rec, _ = asyncio.run(_purify(runner, hw, fault={"purificationStirrerRpm": 0}))
    assert rec["safetyStopReason"] == "the purification stirrer stopped turning" and not hw.heater_on


def test_purification_abort():
    hw = _demo_hw()
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
    asyncio.run(scenario())
    assert runner.state["phase"] == "fault" and runner.state["safetyStopReason"] == "stopped by operator"
    assert not hw.heater_on


# ---------- reaction and separation stages ----------
def test_reaction_stage_pause_resume_complete():
    hw = _demo_hw()
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
    asyncio.run(scenario())
    st = runner.state
    assert st["state"] == "complete" and not hw.electrode_power_on and hw.motor_duty["stirrer"] == 0
    assert st["averageTemperature"] is not None and st["energyKwh"] > 0
    assert events == ["Transesterification started", "Transesterification paused",
                      "Transesterification resumed", "Transesterification completed"]


def test_separation_stops_by_itself():
    hw = _demo_hw()
    runner = StageRunner(hw, 4000)

    async def scenario():
        runner.start("Separation", S)
        assert hw.motor_duty["centrifuge"] > 0.8
        while runner.active:
            await asyncio.sleep(0.01)
    asyncio.run(scenario())
    assert runner.state["state"] == "complete" and runner.state["elapsedSeconds"] == 600
    assert hw.motor_duty["centrifuge"] == 0


def test_reaction_overheat_faults():
    hw = _demo_hw()
    runner = StageRunner(hw, 2000)

    async def scenario():
        runner.start("Esterification", S, voltage=20, time_min=60, stirring=500)
        hw.demo_set_temperature(70)
        hw._snapshot = {**hw.read(), "temperature": 70.0}
        while runner.active:
            await asyncio.sleep(0.005)
    asyncio.run(scenario())
    assert runner.state["state"] == "fault" and "60 °C" in runner.state["faultReason"]
    assert not hw.electrode_power_on
    with pytest.raises(StageError):
        runner.start("Transesterification", S)   # needs a reset first
    runner.reset()


def test_stage_limits():
    runner = StageRunner(MockHardware())
    with pytest.raises(StageError):
        asyncio.run(_start_bad(runner))
    for bad in ({"voltage": 9}, {"current": 2.5}, {"time_min": 190}):
        with pytest.raises(StageError):
            asyncio.run(_start_with(StageRunner(MockHardware()), **bad))


async def _start_with(runner, **kwargs):
    runner.start("Esterification", S, **kwargs)


def test_overcurrent_stops_the_electrodes():
    hw = _demo_hw()
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
    asyncio.run(scenario())
    st = runner.state
    assert st["state"] == "fault" and "above the 1 A setting" in st["faultReason"]
    assert not hw.electrode_power_on and hw.motor_duty["stirrer"] == 0
    assert events[-1].startswith("Transesterification stopped (current")


def test_pi_sets_the_current_limit_when_it_can(monkeypatch):
    monkeypatch.setattr(config, "POWER_SUPPLY_CURRENT_CONTROL", True)
    hw = MockHardware()
    hw.supply_current_limit = 2.0
    runner = StageRunner(hw)

    async def scenario():
        runner.start("Esterification", S, current=1)
        assert runner.state["currentLimitSet"] is True and hw.supply_current_limit == 1
        await runner.emergency_stop()
    asyncio.run(scenario())


async def _start_bad(runner):
    runner.start("Transesterification", S, voltage=35)


# ---------- dosing pumps and outlet valves ----------
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


def test_pump_stops_at_the_dose_weight():
    hw = MockHardware(400)
    hw.demo_load_oil(500)                                       # 460 g of oil in the reactor
    hw.refresh()
    pump = PumpRunner(hw, 400)
    done = []

    async def scenario():
        pump.start("acid", 105.8, 131.9, 100, 20, "B-test", "Esterification", done.append)
        assert hw.pumps["acid"]
        await _until_done(pump)
    asyncio.run(_with_sensors(hw, scenario()))
    st = pump.state
    assert st["phase"] == "done" and done[0]["phase"] == "done" and not st["byTime"]
    assert 105.3 <= st["deliveredG"] <= 107.5 and not hw.pumps["acid"]
    assert 565 < hw.reactor_g < 568                              # oil + the dose


def test_pump_faults_when_nothing_arrives():
    hw = MockHardware(400)
    hw.refresh()
    hw._write_pump = lambda name, on: None
    hw.PUMP_G_PER_S = 0                                          # empty tank: the weight never rises
    pump = PumpRunner(hw, 400)

    async def scenario():
        pump.start("catalyst", 100, 120, 100, 20)
        await _until_done(pump)
    asyncio.run(_with_sensors(hw, scenario()))
    assert pump.state["phase"] == "fault" and "nothing is arriving" in pump.state["faultReason"]
    assert pump.state["elapsedSeconds"] == 20 and not hw.pumps["catalyst"]


def test_pump_by_time_without_load_cell():
    hw = MockHardware(400)
    hw._snapshot = {"oilMassG": None}
    hw.read = lambda: {"oilMassG": None}                         # no load cell reading
    pump = PumpRunner(hw, 400)

    async def scenario():
        pump.start("catalyst", 100, 50, 100, 20)                # 50 mL at 100 mL/min = 30 s
        await _until_done(pump)
    asyncio.run(scenario())
    assert pump.state["byTime"] and pump.state["phase"] == "done" and pump.state["elapsedSeconds"] == 30


def test_pump_stop_and_skip():
    hw = MockHardware(50)
    hw.demo_load_oil(500)
    hw.refresh()
    pump = PumpRunner(hw, 50)

    async def scenario():
        pump.start("acid", 100, 120, 100, 20)
        await asyncio.sleep(0.05)
        await pump.stop()
        assert pump.state["phase"] == "stopped" and not hw.pumps["acid"]
        pump.start("acid", 100, 120, 100, 20)
        pump.skip()                                              # demo: the rest arrives at once
        await _until_done(pump)
    asyncio.run(_with_sensors(hw, scenario()))
    assert pump.state["phase"] == "done" and pump.state["deliveredG"] == 100


def test_drains_move_the_batch_along():
    hw = MockHardware(400)
    hw.demo_load_oil(500)                                        # 460 g of oil
    hw.demo_add("reactor", 230)                                  # acetone and premixes
    hw.refresh()
    drain = DrainRunner(hw, 400)

    async def scenario():
        drain.start("reactor_outlet", 180)
        assert hw.valves["reactor_outlet"]
        await _until_done(drain)
        assert drain.state["phase"] == "done" and not hw.valves["reactor_outlet"]
        assert hw.reactor_g < 1 and 689 < hw.centrifuge_g < 691
        hw.set_motor("centrifuge", 0.9)
        hw.refresh()
        drain.start("centrifuge_outlet", 180, wait_rpm="centrifugeRpm", spin_down_seconds=30)
        await asyncio.sleep(0.02)
        assert drain.state["phase"] == "waiting" and not hw.valves["centrifuge_outlet"]
        hw.set_motor("centrifuge", 0)                            # it stops: the outlet opens
        await _until_done(drain)
    asyncio.run(_with_sensors(hw, scenario()))
    assert drain.state["phase"] == "done" and drain.state["waitedSeconds"] >= 1
    assert 390 < hw.tank_g < 392 and hw.read()["heaterSubmerged"]    # 85% of the oil: biodiesel


def test_drain_waits_for_spin_down_without_rpm_reading():
    hw = MockHardware(400)
    hw.refresh()
    hw._snapshot["centrifugeRpm"] = None
    drain = DrainRunner(hw, 400)

    async def scenario():
        drain.start("centrifuge_outlet", 10, wait_rpm="centrifugeRpm", spin_down_seconds=30)
        await _until_done(drain)
    asyncio.run(scenario())
    assert drain.state["waitedSeconds"] == 30 and drain.state["elapsedSeconds"] == 10


# ---------- database ----------
def test_database(tmp_path):
    config.DB_PATH = tmp_path / "test.db"
    db.init_db()
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
