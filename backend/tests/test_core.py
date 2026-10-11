"""Tests for the calculations, analytics, safety rules and process sequences.
Run from the greenova-backend folder:  python -m pytest"""
import asyncio

import pytest

from app import analytics, calculations, config, db, seed
from app.hardware import InterlockError, MockHardware
from app.models import Batch, Settings
from app.purification import PurificationRunner
from app.stages import StageError, StageRunner

S = Settings()


def approx(value, expected, tol=0.01):
    return abs(value - expected) <= tol


# ---------- settings ----------
def test_settings_use_the_website_keys():
    s = Settings.model_validate({"purificationTargetTemperature": 60, "format": "G-{YEAR}-{SEQ}",
                                 "kohPurity": 85, "ffaRangeBoundaries": [0, 3, 6]})
    dumped = s.dump()
    assert dumped["purificationTargetTemperature"] == 60 and dumped["format"] == "G-{YEAR}-{SEQ}"
    assert dumped["kohPurity"] == 85 and dumped["ffaRangeBoundaries"] == "0,3,6"
    assert {"meshBedFlowRate", "drainTime", "heatingTimeout", "purificationHoldTime", "provenBatchCount",
            "dieselPrice"} <= dumped.keys()


def test_purification_defaults_and_flow_time():
    assert S.purification_target_temperature == 70 and S.purification_hold_time == 25
    assert S.planned_flow_seconds(500) == 750            # 500 mL at 40 mL/min = 12.5 min
    assert S.planned_flow_seconds(1000) == 1500
    assert S.planned_flow_seconds(40) == 120             # never shorter than the 2 min minimum
    assert S.planned_flow_seconds(None) == 1500          # unknown volume: plan for the largest batch


@pytest.mark.parametrize("bad", [{"ffaRangeBoundaries": "5"}, {"purificationTargetTemperature": 80},
                                 {"purificationTargetTemperature": 70, "purificationMaximumTemperature": 70}])
def test_settings_validation(bad):
    with pytest.raises(ValueError):
        Settings.model_validate(bad)


# ---------- calculations (same numbers as calculateQuantityCards on the website) ----------
def test_calculator_with_esterification():
    q = calculations.quantity_cards(460, 6, 7, "NaOH", S)
    assert q["esterificationNeeded"] and q["isEstimate"]
    assert approx(q["esterificationMethanolMl"], 78.38) and approx(q["sulfuricAcidMl"], 0.7452, 0.0001)
    assert approx(q["acetoneMl"], 50) and approx(q["transesterificationMethanolMl"], 148.01)
    assert approx(q["catalystBaseG"], 4.6) and approx(q["neutralizationG"], 0.6532)
    assert approx(q["catalystToWeighG"], 5.36) and q["purity"] == 98


def test_calculator_without_esterification():
    q = calculations.quantity_cards(460, 3, 7, "NaOH", S)
    assert not q["esterificationNeeded"] and not q["isEstimate"]
    assert approx(q["catalystToWeighG"], 6.69)


def test_exactly_4_percent_skips_esterification():
    assert not calculations.needs_esterification(4.0, S)
    assert calculations.needs_esterification(4.01, S)


def test_after_esterification():
    nxt = calculations.after_esterification(920, 1.2, 1, 7, "KOH", S)
    assert nxt["action"] == "anotherStage" and nxt["stage"] == 2
    assert approx(nxt["esterificationMethanolMl"], 62.71) and approx(nxt["sulfuricAcidMl"], 0.298)
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
    assert keys == ["0-2", "2-4", "4-6", "6-8", "8-10", "10+"]
    assert labels[1] == "2–4%" and labels[-1] == "Above 10%"
    r24 = analytics.ffa_ranges(S)[1]
    assert analytics.in_range(2.0, r24) and not analytics.in_range(4.0, r24)   # min <= FFA < max


def test_range_rows_on_sample_data():
    rows = {r["range"]["key"]: r for r in analytics.range_rows(_samples(), S)}
    r = rows["2-4"]
    assert r["testedBatches"] == 2 and r["labPassRate"] == 100 and r["status"] == "Testing"
    assert r["recommendedBatchId"] == "B-2026-022" and approx(r["averageYield"], 88.75)
    assert r["minimumYield"] == 88.4 and r["maximumYield"] == 89.1
    assert rows["4-6"]["recommendedParameters"]["esterificationVoltage"] == 20
    assert rows["0-2"]["status"] == "No data" and rows["0-2"]["recommendedParameters"] is None


def test_proven_status():
    base = seed.hydrate(seed.DEMO_BATCHES[0])          # B-2026-024, 2.8% FFA, Passed, 88.4%
    batches = [base.model_copy(update={"id": f"B-{i}", "yield_": y}) for i, y in enumerate([88.4, 87.0, 89.0])]
    rows = {r["range"]["key"]: r for r in analytics.range_rows(batches, S)}
    assert rows["2-4"]["status"] == "Proven"
    batches.append(base.model_copy(update={"id": "B-x", "yield_": 70.0, "lab_result": "Failed"}))
    rows = {r["range"]["key"]: r for r in analytics.range_rows(batches, S)}
    assert rows["2-4"]["status"] == "Testing"            # a failed batch with the same settings


def test_recommended_parameters():
    batches = _samples()
    p = analytics.recommended_parameters(3.0, batches, S)
    assert p["transesterificationTime"] == 65 and p["transesterificationStirring"] == 470
    assert "esterificationVoltage" not in p
    assert analytics.recommended_parameters(5.0, batches, S)["esterificationTime"] == 120
    assert analytics.recommended_parameters(1.0, batches, S) is None


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
    hw.set_heater(True)
    hw.set_valve("mesh_bed", True)            # opening the valve turns the heater off
    assert not hw.heater_on and hw.valves["mesh_bed"]
    with pytest.raises(InterlockError):
        hw.set_heater(True)


def test_watchdog():
    hw = MockHardware()
    hw.set_heater(True)
    hw.demo_set_temperature(80)
    hw.refresh()
    assert hw.watchdog(75, 60) == "Heater stopped: temperature exceeded 75 °C." and not hw.heater_on
    hw.set_electrode_power(True)
    assert hw.watchdog(75, 60).startswith("Electrodes stopped") and not hw.electrode_power_on


# ---------- purification ----------
SCALE = 400   # run the simulated machine 400x faster


async def _purify(runner, hw, fault=None, skip=False, biodiesel_ml=500):
    async def sensor_loop():
        while True:
            hw.refresh()
            await asyncio.sleep(1 / runner.time_scale)
    loop = None if fault else asyncio.create_task(sensor_loop())
    records = []
    runner.start(S, 70, "B-test", records.append, biodiesel_ml=biodiesel_ml, automatic=True)
    if fault:
        await asyncio.sleep(0.05)
        hw._snapshot = {**hw.read(), **fault}
    while runner.running:
        if skip:
            runner.skip()
        await asyncio.sleep(0.01)
    if loop:
        loop.cancel()
    return records[0]


def _demo_hw(scale=SCALE):
    hw = MockHardware(scale)
    hw.demo_load_oil(500)
    hw.refresh()
    return hw


def test_purification_full_sequence():
    # 100x (not 400x): finer simulated steps, so the ±1 °C hold isn't skewed by timer jitter
    hw = _demo_hw(100)
    violations = []
    write = hw._write_heater

    def guarded(on):
        if on and hw.valves["mesh_bed"]:
            violations.append(True)
        write(on)
    hw._write_heater = guarded
    runner = PurificationRunner(hw, 100)
    rec = asyncio.run(_purify(runner, hw))
    st = runner.state
    assert st["phase"] == "complete", st
    assert not rec["safetyStopOccurred"] and rec["automatic"] and rec["warning"] is None
    assert rec["heatingTimeSeconds"] <= 90                     # about a minute to 70 °C
    assert rec["holdTimeSeconds"] == 1500                      # 25 min default hold
    assert 70 <= rec["highestTemperature"] < 72                # held at 70 ±1 °C, below the 75 °C cutoff
    assert rec["plannedFlowSeconds"] == 750 and rec["flowTimeSeconds"] == 750   # 500 mL at 40 mL/min
    assert 60 <= rec["drainTimeSeconds"] <= 180                # drained: weight steady for a minute
    assert rec["outputWeightG"] > 380 and st["flowStableSeconds"] >= 60
    assert not violations and not hw.heater_on and not hw.valves["mesh_bed"]


def test_purification_warns_when_little_comes_out():
    hw = _demo_hw()
    hw.tank_g = 100.0          # a clogged bed lets only 100 g through
    runner = PurificationRunner(hw, SCALE)
    rec = asyncio.run(_purify(runner, hw))
    assert runner.state["phase"] == "complete" and "clogging" in rec["warning"]


def test_purification_counts_only_this_batch_output():
    hw = _demo_hw()
    hw.output_g = 250.0        # last batch's biodiesel still in the collection container
    runner = PurificationRunner(hw, SCALE)
    rec = asyncio.run(_purify(runner, hw, skip=True))
    assert 380 < rec["outputWeightG"] < 400


def test_purification_skip_in_demo():
    hw = _demo_hw()
    runner = PurificationRunner(hw, SCALE)
    rec = asyncio.run(_purify(runner, hw, skip=True))
    assert runner.state["phase"] == "complete" and rec["outputWeightG"] > 380


@pytest.mark.parametrize("fault,reason", [({"temperature": None}, "temperature reading lost"),
                                          ({"temperature": 80.0}, "temperature exceeded 75 °C"),
                                          ({"heaterSubmerged": False}, "biodiesel level dropped below the heater")])
def test_purification_safety_stops(fault, reason):
    hw = _demo_hw()
    runner = PurificationRunner(hw, SCALE)
    rec = asyncio.run(_purify(runner, hw, fault=fault))
    assert runner.state["phase"] == "fault" and rec["safetyStopReason"] == reason
    assert rec["safetyStopOccurred"] and not hw.heater_on and not hw.valves["mesh_bed"]
    with pytest.raises(RuntimeError):         # must acknowledge first
        runner.start(S, 70)
    runner.acknowledge()
    assert runner.state["phase"] == "ready"


def test_purification_abort():
    hw = _demo_hw()
    runner = PurificationRunner(hw, SCALE)

    async def scenario():
        runner.start(S, 70)
        await asyncio.sleep(0.05)
        await runner.abort()
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


async def _start_bad(runner):
    runner.start("Transesterification", S, voltage=35)


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
    db.save_settings(Settings(purification_target_temperature=60))
    assert db.get_settings().purification_target_temperature == 60


def test_failed_batches_are_not_tested():
    b = Batch.model_validate({"id": "B-1", "date": "2026-10-11", "oilVolume": 500, "status": "Failed"})
    assert b.lab_result == "Not tested"
