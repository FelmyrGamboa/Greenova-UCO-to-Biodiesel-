"""Tests for the MySQL storage (app/db.py) and the SQLite -> MySQL copy (app/migrate_sqlite.py).
They run on the test database of the mysql_db fixture (conftest.py) and are skipped without MySQL."""
import json
import sqlite3
from datetime import datetime, timezone

import pytest

pytest.importorskip("pymysql")

from app import config, db, migrate_sqlite, seed  # noqa: E402
from app.models import Batch, Settings  # noqa: E402

pytestmark = pytest.mark.usefixtures("mysql_db")


def full_batch(batch_id="B-2026-101", **changes) -> Batch:
    """A batch with every part filled in: esterification, purification, materials, timeline."""
    data = {
        "id": batch_id, "date": "2026-10-13", "oilVolume": 500, "yield": 88.9, "duration": 130, "energy": 1.234,
        "status": "Completed", "labResult": "Pending", "ffa": 4, "ffaAboveStrip": False, "esterificationRun": True,
        "temperature": 45.2, "reactionTime": 120, "stirringSpeed": 500, "voltage": 30, "current": 1,
        "methanolRatio": 7, "esterificationVoltage": 20, "esterificationTime": 120, "esterificationStirring": 500,
        "esterificationCurrent": 2, "biodieselOutputMl": 444.3, "catalystType": "KOH", "adsorbent": "Bentonite",
        "materials": {"oilL": 0.5, "methanolL": 0.1903, "catalystKg": 0.0061, "sulfuricAcidL": 0.0012,
                      "acetoneL": 0.05, "bentoniteKg": 0.0092, "magnesolKg": 0},
        "purification": {"targetTemperature": 90, "highestTemperature": 93.1, "heatingTimeSeconds": 71,
                         "holdTimeSeconds": 600, "drainTimeSeconds": 17, "contactTimeSeconds": 900,
                         "settlingTimeSeconds": 600, "coolingTimeSeconds": 6, "magnesolAdded": True,
                         "oilWeightG": 460, "automatic": True, "warning": "Less biodiesel than expected",
                         "safetyStopOccurred": False, "outputWeightG": 391, "stirringSpeed": 200,
                         "magnesolG": 9.2, "adsorbent": "Bentonite", "adsorbentG": 9.2, "heaterOnSeconds": 80},
        "oilMassG": 460, "catalystToWeighG": 6.128,
        "esterificationStages": [
            {"stage": 1, "ffaBefore": 4, "ffaAfter": 2, "doseFfa": 10, "methanolMl": 130.6, "sulfuricAcidMl": 1.2},
            {"stage": 2, "ffaBefore": 2, "ffaAfter": 1, "doseFfa": 2, "methanolMl": 26.1, "sulfuricAcidMl": 0.25,
             "acetoneMl": 5}],
        "timeline": [{"label": "Esterification started", "time": "2026-10-13T19:24:47.139518"},
                     {"label": "Esterification completed", "time": "2026-10-13T19:24:54.744879"},
                     {"label": "Batch saved", "time": "2026-10-13T19:59:03.690848"}],
        "notes": "Test batch: ñ, °C, ₱ survive utf8mb4",
        "createdAt": "2026-10-13T19:59:03.690659",
    }
    return Batch.model_validate(data | changes)


def rows(sql, *args):
    with db.transaction() as cur:
        cur.execute(sql, args)
        return cur.fetchall()


# ---------- tables and relationships ----------
def test_tables_and_foreign_keys():
    tables = {r["t"] for r in rows("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()")}
    assert set(db.TABLES) <= tables
    fks = rows("SELECT TABLE_NAME AS t, REFERENCED_TABLE_NAME AS r FROM information_schema.KEY_COLUMN_USAGE "
               "WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL")
    assert {(r["t"], r["r"]) for r in fks} == {(t, "production_batches") for t in db.BATCH_TABLES[1:]}


def test_deleting_a_batch_deletes_its_rows():
    db.save_batch(full_batch())
    with db.transaction() as cur:
        cur.execute("DELETE FROM production_batches WHERE batch_id = %s", ("B-2026-101",))
    for table in db.BATCH_TABLES:
        assert rows(f"SELECT COUNT(*) AS n FROM {table}")[0]["n"] == 0


# ---------- batches ----------
def test_full_batch_round_trip():
    b = full_batch()
    db.save_batch(b)
    assert db.get_batch("B-2026-101").dump() == b.dump()
    assert db.list_batches()[0].dump() == b.dump()


def test_batch_rows_use_the_schema_units():
    db.save_batch(full_batch())
    p = rows("SELECT * FROM production_batches")[0]
    assert float(p["duration_seconds"]) == 130 * 60 and float(p["reaction_time_seconds"]) == 7200
    assert float(p["esterification_time_seconds"]) == 7200
    assert float(p["energy_value"]) == 1.234 and p["energy_unit"] == "kWh"
    assert p["production_date"].isoformat() == "2026-10-13" and p["catalyst_type"] == "KOH"
    materials = {r["material_name"]: (float(r["quantity"]), r["unit"]) for r in rows("SELECT * FROM batch_materials")}
    assert materials["Used cooking oil"] == (0.5, "L") and materials["Catalyst"] == (0.0061, "kg")
    assert len(materials) == 7
    timeline = rows("SELECT event_sequence, event_label FROM batch_timeline ORDER BY event_sequence")
    assert [(r["event_sequence"], r["event_label"]) for r in timeline][0] == (1, "Esterification started")
    stage = rows("SELECT stage_data FROM esterification_stages WHERE stage_number = 2")[0]["stage_data"]
    assert db._json(stage)["acetoneMl"] == 5
    assert rows("SELECT is_automatic, adsorbent FROM batch_purification")[0] == {"is_automatic": 1, "adsorbent": "Bentonite"}


def test_sample_batches_round_trip():
    """The sample batches' materials have long decimals (0.29602045 L): batch_materials.quantity
    keeps 6 decimals, so they come back rounded to the microliter, nothing more."""
    for b in (seed.hydrate(row) for row in seed.DEMO_BATCHES):
        db.save_batch(b)
        got = db.get_batch(b.id).dump()
        assert got["createdAt"] is not None              # created_at is NOT NULL: the save time
        assert migrate_sqlite.differences(b.dump(), got) == []
        assert abs(got["materials"]["methanolL"] - b.materials.methanol_l) < 1e-6


def test_missing_values_in_not_null_columns_come_back_missing():
    """voltage, catalyst, adsorbent... are NOT NULL in MySQL: "no value" is stored as 0 or '' and
    read back as no value (the analytics then use their defaults, e.g. 30 V)."""
    b = full_batch(voltage=None, current=None, methanolRatio=None, catalystType=None, adsorbent=None,
                   oilMassG=None, catalystToWeighG=None, purification={"highestTemperature": None},
                   materials=None, esterificationStages=[], esterificationVoltage=None)
    db.save_batch(b)
    got = db.get_batch(b.id)
    assert (got.voltage, got.current, got.methanol_ratio, got.catalyst_type, got.adsorbent) == (None,) * 5
    assert got.oil_mass_g is None and got.catalyst_to_weigh_g is None and got.materials is None
    assert got.purification.highest_temperature is None and got.purification.adsorbent is None
    p = rows("SELECT voltage_v, catalyst_type, adsorbent FROM production_batches")[0]
    assert float(p["voltage_v"]) == 0 and p["catalyst_type"] == "" and p["adsorbent"] == ""


def test_lab_results_keep_their_history():
    b = full_batch()
    db.save_batch(b)
    db.save_batch(b)                                     # unchanged: no new row
    b.lab_result, b.lab_reference = "Passed", "LAB-2026-77"
    db.save_batch(b)
    history = rows("SELECT result_status, lab_reference, tested_at FROM batch_lab_results ORDER BY lab_result_id")
    assert [(r["result_status"], r["lab_reference"]) for r in history] == [("Pending", None), ("Passed", "LAB-2026-77")]
    assert history[0]["tested_at"] is None and history[1]["tested_at"] is not None
    assert db.get_batch(b.id).lab_result == "Passed" and db.get_batch(b.id).lab_reference == "LAB-2026-77"


def test_updates_change_rows_in_place():
    b = full_batch()
    db.save_batch(b)
    ids = [r["event_id"] for r in rows("SELECT event_id FROM batch_timeline ORDER BY event_sequence")]
    b.timeline.append(b.timeline[-1].model_copy(update={"label": "Lab result recorded"}))
    b.esterification_stages = b.esterification_stages[:1]
    b.purification = None
    db.save_batch(b)
    after = [r["event_id"] for r in rows("SELECT event_id FROM batch_timeline ORDER BY event_sequence")]
    assert after[:3] == ids and len(after) == 4          # existing events keep their row
    assert rows("SELECT COUNT(*) AS n FROM esterification_stages")[0]["n"] == 1
    assert rows("SELECT COUNT(*) AS n FROM batch_purification")[0]["n"] == 0
    assert db.get_batch(b.id).dump() == b.dump()


def test_times_with_a_time_zone_are_stored_in_local_time():
    utc = datetime(2026, 10, 13, 11, 0, tzinfo=timezone.utc)
    b = full_batch(timeline=[{"label": "Started", "time": utc.isoformat()}])
    db.save_batch(b)
    assert db.get_batch(b.id).timeline[0].time == utc.astimezone().replace(tzinfo=None)


def test_long_timeline_labels_are_cut_to_the_column():
    b = full_batch(timeline=[{"label": "x" * 700, "time": "2026-10-13T10:00:00"}])
    db.save_batch(b)
    assert len(db.get_batch(b.id).timeline[0].label) == 500


def test_rows_typed_by_hand_are_read():
    """A batch entered in HeidiSQL: lower-case texts and a material in grams still work."""
    with db.transaction() as cur:
        cur.execute("INSERT INTO production_batches (batch_id, production_date, oil_volume_ml, oil_mass_g, "
                    "yield_percent, duration_seconds, energy_value, energy_unit, batch_status, ffa_percent, "
                    "temperature_c, reaction_time_seconds, stirring_speed_rpm, voltage_v, current_a, methanol_ratio, "
                    "biodiesel_output_ml, catalyst_type, adsorbent, catalyst_to_weigh_g, created_at) VALUES "
                    "('B-HAND-1', '2026-09-01', 1000, 920, 87.5, 7200, 1500, 'Wh', 'Completed', 1, 42, 3600, 450, "
                    "30, 1, 7, 875, 'naoh', 'magnesol', 9.4, NOW())")
        cur.execute("INSERT INTO batch_materials (batch_id, material_name, quantity, unit) VALUES "
                    "('B-HAND-1', 'methanol', 250, 'mL'), ('B-HAND-1', 'Water', 1, 'L')")
        cur.execute("INSERT INTO batch_lab_results (batch_id, result_status, test_name) VALUES "
                    "('B-HAND-1', 'passed', 'Flash point')")
    b = db.get_batch("B-HAND-1")
    assert (b.catalyst_type, b.adsorbent, b.lab_result) == ("NaOH", "Magnesol", "Passed")
    assert b.energy == 1.5 and b.duration == 120 and b.materials.methanol_l == 0.25
    db.save_batch(b)                                     # saving it again keeps the hand-made rows
    assert {r["material_name"] for r in rows("SELECT material_name FROM batch_materials")} >= {"Water", "methanol"}


def test_a_bad_row_does_not_hide_the_other_batches():
    db.save_batch(full_batch("B-GOOD-1"))
    db.save_batch(full_batch("B-BAD-1"))
    with db.transaction() as cur:
        cur.execute("UPDATE production_batches SET batch_status = 'Exploded' WHERE batch_id = 'B-BAD-1'")
    assert [b.id for b in db.list_batches()] == ["B-GOOD-1"]


def test_next_batch_id():
    assert db.next_batch_id("B-{YEAR}-{SEQ}", 2026) == "B-2026-001"
    db.save_batch(full_batch("B-2026-009"))
    assert db.next_batch_id("B-{YEAR}-{SEQ}", 2026) == "B-2026-010"


def test_batch_id_and_date_must_fit_the_columns():
    with pytest.raises(ValueError):
        full_batch("B-" + "9" * 60)
    with pytest.raises(ValueError):
        full_batch(date="13/10/2026")


# ---------- settings ----------
def test_settings_row_has_one_column_per_setting():
    s = Settings.model_validate({"systemName": "Greenova Pi", "magnesolDose": 3, "autoAdvance": False,
                                 "defaultAdsorbent": "Bentonite", "thermalFuseRating": 10,
                                 "esterification": {"voltage": {"min": 10, "max": 30, "default": 25},
                                                    "time": {"min": 30, "max": 180, "default": 90},
                                                    "stirring": {"min": 400, "max": 700, "default": 600}}})
    db.save_settings(s)
    row = rows("SELECT * FROM settings WHERE id = 1")[0]
    assert row["systemName"] == "Greenova Pi" and float(row["esterificationVoltageDefault"]) == 25
    assert float(row["magnesolDose"]) == 3 and row["autoAdvance"] == 0 and row["defaultAdsorbent"] == "Bentonite"
    assert db.get_settings() == s
    assert set(db.settings_row(s)) == {r["c"] for r in rows(
        "SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() "
        "AND TABLE_NAME = 'settings'")} - {"id"}


def test_an_older_settings_table_gets_the_new_columns():
    with db.transaction() as cur:
        for column in ("magnesolDose", "bentoniteDose", "defaultAdsorbent", "autoAdvance", "magnesolPrice"):
            cur.execute(f"ALTER TABLE settings DROP COLUMN `{column}`")
    db.init_db()
    db.save_settings(Settings(magnesol_price=300, auto_advance=False))
    s = db.get_settings()
    assert s.magnesol_price == 300 and s.auto_advance is False


# ---------- connection errors ----------
def test_connection_errors_say_what_to_check(monkeypatch):
    monkeypatch.setattr(config, "DATABASE", {**config.DATABASE, "host": "127.0.0.1", "port": 1})
    with pytest.raises(db.DatabaseError, match="Can't connect to MySQL"):
        db.get_settings()


def test_wrong_password_says_so(monkeypatch):
    monkeypatch.setattr(config, "DATABASE", {**config.DATABASE, "password": "wrong-password"})
    with pytest.raises(db.DatabaseError, match="refused the login"):
        db.get_settings()


# ---------- copy from the old SQLite file ----------
def test_migrate_sqlite(tmp_path, capsys):
    old = tmp_path / "greenova.db"
    con = sqlite3.connect(old)
    con.execute("CREATE TABLE batches (id TEXT PRIMARY KEY, date TEXT NOT NULL, data TEXT NOT NULL)")
    con.execute("CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)")
    b = full_batch("B-2026-001")
    con.execute("INSERT INTO batches VALUES (?, ?, ?)", (b.id, b.date, b.model_dump_json(by_alias=True)))
    con.execute("INSERT INTO batches VALUES ('B-BROKEN', '2026-10-13', '{\"id\": \"B-BROKEN\"}')")
    con.execute("INSERT INTO settings VALUES (1, ?)", (Settings(oil_price=50).model_dump_json(by_alias=True),))
    con.commit()
    con.close()

    assert migrate_sqlite.main([str(old)]) == 2               # 2: one problem (the broken batch)
    out = capsys.readouterr().out
    assert "B-2026-001: copied" in out and "CHECK" not in out and "PROBLEM B-BROKEN" in out
    assert db.get_batch("B-2026-001").dump() == b.dump()
    assert db.get_settings().oil_price == 50
    migrate_sqlite.main([str(old)])                           # again: nothing is copied twice
    assert "already in MySQL, skipped" in capsys.readouterr().out
    assert rows("SELECT COUNT(*) AS n FROM batch_timeline")[0]["n"] == 3


def test_api_refuses_values_too_long_for_the_columns():
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as client:
        r = client.post("/api/batches", json={"id": "B" * 51, "oilVolume": 500})
        assert r.status_code == 422 and "id" in r.json()["detail"]
        saved = client.post("/api/batches", json={"oilVolume": 500, "status": "Completed"}).json()
        r = client.post(f"/api/batches/{saved['id']}/lab-result", json={"labResult": "Passed", "labReference": "L" * 101})
        assert r.status_code == 422 and "labReference" in r.json()["detail"]
        assert client.put("/api/settings", json={"systemName": "S" * 151}).status_code == 400
        assert json.loads(client.get(f"/api/batches/{saved['id']}").text)["id"] == saved["id"]
