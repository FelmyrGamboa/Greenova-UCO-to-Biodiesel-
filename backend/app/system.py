"""System status for "Before You Start" (tiles), the Dashboard and the Settings page (devices).
Tile fields match ReadOnlyTile in NewBatch.tsx: label, value, secondary, state."""
import socket

from .hardware import PUMP_LABELS, VALVE_LABELS
from .purification import MAXIMUM_TEMPERATURE_C, RUNNING_PHASES


def _tile(label: str, value: str, secondary: str = "", state: str = "ready") -> dict:
    return {"label": label, "value": value, "secondary": secondary, "state": state}


def _grams(value) -> str:
    return f"{value:.1f} g"


def _motor_tile(label: str, rpm, duty, estimated: bool = False) -> dict:
    """Ready when its RPM sensor gives a reading (so the Pi can see it turn). With the ESP32
    controller there is no RPM sensor: the RPM is the speed it was set to (open loop)."""
    if rpm is None:
        return _tile(label, "Not ready", "No reading — check the ESP32 controller" if estimated
                     else "No RPM reading — check the RPM sensor", "fault")
    if estimated:
        return _tile(label, "Ready", f"Running · set to {rpm:g} RPM" if duty else "Stopped · controller online")
    return _tile(label, "Ready", f"Running · {rpm:g} RPM" if duty else "Stopped · RPM sensor online")


def _controller_tile(reading: dict) -> dict:
    """ESP32 mode: the USB link to the ESP32 that switches the relays, heater and mixers."""
    error = reading.get("controllerError")
    if reading.get("controllerOnline") and not error:
        return _tile("Output Controller", "Online", f"ESP32 on {reading.get('controllerPort') or 'USB'}")
    return _tile("Output Controller", "Offline" if not reading.get("controllerOnline") else "Fault",
                 error or "Check the ESP32's USB cable", "fault")


def status(reading: dict, stage_state: dict, purification_state: dict, pump_state: dict | None = None) -> dict:
    mode = "live"                               # always the real machine
    pump_state = pump_state or {}
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
    estimated = bool(reading.get("rpmEstimated"))
    fitted = reading.get("loadCellsFitted") or {}   # ESP32 mode: which HX711s hardware.toml enables
    purification_fault = purification_state.get("phase") == "fault"
    # The reactor pump and pumpin run during separation, the valve + pumpout at the end of
    # purification: expected while a process runs.
    process_running = (stage_state.get("state") in ("running", "paused")
                       or purification_state.get("phase") in RUNNING_PHASES)
    tiles = [
        _tile("Power Supply", "On" if power_on else "Ready",
              f"Output {'on' if power_on else 'off'} · 0–30 V DC"
              + (f" · {voltage:g} V" if power_on and voltage is not None else "")),
        # a stopped stage needs no reset: it can simply be started again
        _tile("Electrodes", "Graphite – graphite",
              f"Last stage stopped: {stage_state.get('faultReason') or 'stopped'}" if stage_fault else "Connected"),
        *([_controller_tile(reading)] if "controllerOnline" in reading else []),
        _motor_tile("Reactor Stirrer", reading.get("stirrerRpm"), duty.get("stirrer"), estimated),
        _motor_tile("Centrifuge Motor", reading.get("centrifugeRpm"), duty.get("centrifuge"), estimated),
        _motor_tile("Purification Stirrer", wash_rpm, duty.get("purification_stirrer"), estimated),
        _tile("Heater", "Not ready" if t is None or purification_fault else "Ready",
              "No temperature reading" if t is None
              else "Safety stop — acknowledge it on the Purification screen" if purification_fault
              else f"{'On' if reading.get('heaterOn') else 'Off'} · stops above {MAXIMUM_TEMPERATURE_C:g} °C",
              "fault" if t is None or purification_fault else "ready"),
        _tile("Temperature Sensor", "Online" if t is not None else "No reading",
              f"{t:.1f} °C · live reading" if t is not None else "Check the sensor wiring",
              "ready" if t is not None else "fault"),
        *([] if fitted.get("reactor") is False else [
            _tile("Reactor Load Cell", "Online" if oil is not None else "No reading",
                  f"{_grams(oil)} in the reactor" if oil is not None else "Check the HX711 wiring",
                  "ready" if oil is not None else "fault")]),
        # automated oil input: the operator measures the oil into the oil container, the pump
        # empties it into the reactor and the operator presses Done
        (_tile("Oil Input", "Pumping" if pumps.get("oil") else "Oil pump",
               "Measured oil container · Done when it is empty")
         if "oil" in pumps else
         _tile("Oil Input", "By hand", "Pour the measured oil through the inlet filter")),
        _tile("Dispensers", "Fault" if pump_fault else "Pumping" if running_pump else "Ready",
              pump_state.get("faultReason") if pump_fault else
              f"{PUMP_LABELS[running_pump]} running" if running_pump else "A: NaOH/KOH + methanol · B: H₂SO₄ + methanol",
              "fault" if pump_fault else "ready"),
        _tile("Transfer Pumps", "All off" if not open_valves else f"{len(open_valves)} on",
              "Reactor pump, pumpin, valve + pumpout" if not open_valves else ", ".join(open_valves),
              "ready" if not open_valves or process_running else "checking"),
        _tile("Output Load Cell", "Online" if output is not None else "No reading",
              f"{_grams(output)} in the biodiesel container" if output is not None else "Check the HX711 wiring",
              "ready" if output is not None else "fault"),
    ]
    devices = [
        {"label": "Raspberry Pi", "status": "Connected"},
        *([{"label": "ESP32 controller", "status": "Connected" if reading.get("controllerOnline") and not
            reading.get("controllerError") else "Fault" if reading.get("controllerOnline") else "No reading"}]
          if "controllerOnline" in reading else []),
        {"label": "Temperature Sensor", "status": "Connected" if t is not None else "No reading"},
        *([] if fitted.get("reactor") is False else
          [{"label": "Reactor load cell", "status": _grams(oil) if oil is not None else "No reading"}]),
        {"label": "Output load cell", "status": _grams(output) if output is not None else "No reading"},
        {"label": "Power relay", "status": "On" if power_on else "Ready"},
        {"label": "Stirrer relay", "status": "Running" if duty.get("stirrer") else "Ready"},
        *([{"label": "Oil pump", "status": "Pumping" if pumps.get("oil") else "Ready"}] if "oil" in pumps else []),
        {"label": "Pump A (NaOH/KOH + methanol)", "status": "Pumping" if pumps.get("catalyst") else "Ready"},
        {"label": "Pump B (H₂SO₄ + methanol)", "status": "Pumping" if pumps.get("acid") else "Ready"},
        {"label": VALVE_LABELS["reactor_outlet"], "status": "On" if valves.get("reactor_outlet") else "Off"},
        {"label": "Centrifuge controller", "status": "Running" if duty.get("centrifuge") else "Ready"},
        {"label": VALVE_LABELS["centrifuge_outlet"], "status": "On" if valves.get("centrifuge_outlet") else "Off"},
        {"label": "Immersion heater", "status": "Fault" if purification_fault else "On" if reading.get("heaterOn") else "Ready"},
        {"label": "Dry wash stirrer", "status": (f"Running · {wash_rpm:g} RPM" if wash_rpm is not None else "Running")
                                             if duty.get("purification_stirrer") else "Ready"},
        {"label": VALVE_LABELS["mesh_bed"], "status": "Open" if reading.get("meshBedValveOpen") else "Closed"},
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
