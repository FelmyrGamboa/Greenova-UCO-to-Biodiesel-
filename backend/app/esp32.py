"""ESP32 + Raspberry Pi hardware ([actuators] backend = "esp32" in hardware.toml).

The real machine is split between two boards:

- The ESP32 (firmware/esp32_process_control/esp32_process_control.ino, on USB serial at 115200)
  switches the 8-channel relay board (dispenser1, dispenser2, reactorpump, pumpin, oil, pumpout,
  valve, electrode), the heater's own relay, and the two mixers on the L298N (mixer1, mixer2, speed
  in RPM). It also reads the DS18B20 temperature probe.
  oil = oil pump into the reactor, reactorpump = reactor -> centrifuge, pumpin = centrifuge ->
  purifier, valve + pumpout = purifier -> output container (after purification).
- The Raspberry Pi drives the centrifuge (BTS7960: L_EN 23, R_EN 24, LPWM 25, RPWM 21) and reads
  the HX711 load cell (DT 17, SCK 27) on its own pins, with lgpio.

Which ESP32 output does which job is set in hardware.toml under [esp32.devices] (for example
heater = "heater", oil_pump = "oil", purification_outlet = ["valve", "pumpout"]).

The ESP32 sketch is used as it is (its own text commands). Two things keep it safe:

- Dead-man timer: every output is switched on as "<device> on 5" (the sketch's timed ON) and the
  Pi repeats that every second while the output should stay on. If the backend, the Pi or the USB
  cable stops, the ESP32 switches the output off by itself within lease_seconds (5 s).
- The Pi checks every status line: an output that doesn't follow ("did not switch on"), a device
  missing from the sketch, or no answer for 3.5 s is a controller fault. The backend then stops
  every process and switches everything off (main.py), and the website shows why.

All the process safety rules (interlocks) stay in hardware.Hardware, so they apply here too.
"""
import collections
import glob
import json
import logging
import os
import re
import threading
import time
from typing import Callable, Optional

from . import config, drivers
from .hardware import Hardware, InterlockError, PUMP_LABELS, VALVE_LABELS, _Sampler

log = logging.getLogger("greenova.esp32")

SAFE_ID = re.compile(r"^[a-z0-9_]+$")

# Greenova job -> what the website calls it
ROLE_LABELS = {
    "heater": "Immersion heater",
    "electrode_power": "Electrode power",
    "oil_pump": PUMP_LABELS["oil"],
    "catalyst_pump": PUMP_LABELS["catalyst"],
    "acid_pump": PUMP_LABELS["acid"],
    "reactor_outlet": VALVE_LABELS["reactor_outlet"],
    "centrifuge_outlet": VALVE_LABELS["centrifuge_outlet"],
    "purification_outlet": VALVE_LABELS["mesh_bed"],
    "stirrer": "Reactor stirrer",
    "purification_stirrer": "Purification stirrer",
}
MOTOR_ROLES = ("stirrer", "purification_stirrer")
RELAY_ROLES = tuple(role for role in ROLE_LABELS if role not in MOTOR_ROLES)
VALVE_ROLE = {"reactor_outlet": "reactor_outlet", "centrifuge_outlet": "centrifuge_outlet",
              "mesh_bed": "purification_outlet"}
PUMP_ROLE = {"catalyst": "catalyst_pump", "acid": "acid_pump", "oil": "oil_pump"}

MISMATCH_LIMIT = 3          # status lines in a row where an output doesn't follow -> fault
SETTLE_S = 1.5              # a command needs this long to show in the status


# =====================================================================
# USB serial link (the same protocol as the Pi control panel's Esp32Serial)
# =====================================================================
def _open_pyserial(port: str, baudrate: int):
    try:
        import serial  # apt: python3-serial (pip: pyserial)
    except ImportError:
        raise RuntimeError("pyserial is not installed: sudo apt install python3-serial "
                           "(or .venv/bin/pip install pyserial)") from None
    s = serial.Serial()
    s.port, s.baudrate, s.timeout, s.write_timeout = port, int(baudrate), 0.2, 1.0
    # Keep DTR/RTS released so the ESP32's auto-reset circuit doesn't hold it in reset / boot mode.
    s.dtr = False
    s.rts = False
    try:
        s.exclusive = True              # a second program can't open the port at the same time
    except (AttributeError, ValueError):
        pass
    try:
        s.open()
    except serial.SerialException as e:
        msg = str(e)
        if "ermission" in msg:
            raise RuntimeError(f"permission denied on {port}: run  sudo usermod -aG dialout $USER  and reboot") from None
        if "busy" in msg.lower() or "lock" in msg.lower():
            raise RuntimeError(f"{port} is busy: close the Arduino Serial Monitor and stop the old Pi control "
                               "panel (sudo systemctl disable --now pi-control)") from None
        raise RuntimeError(f"cannot open {port}: {msg}") from None
    return s


def find_port(setting: str = "auto", exclude: tuple = ()) -> Optional[str]:
    """The ESP32's serial port: the one in hardware.toml, or the first USB serial port found
    (/dev/serial/by-id/*, /dev/ttyUSB*, /dev/ttyACM*), skipping the power supply's port."""
    setting = str(setting or "auto")
    if setting != "auto":
        return setting
    skip = {os.path.realpath(p) for p in exclude if p}
    found = (sorted(glob.glob("/dev/serial/by-id/*")) + sorted(glob.glob("/dev/ttyUSB*"))
             + sorted(glob.glob("/dev/ttyACM*")))
    for port in found:
        if os.path.realpath(port) not in skip:
            return port
    return None


class Esp32Serial:
    """Talks to the ESP32 over USB serial with the sketch's text commands
    ("heater on 5", "mixer2 on 5 200", "valve off", "alloff"). Its `json` command answers with one
    line, STATUS {"maxRpm":1544,"temp":31.25,"devices":[{"id":"heater","on":true,...}]}, which is
    asked for every poll_seconds. It reconnects by itself when the cable is unplugged and back.

    Callbacks (set by Esp32Hardware): on_connect() right after the port opens, on_poll() just
    before each `json` (the dead-man refresh), on_status(data) for every status line, on_recover()
    when the ESP32 answers again after being offline."""

    def __init__(self, port: str = "auto", baudrate: int = 115200, *, poll_seconds: float = 1.0,
                 offline_after_seconds: float = 3.5, open_wait_seconds: float = 2.0,
                 command_gap_seconds: float = 0.01, exclude_ports: tuple = (),
                 opener: Optional[Callable] = None):
        self.port_setting, self.baudrate = port, int(baudrate)
        self.poll_seconds, self.offline_after = float(poll_seconds), float(offline_after_seconds)
        self.open_wait, self.command_gap = float(open_wait_seconds), float(command_gap_seconds)
        self.exclude_ports = tuple(exclude_ports)
        self._opener = opener or _open_pyserial
        self.on_connect: Optional[Callable[[], None]] = None
        self.on_poll: Optional[Callable[[], None]] = None
        self.on_status: Optional[Callable[[dict], None]] = None
        self.on_recover: Optional[Callable[[], None]] = None
        self._lock = threading.Lock()       # data, log
        self._wlock = threading.Lock()      # the port
        self._ser = None
        self.port: Optional[str] = None
        self._data: Optional[dict] = None
        self._last_rx = 0.0
        self._opened_at = 0.0
        self._rx_lines = 0
        self._restart: Optional[tuple[float, str]] = None   # (when, why) the ESP32 last restarted by itself
        self.error: Optional[str] = "connecting..."
        self.log: collections.deque = collections.deque(maxlen=40)
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []

    # ----- life cycle -----
    def start(self) -> None:
        if self._threads:
            return
        for name, target in (("reader", self._reader), ("poller", self._poller)):
            thread = threading.Thread(target=target, name=f"greenova-esp32-{name}", daemon=True)
            thread.start()
            self._threads.append(thread)

    def close(self) -> None:
        self._stop.set()
        for thread in self._threads:
            thread.join(timeout=2)
        self._drop("closed")

    # ----- port handling -----
    def _open(self) -> None:
        port = find_port(self.port_setting, self.exclude_ports)
        if not port:
            raise RuntimeError("no USB serial port found: is the ESP32 plugged into the Pi?")
        ser = self._opener(port, self.baudrate)
        self._stop.wait(self.open_wait)        # opening the port can reset the ESP32
        try:
            ser.reset_input_buffer()
        except Exception:
            pass
        with self._wlock:
            self._ser, self.port = ser, port
        self.error = None
        self._opened_at = time.monotonic()
        self._rx_lines = 0
        self._add_log(f"[connected to {port}]")
        log.info("ESP32 connected on %s", port)
        if self.on_connect:
            try:
                self.on_connect()
            except Exception:
                log.exception("ESP32 on_connect failed")

    def _drop(self, err: str) -> None:
        with self._wlock:
            if self._ser is not None:
                try:
                    self._ser.close()
                except Exception:
                    pass
                self._add_log(f"[disconnected: {err}]")
            self._ser = None
        self.error = err

    def _add_log(self, text: str) -> None:
        with self._lock:
            self.log.append(time.strftime("%H:%M:%S ") + text)

    # ----- threads -----
    def _reader(self) -> None:
        buf = b""
        while not self._stop.is_set():
            if self._ser is None:
                try:
                    self._open()
                    buf = b""
                except Exception as e:
                    if str(e) != self.error:
                        log.warning("ESP32 serial: %s", e)
                    self.error = str(e)
                    self._stop.wait(2)
                    continue
            ser = self._ser
            if ser is None:
                continue
            try:
                chunk = ser.read(ser.in_waiting or 1)
            except Exception as e:
                self._drop(str(e) or "read error")
                self._stop.wait(1)
                continue
            if not chunk:
                continue
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                self._handle_line(line.decode("utf-8", "replace").strip())
            if len(buf) > 8192:
                buf = b""

    def _handle_line(self, text: str) -> None:
        if not text:
            return
        self._rx_lines += 1
        if text.startswith("STATUS "):
            try:
                data = json.loads(text[7:])
            except ValueError:
                return
            if not isinstance(data, dict):
                return
            now = time.monotonic()
            recovered = self._last_rx > self._opened_at and now - self._last_rx >= self.offline_after
            with self._lock:
                self._data, self._last_rx = data, now
            if recovered and self.on_recover:
                try:
                    self.on_recover()
                except Exception:
                    log.exception("ESP32 on_recover failed")
            if self.on_status:
                try:
                    self.on_status(data)
                except Exception:
                    log.exception("ESP32 status check failed")
        elif " -> " not in text:          # skip the ESP32's echo of every (repeated) switch command
            self._add_log(text)
            self._note_restart(text)

    def _note_restart(self, text: str) -> None:
        """The ESP32's own boot messages: it restarted (a reset, or its supply voltage dipped)."""
        lower = text.lower()
        why = None
        if "brownout" in lower:
            why = ("its supply voltage dipped (brownout), usually when a motor or relay switches on. Give the "
                   "ESP32 and the relay / motor boards their own 5 V supply (not only the Pi's USB port), "
                   "with GND shared")
        elif "rst:0x" in lower:
            why = f"it restarted ({text[lower.index('rst:0x'):].split(',')[0]})"
        elif lower.startswith("connecting to ") and self._last_rx > self._opened_at:
            why = "it restarted (its sketch started again)"
        if why is None:
            return
        previous = self._restart
        if previous is None or "brownout" not in previous[1] or time.monotonic() - previous[0] > 30:
            self._restart = (time.monotonic(), why)     # a brownout stays the reason for that restart
        log.warning("ESP32: %s", why)

    def _poller(self) -> None:
        while not self._stop.wait(self.poll_seconds):
            if self._ser is None:
                continue
            if self.on_poll:
                try:
                    self.on_poll()
                except Exception:
                    log.exception("ESP32 refresh failed")
            self.send("json")

    # ----- sending -----
    def send(self, cmd: str) -> bool:
        """Sends one command line. False when the port isn't open (or the write failed)."""
        cmd = cmd.replace("\r", " ").replace("\n", " ").strip().lower()[:60]
        err = None
        with self._wlock:
            if self._ser is None:
                return False
            try:
                self._ser.write((cmd + "\n").encode("ascii", "replace"))
                if self.command_gap:
                    time.sleep(self.command_gap)   # the ESP32's serial input buffer is small
            except Exception as e:
                err = str(e) or "write error"
        if err:
            self._drop(err)
            return False
        return True

    # ----- state -----
    @property
    def connected(self) -> bool:
        return self._ser is not None

    @property
    def online(self) -> bool:
        return self._ser is not None and time.monotonic() - self._last_rx < self.offline_after

    def status(self) -> Optional[dict]:
        with self._lock:
            return json.loads(json.dumps(self._data)) if self._data is not None and self.online else None

    def why_offline(self) -> str:
        if self._ser is None:
            return self.error or "not connected"
        if self._last_rx > self._opened_at:
            if self._restart and self._restart[0] >= self._last_rx - 1:
                return f"the ESP32 stopped answering: {self._restart[1]}"
            return "the ESP32 stopped answering (was it reset or unplugged?)"
        waited = time.monotonic() - self._opened_at
        if waited < 15:
            return "port open, waiting for the ESP32 to answer (up to ~12 s after a reset)"
        if self._rx_lines > 0:
            return ("the ESP32 is talking but doesn't answer the `json` command: upload "
                    "firmware/esp32_process_control/esp32_process_control.ino")
        return (f"{self.port} is open but nothing comes back: check the baud rate (115200), that the "
                "sketch is uploaded, and press the ESP32's EN/RST button")

    def messages(self) -> list[str]:
        with self._lock:
            return list(self.log)


# =====================================================================
# The machine: ESP32 outputs + Pi centrifuge and load cells
# =====================================================================
def _device_ids(value) -> list[str]:
    """[esp32.devices] value -> device ids: "valve", ["pumpout", "valve"] or "" (not fitted)."""
    items = value if isinstance(value, (list, tuple)) else str(value or "").replace(",", " ").split()
    ids = [str(item).strip().lower() for item in items if str(item).strip()]
    for item in ids:
        if not SAFE_ID.match(item):
            raise RuntimeError(f"hardware.toml [esp32.devices]: {item!r} is not an ESP32 device name "
                               "(lower-case letters, digits and _ only).")
    return ids


class Esp32Hardware(Hardware):
    """The real machine with the ESP32 controller (see the top of this file)."""

    def __init__(self, hw_config: Optional[dict] = None, link: Optional[Esp32Serial] = None,
                 calibration_file=None):
        cfg = hw_config or config.HARDWARE
        problems = config.check_hardware(cfg)
        if problems:
            raise RuntimeError("hardware.toml: " + " ".join(problems))
        e = cfg["esp32"]
        roles: dict[str, list[str]] = {role: _device_ids(e["devices"].get(role, "")) for role in ROLE_LABELS}
        unknown = set(e["devices"]) - set(ROLE_LABELS)
        if unknown:
            raise RuntimeError(f"hardware.toml [esp32.devices]: unknown job(s) {', '.join(sorted(unknown))}; "
                               f"use {', '.join(ROLE_LABELS)}.")
        # pumps A and B are always offered (an unassigned one refuses to start); the oil pump only when fitted
        super().__init__(("catalyst", "acid") + (("oil",) if roles["oil_pump"] else ()))
        self.cfg = cfg
        self._roles = roles
        self._lease = max(0, int(e.get("lease_seconds", 5)))
        self._max_on = {role: int(s) for role, s in (e.get("max_on_seconds") or {}).items() if s}
        self._mixer_max_rpm = float(e.get("mixer_max_rpm", 1544))
        self._want: dict[str, int] = {}               # role -> 1/0 (relays) or RPM (mixers, 0 = off)
        self._switched_at: dict[str, float] = {}
        self._deadline: dict[str, Optional[float]] = {}
        self._mismatch: dict[str, int] = {}
        self._command_fault: Optional[str] = None
        self._config_fault: Optional[str] = None
        self._temp: Optional[float] = None
        self._temp_at = 0.0
        self._lock = threading.RLock()
        self._closables: list = []

        # ----- Pi side: centrifuge, load cells, level switch, power monitor, power supply -----
        self._lg = self._chip = None
        cells = {k: c for k, c in cfg["load_cells"].items() if c.get("enabled")}
        if cfg["centrifuge"].get("enabled") or cells or cfg["level_switch"].get("enabled"):
            self._lg, self._chip = drivers.open_gpiochip(cfg.get("gpiochip"))
        self._centrifuge = drivers.Centrifuge(self._lg, self._chip, cfg["centrifuge"]) \
            if cfg["centrifuge"].get("enabled") else None
        store = drivers.CalibrationStore(calibration_file or config.CALIBRATION_FILE)
        self._cells: dict[str, drivers.LoadCell] = {}
        for key, c in cells.items():
            hx = drivers.HX711Scale(self._lg, self._chip, c["data_pin"], c["clock_pin"])
            self._cells[key] = drivers.LoadCell(hx, key, c.get("offset", 0), c.get("scale", 1.0),
                                                c.get("samples", 10), c.get("cal_seconds", 3.0), store)
        self._level_pin = None
        self._level_closed_is_liquid = cfg["level_switch"].get("closed_means_liquid", True)
        if cfg["level_switch"].get("enabled"):
            self._level_pin = int(cfg["level_switch"]["pin"])
            self._lg.gpio_claim_input(self._chip, self._level_pin, getattr(self._lg, "SET_PULL_UP", 32))
        self._samplers: dict[str, _Sampler] = {}
        pm = cfg["power_monitor"]
        if pm.get("type", "none") not in ("none", "", None):
            power = drivers.PowerMonitor(pm["type"], pm.get("i2c_bus", 1), pm.get("address", 0x40), pm.get("shunt_ohms", 0.02))
            self._closables.append(power)
            self._samplers["power"] = _Sampler("power", power.read_or_none, 0.2)
        self._supply = None
        ps = cfg["power_supply"]
        if ps.get("control") == "serial":
            self._supply = drivers.SerialSupply(ps["port"], ps.get("baudrate", 9600), ps.get("voltage_command", ""),
                                                ps.get("current_command", ""), ps.get("output_on_command", ""),
                                                ps.get("output_off_command", ""))
            self._closables.append(self._supply)

        # ----- the ESP32 -----
        a = cfg["actuators"]
        exclude = (ps.get("port"),) if ps.get("control") == "serial" else ()
        self.link = link or Esp32Serial(a.get("port", "auto"), a.get("baudrate", 115200),
                                        poll_seconds=e.get("poll_seconds", 1.0),
                                        offline_after_seconds=e.get("offline_after_seconds", 3.5),
                                        exclude_ports=exclude)
        self.link.on_connect = self._on_connect
        self.link.on_poll = self._refresh_outputs
        self.link.on_status = self._check_status
        self.link.on_recover = self._on_recover
        self.link.start()

    # ----- the ESP32 outputs -----
    def _label(self, role: str) -> str:
        return ROLE_LABELS[role]

    def _command(self, device: str, role: str, value: int, seconds: int) -> str:
        if not value:
            return f"{device} off"
        if role in MOTOR_ROLES:
            return f"{device} on {seconds} {int(value)}"          # "mixer2 on 5 200": 0 s = no timer
        return f"{device} on {seconds}" if seconds else f"{device} on"

    def _switch(self, role: str, value: int) -> None:
        """Switch one Greenova job on (value > 0: 1, or the RPM for a mixer) or off (0)."""
        devices = self._roles[role]
        value = max(0, int(value))
        if value and not devices:
            raise InterlockError(f"{self._label(role)} has no ESP32 output: set {role} under "
                                 "[esp32.devices] in hardware.toml.")
        if value and not self.link.online:
            raise InterlockError(f"{self._label(role)} can't switch on: the ESP32 controller is offline "
                                 f"({self.link.why_offline()}).")
        if value and (self._config_fault or self._command_fault):
            raise InterlockError(f"{self._label(role)} can't switch on: {self._config_fault or self._command_fault}")
        with self._lock:
            now = time.monotonic()
            limit = self._max_on.get(role)
            self._want[role] = value
            self._switched_at[role] = now
            self._mismatch[role] = 0
            self._deadline[role] = now + limit if value and limit else None
            seconds = limit or self._lease
            sent = all([self.link.send(self._command(device, role, value, seconds)) for device in devices])
        if value and not sent:
            with self._lock:
                self._want[role] = 0
            raise InterlockError(f"{self._label(role)}: the command didn't reach the ESP32 ({self.link.why_offline()}).")

    def _refresh_outputs(self) -> None:
        """Every poll: repeat "<device> on <lease>" for each output that should stay on (dead-man).
        Not while the ESP32 doesn't answer: then its timers switch everything off."""
        if not self._lease or not self.link.online:
            return
        with self._lock:
            for role, value in self._want.items():
                if value and self._deadline.get(role) is None:
                    for device in self._roles[role]:
                        self.link.send(self._command(device, role, value, self._lease))

    def _on_connect(self) -> None:
        """A fresh connection: everything off on the ESP32 (it may have been left running)."""
        self.link.send("alloff")

    def _on_recover(self) -> None:
        """The ESP32 answers again after a gap: every output Greenova wants off goes off now (an
        output that should stay on is refreshed as usual; after a real outage there is none, since
        the outage switched everything off)."""
        with self._lock:
            for role, ids in self._roles.items():
                if not self._want.get(role):
                    for device in ids:
                        self.link.send(f"{device} off")

    def _check_status(self, data: dict) -> None:
        """Every status line: are all the devices there, and does each output do what it should?"""
        devices = {str(d.get("id", "")).lower(): d for d in data.get("devices", []) if isinstance(d, dict)}
        missing = []
        for role, ids in self._roles.items():
            for device in ids:
                d = devices.get(device)
                if d is None:
                    missing.append(f"{role} = \"{device}\" (no such device on the ESP32)")
                elif (d.get("type") == "motor") != (role in MOTOR_ROLES):
                    missing.append(f"{role} = \"{device}\" (needs a {'mixer' if role in MOTOR_ROLES else 'relay'})")
        self._config_fault = ("hardware.toml [esp32.devices]: " + "; ".join(missing) + ". ESP32 devices: "
                              + ", ".join(devices)) if missing else None
        now = time.monotonic()
        with self._lock:
            for role, ids in self._roles.items():
                want = self._want.get(role, 0)
                deadline = self._deadline.get(role)
                if now - self._switched_at.get(role, 0.0) < SETTLE_S:
                    continue
                if deadline is not None and now >= deadline - 0.5:
                    continue                  # its max_on_seconds timer on the ESP32 switches it off
                wrong = None                  # an output of this job that isn't doing what it should
                for device in ids:
                    d = devices.get(device)
                    if d is None or bool(d.get("on")) == bool(want):
                        continue
                    if not want:              # switched on by someone else (the ESP32's web page?)
                        self.link.send(f"{device} off")
                    wrong = device
                if wrong is None:
                    self._mismatch[role] = 0
                    continue
                self._mismatch[role] = self._mismatch.get(role, 0) + 1
                if self._mismatch[role] >= MISMATCH_LIMIT and not self._command_fault:
                    self._command_fault = (f"the ESP32 did not switch {self._label(role)} ({wrong}) "
                                           f"{'on' if want else 'off'}")
                    log.error("ESP32 controller fault: %s", self._command_fault)

    @property
    def link_fault(self) -> Optional[str]:
        """Why the ESP32 can't be trusted right now (None = all good)."""
        if not self.link.online:
            return f"ESP32 controller offline: {self.link.why_offline()}"
        return self._config_fault or (f"ESP32 controller fault: {self._command_fault}" if self._command_fault else None)

    # ----- Hardware outputs -----
    def _write_heater(self, on: bool) -> None:
        self._switch("heater", 1 if on else 0)

    def _write_electrode_power(self, on: bool) -> None:
        self._switch("electrode_power", 1 if on else 0)
        if self._supply:
            self._supply.output(on)

    def _write_valve(self, name: str, is_open: bool) -> None:
        self._switch(VALVE_ROLE[name], 1 if is_open else 0)

    def _write_pump(self, name: str, on: bool) -> None:
        self._switch(PUMP_ROLE[name], 1 if on else 0)

    def _write_motor(self, name: str, duty: float) -> None:
        if name == "centrifuge":
            if self._centrifuge is None:
                if duty > 0:
                    raise InterlockError("The centrifuge is not enabled in hardware.toml ([centrifuge] enabled).")
                return
            self._centrifuge.set_fraction(duty)
            return
        rpm = round(duty * (self.full_speed_rpm(name) or self._mixer_max_rpm))
        self._switch(name, max(rpm, 1) if duty > 0 else 0)

    def _write_current_limit(self, amps: float) -> None:
        if self._supply is None:
            raise NotImplementedError("Set the power supply's current limit by hand, or set "
                                      "[power_supply] control = \"serial\" in hardware.toml.")
        self._supply.set_current(amps)

    def _write_voltage(self, volts: float) -> None:
        if self._supply is not None:
            self._supply.set_voltage(volts)

    def all_off(self) -> None:
        """Everything off, including the ESP32 outputs Greenova doesn't use (oil, pumpin ...)."""
        try:
            super().all_off()
        finally:
            with self._lock:
                self._want.clear()
                self._deadline.clear()
                self._command_fault = None        # an emergency stop clears a controller fault
            self.link.send("alloff")
            if self._centrifuge:
                self._centrifuge.set_fraction(0)

    # ----- speeds -----
    def full_speed_rpm(self, name: str) -> Optional[float]:
        """The RPM at full speed: the sketch's MAX_RPM for the mixers (1544), [centrifuge] max_rpm (2500)."""
        if name == "centrifuge":
            return self._centrifuge.max_rpm if self._centrifuge else None
        data = self.link.status()
        try:
            return float(data["maxRpm"]) if data and data.get("maxRpm") else self._mixer_max_rpm
        except (TypeError, ValueError):
            return self._mixer_max_rpm

    def rpm_is_measured(self, key: str) -> bool:
        return False        # open loop: the RPM shown is worked out from the speed setting

    # ----- sensors -----
    def _read_sensors(self) -> dict:
        data = self.link.status()
        online = data is not None
        if not online and self.any_output_on():
            # The ESP32's dead-man timers switch its outputs off; make the Pi's view match.
            log.error("ESP32 offline (%s): switching every output off", self.link.why_offline())
            self.all_off()
        devices = {str(d.get("id", "")).lower(): d for d in (data or {}).get("devices", []) if isinstance(d, dict)}

        def mixer_rpm(role: str) -> Optional[float]:
            ids = self._roles[role]
            d = devices.get(ids[0]) if ids else None
            if d is None:
                return None
            return float(d.get("rpm", 0)) if d.get("on") else 0

        power = self._samplers.get("power")
        volts, amps = (power.value if power else None) or (None, None)
        output = self._cells.get("output")
        reactor = self._cells.get("reactor")
        return {
            "oilMassG": reactor.grams() if reactor else None,
            "outputWeightG": output.grams() if output else None,
            "temperature": self._temperature(data),
            "voltage": volts,
            "current": amps,
            "stirrerRpm": mixer_rpm("stirrer"),
            "centrifugeRpm": self._centrifuge.rpm() if self._centrifuge else None,
            "purificationStirrerRpm": mixer_rpm("purification_stirrer"),
            "heaterSubmerged": self._read_level(),
            "rpmEstimated": True,
            "loadCellsFitted": {key: key in self._cells for key in ("reactor", "output")},
            "controllerOnline": online,
            "controllerError": self.link_fault,
            "controllerPort": self.link.port,
        }

    def _temperature(self, data: Optional[dict]) -> Optional[float]:
        """The ESP32's DS18B20. 85.00 is the probe's power-on value, not a reading: the last good
        reading is kept for up to 5 s instead."""
        now = time.monotonic()
        value = (data or {}).get("temp")
        if isinstance(value, (int, float)) and value != 85.0 and -55 <= value <= 125:
            self._temp, self._temp_at = round(float(value), 1), now
        return self._temp if data is not None and now - self._temp_at <= 5 else None

    def _read_level(self) -> Optional[bool]:
        if self._level_pin is None:
            return None
        closed = self._lg.gpio_read(self._chip, self._level_pin) == 0     # switch to GND, pull-up on
        return closed if self._level_closed_is_liquid else not closed

    # ----- website: Settings -> Hardware -----
    def describe(self) -> dict:
        data = self.link.status()
        devices = {str(d.get("id", "")).lower(): d for d in (data or {}).get("devices", []) if isinstance(d, dict)}
        with self._lock:
            roles = [{"role": role, "label": self._label(role), "devices": ids,
                      "on": bool(self._want.get(role)), "rpm": self._want.get(role) if role in MOTOR_ROLES else None,
                      "maxOnSeconds": self._max_on.get(role),
                      "controllerOn": [bool(devices[i].get("on")) if i in devices else None for i in ids]}
                     for role, ids in self._roles.items()]
        used = {i for ids in self._roles.values() for i in ids}
        return {
            "backend": "esp32",
            "fault": self.link_fault,
            "controller": {"online": data is not None, "port": self.link.port or self.link.port_setting,
                           "error": None if data is not None else self.link.why_offline(),
                           "temperature": self._temperature(data), "maxRpm": (data or {}).get("maxRpm"),
                           "leaseSeconds": self._lease,
                           "devices": [{"id": i, "label": d.get("label", i), "type": d.get("type"), "on": bool(d.get("on")),
                                        "rpm": d.get("rpm") if d.get("type") == "motor" else None, "used": i in used}
                                       for i, d in devices.items()],
                           "messages": self.link.messages()[-12:]},
            "roles": roles,
            "centrifuge": self._centrifuge.status() if self._centrifuge else None,
            "loadCells": self.load_cells(),
        }

    def load_cells(self) -> list[dict]:
        labels = {"reactor": "Reactor load cell", "output": "Output load cell"}
        found = []
        for key, c in self.cfg["load_cells"].items():
            cell = self._cells.get(key)
            found.append({"key": key, "label": labels.get(key, key), "enabled": cell is not None,
                          "dataPin": c.get("data_pin"), "clockPin": c.get("clock_pin"),
                          **(cell.status() if cell else {"grams": None, "ok": False})})
        return found

    def _cell(self, key: str) -> drivers.LoadCell:
        cell = self._cells.get(key)
        if cell is None:
            raise ValueError(f"The {key} load cell is not enabled in hardware.toml ([load_cells.{key}] enabled = true).")
        return cell

    def tare_load_cell(self, key: str) -> dict:
        return self._cell(key).tare()

    def calibrate_load_cell(self, key: str, grams: float) -> dict:
        return self._cell(key).calibrate(grams)

    def close(self) -> None:
        try:
            self.all_off()
        except Exception:
            log.exception("all_off on close failed")
        time.sleep(0.05)
        self.link.close()
        for sampler in self._samplers.values():
            sampler.close()
        for item in [*([self._centrifuge] if self._centrifuge else []), *self._cells.values(), *self._closables]:
            try:
                item.close()
            except Exception:
                pass
        if self._level_pin is not None:
            try:
                self._lg.gpio_free(self._chip, self._level_pin)
            except Exception:
                pass
        if self._lg is not None:
            try:
                self._lg.gpiochip_close(self._chip)
            except Exception:
                pass
