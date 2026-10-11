"""SQLite storage. Each batch and the settings are saved as JSON documents, in the same
camelCase shape the website uses, so adding fields later is easy."""
import re
import sqlite3
from contextlib import contextmanager
from typing import Optional

from . import config
from .models import Batch, Settings


@contextmanager
def connect():
    con = sqlite3.connect(config.DB_PATH)
    try:
        yield con
        con.commit()
    finally:
        con.close()


def init_db() -> None:
    with connect() as con:
        con.execute("CREATE TABLE IF NOT EXISTS batches ("
                    "id TEXT PRIMARY KEY, date TEXT NOT NULL, data TEXT NOT NULL)")
        con.execute("CREATE TABLE IF NOT EXISTS settings ("
                    "id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)")


def get_settings() -> Settings:
    with connect() as con:
        row = con.execute("SELECT data FROM settings WHERE id = 1").fetchone()
    return Settings.model_validate_json(row[0]) if row else Settings()


def save_settings(s: Settings) -> None:
    with connect() as con:
        con.execute("INSERT OR REPLACE INTO settings (id, data) VALUES (1, ?)",
                    (s.model_dump_json(by_alias=True),))


def list_batches() -> list[Batch]:
    """Newest first, like the website's Batch History."""
    with connect() as con:
        rows = con.execute("SELECT data FROM batches ORDER BY date DESC, id DESC").fetchall()
    return [Batch.model_validate_json(r[0]) for r in rows]


def get_batch(batch_id: str) -> Optional[Batch]:
    with connect() as con:
        row = con.execute("SELECT data FROM batches WHERE id = ?", (batch_id,)).fetchone()
    return Batch.model_validate_json(row[0]) if row else None


def save_batch(b: Batch) -> None:
    with connect() as con:
        con.execute("INSERT OR REPLACE INTO batches (id, date, data) VALUES (?, ?, ?)",
                    (b.id, b.date, b.model_dump_json(by_alias=True)))


def next_batch_id(batch_format: str, year: int) -> str:
    """Next ID for a format like "B-{YEAR}-{SEQ}" (the website's batch naming format)."""
    if "{SEQ}" not in batch_format:
        batch_format += "-{SEQ}"
    prefix_format = batch_format.replace("{YEAR}", str(year))
    pattern = re.compile("^" + re.escape(prefix_format).replace(re.escape("{SEQ}"), r"(\d+)") + "$")
    with connect() as con:
        ids = [r[0] for r in con.execute("SELECT id FROM batches").fetchall()]
    numbers = [int(m.group(1)) for i in ids if (m := pattern.match(i))]
    return prefix_format.replace("{SEQ}", f"{max(numbers, default=0) + 1:03d}")
