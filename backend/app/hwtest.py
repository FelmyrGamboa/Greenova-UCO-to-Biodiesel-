"""Hardware bench test for the Raspberry Pi. Run it from the backend folder, with the Greenova
service stopped (only one program can use the GPIO pins and the ESP32's serial port):

    sudo systemctl stop greenova
    .venv/bin/python -m app.hwtest check                # hardware.toml: pins, conflicts, ESP32 jobs, which parts are on
    .venv/bin/python -m app.hwtest esp32                # ESP32 controller: port, temperature, every output (Ctrl+C)
    .venv/bin/python -m app.hwtest read                 # every sensor, once per second (Ctrl+C to stop)
    .venv/bin/python -m app.hwtest outputs              # switch each job's output (relay, pump, valve, motor) one by one
    .venv/bin/python -m app.hwtest calibrate output     # load cell Tare + Calibrate (or: reactor)
    .venv/bin/python -m app.hwtest pump oil 60          # run a pump 60 s into a jug to measure its mL/min (oil, catalyst, acid)
    .venv/bin/python -m app.hwtest i2c                  # list the I2C devices (power monitor)

Full guide: docs/RASPBERRY_PI_SETUP.md.
"""
import sys
import time

from . import config


def _names(device) -> str:
    """[esp32.devices] value: "valve" or ["valve", "pumpout"] -> "valve + pumpout"."""
    return " + ".join(device) if isinstance(device, (list, tuple)) else str(device or "")


def _esp32_mode() -> bool:
    return config.actuator_backend(config.HARDWARE) == "esp32"


def _hardware():
    try:
        if _esp32_mode():
            from .esp32 import Esp32Hardware
            hw = Esp32Hardware()
            print("Connecting to the ESP32...", flush=True)
            end = time.time() + 20
            while not hw.link.online and time.time() < end:
                time.sleep(0.2)
            if not hw.link.online:
                print(f"The ESP32 doesn't answer: {hw.link.why_offline()}")
            return hw
        from .hardware import PiHardware
        return PiHardware()
    except ImportError as e:
        sys.exit(f"Missing library: {e}. Run setup-pi.sh first (it installs lgpio, pyserial, gpiozero, smbus2).")
    except RuntimeError as e:
        sys.exit(str(e))


def check() -> int:
    hw = config.HARDWARE
    backend = config.actuator_backend(hw)
    print(f"Hardware file: {config.HARDWARE_FILE} ({'found' if config.HARDWARE_FILE.is_file() else 'NOT found: using the defaults'})")
    print(f"Outputs: [actuators] backend = {backend!r}")
    if backend == "esp32":
        e, a, c = hw["esp32"], hw["actuators"], hw["centrifuge"]
        print(f"  ESP32 on {a['port']} at {a['baudrate']} baud; dead-man timer {e['lease_seconds']} s")
        print("  Greenova job -> ESP32 device ([esp32.devices]):")
        for role, device in e["devices"].items():
            limit = (e.get("max_on_seconds") or {}).get(role)
            print(f"    {role:<22} {_names(device) or '(not fitted)'}" + (f"  (switches off after {limit} s)" if limit else ""))
        print(f"  Centrifuge (Pi, BTS7960): {'on' if c.get('enabled') else 'off'}, max {c['max_rpm']} RPM, "
              f"ramp {c['ramp_seconds']} s, {c['direction']}")
    else:
        print(f"Relays switch ON when the input is {'HIGH' if hw['relays']['active_high'] else 'LOW'} (relays.active_high)")
    print("\nPi pins in use (BCM numbers):")
    for pin, what in sorted(config.used_pins(hw)):
        print(f"  GPIO{pin:<3} {what}")
    print("\nSensors:")
    print(f"  temperature        {'ESP32 DS18B20' if backend == 'esp32' else hw['temperature']['type']}")
    for key, cell in hw["load_cells"].items():
        print(f"  load cell {key:<8} {'on' if cell.get('enabled') else 'off'}"
              + (f" (offset {cell.get('offset')}, scale {cell.get('scale')})" if cell.get("enabled") else ""))
    print(f"  power monitor      {hw['power_monitor']['type']}"
          + (f" at 0x{hw['power_monitor']['address']:02x}, shunt {hw['power_monitor']['shunt_ohms']} Ω"
             if hw["power_monitor"]["type"] != "none" else ""))
    if backend == "esp32":
        print("  rpm                worked out from the speed setting (no RPM sensors)")
    else:
        for key, r in hw["rpm"].items():
            print(f"  rpm {key:<14} {'on' if r.get('enabled') else 'off'}")
    print(f"  level switch       {'on' if hw['level_switch'].get('enabled') else 'off (the operator confirms the heater is covered)'}")
    print(f"  power supply       {hw['power_supply']['control']}")
    problems = config.check_hardware(hw)
    print("\n" + ("Problems:\n  " + "\n  ".join(problems) if problems else "No pin conflicts."))
    return 1 if problems else 0


def esp32(seconds: float = 0) -> int:
    """The ESP32 controller's status once per second: port, temperature and every output."""
    if not _esp32_mode():
        sys.exit("hardware.toml [actuators] backend is not \"esp32\".")
    from .esp32 import Esp32Serial
    a = config.HARDWARE["actuators"]
    link = Esp32Serial(a["port"], a["baudrate"])
    link.start()
    end = time.time() + seconds if seconds else None
    try:
        while end is None or time.time() < end:
            time.sleep(1)
            data = link.status()
            if data is None:
                print(f"offline: {link.why_offline()}", flush=True)
                continue
            outputs = "  ".join(f"{d['id']}={'ON' if d.get('on') else 'off'}" + (f"@{d.get('rpm')}" if d.get("type") == "motor" else "")
                                for d in data.get("devices", []))
            print(f"{link.port}  temp={data.get('temp')}  {outputs}", flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        link.close()
    return 0


def read(seconds: float = 0) -> int:
    hw = _hardware()
    keys = ["temperature", "oilMassG", "outputWeightG", "voltage", "current", "stirrerRpm", "centrifugeRpm",
            "purificationStirrerRpm", "heaterSubmerged"] + (["controllerOnline"] if _esp32_mode() else [])
    print("Waiting 2 s for the first readings... (Ctrl+C to stop)")
    time.sleep(2)
    end = time.time() + seconds if seconds else None
    try:
        while end is None or time.time() < end:
            r = hw.refresh()
            print("  ".join(f"{k}={r.get(k)}" for k in keys), flush=True)
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        hw.close()
    return 0


def _ask(prompt: str) -> bool:
    answer = input(f"{prompt} [Enter = yes, s = skip, q = quit] ").strip().lower()
    if answer == "q":
        raise KeyboardInterrupt
    return answer != "s"


def outputs() -> int:
    """Switches each output on for 2 s (motors at 30%). It talks to the pins directly, without the
    process interlocks, so unplug the heater and the power supply output first: you only want to
    hear each relay click and see each LED."""
    print("UNPLUG THE HEATER AND THE ELECTRODE SUPPLY OUTPUT, and remove the centrifuge rotor, before you go on.")
    if _esp32_mode():
        print("ESP32 mode: each step names the ESP32 device from [esp32.devices]; check that the RIGHT part moves.")
    if input("Type yes to continue: ").strip().lower() != "yes":
        return 1
    hw = _hardware()
    devices = config.HARDWARE["esp32"]["devices"] if _esp32_mode() else {}

    def named(label: str, role: str) -> str:
        return f"{label} [ESP32: {_names(devices.get(role)) or 'not fitted'}]" if devices else label

    tests = [(named("Heater relay", "heater"), lambda on: hw._write_heater(on)),
             (named("Electrode power relay", "electrode_power"), lambda on: hw._write_electrode_power(on)),
             *([(named("Oil pump", "oil_pump"), lambda on: hw._write_pump("oil", on))] if "oil" in hw.pumps else []),
             (named("Pump A (NaOH/KOH + methanol)", "catalyst_pump"), lambda on: hw._write_pump("catalyst", on)),
             (named("Pump B (H2SO4 + methanol)", "acid_pump"), lambda on: hw._write_pump("acid", on)),
             (named("Reactor outlet valve (opens, then closes)", "reactor_outlet"), lambda on: hw._write_valve("reactor_outlet", on)),
             (named("Centrifuge outlet valve", "centrifuge_outlet"), lambda on: hw._write_valve("centrifuge_outlet", on)),
             (named("Purification outlet valve", "purification_outlet"), lambda on: hw._write_valve("mesh_bed", on)),
             (named("Reactor stirrer at 30%", "stirrer"), lambda on: hw._write_motor("stirrer", 0.3 if on else 0)),
             ("Centrifuge at 30%" + (" [Pi BTS7960]" if devices else ""), lambda on: hw._write_motor("centrifuge", 0.3 if on else 0)),
             (named("Purification stirrer at 30%", "purification_stirrer"), lambda on: hw._write_motor("purification_stirrer", 0.3 if on else 0))]
    try:
        for label, switch in tests:
            if not _ask(f"\n{label}: switch it on for 2 s?"):
                continue
            try:
                switch(True)
            except Exception as e:           # e.g. not fitted, or the ESP32 is offline
                print(f"  {label}: could not switch on: {e}")
                continue
            time.sleep(2 if "valve" not in label else 8)   # motorized valves take a few seconds to turn
            switch(False)
            print(f"  {label}: off again.")
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        hw.close()
        print("Everything is off.")
    return 0


def calibrate(which: str) -> int:
    """Tare and Calibrate a load cell (the website's Settings -> Hardware does the same). The result
    is saved in loadcell_calibration.json, which wins over hardware.toml."""
    cell = config.HARDWARE["load_cells"].get(which)
    if cell is None:
        sys.exit("Use: calibrate output   or   calibrate reactor")
    from . import drivers
    lgpio, chip = drivers.open_gpiochip(config.HARDWARE.get("gpiochip"))
    hx = drivers.HX711Scale(lgpio, chip, cell["data_pin"], cell["clock_pin"])
    store = drivers.CalibrationStore(config.CALIBRATION_FILE)
    scale = drivers.LoadCell(hx, which, cell.get("offset", 0), cell.get("scale", 1.0), cell.get("samples", 10),
                             cell.get("cal_seconds", 3.0), store)
    try:
        time.sleep(1.5)
        if scale.raw() is None:
            sys.exit(f"No reading from the HX711 on DT GPIO{cell['data_pin']} / SCK GPIO{cell['clock_pin']}. "
                     "Check VCC (3.3 V), GND, DT and SCK, and the pins in hardware.toml.")
        print(f"Now: {scale.grams()} g (raw {scale.raw():.0f}, offset {scale.offset}, scale {scale.scale})")
        input(f"\n1. Empty the {which} load cell (empty reactor / empty container in place), then press Enter.")
        print(f"   offset = {scale.tare()['offset']}")
        grams = float(input("2. Put a known weight on it. How many grams is it? ").strip())
        result = scale.calibrate(grams)
        print(f"   scale = {result['scale']} counts per gram (noise about {result['resolutionG']} g)")
        time.sleep(1.2)
        print(f"   reading now: {scale.grams()} g")
        print(f"\nSaved in {config.CALIBRATION_FILE}. A negative scale is fine (the cell is mounted the other way round).")
    except ValueError as e:
        sys.exit(str(e))
    finally:
        scale.close()
    return 0


def pump(name: str, seconds: float) -> int:
    """Runs one pump for a set time into a measuring jug, to check it and see its flow (mL/min).
    Only for reference: in a batch the operator stops each pump with Done when its container is empty."""
    if name not in ("oil", "catalyst", "acid") or seconds <= 0:
        sys.exit("Use: pump oil 60   (or: pump catalyst 30, pump acid 30)")
    hw = _hardware()
    if name not in hw.pumps:
        hw.close()
        sys.exit(f"This machine has no {name} pump in hardware.toml.")
    try:
        input(f"Put the {name} pump's outlet into a measuring jug, then press Enter to run it for {seconds:g} s.")
        hw._write_pump(name, True)
        end = time.time() + seconds
        while time.time() < end:
            print(f"\r  pumping... {end - time.time():4.0f} s left ", end="", flush=True)
            time.sleep(0.5)
        hw._write_pump(name, False)
        print("\r  stopped.                     ")
        ml = float(input("How many mL are in the jug? ").strip())
        rate = ml / seconds * 60
        print(f"\n  {rate:.0f} mL/min (for reference: in a batch the pump runs until Done is pressed)")
    except (KeyboardInterrupt, ValueError):
        print("\nStopped.")
    finally:
        hw.close()
    return 0


def i2c() -> int:
    try:
        from smbus2 import SMBus
    except ImportError:
        sys.exit("smbus2 is missing: .venv/bin/pip install smbus2")
    known = {0x40: "INA226/INA219 power monitor (default address)",
             0x41: "INA226/INA219 (A0 high)", 0x44: "INA226/INA219", 0x45: "INA226/INA219"}
    found = []
    with SMBus(1) as bus:
        for address in range(0x03, 0x78):
            try:
                bus.read_byte(address)
                found.append(address)
            except OSError:
                pass
    print("I2C bus 1: " + (", ".join(f"0x{a:02x} ({known.get(a, 'unknown')})" for a in found) or "nothing found"))
    return 0


def main(argv: list[str]) -> int:
    command = argv[1] if len(argv) > 1 else "check"
    if command == "check":
        return check()
    if command == "esp32":
        return esp32(float(argv[2]) if len(argv) > 2 else 0)
    if command == "read":
        return read(float(argv[2]) if len(argv) > 2 else 0)
    if command == "outputs":
        return outputs()
    if command == "calibrate":
        return calibrate(argv[2] if len(argv) > 2 else "")
    if command == "i2c":
        return i2c()
    if command == "pump":
        return pump(argv[2] if len(argv) > 2 else "", float(argv[3]) if len(argv) > 3 else 60)
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
