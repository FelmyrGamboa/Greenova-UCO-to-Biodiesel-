"""Basic configuration. Change these with environment variables or edit the defaults here."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

# Demo mode: simulated hardware, so the backend runs on any laptop.
# On the Raspberry Pi with the real machine, start with GREENOVA_MOCK=0.
MOCK = os.getenv("GREENOVA_MOCK", "1") == "1"

# Demo only: run the simulated machine faster (10 = ten times faster). Always 1 on real hardware.
TIME_SCALE = float(os.getenv("GREENOVA_TIME_SCALE", "1")) if MOCK else 1.0

DB_PATH = Path(os.getenv("GREENOVA_DB", BASE_DIR / "greenova.db"))

# Built website (Vite "dist" folder). If it exists, the backend serves the website too.
FRONTEND_DIR = Path(os.getenv("GREENOVA_FRONTEND", BASE_DIR / "frontend" / "dist"))

# Websites allowed to call the API from another address (for example the Vite dev server).
CORS_ORIGINS = os.getenv(
    "GREENOVA_CORS",
    "http://localhost:8443,http://127.0.0.1:8443,http://localhost:5173,http://127.0.0.1:5173",
).split(",")

# GPIO pins (BCM numbers). TODO: change these to match your wiring.
# GPIO17 is used by the FFA strip reader's LED (see strip_reader.py), so don't reuse it.
PINS = {
    "heater_relay": 23,
    "electrode_power_relay": 25,
    "valve_mesh_bed": 24,
    "stirrer_pwm": 18,
    "centrifuge_pwm": 13,
    # Float (level) switch at the heater's height in the purification tank. Closed = biodiesel
    # covers the heater. Set it to a pin number to start purification automatically and to stop
    # the heater if the level drops. None = no switch: the operator confirms on the website.
    "heater_level_switch": None,
}

# Many relay modules switch ON when the input is LOW. If yours does, set this to False,
# otherwise the heater could turn ON when the Pi starts. Test with the heater unplugged first.
RELAY_ACTIVE_HIGH = os.getenv("GREENOVA_RELAY_ACTIVE_HIGH", "1") == "1"
