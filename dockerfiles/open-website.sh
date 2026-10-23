#!/usr/bin/env bash
# Opens the Greenova website in the Raspberry Pi's browser by itself, as soon as it answers.
#
# A Docker container can't open a browser on the Pi's screen, so this small helper runs on the Pi's
# desktop instead and watches the website: every time it comes up (docker compose up, docker compose
# up --build, a restart, the Pi booting) it opens http://localhost:8443 in Chromium.
#
#   bash open-website.sh --install     once: start it with the desktop (autostart) and start it now.
#                                      From then on every "docker compose up" opens the website.
#                                      (start-machine.sh does this for you.)
#   bash open-website.sh --uninstall   stop it and remove it from the autostart
#   bash open-website.sh               wait until the website answers, open it once, then stop
#   bash open-website.sh --watch       what the autostart runs: keep watching
#
# Add --kiosk (with --install or --watch) for full screen without an address bar (touch screen;
# Alt+F4 closes it). Another address: GREENOVA_URL=http://localhost:8443 bash open-website.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SELF="$HERE/$(basename "$0")"
URL="${GREENOVA_URL:-http://localhost:${FRONTEND_PORT:-8443}}"
AUTOSTART="$HOME/.config/autostart/greenova-website.desktop"
MODE="once"
KIOSK="${GREENOVA_KIOSK:-0}"
for arg in "$@"; do
  case "$arg" in
    --install) MODE="install";;
    --uninstall) MODE="uninstall";;
    --watch) MODE="watch";;
    --kiosk) KIOSK=1;;
    -h|--help) sed -n '2,17p' "$0"; exit 0;;
    *) echo "Unknown option: $arg (see: bash open-website.sh --help)"; exit 1;;
  esac
done

# The Pi's desktop session, also when this is started from SSH or from start-machine.sh.
find_display() {
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  if [ -z "${WAYLAND_DISPLAY:-}" ]; then
    for socket in "$XDG_RUNTIME_DIR"/wayland-*; do
      case "$socket" in *.lock) continue;; esac
      [ -S "$socket" ] && { export WAYLAND_DISPLAY="$(basename "$socket")"; break; }
    done
  fi
  if [ -z "${DISPLAY:-}" ] && [ -S /tmp/.X11-unix/X0 ]; then export DISPLAY=:0; fi
  [ -n "${WAYLAND_DISPLAY:-}" ] || [ -n "${DISPLAY:-}" ]
}

website_up() {
  if command -v curl >/dev/null; then
    curl -fsS -o /dev/null --max-time 3 "$URL" 2>/dev/null
  else
    python3 -c "import sys, urllib.request; urllib.request.urlopen(sys.argv[1], timeout=3)" "$URL" 2>/dev/null
  fi
}

open_browser() {
  if ! find_display; then
    echo "No desktop screen found (started over SSH without a desktop logged in?). Open $URL yourself."
    return 1
  fi
  local browser
  browser="$(command -v chromium-browser || command -v chromium || true)"
  if [ -n "$browser" ]; then
    local args=(--noerrdialogs --disable-infobars --disable-session-crashed-bubble --password-store=basic)
    if [ "$KIOSK" = "1" ]; then args+=(--kiosk "$URL"); else args+=(--new-window "$URL"); fi
    setsid "$browser" "${args[@]}" >/dev/null 2>&1 < /dev/null &
  elif command -v firefox >/dev/null; then
    setsid firefox --new-window "$URL" >/dev/null 2>&1 < /dev/null &
  elif command -v xdg-open >/dev/null; then
    setsid xdg-open "$URL" >/dev/null 2>&1 < /dev/null &
  else
    echo "No browser found (sudo apt install chromium-browser). Open $URL yourself."
    return 1
  fi
  echo "$(date '+%H:%M:%S') Opened $URL in the browser."
}

# Only one watcher at a time (the autostart and a manual start would open it twice): it holds a lock
# and writes its process number next to it.
RUN_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
[ -d "$RUN_DIR" ] && [ -w "$RUN_DIR" ] || RUN_DIR="/tmp"
LOCK="$RUN_DIR/greenova-open-website.lock"
PIDFILE="$RUN_DIR/greenova-open-website.pid"

watcher_running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null
}

watch_website() {
  if command -v flock >/dev/null; then
    exec 9>"$LOCK" || true
    flock -n 9 || { echo "The website watcher is already running."; exit 0; }
  elif watcher_running; then
    echo "The website watcher is already running."; exit 0
  fi
  echo $$ > "$PIDFILE"
  echo "Watching $URL: it opens in the browser each time Greenova starts (docker compose up)."
  local up=0 down=2
  while true; do
    if website_up; then
      down=0
      if [ "$up" = 0 ]; then
        sleep 2                                  # give the page a moment to finish starting
        open_browser
        up=1
      fi
    else
      down=$((down + 1))
      [ "$down" -ge 2 ] && up=0                  # down for a while (not a single missed answer)
    fi
    sleep 3
  done
}

start_watcher_now() {
  if watcher_running; then
    echo "The website watcher is already running."
    return 0
  fi
  if ! find_display; then
    echo "No desktop screen right now: the watcher starts with the desktop at the next login."
    return 0
  fi
  local args=(--watch)
  [ "$KIOSK" = "1" ] && args+=(--kiosk)
  setsid bash "$SELF" "${args[@]}" >/dev/null 2>&1 < /dev/null &
  echo "Started the website watcher."
}

case "$MODE" in
  install)
    mkdir -p "$(dirname "$AUTOSTART")"
    cat > "$AUTOSTART" <<EOF
[Desktop Entry]
Type=Application
Name=Greenova website
Comment=Opens the Greenova website when it starts (docker compose up, boot)
Exec=bash "$SELF" --watch$([ "$KIOSK" = "1" ] && echo " --kiosk")
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
    echo "Installed $AUTOSTART: the website opens by itself each time Greenova starts."
    start_watcher_now
    ;;
  uninstall)
    rm -f "$AUTOSTART"
    if watcher_running; then kill "$(cat "$PIDFILE")" 2>/dev/null; fi
    rm -f "$PIDFILE"
    echo "Removed the website watcher."
    ;;
  watch)
    watch_website
    ;;
  once)
    printf 'Waiting for %s' "$URL"
    for _ in $(seq 1 150); do
      website_up && break
      printf '.'; sleep 2
    done
    echo
    if website_up; then open_browser; else echo "The website didn't answer. Check: docker compose ps"; exit 1; fi
    ;;
esac
