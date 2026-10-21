"""Basic configuration. Change these with environment variables, in backend/.env, or edit the
defaults here.

The MySQL login is right below (DB_HOST ... DB_NAME). The defaults match backend/greenova_db_ver2.sql,
which creates the database greenova_db and the MySQL user greenova@localhost with no password, so
nothing has to be changed when MySQL runs on the same computer as the backend. Use backend/.env
(copy .env.example) only for a different login.

The Raspberry Pi wiring (pins, sensors, calibration) is NOT edited here: it lives in
backend/hardware.toml (copy hardware.example.toml to start). See docs/RASPBERRY_PI_SETUP.md.
"""
import copy
import os
import sys
from pathlib import Path
from typing import Optional

BASE_DIR = Path(__file__).resolve().parent.parent


def _load_env_file(path: Path) -> None:
    """Reads backend/.env (lines like DB_PASSWORD=secret) into the environment. A variable that
    is already set in the real environment wins, and an empty value (DB_PASSWORD=) is ignored, so
    the default below is used. No extra package needed."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip().removeprefix("export ").strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]                  # DB_PASSWORD="my password" -> my password
        if key and value and key not in os.environ:
            os.environ[key] = value


ENV_FILE = BASE_DIR / ".env"
_load_env_file(ENV_FILE)

# ---------- MySQL database (MySQL 8 Community Server) ----------
# The database is greenova_db_ver2.sql, imported once as it is. It creates the user
# 'greenova'@'localhost' (no password), so the backend logs in as greenova on localhost.
# Users opening the website do not need MySQL installed or database credentials.
# Keep MySQL on the server; client devices should talk to the FastAPI backend, not port 3306.
# Environment variables set by the OS override values in backend/.env.
DB_HOST = os.getenv("DB_HOST", "localhost").strip() or "localhost"
try:
    DB_PORT = int(os.getenv("DB_PORT", "3306"))
except ValueError as exc:
    raise RuntimeError("DB_PORT must be a number, usually 3306.") from exc
DB_USER = os.getenv("DB_USER", "greenova").strip() or "greenova"
DB_PASSWORD = os.getenv("DB_PASSWORD", "")      # greenova@localhost has no password
DB_NAME = os.getenv("DB_NAME", "greenova_db").strip() or "greenova_db"

DATABASE = {"host": DB_HOST, "port": DB_PORT, "user": DB_USER, "password": DB_PASSWORD,
            "database": DB_NAME, "connect_timeout": 5, "pool_size": 5}

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
# Pin numbers are BCM GPIO numbers (GPIO17 = physical pin 11).
# [actuators] backend = "esp32" (default): the ESP32 controller on USB (relays, heater, mixers,
#   temperature) + the Pi's own pins for the centrifuge (BTS7960) and the HX711 load cell(s). See esp32.py.
# [actuators] backend = "gpio": the older wiring with every relay and motor on the Pi's pins
#   (relays, pumps, valves, motors, rpm and temperature below). Set every pin in hardware.toml.
HARDWARE_DEFAULTS: dict = {
    "actuators": {"backend": "esp32", "port": "auto", "baudrate": 115200},
    "esp32": {
        # Dead-man timer: outputs are switched on as "<device> on 5" and refreshed every second, so
        # the ESP32 switches them off by itself within 5 s if the Pi, the backend or the cable stops.
        "lease_seconds": 5,
        "poll_seconds": 1.0,
        "offline_after_seconds": 3.5,
        "mixer_max_rpm": 1544,           # the sketch's MAX_RPM (used until the ESP32 reports its own)
        # Greenova job -> ESP32 device name(s) in esp32_process_control.ino ("" = not fitted)
        "devices": {
            "heater": "heater",
            "electrode_power": "electrode",
            "oil_pump": "oil",                 # oil input: oil tank -> reactor
            "catalyst_pump": "dispenser1",     # pump A: NaOH/KOH + methanol
            "acid_pump": "dispenser2",         # pump B: H2SO4 + methanol
            "reactor_outlet": "reactorpump",   # reactor -> centrifuge
            "centrifuge_outlet": "pumpin",     # centrifuge -> purifier
            "purification_outlet": ["valve", "pumpout"],   # after purification: valve opens, pump to the output container
            "stirrer": "mixer1",               # reactor stirrer
            "purification_stirrer": "mixer2",  # dry wash stirrer
        },
        # job -> seconds: an extra limit, the ESP32 switches the output off by itself after this long.
        # Empty = the process step switches it off (separation timer, purification drain, Done).
        "max_on_seconds": {},
    },
    "centrifuge": {"enabled": True, "max_rpm": 2500, "min_duty": 0, "pwm_freq": 1000, "ramp_seconds": 3.0,
                   "direction": "forward", "l_en": 23, "r_en": 24, "lpwm": 25, "rpwm": 21},
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
        # ESP32 mode: the output load cell is the HX711 on DT 17 / SCK 27, with the calibration from the
        # Pi control panel's config.json (offset 41028.54; factor 145759 per kg = 145.759 counts per gram).
        "reactor": {"enabled": False, "data_pin": 5, "clock_pin": 6, "offset": 0, "scale": 420.0, "samples": 10,
                    "cal_seconds": 3.0, "capacity_kg": 5, "vessel_kg": 0},
        "output": {"enabled": True, "data_pin": 17, "clock_pin": 27, "offset": 41028.54, "scale": 145.759,
                   "samples": 10, "cal_seconds": 3.0, "capacity_kg": 5, "vessel_kg": 0},
    },
    "power_monitor": {"type": "none", "i2c_bus": 1, "address": 0x40, "shunt_ohms": 0.02},
    "rpm": {
        "stirrer": {"enabled": False, "pin": 21, "pulses_per_rev": 1},
        "centrifuge": {"enabled": False, "pin": 19, "pulses_per_rev": 1},
        "purification_stirrer": {"enabled": False, "pin": 7, "pulses_per_rev": 1},
    },
    "power_supply": {"control": "manual", "port": "/dev/ttyUSB1", "baudrate": 9600,
                     "voltage_command": "VOLT {volts:.2f}\n", "current_command": "CURR {amps:.2f}\n",
                     "output_on_command": "", "output_off_command": ""},
}

HARDWARE_FILE = Path(os.getenv("GREENOVA_HARDWARE", BASE_DIR / "hardware.toml"))
# Load cell Tare / Calibrate from the website (ESP32 mode) are kept here; they win over hardware.toml.
CALIBRATION_FILE = Path(os.getenv("GREENOVA_CALIBRATION", BASE_DIR / "loadcell_calibration.json"))


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
    if path.is_dir():
        print(f"Greenova: {path} is a folder, not a file (Docker creates one when the mounted file is "
              "missing). Using the default pins; to change them, delete the folder and copy "
              "hardware.example.toml to hardware.toml.")
    hw = _merge(HARDWARE_DEFAULTS, _read_toml(path) if path.is_file() else {})
    # Older environment switches still work.
    if os.getenv("GREENOVA_RELAY_ACTIVE_HIGH") is not None:
        hw["relays"]["active_high"] = os.getenv("GREENOVA_RELAY_ACTIVE_HIGH") == "1"
    return hw


def actuator_backend(hw: dict) -> str:
    """ "esp32" (ESP32 controller + Pi centrifuge and load cell) or "gpio" (everything on the Pi)."""
    return str(hw.get("actuators", {}).get("backend", "esp32")).strip().lower()


def reserved_pins(hw: dict, backend: Optional[str] = None) -> dict[int, str]:
    """Pins other parts already use: I2C (power monitor) and, in gpio mode, the Pi's
    1-Wire temperature probe."""
    reserved = {2: "I2C SDA", 3: "I2C SCL"}
    if (backend or actuator_backend(hw)) == "gpio" and hw["temperature"].get("type", "ds18b20") == "ds18b20":
        reserved[4] = "1-Wire (DS18B20)"
    return reserved


def used_pins(hw: dict, backend: Optional[str] = None) -> list[tuple[int, str]]:
    """Every Raspberry Pi GPIO pin the configuration uses, with what it's for (enabled devices only).
    In ESP32 mode the relays, heater and mixers are on the ESP32, so only the Pi's own parts count."""
    backend = backend or actuator_backend(hw)
    pins: list[tuple[int, str]] = []
    if backend == "esp32":
        c = hw["centrifuge"]
        if c.get("enabled"):
            pins += [(c[k], f"centrifuge.{k}") for k in ("l_en", "r_en", "lpwm", "rpwm")]
    else:
        pins += [(hw["relays"][k], f"relays.{k}") for k in ("heater", "electrode_power")]
        pins += [(pin, f"pumps.{k}") for k, pin in hw["pumps"].items()]
        for name, v in hw["valves"].items():
            if v.get("mode", "single") == "dual":
                pins += [(v["open_pin"], f"valves.{name}.open_pin"), (v["close_pin"], f"valves.{name}.close_pin")]
            else:
                pins.append((v["pin"], f"valves.{name}"))
        pins += [(m["pin"], f"motors.{k}") for k, m in hw["motors"].items()]
        for k, r in hw["rpm"].items():
            if r.get("enabled"):
                pins.append((r["pin"], f"rpm.{k}"))
    if hw["level_switch"].get("enabled"):
        pins.append((hw["level_switch"]["pin"], "level_switch"))
    for k, cell in hw["load_cells"].items():
        if cell.get("enabled"):
            pins += [(cell["data_pin"], f"load_cells.{k}.data_pin"), (cell["clock_pin"], f"load_cells.{k}.clock_pin")]
    return pins


def check_hardware(hw: dict, backend: Optional[str] = None) -> list[str]:
    """Problems in the wiring configuration: a pin used twice, or a reserved pin."""
    backend = backend or actuator_backend(hw)
    problems, seen = [], {}
    if backend not in ("esp32", "gpio"):
        problems.append(f"actuators.backend: {backend!r} is not 'esp32' or 'gpio'.")
    reserved = reserved_pins(hw, backend)
    for pin, what in used_pins(hw, backend):
        if not isinstance(pin, int) or not 0 <= pin <= 27:
            problems.append(f"{what}: {pin!r} is not a BCM GPIO number (0-27).")
            continue
        if pin in seen:
            problems.append(f"GPIO{pin} is used twice: {seen[pin]} and {what}.")
        seen[pin] = what
        if pin in reserved:
            problems.append(f"{what}: GPIO{pin} is already used by the {reserved[pin]}.")
    if backend == "esp32":
        a, ps = hw["actuators"], hw["power_supply"]
        if ps.get("control") == "serial" and str(a.get("port")) == str(ps.get("port")):
            problems.append(f"The ESP32 and the power supply can't share {ps.get('port')}: set [actuators] port "
                            "or [power_supply] port (ls /dev/serial/by-id/ lists them).")
        for key, cell in hw["load_cells"].items():
            if cell.get("enabled") and not cell.get("scale"):
                problems.append(f"load_cells.{key}.scale can't be 0.")
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
