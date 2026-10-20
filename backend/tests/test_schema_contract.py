"""Static guard: the backend's schema is greenova_db_ver2.sql, the MySQL 8 dump, used as it is.
These run without a MySQL server."""
import os
import re
from decimal import Decimal
from pathlib import Path

from app import db
from app.models import PurificationRecord, Settings

ROOT = Path(__file__).resolve().parents[1]
DUMP = ROOT / "greenova_db_ver2.sql"
TABLES = {"production_batches", "batch_lab_results", "batch_materials", "batch_progress",
          "batch_purification", "batch_timeline", "esterification_stages", "settings"}


def columns(table: str) -> set[str]:
    return {name for name, _ in db._column_definitions(db._schema_statements()[table])}


def test_the_backend_reads_its_schema_from_the_mysql_dump():
    assert db.SCHEMA_FILE == DUMP and DUMP.is_file()
    assert set(db._schema_statements()) == TABLES == set(db.TABLES)
    assert not (ROOT / "schema.sql").exists()              # no separate (MariaDB) copy of the schema


def test_the_dump_is_the_mysql_8_export():
    sql = DUMP.read_text(encoding="utf-8")
    assert "MySQL Community Server" in sql and "utf8mb4_0900_ai_ci" in sql   # MySQL 8, not MariaDB
    assert "CREATE DATABASE IF NOT EXISTS `greenova_db`" in sql
    # the login the backend uses by default (app/config.py)
    assert "CREATE USER 'greenova'@'localhost';" in sql


def test_default_login_matches_the_dump():
    """Without backend/.env or DB_* variables, the backend logs in as the dump's user."""
    from app import config
    if "DB_USER" not in os.environ:
        assert config.DB_USER == "greenova" and config.DB_PASSWORD == ""
    if "DB_HOST" not in os.environ:
        assert config.DB_HOST == "localhost"
    if "DB_NAME" not in os.environ:
        assert config.DB_NAME == "greenova_db"


def test_every_column_the_backend_writes_is_in_the_dump():
    from app.models import Batch
    b = Batch(id="B-1", date="2026-10-20", oil_volume=500)
    assert set(db._batch_row(b)) | {"batch_id", "created_at"} == columns("production_batches")
    p_columns = set(db._purification_row(PurificationRecord()))
    assert p_columns | {"purification_id", "batch_id"} == columns("batch_purification")
    assert set(db.settings_row(Settings())) == columns("settings") - {"id"}
    assert set(db.PROGRESS_COLUMNS) <= columns("production_batches")
    assert {"batch_id", "current_stage", "state_data", "updated_at"} == columns("batch_progress")
    assert {"batch_id", "event_sequence", "event_label", "event_time"} <= columns("batch_timeline")
    assert {"batch_id", "material_name", "quantity", "unit"} <= columns("batch_materials")
    assert {"batch_id", "stage_number", "stage_data"} <= columns("esterification_stages")
    assert {"batch_id", "result_status", "lab_reference", "tested_at"} <= columns("batch_lab_results")


def test_the_dump_settings_row_is_valid():
    """The settings row in the dump is read by the backend as it is (no migration)."""
    sql = DUMP.read_text(encoding="utf-8")
    match = re.search(r"INSERT INTO `settings` \((.*?)\) VALUES\s*\((.*?)\);", sql, re.S)
    names = [n.strip(" `") for n in match.group(1).split(",")]
    tokens = re.findall(r"\s*('[^']*'|[^,]+?)\s*(?:,|$)", match.group(2).strip())
    # like PyMySQL: quoted text -> str, NULL -> None, numbers -> Decimal
    values = [t[1:-1] if t.startswith("'") else None if t == "NULL" else Decimal(t) for t in tokens]
    assert len(values) == len(names)
    row = dict(zip(names, values))
    s = db.settings_from_row(row)
    assert s.contact_time == 15 and s.methanol_removal_time == 10 and s.operator == "Operator 6767"


def test_process_defaults_match_the_requested_values():
    models = (ROOT / "app" / "models.py").read_text(encoding="utf-8")
    for expected in (
        "contact_time: float = 10", "settling_time: float = 0", "max_drain_temperature: float = 70",
        "oil_minimum_volume_ml: float = 1500", "oil_maximum_volume_ml: float = 5000",
        "ffa_threshold: float = 3", "ffa_target: float = 3", "separation_time: float = 60",
        "heater_power_watts: float = 900",
    ):
        assert expected in models
