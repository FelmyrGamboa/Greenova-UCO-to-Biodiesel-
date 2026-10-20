# Greenova database (MySQL 8)

Greenova stores its batches and settings in **MySQL 8 Community Server** (not MariaDB). The database is the HeidiSQL export `backend/greenova_db_ver2.sql`, used **as it is**: the backend never creates, alters or re-seeds tables, and never rewrites the saved settings.

## One-time setup

1. Install MySQL 8 Community Server and HeidiSQL on the computer that will run the backend (Windows: MySQL Installer, service `MySQL80`).
2. In HeidiSQL, log in as `root`, then **File > Run SQL file…** and choose `backend/greenova_db_ver2.sql`. From the command line instead:

   ```bash
   mysql -u root -p < backend/greenova_db_ver2.sql
   ```

   It creates:
   - the database `greenova_db` with its 8 tables (`production_batches`, `batch_purification`, `batch_materials`, `esterification_stages`, `batch_timeline`, `batch_lab_results`, `batch_progress`, `settings`) and their data (batches B-2026-001 … B-2026-009 and the settings row);
   - the MySQL user **`greenova@localhost` with no password** and all privileges. This is the login the backend uses.

   Import it **once**. Running it again on the same server stops at `CREATE USER 'greenova'@'localhost'` (the user already exists).

3. Check the connection from the `backend` folder:

   ```bash
   python -m app.db
   ```

   It prints the server version and the number of rows in each table, and ends with `OK: the backend can use this database.`

## The backend's login

The defaults in `backend/app/config.py` match the SQL file, so no `.env` is needed when MySQL runs on the same computer as the backend:

| Setting | Default |
|---|---|
| `DB_HOST` | `localhost` |
| `DB_PORT` | `3306` |
| `DB_NAME` | `greenova_db` |
| `DB_USER` | `greenova` |
| `DB_PASSWORD` | *(empty)* |

To use something else, copy `backend/.env.example` to `backend/.env` and change the values there (an environment variable set by the system wins over `.env`).

`greenova@localhost` only accepts logins from MySQL's own computer. If the backend runs on another computer (for example the Raspberry Pi with MySQL on a laptop), create a MySQL account for that computer's address yourself and put it in that computer's `backend/.env`.

## What the backend checks at startup

At startup (and with `python -m app.db`) the backend reads the `CREATE TABLE` statements of `greenova_db_ver2.sql` and checks that every table and column is in the database. It only reports what is missing; it changes nothing. The settings row (`id = 1`) must exist: the SQL file has it.

## Troubleshooting

| Message | What to do |
|---|---|
| `Can't connect to MySQL at localhost:3306` | Start the MySQL service (Windows: Services > MySQL80) and check `DB_HOST` / `DB_PORT`. |
| `MySQL refused the login of user 'greenova'` | Import `greenova_db_ver2.sql` (it creates the user), keep `DB_HOST=localhost`, and leave `DB_PASSWORD` empty. |
| `The database 'greenova_db' doesn't exist yet` | Import `greenova_db_ver2.sql`. |
| `The MySQL tables are missing columns …` | The database is older than `greenova_db_ver2.sql`: back it up, then import the SQL file into a fresh MySQL 8 server (or add the listed columns in HeidiSQL). |
| `Unknown collation: 'utf8mb4_0900_ai_ci'` while importing | The server is MariaDB, not MySQL 8. Install MySQL 8 Community Server and import the file there. |

## Tests

`python -m pytest` uses a separate database, `greenova_test`, built from the table definitions of `greenova_db_ver2.sql` (structure only). Your `greenova_db` is never touched. Without a reachable MySQL server those tests are skipped.
