"""API tests with the real FastAPI. They need FastAPI and httpx:  python -m pytest"""
import time

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from app import config  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture()
def client(mysql_db):
    """The API on an empty MySQL test database (fixture mysql_db in conftest.py)."""
    with TestClient(app) as c:
        yield c


def _wait_for(client, path, key, values, timeout=6.0):
    """Polls a state endpoint until state[key] is one of values."""
    end = time.time() + timeout
    while True:
        st = client.get(path).json()
        if st[key] in values or time.time() > end:
            assert st[key] in values, st
            return st
        time.sleep(0.1)


def test_health_and_config(client):
    assert client.get("/api/health").json()["status"] == "ok"
    cfg = client.get("/api/config").json()
    assert cfg["esterification"]["voltage"] == {"min": 10, "max": 30, "default": 20}
    assert cfg["transesterification"]["time"] == {"min": 30, "max": 180, "default": 120}
    assert cfg["esterification"]["current"] == {"min": 1, "max": 2, "default": 1}
    assert cfg["powerSupply"]["currentControl"] is False
    assert cfg["ffaThreshold"] == 3 and cfg["wholeNumberInputs"] is True and cfg["autoAdvance"] is True
    assert cfg["esterification"]["designFfa"] == 10 and cfg["esterification"]["stripMaxFfa"] == 5
    assert cfg["pumps"]["acidRateMlPerMinute"] == 100
    # no drain time: the outlets stay open until the batch is complete
    assert cfg["drains"] == {"stayOpenUntilComplete": True, "centrifugeSpinDownSeconds": 30}
    pur = cfg["purification"]
    assert (pur["holdTemperature"], pur["holdBand"], pur["maximumTemperature"], pur["stirringSpeedRpm"]) == (90, 1, 95, 200)
    assert (pur["methanolRemovalMinutes"], pur["contactMinutes"]) == (10, 10)
    assert not {"settlingMinutes", "maxDrainTemperature", "drainMaximumMinutes"} & set(pur)   # no settling/cooling
    assert pur["magnesolGramsPerMlOil"] == 0.0092 and pur["bentoniteGramsPerMlOil"] == 0.0184
    assert pur["adsorbents"] == ["Magnesol", "Bentonite"] and pur["defaultAdsorbent"] == "Magnesol"


def test_settings_partial_update(client):
    s = client.put("/api/settings", json={"methanolRemovalTime": 12, "methanolPrice": None}).json()
    assert s["methanolRemovalTime"] == 12 and s["methanolPrice"] == 70
    assert client.put("/api/settings", json={"methanolRemovalTime": 40}).status_code == 400   # 5-30 min
    assert client.put("/api/settings", json={"ffaRangeBoundaries": "5"}).status_code == 400
    r = client.put("/api/settings", json={"contactTime": 12.5})                      # whole numbers only
    assert r.status_code == 400 and "whole number" in r.json()["detail"]


def test_calculate(client):
    q = client.post("/api/calculate", json={"oilMassG": 460, "ffa": 5, "catalyst": "NaOH"}).json()
    assert round(q["esterificationMethanolMl"], 1) == 130.6 and round(q["catalystToWeighG"], 2) == 6.69
    assert q["uniformDose"] is True and q["doseFfa"] == 10
    assert q["magnesolG"] == 4.6                                        # 500 mL × 0.0092
    assert client.post("/api/calculate", json={"oilMassG": 460, "ffa": 5, "methanolRatio": 12}).status_code == 400
    assert client.post("/api/calculate", json={"oilMassG": 460, "ffa": 6}).status_code == 422
    r = client.post("/api/calculate", json={"oilMassG": 460, "ffa": 2.5})            # FFA is a whole percent
    assert r.status_code == 422 and r.json()["detail"] == "ffa: Use a whole number (no decimals)."
    b = client.post("/api/calculate", json={"oilMassG": 460, "ffa": 1, "adsorbent": "Bentonite"}).json()
    assert b["esterificationNeeded"] is False and b["adsorbentG"] == 9.2


def test_ffa_pathway_and_after_esterification_threshold(client):
    direct = client.post("/api/calculate", json={"oilMassG": 460, "ffa": 3}).json()
    assert direct["esterificationNeeded"] is False
    esterify = client.post("/api/calculate", json={"oilMassG": 460, "ffa": 4}).json()
    assert esterify["esterificationNeeded"] is True
    accepted = client.post("/api/calculate/after-esterification", json={"oilMassG": 460, "ffaAfter": 3}).json()
    assert accepted["action"] == "transesterification" and accepted["ffa"] == 3
    not_yet = client.post("/api/calculate/after-esterification", json={"oilMassG": 460, "ffaAfter": 4}).json()
    assert not_yet["action"] == "anotherStage"
    assert client.post("/api/calculate/after-esterification", json={"oilMassG": 460, "ffaAfter": 6}).status_code == 422


def test_save_batch_and_lab_result(client):
    b = client.post("/api/batches", json={"oilVolume": 500, "ffa": 1, "status": "Completed",
                                          "biodieselOutputMl": 440, "reactionTime": 120, "stirringSpeed": 500}).json()
    assert b["id"].startswith("B-") and b["yield"] == 88.0 and b["labResult"] == "Pending"
    assert b["materials"]["oilL"] == 0.5
    r = client.post(f"/api/batches/{b['id']}/lab-result", json={"labResult": "Passed", "labReference": "L-1"})
    assert r.json()["labResult"] == "Passed"
    assert client.get("/api/analytics/summary").json()["labPassRate"] == 100
    assert client.get("/api/analytics/recommended", params={"ffa": 1}).json()["transesterificationTime"] == 120


def test_stage_controls(client):
    r = client.post("/api/process/stage/start", json={"stage": "Transesterification", "voltage": 30,
                                                      "time": 30, "stirring": 500})
    assert r.json()["state"] == "running"
    assert client.post("/api/process/stage/pause").json()["state"] == "paused"
    assert client.post("/api/process/stage/resume").json()["state"] == "running"
    assert client.post("/api/process/stage/complete").json()["state"] == "complete"
    bad = client.post("/api/process/stage/start", json={"stage": "Esterification", "voltage": 35})
    assert bad.status_code == 409
    client.post("/api/process/stage/reset")
    bad = client.post("/api/process/stage/start", json={"stage": "Esterification", "current": 3})
    assert bad.status_code == 409 and "Current must be between 1 and 2" in bad.json()["detail"]
    bad = client.post("/api/process/stage/start", json={"stage": "Esterification", "current": 1.5})
    assert bad.status_code == 422 and "whole number" in bad.json()["detail"]


def test_purification_rules(client):
    time.sleep(1.2)   # let the sensor loop take a reading
    assert client.post("/api/process/purification/start", json={"heaterSubmerged": True}).status_code == 409  # empty tank
    client.post("/api/demo/load-oil", json={"volumeMl": 500})
    client.post("/api/demo/add", json={"place": "purificationTank", "grams": 391})
    time.sleep(1.2)
    r = client.post("/api/process/purification/start", json={})   # level switch confirms it
    assert r.status_code == 200, r.json()
    assert r.status_code == 200 and r.json()["phase"] == "heating"
    client.post("/api/process/purification/abort")
    assert client.get("/api/process/purification").json()["phase"] == "fault"
    assert client.post("/api/process/purification/acknowledge").json()["phase"] == "ready"


def test_heater_interlock(client):
    client.post("/api/control/valve", json={"name": "mesh_bed", "open": True})
    assert client.post("/api/control/heater", json={"on": True}).status_code == 409
    assert client.post("/api/control/all-off").json()["sensors"]["meshBedValveOpen"] is False


def test_unexpected_error_returns_json(mysql_db):
    """An unexpected error must come back as JSON, so the website shows it instead of going offline."""
    from app import db
    original = db.list_batches
    db.list_batches = lambda: 1 / 0
    try:
        with TestClient(app, raise_server_exceptions=False) as c:
            r = c.get("/api/batches")
    finally:
        db.list_batches = original
    assert r.status_code == 500
    assert r.headers["content-type"].startswith("application/json")
    assert "division by zero" in r.json()["detail"]


def test_whole_batch_moves_through_the_machine(client):
    """Valve handoffs and the next stages run automatically even if the legacy stored flags are off."""
    # These two persisted preferences are retained for DB compatibility, but handoffs are now automatic.
    app.state.settings.auto_advance = False
    app.state.settings.purification_auto_start = False
    b = "B-FLOW-1"
    client.post("/api/demo/load-oil", json={"volumeMl": 300})              # 276 g of oil
    time.sleep(1.2)
    assert client.get("/api/live").json()["sensors"]["oilMassG"] == 276
    app.state.purification.state["phase"] = "complete"                     # the previous batch's finished run

    # esterification: pump B loads the H2SO4 + methanol premix
    r = client.post("/api/process/pump/start", json={"pump": "acid", "targetG": 63.5, "volumeMl": 79.1,
                                                     "batchId": b, "stage": "Esterification"})
    assert r.status_code == 200 and r.json()["phase"] == "pumping" and r.json()["startWeightG"] == 276
    assert client.get("/api/live").json()["sensors"]["pumps"]["acid"] is True
    busy = client.post("/api/process/stage/start", json={"stage": "Esterification", "batchId": b})
    assert busy.status_code == 409 and "still loading" in busy.json()["detail"]
    client.post("/api/process/pump/skip")
    assert _wait_for(client, "/api/process/pump", "phase", ["done"])["deliveredG"] == 63.5
    assert client.post("/api/process/stage/start", json={"stage": "Esterification", "batchId": b}).status_code == 200
    busy = client.post("/api/process/pump/start", json={"pump": "catalyst", "targetG": 10, "volumeMl": 10})
    assert busy.status_code == 409                                         # no loading during a stage
    client.post("/api/process/stage/complete")
    client.post("/api/process/stage/reset")

    # transesterification: pump A loads the NaOH + methanol premix
    client.post("/api/process/pump/start", json={"pump": "catalyst", "targetG": 72.0, "volumeMl": 88.8,
                                                 "batchId": b, "stage": "Transesterification"})
    client.post("/api/process/pump/skip")
    _wait_for(client, "/api/process/pump", "phase", ["done"])
    client.post("/api/process/stage/start", json={"stage": "Transesterification", "batchId": b, "oilMassG": 276})
    done = client.post("/api/process/stage/complete").json()
    assert done["stage"] == "Transesterification" and done["state"] == "complete"

    # no drain time: the reactor outlet opens and separation starts at once; the outlet stays open
    st = _wait_for(client, "/api/process/stage", "state", ["running"])
    assert st["stage"] == "Separation" and st["batchId"] == b
    live = client.get("/api/live").json()
    assert live["sensors"]["reactorValveOpen"] is True and live["drain"]["openValves"] == ["reactor_outlet"]
    time.sleep(0.5)
    assert client.get("/api/live").json()["sensors"]["reactorValveOpen"] is True
    client.post("/api/process/drain/skip")                                   # demo: the mixture arrives at once

    # separation done and the centrifuge stopped: its outlet opens, purification starts at once
    client.post("/api/process/stage/complete")
    _wait_for(client, "/api/process/drain", "phase", ["open"])
    client.post("/api/process/drain/skip")                                   # demo: the biodiesel arrives at once
    p = _wait_for(client, "/api/process/purification", "phase", ["heating"], timeout=3)
    sensors = client.get("/api/live").json()["sensors"]
    assert sensors["reactorValveOpen"] is True and sensors["centrifugeValveOpen"] is True   # both still open
    assert p["batchId"] == b and p["automatic"] is True and p["heaterOn"] is True
    assert p["stirrerOn"] is True and p["stirrerRpm"] is None                # no RPM reading while heating
    assert p["stirringSpeed"] == 200 and p["targetTemperature"] == 90
    # from the batch's oil: 276 g ÷ 0.92 g/mL = 300 mL; Magnesol = 300 × 0.0092 = 2.76 -> 2.8 g
    assert p["magnesolG"] == 2.8 and p["oilWeightG"] == 276
    assert p["methanolTotalSeconds"] == 600 and p["contactTotalSeconds"] == 600
    client.post("/api/process/purification/abort")
    # purification over (here: stopped): every valve is closed
    assert not any(client.get("/api/live").json()["sensors"]["valves"].values())

    saved = client.post("/api/batches", json={"id": b, "oilVolume": 300, "ffa": 5, "ffaAboveStrip": True,
                                              "esterificationRun": True}).json()
    labels = [e["label"] for e in saved["timeline"]]
    for expected in ("Pump B loaded 63.5 g for Esterification", "Pump A loaded 72 g for Transesterification",
                     "Reactor outlet valve opened", "Separation started", "Centrifuge outlet valve opened",
                     "Purification started automatically", "Reactor outlet valve closed",
                     "Centrifuge outlet valve closed"):
        assert expected in labels, labels
    assert labels.index("Separation started") < labels.index("Reactor outlet valve closed")
    assert saved["ffaAboveStrip"] is True


def test_emergency_stop_closes_the_open_outlets(client):
    client.post("/api/process/stage/start", json={"stage": "Transesterification", "batchId": "B-ESTOP-1"})
    client.post("/api/process/stage/complete")
    _wait_for(client, "/api/process/stage", "stage", ["Separation"])
    assert client.get("/api/live").json()["sensors"]["reactorValveOpen"] is True
    live = client.post("/api/control/all-off").json()
    assert not any(live["sensors"]["valves"].values()) and live["drain"]["openValves"] == []


def test_old_drain_time_settings_are_ignored(client):
    """reactorDrainTime / centrifugeDrainTime stay in MySQL but aren't used: the outlet opens and
    purification is armed at once, whatever they are."""
    client.put("/api/settings", json={"centrifugeDrainTime": 0, "reactorDrainTime": 9})
    client.post("/api/process/stage/start", json={"stage": "Separation", "batchId": "B-HAND-1"})
    client.post("/api/process/stage/complete")
    d = _wait_for(client, "/api/process/drain", "phase", ["open"])
    assert d["valve"] == "centrifuge_outlet" and d["openValves"] == ["centrifuge_outlet"]
    assert client.get("/api/live").json()["purificationAutoStart"] == "B-HAND-1"


def test_pump_and_valve_rules(client):
    client.post("/api/control/valve", json={"name": "reactor_outlet", "open": True})
    r = client.post("/api/control/pump", json={"name": "acid", "on": True})
    assert r.status_code == 409 and "reactor outlet" in r.json()["detail"]
    r = client.post("/api/process/pump/start", json={"pump": "acid", "targetG": 10, "volumeMl": 10})
    assert r.status_code == 409
    client.post("/api/control/valve", json={"name": "reactor_outlet", "open": False})
    assert client.post("/api/control/pump", json={"name": "acid", "on": True}).json()["pumps"]["acid"] is True
    off = client.post("/api/control/all-off").json()
    assert off["sensors"]["pumps"] == {"catalyst": False, "acid": False}


def test_emergency_stop_stops_pump(client):
    client.post("/api/demo/load-oil", json={"volumeMl": 300})
    time.sleep(1.2)
    client.post("/api/process/pump/start", json={"pump": "acid", "targetG": 60, "volumeMl": 75})
    live = client.post("/api/control/all-off").json()
    assert live["pump"]["phase"] == "stopped" and live["sensors"]["pumps"]["acid"] is False


def test_system_status_lists_the_new_parts(client):
    time.sleep(1.2)
    st = client.get("/api/system/status").json()
    labels = [t["label"] for t in st["tiles"]]
    assert {"Dosing Pumps", "Outlet Valves", "Output Load Cell", "Reactor Load Cell"} <= set(labels)
    tiles = {t["label"]: t for t in st["tiles"]}
    for name in ("Reactor Stirrer", "Centrifuge Motor", "Purification Stirrer", "Heater"):
        assert tiles[name]["value"] == "Ready" and tiles[name]["state"] == "ready"
    assert tiles["Electrodes"]["value"] == "Graphite – graphite"
    devices = {d["label"]: d["status"] for d in st["devices"]}
    assert devices["Reactor outlet valve"] == "Closed" and devices["Dry wash stirrer"] == "Ready"
    assert devices["Pump B (H₂SO₄ + methanol)"] == "Ready"


def test_level_switch_blocks_and_stops_heater(client):
    """No biodiesel at the heater: manual start is refused, even with the confirmation ticked."""
    time.sleep(1.2)   # demo machine starts empty
    r = client.post("/api/process/purification/start", json={"heaterSubmerged": True})
    assert r.status_code == 409 and "level switch" in r.json()["detail"]


def test_network_addresses(client):
    addresses = client.get("/api/network").json()["addresses"]
    assert isinstance(addresses, list)
    assert all(not a.startswith("127.") and a.count(".") == 3 for a in addresses)


def test_magnesol_step_waits_for_the_operator(client):
    client.post("/api/demo/load-oil", json={"volumeMl": 500})
    client.post("/api/demo/add", json={"place": "purificationTank", "grams": 391})
    time.sleep(1.2)
    r = client.post("/api/process/purification/start", json={"batchId": "B-MAG-1", "oilVolumeMl": 500})
    assert r.status_code == 200 and r.json()["magnesolG"] == 4.6
    assert client.post("/api/process/purification/magnesol-added").status_code == 409   # not asked yet
    client.post("/api/process/purification/skip")                                        # heating
    _wait_for(client, "/api/process/purification", "phase", ["methanol"])
    client.post("/api/process/purification/skip")                                        # methanol removal
    p = _wait_for(client, "/api/process/purification", "phase", ["magnesol"])
    assert p["heaterOn"] is False and p["stirrerOn"] is True
    time.sleep(1.5)
    assert client.get("/api/process/purification").json()["phase"] == "magnesol"         # still waiting
    p = client.post("/api/process/purification/magnesol-added").json()
    p = _wait_for(client, "/api/process/purification", "phase", ["contact"])
    assert p["magnesolAdded"] is True
    client.post("/api/process/purification/abort")


def test_overcurrent_stops_electrodes_with_a_warning(client):
    r = client.post("/api/process/stage/start", json={"stage": "Transesterification", "batchId": "B-AMP-1", "current": 1})
    assert r.json()["current"] == 1 and r.json()["currentLimitSet"] is False
    app.state.hw.supply_current_limit = 1.5            # the supply was set too high
    st = _wait_for(client, "/api/process/stage", "state", ["fault"], timeout=6)
    assert "above the 1 A setting" in st["faultReason"]
    live = client.get("/api/live").json()
    assert live["sensors"]["electrodePowerOn"] is False and live["alarm"].startswith("Electrodes stopped: current")
    client.post("/api/process/stage/reset")


def test_heater_needs_the_stirrer(client):
    client.post("/api/demo/add", json={"place": "purificationTank", "grams": 391})
    time.sleep(1.2)
    r = client.post("/api/control/heater", json={"on": True})
    assert r.status_code == 409 and "stirrer" in r.json()["detail"]
    client.post("/api/control/motor", json={"name": "purification_stirrer", "duty": 0.33})
    assert client.post("/api/control/heater", json={"on": True}).json()["heaterOn"] is True
    client.post("/api/control/all-off")


def test_legacy_auto_advance_setting_is_ignored(client):
    """autoAdvance is a legacy column: the next process always starts at once."""
    client.put("/api/settings", json={"autoAdvance": False})
    client.post("/api/process/stage/start", json={"stage": "Transesterification", "batchId": "B-MAN-1"})
    client.post("/api/process/stage/complete")
    st = _wait_for(client, "/api/process/stage", "stage", ["Separation"])
    assert st["state"] == "running"


def test_saving_a_batch_never_fails_on_the_purification_record(client):
    """A partial purification record (a run that stopped early, an older website) still saves,
    and a missing oil volume comes from the oil weight."""
    r = client.post("/api/batches", json={"id": "B-SAVE-1", "oilMassG": 460, "ffa": 1,
                                          "purification": {"safetyStopOccurred": False, "outputWeightG": 400}})
    assert r.status_code == 201, r.json()
    b = r.json()
    assert b["oilVolume"] == 500 and b["purification"]["targetTemperature"] == 90
    assert b["purification"]["highestTemperature"] is None and b["biodieselOutputMl"] == 454.5


def test_whole_numbers_and_readable_errors(client):
    r = client.post("/api/process/stage/start", json={"stage": "Transesterification", "voltage": 20.5})
    assert r.status_code == 422 and r.json()["detail"] == "voltage: Use a whole number (no decimals)."
    r = client.post("/api/process/pump/start", json={"pump": "acid", "volumeMl": 10})
    assert r.status_code == 422 and r.json()["detail"] == "targetG: Field required"   # names the field
    assert client.post("/api/strip/read").json()["ffa"] in range(0, 6)


def test_bentonite_batch(client):
    """The adsorbent sent with the stages is used when purification starts by itself, and the
    saved batch's materials count bentonite instead of Magnesol."""
    b = "B-BEN-1"
    client.post("/api/demo/load-oil", json={"volumeMl": 500})
    time.sleep(1.2)
    client.post("/api/process/stage/start", json={"stage": "Transesterification", "batchId": b, "oilMassG": 460,
                                                   "adsorbent": "Bentonite"})
    client.post("/api/process/stage/complete")
    _wait_for(client, "/api/process/stage", "stage", ["Separation"])
    client.post("/api/process/drain/skip")
    client.post("/api/process/stage/complete")
    _wait_for(client, "/api/process/drain", "phase", ["open"])
    client.post("/api/process/drain/skip")
    p = _wait_for(client, "/api/process/purification", "phase", ["heating"], timeout=4)
    assert p["adsorbent"] == "Bentonite" and p["adsorbentG"] == 9.2 and p["magnesolG"] == 9.2
    client.post("/api/process/purification/skip")
    _wait_for(client, "/api/process/purification", "phase", ["methanol"])
    client.post("/api/process/purification/skip")
    _wait_for(client, "/api/process/purification", "phase", ["magnesol"])
    client.post("/api/process/purification/magnesol-added")
    for _ in range(60):                                     # contact, drain
        if client.get("/api/process/purification").json()["phase"] in ("complete", "fault"):
            break
        client.post("/api/process/purification/skip")
        time.sleep(0.15)
    p = _wait_for(client, "/api/process/purification", "phase", ["complete"], timeout=8)
    saved = client.post("/api/batches", json={"id": b, "oilVolume": 500, "ffa": 1, "adsorbent": "Bentonite"}).json()
    assert saved["adsorbent"] == "Bentonite" and saved["purification"]["adsorbent"] == "Bentonite"
    assert saved["materials"]["bentoniteKg"] == 0.0092 and saved["materials"]["magnesolKg"] == 0
    assert "Bentonite added (9.2 g)" in [e["label"] for e in saved["timeline"]]


# ---------- one batch at a time: start, continue, complete, cancel ----------
def _count(sql, *args):
    from app import db
    with db.transaction() as cur:
        cur.execute(sql, args)
        return cur.fetchone()["n"]


def test_only_one_batch_in_progress(client):
    assert client.get("/api/batches/active").json() is None
    preview = client.get("/api/batches/next-id").json()["id"]
    r = client.post("/api/batches/start", json={"id": preview})
    assert r.status_code == 201
    b = r.json()
    assert b["id"] == preview and b["status"] == "In Progress" and b["progress"] is None
    assert [e["label"] for e in b["timeline"]] == ["Batch started"]
    # it is in Batch History at once, and the next ID moves on
    listed = client.get("/api/batches").json()
    assert [(x["id"], x["status"]) for x in listed] == [(preview, "In Progress")]
    assert client.get("/api/batches/next-id").json()["id"] != preview
    # a second batch is refused; starting the same one again just returns it
    r = client.post("/api/batches/start", json={})
    assert r.status_code == 409 and f"Batch {preview} is still in progress" in r.json()["detail"]
    r = client.post("/api/batches", json={"oilVolume": 500, "status": "In Progress"})
    assert r.status_code == 409
    assert client.post("/api/batches/start", json={"id": preview}).json()["id"] == preview
    assert client.get("/api/batches/active").json()["id"] == preview
    assert _count("SELECT COUNT(*) AS n FROM production_batches") == 1
    assert _count("SELECT COUNT(*) AS n FROM batch_lab_results") == 0   # no lab result while it runs
    # the analytics don't count it as an unfinished (failed) batch
    assert client.get("/api/analytics/summary").json()["completionRate"] == 0


def test_progress_is_saved_for_continuing(client):
    b = client.post("/api/batches/start").json()["id"]
    state = {"version": 1, "step": 3, "ffa": "4", "loads": {"Esterification 1": {"completedG": 63.5}}}
    r = client.put(f"/api/batches/{b}/progress", json={
        "stage": "Esterification", "state": state,
        "batch": {"oilVolume": 500, "oilMassG": 460, "ffa": 4, "esterificationRun": True, "catalystType": "KOH",
                  "yield": 99, "status": "Completed", "labResult": "Passed"}})   # results are ignored
    assert r.status_code == 200
    active = client.get("/api/batches/active").json()
    assert active["progress"]["stage"] == "Esterification" and active["progress"]["state"] == state
    assert active["currentStage"] == "Esterification"
    assert (active["oilVolume"], active["ffa"], active["catalystType"]) == (500, 4, "KOH")
    assert (active["status"], active["yield"], active["labResult"]) == ("In Progress", 0, "Pending")
    assert client.get("/api/batches").json()[0]["currentStage"] == "Esterification"
    # saved again: the same progress row is updated
    client.put(f"/api/batches/{b}/progress", json={"stage": "Transesterification", "state": {"step": 4}})
    assert _count("SELECT COUNT(*) AS n FROM batch_progress") == 1
    assert client.get(f"/api/batches/{b}").json()["currentStage"] == "Transesterification"
    assert client.put("/api/batches/B-NONE/progress", json={"stage": "Oil Loading"}).status_code == 404


def test_completing_the_ongoing_batch_updates_its_row(client):
    b = client.post("/api/batches/start").json()["id"]
    client.put(f"/api/batches/{b}/progress", json={"stage": "Separation", "state": {}})
    # what the machine does is written to the ongoing batch's timeline as it happens
    client.post("/api/process/stage/start", json={"stage": "Separation", "batchId": b})
    client.post("/api/process/stage/complete")
    labels = [e["label"] for e in client.get(f"/api/batches/{b}").json()["timeline"]]
    assert labels[:3] == ["Batch started", "Separation started", "Separation completed"]
    client.post("/api/process/drain/stop")
    client.post("/api/process/stage/reset")

    saved = client.post("/api/batches", json={"id": b, "oilVolume": 500, "ffa": 1, "status": "Completed",
                                              "biodieselOutputMl": 440, "reactionTime": 120}).json()
    assert saved["status"] == "Completed" and saved["yield"] == 88.0 and saved["labResult"] == "Pending"
    labels = [e["label"] for e in saved["timeline"]]
    assert labels[0] == "Batch started" and labels[-1] == "Batch saved" and "Separation completed" in labels
    # one row for the batch, one lab result row, no progress left; nothing is ongoing any more
    assert _count("SELECT COUNT(*) AS n FROM production_batches WHERE batch_id = %s", b) == 1
    assert _count("SELECT COUNT(*) AS n FROM batch_lab_results WHERE batch_id = %s", b) == 1
    assert _count("SELECT COUNT(*) AS n FROM batch_progress") == 0
    assert client.get("/api/batches/active").json() is None
    assert "currentStage" not in client.get(f"/api/batches/{b}").json()
    # saving it again changes nothing, and it can't be continued any more
    again = client.post("/api/batches", json={"id": b, "oilVolume": 999, "status": "Completed"}).json()
    assert again["oilVolume"] == 500 and len(again["timeline"]) == len(saved["timeline"])
    assert client.put(f"/api/batches/{b}/progress", json={"stage": "Separation"}).status_code == 409
    assert client.patch(f"/api/batches/{b}", json={"status": "In Progress"}).status_code == 409
    # and the next batch can start
    assert client.post("/api/batches/start").status_code == 201


def test_cancel_the_ongoing_batch(client):
    b = client.post("/api/batches/start").json()["id"]
    cancelled = client.post(f"/api/batches/{b}/cancel").json()
    assert cancelled["status"] == "Cancelled" and cancelled["labResult"] == "Not tested"
    assert cancelled["timeline"][-1]["label"] == "Batch cancelled"
    assert client.get("/api/batches/active").json() is None
    assert client.post(f"/api/batches/{b}/cancel").status_code == 409
    assert client.put(f"/api/batches/{b}/progress", json={"stage": "Oil Loading"}).status_code == 409
    nxt = client.post("/api/batches/start").json()
    assert nxt["id"] != b and nxt["status"] == "In Progress"
    statuses = {x["id"]: x["status"] for x in client.get("/api/batches").json()}
    assert statuses == {b: "Cancelled", nxt["id"]: "In Progress"}


def test_the_machine_runs_only_the_ongoing_batch(client):
    b = client.post("/api/batches/start").json()["id"]
    r = client.post("/api/process/stage/start", json={"stage": "Separation", "batchId": "B-OTHER"})
    assert r.status_code == 409 and f"Batch {b} is in progress" in r.json()["detail"]
    r = client.post("/api/process/pump/start", json={"pump": "acid", "targetG": 10, "volumeMl": 10, "batchId": "B-OTHER"})
    assert r.status_code == 409
    assert client.post("/api/process/stage/start", json={"stage": "Separation", "batchId": b}).status_code == 200
    r = client.post(f"/api/batches/{b}/cancel")                   # not while it runs
    assert r.status_code == 409 and "Separation is running" in r.json()["detail"]
    client.post("/api/control/all-off")
    assert client.post(f"/api/batches/{b}/cancel").status_code == 200


def test_no_new_batch_while_the_machine_is_busy(client):
    client.post("/api/process/stage/start", json={"stage": "Separation"})   # running without a batch
    r = client.post("/api/batches/start")
    assert r.status_code == 409 and "machine is still busy" in r.json()["detail"]
    client.post("/api/control/all-off")
    assert client.post("/api/batches/start").status_code == 201


# ---------- lab results: one row per batch, its time kept ----------
def test_lab_result_updates_one_row_and_keeps_its_time(client):
    from datetime import datetime as dt

    b = client.post("/api/batches", json={"oilVolume": 500, "ffa": 1, "status": "Completed"}).json()["id"]
    lab_rows = lambda: _count("SELECT COUNT(*) AS n FROM batch_lab_results WHERE batch_id = %s", b)
    assert lab_rows() == 1 and client.get(f"/api/batches/{b}").json()["labResult"] == "Pending"

    # recorded on the website at 02:50:53 UTC: saved in the Pi's local time, in the same row
    sent = "2026-10-15T02:50:53.250Z"
    local = dt.fromisoformat("2026-10-15T02:50:53.250+00:00").astimezone().replace(tzinfo=None).isoformat()
    r = client.post(f"/api/batches/{b}/lab-result", json={"labResult": "Passed", "labReference": "L-1", "testedAt": sent})
    passed = r.json()
    assert (passed["labResult"], passed["labReference"], passed["labTestedAt"]) == ("Passed", "L-1", local)
    assert lab_rows() == 1
    events = [e["label"] for e in passed["timeline"]]
    assert events[-1] == "Lab result recorded: Passed (L-1)" and passed["timeline"][-1]["time"] == local

    # the same result again: nothing changes, the first time stays
    again = client.post(f"/api/batches/{b}/lab-result", json={"labResult": "Passed", "testedAt": "2026-10-16T00:00:00Z"}).json()
    assert again["labTestedAt"] == local and len(again["timeline"]) == len(passed["timeline"])

    # changed to Failed (no reference typed: the saved one stays), with a new time; still one row
    failed = client.post(f"/api/batches/{b}/lab-result", json={"labResult": "Failed"}).json()
    assert (failed["labResult"], failed["labReference"]) == ("Failed", "L-1") and failed["labTestedAt"] > local
    assert lab_rows() == 1 and failed["timeline"][-1]["label"] == "Lab result recorded: Failed (L-1)"

    # other saves of the batch never clear the time, even when asked to
    for updates in ({"notes": "checked"}, {"labTestedAt": None}):
        assert client.patch(f"/api/batches/{b}", json=updates).json()["labTestedAt"] == failed["labTestedAt"]
    assert lab_rows() == 1
    assert client.get("/api/batches").json()[0]["labTestedAt"] == failed["labTestedAt"]
