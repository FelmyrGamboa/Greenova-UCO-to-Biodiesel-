"""API tests with the real FastAPI. They need FastAPI and httpx:  python -m pytest"""
import time

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from app import config  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture()
def client(tmp_path):
    config.DB_PATH = tmp_path / "api.db"
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
    assert cfg["esterification"]["voltage"] == {"min": 18, "max": 30, "default": 20}
    assert cfg["ffaThreshold"] == 4
    assert cfg["esterification"]["designFfa"] == 10 and cfg["esterification"]["stripMaxFfa"] == 5
    assert cfg["pumps"]["acidRateMlPerMinute"] == 100 and cfg["drains"]["reactorMinutes"] == 3
    assert cfg["purification"]["stirringSpeedRpm"] == 300


def test_settings_partial_update(client):
    s = client.put("/api/settings", json={"purificationTargetTemperature": 64, "methanolPrice": None}).json()
    assert s["purificationTargetTemperature"] == 64 and s["methanolPrice"] == 70
    assert client.put("/api/settings", json={"ffaRangeBoundaries": "5"}).status_code == 400


def test_calculate(client):
    q = client.post("/api/calculate", json={"oilMassG": 460, "ffa": 6, "catalyst": "NaOH"}).json()
    assert round(q["esterificationMethanolMl"], 1) == 130.6 and round(q["catalystToWeighG"], 2) == 5.36
    assert q["uniformDose"] is True and q["doseFfa"] == 10
    assert client.post("/api/calculate", json={"oilMassG": 460, "ffa": 6, "methanolRatio": 12}).status_code == 400


def test_save_batch_and_lab_result(client):
    b = client.post("/api/batches", json={"oilVolume": 500, "ffa": 3, "status": "Completed",
                                          "biodieselOutputMl": 440, "reactionTime": 120, "stirringSpeed": 500}).json()
    assert b["id"].startswith("B-") and b["yield"] == 88.0 and b["labResult"] == "Pending"
    assert b["materials"]["oilL"] == 0.5
    r = client.post(f"/api/batches/{b['id']}/lab-result", json={"labResult": "Passed", "labReference": "L-1"})
    assert r.json()["labResult"] == "Passed"
    assert client.get("/api/analytics/summary").json()["labPassRate"] == 100
    assert client.get("/api/analytics/recommended", params={"ffa": 3}).json()["transesterificationTime"] == 120


def test_stage_controls(client):
    r = client.post("/api/process/stage/start", json={"stage": "Transesterification", "voltage": 30,
                                                      "time": 30, "stirring": 500})
    assert r.json()["state"] == "running"
    assert client.post("/api/process/stage/pause").json()["state"] == "paused"
    assert client.post("/api/process/stage/resume").json()["state"] == "running"
    assert client.post("/api/process/stage/complete").json()["state"] == "complete"
    bad = client.post("/api/process/stage/start", json={"stage": "Esterification", "voltage": 35})
    assert bad.status_code == 409


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


def test_unexpected_error_returns_json(tmp_path):
    """An unexpected error must come back as JSON, so the website shows it instead of going offline."""
    from app import db
    config.DB_PATH = tmp_path / "api.db"
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
    assert d["valve"] == "reactor_outlet" and d["phase"] == "draining" and d["totalSeconds"] == 180
    assert client.get("/api/live").json()["sensors"]["reactorValveOpen"] is True
    client.post("/api/process/stage/reset")
    busy = client.post("/api/process/stage/start", json={"stage": "Separation", "batchId": b})
    assert busy.status_code == 409 and "reactor outlet" in busy.json()["detail"]
    client.post("/api/process/drain/skip")
    _wait_for(client, "/api/process/drain", "phase", ["done"])
    assert client.get("/api/live").json()["sensors"]["reactorValveOpen"] is False

    # separation, then the centrifuge outlet opens and the biodiesel reaches the purification tank
    client.post("/api/process/stage/start", json={"stage": "Separation", "batchId": b})
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
    assert p["stirrerOn"] is True and p["stirringSpeed"] == 300
    # flow time from the batch's oil: 276 g ÷ 0.92 g/mL = 300 mL, at 40 mL/min = 7.5 min
    assert p["expectedBiodieselMl"] == 300 and p["plannedFlowSeconds"] == 450
    client.post("/api/process/purification/abort")

    saved = client.post("/api/batches", json={"id": b, "oilVolume": 300, "ffa": 5, "ffaAboveStrip": True,
                                              "esterificationRun": True}).json()
    labels = [e["label"] for e in saved["timeline"]]
    for expected in ("Pump B loaded 63.5 g for Esterification", "Pump A loaded 72 g for Transesterification",
                     "Reactor outlet valve opened", "Centrifuge outlet valve opened",
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
