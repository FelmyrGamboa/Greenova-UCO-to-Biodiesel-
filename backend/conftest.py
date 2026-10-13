"""Lets pytest find the "app" package from any folder, e.g. "pytest backend" from the repo root,
and gives the tests a clean MySQL test database (fixture mysql_db).

The tests log in to MySQL like the backend (backend/.env or app/config.py), but always use a
separate database, greenova_test (or DB_TEST_NAME), which they create if needed and empty before
each test. Your real greenova_db is never touched. Tests that need MySQL are skipped when no
server is reachable.
"""
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

TEST_DATABASE = os.getenv("DB_TEST_NAME", "greenova_test")


@pytest.fixture()
def mysql_db():
    """An empty test database: no batches, default settings."""
    from app import config, db

    original = config.DATABASE
    if TEST_DATABASE == original["database"]:
        pytest.skip(f"The test database name ({TEST_DATABASE}) is the real database: refusing to empty it.")
    config.DATABASE = {**original, "database": TEST_DATABASE}
    try:
        db.init_db()
        with db.transaction() as cur:
            cur.execute("DELETE FROM production_batches")    # the batch_* rows go too (ON DELETE CASCADE)
            cur.execute("DELETE FROM settings")
    except db.DatabaseError as e:
        db.close()
        config.DATABASE = original
        pytest.skip(f"No MySQL test database ({e})")
    try:
        yield config.DATABASE
    finally:
        db.close()
        config.DATABASE = original
