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
set -euo pipefail

cd "$(dirname "$0")"
BACKEND="$(pwd)"
RUN_AS="$(id -un)"

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

echo "==> Service (starts the backend when the Pi boots)"
sed -e "s#__USER__#$RUN_AS#g" -e "s#__BACKEND__#$BACKEND#g" greenova.service \
  | sudo tee /etc/systemd/system/greenova.service >/dev/null
sudo systemctl daemon-reload

cat <<EOF

Done. Next steps (reboot first if I2C or 1-Wire was just turned on):

  1. Edit the wiring:       nano $BACKEND/hardware.toml
  2. Check it:              .venv/bin/python -m app.hwtest check
  3. Read the sensors:      .venv/bin/python -m app.hwtest read
  4. Click each output:     .venv/bin/python -m app.hwtest outputs    (heater and supply unplugged!)
  5. Calibrate load cells:  .venv/bin/python -m app.hwtest calibrate reactor   (and: output)
  6. Start the service:     sudo systemctl enable --now greenova
                            journalctl -u greenova -f
  7. Open the website:      http://$(hostname -I 2>/dev/null | awk '{print $1}'):8000

EOF
