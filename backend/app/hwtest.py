"""Hardware bench test for the Raspberry Pi. Run it from the backend folder, with the Greenova
service stopped (only one program can use the GPIO pins):

    sudo systemctl stop greenova
    .venv/bin/python -m app.hwtest check                # hardware.toml: pins, conflicts, which parts are on
    .venv/bin/python -m app.hwtest read                 # every sensor, once per second (Ctrl+C to stop)
    .venv/bin/python -m app.hwtest outputs              # switch each relay, pump, valve and motor, one by one
    .venv/bin/python -m app.hwtest calibrate reactor    # load cell offset and scale (or: output)
    .venv/bin/python -m app.hwtest i2c                  # list the I2C devices (power monitor, strip reader)

Full guide: docs/RASPBERRY_PI_SETUP.md.
"""
import sys
import time

from . import config


def _hardware():
    from .hardware import PiHardware
    try:
        return PiHardware()
    except ImportError as e:
        sys.exit(f"Missing library: {e}. Run setup-pi.sh first (it installs gpiozero, lgpio, smbus2, pyserial).")
    except RuntimeError as e:
        sys.exit(str(e))


def check() -> int:
    hw = config.HARDWARE
    print(f"Hardware file: {config.HARDWARE_FILE} ({'found' if config.HARDWARE_FILE.is_file() else 'NOT found: using the defaults'})")
    print(f"Relays switch ON when the input is {'HIGH' if hw['relays']['active_high'] else 'LOW'} (relays.active_high)")
    print("\nPins in use (BCM numbers):")
    for pin, what in sorted(config.used_pins(hw)):
        print(f"  GPIO{pin:<3} {what}")
    print("\nSensors:")
    print(f"  temperature        {hw['temperature']['type']}")
    for key, cell in hw["load_cells"].items():
        print(f"  load cell {key:<8} {'on' if cell.get('enabled') else 'off'}"
              + (f" (offset {cell.get('offset')}, scale {cell.get('scale')})" if cell.get("enabled") else ""))
    print(f"  power monitor      {hw['power_monitor']['type']}"
          + (f" at 0x{hw['power_monitor']['address']:02x}, shunt {hw['power_monitor']['shunt_ohms']} Ω"
             if hw["power_monitor"]["type"] != "none" else ""))
    for key, r in hw["rpm"].items():
        print(f"  rpm {key:<14} {'on' if r.get('enabled') else 'off'}")
    print(f"  level switch       {'on' if hw['level_switch'].get('enabled') else 'off (the operator confirms the heater is covered)'}")
    print(f"  power supply       {hw['power_supply']['control']}")
    problems = config.check_hardware(hw)
    print("\n" + ("Problems:\n  " + "\n  ".join(problems) if problems else "No pin conflicts."))
    return 1 if problems else 0


def read(seconds: float = 0) -> int:
    hw = _hardware()
    keys = ["temperature", "oilMassG", "outputWeightG", "voltage", "current", "stirrerRpm", "centrifugeRpm",
            "purificationStirrerRpm", "heaterSubmerged"]
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
    if input("Type yes to continue: ").strip().lower() != "yes":
        return 1
    hw = _hardware()
    tests = [("Heater relay", lambda on: hw._write_heater(on)),
             ("Electrode power relay", lambda on: hw._write_electrode_power(on)),
             ("Pump A (NaOH/KOH + methanol)", lambda on: hw._write_pump("catalyst", on)),
             ("Pump B (H2SO4 + methanol)", lambda on: hw._write_pump("acid", on)),
             ("Reactor outlet valve (opens, then closes)", lambda on: hw._write_valve("reactor_outlet", on)),
             ("Centrifuge outlet valve", lambda on: hw._write_valve("centrifuge_outlet", on)),
             ("Purification outlet valve", lambda on: hw._write_valve("mesh_bed", on)),
             ("Reactor stirrer at 30%", lambda on: hw._write_motor("stirrer", 0.3 if on else 0)),
             ("Centrifuge at 30%", lambda on: hw._write_motor("centrifuge", 0.3 if on else 0)),
             ("Purification stirrer at 30%", lambda on: hw._write_motor("purification_stirrer", 0.3 if on else 0))]
    try:
        for label, switch in tests:
            if not _ask(f"\n{label}: switch it on for 2 s?"):
                continue
            switch(True)
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
    cell = config.HARDWARE["load_cells"].get(which)
    if cell is None:
        sys.exit("Use: calibrate reactor   or   calibrate output")
    from . import drivers
    lgpio, chip = drivers.open_gpiochip(config.HARDWARE.get("gpiochip"))
    scale = drivers.HX711Scale(lgpio, chip, cell["data_pin"], cell["clock_pin"])
    try:
        input(f"\n1. Empty the {which} load cell (empty reactor / empty container in place), then press Enter.")
        empty = scale.read_average_raw(15)
        if empty is None:
            sys.exit("No reading from the HX711. Check VCC (3.3 V), GND, DT and SCK, and the pins in hardware.toml.")
        print(f"   raw empty = {empty:.0f}")
        grams = float(input("2. Put a known weight on it. How many grams is it? ").strip())
        full = scale.read_average_raw(15)
        if full is None or grams <= 0:
            sys.exit("No reading, or a weight of 0 g.")
        factor = (full - empty) / grams
        print(f"   raw with {grams:g} g = {full:.0f}")
        if abs(factor) < 1:
            print("   Warning: the reading hardly changed. Check the load cell wires (E+, E-, A+, A-).")
        print(f"\nPut this in hardware.toml under [load_cells.{which}]:\n"
              f"  enabled = true\n  offset = {empty:.0f}\n  scale = {factor:.3f}\n")
        print("A negative scale is fine (the cell is mounted the other way round).")
    finally:
        scale.close()
    return 0


def i2c() -> int:
    try:
        from smbus2 import SMBus
    except ImportError:
        sys.exit("smbus2 is missing: .venv/bin/pip install smbus2")
    known = {0x29: "TCS34725 strip reader", 0x40: "INA226/INA219 power monitor (default address)",
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
    if command == "read":
        return read(float(argv[2]) if len(argv) > 2 else 0)
    if command == "outputs":
        return outputs()
    if command == "calibrate":
        return calibrate(argv[2] if len(argv) > 2 else "")
    if command == "i2c":
        return i2c()
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
