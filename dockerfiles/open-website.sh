#!/usr/bin/env bash
# Opens the Greenova website in the Raspberry Pi's browser as soon as it answers.
# start-machine.sh runs it after "docker compose up", and installs it as a desktop autostart entry,
# so the website also opens by itself after every reboot (the containers start by themselves).
#
#     bash open-website.sh                 wait for the website, then open it
#     GREENOVA_KIOSK=1 bash open-website.sh   full screen, no address bar (Alt+F4 closes it)
URL="${GREENOVA_URL:-http://localhost:${FRONTEND_PORT:-8443}/dashboard}"

# wait up to 5 minutes (after a boot, MySQL and the backend start first; the first page load
# of the website compiles it)
for _ in $(seq 1 150); do
  curl -fsS -o /dev/null --max-time 5 "$URL" && break
  sleep 2
done

# the desktop session's display (also when this runs from SSH or from start-machine.sh)
uid="$(id -u)"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$uid}"
if [ -z "${WAYLAND_DISPLAY:-}" ]; then
  socket="$(ls "$XDG_RUNTIME_DIR"/wayland-[0-9] 2>/dev/null | head -n 1)"
  [ -n "$socket" ] && export WAYLAND_DISPLAY="$(basename "$socket")"
fi
export DISPLAY="${DISPLAY:-:0}"
[ -z "${XAUTHORITY:-}" ] && [ -f "$HOME/.Xauthority" ] && export XAUTHORITY="$HOME/.Xauthority"

flags=(--new-window --no-first-run --noerrdialogs --disable-session-crashed-bubble)
[ "${GREENOVA_KIOSK:-0}" = "1" ] && flags+=(--kiosk)
for browser in chromium-browser chromium; do
  if command -v "$browser" >/dev/null 2>&1; then
    exec "$browser" "${flags[@]}" "$URL" >/dev/null 2>&1
  fi
done
exec xdg-open "$URL" >/dev/null 2>&1
