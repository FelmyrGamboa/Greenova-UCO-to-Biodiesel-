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
# Looked for in backend/frontend/dist, then in ../frontend/dist (a repo with frontend/ and backend/).
def _frontend_dir() -> Path:
    if os.getenv("GREENOVA_FRONTEND"):
        return Path(os.environ["GREENOVA_FRONTEND"])
    for candidate in (BASE_DIR / "frontend" / "dist", BASE_DIR.parent / "frontend" / "dist"):
        if candidate.is_dir():
            return candidate
    return BASE_DIR / "frontend" / "dist"


FRONTEND_DIR = _frontend_dir()

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
    "valve_reactor_outlet": 16,      # main reactor -> centrifuge (opens after transesterification)
    "valve_centrifuge_outlet": 20,   # centrifuge -> purification tank (opens after separation)
    "valve_mesh_bed": 24,            # purification outlet -> filter -> output container
    "pump_catalyst": 5,              # pump A: NaOH/KOH + methanol
    "pump_acid": 6,                  # pump B: H2SO4 + methanol
    "stirrer_pwm": 18,               # reactor stirrer
    "centrifuge_pwm": 13,
    "purification_stirrer_pwm": 12,  # dry wash stirrer in the purification tank
    # Float (level) switch at the heater's height in the purification tank. Closed = biodiesel
    # covers the heater. Set it to a pin number to start purification automatically and to stop
    # the heater if the level drops. None = no switch: the operator confirms on the website.
    "heater_level_switch": None,
}

# Can the Pi set the power supply's current limit (e.g. a supply with a serial/USB or PWM control
# input)? Then fill in PiHardware._write_current_limit and set this to 1. If not (a supply with
# knobs), the website tells the operator to set the current by hand before each stage. Either
# way the electrodes stop when the measured current goes above the setting.
POWER_SUPPLY_CURRENT_CONTROL = os.getenv("GREENOVA_PSU_CURRENT_CONTROL", "0") == "1"

# Many relay modules switch ON when the input is LOW. If yours does, set this to False,
# otherwise the heater could turn ON when the Pi starts. Test with the heater unplugged first.
RELAY_ACTIVE_HIGH = os.getenv("GREENOVA_RELAY_ACTIVE_HIGH", "1") == "1"
