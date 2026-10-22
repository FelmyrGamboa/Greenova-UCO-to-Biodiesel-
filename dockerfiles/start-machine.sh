#!/usr/bin/env bash
# Greenova in Docker on the Raspberry Pi wired to the machine: one command that
#   1. stops the programs that would take the ESP32's USB port or the GPIO pins (the old Pi control
#      panel, a native Greenova service, a serial monitor),
#   2. checks that the ESP32 and the GPIO chip are there,
#   3. builds and starts MySQL, the backend and the website,
#   4. asks the backend what works: ESP32, temperature, centrifuge, output load cell,
#   and the website opens by itself in the Pi's browser (open-website.sh, installed here once: from
#   then on every "docker compose up" and every boot opens it too).
#
#     cd ~/Desktop/Greenova-UCO-to-Biodiesel-/dockerfiles
#     bash start-machine.sh                  start / restart and check
#     bash start-machine.sh --check          only the check (Greenova already running)
#     bash start-machine.sh --test-outputs   switch each output for 2 s, one by one (bench test)
#     bash start-machine.sh --test-mixers    find the lowest PWM where mixer 1 and mixer 2 turn
set -uo pipefail
cd "$(dirname "$0")"
HERE="$(pwd)"
BACKEND="$(cd "$HERE/../backend" && pwd)"
DATA="$BACKEND/data"
API="http://127.0.0.1:${BACKEND_PORT:-8000}"
MODE="${1:-start}"

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m!!  %s\033[0m\n' "$*"; }

command -v docker >/dev/null || { echo "Docker is not installed on this Pi."; exit 1; }

check_hardware() {
  step "Hardware check (what the backend sees)"
  local hw live
  hw="$(curl -fsS "$API/api/hardware")" && live="$(curl -fsS "$API/api/live")" || {
    warn "The backend doesn't answer on $API. Its log:"; docker compose logs --tail 60 backend; return 1; }
  HW="$hw" LIVE="$live" python3 - <<'EOF'
import json, os
hw, live = json.loads(os.environ["HW"]), json.loads(os.environ["LIVE"])
s = live.get("sensors", {})
problems = []

def line(ok, text, fix=""):
    print(("  OK    " if ok else "  FIX   ") + text)
    if not ok:
        problems.append(text)
        if fix:
            print("        -> " + fix)

c = hw.get("controller") or {}
online = bool(c.get("online"))
line(online and not hw.get("fault"),
     "ESP32 controller: " + (f"online on {c.get('port')}" if online else f"OFFLINE ({c.get('error')})")
     + (f" but {hw['fault']}" if online and hw.get("fault") else ""),
     "Check the USB cable (a charge-only cable shows no port), that the sketch is uploaded, and that "
     "nothing else has the port open. Mixers, pumps, the electrode relay and the heater all go through it.")
if online:
    print("        ESP32 devices: " + ", ".join(d.get("id", "?") for d in c.get("devices", [])))
    print("        Greenova job -> ESP32 output:")
    for r in hw.get("roles", []):
        print(f"          {r.get('label', r.get('role')):<40} {' + '.join(r.get('devices') or []) or 'not fitted'}")
t = s.get("temperature")
line(t is not None, f"Temperature: {t} °C" if t is not None else "Temperature: NO READING",
     "DS18B20 data on the ESP32's GPIO4 with a 4.7 kΩ pull-up to 3.3 V. Purification can't start without it.")
cf = hw.get("centrifuge")
line(cf is not None and not cf.get("error"),
     "Centrifuge (Pi GPIO 23/24/25/21, BTS7960): " + ("not enabled" if cf is None else
                                                     f"NOT WORKING ({cf['error']})" if cf.get("error") else
                                                     f"ready, up to {cf.get('maxRpm'):g} RPM"),
     "Check the BTS7960 wiring, its motor supply, and GND shared with the Pi.")
for cell in hw.get("loadCells", []):
    if not cell.get("enabled"):
        continue
    g = cell.get("grams")
    line(g is not None, f"{cell.get('label')} (HX711 DT {cell.get('dataPin')} / SCK {cell.get('clockPin')}): "
         + (f"{g} g" if g is not None else "NO READING"),
         "HX711 VCC to 3.3 V, GND, DT to GPIO17, SCK to GPIO27. Purification can't start without it.")
print()
if problems:
    print(f"{len(problems)} part(s) to fix (FIX above). Live log: docker compose logs -f backend")
else:
    print("Everything the process needs answers. Next: Settings -> Hardware -> Output load cell -> Tare and")
    print("Calibrate with a known weight, then start a batch. Bench test: bash start-machine.sh --test-outputs")
EOF
}

if [ "$MODE" = "--check" ]; then
  check_hardware; exit $?
fi

if [ "$MODE" = "--test-mixers" ]; then
  step "Mixer test: the lowest PWM where each mixer turns (the backend is stopped meanwhile)"
  docker compose stop backend frontend
  for role in stirrer purification_stirrer; do
    docker compose run --rm --no-deps backend python -m app.hwtest mixer "$role"
  done
  echo "Set the higher MIN_PWM it printed in the ESP32 sketch (#define MIN_PWM) and upload the sketch again."
  docker compose up -d
  exit 0
fi

if [ "$MODE" = "--test-outputs" ]; then
  step "Bench test: each output on for 2 s (the backend is stopped meanwhile)"
  docker compose stop backend frontend
  docker compose run --rm --no-deps backend python -m app.hwtest outputs
  docker compose up -d
  exit 0
fi

# MySQL's first start imports every .sql in mysql-init: the dump must be there (an unchanged copy)
if [ -d "$HERE/mysql-init" ] && [ -f "$BACKEND/greenova_db_ver2.sql" ] \
   && ! cmp -s "$BACKEND/greenova_db_ver2.sql" "$HERE/mysql-init/greenova_db_ver2.sql"; then
  cp "$BACKEND/greenova_db_ver2.sql" "$HERE/mysql-init/greenova_db_ver2.sql" \
    && echo "Copied backend/greenova_db_ver2.sql (unchanged) into mysql-init."
fi
for f in frontend.Dockerfile mysql-init; do
  [ -e "$HERE/$f" ] || warn "$f is missing next to docker-compose.yaml (it comes with the project zip)."
done

step "1. Stopping programs that use the ESP32's USB port or the GPIO pins"
docker compose stop backend >/dev/null 2>&1 || true        # the old backend container holds them too
for unit in pi-control greenova; do
  if systemctl list-unit-files "$unit.service" 2>/dev/null | grep -q "^$unit.service"; then
    sudo systemctl disable --now "$unit" >/dev/null 2>&1 && echo "Stopped and disabled the $unit service."
  fi
done
for f in "$HOME/.config/autostart/pi-control.desktop" /etc/xdg/autostart/pi-control.desktop; do
  if [ -e "$f" ]; then sudo rm -f "$f" && echo "Removed the autostart entry $f."; fi
done
for pid in $(pgrep -f "app\.py" 2>/dev/null); do
  cwd="$(sudo readlink "/proc/$pid/cwd" 2>/dev/null)"
  cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)"
  case "$cwd $cmd" in
    *pi_control*) sudo kill "$pid" && echo "Stopped the old Pi control panel ($cmd).";;
  esac
done
sleep 1
for port in /dev/ttyUSB* /dev/ttyACM*; do
  [ -e "$port" ] || continue
  if command -v fuser >/dev/null; then
    users="$(sudo fuser "$port" 2>/dev/null | xargs)"
    [ -n "$users" ] && warn "$port is still open in: $(ps -o pid=,args= -p "${users// /,}" 2>/dev/null | xargs). Close it."
  fi
done

step "2. The ESP32 and the Pi's GPIO chip"
ports="$(ls /dev/serial/by-id/* /dev/ttyUSB* /dev/ttyACM* 2>/dev/null)"
if [ -n "$ports" ]; then echo "$ports"; else
  warn "No USB serial port: the ESP32 isn't connected. Check the cable (charge-only cables have no data) and the USB port."
fi
if command -v gpiodetect >/dev/null; then gpiodetect; else ls /dev/gpiochip* 2>/dev/null || warn "No /dev/gpiochip*: is this the Raspberry Pi?"; fi

step "3. Settings folder (backend/data)"
mkdir -p "$DATA"
for name in hardware.toml loadcell_calibration.json; do
  src="$BACKEND/$name"
  if [ -d "$src" ]; then                       # made by Docker when a mounted file didn't exist
    if [ -f "$src/$name" ] && [ ! -e "$DATA/$name" ]; then sudo cp "$src/$name" "$DATA/$name"; fi
    sudo rm -f "$src/$name" "$src/$name.tmp"; sudo rmdir "$src" 2>/dev/null && echo "Removed the empty folder $src (made by Docker)."
  elif [ "$name" = "loadcell_calibration.json" ] && [ -f "$src" ] && [ ! -e "$DATA/$name" ]; then
    cp "$src" "$DATA/$name" && echo "Kept your load cell calibration ($DATA/$name)."
  fi
done
sudo chown -R "$(id -u):$(id -g)" "$DATA" 2>/dev/null || true
if [ -f "$DATA/hardware.toml" ]; then echo "Using $DATA/hardware.toml."; else
  echo "No hardware.toml in $DATA: the built-in pins are used (they match the supplied wiring and ESP32 sketch)."
fi

step "The website on the Pi's screen"
# Installs the desktop helper that opens http://localhost:8443 each time the website comes up
# (here, every later "docker compose up", every boot). A container can't open the Pi's browser itself.
bash "$HERE/open-website.sh" --install || true

step "4. Building and starting MySQL, the backend and the website"
docker compose up -d --build --remove-orphans || { warn "Build or start failed (see above)."; exit 1; }
printf 'Waiting for the backend'
for _ in $(seq 1 90); do
  curl -fsS "$API/api/health" >/dev/null 2>&1 && break
  printf '.'; sleep 2
done
echo
if ! curl -fsS "$API/api/health" >/dev/null 2>&1; then
  warn "The backend didn't start. Its log:"; docker compose logs --tail 80 backend; exit 1
fi
echo "Backend running. Giving the ESP32 10 s (it restarts when the port opens)..."
sleep 10
check_hardware
ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "Website: http://${ip:-<pi-address>}:${FRONTEND_PORT:-8443} (it opens by itself in the Pi's browser)"
