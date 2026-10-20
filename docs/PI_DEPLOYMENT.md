# Greenova Raspberry Pi deployment checklist

This guide deploys the **website and backend in simulation mode** on a Raspberry Pi. It is intended for Raspberry Pi 4/5 running Raspberry Pi OS Bookworm (64-bit). The browser-facing site does not need internet once installed; internet is usually needed during package installation.

> **Hardware safety:** the systemd service intentionally uses `GREENOVA_MOCK=1`. This is a safe demonstration: values and process transitions are simulated and physical outputs are not operated. The supplied ESP32/Pi wiring still has unresolved mappings and the hybrid serial driver/interlocks are incomplete. Do not change this to hardware mode for a real production run until the wiring and safety checks in `RASPBERRY_PI_SETUP.md` have been completed and bench-tested.

## 1. Build the website on your development computer

Install Node.js 22 on your Windows/macOS/Linux development computer. From the project folder:

```bash
cd frontend
npm ci
npm run build
```

Confirm that `frontend/dist/index.html` exists. The Pi does not need Node.js to serve this built website.

## 2. Copy the project to the Pi

Copy the complete project folder to the Pi, including `frontend/dist`. You can use a USB drive, `scp`, or Git. If you use `scp`, run it from your development computer and replace the username and Pi address:

```bash
scp -r Greenova-UCO-to-Biodiesel <pi-user>@<pi-address>:~/Greenova-UCO-to-Biodiesel
```

If you are copying an extracted folder with a different name, use that actual folder name in the command. Do not copy your Windows `backend/.venv` folder; the setup script creates a Linux virtual environment on the Pi.

## 3. Install the backend on the Pi

Open a terminal on the Pi (SSH or local keyboard) and run:

```bash
cd ~/Greenova-UCO-to-Biodiesel/backend
bash setup-pi.sh
sudo reboot
```

The script installs the backend's Python dependencies, creates `hardware.toml` from its template and `backend/.env` from `.env.example`, and installs a systemd service. It does not install a database server.

The database is **MySQL 8** (not MariaDB): `backend/greenova_db_ver2.sql`, imported once as it is on the computer that runs MySQL 8 (see `../database.md`). That file creates `greenova_db` and the user `greenova@localhost` (no password), which is the backend's default login, so it works as is when MySQL 8 runs on the same computer as the backend. If MySQL runs on another computer, `greenova@localhost` can't log in from the Pi: put that computer's address in `DB_HOST` in `backend/.env`, with a MySQL account that may connect from the Pi in `DB_USER` / `DB_PASSWORD`. Keep MySQL port 3306 private; client devices should only access the website/API on port 8000.

## 4. Verify the site and database

After reboot, from the Pi:

```bash
cd ~/Greenova-UCO-to-Biodiesel/backend
sudo systemctl enable --now greenova
.venv/bin/python -m app.db
sudo systemctl status greenova --no-pager
curl -I http://127.0.0.1:8000
journalctl -u greenova -n 80 --no-pager
```

The database check should report `Connected` and `OK`; the HTTP check should return a successful response. If the service fails, inspect the journal for the exact missing table, column, or connection error.

## 5. Open it from another device

Find the Pi's IP address:

```bash
hostname -I
```

On a phone, tablet, or laptop connected to the same trusted Wi-Fi/LAN, open:

`http://<pi-address>:8000`

Avahi/mDNS is enabled by the setup script. `http://<hostname>.local:8000` may work on the local network; `http://greenova.local:8000` works only if the Pi's hostname is `greenova`. Some managed/public Wi-Fi networks isolate clients from each other; use a trusted router or hotspot if other devices cannot reach the Pi.

For an optional directly-attached HDMI touchscreen kiosk, run `bash setup-pi.sh --kiosk` during setup (or install/configure the kiosk separately). The kiosk option opens Chromium at `http://localhost:8000` after the graphical desktop starts.

## 6. Updating the website later

On the development computer, after editing the frontend:

```bash
cd frontend
npm ci
npm run build
```

Copy the resulting `frontend/dist` folder to the same project path on the Pi, then restart the service:

```bash
sudo systemctl restart greenova
```

Backend code changes also need to be copied to the Pi. If Python dependencies change, reinstall them in the Pi's `.venv` using the appropriate requirements files.

## 7. Back up data and keep credentials private

Back up the database before changing schemas or importing data. In HeidiSQL: *Tools > Export database as SQL*; or on the MySQL computer:

```bash
mysqldump -u root -p greenova_db > greenova_db-backup.sql
```

Keep `backend/.env` private (it may contain a database password); never commit it or put it in the frontend. Do not expose port 3306 to Wi-Fi clients or the public internet. For access outside the trusted LAN, use a VPN and a properly secured HTTPS deployment rather than exposing this service directly.
