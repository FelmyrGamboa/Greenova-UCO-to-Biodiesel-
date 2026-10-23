"""ESP32 hardware mode with a simulated ESP32 on a fake serial port and fake lgpio, so the real
machine's code runs on any computer.

FakeEsp32 follows firmware/esp32_process_control/esp32_process_control.ino: the same devices (all
relays: the 8-channel board, the heater relay and the 4-channel board with mixer1, mixer2, extra and
centrifuge), the same text commands ("heater on 5", "mixer2 on 5", "valve off", "alloff", "json"),
its timed ON (auto-off after the seconds), and the one-line STATUS {...} answer to "json".
FakeLgpio has the Pi's one BTS7960 that sets the speed of whichever motor's relay is on."""
import json
import sys
import threading
import time
import types
from pathlib import Path

import pytest

from app import config

DEVICES = [("dispenser1", "Dispenser 1", "relay"), ("dispenser2", "Dispenser 2", "relay"),
           ("reactorpump", "Reactor Pump", "relay"), ("pumpin", "Pump In", "relay"), ("oil", "Oil", "relay"),
           ("pumpout", "Pump Out", "relay"), ("valve", "Valve", "relay"), ("electrode", "Electrode", "relay"),
           ("heater", "Heater", "relay"), ("mixer1", "Mixer 1", "relay"), ("mixer2", "Mixer 2", "relay"),
           ("extra", "Extra", "relay"), ("centrifuge", "Centrifuge", "relay")]


class FakeEsp32:
    """The ESP32 sketch behind a pyserial-like object."""

    def __init__(self, temp=31.25):
        self.temp = temp
        self.devs = {i: {"id": i, "label": label, "on": False, "timed": False, "start": 0.0, "dur": 0.0}
                     for i, label, _ in DEVICES}
        self.rx = bytearray()
        self.lines: list[str] = []          # every command line received
        self.silent = False                 # True: the ESP32 stops answering (hung / reset)
        self.broken = False                 # True: the USB cable is unplugged
        self.ignore_on: set = set()         # devices whose "on" doesn't take (e.g. a garbled command)
        self.closed = False
        self._lock = threading.Lock()

    # --- pyserial-like ---
    @property
    def in_waiting(self):
        self._tick()
        return len(self.rx)

    def read(self, n=1):
        if self.broken:
            raise OSError("device reports readiness to read but returned no data (unplugged?)")
        self._tick()
        with self._lock:
            data = bytes(self.rx[:n])
            del self.rx[:n]
        if not data:
            time.sleep(0.01)
        return data

    def write(self, data: bytes):
        if self.broken:
            raise OSError("write failed: device disconnected")
        for line in data.decode().splitlines():
            self._handle(line)
        return len(data)

    def reset_input_buffer(self):
        with self._lock:
            self.rx.clear()

    def close(self):
        self.closed = True

    # --- the sketch ---
    def _out(self, text: str) -> None:
        if not self.silent:
            with self._lock:
                self.rx += (text + "\r\n").encode()

    def _tick(self) -> None:
        now = time.monotonic()
        for d in self.devs.values():
            if d["on"] and d["timed"] and now - d["start"] >= d["dur"]:
                d["on"] = d["timed"] = False
                self._out(f"[timer] {d['label']} -> OFF")

    def _set(self, d, on, sec=0):
        d["on"], d["timed"], d["start"], d["dur"] = on, on and sec > 0, time.monotonic(), float(sec)
        self._out(f"{d['label']} -> {'ON' if on else 'OFF'}" + (f" for {sec} s" if on and sec > 0 else ""))

    def status_json(self) -> str:
        self._tick()
        return json.dumps({"temp": self.temp, "devices": [
            {"id": d["id"], "label": d["label"], "on": d["on"], "remaining": 0}
            for d in self.devs.values()]}, separators=(",", ":"))

    def _handle(self, line: str) -> None:
        line = line.strip().lower()
        if not line:
            return
        self.lines.append(line)
        if self.silent:
            return
        w = line.split()[:3]                # the sketch reads up to 3 words
        if w[0] == "alloff":
            for d in self.devs.values():
                self._set(d, False)
            return
        if w[0] == "json":
            self._out("STATUS " + self.status_json())
            return
        d = self.devs.get(w[0])
        if d is None:
            self._out("Unknown command. Type: help")
            return
        if len(w) > 1 and w[1] == "on":
            if w[0] in self.ignore_on:
                return
            sec = max(int(w[2]), 0) if len(w) >= 3 else 0
            self._set(d, True, sec)
        elif len(w) > 1 and w[1] == "off":
            self._set(d, False)
        else:
            self._out("Use: <device> on [seconds] | off")

    def on(self, device: str) -> bool:
        self._tick()
        return self.devs[device]["on"]


class FakeLgpio:
    """lgpio with two HX711s (output: DT 17 / SCK 27, reactor: DT 5 / SCK 6), the BTS7960 pins and
    a level switch on GPIO26."""
    SET_PULL_UP = 32

    def __init__(self):
        self.raw = {17: 41028 + 145759, 5: 1000}     # 1 kg on the output cell (with the default calibration)
        self.sck_of = {27: 17, 6: 5}
        self.edges = {17: 0, 5: 0}
        self.level = {}
        self.pwm = {}
        self.claimed = set()
        self.freed = set()

    def gpiochip_open(self, n):
        return n

    def gpiochip_close(self, h):
        pass

    def gpio_get_chip_info(self, h):
        return (0, 54, f"gpiochip{h}", "pinctrl-rp1" if h == 0 else "other")

    def gpio_claim_input(self, h, pin, flags=0):
        self.claimed.add(pin)

    def gpio_claim_output(self, h, pin, level=0):
        self.claimed.add(pin)
        self.level[pin] = level

    def gpio_write(self, h, pin, level):
        self.level[pin] = level
        dout = self.sck_of.get(pin)
        if dout is None:
            return
        if level == 1:
            self.edges[dout] = self.edges[dout] + 1 if self.edges[dout] < 25 else 1
        elif self.edges[dout] == 25:
            self.edges[dout] = -1               # the 25th pulse pulls DT high until the next conversion

    def gpio_read(self, h, pin):
        if pin in self.edges:
            n = self.edges[pin]
            if n == -1:
                self.edges[pin] = 0                  # high once, then the next conversion is ready
                return 1
            if n > 24:
                return 1
            if n == 0:
                return 0                             # data ready
            return (self.raw[pin] & 0xFFFFFF) >> (24 - n) & 1
        return self.level.get(pin, 1)

    def tx_pwm(self, h, pin, freq, duty, *args):
        self.pwm[pin] = (freq, duty)

    def gpio_free(self, h, pin):
        self.freed.add(pin)


def wait_until(condition, timeout=3.0, what="condition"):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if condition():
            return
        time.sleep(0.02)
    raise AssertionError(f"timed out waiting for {what}")


@pytest.fixture()
def lg(monkeypatch):
    fake = FakeLgpio()
    monkeypatch.setitem(sys.modules, "lgpio", fake)
    from app import drivers
    monkeypatch.setattr(drivers.LoadCell, "SETTLE_S", 0.05)   # 1 s on the machine
    return fake


def _cfg(**changes):
    cfg = config.load_hardware(Path("/nonexistent.toml"))
    cfg["esp32"]["poll_seconds"] = 0.05
    cfg["esp32"]["offline_after_seconds"] = 0.4
    for key in ("reactor", "output"):
        cfg["load_cells"][key]["cal_seconds"] = 0.3
    cfg["motor_driver"]["relay_settle_s"] = 0.1
    for path, value in changes.items():
        node = cfg
        keys = path.split(".")
        for key in keys[:-1]:
            node = node[key]
        node[keys[-1]] = value
    return cfg


def _machine(lg, tmp_path, esp=None, **changes):
    from app.esp32 import Esp32Hardware, Esp32Serial
    esp = esp or FakeEsp32()
    link = Esp32Serial("/dev/ttyFAKE", 115200, poll_seconds=0.05, offline_after_seconds=0.4, open_wait_seconds=0,
                       command_gap_seconds=0, opener=lambda port, baud: esp)
    hw = Esp32Hardware(_cfg(**changes), link=link, calibration_file=tmp_path / "cal.json")
    wait_until(lambda: link.online, what="the ESP32 to answer")
    return hw, esp


def test_defaults_match_the_supplied_wiring():
    hw = config.load_hardware(Path("/nonexistent.toml"))
    assert config.actuator_backend(hw) == "esp32"
    assert config.check_hardware(hw) == []
    pins = dict((what, pin) for pin, what in config.used_pins(hw))
    assert (pins["motor_driver.l_en"], pins["motor_driver.r_en"], pins["motor_driver.lpwm"],
            pins["motor_driver.rpwm"]) == (23, 24, 25, 21)          # one BTS7960 for the three motors
    assert (pins["load_cells.output.data_pin"], pins["load_cells.output.clock_pin"]) == (17, 27)
    assert "relays.heater" not in pins                      # the relays are on the ESP32, not the Pi
    devices = hw["esp32"]["devices"]
    assert devices["heater"] == "heater" and devices["purification_stirrer"] == "mixer2"
    assert devices["stirrer"] == "mixer1" and devices["centrifuge"] == "centrifuge"   # the 4-channel relay
    # the operator's machine: oil = oil input, pumpin = centrifuge -> purifier,
    # valve + pumpout = purifier -> output container after purification
    assert devices["oil_pump"] == "oil" and devices["reactor_outlet"] == "reactorpump"
    assert devices["centrifuge_outlet"] == "pumpin" and devices["purification_outlet"] == ["valve", "pumpout"]


def test_pin_conflicts_in_esp32_mode():
    cfg = _cfg(**{"motor_driver.l_en": 17})
    assert any("GPIO17 is used twice" in p for p in config.check_hardware(cfg))
    cfg = _cfg(**{"level_switch.enabled": True, "level_switch.pin": 27})
    assert any("GPIO27 is used twice" in p for p in config.check_hardware(cfg))
    cfg = _cfg(**{"power_supply.control": "serial", "power_supply.port": "/dev/ttyUSB0", "actuators.port": "/dev/ttyUSB0"})
    assert any("can't share" in p for p in config.check_hardware(cfg))


def test_outputs_go_through_the_esp32_with_a_dead_man_timer(lg, tmp_path):
    hw, esp = _machine(lg, tmp_path)
    try:
        assert "alloff" in esp.lines                         # a fresh connection starts with everything off
        r = hw.refresh()
        assert r["temperature"] == 31.2 and r["controllerOnline"] is True and r["controllerError"] is None
        assert r["purificationStirrerRpm"] == 0 and r["stirrerRpm"] == 0

        # dry wash stirrer: its relay (mixer2) on, then the Pi's BTS7960 at 200 RPM
        full = hw.full_speed_rpm("purification_stirrer")
        assert full == 1544
        hw.set_motor("purification_stirrer", 200 / full)
        assert "mixer2 on 5" in esp.lines and esp.on("mixer2")
        wait_until(lambda: esp.lines.count("mixer2 on 5") >= 3, what="the dead-man refresh")

        hw.set_heater(True)                                  # interlock: only with the stirrer running
        assert esp.on("heater") and "heater on 5" in esp.lines
        wait_until(lambda: hw.refresh()["purificationStirrerRpm"] == 200, what="the RPM reading")

        # opening the purification outlet turns the heater off first (interlock in Hardware)
        hw.set_valve("mesh_bed", True)
        assert not esp.on("heater") and esp.on("valve") and hw.heater_on is False

        # pumps and the reactor outlet: the interlocks still apply
        hw.set_valve("mesh_bed", False)
        hw.set_pump("catalyst", True)
        assert esp.on("dispenser1")
        from app.hardware import InterlockError
        with pytest.raises(InterlockError):
            hw.set_valve("reactor_outlet", True)
        assert not esp.on("reactorpump")
        hw.set_pump("catalyst", False)
        hw.set_valve("reactor_outlet", True)
        assert esp.on("reactorpump")

        # an output switched on behind the Pi's back (the ESP32's web page) is switched off again
        esp._set(esp.devs["heater"], True)
        wait_until(lambda: not esp.on("heater"), what="the heater to be switched off again")

        hw.all_off()
        assert esp.lines[-1] == "alloff" or "alloff" in esp.lines[-3:]
        assert not any(esp.on(d) for d, _, _ in DEVICES)
        assert hw.link_fault is None
    finally:
        hw.close()
    assert esp.closed


def test_esp32_switches_off_by_itself_when_the_pi_stops(lg, tmp_path):
    hw, esp = _machine(lg, tmp_path, **{"esp32.lease_seconds": 1})
    try:
        hw.set_motor("purification_stirrer", 0.2)
        hw.set_heater(True)
        assert esp.on("heater")
        time.sleep(1.3)
        assert esp.on("heater")                              # refreshed every poll: stays on
        hw.link._stop.set()                                  # the backend stops (crash, cable, Pi off)
        time.sleep(1.3)
        assert not esp.on("heater") and not esp.on("mixer2")   # the ESP32's own timer switched them off
    finally:
        hw.link._stop.clear()
        hw.close()


def test_lost_link_is_a_fault_and_everything_switches_off(lg, tmp_path):
    hw, esp = _machine(lg, tmp_path)
    try:
        hw.set_motor("stirrer", 0.3)
        hw.set_electrode_power(True)
        assert hw.any_output_on()
        esp.silent = True                                    # the ESP32 stops answering
        wait_until(lambda: hw.link_fault is not None, what="the link fault")
        assert "offline" in hw.link_fault
        r = hw.refresh()
        assert r["temperature"] is None and r["controllerOnline"] is False
        assert not hw.any_output_on()                        # the Pi's view follows the ESP32's timers
        from app.hardware import InterlockError
        with pytest.raises(InterlockError, match="offline"):
            hw.set_electrode_power(True)

        esp.silent = False                                   # back: no output comes back on by itself
        wait_until(lambda: hw.link.online, what="the link to come back")
        wait_until(lambda: not esp.on("electrode") and not esp.on("mixer1"), what="the outputs to go off")
        assert hw.link_fault is None

        esp.broken = True                                    # unplugged: reconnects when it's back
        wait_until(lambda: not hw.link.connected, what="the port to drop")
        esp.broken = False
        wait_until(lambda: hw.link.online, timeout=5, what="reconnection")
    finally:
        hw.close()


def test_output_that_does_not_follow_is_a_fault(lg, tmp_path):
    esp = FakeEsp32()
    esp.ignore_on.add("dispenser2")
    hw, _ = _machine(lg, tmp_path, esp)
    try:
        hw.set_pump("acid", True)                            # sent, but the ESP32 stays off
        wait_until(lambda: hw.link_fault is not None, what="the command fault")
        assert "did not switch" in hw.link_fault and "dispenser2" in hw.link_fault
        hw.all_off()                                         # the emergency stop clears it
        assert hw.link_fault is None
    finally:
        hw.close()


def test_wrong_device_name_is_reported(lg, tmp_path):
    hw, esp = _machine(lg, tmp_path, **{"esp32.devices.heater": "heatr", "esp32.devices.stirrer": "valve"})
    try:
        wait_until(lambda: hw.link_fault is not None, what="the configuration fault")
        assert '"heatr" (no such device' in hw.link_fault
        from app.hardware import InterlockError
        with pytest.raises(InterlockError, match="hardware.toml"):
            hw.set_motor("purification_stirrer", 0.2)       # nothing switches on until it's fixed
        assert not esp.on("mixer2")
    finally:
        hw.close()


def test_not_fitted_and_time_limited_outputs(lg, tmp_path):
    hw, esp = _machine(lg, tmp_path, **{"esp32.devices.centrifuge_outlet": "",
                                        "esp32.devices.reactor_outlet": ["reactorpump", "pumpin"],
                                        "esp32.max_on_seconds": {"reactor_outlet": 1}})
    try:
        from app.hardware import InterlockError
        with pytest.raises(InterlockError, match="no ESP32 output"):
            hw.set_valve("centrifuge_outlet", True)
        hw.set_valve("centrifuge_outlet", False)             # off is always fine
        hw.set_valve("reactor_outlet", True)                 # a transfer pump: runs 1 s, then stops itself
        assert esp.on("reactorpump") and esp.on("pumpin") and "reactorpump on 1" in esp.lines
        time.sleep(1.4)
        assert not esp.on("reactorpump") and not esp.on("pumpin")
        assert hw.valves["reactor_outlet"] is True and hw.link_fault is None   # no false fault
        assert esp.lines.count("reactorpump on 1") == 1     # not refreshed
    finally:
        hw.close()


def test_centrifuge_relay_then_the_pi_sets_its_speed(lg, tmp_path):
    """The centrifuge: its ESP32 relay (4-channel IN4) on first, then the Pi's BTS7960 at the set
    speed relay_settle_s later; off: the PWM first, then the relay."""
    hw, esp = _machine(lg, tmp_path)
    try:
        assert hw.full_speed_rpm("centrifuge") == 2500
        hw.set_motor("centrifuge", 1500 / 2500)
        assert esp.on("centrifuge") and "centrifuge on 5" in esp.lines
        assert lg.pwm.get(21, (0, 0))[1] == 0                # no PWM while the relay is still closing
        wait_until(lambda: lg.pwm.get(21, (0, 0))[1] == 60.0, timeout=1, what="the PWM after the relay")
        assert lg.pwm[21] == (1000, 60.0)                    # RPWM: 60 % duty at 1 kHz
        assert lg.level[23] == 1 and lg.level[24] == 1       # L_EN, R_EN
        wait_until(lambda: hw.refresh()["centrifugeRpm"] == 1500, what="the set speed shown")
        assert not hw.rpm_is_measured("centrifugeRpm")       # open loop: the RPM is the set speed
        hw.set_valve("centrifuge_outlet", True)              # pumpin runs while it spins (separation)
        assert esp.on("pumpin")
        hw.set_valve("centrifuge_outlet", False)
        order = []
        write = lg.gpio_write
        lg.gpio_write = lambda h, pin, level: (order.append(("pin", pin, level)), write(h, pin, level))[1]
        send = hw.link.send
        hw.link.send = lambda cmd: (order.append(("esp", cmd)), send(cmd))[1]
        hw.set_motor("centrifuge", 0)
        lg.gpio_write, hw.link.send = write, send
        assert order.index(("pin", 23, 0)) < order.index(("esp", "centrifuge off"))   # PWM off before the relay
        assert not esp.on("centrifuge") and lg.level[23] == 0
        wait_until(lambda: hw.refresh()["centrifugeRpm"] == 0, what="the stop")
    finally:
        hw.close()
    assert {21, 23, 24, 25} <= lg.freed


def test_load_cell_reading_tare_and_calibrate(lg, tmp_path):
    hw, esp = _machine(lg, tmp_path)
    try:
        wait_until(lambda: hw.refresh()["outputWeightG"] is not None, what="a weight")
        assert hw.refresh()["outputWeightG"] == pytest.approx(1000.0, abs=0.2)
        assert hw.refresh()["oilMassG"] is None              # no reactor load cell by default
        assert hw.refresh()["loadCellsFitted"] == {"reactor": False, "output": True}
        lg.raw[17] = 50_000                                  # empty container
        time.sleep(0.3)
        result = hw.tare_load_cell("output")
        assert result["offset"] == 50_000
        assert hw.refresh()["outputWeightG"] == 0.0
        lg.raw[17] = 50_000 + 500 * 210                      # 500 g at 210 counts per gram
        time.sleep(0.3)
        result = hw.calibrate_load_cell("output", 500)
        assert result["scale"] == pytest.approx(210)
        assert hw.refresh()["outputWeightG"] == pytest.approx(500.0)
        with pytest.raises(ValueError):
            hw.tare_load_cell("reactor")
        saved = json.loads((tmp_path / "cal.json").read_text())
        assert saved["output"]["offset"] == 50_000 and saved["output"]["scale"] == pytest.approx(210)
    finally:
        hw.close()
    hw2, _ = _machine(lg, tmp_path)                          # the calibration survives a restart
    try:
        cell = next(c for c in hw2.load_cells() if c["key"] == "output")
        assert cell["scale"] == pytest.approx(210) and cell["calibratedAt"]
    finally:
        hw2.close()


def test_load_cell_calibration_needs_a_fresh_tare_and_fits_several_weights(lg, tmp_path):
    """Calibrate is refused without a Tare in the same sitting (an old zero gave a wrong scale).
    Each known weight after the Tare is a point; the scale is the best fit through all of them,
    and each point's error is returned. Check reads a known weight without changing anything."""
    hw, esp = _machine(lg, tmp_path)
    try:
        wait_until(lambda: hw.refresh()["outputWeightG"] is not None, what="a weight")
        lg.raw[17] = 60_000 + 500 * 200
        time.sleep(0.2)
        with pytest.raises(ValueError, match="Tare"):
            hw.calibrate_load_cell("output", 500)
        lg.raw[17] = 60_000                                   # empty
        time.sleep(0.2)
        hw.tare_load_cell("output")
        lg.raw[17] = 60_000 + 200 * 200 + 30                  # 200 g reads a little high
        time.sleep(0.2)
        first = hw.calibrate_load_cell("output", 200)
        assert first["scale"] == pytest.approx(200.15)
        lg.raw[17] = 60_000 + 1000 * 200 - 30                 # 1000 g a little low
        time.sleep(0.2)
        both = hw.calibrate_load_cell("output", 1000)
        expected = ((200 * 200 + 30) * 200 + (1000 * 200 - 30) * 1000) / (200 ** 2 + 1000 ** 2)
        assert both["scale"] == pytest.approx(expected, rel=1e-6)
        assert [p["grams"] for p in both["points"]] == [200, 1000] and both["maxErrorG"] < 0.3
        assert hw.refresh()["outputWeightG"] == pytest.approx(1000, abs=0.3)
        check = hw.check_load_cell("output", 1000)
        assert check["readsG"] == pytest.approx(1000, abs=0.3) and abs(check["errorG"]) <= 0.3
        assert hw._cells["output"].scale == pytest.approx(expected, rel=1e-6)    # Check changed nothing
        lg.raw[17] = 60_000 - 500 * 200                       # the reading going the other way: a mistake
        time.sleep(0.2)
        with pytest.raises(ValueError, match="other way"):
            hw.calibrate_load_cell("output", 500)
        cell = next(c for c in hw.load_cells() if c["key"] == "output")
        assert cell["sessionPoints"] == 2 and len(cell["calibrationPoints"]) == 2 and cell["readyToCalibrate"]
        saved = json.loads((tmp_path / "cal.json").read_text())["output"]
        assert saved["offset"] == 60_000 and [p["grams"] for p in saved["points"]] == [200, 1000]
    finally:
        hw.close()


def test_reactor_load_cell_and_level_switch(lg, tmp_path):
    hw, esp = _machine(lg, tmp_path, **{"load_cells.reactor.enabled": True, "load_cells.reactor.offset": 0,
                                        "load_cells.reactor.scale": 2, "level_switch.enabled": True})
    try:
        wait_until(lambda: hw.refresh()["oilMassG"] == 500.0, what="the reactor weight")
        lg.level[26] = 0                                     # float switch closed: biodiesel covers the heater
        assert hw.refresh()["heaterSubmerged"] is True
        lg.level[26] = 1
        assert hw.refresh()["heaterSubmerged"] is False
        hw.set_motor("purification_stirrer", 0.2)
        from app.hardware import InterlockError
        with pytest.raises(InterlockError, match="level switch"):
            hw.set_heater(True)
    finally:
        hw.close()


def test_describe_for_the_website(lg, tmp_path):
    hw, esp = _machine(lg, tmp_path)
    try:
        hw.set_motor("stirrer", 0.5)
        wait_until(lambda: hw.describe()["controller"]["devices"], what="a status")
        info = hw.describe()
        assert info["backend"] == "esp32" and info["controller"]["online"] and info["fault"] is None
        stirrer = next(r for r in info["roles"] if r["role"] == "stirrer")
        assert stirrer["devices"] == ["mixer1"] and stirrer["on"] and stirrer["rpm"] == 772
        unused = [d["id"] for d in info["controller"]["devices"] if not d["used"]]
        assert unused == ["extra"]                           # every other ESP32 output has a job
        driver = info["motorDriver"]
        assert driver["motor"] == "stirrer" and driver["targetRpm"] == 772
        assert driver["maxRpm"] == {"stirrer": 1544, "purification_stirrer": 1544, "centrifuge": 2500}
    finally:
        hw.close()


def test_find_port_skips_the_power_supply(monkeypatch):
    from app import esp32
    monkeypatch.setattr(esp32.glob, "glob", lambda pattern: {"/dev/ttyUSB*": ["/dev/ttyUSB0", "/dev/ttyUSB1"]}.get(pattern, []))
    assert esp32.find_port("auto") == "/dev/ttyUSB0"
    assert esp32.find_port("auto", exclude=("/dev/ttyUSB0",)) == "/dev/ttyUSB1"
    assert esp32.find_port("/dev/ttyACM3") == "/dev/ttyACM3"


def test_create_hardware_uses_the_esp32_in_hardware_mode(monkeypatch, lg, tmp_path):
    from app import esp32
    from app.hardware import create_hardware
    esp = FakeEsp32()
    monkeypatch.setattr(config, "HARDWARE", _cfg())
    monkeypatch.setattr(config, "CALIBRATION_FILE", tmp_path / "cal.json")
    monkeypatch.setattr(esp32, "_open_pyserial", lambda port, baud: esp)
    monkeypatch.setattr(esp32, "find_port", lambda setting="auto", exclude=(): "/dev/ttyUSB0")
    hw = create_hardware()
    try:
        assert isinstance(hw, esp32.Esp32Hardware)
        wait_until(lambda: hw.link.online, timeout=5, what="the ESP32")
        assert hw.link.port == "/dev/ttyUSB0"
    finally:
        hw.close()


def test_system_tiles_in_esp32_mode():
    from app import system
    reading = {"temperature": 30.0, "oilMassG": None, "outputWeightG": 12.0, "stirrerRpm": 0, "centrifugeRpm": 0,
               "purificationStirrerRpm": 0, "rpmEstimated": True, "controllerOnline": True, "controllerError": None,
               "controllerPort": "/dev/ttyUSB0", "loadCellsFitted": {"reactor": False, "output": True},
               "motorDuty": {}, "pumps": {}, "valves": {}}
    tiles = {t["label"]: t for t in system.status(reading, {}, {})["tiles"]}
    assert tiles["Output Controller"]["state"] == "ready"
    assert "Reactor Load Cell" not in tiles                  # not fitted: no tile (the operator measures)
    assert tiles["Reactor Stirrer"]["state"] == "ready"
    reading.update(controllerOnline=False, controllerError="ESP32 controller offline: not connected", stirrerRpm=None)
    status = system.status(reading, {}, {})
    tiles = {t["label"]: t for t in status["tiles"]}
    assert tiles["Output Controller"]["state"] == "fault" and not status["ready"]
    assert tiles["Reactor Stirrer"]["secondary"].startswith("No reading")


def test_a_stage_or_pump_that_cannot_start_leaves_nothing_half_on(lg, tmp_path):
    """The ESP32 is offline: starting a stage or a dosing pump is refused cleanly (409 on the website)."""
    import asyncio
    from app.hardware import InterlockError
    from app.models import Settings
    from app.stages import StageError, StageRunner
    from app.transfers import PumpRunner
    esp = FakeEsp32()
    hw, _ = _machine(lg, tmp_path, esp)
    try:
        esp.silent = True
        wait_until(lambda: not hw.link.online, what="offline")

        async def run():
            stage, pump = StageRunner(hw), PumpRunner(hw)
            with pytest.raises(StageError, match="can't start: ESP32 controller offline"):
                stage.start("Transesterification", Settings())
            assert stage.state["state"] == "ready" and not stage.active
            with pytest.raises(InterlockError):
                pump.start("catalyst", 50, 50)
            assert pump.state["phase"] == "idle"
        asyncio.run(run())
        assert not hw.any_output_on()
    finally:
        hw.close()


def test_a_job_with_two_outputs_faults_when_one_does_not_follow(lg, tmp_path):
    esp = FakeEsp32()
    esp.ignore_on.add("pumpin")
    hw, _ = _machine(lg, tmp_path, esp, **{"esp32.devices.reactor_outlet": ["reactorpump", "pumpin"]})
    try:
        hw.set_valve("reactor_outlet", True)
        assert esp.on("reactorpump") and not esp.on("pumpin")
        wait_until(lambda: hw.link_fault is not None, what="the command fault")
        assert "(pumpin) on" in hw.link_fault
    finally:
        hw.close()


def test_the_purification_outlet_is_the_valve_and_pumpout(lg, tmp_path):
    hw, esp = _machine(lg, tmp_path)
    try:
        hw.set_valve("centrifuge_outlet", True)
        assert esp.on("pumpin") and not esp.on("pumpout")
        hw.set_valve("mesh_bed", True)                       # drain after contact
        assert esp.on("valve") and esp.on("pumpout") and esp.lines.index("valve on 5") < esp.lines.index("pumpout on 5")
        hw.all_off()
        assert not esp.on("valve") and not esp.on("pumpout") and not esp.on("pumpin")
    finally:
        hw.close()


def test_oil_pump(lg, tmp_path):
    from app.hardware import InterlockError
    hw, esp = _machine(lg, tmp_path)
    try:
        assert hw.has_oil_pump and set(hw.pumps) == {"catalyst", "acid", "oil"}
        hw.set_pump("oil", True)
        assert esp.on("oil") and "oil on 5" in esp.lines
        with pytest.raises(InterlockError, match="Only one pump"):
            hw.set_pump("catalyst", True)                    # one pump into the reactor at a time
        with pytest.raises(InterlockError, match="pump into the reactor is running"):
            hw.set_valve("reactor_outlet", True)
        hw.set_pump("oil", False)
        hw.set_valve("reactor_outlet", True)
        with pytest.raises(InterlockError, match="reactor pump is emptying it"):
            hw.set_pump("oil", True)                         # never fill while it is emptied
        assert not esp.on("oil")
    finally:
        hw.close()
    hw, esp = _machine(lg, tmp_path, **{"esp32.devices.oil_pump": ""})
    try:
        assert not hw.has_oil_pump and "oil" not in hw.pumps
        with pytest.raises(InterlockError, match="no oil pump"):
            hw.set_pump("oil", True)
    finally:
        hw.close()


def test_oil_pump_runs_until_the_operator_presses_done(lg, tmp_path):
    """The oil pump stays on (its 5 s timer refreshed every second) until Done, then goes off."""
    import asyncio
    from app.transfers import PumpRunner
    hw, esp = _machine(lg, tmp_path)
    try:
        async def run():
            runner = PumpRunner(hw, time_scale=20)           # 1 s steps take 50 ms
            runner.start("oil", 920.0, 1000.0, stage="Oil Loading")
            assert esp.on("oil")
            await asyncio.sleep(1.0)                         # 20 simulated seconds: no automatic stop
            on_before = runner.running and esp.on("oil")
            runner.finish()
            while runner.running:
                await asyncio.sleep(0.02)
            return on_before, runner.state
        on_before, st = asyncio.run(run())
        assert on_before and st["phase"] == "done" and st["deliveredG"] == 920.0
        assert not esp.on("oil")
    finally:
        hw.close()


def test_calibration_file_in_docker(tmp_path, monkeypatch):
    """Docker: a missing mounted file becomes a folder, and a mounted file can't be replaced."""
    from app import drivers
    folder = tmp_path / "loadcell_calibration.json"
    folder.mkdir()
    store = drivers.CalibrationStore(folder)
    store.save("output", {"offset": 1, "scale": 2})
    assert json.loads((folder / "loadcell_calibration.json").read_text())["output"] == {"offset": 1, "scale": 2}

    mounted = tmp_path / "mounted.json"
    mounted.write_text("{}")

    def busy(src, dst):
        raise OSError(16, "Device or resource busy")
    monkeypatch.setattr(drivers.os, "replace", busy)
    drivers.CalibrationStore(mounted).save("output", {"scale": 210})
    assert json.loads(mounted.read_text()) == {"output": {"scale": 210}}
    assert not (tmp_path / "mounted.json.tmp").exists()


def test_gpio_chip_and_busy_pins_are_explained(lg, monkeypatch):
    from app import drivers
    with pytest.raises(RuntimeError, match="not the Raspberry Pi's GPIO header"):
        drivers.open_gpiochip(1)                     # "other": not the header's chip
    assert drivers.open_gpiochip(0)[1] == 0

    def gone(n):
        raise OSError("no such file")
    monkeypatch.setattr(lg, "gpiochip_open", gone)
    with pytest.raises(RuntimeError, match="/dev/gpiochip0"):
        drivers.open_gpiochip(0)

    def busy(h, pin, level=0):
        raise Exception("'GPIO busy'")
    monkeypatch.setattr(lg, "gpio_claim_output", busy)
    with pytest.raises(RuntimeError, match="GPIO 23 .motor driver L_EN. is busy.*pi-control"):
        drivers.MotorDriver(lg, 0, config.HARDWARE_DEFAULTS["motor_driver"])


def test_reactions_run_without_a_temperature_reading(lg, tmp_path):
    """No DS18B20 reading: esterification starts and keeps running (no temperature checks in the
    reactions), with the electrode relay and mixer 1 on."""
    import asyncio
    from app.models import Settings
    from app.stages import StageRunner
    hw, esp = _machine(lg, tmp_path, FakeEsp32(temp=None))
    try:
        hw.refresh()

        async def run():
            stage = StageRunner(hw, time_scale=10)
            stage.start("Esterification", Settings())
            for _ in range(30):                           # 3 s = 30 simulated seconds
                hw.refresh()
                assert hw.watchdog(95, 60) is None
                await asyncio.sleep(0.1)
            assert stage.state["state"] == "running", stage.state
            assert stage.state["elapsedSeconds"] >= 20 and stage.state["averageTemperature"] is None
            assert esp.on("electrode") and esp.on("mixer1")
            await stage.emergency_stop("test over")
        asyncio.run(run())
    finally:
        hw.close()


def test_an_esp32_brownout_is_named_in_the_fault(lg, tmp_path):
    """The ESP32 restarts when its supply dips (a motor or relay switching on): the controller fault
    says so, instead of only "stopped answering"."""
    esp = FakeEsp32()
    hw, _ = _machine(lg, tmp_path, esp)
    try:
        hw.refresh()
        with esp._lock:
            esp.rx += b"Brownout detector was triggered\r\n\r\nets Jul 29 2019 12:21:46\r\n\r\n" \
                      b"rst:0xc (SW_CPU_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)\r\n"
        esp.silent = True
        wait_until(lambda: not hw.link.online, what="offline")
        fault = hw.link_fault
        assert "brownout" in fault and "own 5 V supply" in fault, fault
    finally:
        hw.close()


def test_one_motor_at_a_time_on_the_shared_driver(lg, tmp_path):
    """Mixer 1 (the stage's speed) and mixer 2 (always 200 RPM) through their relays and the one
    BTS7960: straight to the set speed, never two motors at once."""
    from app.hardware import InterlockError
    hw, esp = _machine(lg, tmp_path, **{"esp32.mixer_kick_seconds": 3})   # an old setting is ignored
    try:
        hw.refresh()
        hw.set_motor("stirrer", 700 / 1544)                        # mixer 1 at a stage's 700 RPM
        assert esp.on("mixer1") and "mixer1 on 5" in esp.lines
        wait_until(lambda: hw.refresh()["stirrerRpm"] == 700, what="mixer 1 at 700 RPM")
        assert lg.pwm[21] == (1000, round(700 / 1544 * 100, 6)) or abs(lg.pwm[21][1] - 700 / 1544 * 100) < 1e-6
        with pytest.raises(InterlockError, match="only one runs at a time"):
            hw.set_motor("centrifuge", 0.5)                        # the driver is busy with mixer 1
        with pytest.raises(InterlockError, match="only one runs at a time"):
            hw.set_motor("purification_stirrer", 0.2)
        assert not esp.on("centrifuge") and not esp.on("mixer2")
        hw.set_motor("stirrer", 500 / 1544)                        # a new speed for the running motor: at once
        wait_until(lambda: hw.refresh()["stirrerRpm"] == 500, timeout=0.5, what="mixer 1 at 500 RPM")
        hw.set_motor("stirrer", 0)
        assert not esp.on("mixer1")
        hw.set_motor("purification_stirrer", 1.0)                  # mixer 2: always 200 RPM
        assert esp.on("mixer2")
        wait_until(lambda: hw.refresh()["purificationStirrerRpm"] == 200, what="mixer 2 at 200 RPM")
        assert abs(lg.pwm[21][1] - 200 / 1544 * 100) < 1e-6
        assert not any(len(line.split()) > 3 for line in esp.lines)   # relays only: no RPM in the commands
        hw.all_off()
        assert not any(esp.on(m) for m in ("mixer1", "mixer2", "centrifuge")) and lg.level[23] == 0
    finally:
        hw.close()


def test_a_motor_stays_off_when_the_esp32_is_offline(lg, tmp_path):
    """The relay can't switch on, so the PWM never starts either."""
    from app.hardware import InterlockError
    hw, esp = _machine(lg, tmp_path)
    try:
        esp.silent = True
        wait_until(lambda: not hw.link.online, what="offline")
        with pytest.raises(InterlockError, match="offline"):
            hw.set_motor("stirrer", 0.3)
        time.sleep(0.3)
        assert lg.pwm.get(21, (0, 0))[1] == 0 and lg.level.get(23, 0) == 0
    finally:
        hw.close()
