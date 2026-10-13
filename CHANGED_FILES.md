# Greenova update: MySQL database

The backend now stores the batches and settings in **MySQL** (database `greenova_db`, the 7 tables of `greenova_db.sql`) instead of `backend/greenova.db` (SQLite). The website gets exactly the same data from the API, so nothing changed on the website. Full guide: **`database.md`** (project folder).

## Setup (laptop)

1. MySQL80 service running (the MySQL you use with HeidiSQL).
2. Double-click `backend/start-backend.bat`. The first time it opens `backend/.env` in Notepad: type your MySQL password after `DB_PASSWORD=`, save, close. (Or type it in `backend/app/config.py`.)
3. Done. The backend installs the packages, creates `greenova_db` and its tables by itself, and starts. Website: `npm install` once, then `npm run dev` in `frontend`, as before.

Optional, once: `python -m app.migrate_sqlite` (in `backend`) copies the batches of the old `greenova.db` into MySQL.

## What changed

1. **MySQL instead of SQLite**, with the tables, keys and relationships of `greenova_db.sql`.
2. **The MySQL login is in `backend/.env`** (template `.env.example`) or in `backend/app/config.py`: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`. `python -m app.db` checks it and says what is wrong if it can't connect.
3. **The backend prepares the database by itself**: it creates the database and any missing table (`backend/schema.sql`), adds the 5 newer settings columns that the HeidiSQL export doesn't have (`magnesolDose`, `bentoniteDose`, `defaultAdsorbent`, `autoAdvance`, `magnesolPrice`), and saves the default settings row.
4. **Lab results keep their history** (`batch_lab_results`: Pending → Passed with the time it was recorded); the newest one is the batch's lab result.
5. **Raspberry Pi:** `bash setup-pi.sh --with-mariadb` installs MariaDB (MySQL) on the Pi and sets up the database, a user and `.env`; the service starts after the database.

## Files

New: `database.md`, `backend/.env.example`, `backend/schema.sql`, `backend/app/migrate_sqlite.py`, `backend/tests/test_mysql.py`

Changed:

- Backend: `backend/app/db.py` (rewritten for MySQL), `backend/app/config.py`, `backend/app/models.py`, `backend/app/main.py`, `backend/main.py`, `backend/requirements.txt`, `backend/start-backend.bat`, `backend/setup-pi.sh`, `backend/greenova.service`, `backend/.gitignore`
- Tests: `backend/conftest.py`, `backend/tests/test_api.py`, `backend/tests/test_core.py` (97 tests; two timing tests of the simulated machine fail now and then, as before)
- Docs: `README.md`, `backend/README.md`, `backend/API.md`, `docs/WEBSITE_GUIDE.md`, `docs/RASPBERRY_PI_SETUP.md`, `WEBSITE_GUIDE.md`, `RASPBERRY_PI_SETUP.md`
