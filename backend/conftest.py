"""Lets pytest find the "app" package from any folder, e.g. "pytest backend" from the repo root,
and gives the tests a clean MySQL test database (fixture mysql_db).

The tests log in to MySQL like the backend (greenova@localhost from greenova_db_ver2.sql, or
backend/.env), but always use a separate database, greenova_test (or DB_TEST_NAME). It gets the
tables of greenova_db_ver2.sql (their structure only: none of the dump's data, users or settings
values), no batches, and a settings row with the backend's defaults (app/models.py). Your real
greenova_db is never touched. Tests that need MySQL are skipped when no server is reachable.
"""
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

TEST_DATABASE = os.getenv("DB_TEST_NAME", "greenova_test")


def _create_test_tables(db, name: str) -> None:
    """The test database with the CREATE TABLE statements of greenova_db_ver2.sql (if missing)."""
    con = db._connect(with_database=False)
    try:
        with con.cursor() as cur:
            cur.execute(f"CREATE DATABASE IF NOT EXISTS `{name}` DEFAULT CHARACTER SET utf8mb4 "
                        "COLLATE utf8mb4_0900_ai_ci")
            cur.execute(f"USE `{name}`")
            cur.execute("SET FOREIGN_KEY_CHECKS = 0")     # the dump creates child tables first
            for statement in db._schema_statements().values():
                cur.execute(statement.rstrip().rstrip(";"))
            cur.execute("SET FOREIGN_KEY_CHECKS = 1")
        con.commit()
    finally:
        con.close()


@pytest.fixture()
def mysql_db():
    """An empty test database: no batches, default settings."""
    pytest.importorskip("pymysql")
    from app import config, db

    original = config.DATABASE
    if TEST_DATABASE == original["database"]:
        pytest.skip(f"The test database name ({TEST_DATABASE}) is the real database: refusing to empty it.")
    config.DATABASE = {**original, "database": TEST_DATABASE}
    try:
        _create_test_tables(db, TEST_DATABASE)
        with db.transaction() as cur:
            cur.execute("DELETE FROM production_batches")    # the batch_* rows go too (ON DELETE CASCADE)
            cur.execute("DELETE FROM settings")
            cur.execute("INSERT INTO settings (id) VALUES (1)")
        db.init_db()
        from app.models import Settings
        db.save_settings(Settings())                         # the backend's defaults, which the tests expect
    except Exception as e:   # no server, no login, or no rights: skip the MySQL tests
        db.close()
        config.DATABASE = original
        pytest.skip(f"No MySQL test database ({e})")
    try:
        yield config.DATABASE
    finally:
        db.close()
        config.DATABASE = original
