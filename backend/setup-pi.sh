#!/usr/bin/env bash
# One-time setup of the Greenova backend on a Raspberry Pi (Raspberry Pi OS Bookworm, Pi 4 or Pi 5).
# Run it from the backend folder, as your normal user (not root):
#
#     cd ~/Greenova-UCO-to-Biodiesel-/backend
#     bash setup-pi.sh
#
# It installs packages, creates .venv, copies the hardware template if needed, and installs
# the "greenova" service. By default the service runs in SIMULATED DEMO mode (no physical outputs).
#     bash setup-pi.sh --hardware        HARDWARE mode: the website drives the real machine (the ESP32
#                                        controller on USB + the Pi's centrifuge and load cell). Also
#                                        stops the old Pi control panel (pi-control), which would
#                                        take the ESP32's serial port and the GPIO pins.
# Guide: docs/RASPBERRY_PI_SETUP.md
#
# The batches and settings live in the project's MySQL 8 database (not MariaDB). It is created
# once by importing backend/greenova_db_ver2.sql as it is, on the computer running MySQL 8; that
# file also creates the MySQL user greenova@localhost (no password) the backend logs in with.
# This script does not install a database server.
#     bash setup-pi.sh --kiosk           optionally launch Chromium full-screen on the touchscreen at boot
set -euo pipefail

cd "$(dirname "$0")"
BACKEND="$(pwd)"
RUN_AS="$(id -un)"
KIOSK=0
MOCK=1
for arg in "$@"; do
  case "$arg" in
    --kiosk) KIOSK=1 ;;
    --hardware) MOCK=0 ;;
    --demo) MOCK=1 ;;
    --with-mariadb) echo "--with-mariadb was removed: Greenova uses MySQL 8 (import greenova_db_ver2.sql)." >&2; exit 2 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ "$RUN_AS" = "root" ]; then
  echo "Run this as your normal user (e.g. pi), not with sudo. It asks for sudo itself." >&2
  exit 1
fi

# The backend also serves the production-built React website. Build it on the development
# computer with Node.js 22, then copy frontend/dist to the Pi with the rest of the project.
# We deliberately do not install a separate Node toolchain on the Pi just to serve static files.
if [ ! -f "$BACKEND/../frontend/dist/index.html" ] && [ ! -f "$BACKEND/frontend/dist/index.html" ]; then
  cat >&2 <<'EOF'
The built Greenova website was not found (frontend/dist/index.html).

Before running this installer, build the website on a computer with Node.js 22:
  cd frontend
  npm ci
  npm run build

Then copy the complete project, including frontend/dist, to the Raspberry Pi and run this script again.
See docs/PI_DEPLOYMENT.md for the full steps.
EOF
  exit 1
fi

echo "==> System packages"
sudo apt update
sudo apt install -y python3-venv python3-pip python3-gpiozero python3-lgpio python3-serial i2c-tools avahi-daemon

echo "==> I2C (optional power monitor) and 1-Wire (DS18B20 temperature probe, older gpio wiring)"
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

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  cat <<'EOF'
==> Created .env from .env.example. Its defaults are MySQL 8 on this Pi with the greenova_db
    database and the user greenova@localhost from greenova_db_ver2.sql. If MySQL runs on another
    computer, put that computer's address in DB_HOST and a MySQL account that may log in from this
    Pi in DB_USER / DB_PASSWORD (greenova@localhost only accepts logins from MySQL's own computer).
EOF
fi

if [ "$MOCK" = 0 ]; then
  echo "==> Hardware mode: stopping the old Pi control panel (it would take the ESP32's port and the GPIO pins)"
  if systemctl list-unit-files pi-control.service 2>/dev/null | grep -q pi-control; then
    sudo systemctl disable --now pi-control || true
    echo "    pi-control service stopped and disabled."
  fi
  if [ -f "$HOME/.config/autostart/pi-control.desktop" ]; then
    mv "$HOME/.config/autostart/pi-control.desktop" "$HOME/.config/autostart/pi-control.desktop.disabled"
    echo "    pi-control desktop autostart disabled (renamed to pi-control.desktop.disabled)."
  fi
  pkill -f "pi_control/app.py" 2>/dev/null || true
fi

echo "==> Service (starts the backend when the Pi boots, $([ "$MOCK" = 0 ] && echo HARDWARE || echo DEMO) mode)"
sed -e "s#__USER__#$RUN_AS#g" -e "s#__BACKEND__#$BACKEND#g" -e "s#GREENOVA_MOCK=1#GREENOVA_MOCK=$MOCK#" greenova.service \
  | sudo tee /etc/systemd/system/greenova.service >/dev/null
sudo systemctl daemon-reload

if [ "$KIOSK" = 1 ]; then
  echo "==> Chromium touchscreen kiosk"
  sudo apt install -y chromium
  mkdir -p "$HOME/.config/autostart"
  cat > "$HOME/.config/autostart/greenova-kiosk.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Greenova Kiosk
Exec=chromium --kiosk --noerrdialogs --disable-infobars --check-for-update-interval=31536000 http://localhost:8000
X-GNOME-Autostart-enabled=true
DESKTOP
  chmod 644 "$HOME/.config/autostart/greenova-kiosk.desktop"
fi
sudo systemctl enable --now avahi-daemon || true

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [ "$MOCK" = 0 ]; then
cat <<EOF

Done: HARDWARE mode. Next steps (reboot first: the dialout/gpio groups and I2C need it):

  0. Check the database:    .venv/bin/python -m app.db      (MySQL login: nano $BACKEND/.env)
  1. Check the wiring file: .venv/bin/python -m app.hwtest check
                            Edit [esp32.devices] in $BACKEND/hardware.toml so each Greenova job
                            (heater, pumps A/B, the three outlets, the mixers) names the right ESP32 output.
  2. Upload firmware/esp32_process_control/esp32_process_control.ino to the ESP32 and plug it into the Pi.
                            .venv/bin/python -m app.hwtest esp32        (should show its outputs and temperature)
  3. Bench test (heater and electrode supply UNPLUGGED, centrifuge rotor out):
                            .venv/bin/python -m app.hwtest outputs
  4. Start the backend:     sudo systemctl enable --now greenova
                            journalctl -u greenova -f
  5. Open on the Pi:        http://localhost:8000      over Wi-Fi: http://$IP:8000  (or http://greenova.local:8000)
     Settings -> Hardware: check the ESP32 is online, then Tare and Calibrate the output load cell.

Back to demo mode at any time: bash setup-pi.sh --demo && sudo systemctl restart greenova

EOF
else
cat <<EOF

Done: DEMO mode. Next steps (reboot first if I2C or 1-Wire was just turned on):

  0. Check the database:    .venv/bin/python -m app.db      (MySQL login: nano $BACKEND/.env)
  1. Start the live demo:   sudo systemctl enable --now greenova
                            journalctl -u greenova -f
  2. Open on the Pi:        http://localhost:8000
  3. Open over Wi-Fi:       http://$IP:8000   or http://greenova.local:8000

The process is simulated: the real pumps, valves, heater, electrodes and motors are not switched.
To drive the real machine (ESP32 controller + the Pi's centrifuge and load cell):
                            bash setup-pi.sh --hardware && sudo systemctl restart greenova

EOF
fi
