#!/usr/bin/env bash
# One-time setup of the Greenova backend on a Raspberry Pi (Raspberry Pi OS Bookworm, Pi 4 or Pi 5).
# Run it from the backend folder, as your normal user (not root):
#
#     cd ~/Greenova-UCO-to-Biodiesel-/backend
#     bash setup-pi.sh
#
# It installs the system packages, turns on I2C and 1-Wire, creates .venv, copies
# hardware.example.toml to hardware.toml (if you don't have one yet) and installs the
# "greenova" service. It does NOT start the machine: edit hardware.toml and run the checks first.
# Guide: docs/RASPBERRY_PI_SETUP.md
#
# The batches and settings live in a MySQL database (database.md):
#     bash setup-pi.sh --with-mariadb    also installs MariaDB (MySQL) on the Pi, creates the
#                                        greenova_db database, its tables and the "greenova" user,
#                                        and writes backend/.env with a new random password
#     bash setup-pi.sh                   the database is elsewhere (e.g. MySQL on the laptop):
#                                        put its address and password in backend/.env afterwards
set -euo pipefail

cd "$(dirname "$0")"
BACKEND="$(pwd)"
RUN_AS="$(id -un)"
WITH_MARIADB=0
if [ "${1:-}" = "--with-mariadb" ]; then
  WITH_MARIADB=1
fi

if [ "$RUN_AS" = "root" ]; then
  echo "Run this as your normal user (e.g. pi), not with sudo. It asks for sudo itself." >&2
  exit 1
fi

echo "==> System packages"
sudo apt update
sudo apt install -y python3-venv python3-pip python3-gpiozero python3-lgpio i2c-tools

echo "==> I2C (power monitor, strip reader) and 1-Wire (DS18B20 temperature probe)"
if command -v raspi-config >/dev/null; then
  sudo raspi-config nonint do_i2c 0 || true
  sudo raspi-config nonint do_onewire 0 || true
fi

echo "==> GPIO and serial access for $RUN_AS"
sudo usermod -aG gpio,i2c,dialout "$RUN_AS" || true

echo "==> Python environment (.venv, using the Pi's GPIO libraries)"
python3 -m venv --system-site-packages .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt -r requirements-pi.txt

if [ ! -f hardware.toml ]; then
  cp hardware.example.toml hardware.toml
  echo "==> Created hardware.toml from hardware.example.toml: edit it to match your wiring."
fi

if [ "$WITH_MARIADB" = 1 ]; then
  echo "==> MariaDB (the MySQL database, on this Pi)"
  sudo apt install -y mariadb-server
  sudo systemctl enable --now mariadb
  if [ ! -f .env ]; then
    DB_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')"
    sudo mariadb <<SQL
CREATE DATABASE IF NOT EXISTS greenova_db DEFAULT CHARACTER SET utf8mb4;
CREATE USER IF NOT EXISTS 'greenova'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
ALTER USER 'greenova'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
GRANT ALL PRIVILEGES ON greenova_db.* TO 'greenova'@'localhost';
FLUSH PRIVILEGES;
SQL
    sed -e "s/^DB_USER=.*/DB_USER=greenova/" -e "s/^DB_PASSWORD=.*/DB_PASSWORD=$DB_PASSWORD/" .env.example > .env
    chmod 600 .env
    echo "==> Created the greenova_db database and user; the password is in .env."
  fi
  sudo mariadb < schema.sql
  echo "==> Tables of schema.sql are in greenova_db."
fi

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  echo "==> Created .env from .env.example: enter your MySQL address (DB_HOST), user and password."
fi

echo "==> Service (starts the backend when the Pi boots)"
sed -e "s#__USER__#$RUN_AS#g" -e "s#__BACKEND__#$BACKEND#g" greenova.service \
  | sudo tee /etc/systemd/system/greenova.service >/dev/null
sudo systemctl daemon-reload

cat <<EOF

Done. Next steps (reboot first if I2C or 1-Wire was just turned on):

  0. Check the database:    .venv/bin/python -m app.db      (MySQL login: nano $BACKEND/.env)
  1. Edit the wiring:       nano $BACKEND/hardware.toml
  2. Check it:              .venv/bin/python -m app.hwtest check
  3. Read the sensors:      .venv/bin/python -m app.hwtest read
  4. Click each output:     .venv/bin/python -m app.hwtest outputs    (heater and supply unplugged!)
  5. Calibrate load cells:  .venv/bin/python -m app.hwtest calibrate reactor   (and: output)
  6. Start the service:     sudo systemctl enable --now greenova
                            journalctl -u greenova -f
  7. Open the website:      http://$(hostname -I 2>/dev/null | awk '{print $1}'):8000

EOF
