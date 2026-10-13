"""Copies the batches and settings of the old SQLite file (greenova.db) into MySQL. Run it once,
from the backend folder, once the backend can reach MySQL (python -m app.db says OK):

    python -m app.migrate_sqlite                     reads backend/greenova.db
    python -m app.migrate_sqlite C:\\path\\to\\greenova.db
    python -m app.migrate_sqlite --replace           also overwrite batches already in MySQL

greenova.db is only read, never changed. Batches already in MySQL are skipped (unless --replace),
so running it twice is safe. The settings are copied only while MySQL still has the default
settings (or with --replace). Every copied batch is read back from MySQL and compared.
"""
import argparse
import sqlite3
import sys
from pathlib import Path
from typing import Optional

from pydantic import ValidationError

from . import config, db
from .models import Batch, Settings

# Numbers are stored as DECIMAL with 2-6 decimals, so tiny differences are only rounding.
TOLERANCE = 0.0051


def read_sqlite(path: Path) -> tuple[list[Batch], Optional[Settings], list[str]]:
    """The batches and settings saved by the SQLite version (JSON documents), plus problems."""
    con = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)
    try:
        tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        batches, problems = [], []
        if "batches" in tables:
            for batch_id, data in con.execute("SELECT id, data FROM batches ORDER BY date, id"):
                try:
                    batches.append(Batch.model_validate_json(data))
                except ValidationError as e:
                    problems.append(f"{batch_id}: not copied, {e.error_count()} invalid value(s): {e}")
        settings = None
        if "settings" in tables:
            row = con.execute("SELECT data FROM settings WHERE id = 1").fetchone()
            if row:
                try:
                    settings = Settings.model_validate_json(row[0])
                except ValidationError as e:
                    problems.append(f"settings: not copied: {e}")
        return batches, settings, problems
    finally:
        con.close()


def differences(before, after, path: str = "") -> list[str]:
    """Where two dumps of the same batch differ (beyond DECIMAL rounding)."""
    if isinstance(before, dict) and isinstance(after, dict):
        out = []
        for key in before.keys() | after.keys():
            if key == "createdAt" and before.get(key) is None:
                continue                             # MySQL needs a created_at: the copy time is used
            out += differences(before.get(key), after.get(key), f"{path}.{key}" if path else key)
        return out
    if isinstance(before, list) and isinstance(after, list):
        if len(before) != len(after):
            return [f"{path}: {len(before)} items before, {len(after)} after"]
        return [d for i, (a, b) in enumerate(zip(before, after)) for d in differences(a, b, f"{path}[{i}]")]
    numbers = (int, float)
    if isinstance(before, numbers) and isinstance(after, numbers) and not isinstance(before, bool):
        return [] if abs(before - after) <= TOLERANCE else [f"{path}: {before} -> {after}"]
    if before in (None, 0) and after in (None, 0):
        return []                                    # "no value" and 0 are the same in a NOT NULL column
    return [] if before == after else [f"{path}: {before!r} -> {after!r}"]


def migrate(path: Path, replace: bool = False) -> int:
    if not Path(path).is_file():
        print(f"{path} not found. Give the path of the old greenova.db:  python -m app.migrate_sqlite <path>")
        return 1
    batches, settings, problems = read_sqlite(path)
    print(f"{path}: {len(batches)} batches" + (", settings" if settings else ", no saved settings"))
    db.init_db()

    copied = skipped = 0
    for b in batches:
        if db.get_batch(b.id) is not None and not replace:
            print(f"  {b.id}: already in MySQL, skipped (use --replace to overwrite)")
            skipped += 1
            continue
        db.save_batch(b)
        diff = differences(b.dump(), db.get_batch(b.id).dump())
        parts = [f"{len(b.timeline)} timeline events", f"{len(b.esterification_stages)} esterification stages",
                 "materials" if b.materials else "no materials", "purification" if b.purification else "no purification"]
        print(f"  {b.id}: copied ({', '.join(parts)})" + (f"; CHECK: {'; '.join(diff)}" if diff else ""))
        copied += 1

    if settings is not None:
        if replace or db.get_settings() == Settings():
            db.save_settings(settings)
            print("  settings: copied")
        else:
            print("  settings: MySQL already has changed settings, kept them (use --replace to overwrite)")

    for problem in problems:
        print(f"  PROBLEM {problem}")
    print(f"Done: {copied} copied, {skipped} skipped, {len(problems)} problems. greenova.db was not changed.")
    return 0 if not problems else 2


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Copy the old greenova.db (SQLite) into MySQL.")
    parser.add_argument("path", nargs="?", default=str(config.LEGACY_SQLITE_PATH), help="the old greenova.db")
    parser.add_argument("--replace", action="store_true", help="overwrite batches and settings already in MySQL")
    args = parser.parse_args(argv)
    try:
        return migrate(Path(args.path), args.replace)
    except db.DatabaseError as e:
        print(f"MySQL: {e}")
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
