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
    assert cfg["ffaThreshold"] == 1 and cfg["wholeNumberInputs"] is True and cfg["autoAdvance"] is True
    assert cfg["esterification"]["designFfa"] == 10 and cfg["esterification"]["stripMaxFfa"] == 5
    assert cfg["pumps"]["acidRateMlPerMinute"] == 100 and cfg["drains"]["reactorMinutes"] == 1
    assert cfg["drains"]["centrifugeMinutes"] == 2
    pur = cfg["purification"]
    assert (pur["holdTemperature"], pur["maximumTemperature"], pur["stirringSpeedRpm"]) == (90, 95, 200)
    assert (pur["methanolRemovalMinutes"], pur["contactMinutes"], pur["settlingMinutes"], pur["maxDrainTemperature"]) == (10, 15, 10, 50)
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
    q = client.post("/api/calculate", json={"oilMassG": 460, "ffa": 6, "catalyst": "NaOH"}).json()
    assert round(q["esterificationMethanolMl"], 1) == 130.6 and round(q["catalystToWeighG"], 2) == 5.36
    assert q["uniformDose"] is True and q["doseFfa"] == 10
    assert q["magnesolG"] == 4.6                                        # 500 mL × 0.0092
    assert client.post("/api/calculate", json={"oilMassG": 460, "ffa": 6, "methanolRatio": 12}).status_code == 400
    r = client.post("/api/calculate", json={"oilMassG": 460, "ffa": 2.5})            # FFA is a whole percent
    assert r.status_code == 422 and r.json()["detail"] == "ffa: Use a whole number (no decimals)."
    b = client.post("/api/calculate", json={"oilMassG": 460, "ffa": 1, "adsorbent": "Bentonite"}).json()
    assert b["esterificationNeeded"] is False and b["adsorbentG"] == 9.2


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
    """Pumps load the doses, the outlet valves open by themselves after transesterification and
    separation, and purification starts by itself once the biodiesel reaches the heater."""
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
    client.post("/api/process/stage/complete")
    d = client.get("/api/process/drain").json()
    assert d["valve"] == "reactor_outlet" and d["phase"] == "draining" and d["totalSeconds"] == 60   # 1 min
    assert client.get("/api/live").json()["sensors"]["reactorValveOpen"] is True
    client.post("/api/process/stage/reset")
    busy = client.post("/api/process/stage/start", json={"stage": "Separation", "batchId": b})
    assert busy.status_code == 409 and "reactor outlet" in busy.json()["detail"]
    client.post("/api/process/drain/skip")
    _wait_for(client, "/api/process/drain", "phase", ["done"])
    assert client.get("/api/live").json()["sensors"]["reactorValveOpen"] is False

    # the reactor has drained: separation starts by itself (autoAdvance), then the centrifuge
    # outlet opens and the biodiesel reaches the purification tank
    st = _wait_for(client, "/api/process/stage", "state", ["running"])
    assert st["stage"] == "Separation" and st["batchId"] == b
    client.post("/api/process/stage/complete")
    d = client.get("/api/process/drain").json()
    assert d["valve"] == "centrifuge_outlet" and d["phase"] in ("waiting", "draining")
    assert client.get("/api/live").json()["purificationAutoStart"] is None   # not while it drains
    busy = client.post("/api/process/purification/start", json={"heaterSubmerged": True})
    assert busy.status_code == 409
    client.post("/api/process/drain/skip")
    _wait_for(client, "/api/process/drain", "phase", ["done"])
    p = _wait_for(client, "/api/process/purification", "phase", ["heating"], timeout=3)
    assert p["batchId"] == b and p["automatic"] is True and p["heaterOn"] is True
    assert p["stirrerOn"] is True and p["stirringSpeed"] == 200 and p["targetTemperature"] == 90
    # from the batch's oil: 276 g ÷ 0.92 g/mL = 300 mL; Magnesol = 300 × 0.0092 = 2.76 -> 2.8 g
    assert p["magnesolG"] == 2.8 and p["oilWeightG"] == 276
    assert p["methanolTotalSeconds"] == 600 and p["contactTotalSeconds"] == 900
    client.post("/api/process/purification/abort")

    saved = client.post("/api/batches", json={"id": b, "oilVolume": 300, "ffa": 5, "ffaAboveStrip": True,
                                              "esterificationRun": True}).json()
    labels = [e["label"] for e in saved["timeline"]]
    for expected in ("Pump B loaded 63.5 g for Esterification", "Pump A loaded 72 g for Transesterification",
                     "Reactor outlet valve opened", "Separation started", "Centrifuge outlet valve opened",
                     "Purification started automatically"):
        assert expected in labels, labels
    assert any(label.startswith("Reactor outlet valve closed") for label in labels)
    assert saved["ffaAboveStrip"] is True


def test_drain_time_zero_means_by_hand(client):
    """With centrifugeDrainTime 0 the operator moves the biodiesel; purification is armed at once."""
    client.put("/api/settings", json={"centrifugeDrainTime": 0})
    client.post("/api/process/stage/start", json={"stage": "Separation", "batchId": "B-HAND-1"})
    client.post("/api/process/stage/complete")
    assert client.get("/api/process/drain").json()["phase"] == "idle"
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


def test_auto_advance_can_be_turned_off(client):
    """autoAdvance off: after the reactor drains, the operator starts the separation."""
    client.put("/api/settings", json={"autoAdvance": False})
    client.post("/api/process/stage/start", json={"stage": "Transesterification", "batchId": "B-MAN-1"})
    client.post("/api/process/stage/complete")
    client.post("/api/process/drain/skip")
    _wait_for(client, "/api/process/drain", "phase", ["done"])
    time.sleep(0.3)
    assert client.get("/api/process/stage").json()["stage"] == "Transesterification"


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
    client.post("/api/process/drain/skip")
    _wait_for(client, "/api/process/stage", "stage", ["Separation"])
    client.post("/api/process/stage/complete")
    _wait_for(client, "/api/process/drain", "phase", ["waiting", "draining", "done"])
    client.post("/api/process/drain/skip")
    p = _wait_for(client, "/api/process/purification", "phase", ["heating"], timeout=4)
    assert p["adsorbent"] == "Bentonite" and p["adsorbentG"] == 9.2 and p["magnesolG"] == 9.2
    client.post("/api/process/purification/skip")
    _wait_for(client, "/api/process/purification", "phase", ["methanol"])
    client.post("/api/process/purification/skip")
    _wait_for(client, "/api/process/purification", "phase", ["magnesol"])
    client.post("/api/process/purification/magnesol-added")
    for _ in range(60):                                     # contact, settling, cooling, drain
        if client.get("/api/process/purification").json()["phase"] in ("complete", "fault"):
            break
        client.post("/api/process/purification/skip")
        time.sleep(0.15)
    p = _wait_for(client, "/api/process/purification", "phase", ["complete"], timeout=8)
    saved = client.post("/api/batches", json={"id": b, "oilVolume": 500, "ffa": 1, "adsorbent": "Bentonite"}).json()
    assert saved["adsorbent"] == "Bentonite" and saved["purification"]["adsorbent"] == "Bentonite"
    assert saved["materials"]["bentoniteKg"] == 0.0092 and saved["materials"]["magnesolKg"] == 0
    assert "Bentonite added (9.2 g)" in [e["label"] for e in saved["timeline"]]
