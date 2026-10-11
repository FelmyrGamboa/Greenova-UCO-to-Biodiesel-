"""System status for "Before You Start" (tiles), the Dashboard and the Settings page (devices).
Tile fields match ReadOnlyTile in NewBatch.tsx: label, value, secondary, state."""
from . import config


def _tile(label: str, value: str, secondary: str = "", state: str = "ready") -> dict:
    return {"label": label, "value": value, "secondary": secondary, "state": state}


def status(reading: dict, stage_state: dict, purification_state: dict) -> dict:
    mode = "demonstration" if config.MOCK else "live"
    t, oil = reading.get("temperature"), reading.get("oilMassG")
    power_on = reading.get("electrodePowerOn")
    voltage = reading.get("voltage")
    stage_fault = stage_state.get("state") == "fault"
    tiles = [
        _tile("Power Supply", "On" if power_on else "Ready",
              f"Output {'on' if power_on else 'off'} · 0–30 V DC"
              + (f" · {voltage:g} V" if power_on and voltage is not None else "")),
        _tile("Electrodes", "Copper tube – stainless steel",
              "Fault — controller reset required" if stage_fault else "Connected",
              "fault" if stage_fault else "ready"),
        _tile("Stirrer", "Running" if reading.get("motorDuty", {}).get("stirrer") else "Ready",
              f"{reading.get('stirrerRpm') or 0:g} RPM" if reading.get("stirrerRpm") is not None else "RPM reading unavailable"),
        _tile("Temperature Sensor", "Online" if t is not None else "No reading",
              f"{t:.1f} °C · {mode} reading" if t is not None else "Check the sensor wiring",
              "ready" if t is not None else "fault"),
        _tile("Load Cell", "Online" if oil is not None else "No reading",
              f"{oil:.1f} g · {mode} mode" if oil is not None else "Check the HX711 wiring",
              "ready" if oil is not None else "fault"),
        _tile("Oil Input", f"{oil:.1f} g" if oil else "No oil detected", f"Input channel ready · {mode} mode",
              "ready" if oil is not None else "checking"),
    ]
    purification_fault = purification_state.get("phase") == "fault"
    devices = [
        {"label": "Raspberry Pi", "status": "Connected"},
        {"label": "Temperature Sensor", "status": "Connected" if t is not None else "No reading"},
        {"label": "Power relay", "status": "On" if power_on else "Ready"},
        {"label": "Stirrer relay", "status": "Running" if reading.get("motorDuty", {}).get("stirrer") else "Ready"},
        {"label": "Centrifuge controller", "status": "Running" if reading.get("motorDuty", {}).get("centrifuge") else "Ready"},
        {"label": "Immersion heater", "status": "Fault" if purification_fault else "On" if reading.get("heaterOn") else "Ready"},
        {"label": "Mesh bed valve", "status": "Open" if reading.get("meshBedValveOpen") else "Closed"},
    ]
    ready = all(tile["state"] == "ready" for tile in tiles)
    return {"mode": mode, "ready": ready, "tiles": tiles, "devices": devices,
            "readiness": round(sum(tile["state"] == "ready" for tile in tiles) / len(tiles) * 100)}
