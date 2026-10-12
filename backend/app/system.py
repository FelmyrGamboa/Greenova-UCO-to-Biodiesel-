"""System status for "Before You Start" (tiles), the Dashboard and the Settings page (devices).
Tile fields match ReadOnlyTile in NewBatch.tsx: label, value, secondary, state."""
import socket

from . import config
from .hardware import PUMP_LABELS, VALVE_LABELS


def _tile(label: str, value: str, secondary: str = "", state: str = "ready") -> dict:
    return {"label": label, "value": value, "secondary": secondary, "state": state}


def _grams(value) -> str:
    return f"{value:.1f} g"


def status(reading: dict, stage_state: dict, purification_state: dict,
           pump_state: dict | None = None, drain_state: dict | None = None) -> dict:
    mode = "demonstration" if config.MOCK else "live"
    pump_state, drain_state = pump_state or {}, drain_state or {}
    t, oil, output = reading.get("temperature"), reading.get("oilMassG"), reading.get("outputWeightG")
    power_on = reading.get("electrodePowerOn")
    voltage = reading.get("voltage")
    duty = reading.get("motorDuty", {})
    pumps, valves = reading.get("pumps", {}), reading.get("valves", {})
    stage_fault = stage_state.get("state") == "fault"
    pump_fault = pump_state.get("phase") == "fault"
    running_pump = next((name for name, on in pumps.items() if on), None)
    open_valves = [VALVE_LABELS[name] for name, is_open in valves.items() if is_open and name in VALVE_LABELS]
    wash_rpm = reading.get("purificationStirrerRpm")
    tiles = [
        _tile("Power Supply", "On" if power_on else "Ready",
              f"Output {'on' if power_on else 'off'} · 0–30 V DC"
              + (f" · {voltage:g} V" if power_on and voltage is not None else "")),
        _tile("Electrodes", "Copper tube – stainless steel",
              "Fault — controller reset required" if stage_fault else "Connected",
              "fault" if stage_fault else "ready"),
        _tile("Stirrer", "Running" if duty.get("stirrer") else "Ready",
              f"{reading.get('stirrerRpm') or 0:g} RPM" if reading.get("stirrerRpm") is not None else "RPM reading unavailable"),
        _tile("Temperature Sensor", "Online" if t is not None else "No reading",
              f"{t:.1f} °C · {mode} reading" if t is not None else "Check the sensor wiring",
              "ready" if t is not None else "fault"),
        _tile("Reactor Load Cell", "Online" if oil is not None else "No reading",
              f"{_grams(oil)} in the reactor · {mode} mode" if oil is not None else "Check the HX711 wiring",
              "ready" if oil is not None else "fault"),
        _tile("Oil Input", _grams(oil) if oil else "No oil detected", "Pour the oil through the inlet filter",
              "ready" if oil is not None else "checking"),
        _tile("Dosing Pumps", "Fault" if pump_fault else "Pumping" if running_pump else "Ready",
              pump_state.get("faultReason") if pump_fault else
              f"{PUMP_LABELS[running_pump]} running" if running_pump else "A: NaOH/KOH + methanol · B: H₂SO₄ + methanol",
              "fault" if pump_fault else "ready"),
        _tile("Outlet Valves", "All closed" if not open_valves else f"{len(open_valves)} open",
              "Reactor, centrifuge and purification outlets" if not open_valves else ", ".join(open_valves),
              "ready" if not open_valves or drain_state.get("phase") in ("waiting", "draining")
              or purification_state.get("phase") in ("flow", "drain") else "checking"),
        _tile("Output Load Cell", "Online" if output is not None else "No reading",
              f"{_grams(output)} in the biodiesel container" if output is not None else "Check the HX711 wiring",
              "ready" if output is not None else "fault"),
    ]
    purification_fault = purification_state.get("phase") == "fault"
    devices = [
        {"label": "Raspberry Pi", "status": "Connected"},
        {"label": "Temperature Sensor", "status": "Connected" if t is not None else "No reading"},
        {"label": "Reactor load cell", "status": _grams(oil) if oil is not None else "No reading"},
        {"label": "Output load cell", "status": _grams(output) if output is not None else "No reading"},
        {"label": "Power relay", "status": "On" if power_on else "Ready"},
        {"label": "Stirrer relay", "status": "Running" if duty.get("stirrer") else "Ready"},
        {"label": "Pump A (NaOH/KOH + methanol)", "status": "Pumping" if pumps.get("catalyst") else "Ready"},
        {"label": "Pump B (H₂SO₄ + methanol)", "status": "Pumping" if pumps.get("acid") else "Ready"},
        {"label": "Reactor outlet valve", "status": "Open" if valves.get("reactor_outlet") else "Closed"},
        {"label": "Centrifuge controller", "status": "Running" if duty.get("centrifuge") else "Ready"},
        {"label": "Centrifuge outlet valve", "status": "Open" if valves.get("centrifuge_outlet") else "Closed"},
        {"label": "Immersion heater", "status": "Fault" if purification_fault else "On" if reading.get("heaterOn") else "Ready"},
        {"label": "Dry wash stirrer", "status": (f"Running · {wash_rpm:g} RPM" if wash_rpm is not None else "Running")
                                             if duty.get("purification_stirrer") else "Ready"},
        {"label": "Purification outlet valve", "status": "Open" if reading.get("meshBedValveOpen") else "Closed"},
    ]
    ready = all(tile["state"] == "ready" for tile in tiles)
    return {"mode": mode, "ready": ready, "tiles": tiles, "devices": devices,
            "readiness": round(sum(tile["state"] == "ready" for tile in tiles) / len(tiles) * 100)}


def lan_addresses() -> list[str]:
    """This computer's IPv4 addresses on the local network (for opening the website on a phone).
    The address of the network the computer uses to go out comes first."""
    found = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))   # picks the outgoing interface; nothing is sent
            found.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        found += [info[4][0] for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)]
    except OSError:
        pass
    result = []
    for ip in found:
        if ip not in result and not ip.startswith(("127.", "169.254.", "0.")):
            result.append(ip)
    return result
