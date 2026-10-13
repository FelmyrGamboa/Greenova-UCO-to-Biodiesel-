"""PiHardware with fake GPIO, I2C and serial libraries, so the Raspberry Pi code is tested on any
computer: hardware.toml handling, pin conflicts, valve and motor types, the HX711 and INA226
drivers, the RPM counter and the level switch."""
import sys
import time
import types
from pathlib import Path

import pytest

from app import config

EXAMPLE = Path(__file__).resolve().parent.parent / "hardware.example.toml"


# ---------- fake libraries ----------
class FakeOutput:
    def __init__(self, pin, active_high=True, initial_value=False, frequency=None):
        self.pin, self.active_high, self.frequency = pin, active_high, frequency
        self.value = initial_value if not isinstance(initial_value, bool) else float(initial_value)
        self.closed = False

    def on(self):
        self.value = 1.0

    def off(self):
        self.value = 0.0

    @property
    def is_active(self):
        return self.value > 0

    def close(self):
        self.closed = True


class FakeButton:
    def __init__(self, pin, pull_up=True):
        self.pin, self.is_pressed = pin, True

    def close(self):
        pass


class FakeInput:
    instances: dict = {}

    def __init__(self, pin, pull_up=True):
        self.pin, self.when_activated = pin, None
        FakeInput.instances[pin] = self

    def close(self):
        pass


class FakeLgpio:
    """An HX711 on (dout, sck) that always returns RAW: one bit per SCK rising edge."""
    RAW = {27: 47000, 10: -2000}

    def __init__(self):
        self.edges, self.sck_of = {}, {}

    def gpiochip_open(self, n):
        return n

    def gpiochip_close(self, h):
        pass

    def gpio_get_chip_info(self, h):
        return (0, 54, f"gpiochip{h}", "pinctrl-bcm2711" if h == 0 else "other")

    def gpio_claim_input(self, h, pin):
        self.edges[pin] = 0

    def gpio_claim_output(self, h, pin, level=0):
        self.sck_of[pin] = {22: 27, 9: 10}.get(pin)

    def gpio_write(self, h, pin, level):
        dout = self.sck_of.get(pin)
        if dout is not None and level == 1:
            self.edges[dout] = self.edges[dout] + 1 if self.edges[dout] < 25 else 1
        if dout is not None and level == 0 and self.edges[dout] == 25:
            self.edges[dout] = 0

    def gpio_read(self, h, pin):
        n = self.edges.get(pin, 0)
        if n == 0 or n > 24:
            return 0                           # ready
        raw = self.RAW[pin] & 0xFFFFFF
        return (raw >> (24 - n)) & 1

    def gpio_free(self, h, pin):
        pass


class FakeSMBus:
    REGS = {0x01: 8000, 0x02: 24000}            # shunt 20 mV, bus 30.0 V (INA226)

    def __init__(self, bus):
        self.written = []

    def write_i2c_block_data(self, address, register, data):
        self.written.append((register, data))

    def read_i2c_block_data(self, address, register, n):
        value = self.REGS[register]
        return [(value >> 8) & 0xFF, value & 0xFF]

    def close(self):
        pass


@pytest.fixture()
def fake_pi(monkeypatch):
    gpiozero = types.ModuleType("gpiozero")
    gpiozero.OutputDevice = FakeOutput
    gpiozero.PWMOutputDevice = lambda pin, frequency=100, initial_value=0: FakeOutput(pin, True, initial_value, frequency)
    gpiozero.Button = FakeButton
    gpiozero.DigitalInputDevice = FakeInput
    smbus2 = types.ModuleType("smbus2")
    smbus2.SMBus = FakeSMBus
    monkeypatch.setitem(sys.modules, "gpiozero", gpiozero)
    monkeypatch.setitem(sys.modules, "lgpio", FakeLgpio())
    monkeypatch.setitem(sys.modules, "smbus2", smbus2)
    monkeypatch.setattr("app.drivers.read_ds18b20", lambda sensor_id="": 31.5)


def _config(**changes):
    cfg = config.load_hardware(Path("/nonexistent.toml"))
    for path, value in changes.items():
        node = cfg
        keys = path.split(".")
        for key in keys[:-1]:
            node = node[key]
        node[keys[-1]] = value
    return cfg


def test_example_file_matches_the_defaults():
    from_file = config.load_hardware(EXAMPLE)
    assert from_file == config.HARDWARE_DEFAULTS
    assert config.check_hardware(from_file) == []


def test_pin_conflicts_are_found():
    cfg = _config(**{"pumps.acid": 23})
    assert any("GPIO23 is used twice" in p for p in config.check_hardware(cfg))
    cfg = _config(**{"relays.heater": 17})
    assert any("strip reader LED" in p for p in config.check_hardware(cfg))
    cfg = _config(**{"load_cells.reactor.enabled": True, "load_cells.reactor.data_pin": 5})
    assert any("GPIO5 is used twice" in p for p in config.check_hardware(cfg))


def test_pi_hardware_with_all_sensors(fake_pi):
    from app.hardware import PiHardware
    cfg = _config(**{
        "relays.active_high": False,
        "valves.reactor_outlet": {"mode": "dual", "open_pin": 16, "close_pin": 8},
        "motors.centrifuge": {"type": "esc", "pin": 13},
        "level_switch.enabled": True,
        "load_cells.reactor.enabled": True, "load_cells.reactor.offset": 1000, "load_cells.reactor.scale": 100,
        "load_cells.output.enabled": True, "load_cells.output.offset": -2000, "load_cells.output.scale": 50,
        "power_monitor.type": "ina226",
        "rpm.centrifuge.enabled": True,
    })
    hw = PiHardware(cfg)
    try:
        time.sleep(0.4)                                   # let the background samplers read once
        r = hw.refresh()
        assert r["oilMassG"] == 460.0                     # (47000 - 1000) / 100
        assert r["outputWeightG"] == 0.0                  # empty container
        assert r["temperature"] == 31.5
        assert (r["voltage"], r["current"]) == (30.0, 1.0)   # 24000 × 1.25 mV; 20 mV / 0.02 Ω
        assert r["heaterSubmerged"] is True and r["stirrerRpm"] is None
        assert r["centrifugeRpm"] == 0
        counter = FakeInput.instances[19]
        for _ in range(100):                              # 100 pulses in the 2 s window = 3000 RPM
            counter.when_activated()
        assert hw._read_rpm("centrifuge") == 3000
        assert hw._heater.active_high is False            # active-low relay board

        # 3-wire valve: OPEN and CLOSE are never powered together
        _, open_relay, close_relay = hw._valves["reactor_outlet"]
        hw.set_valve("reactor_outlet", True)
        assert (open_relay.value, close_relay.value) == (1.0, 0.0)
        hw.set_valve("reactor_outlet", False)
        assert (open_relay.value, close_relay.value) == (0.0, 1.0)

        # ESC: 1 ms (stopped) to 2 ms (full) of a 20 ms period
        _, esc = hw._motors["centrifuge"]
        assert esc.frequency == 50 and esc.value == 0.05
        hw.set_motor("centrifuge", 1.0)
        assert esc.value == pytest.approx(0.10)
        hw.set_motor("centrifuge", 0.0)
        assert esc.value == pytest.approx(0.05)

        # the interlocks still apply on the real hardware
        hw.set_motor("purification_stirrer", 0.33)
        hw.set_heater(True)
        assert hw._heater.value == 1.0
        hw.set_valve("mesh_bed", True)                    # opening the outlet turns the heater off first
        assert hw._heater.value == 0.0 and hw.heater_on is False
    finally:
        hw.close()


def test_pi_hardware_without_optional_sensors(fake_pi):
    """Nothing enabled: readings are None (the backend works around them), except temperature."""
    from app.hardware import PiHardware
    hw = PiHardware(_config())
    try:
        time.sleep(0.2)
        r = hw.refresh()
        assert r["temperature"] == 31.5
        for key in ("oilMassG", "outputWeightG", "voltage", "current", "stirrerRpm", "heaterSubmerged"):
            assert r[key] is None, key
    finally:
        hw.close()


def test_pi_hardware_refuses_a_bad_configuration(fake_pi):
    from app.hardware import PiHardware
    with pytest.raises(RuntimeError, match="used twice"):
        PiHardware(_config(**{"pumps.acid": 5}))
