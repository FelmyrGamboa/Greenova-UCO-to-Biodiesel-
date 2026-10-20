# Running Greenova with Docker

One command starts the whole system in three containers: the MySQL database, the backend
(FastAPI, Python) and the website (Vite, npm). You don't need Python, Node.js or MySQL
installed on the computer, only Docker.

| Container  | What it runs                                       | Open it at (on your computer)          |
|------------|----------------------------------------------------|----------------------------------------|
| `mysql`    | MySQL 8.4 with the `greenova_db` database           | `127.0.0.1:3307` (HeidiSQL, etc.)      |
| `backend`  | `backend/` + `requirements.txt`, uvicorn on 8000   | http://localhost:8000/docs (API docs)  |
| `frontend` | `frontend/` + `npm ci`, `npm run dev` on 8443      | http://localhost:8443 (the website)    |

They start in order. `backend` waits until MySQL accepts the `greenova` login, and `frontend`
waits until the backend answers `/api/health`.

## Files in this folder

| File                                | What it is for                                                       |
|-------------------------------------|----------------------------------------------------------------------|
| `docker-compose.yaml`               | The three containers, their ports, and the database login            |
| `backend.Dockerfile`                | Builds the backend image (Python 3.12, `pip install -r requirements.txt`) |
| `frontend.Dockerfile`               | Builds the website image (Node 22, `npm ci`)                          |
| `*.Dockerfile.dockerignore`         | Keeps `.venv`, `node_modules`, `backend/.env` etc. out of the images  |
| `mysql-init/01-greenova-user.sql`   | Creates the MySQL user `greenova` (no password) on the first start    |

---

## 1. Run it

1. Install **Docker Desktop** for Windows (it uses WSL 2) and start it. Wait until it says
   *Engine running*.
2. **Free the ports.** If `start-backend.bat` or `start-website.bat` is still running, close
   those windows (Ctrl+C). They use the same ports, 8000 and 8443. The Windows MySQL80
   service can keep running: Docker's MySQL uses port **3307**, not 3306.
3. Open a terminal **in the `dockerfiles` folder** and run:

   ```powershell
   cd dockerfiles
   docker compose up --build
   ```

   The first time takes a few minutes, while it downloads MySQL, Python and Node and installs
   the packages. Later starts take a few seconds.
4. When you see `VITE ... ready`, open **http://localhost:8443**.

### Everyday commands (run them in `dockerfiles`)

| Command                                   | What it does                                                         |
|-------------------------------------------|----------------------------------------------------------------------|
| `docker compose up --build`               | Start everything; Ctrl+C stops it                                     |
| `docker compose up --build -d`            | Start in the background (the terminal stays free)                     |
| `docker compose ps`                       | Is each container running / healthy?                                  |
| `docker compose logs -f backend`          | Watch the backend's messages (also `mysql`, `frontend`)               |
| `docker compose down`                     | Stop and remove the containers. **The database is kept.**            |
| `docker compose down -v`                  | Stop and **delete the database** (the next start begins empty)        |
| `docker compose up --build backend`       | Rebuild and restart only the backend after a code change              |

**After you edit the code**, run `docker compose up --build` again. The images hold a copy of
the code, so a change on disk doesn't reach a running container by itself.

---

## 2. How the backend connects to the database

### The login

| Setting  | Value          | Notes                                                       |
|----------|----------------|-------------------------------------------------------------|
| Host     | `mysql`        | The **service name** in `docker-compose.yaml`, not `localhost` |
| Port     | `3306`         | MySQL's port **inside** Docker's network                     |
| User     | `greenova`     | Created by `mysql-init/01-greenova-user.sql`                  |
| Password | *(none)*       | Empty                                                       |
| Database | `greenova_db`  | Created by the MySQL container (`MYSQL_DATABASE`)            |

These are set as environment variables on the `backend` service in `docker-compose.yaml`:

```yaml
  backend:
    environment:
      DB_HOST: mysql
      DB_PORT: "3306"
      DB_USER: greenova
      DB_PASSWORD: ""
      DB_NAME: greenova_db
```

`backend/app/config.py` reads `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` and `DB_NAME`
from the environment. A value from the environment wins over `backend/.env`. Your laptop's
`backend/.env` (with your HeidiSQL password) is also left out of the image on purpose.
**To change the database login for Docker, edit these lines, not `backend/.env`.**

### What happens on the first start

1. **MySQL** starts with an empty data volume (`mysql-data`). It creates the database
   `greenova_db`, then runs `mysql-init/01-greenova-user.sql`:

   ```sql
   CREATE USER IF NOT EXISTS 'greenova'@'%' IDENTIFIED BY '';
   GRANT ALL PRIVILEGES ON `greenova_db`.* TO 'greenova'@'%';
   ```

   `'%'` means "from any computer", which here means from the other containers.
   *Why a script instead of `MYSQL_USER: greenova`?* The MySQL image only creates
   `MYSQL_USER` when `MYSQL_PASSWORD` is also set. With no password it quietly skips the user.
2. **The backend** runs the same steps as `start-backend.bat`:
   - `python -m app.db` connects as `greenova@mysql:3306` and creates the 8 tables from
     `backend/schema.sql`, plus the default settings row;
   - `python -m app.seed` adds the 6 sample batches (only when there are no batches yet);
   - `uvicorn app.main:app` starts the API on port 8000.

   You'll see this in `docker compose logs backend`:

   ```
   MySQL: greenova@mysql:3306, database greenova_db
   Created table production_batches
   ...
   OK: the backend can use this database.
   Added 6 sample batches.
   ```

3. **The website** forwards every `/api/...` request to `http://backend:8000` (the
   `GREENOVA_API` variable, used by `frontend/vite.config.ts`). The browser only talks to
   port 8443, so no CORS setup is needed.

The data lives in the Docker volume `greenova_mysql-data`. It survives `docker compose down`
and restarts, and is deleted only by `docker compose down -v`.

> The init script runs **only when the data volume is empty**. If you edit
> `01-greenova-user.sql` later, run `docker compose down -v` (this erases the data) and
> start again.

### Opening the database in HeidiSQL (or MySQL Workbench)

Docker's MySQL is published on your computer at port **3307**:

| Field            | Value         |
|------------------|---------------|
| Network type     | MySQL (TCP/IP) |
| Hostname / IP    | `127.0.0.1`   |
| User             | `greenova`    |
| Password         | *(leave empty)* |
| Port             | `3307`        |
| Database         | `greenova_db` |

To log in as `root` instead, use the password `greenova_root`. You can change it with
`MYSQL_ROOT_PASSWORD` before the first start (see section 3).

Or from the command line, without HeidiSQL:

```powershell
docker compose exec mysql mysql -u greenova greenova_db
```

### Using Docker's MySQL with the backend outside Docker

To run the backend the usual way (`start-backend.bat` / `python main.py`) but keep the data
in Docker's MySQL, start only the database and point `backend/.env` at port 3307:

```powershell
docker compose up -d mysql
```

```ini
# backend/.env
DB_HOST=127.0.0.1
DB_PORT=3307
DB_USER=greenova
DB_PASSWORD=
DB_NAME=greenova_db
```

---

## 3. Settings you can change

Set these as environment variables before `docker compose up`, or put them in a file named
`.env` **in the `dockerfiles` folder** (Docker Compose reads it by itself).

| Variable              | Default          | What it does                                                    |
|-----------------------|------------------|-----------------------------------------------------------------|
| `FRONTEND_PORT`       | `8443`           | Website port on your computer                                   |
| `BACKEND_PORT`        | `8000`           | API port on your computer                                       |
| `MYSQL_PORT`          | `3307`           | MySQL port on your computer (HeidiSQL)                          |
| `MYSQL_ROOT_PASSWORD` | `greenova_root`  | MySQL root password (only on the first start, with an empty volume) |
| `GREENOVA_TIME_SCALE` | `1`              | Demo machine speed: `20` runs the simulated process 20× faster  |
| `GREENOVA_SEED`       | `1`              | `0` = don't add the 6 sample batches to an empty database        |
| `TZ`                  | `Asia/Manila`    | Clock of the backend and MySQL (batch dates and timeline times) |

Example, in PowerShell:

```powershell
$env:GREENOVA_TIME_SCALE = "20"; docker compose up --build
```

or in `dockerfiles/.env`:

```ini
GREENOVA_TIME_SCALE=20
FRONTEND_PORT=9443
```

---

## 4. Opening the website on a phone

Use your **laptop's** Wi-Fi address with port 8443, for example `http://192.168.1.23:8443`.
To find it, run `ipconfig` and look for *Wireless LAN adapter Wi-Fi → IPv4 Address*.

Ignore the `Network: http://172.x.x.x:8443` line and the QR code in the `frontend` logs. They
show the container's address inside Docker, which a phone can't reach. If the phone still can't
open the website, allow Docker Desktop through the Windows Firewall on private networks.

---

## 5. Troubleshooting

| Problem | What to do |
|---|---|
| `Bind for 0.0.0.0:8000 failed: port is already allocated` (or 8443 / 3307) | Something else uses that port. Close `start-backend.bat` / `start-website.bat`, or change `BACKEND_PORT` / `FRONTEND_PORT` / `MYSQL_PORT` (section 3). |
| `dependency failed to start: container greenova-mysql-1 is unhealthy` | `docker compose logs mysql`. If the volume was made with an older init script, run `docker compose down -v` and start again (erases the data). |
| Backend logs `Can't connect to MySQL` or `refused the login of user 'greenova'` | Check the `DB_*` lines of the `backend` service: host `mysql`, port `3306`, user `greenova`, empty password. `localhost` and `3307` only work **outside** Docker. |
| The website shows the demo data / "backend offline" | `docker compose ps`: is `backend` *healthy*? Then `docker compose logs backend`. |
| My code change doesn't show up | Run `docker compose up --build` (the images hold a copy of the code). |
| Start over with an empty database | `docker compose down -v`, then `docker compose up --build`. |
| `error during connect` / `docker: command not found` | Docker Desktop isn't running: start it and wait for *Engine running*. |

---

## Notes

- **Demo mode only.** The backend in Docker always runs with simulated hardware
  (`GREENOVA_MOCK=1`). The real machine runs on the Raspberry Pi: see
  [RASPBERRY_PI_SETUP.md](../docs/RASPBERRY_PI_SETUP.md).
- **No password is for a laptop only.** MySQL is published on `127.0.0.1` only, so other
  devices on the Wi-Fi can't log in as `greenova`. Before putting this on a shared network or
  server, give `greenova` a password: change the `IDENTIFIED BY ''` line in
  `mysql-init/01-greenova-user.sql` and `DB_PASSWORD` in `docker-compose.yaml`, then
  `docker compose down -v` and start again.
- The website runs on the Vite development server (`npm run dev`), the same as
  `start-website.bat`.
