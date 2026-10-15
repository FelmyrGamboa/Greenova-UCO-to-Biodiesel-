# Greenova database: MySQL

The backend now keeps every batch and the settings in a **MySQL database (`greenova_db`)** instead of the SQLite file `backend/greenova.db`. It uses the tables, keys and relationships of `greenova_db.sql` (your HeidiSQL export). The website did not change: it gets exactly the same data from the API as before.

```
 Website (browser) ──/api──► FastAPI backend (backend/) ──PyMySQL──► MySQL, database greenova_db (8 tables)
                               app/config.py + backend/.env: your MySQL login
```

---

## 1. Setup on your laptop: 3 steps

**Step 1. MySQL is running.** The MySQL Server 8.0 you use with HeidiSQL: Windows **Services → MySQL80 → Running**.

**Step 2. Your MySQL password.** Double-click `backend\start-backend.bat`. The first time, it creates `backend\.env` and opens it in Notepad. Type the password you use in HeidiSQL after `DB_PASSWORD=`, then save and close Notepad:

```ini
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your-mysql-password
DB_NAME=greenova_db
```

(Or skip `.env` and type the password in `backend\app\config.py`, in the "MySQL database" lines near the top. Part 2 explains both.)

**Step 3. Nothing else.** `start-backend.bat` installs the packages (PyMySQL, cryptography), connects, **creates the `greenova_db` database and its 8 tables by itself**, loads the sample batches, and starts the backend at http://localhost:8000. Start the website as before (`npm install` once, then `npm run dev` in `frontend`).

If you already made `greenova_db` in HeidiSQL from `greenova_db.sql`, the backend uses those tables. It only adds the 5 settings columns that the export is missing (part 5).

The check it runs, which you can also run by hand from the `backend` folder:

```
.venv\Scripts\python.exe -m app.db

MySQL: root@localhost:3306, database greenova_db   [backend/.env + app/config.py]
Created the database greenova_db
Created table production_batches
...
Connected. Server version 8.0.46.
  production_batches          0 rows
  ...
OK: the backend can use this database.
```

If it says `NOT OK`, the sentence after it says what to fix (part 8).

### Optional: copy the batches from the old `greenova.db`

Once, from the `backend` folder:

```
.venv\Scripts\python.exe -m app.migrate_sqlite

...\backend\greenova.db: 3 batches, no saved settings
  B-2026-001: copied (13 timeline events, 0 esterification stages, materials, purification)
  B-2026-002: copied (13 timeline events, 0 esterification stages, materials, purification)
  B-2026-003: copied (32 timeline events, 0 esterification stages, materials, purification)
Done: 3 copied, 0 skipped, 0 problems. greenova.db was not changed.
```

It never changes `greenova.db`. It reads every copied batch back and compares it (a difference would be printed after `CHECK:`). Running it again skips batches already in MySQL (`--replace` overwrites them), and another file works too: `python -m app.migrate_sqlite D:\old\greenova.db`. After that, `greenova.db` isn't used any more.

### Another computer or teammate

Same 3 steps. `.env` is in `.gitignore`, so each computer keeps its own password and it is never committed to GitHub. `.env.example` is the template.

---

## 2. The MySQL login: `.env` or `config.py`

`backend/app/config.py` has the login, with these defaults:

```python
DB_HOST = os.getenv("DB_HOST", "localhost")      # the computer running MySQL
DB_PORT = int(os.getenv("DB_PORT", "3306"))
DB_USER = os.getenv("DB_USER", "root")           # the MySQL user you log in with in HeidiSQL
DB_PASSWORD = os.getenv("DB_PASSWORD", "")       # its password
DB_NAME = os.getenv("DB_NAME", "greenova_db")
```

| Setting | Default | Meaning |
|---|---|---|
| `DB_HOST` | `localhost` | Computer running MySQL (`localhost` = this computer) |
| `DB_PORT` | `3306` | MySQL port |
| `DB_USER` | `root` | MySQL user |
| `DB_PASSWORD` | *(empty)* | Its password |
| `DB_NAME` | `greenova_db` | Database; created by the backend if it doesn't exist |

Where a value comes from (later wins): the default in `config.py` → `backend/.env` → a real environment variable (e.g. `set DB_PASSWORD=...` in the Command Prompt window).

- **Using `.env`** (recommended): one `NAME=value` per line, `#` starts a comment line, quotes are optional (`DB_PASSWORD="my pass"`). A `#` inside a password is fine. An empty value (`DB_PASSWORD=`) means "use the default from `config.py`". No extra package is needed: `config.py` reads the file itself.
- **Using `config.py` only**: replace the second value, e.g. `DB_PASSWORD = os.getenv("DB_PASSWORD", "your-mysql-password")`. The catch: `config.py` is committed to git, so the password would end up on GitHub.

`.env` can also hold the other backend settings, e.g. `GREENOVA_TIME_SCALE=20`.

**Optional: a separate MySQL user instead of root.** In HeidiSQL, as root:

```sql
CREATE USER IF NOT EXISTS 'greenova'@'localhost' IDENTIFIED BY 'choose-a-password';
GRANT ALL PRIVILEGES ON greenova_db.* TO 'greenova'@'localhost';
GRANT ALL PRIVILEGES ON greenova_test.* TO 'greenova'@'localhost';   -- for the tests (part 7)
```

Then set `DB_USER=greenova` and its password in `.env`.

---

## 3. Raspberry Pi

### Option A (recommended): MySQL (MariaDB) on the Pi

The Pi then works on its own, without the laptop:

```bash
cd ~/Greenova-UCO-to-Biodiesel-/backend
bash setup-pi.sh --with-mariadb
.venv/bin/python -m app.db                 # should end with OK
.venv/bin/python -m app.migrate_sqlite     # only if you copied an old greenova.db to the Pi
```

`--with-mariadb` installs MariaDB, creates `greenova_db` with its tables and a `greenova` user with a random password, and writes `backend/.env` for you. A separate user is needed on the Pi because MariaDB's root there only logs in through `sudo`, not with a password. The `greenova` service starts after MariaDB.

- To load the tables by hand on the Pi, use **`backend/schema.sql`, not the HeidiSQL export**: `greenova_db.sql` uses `COLLATE utf8mb4_0900_ai_ci`, which MariaDB 10.11 rejects (`ERROR 1273 Unknown collation`). `schema.sql` has the same tables without it.
- Set the Pi's time zone once: `sudo timedatectl set-timezone Asia/Manila` (batch times are saved in local time).

### Option B: the Pi uses the laptop's MySQL over Wi-Fi

The laptop must then be on, on the same Wi-Fi, during every batch.

1. Laptop: give it a fixed address (DHCP reservation on the router), e.g. `192.168.1.20`.
2. Laptop: allow port 3306 in Windows Firewall (PowerShell as administrator):
   `New-NetFirewallRule -DisplayName "MySQL 3306 (Greenova)" -Direction Inbound -Protocol TCP -LocalPort 3306 -Profile Private -Action Allow`
3. Laptop, in HeidiSQL: root is allowed only from the laptop itself, so create a user for the Pi's network:
   ```sql
   CREATE USER IF NOT EXISTS 'greenova'@'192.168.1.%' IDENTIFIED BY 'choose-a-password';
   GRANT ALL PRIVILEGES ON greenova_db.* TO 'greenova'@'192.168.1.%';
   ```
4. Pi, in `backend/.env`: `DB_HOST=192.168.1.20`, `DB_USER=greenova`, `DB_PASSWORD=choose-a-password`. Then `.venv/bin/python -m app.db`.

If MySQL can't be reached, the batch can't be saved on the Pi. The machine and its safety rules still run, and the website offers "Finish and keep the record in this browser".

---

## 4. How the data is stored

### Tables and relationships

```
production_batches (PK batch_id)
 ├──o batch_lab_results      (FK batch_id, UNIQUE)  1 : 0..1   the lab result, updated in place
 ├──< batch_materials        (FK batch_id)          1 : many   one row per material
 ├──o batch_purification     (FK batch_id, UNIQUE)  1 : 0..1   dry wash record
 ├──< batch_timeline         (FK batch_id)          1 : many   events, event_sequence 1, 2, 3 …
 ├──< esterification_stages  (FK batch_id)          1 : many   one row per stage number
 └──o batch_progress         (FK batch_id, PK)      1 : 0..1   where the batch in progress is on the Process page

settings (PK id = 1)   one row, no relationship
```

Every foreign key is `ON DELETE CASCADE ON UPDATE CASCADE`. Deleting a batch in HeidiSQL (`DELETE FROM production_batches WHERE batch_id = 'B-2026-003'`) deletes its child rows too, and renaming a `batch_id` renames it in the child tables.

### Website field → column

**`production_batches`** (one row per batch)

| Batch field (API JSON) | Column | Conversion |
|---|---|---|
| `id` | `batch_id` | at most 50 characters |
| `date` | `production_date` | `YYYY-MM-DD` |
| `oilVolume`, `oilMassG` | `oil_volume_ml`, `oil_mass_g` | |
| `yield` | `yield_percent` | |
| `duration`, `reactionTime`, `esterificationTime` | `duration_seconds`, `reaction_time_seconds`, `esterification_time_seconds` | **minutes × 60** (read back ÷ 60) |
| `energy` | `energy_value` + `energy_unit` | kWh, `energy_unit = 'kWh'` (a row typed with `'Wh'` is converted) |
| `status` | `batch_status` | Completed / Failed / In Progress / Cancelled |
| `ffa`, `ffaAboveStrip`, `esterificationRun` | `ffa_percent`, `ffa_above_strip`, `esterification_run` | booleans are 0/1 |
| `temperature`, `stirringSpeed`, `voltage`, `current`, `methanolRatio` | `temperature_c`, `stirring_speed_rpm`, `voltage_v`, `current_a`, `methanol_ratio` | |
| `esterificationVoltage`, `esterificationStirring`, `esterificationCurrent` | `esterification_voltage`, `esterification_stirring_rpm`, `esterification_current_a` | NULL when there was no esterification |
| `biodieselOutputMl`, `catalystType`, `adsorbent`, `catalystToWeighG` | `biodiesel_output_ml`, `catalyst_type`, `adsorbent`, `catalyst_to_weigh_g` | |
| `notes`, `createdAt` | `notes`, `created_at` | `created_at` = the first save if the batch has none |
| `labResult`, `labReference`, `labTestedAt` | → `batch_lab_results` (`result_status`, `lab_reference`, `tested_at`) | below |
| `materials`, `purification`, `esterificationStages`, `timeline` | → child tables | below |

**`batch_lab_results`**: **one row per batch** (`UNIQUE KEY uq_lab_batch (batch_id)`). The row is written when the batch is completed (`Pending`) or cancelled (`Not tested`); recording or changing the lab result **updates that same row**, found by `batch_id` (Pending → Passed → Failed), never a second one. `tested_at` is when the result was recorded: the time the website sends (the operator's device clock, stored in the backend's local time), else the backend's time. A saved `tested_at` is **never replaced by NULL**: saving the batch again, or a PATCH without a time, keeps it; sending the same result and reference again changes nothing. Each recording also adds a timeline event "Lab result recorded: Passed (LAB-…)". `test_name`, `measured_value`, `unit` and `notes` are free for you, e.g. flash point results typed in HeidiSQL: the backend never changes them. Older tables had one row per change: on its next start the backend joins each batch's rows into the newest one (a value the newest lacks, e.g. a NULL `tested_at`, is taken from the older rows), then adds the unique key.

**`batch_materials`**: 7 rows per batch, `quantity` in the unit shown:

| `materials` field | `material_name` | `unit` |
|---|---|---|
| `oilL` | Used cooking oil | L |
| `methanolL` | Methanol | L |
| `catalystKg` | Catalyst (NaOH or KOH: `production_batches.catalyst_type`) | kg |
| `sulfuricAcidL` | Sulfuric acid | L |
| `acetoneL` | Acetone | L |
| `bentoniteKg` | Bentonite | kg |
| `magnesolKg` | Magnesol | kg |

A row with another name (e.g. `Water`, typed in HeidiSQL) is kept but not shown on the website. Rows typed in `mL` or `g` are converted.

**`batch_purification`**: the `purification` record, with the same names plus units: `targetTemperature → target_temperature_c`, `highestTemperature → highest_temperature_c`, `…Seconds → …_seconds`, `automatic → is_automatic`, `stirringSpeed → stirring_speed_rpm`, `magnesolAdded → magnesol_added`, `oilWeightG → oil_weight_g`, `outputWeightG → output_weight_g`, `magnesolG`, `adsorbent`, `adsorbentG`, `heaterOnSeconds`, `warning`, `safetyStopOccurred`, `safetyStopReason`, `expectedBiodieselMl`, `plannedFlowSeconds`.

**`esterification_stages`**: `stage_number` plus the stage's values as JSON in `stage_data`, e.g. `{"stage": 1, "ffaBefore": 3.0, "ffaAfter": 1.0, "doseFfa": 10.0, "methanolMl": 130.6, "sulfuricAcidMl": 1.2, "acetoneMl": 0.0}`.

**`batch_timeline`**: one row per event, `event_sequence` = its place in the timeline (1, 2, 3 …), `event_label` (at most 500 characters; longer texts are cut), `event_time` with microseconds. New events are added as new rows, and the existing rows keep their `event_id`.

**The batch in progress** (only one at a time). "Start Batch" on the Process page inserts its `production_batches` row at once with `batch_status = 'In Progress'`, so Batch History shows it. Every later save of that batch **updates the same row**; completing it never adds a second row with the same `batch_id`. While it runs, the pumps, valves and stages add their events to `batch_timeline` one by one, and the Pi's dry wash record goes into `batch_purification`. It gets no `batch_lab_results` row until it is completed (`Pending`) or cancelled (`Not tested`). **`batch_progress`** holds where the website is: `current_stage` ("Transesterification"), `state_data` (the Process page's own data, JSON) and `updated_at`. It has one row for the batch in progress, updated in place and deleted when the batch is completed or cancelled. The backend creates this table by itself on its next start. Find the ongoing batch with `SELECT batch_id FROM production_batches WHERE batch_status = 'In Progress';`.

**`settings`**: one row, `id = 1`, created with the defaults on the first start. The column names are the website's setting keys (`methanolRemovalTime`, `oilPrice` …). The nested limits are flattened: `methanolRatio.min → methanolRatioMin`, `esterification.voltage.default → esterificationVoltageDefault`, `transesterification.current.max → transesterificationCurrentMax`. Changing a value in HeidiSQL takes effect when the backend restarts; the Settings page saves at once.

### Rules worth knowing

- **"No value" in a NOT NULL column.** The schema makes some columns NOT NULL that the app can leave empty. They are saved as `0` (numbers) or `''` (text) and read back as "no value": `voltage_v`, `current_a`, `methanol_ratio`, `oil_mass_g`, `catalyst_to_weigh_g`, `catalyst_type`, `adsorbent`, and in `batch_purification` `highest_temperature_c`, `oil_weight_g`, `output_weight_g`, `stirring_speed_rpm`, `magnesol_g`, `adsorbent_g`, `adsorbent`. So a batch without a voltage still uses the 30 V default in the analytics, as before. `biodiesel_output_ml` and `heater_on_seconds` read back as 0.
- **Precision.** Numbers are DECIMAL: materials keep 6 decimals (1 µL / 1 mg), temperatures 2, seconds 3. Compared with the old file, the cost per liter differs by at most ₱0.0001.
- **Times** are saved in the backend computer's local time (DATETIME has no time zone).
- **Text typed by hand** is matched without caring about upper/lower case: `passed`, `naoh`, `magnesol` work. A batch row the backend can't read (e.g. `batch_status = 'Done'`) is left out of Batch History and logged, so it doesn't hide the other batches.
- **Lengths.** Too-long values are refused with a clear message: batch ID over 50 characters, lab reference over 100, `systemName` over 150, `operator` over 100, batch naming format over 50.

---

## 5. Differences from `greenova_db.sql` (the reference)

| | |
|---|---|
| `production_batches`, `batch_materials`, `batch_purification`, `batch_timeline`, `esterification_stages` | **Unchanged**: identical columns, types, keys, indexes, CHECK and foreign keys |
| `batch_lab_results` | Same columns; `KEY idx_lab_batch (batch_id)` became **`UNIQUE KEY uq_lab_batch (batch_id)`**: one lab result per batch (added by itself to an older table) |
| `batch_progress` | **New** table: where the batch in progress is on the Process page |
| `settings` | **+5 columns** for settings the app already had but the export didn't: `magnesolDose`, `bentoniteDose`, `defaultAdsorbent`, `autoAdvance`, `magnesolPrice` |
| `settings` defaults | `ffaThreshold` 4 → **1**, `centrifugeDrainTime` 3 → **2**, `esterificationCurrentMin` and `transesterificationCurrentMin` 0.5 → **1** (the current rules). The backend always writes every column, so these only matter for a row you insert by hand. The backend also upgrades these old values when it reads them. |
| `schema.sql` collation | No `COLLATE utf8mb4_0900_ai_ci`, so it also runs on MariaDB (the server's utf8mb4 default is used; on MySQL 8 that is the same `utf8mb4_0900_ai_ci`) |

**The backend adds the 5 settings columns by itself** on its first start (and `python -m app.db` does too). To add them yourself instead, run this in HeidiSQL:

```sql
ALTER TABLE greenova_db.settings
  ADD COLUMN `magnesolDose` decimal(10,2) NOT NULL DEFAULT '1.00' AFTER `purificationAutoStart`,
  ADD COLUMN `bentoniteDose` decimal(10,2) NOT NULL DEFAULT '2.00' AFTER `magnesolDose`,
  ADD COLUMN `defaultAdsorbent` varchar(100) NOT NULL DEFAULT 'Magnesol' AFTER `bentoniteDose`,
  ADD COLUMN `autoAdvance` tinyint(1) NOT NULL DEFAULT '1' AFTER `defaultAdsorbent`,
  ADD COLUMN `magnesolPrice` decimal(12,2) NOT NULL DEFAULT '250.00' AFTER `bentonitePrice`;
```

Update the ERD or data dictionary in the paper with these 5 columns. The other 6 tables are exactly as designed.

---

## 6. Changes made in the source code

**Nothing changed in the website (`frontend/`)**: the API answers with the same JSON. The endpoints (`api.py`), calculations, analytics, stages, purification and hardware code are unchanged too. All database access is still in one file, `backend/app/db.py`, with the same functions as before (`init_db`, `get_settings`, `save_settings`, `list_batches`, `get_batch`, `save_batch`, `next_batch_id`).

| File | Change |
|---|---|
| `backend/app/db.py` | **Rewritten for MySQL.** Was: 2 SQLite tables, each batch and the settings stored as one JSON text. Now it uses PyMySQL with a small connection pool and saves each batch in one transaction, spread over the 6 batch tables: child rows are updated in place, and lab results are added as history. Settings are spread over the `settings` columns. On start, `init_db()` creates the database and any missing table from `schema.sql`, adds missing settings columns, checks the columns, and saves the default settings row. Connection problems come back as clear messages (`DatabaseError`). `python -m app.db` checks the connection. |
| `backend/app/config.py` | **The MySQL login**: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, read from `backend/.env` (a small reader, no extra package) or the defaults. `DB_PATH` replaced by `LEGACY_SQLITE_PATH` (used only by the migration) |
| `backend/.env.example` | **New.** Template for `backend/.env` (your MySQL login) |
| `backend/schema.sql` | **New.** The 8 tables (part 5), parents first, runs on MySQL 8 and MariaDB |
| `backend/app/migrate_sqlite.py` | **New.** One-time copy of `greenova.db` into MySQL, with a read-back check |
| `backend/app/models.py` | Lengths that fit the columns: batch `id` ≤ 50, `labReference` ≤ 100, `systemName` ≤ 150, `operator` ≤ 100, `units` ≤ 20, `format` ≤ 50, `ffaRangeBoundaries` ≤ 100. `date` must be `YYYY-MM-DD` |
| `backend/app/main.py` | On start: a clear message if MySQL can't be used (the backend then doesn't start). On stop: closes the MySQL connections |
| `backend/main.py` | Checks that PyMySQL is installed; prints which MySQL it uses |
| `backend/requirements.txt` | `+ PyMySQL>=1.1`, `+ cryptography>=41` (MySQL 8's login method) |
| `backend/start-backend.bat` | First start: creates `.env` and opens it in Notepad. Installs the MySQL packages, runs `python -m app.db` before starting |
| `backend/setup-pi.sh` | `--with-mariadb`: installs MariaDB, creates the database, tables, user and `.env`. Without it: copies `.env.example` to `.env` |
| `backend/greenova.service` | Starts after `mariadb.service` / `mysql.service`; restarts if the database wasn't ready yet |
| `backend/.gitignore` | `+ .env` (it holds your password) |
| `backend/conftest.py` | Fixture `mysql_db`: a clean test database `greenova_test` for each test (skipped without MySQL; never uses `greenova_db`) |
| `backend/tests/test_api.py`, `test_core.py` | The 4 tests that used a temporary SQLite file now use `mysql_db`; a test for the `.env` reader |
| `backend/tests/test_mysql.py` | **New.** 20 tests: tables and foreign keys, cascade delete, full round trip of every batch part, units, NOT NULL handling, lab result history, in-place updates, time zones, rows typed in HeidiSQL, settings columns, adding the 5 missing settings columns, error messages, migration, too-long values |
| `README.md`, `backend/README.md`, `backend/API.md`, `docs/WEBSITE_GUIDE.md`, `docs/RASPBERRY_PI_SETUP.md` (and their copies in the project root), `CHANGED_FILES.md` | MySQL instead of SQLite; setup; troubleshooting |

`backend/greenova.db` is no longer read by the backend; only `migrate_sqlite` reads it.

---

## 7. Tests

```
cd backend
.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.venv\Scripts\python.exe -m pytest
```

The database tests log in like the backend (`.env` / `config.py`) but always use a separate database, **`greenova_test`**, which they create and empty before each test. `greenova_db` is never touched. Without a reachable MySQL server those tests are *skipped*, not failed.

What was checked:

- **97 tests pass** (the 76 existing, 20 new for MySQL, 1 for `.env`) on **MariaDB 10.11** and on a **MySQL 8.0-compatible server** (Dolt, reporting 8.0.31). That server was loaded with your `greenova_db.sql` exactly as exported, and the backend added the 5 settings columns.
- `schema.sql` loads on both, and its 6 batch tables match your export line for line.
- Your `greenova.db` (3 batches) was copied with no differences.
- With the same batches, the old SQLite backend and the new MySQL backend give the **same answers** on every read endpoint: batches, details, next ID, analytics, cost per liter (within ₱0.0001), settings and config.

It was not run on Oracle MySQL 8.0.46 itself. Run `python -m app.db` and `python -m pytest` on your laptop once to confirm.

Two existing tests time the simulated machine and sometimes fail on a busy computer: `test_purification_full_sequence` (`assert 93.6 < 93`) and `test_pump_stops_at_the_dose_weight`. They don't use the database, and they fail just as often on the original code (the pump test failed 5 times in 30 runs there). Run them again and they pass.

---

## 8. Troubleshooting

| Message | Cause and fix |
|---|---|
| `Can't connect to MySQL at localhost:3306` | The MySQL80 service is stopped (start it in Services), or `DB_HOST`/`DB_PORT` is wrong. Pi → laptop: laptop address, firewall rule (part 3, option B) |
| `MySQL refused the login of user 'root'` | Wrong `DB_PASSWORD` in `backend/.env` (use the HeidiSQL password), or a typo in `DB_USER` |
| `… may not create it` / `… may not use the database` | `DB_USER` isn't root and lacks rights: use root, or run the GRANT lines of part 2 |
| `MySQL 8 needs the 'cryptography' package` / `No module named 'pymysql'` | `.venv\Scripts\python.exe -m pip install -r requirements.txt` (or run `start-backend.bat`) |
| `ERROR 1273 Unknown collation: 'utf8mb4_0900_ai_ci'` | You loaded the HeidiSQL export into MariaDB (Pi): load `backend/schema.sql` instead, or let the backend create the tables |
| `The MySQL tables are missing columns the backend needs` | A table differs from `schema.sql` (renamed or missing column). Compare in HeidiSQL, or drop the empty table and let the backend create it again |
| `The settings row in MySQL … has a value the backend can't use` | A value typed in HeidiSQL is out of range (e.g. `methanolRemovalTime = 40`). Fix it, or delete the row: the defaults come back |
| A batch is missing from Batch History | A value typed by hand can't be read. The backend log says `Batch … can't be read and is left out` with the reason |
| The password in `.env` seems ignored | The file must be `backend\.env` exactly (Windows may save `.env.txt`: in Notepad choose "All files"). A `DB_PASSWORD` set in the Command Prompt window wins over the file |
| The website says *Local demo* | The backend didn't start: read its window (or `journalctl -u greenova -f` on the Pi) |
| `Lock wait timeout exceeded` | A HeidiSQL tab holds an open transaction on the same rows: commit or close it |

---

## 9. Useful queries and backups

```sql
-- Batch History with each batch's lab result (one row per batch)
SELECT b.batch_id, b.production_date, b.batch_status, b.yield_percent,
       (SELECT l.result_status FROM batch_lab_results l WHERE l.batch_id = b.batch_id) AS lab_result
FROM production_batches b
ORDER BY b.production_date DESC, b.batch_id DESC;

-- Materials of one batch
SELECT material_name, quantity, unit FROM batch_materials WHERE batch_id = 'B-2026-001';

-- Timeline of one batch, in order
SELECT event_sequence, event_time, event_label FROM batch_timeline
WHERE batch_id = 'B-2026-001' ORDER BY event_sequence;

-- Average yield per catalyst and adsorbent (completed batches)
SELECT catalyst_type, adsorbent, COUNT(*) AS batches, ROUND(AVG(yield_percent), 1) AS avg_yield
FROM production_batches WHERE batch_status = 'Completed' GROUP BY catalyst_type, adsorbent;
```

**Backup.** HeidiSQL: right-click `greenova_db` → *Export database as SQL*, with Table(s) **Create** and Data **Insert**. Or from Command Prompt:

```bat
"C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqldump.exe" -u root -p greenova_db > greenova_backup.sql
```

On the Pi: `sudo mariadb-dump greenova_db > greenova_backup.sql`. Restore with `mysql -u root -p greenova_db < greenova_backup.sql`.
