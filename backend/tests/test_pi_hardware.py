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
            self.edges[dout] = -1              # the 25th pulse pulls DT high until the next conversion

    def gpio_read(self, h, pin):
        n = self.edges.get(pin, 0)
        if n == -1:
            self.edges[pin] = 0                # high once, then the next conversion is ready
            return 1
        if n > 24:
            return 1
        if n == 0:
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
    """The older all-on-the-Pi wiring ([actuators] backend = "gpio") with its original pins."""
    cfg = config.load_hardware(Path("/nonexistent.toml"))
    cfg["actuators"]["backend"] = "gpio"
    cfg["load_cells"]["reactor"].update(enabled=False, data_pin=27, clock_pin=22, samples=3)
    cfg["load_cells"]["output"].update(enabled=False, data_pin=10, clock_pin=9, samples=3)
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


def test_gpio_wiring_has_no_conflicts():
    assert config.check_hardware(_config()) == []


def test_pin_conflicts_are_found():
    cfg = _config(**{"pumps.acid": 23})
    assert any("GPIO23 is used twice" in p for p in config.check_hardware(cfg))
    cfg = _config(**{"relays.heater": 2})
    assert any("already used by the I2C SDA" in p for p in config.check_hardware(cfg))
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


def test_esp32_mode_needs_the_pi_libraries(monkeypatch):
    """Hardware mode on a computer without lgpio: a clear message instead of a traceback.
    (The ESP32 mode itself is tested in test_esp32.py.)"""
    from app.hardware import create_hardware
    monkeypatch.setitem(config.HARDWARE["actuators"], "backend", "esp32")
    monkeypatch.setitem(sys.modules, "lgpio", None)          # import lgpio -> ImportError
    with pytest.raises(RuntimeError, match="needs lgpio and pyserial"):
        create_hardware()


def test_hx711_conversion_with_a_long_clock_pulse_is_thrown_away(monkeypatch):
    """SCK high for 60 µs or more powers the HX711 down mid-read: that conversion is spoiled and
    dropped (None), the next one counts again."""
    from app import drivers
    lg = FakeLgpio()
    hx = drivers.HX711Scale(lg, 0, 27, 22)

    def good_read():                     # (the test machine itself may pause a pulse now and then)
        return next((v for v in (hx.read_raw() for _ in range(20)) if v is not None), None)
    assert good_read() == 47000
    ticks = iter([0.0, 0.0001] + [0.0] * 200)                   # the first pulse took 100 µs
    monkeypatch.setattr(drivers.time, "perf_counter", lambda: next(ticks))
    spoiled = hx.spoiled
    assert hx.read_raw() is None and hx.spoiled == spoiled + 1
    monkeypatch.undo()
    assert good_read() == 47000


class _FakeHx:
    """An HX711 whose next conversions come from a function (raw counts)."""
    def __init__(self, value):
        self.value, self.spoiled = value, 0

    def read_raw(self):
        time.sleep(0.005)
        return self.value() if callable(self.value) else self.value

    def close(self):
        pass


def _cell(hx, **kw):
    from app import drivers
    cell = drivers.LoadCell(hx, "output", offset=0, scale=100.0, samples=10, cal_seconds=0.3, **kw)
    cell.POLL_S = 0.001
    return cell


def test_load_cell_ignores_a_lone_spike_but_follows_a_real_change():
    import itertools
    values = itertools.chain([10_000] * 30, [900_000], itertools.repeat(10_000))
    hx = _FakeHx(lambda: next(values))
    cell = _cell(hx)
    try:
        time.sleep(0.4)
        assert cell.grams() == 100.0                       # the 900 000 bit error never shows
        hx.value = 60_000                                  # a 500 g weight put on: a real change
        time.sleep(0.3)
        assert cell.grams() == 600.0
    finally:
        cell.close()


def test_load_cell_multi_point_calibration_and_tare_first():
    """Tare, then one or more known weights: the scale is the least-squares line through them and
    each weight's error is reported. A weight without a Tare first is refused."""
    import pytest as _pytest
    hx = _FakeHx(50_000)
    cell = _cell(hx)
    try:
        time.sleep(0.2)
        with _pytest.raises(ValueError, match="Tare first"):
            cell.calibrate(500)
        cell.tare()
        hx.value = 50_000 + 500 * 212                      # 500 g reads 212 counts per gram ...
        time.sleep(0.15)
        first = cell.calibrate(500)
        assert first["scale"] == _pytest.approx(212) and first["points"] == [{"grams": 500.0, "errorG": 0.0}]
        hx.value = 50_000 + 1000 * 208                     # ... and 1000 g 208 per gram (a slightly curved cell)
        time.sleep(0.15)
        both = cell.calibrate(1000)
        assert 208 < both["scale"] < 212 and len(both["points"]) == 2 and both["offset"] == 50_000
        assert all(abs(p["errorG"]) < 10 for p in both["points"])          # the zero stays exactly at the tare
        assert cell.status()["points"] == both["points"]
    finally:
        cell.close()


def test_load_cell_refuses_an_unsteady_reading():
    import pytest as _pytest
    import random
    hx = _FakeHx(lambda: 50_000 + random.randint(-1500, 1500))   # ±7 g at ~200 counts per gram
    cell = _cell(hx)
    try:
        time.sleep(0.2)
        cell.tare()
        hx.value = lambda: 150_000 + random.randint(-1500, 1500)
        time.sleep(0.15)
        with _pytest.raises(ValueError, match="isn't steady"):
            cell.calibrate(500)
    finally:
        cell.close()


def test_load_cell_zero_tracking_only_near_zero_and_when_allowed():
    hx = _FakeHx(10_150)                                   # empty, but the zero drifted to +1.5 g
    cell = _cell(hx)
    cell.offset = 10_000
    cell.ZERO_STEADY_S = 1.0
    try:
        allowed = {"on": False}
        cell.zero_tracking = lambda: allowed["on"]
        time.sleep(1.5)
        assert cell.grams() == 1.5                         # a process is running: no tracking
        allowed["on"] = True
        deadline = time.time() + 15
        while abs(cell.grams()) > 0.3 and time.time() < deadline:
            time.sleep(0.2)
        assert abs(cell.grams()) <= 0.3                    # idle: the zero followed the drift
        hx.value = 10_000 + 100 * 300                      # 300 g on it: far from zero, never tracked
        time.sleep(1.5)
        before = cell.offset
        time.sleep(1.5)
        assert cell.offset == before
    finally:
        cell.close()
