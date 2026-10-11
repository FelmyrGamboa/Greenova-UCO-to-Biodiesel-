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


def test_health_and_config(client):
    assert client.get("/api/health").json()["status"] == "ok"
    cfg = client.get("/api/config").json()
    assert cfg["esterification"]["voltage"] == {"min": 18, "max": 30, "default": 20}
    assert cfg["ffaThreshold"] == 4


def test_settings_partial_update(client):
    s = client.put("/api/settings", json={"purificationTargetTemperature": 64, "methanolPrice": None}).json()
    assert s["purificationTargetTemperature"] == 64 and s["methanolPrice"] == 70
    assert client.put("/api/settings", json={"ffaRangeBoundaries": "5"}).status_code == 400


def test_calculate(client):
    q = client.post("/api/calculate", json={"oilMassG": 460, "ffa": 6, "catalyst": "NaOH"}).json()
    assert round(q["esterificationMethanolMl"], 1) == 78.4 and round(q["catalystToWeighG"], 2) == 5.36
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


def test_purification_starts_by_itself_after_separation(client):
    """With biodiesel at the heater (simulated level switch), no operator confirmation is needed."""
    client.post("/api/demo/load-oil", json={"volumeMl": 500})
    time.sleep(1.2)
    assert client.get("/api/live").json()["sensors"]["heaterSubmerged"] is True
    app.state.purification.state["phase"] = "complete"   # the previous batch's finished run
    client.post("/api/process/stage/start", json={"stage": "Separation", "batchId": "B-AUTO-1", "oilMassG": 276})
    client.post("/api/process/stage/complete")
    assert client.get("/api/live").json()["purificationAutoStart"] == "B-AUTO-1"
    time.sleep(2.2)   # the sensor loop starts it within a second
    p = client.get("/api/process/purification").json()
    assert p["phase"] == "heating" and p["batchId"] == "B-AUTO-1" and p["heaterOn"] is True
    assert p["automatic"] is True and p["targetTemperature"] == 70 and p["holdTotalSeconds"] == 1500
    # flow time from the batch's oil: 276 g ÷ 0.92 g/mL = 300 mL, at 40 mL/min = 7.5 min
    assert p["expectedBiodieselMl"] == 300 and p["plannedFlowSeconds"] == 450
    assert client.get("/api/live").json()["purificationAutoStart"] is None
    client.post("/api/process/purification/abort")


def test_level_switch_blocks_and_stops_heater(client):
    """No biodiesel at the heater: manual start is refused, even with the confirmation ticked."""
    time.sleep(1.2)   # demo machine starts empty
    r = client.post("/api/process/purification/start", json={"heaterSubmerged": True})
    assert r.status_code == 409 and "level switch" in r.json()["detail"]
