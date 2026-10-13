"""Basic configuration. Change these with environment variables or edit the defaults here.

The Raspberry Pi wiring (pins, sensors, calibration) is NOT edited here any more: it lives in
backend/hardware.toml (copy hardware.example.toml to start). See docs/RASPBERRY_PI_SETUP.md.
"""
import copy
import os
import sys
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


# ---------- Raspberry Pi hardware (hardware.toml) ----------
# Pin numbers are BCM GPIO numbers (GPIO17 = physical pin 11). These defaults are the same as
# hardware.example.toml; hardware.toml overrides any of them. GPIO17 (strip reader LED), GPIO2/3
# (I2C: strip reader, power monitor) and GPIO4 (1-Wire temperature probe) are taken.
HARDWARE_DEFAULTS: dict = {
    "gpiochip": None,                    # None = find the Pi's GPIO chip by itself (Pi 4 and Pi 5)
    "relays": {"active_high": True, "heater": 23, "electrode_power": 25},
    "pumps": {"catalyst": 5, "acid": 6},  # pump A: NaOH/KOH + methanol, pump B: H2SO4 + methanol
    "valves": {
        # mode "single": one relay, ON = open.  mode "dual": open_pin powers OPEN, close_pin powers CLOSE.
        "reactor_outlet": {"mode": "single", "pin": 16},
        "centrifuge_outlet": {"mode": "single", "pin": 20},
        "purification_outlet": {"mode": "single", "pin": 24},
    },
    "motors": {
        # type "pwm" (motor driver / MOSFET PWM input) or "esc" (brushless ESC, 1-2 ms pulses at 50 Hz)
        "stirrer": {"type": "pwm", "pin": 18, "frequency": 1000},
        "centrifuge": {"type": "pwm", "pin": 13, "frequency": 1000},
        "purification_stirrer": {"type": "pwm", "pin": 12, "frequency": 1000},
    },
    "level_switch": {"enabled": False, "pin": 26, "closed_means_liquid": True},
    "temperature": {"type": "ds18b20", "sensor_id": ""},
    "load_cells": {
        "reactor": {"enabled": False, "data_pin": 27, "clock_pin": 22, "offset": 0, "scale": 420.0, "samples": 3},
        "output": {"enabled": False, "data_pin": 10, "clock_pin": 9, "offset": 0, "scale": 420.0, "samples": 3},
    },
    "power_monitor": {"type": "none", "i2c_bus": 1, "address": 0x40, "shunt_ohms": 0.02},
    "rpm": {
        "stirrer": {"enabled": False, "pin": 21, "pulses_per_rev": 1},
        "centrifuge": {"enabled": False, "pin": 19, "pulses_per_rev": 1},
        "purification_stirrer": {"enabled": False, "pin": 7, "pulses_per_rev": 1},
    },
    "power_supply": {"control": "manual", "port": "/dev/ttyUSB0", "baudrate": 9600,
                     "voltage_command": "VOLT {volts:.2f}\n", "current_command": "CURR {amps:.2f}\n",
                     "output_on_command": "", "output_off_command": ""},
}

RESERVED_PINS = {2: "I2C SDA", 3: "I2C SCL", 4: "1-Wire (DS18B20)", 17: "strip reader LED"}

HARDWARE_FILE = Path(os.getenv("GREENOVA_HARDWARE", BASE_DIR / "hardware.toml"))


def _merge(base: dict, extra: dict) -> dict:
    out = copy.deepcopy(base)
    for key, value in extra.items():
        out[key] = _merge(out[key], value) if isinstance(value, dict) and isinstance(out.get(key), dict) else value
    return out


def _read_toml(path: Path) -> dict:
    try:
        import tomllib                     # Python 3.11+ (Raspberry Pi OS Bookworm)
    except ImportError:                    # Python 3.10: pip install tomli
        try:
            import tomli as tomllib        # type: ignore
        except ImportError:
            print(f"Greenova: {path.name} found but Python {sys.version_info.major}.{sys.version_info.minor} "
                  "can't read TOML (use Python 3.11+, or pip install tomli). Using the default pins.")
            return {}
    with open(path, "rb") as f:
        return tomllib.load(f)


def load_hardware(path: Path = HARDWARE_FILE) -> dict:
    """The defaults above, with backend/hardware.toml (if it exists) on top."""
    hw = _merge(HARDWARE_DEFAULTS, _read_toml(path) if path.is_file() else {})
    # Older environment switches still work.
    if os.getenv("GREENOVA_RELAY_ACTIVE_HIGH") is not None:
        hw["relays"]["active_high"] = os.getenv("GREENOVA_RELAY_ACTIVE_HIGH") == "1"
    return hw


def used_pins(hw: dict) -> list[tuple[int, str]]:
    """Every GPIO pin the configuration uses, with what it's for (enabled devices only)."""
    pins: list[tuple[int, str]] = []
    pins += [(hw["relays"][k], f"relays.{k}") for k in ("heater", "electrode_power")]
    pins += [(pin, f"pumps.{k}") for k, pin in hw["pumps"].items()]
    for name, v in hw["valves"].items():
        if v.get("mode", "single") == "dual":
            pins += [(v["open_pin"], f"valves.{name}.open_pin"), (v["close_pin"], f"valves.{name}.close_pin")]
        else:
            pins.append((v["pin"], f"valves.{name}"))
    pins += [(m["pin"], f"motors.{k}") for k, m in hw["motors"].items()]
    if hw["level_switch"].get("enabled"):
        pins.append((hw["level_switch"]["pin"], "level_switch"))
    for k, cell in hw["load_cells"].items():
        if cell.get("enabled"):
            pins += [(cell["data_pin"], f"load_cells.{k}.data_pin"), (cell["clock_pin"], f"load_cells.{k}.clock_pin")]
    for k, r in hw["rpm"].items():
        if r.get("enabled"):
            pins.append((r["pin"], f"rpm.{k}"))
    return pins


def check_hardware(hw: dict) -> list[str]:
    """Problems in the wiring configuration: a pin used twice, or a reserved pin."""
    problems, seen = [], {}
    for pin, what in used_pins(hw):
        if not isinstance(pin, int) or not 0 <= pin <= 27:
            problems.append(f"{what}: {pin!r} is not a BCM GPIO number (0-27).")
            continue
        if pin in seen:
            problems.append(f"GPIO{pin} is used twice: {seen[pin]} and {what}.")
        seen[pin] = what
        if pin in RESERVED_PINS:
            problems.append(f"{what}: GPIO{pin} is already used by the {RESERVED_PINS[pin]}.")
    return problems


HARDWARE = load_hardware()

# Older code and docs refer to these names; they follow hardware.toml.
PINS = {
    "heater_relay": HARDWARE["relays"]["heater"],
    "electrode_power_relay": HARDWARE["relays"]["electrode_power"],
    "valve_reactor_outlet": HARDWARE["valves"]["reactor_outlet"].get("pin"),
    "valve_centrifuge_outlet": HARDWARE["valves"]["centrifuge_outlet"].get("pin"),
    "valve_mesh_bed": HARDWARE["valves"]["purification_outlet"].get("pin"),
    "pump_catalyst": HARDWARE["pumps"]["catalyst"],
    "pump_acid": HARDWARE["pumps"]["acid"],
    "stirrer_pwm": HARDWARE["motors"]["stirrer"]["pin"],
    "centrifuge_pwm": HARDWARE["motors"]["centrifuge"]["pin"],
    "purification_stirrer_pwm": HARDWARE["motors"]["purification_stirrer"]["pin"],
    "heater_level_switch": HARDWARE["level_switch"]["pin"] if HARDWARE["level_switch"].get("enabled") else None,
}

# Can the Pi set the power supply's voltage and current limit? Yes when hardware.toml has
# [power_supply] control = "serial" (or GREENOVA_PSU_CURRENT_CONTROL=1 with your own code in
# PiHardware._write_current_limit). If not (a supply with knobs), the website tells the operator
# to set the current by hand before each stage. Either way the electrodes stop when the measured
# current goes above the setting.
POWER_SUPPLY_CURRENT_CONTROL = (os.getenv("GREENOVA_PSU_CURRENT_CONTROL", "0") == "1"
                                or HARDWARE["power_supply"].get("control") == "serial")

# Many relay modules switch ON when the input is LOW. If yours does, set active_high = false in
# hardware.toml, otherwise the heater could turn ON when the Pi starts. Test with the heater unplugged first.
RELAY_ACTIVE_HIGH = HARDWARE["relays"]["active_high"]
