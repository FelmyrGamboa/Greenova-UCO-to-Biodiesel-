"""MySQL storage (MySQL 8 or MariaDB 10.11+), in the tables of greenova_db.sql / schema.sql:

    production_batches     one row per batch (the parent of the batch_* tables)
    batch_purification     0 or 1 row per batch: the dry wash record
    batch_materials        one row per material a batch used (oil, methanol, catalyst, ...)
    esterification_stages  one row per esterification stage (the stage's values as JSON)
    batch_timeline         one row per timeline event, in order (event_sequence 1, 2, 3, ...)
    batch_lab_results      0 or 1 row per batch (UNIQUE batch_id): its lab result, updated in place
    batch_progress         0 or 1 row per ongoing batch: where the website's Process page is
    settings               one row (id = 1), one column per setting (the website's keys)

The rest of the backend still works with the same Batch and Settings objects (models.py) and
calls the same functions as before (init_db, get_settings, save_settings, list_batches,
get_batch, save_batch, next_batch_id): this file turns those objects into rows and back.

Only one batch is "In Progress" at a time: start_batch refuses a second one (ActiveBatchError),
and every later save of that batch updates its row instead of adding another.

Connection settings: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME in backend/.env or
app/config.py (config.DATABASE). Check them with:
    python -m app.db
"""
import json
import logging
import math
import queue
import re
import sys
import threading
import time
from contextlib import contextmanager
from datetime import date as _date
from datetime import datetime
from decimal import Decimal
from typing import Any, Iterator, Optional

import pymysql
from pydantic import ValidationError

from . import config
from .models import Batch, EsterificationStage, Materials, PurificationRecord, Settings, TimelineEvent

log = logging.getLogger("greenova.db")

SCHEMA_FILE = config.BASE_DIR / "schema.sql"

BATCH_TABLES = ("production_batches", "batch_lab_results", "batch_materials", "batch_purification",
                "batch_timeline", "esterification_stages", "batch_progress")
TABLES = BATCH_TABLES + ("settings",)
SETTINGS_ID = 1
IN_PROGRESS = "In Progress"                    # production_batches.batch_status of the ongoing batch

# Model field -> (material_name, unit) in batch_materials.
MATERIALS = {
    "oil_l": ("Used cooking oil", "L"),
    "methanol_l": ("Methanol", "L"),
    "catalyst_kg": ("Catalyst", "kg"),          # NaOH or KOH: production_batches.catalyst_type
    "sulfuric_acid_l": ("Sulfuric acid", "L"),
    "acetone_l": ("Acetone", "L"),
    "bentonite_kg": ("Bentonite", "kg"),
    "magnesol_kg": ("Magnesol", "kg"),
}

LAB_RESULTS = ("Pending", "Passed", "Failed", "Not tested")
TESTED_RESULTS = ("Passed", "Failed")          # these get tested_at = the time they were recorded
EVENT_LABEL_MAX = 500                          # batch_timeline.event_label is varchar(500)
BATCH_ID_MAX = 50                              # production_batches.batch_id is varchar(50)


class DatabaseError(RuntimeError):
    """MySQL can't be reached, refuses the login, or doesn't have the tables the backend needs.
    The message says what to check (see database.md, Troubleshooting)."""

    def __init__(self, message: str, code: Optional[int] = None):
        super().__init__(message)
        self.code = code


class ActiveBatchError(RuntimeError):
    """Another batch is still in progress: only one batch can run at a time."""

    def __init__(self, batch_id: str):
        super().__init__(f"Batch {batch_id} is still in progress. Only one batch can be processed at a "
                         "time: continue it, or cancel it, before starting a new one.")
        self.batch_id = batch_id


# ---------------------------------------------------------------- connections
def _params(with_database: bool = True) -> dict:
    d = config.DATABASE
    params = dict(host=d["host"], port=d["port"], user=d["user"], password=d["password"],
                  charset="utf8mb4", autocommit=False, cursorclass=pymysql.cursors.DictCursor,
                  connect_timeout=d["connect_timeout"], read_timeout=60, write_timeout=60)
    if with_database:
        params["database"] = d["database"]
    return params


def _explain(error: Exception) -> DatabaseError:
    """A connection error, in words that say what to fix."""
    d = config.DATABASE
    where = f"{d['host']}:{d['port']}"
    code = error.args[0] if error.args and isinstance(error.args[0], int) else None
    text = str(error.args[1]) if len(error.args) > 1 else str(error)
    if isinstance(error, RuntimeError) and "cryptography" in str(error):
        return DatabaseError("MySQL 8 needs the 'cryptography' package for its login method. In the backend "
                             "folder run:  pip install -r requirements.txt")
    messages = {
        2003: f"Can't connect to MySQL at {where}. Is the MySQL service running (Windows: Services > MySQL80), "
              "and are DB_HOST and DB_PORT right in backend/.env (or app/config.py)?",
        2005: f"Unknown MySQL host '{d['host']}'. Check DB_HOST in backend/.env (or app/config.py).",
        2013: f"Lost the connection to MySQL at {where} while logging in. Check DB_HOST and DB_PORT in backend/.env.",
        1045: f"MySQL refused the login of user '{d['user']}' at {where}: wrong password? Put the password you "
              "use in HeidiSQL after DB_PASSWORD= in backend/.env (or in app/config.py), and check DB_USER.",
        1044: f"MySQL user '{d['user']}' may not use the database '{d['database']}'. Use DB_USER=root in "
              "backend/.env, or give that user access in HeidiSQL (User manager).",
        1049: f"The database '{d['database']}' doesn't exist and user '{d['user']}' may not create it. Create it "
              f"once in HeidiSQL (CREATE DATABASE {d['database']};) or use DB_USER=root in backend/.env.",
    }
    return DatabaseError(messages.get(code, f"MySQL error {code}: {text}" if code else f"MySQL error: {text}"), code)


def _connect(with_database: bool = True) -> pymysql.connections.Connection:
    try:
        return pymysql.connect(**_params(with_database))
    except (pymysql.MySQLError, RuntimeError) as e:
        raise _explain(e) from e


class _Pool:
    """A few open connections, reused between requests (opening one takes a moment). Each thread
    takes its own connection; a connection the server closed meanwhile is reopened."""

    def __init__(self, key: tuple, size: int):
        self.key = key
        self.size = size
        self._idle: "queue.LifoQueue[pymysql.connections.Connection]" = queue.LifoQueue()

    def get(self) -> pymysql.connections.Connection:
        while True:
            try:
                con = self._idle.get_nowait()
            except queue.Empty:
                return _connect()
            try:
                con.ping(reconnect=True)
                return con
            except pymysql.MySQLError:
                _close_quietly(con)

    def put(self, con: pymysql.connections.Connection) -> None:
        if self._idle.qsize() < self.size and con.open:
            self._idle.put(con)
        else:
            _close_quietly(con)

    def close(self) -> None:
        while True:
            try:
                _close_quietly(self._idle.get_nowait())
            except queue.Empty:
                return


_pool: Optional[_Pool] = None
_pool_lock = threading.Lock()


def _get_pool() -> _Pool:
    """The pool for the current config.DATABASE (a new one if the settings changed, e.g. in tests)."""
    global _pool
    d = config.DATABASE
    key = (d["host"], d["port"], d["user"], d["password"], d["database"])
    with _pool_lock:
        if _pool is None or _pool.key != key:
            if _pool is not None:
                _pool.close()
            _pool = _Pool(key, d.get("pool_size", 5))
        return _pool


def close() -> None:
    """Closes the open connections (when the backend stops)."""
    global _pool
    with _pool_lock:
        if _pool is not None:
            _pool.close()
            _pool = None


def _close_quietly(con) -> None:
    try:
        con.close()
    except Exception:
        pass


@contextmanager
def transaction() -> Iterator[pymysql.cursors.DictCursor]:
    """One transaction: everything inside is saved together (commit) or not at all (rollback)."""
    pool = _get_pool()
    con = pool.get()
    ok = False
    try:
        with con.cursor() as cur:
            yield cur
        con.commit()
        ok = True
    finally:
        if not ok:
            try:
                con.rollback()
            except Exception:
                _close_quietly(con)
                con = None
        if con is not None:
            pool.put(con)


# 1213 deadlock, 1205 lock wait timeout: another request was saving the same batch; try again.
# 1062 duplicate key on INSERT: two saves created the same new batch at the same moment.
_RETRY_CODES = {1213, 1205, 1062}


def _write(work, *args):
    """Runs work(cursor, *args) in one transaction, again (up to 3 times) after a deadlock."""
    for attempt in range(3):
        try:
            with transaction() as cur:
                return work(cur, *args)
        except (pymysql.err.OperationalError, pymysql.err.IntegrityError) as e:
            if e.args and e.args[0] in _RETRY_CODES and attempt < 2:
                time.sleep(0.05 * (attempt + 1))
                continue
            raise


# ---------------------------------------------------------------- schema
def _schema_statements() -> dict[str, str]:
    """CREATE TABLE statements of schema.sql, by table name (in the file's order: parents first)."""
    text = SCHEMA_FILE.read_text(encoding="utf-8")
    text = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("--"))
    statements = {}
    for statement in (s.strip() for s in text.split(";")):
        match = re.match(r"CREATE TABLE IF NOT EXISTS `(\w+)`", statement, re.I)
        if match:
            statements[match.group(1)] = statement
    return statements


def _column_definitions(statement: str) -> list[tuple[str, str]]:
    """[(column, definition)] of a CREATE TABLE statement, in order."""
    return re.findall(r"^\s*`(\w+)` (.+?),?\s*$", statement, re.M)


def _existing_columns(cur) -> dict[str, list[str]]:
    cur.execute("SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS "
                "WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION")
    columns: dict[str, list[str]] = {}
    for row in cur.fetchall():
        columns.setdefault(row["t"], []).append(row["c"])
    return columns


_settings_columns: Optional[set] = None


def _ensure_database() -> None:
    """Creates the database itself if it doesn't exist and the MySQL user is allowed to."""
    try:
        _connect().close()
    except DatabaseError as e:
        if e.code != 1049:
            raise
        name = config.DATABASE["database"]
        con = _connect(with_database=False)
        try:
            with con.cursor() as cur:
                cur.execute(f"CREATE DATABASE IF NOT EXISTS `{name}` DEFAULT CHARACTER SET utf8mb4")
            log.info("Created the database %s", name)
        except pymysql.MySQLError as create_error:
            raise e from create_error
        finally:
            con.close()


def init_db() -> None:
    """Called when the backend starts. Creates any missing table (schema.sql), adds the newer
    settings columns to an older settings table, checks that every column the backend uses exists,
    and puts the default settings row (id = 1) in an empty settings table."""
    global _settings_columns
    _ensure_database()
    statements = _schema_statements()
    with transaction() as cur:
        existing = _existing_columns(cur)
        for table, statement in statements.items():
            if table not in existing:
                cur.execute(statement)
                log.info("Created table %s", table)
        existing = _existing_columns(cur)

        # settings: add the settings that are newer than the table (e.g. magnesolDose, autoAdvance)
        wanted = _column_definitions(statements["settings"])
        have = existing.get("settings", [])
        previous = None
        for column, definition in wanted:
            if column not in have:
                position = f" AFTER `{previous}`" if previous in have else ""
                cur.execute(f"ALTER TABLE `settings` ADD COLUMN `{column}` {definition}{position}")
                have.insert(have.index(previous) + 1 if previous in have else len(have), column)
                log.info("Added column settings.%s", column)
            previous = column

        problems = []
        for table in BATCH_TABLES:
            missing = [c for c, _ in _column_definitions(statements[table]) if c not in existing.get(table, [])]
            if missing:
                problems.append(f"{table}: {', '.join(missing)}")
        if problems:
            raise DatabaseError("The MySQL tables are missing columns the backend needs (compare them with "
                                "backend/schema.sql): " + "; ".join(problems))
        _settings_columns = set(have)

        cur.execute("SELECT id FROM settings WHERE id = %s", (SETTINGS_ID,))
        if cur.fetchone() is None:
            _write_settings(cur, Settings())
            log.info("Saved the default settings (settings row id = 1)")
    _one_lab_result_per_batch()


# Columns of batch_lab_results that are merged when duplicate rows of a batch are joined.
LAB_MERGE_COLUMNS = ("lab_reference", "test_name", "measured_value", "unit", "tested_at", "notes")


def _one_lab_result_per_batch() -> None:
    """Older tables kept one batch_lab_results row per change (Pending, then Passed ...). Joins each
    batch's rows into its newest one, then adds UNIQUE (batch_id) so it can't happen again.
    A value the newest row lacks (a NULL tested_at or reference) is taken from the older rows, so no
    saved time is lost. Runs once: nothing to do when the unique key is there."""
    with transaction() as cur:
        cur.execute("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() "
                    "AND TABLE_NAME = 'batch_lab_results' AND NON_UNIQUE = 0 "
                    "GROUP BY INDEX_NAME HAVING COUNT(*) = 1 AND MAX(COLUMN_NAME) = 'batch_id'")
        if cur.fetchone():
            return
        cur.execute("SELECT * FROM batch_lab_results ORDER BY batch_id, lab_result_id FOR UPDATE")
        by_batch: dict[str, list[dict]] = {}
        for row in cur.fetchall():
            by_batch.setdefault(row["batch_id"], []).append(row)
        removed = 0
        for rows in by_batch.values():
            if len(rows) < 2:
                continue
            keep, older = rows[-1], rows[-2::-1]          # the newest row is the batch's lab result
            fill = {}
            for column in LAB_MERGE_COLUMNS:
                if keep[column] in (None, ""):
                    found = next((r[column] for r in older if r[column] not in (None, "")), None)
                    if found is not None:
                        fill[column] = found
            if fill:
                _update(cur, "batch_lab_results", fill, "lab_result_id = %s", (keep["lab_result_id"],))
            ids = [r["lab_result_id"] for r in older]
            cur.execute(f"DELETE FROM batch_lab_results WHERE lab_result_id IN ({', '.join(['%s'] * len(ids))})", ids)
            removed += len(ids)
        if removed:
            log.info("batch_lab_results: joined %d duplicate rows into their batch's newest row", removed)
    with transaction() as cur:
        cur.execute("ALTER TABLE batch_lab_results ADD UNIQUE KEY uq_lab_batch (batch_id)")
    log.info("batch_lab_results: one lab result per batch now (UNIQUE batch_id)")


def _settings_column_set(cur) -> set:
    global _settings_columns
    if _settings_columns is None:
        _settings_columns = set(_existing_columns(cur).get("settings", []))
    return _settings_columns


# ---------------------------------------------------------------- value conversions
def _num(value: Optional[float]) -> Optional[float]:
    """A number for a DECIMAL column (None stays None; NaN and infinity can't be stored)."""
    if value is None:
        return None
    value = float(value)
    return value if math.isfinite(value) else None


def _or0(value: Optional[float]) -> float:
    """For a NOT NULL number column: "no value" is written as 0."""
    number = _num(value)
    return 0 if number is None else number


def _f(value) -> Optional[float]:
    return None if value is None else float(value)


def _none0(value) -> Optional[float]:
    """Read back a NOT NULL column where 0 means "no value" (0 V, 0:1 ratio, 0 g oil can't be real)."""
    number = _f(value)
    return number if number else None


def _seconds(minutes: Optional[float]) -> Optional[float]:
    number = _num(minutes)
    return None if number is None else number * 60


def _minutes(seconds) -> Optional[float]:
    return None if seconds is None else round(float(seconds) / 60, 6)


def _kwh(value, unit: Optional[str]) -> float:
    energy = float(value or 0)
    unit = (unit or "kWh").strip().lower()
    return energy / 1000 if unit == "wh" else energy * 1000 if unit == "mwh" else energy


def _local(moment: Optional[datetime]) -> Optional[datetime]:
    """DATETIME columns have no time zone: times are stored in the backend computer's local time."""
    if moment is not None and moment.tzinfo is not None:
        moment = moment.astimezone().replace(tzinfo=None)
    return moment


def _choice(value: Optional[str], allowed, default=None):
    """A stored text, matched to one of the allowed values without caring about upper/lower case
    (so "passed" typed in HeidiSQL still counts as "Passed")."""
    if not value:
        return default
    for option in allowed:
        if value.strip().lower() == option.lower():
            return option
    return default


def _text(value: Optional[str]) -> Optional[str]:
    return value.decode() if isinstance(value, (bytes, bytearray)) else value


def _json(value) -> dict:
    if isinstance(value, dict):
        return value
    return json.loads(_text(value))


# ---------------------------------------------------------------- settings
def _flatten(prefix: str, value, row: dict) -> None:
    """{"esterification": {"voltage": {"min": 10}}} -> {"esterificationVoltageMin": 10}"""
    if isinstance(value, dict):
        for key, inner in value.items():
            _flatten(prefix + key[:1].upper() + key[1:], inner, row)
    else:
        row[prefix] = value


def settings_row(s: Settings) -> dict:
    """The settings as columns of the settings table (camelCase, nested limits flattened)."""
    row: dict = {}
    for key, value in s.dump().items():
        _flatten(key, value, row)
    return row


def settings_from_row(row: dict) -> Settings:
    """A settings row back into Settings. Columns that aren't in the row keep their default."""
    def fill(prefix: str, default):
        if isinstance(default, dict):
            return {k: fill(prefix + k[:1].upper() + k[1:], v) for k, v in default.items()}
        if prefix not in row:
            return default
        value = row[prefix]
        return float(value) if isinstance(value, Decimal) else _text(value)

    return Settings.model_validate({key: fill(key, value) for key, value in Settings().dump().items()})


def _write_settings(cur, s: Settings) -> None:
    columns = _settings_column_set(cur)
    row = {k: v for k, v in settings_row(s).items() if k in columns}
    skipped = sorted(set(settings_row(s)) - columns)
    if skipped:
        log.warning("The settings table has no column for %s: those settings aren't saved. Restart the "
                    "backend to add the columns, or run the ALTER TABLE lines in database.md.", ", ".join(skipped))
    cur.execute("SELECT id FROM settings WHERE id = %s FOR UPDATE", (SETTINGS_ID,))
    if cur.fetchone():
        cur.execute("UPDATE settings SET " + ", ".join(f"`{k}` = %s" for k in row) + " WHERE id = %s",
                    (*row.values(), SETTINGS_ID))
    else:
        cur.execute(f"INSERT INTO settings (`id`, {', '.join(f'`{k}`' for k in row)}) "
                    f"VALUES (%s, {', '.join(['%s'] * len(row))})", (SETTINGS_ID, *row.values()))


def get_settings() -> Settings:
    with transaction() as cur:
        cur.execute("SELECT * FROM settings WHERE id = %s", (SETTINGS_ID,))
        row = cur.fetchone()
    if not row:
        return Settings()
    try:
        s = settings_from_row(row)
    except ValidationError as e:
        raise DatabaseError(f"The settings row in MySQL (table settings, id = 1) has a value the backend can't "
                            f"use: {e}. Fix it in HeidiSQL, or delete the row to go back to the defaults.") from e
    # Old defaults saved by earlier versions become the new defaults (values you changed stay).
    if s.ffa_range_boundaries == "0,2,4,6,8,10":
        # the strip reads only up to 5%, so the ranges end at 5%+
        s.ffa_range_boundaries = Settings().ffa_range_boundaries
    for limits in (s.esterification, s.transesterification):
        if limits.voltage.min == 18:
            limits.voltage.min = 10
        if limits.time.max == 120:
            limits.time.max = 180
        if limits.current.min == 0.5:          # current is a whole number now: 1-2 A
            limits.current.min = 1
        if limits.current.default < limits.current.min:
            limits.current.default = limits.current.min
    if s.reactor_drain_time == 3:
        s.reactor_drain_time = 1
    if s.centrifuge_drain_time == 3:           # old default: the centrifuge outlet now stays open 2 min
        s.centrifuge_drain_time = 2
    if s.ffa_threshold == 4:                   # old rule: now FFA <= 1% goes straight to transesterification
        s.ffa_threshold = 1
    return s


def save_settings(s: Settings) -> None:
    _write(_write_settings, s)


# ---------------------------------------------------------------- batches: object -> rows
def _batch_row(b: Batch) -> dict:
    """production_batches columns. Units: minutes -> seconds, energy in kWh (energy_unit)."""
    return {
        "production_date": _date.fromisoformat(b.date),
        "oil_volume_ml": _or0(b.oil_volume),
        "oil_mass_g": _or0(b.oil_mass_g),
        "yield_percent": _or0(b.yield_),
        "duration_seconds": _or0(_seconds(b.duration)),
        "energy_value": _or0(b.energy),
        "energy_unit": "kWh",
        "batch_status": b.status,
        "ffa_percent": _or0(b.ffa),
        "ffa_above_strip": b.ffa_above_strip,
        "esterification_run": b.esterification_run,
        "esterification_voltage": _num(b.esterification_voltage),
        "esterification_time_seconds": _seconds(b.esterification_time),
        "esterification_stirring_rpm": _num(b.esterification_stirring),
        "esterification_current_a": _num(b.esterification_current),
        "temperature_c": _or0(b.temperature),
        "reaction_time_seconds": _or0(_seconds(b.reaction_time)),
        "stirring_speed_rpm": _or0(b.stirring_speed),
        "voltage_v": _or0(b.voltage),
        "current_a": _or0(b.current),
        "methanol_ratio": _or0(b.methanol_ratio),
        "biodiesel_output_ml": _or0(b.biodiesel_output_ml),
        "catalyst_type": b.catalyst_type or "",
        "adsorbent": b.adsorbent or "",
        "catalyst_to_weigh_g": _or0(b.catalyst_to_weigh_g),
        "notes": b.notes,
    }


def _purification_row(p: PurificationRecord) -> dict:
    return {
        "target_temperature_c": _or0(p.target_temperature),
        "highest_temperature_c": _or0(p.highest_temperature),
        "heating_time_seconds": _or0(p.heating_time_seconds),
        "hold_time_seconds": _or0(p.hold_time_seconds),
        "flow_time_seconds": _or0(p.flow_time_seconds),
        "drain_time_seconds": _or0(p.drain_time_seconds),
        "contact_time_seconds": _or0(p.contact_time_seconds),
        "settling_time_seconds": _or0(p.settling_time_seconds),
        "cooling_time_seconds": _or0(p.cooling_time_seconds),
        "magnesol_added": p.magnesol_added,
        "oil_weight_g": _or0(p.oil_weight_g),
        "expected_biodiesel_ml": _num(p.expected_biodiesel_ml),
        "planned_flow_seconds": _num(p.planned_flow_seconds),
        "is_automatic": p.automatic,
        "warning": p.warning,
        "safety_stop_occurred": p.safety_stop_occurred,
        "safety_stop_reason": p.safety_stop_reason,
        "output_weight_g": _or0(p.output_weight_g),
        "stirring_speed_rpm": _or0(p.stirring_speed),
        "magnesol_g": _or0(p.magnesol_g),
        "adsorbent": p.adsorbent or "",
        "adsorbent_g": _or0(p.adsorbent_g),
        "heater_on_seconds": _or0(p.heater_on_seconds),
    }


def _insert(cur, table: str, row: dict) -> None:
    cur.execute(f"INSERT INTO `{table}` ({', '.join(f'`{k}`' for k in row)}) "
                f"VALUES ({', '.join(['%s'] * len(row))})", tuple(row.values()))


def _update(cur, table: str, row: dict, where: str, args: tuple) -> None:
    cur.execute(f"UPDATE `{table}` SET {', '.join(f'`{k}` = %s' for k in row)} WHERE {where}",
                (*row.values(), *args))


def _write_purification(cur, batch_id: str, p: Optional[PurificationRecord]) -> None:
    """batch_purification: 0 or 1 row per batch (updated in place, never a second row)."""
    if p is None:
        cur.execute("DELETE FROM batch_purification WHERE batch_id = %s", (batch_id,))
        return
    p_row = _purification_row(p)
    cur.execute("SELECT purification_id FROM batch_purification WHERE batch_id = %s", (batch_id,))
    if cur.fetchone():
        _update(cur, "batch_purification", p_row, "batch_id = %s", (batch_id,))
    else:
        _insert(cur, "batch_purification", {"batch_id": batch_id, **p_row})


def _lock_batch(cur, batch_id: str) -> Optional[dict]:
    """Locks the batch row until the transaction ends, so two saves of the same batch (e.g. a
    timeline event and the purification record) run one after the other instead of mixing their
    rows. Returns {"batch_status": ...}, or None when there's no such batch."""
    cur.execute("SELECT batch_status FROM production_batches WHERE batch_id = %s FOR UPDATE", (batch_id,))
    return cur.fetchone()


def _save_batch(cur, b: Batch) -> None:
    if len(b.id) > BATCH_ID_MAX:
        raise ValueError(f"Batch ID {b.id!r} is longer than {BATCH_ID_MAX} characters.")
    row = _batch_row(b)
    # One row per batch ID: an existing batch (e.g. the ongoing one being completed) is updated.
    if _lock_batch(cur, b.id):
        if b.created_at is not None:
            row["created_at"] = _local(b.created_at)
        _update(cur, "production_batches", row, "batch_id = %s", (b.id,))
    else:
        row["created_at"] = _local(b.created_at) or datetime.now()
        _insert(cur, "production_batches", {"batch_id": b.id, **row})

    _write_purification(cur, b.id, b.purification)

    # batch_materials: the 7 materials the app knows (rows with other names, added by hand, stay)
    names = [name for name, _ in MATERIALS.values()]
    if b.materials is None:
        cur.execute(f"DELETE FROM batch_materials WHERE batch_id = %s AND material_name IN "
                    f"({', '.join(['%s'] * len(names))})", (b.id, *names))
    else:
        cur.execute("SELECT material_name FROM batch_materials WHERE batch_id = %s", (b.id,))
        have = {r["material_name"].strip().lower(): r["material_name"] for r in cur.fetchall()}
        for field, (name, unit) in MATERIALS.items():
            quantity = max(_or0(getattr(b.materials, field)), 0)
            if name.lower() in have:                # update the row as it is spelled in MySQL
                _update(cur, "batch_materials", {"quantity": quantity, "unit": unit},
                        "batch_id = %s AND material_name = %s", (b.id, have[name.lower()]))
            else:
                _insert(cur, "batch_materials", {"batch_id": b.id, "material_name": name,
                                                 "quantity": quantity, "unit": unit})

    # esterification_stages: one row per stage number
    cur.execute("SELECT stage_number FROM esterification_stages WHERE batch_id = %s", (b.id,))
    have_stages = {r["stage_number"] for r in cur.fetchall()}
    for stage in b.esterification_stages:
        data = json.dumps(stage.dump())
        if stage.stage in have_stages:
            _update(cur, "esterification_stages", {"stage_data": data},
                    "batch_id = %s AND stage_number = %s", (b.id, stage.stage))
        else:
            _insert(cur, "esterification_stages", {"batch_id": b.id, "stage_number": stage.stage,
                                                   "stage_data": data})
    gone = have_stages - {stage.stage for stage in b.esterification_stages}
    if gone:
        cur.execute(f"DELETE FROM esterification_stages WHERE batch_id = %s AND stage_number IN "
                    f"({', '.join(['%s'] * len(gone))})", (b.id, *sorted(gone)))

    # batch_timeline: event_sequence 1, 2, 3, ... in the timeline's order (new events are appended)
    cur.execute("SELECT event_sequence, event_label, event_time FROM batch_timeline WHERE batch_id = %s",
                (b.id,))
    have_events = {r["event_sequence"]: (r["event_label"], r["event_time"]) for r in cur.fetchall()}
    new_events = []
    for sequence, event in enumerate(b.timeline, start=1):
        values = (event.label[:EVENT_LABEL_MAX], _local(event.time))
        if sequence not in have_events:
            new_events.append((b.id, sequence, *values))
        elif have_events[sequence] != values:
            _update(cur, "batch_timeline", {"event_label": values[0], "event_time": values[1]},
                    "batch_id = %s AND event_sequence = %s", (b.id, sequence))
    if new_events:
        cur.executemany("INSERT INTO batch_timeline (batch_id, event_sequence, event_label, event_time) "
                        "VALUES (%s, %s, %s, %s)", new_events)
    cur.execute("DELETE FROM batch_timeline WHERE batch_id = %s AND event_sequence > %s", (b.id, len(b.timeline)))

    # An ongoing batch has no lab result yet: its row is written when it is completed (or cancelled).
    if b.status != IN_PROGRESS:
        _write_lab_result(cur, b)
        # finished (completed, failed or cancelled): nothing left to continue on the Process page
        cur.execute("DELETE FROM batch_progress WHERE batch_id = %s", (b.id,))


def _write_lab_result(cur, b: Batch) -> None:
    """batch_lab_results: ONE row per batch (UNIQUE batch_id), found by batch_id and updated in
    place when the result changes (Pending -> Passed), never a second row.
    tested_at = when the result was recorded: b.lab_tested_at when given, else the time already
    saved, else now for a Passed/Failed result. A saved time is never replaced by NULL.
    Columns the app doesn't use (test_name, measured_value, unit, notes) are left as they are."""
    cur.execute("SELECT lab_result_id, result_status, lab_reference, tested_at FROM batch_lab_results "
                "WHERE batch_id = %s ORDER BY lab_result_id DESC LIMIT 1 FOR UPDATE", (b.id,))
    row = cur.fetchone()
    tested_at = _local(b.lab_tested_at) or (row["tested_at"] if row else None)
    # if tested_at is None and b.lab_result in TESTED_RESULTS:
    if tested_at is None:
        tested_at = datetime.now()
    values = {"result_status": b.lab_result, "lab_reference": b.lab_reference or None, "tested_at": tested_at}
    if row is None:
        _insert(cur, "batch_lab_results", {"batch_id": b.id, **values})
        return
    if _choice(row["result_status"], LAB_RESULTS) == b.lab_result:
        del values["result_status"]              # same result (maybe typed "passed" by hand): keep it as it is
    changed = {k: v for k, v in values.items() if row[k] != v}
    if changed:
        _update(cur, "batch_lab_results", changed, "lab_result_id = %s", (row["lab_result_id"],))


def save_batch(b: Batch) -> None:
    """Saves a batch and its child rows in one transaction (a new batch, or an update)."""
    _write(_save_batch, b)


def _add_timeline_event(cur, batch_id: str, label: str, moment: datetime) -> bool:
    if not _lock_batch(cur, batch_id):
        return False
    cur.execute("SELECT COALESCE(MAX(event_sequence), 0) AS n FROM batch_timeline WHERE batch_id = %s", (batch_id,))
    _insert(cur, "batch_timeline", {"batch_id": batch_id, "event_sequence": int(cur.fetchone()["n"]) + 1,
                                    "event_label": label[:EVENT_LABEL_MAX], "event_time": _local(moment)})
    return True


def add_timeline_event(batch_id: str, label: str, moment: Optional[datetime] = None) -> bool:
    """Appends one event to a saved batch's timeline (one INSERT, so events added at the same time
    by the pumps, valves and purification never overwrite each other). False: no such batch."""
    return _write(_add_timeline_event, batch_id, label, moment or datetime.now())


def _set_purification(cur, batch_id: str, p: PurificationRecord) -> bool:
    if not _lock_batch(cur, batch_id):
        return False
    _write_purification(cur, batch_id, p)
    return True


def set_purification(batch_id: str, p: PurificationRecord) -> bool:
    """Saves only the batch's purification record (its other rows stay as they are)."""
    return _write(_set_purification, batch_id, p)


# ---------------------------------------------------------------- batches: rows -> object
def _load_children(cur, batch_id: Optional[str] = None) -> dict[str, dict]:
    """The child rows of one batch (or of every batch), grouped by batch_id."""
    where, args = ("WHERE batch_id = %s", (batch_id,)) if batch_id is not None else ("", ())
    children: dict[str, dict] = {}

    def of(row) -> dict:
        return children.setdefault(row["batch_id"], {"purification": None, "materials": [], "stages": [],
                                                     "timeline": [], "lab": None})

    cur.execute(f"SELECT * FROM batch_purification {where}", args)
    for row in cur.fetchall():
        of(row)["purification"] = row
    cur.execute(f"SELECT batch_id, material_name, quantity, unit FROM batch_materials {where} "
                f"ORDER BY material_id", args)
    for row in cur.fetchall():
        of(row)["materials"].append(row)
    cur.execute(f"SELECT batch_id, stage_number, stage_data FROM esterification_stages {where} "
                f"ORDER BY batch_id, stage_number", args)
    for row in cur.fetchall():
        of(row)["stages"].append(row)
    cur.execute(f"SELECT batch_id, event_label, event_time FROM batch_timeline {where} "
                f"ORDER BY batch_id, event_sequence", args)
    for row in cur.fetchall():
        of(row)["timeline"].append(row)
    cur.execute(f"SELECT batch_id, result_status, lab_reference, tested_at FROM batch_lab_results {where} "
                f"ORDER BY batch_id, lab_result_id", args)
    for row in cur.fetchall():
        of(row)["lab"] = row                     # the newest row wins
    return children


def _purification_from_row(r: dict) -> PurificationRecord:
    return PurificationRecord.model_validate({
        "targetTemperature": _f(r["target_temperature_c"]),
        "highestTemperature": _none0(r["highest_temperature_c"]),
        "heatingTimeSeconds": _f(r["heating_time_seconds"]),
        "holdTimeSeconds": _f(r["hold_time_seconds"]),
        "flowTimeSeconds": _f(r["flow_time_seconds"]),
        "drainTimeSeconds": _f(r["drain_time_seconds"]),
        "contactTimeSeconds": _f(r["contact_time_seconds"]),
        "settlingTimeSeconds": _f(r["settling_time_seconds"]),
        "coolingTimeSeconds": _f(r["cooling_time_seconds"]),
        "magnesolAdded": bool(r["magnesol_added"]),
        "oilWeightG": _none0(r["oil_weight_g"]),
        "expectedBiodieselMl": _f(r["expected_biodiesel_ml"]),
        "plannedFlowSeconds": _f(r["planned_flow_seconds"]),
        "automatic": bool(r["is_automatic"]),
        "warning": r["warning"],
        "safetyStopOccurred": bool(r["safety_stop_occurred"]),
        "safetyStopReason": r["safety_stop_reason"],
        "outputWeightG": _none0(r["output_weight_g"]),
        "stirringSpeed": _none0(r["stirring_speed_rpm"]),
        "magnesolG": _none0(r["magnesol_g"]),
        "adsorbent": _choice(r["adsorbent"], ("Magnesol", "Bentonite")),
        "adsorbentG": _none0(r["adsorbent_g"]),
        "heaterOnSeconds": _f(r["heater_on_seconds"]),
    })


def _materials_from_rows(rows: list[dict]) -> Optional[Materials]:
    by_name = {name.lower(): field for field, (name, _) in MATERIALS.items()}
    values = {field: 0.0 for field in MATERIALS}
    found = False
    for r in rows:
        field = by_name.get(r["material_name"].strip().lower())
        if field is None:
            continue                              # a material added by hand: kept in MySQL only
        quantity, unit = float(r["quantity"]), (r["unit"] or "").strip().lower()
        if unit in ("ml", "g"):                   # stored in mL or g instead of L or kg
            quantity /= 1000
        values[field] = quantity
        found = True
    return Materials.model_validate(values) if found else None


def _batch_from_rows(r: dict, children: Optional[dict]) -> Batch:
    c = children or {"purification": None, "materials": [], "stages": [], "timeline": [], "lab": None}
    lab = c["lab"]
    stages = []
    for row in c["stages"]:
        data = _json(row["stage_data"])
        data["stage"] = row["stage_number"]
        stages.append(EsterificationStage.model_validate(data))
    return Batch.model_validate({
        "id": r["batch_id"],
        "date": r["production_date"].isoformat(),
        "oilVolume": _f(r["oil_volume_ml"]),
        "yield": _f(r["yield_percent"]),
        "duration": _minutes(r["duration_seconds"]),
        "energy": _kwh(r["energy_value"], r["energy_unit"]),
        "status": r["batch_status"],
        "labResult": _choice(lab["result_status"], LAB_RESULTS, "Pending") if lab else "Pending",
        "labReference": lab["lab_reference"] if lab else None,
        "labTestedAt": lab["tested_at"] if lab else None,
        "ffa": _f(r["ffa_percent"]),
        "ffaAboveStrip": bool(r["ffa_above_strip"]),
        "esterificationRun": bool(r["esterification_run"]),
        "temperature": _f(r["temperature_c"]),
        "reactionTime": _minutes(r["reaction_time_seconds"]),
        "stirringSpeed": _f(r["stirring_speed_rpm"]),
        "voltage": _none0(r["voltage_v"]),
        "current": _none0(r["current_a"]),
        "methanolRatio": _none0(r["methanol_ratio"]),
        "esterificationVoltage": _f(r["esterification_voltage"]),
        "esterificationTime": _minutes(r["esterification_time_seconds"]),
        "esterificationStirring": _f(r["esterification_stirring_rpm"]),
        "esterificationCurrent": _f(r["esterification_current_a"]),
        "biodieselOutputMl": _f(r["biodiesel_output_ml"]),
        "catalystType": _choice(r["catalyst_type"], ("NaOH", "KOH")),
        "adsorbent": _choice(r["adsorbent"], ("Magnesol", "Bentonite")),
        "materials": _materials_from_rows(c["materials"]),
        "purification": _purification_from_row(c["purification"]) if c["purification"] else None,
        "oilMassG": _none0(r["oil_mass_g"]),
        "catalystToWeighG": _none0(r["catalyst_to_weigh_g"]),
        "esterificationStages": stages,
        "timeline": [TimelineEvent(label=e["event_label"], time=e["event_time"]) for e in c["timeline"]],
        "notes": r["notes"],
        "createdAt": r["created_at"],
    })


def list_batches() -> list[Batch]:
    """Newest first, like the website's Batch History. A row that can't be read (e.g. a value
    typed by hand in HeidiSQL) is left out and logged, so one bad row doesn't hide the others."""
    with transaction() as cur:
        cur.execute("SELECT * FROM production_batches ORDER BY production_date DESC, batch_id DESC")
        rows = cur.fetchall()
        children = _load_children(cur)
    batches = []
    for r in rows:
        try:
            batches.append(_batch_from_rows(r, children.get(r["batch_id"])))
        except (ValidationError, ValueError, TypeError) as e:
            log.error("Batch %s in MySQL can't be read and is left out: %s", r["batch_id"], e)
    return batches


def get_batch(batch_id: str) -> Optional[Batch]:
    with transaction() as cur:
        cur.execute("SELECT * FROM production_batches WHERE batch_id = %s", (batch_id,))
        row = cur.fetchone()
        if row is None:
            return None
        children = _load_children(cur, row["batch_id"])
    return _batch_from_rows(row, children.get(row["batch_id"]))


def _next_batch_id(cur, batch_format: str, year: int) -> str:
    if "{SEQ}" not in batch_format:
        batch_format += "-{SEQ}"
    prefix_format = batch_format.replace("{YEAR}", str(year))
    pattern = re.compile("^" + re.escape(prefix_format).replace(re.escape("{SEQ}"), r"(\d+)") + "$")
    cur.execute("SELECT batch_id FROM production_batches")
    ids = [r["batch_id"] for r in cur.fetchall()]
    numbers = [int(m.group(1)) for i in ids if (m := pattern.match(i))]
    return prefix_format.replace("{SEQ}", f"{max(numbers, default=0) + 1:03d}")


def next_batch_id(batch_format: str, year: int) -> str:
    """Next ID for a format like "B-{YEAR}-{SEQ}" (the website's batch naming format)."""
    with transaction() as cur:
        return _next_batch_id(cur, batch_format, year)


# ---------------------------------------------------------------- the ongoing batch
def _active_batch_id(cur, lock: bool = False) -> Optional[str]:
    cur.execute("SELECT batch_id FROM production_batches WHERE batch_status = %s ORDER BY created_at LIMIT 1"
                + (" FOR UPDATE" if lock else ""), (IN_PROGRESS,))
    row = cur.fetchone()
    return row["batch_id"] if row else None


def active_batch_id() -> Optional[str]:
    """The batch that is "In Progress", or None."""
    with transaction() as cur:
        return _active_batch_id(cur)


def _start_batch(cur, b: Batch, batch_format: str, year: int) -> Batch:
    # FOR UPDATE also locks the place where a new "In Progress" row would go, so two batches
    # started at the same moment can't both get in (the second waits, then sees the first).
    active = _active_batch_id(cur, lock=True)
    if active is not None:
        raise ActiveBatchError(active)
    cur.execute("SELECT batch_id FROM production_batches WHERE batch_id = %s", (b.id,))
    if not b.id or cur.fetchone():               # ID already used (or none asked for): take the next one
        b = b.model_copy(update={"id": _next_batch_id(cur, batch_format, year)})
    _save_batch(cur, b)
    return b


def start_batch(b: Batch, batch_format: str, year: int) -> Batch:
    """Saves a new "In Progress" batch, keeping b.id when it is still free (else the next ID).
    Raises ActiveBatchError when another batch is in progress."""
    if b.status != IN_PROGRESS:
        raise ValueError("A started batch is In Progress.")
    return _write(_start_batch, b, batch_format, year)


# production_batches columns the website updates while a batch is in progress (oil, FFA, the
# chosen parameters). Results (yield, energy, purification, timeline) are written when it ends.
PROGRESS_COLUMNS = ("oil_volume_ml", "oil_mass_g", "ffa_percent", "ffa_above_strip",
                    "esterification_run", "esterification_voltage", "esterification_time_seconds",
                    "esterification_stirring_rpm", "esterification_current_a", "reaction_time_seconds",
                    "stirring_speed_rpm", "voltage_v", "current_a", "methanol_ratio", "catalyst_type", "adsorbent",
                    "catalyst_to_weigh_g")


def _save_progress(cur, b: Batch, stage: str, state: dict) -> bool:
    found = _lock_batch(cur, b.id)
    if not found or found["batch_status"] != IN_PROGRESS:
        return False                             # finished or cancelled meanwhile: nothing to save
    row = _batch_row(b)
    _update(cur, "production_batches", {k: row[k] for k in PROGRESS_COLUMNS}, "batch_id = %s", (b.id,))
    values = {"current_stage": stage[:50], "state_data": json.dumps(state), "updated_at": datetime.now()}
    cur.execute("SELECT batch_id FROM batch_progress WHERE batch_id = %s", (b.id,))
    if cur.fetchone():
        _update(cur, "batch_progress", values, "batch_id = %s", (b.id,))
    else:
        _insert(cur, "batch_progress", {"batch_id": b.id, **values})
    return True


def save_progress(b: Batch, stage: str, state: dict) -> bool:
    """Saves where the ongoing batch is on the Process page (one row per batch, updated in place)
    and its setup columns. Only the batch's own row and its batch_progress row change: the
    timeline and the other rows stay as they are. False: the batch isn't in progress any more."""
    return _write(_save_progress, b, stage, state)


def _progress_from_row(row: dict) -> dict:
    return {"stage": row["current_stage"], "state": _json(row["state_data"]),
            "updatedAt": row["updated_at"].isoformat() if row["updated_at"] else None}


def get_progress(batch_id: str) -> Optional[dict]:
    """{"stage", "state", "updatedAt"} of an ongoing batch, or None."""
    with transaction() as cur:
        cur.execute("SELECT * FROM batch_progress WHERE batch_id = %s", (batch_id,))
        row = cur.fetchone()
    return _progress_from_row(row) if row else None


def progress_stages() -> dict[str, str]:
    """The Process page stage of every ongoing batch, by batch ID (for Batch History)."""
    with transaction() as cur:
        cur.execute("SELECT batch_id, current_stage FROM batch_progress")
        return {r["batch_id"]: r["current_stage"] for r in cur.fetchall()}


# ---------------------------------------------------------------- python -m app.db
def check() -> int:
    """Connection check: python -m app.db"""
    d = config.DATABASE
    source = "backend/.env + app/config.py" if config.ENV_FILE.is_file() else "app/config.py (no backend/.env)"
    print(f"MySQL: {d['user']}@{d['host']}:{d['port']}, database {d['database']}   [{source}]")
    try:
        init_db()
        with transaction() as cur:
            cur.execute("SELECT VERSION() AS v")
            version = cur.fetchone()["v"]
            counts = {}
            for table in TABLES:
                cur.execute(f"SELECT COUNT(*) AS n FROM `{table}`")
                counts[table] = cur.fetchone()["n"]
        print(f"Connected. Server version {version}.")
        for table, n in counts.items():
            print(f"  {table:<24}{n:>6} rows")
        get_settings()
        print("OK: the backend can use this database.")
        return 0
    except DatabaseError as e:
        print(f"NOT OK: {e}")
        return 1
    finally:
        close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    sys.exit(check())
