#!/usr/bin/env python3
"""
Raspberry Pi Process Control Panel (Flask)

- Controls the ESP32 (relays, heater, mixers, temperature) over the
  USB serial cable using the ESP32's serial commands (or over WiFi
  through its web API if esp32_mode is "http").
- Drives the centrifuge DC motor directly from Pi GPIO
  (BTS7960-style driver: L_EN, R_EN, LPWM, RPWM), 0-2500 RPM.
- Reads the HX711 load cell directly from Pi GPIO.

Pins are BCM (GPIO) numbers:
  Centrifuge : L_EN=23  R_EN=24  LPWM=25  RPWM=21
  HX711      : DT=17    SCK=27

Settings live in config.json (created automatically on first run).
Run:  python3 app.py     ->  open http://<pi-ip>:5000
"""

import collections
import copy
import glob
import json
import os
import re
import statistics
import sys
import threading
import time

import requests
from flask import Flask, jsonify, render_template, request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")

DEFAULT_CONFIG = {
    "esp32_mode": "serial",               # "serial" (USB cable) or "http" (WiFi)
    "esp32_port": "auto",                 # serial port, e.g. /dev/ttyUSB0; "auto" finds it
    "esp32_baud": 115200,
    "esp32_url": "http://192.168.1.50",   # only used in http mode
    "web_port": 5000,
    "centrifuge": {
        "max_rpm": 2500,
        "min_duty": 0,          # % duty at 1 RPM; raise if motor hums but won't spin
        "pwm_freq": 1000,       # Hz
        "ramp_seconds": 3.0,    # time to ramp 0 -> 100% (soft start / soft stop)
        "direction": "forward", # forward = RPWM, reverse = LPWM
        "pins": {"l_en": 23, "r_en": 24, "lpwm": 25, "rpwm": 21},
    },
    "loadcell": {
        "dt": 17,
        "sck": 27,
        "offset": 0,            # set by Tare
        "scale": 1.0,           # set by Calibrate (raw counts per unit)
        "unit": "g",
        "samples": 10,          # median filter size
    },
}

_cfg_lock = threading.Lock()


def _merge(base, extra):
    for k, v in extra.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _merge(base[k], v)
        else:
            base[k] = v
    return base


def load_config():
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE) as f:
                _merge(cfg, json.load(f))
        except Exception as e:
            print("config.json unreadable, using defaults:", e)
    save_config(cfg)
    return cfg


def save_config(cfg):
    with _cfg_lock:
        tmp = CONFIG_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(cfg, f, indent=2)
        os.replace(tmp, CONFIG_FILE)


CONFIG = load_config()
# Environment variable overrides the file (handy for systemd)
if os.environ.get("ESP32_URL"):
    CONFIG["esp32_url"] = os.environ["ESP32_URL"]


# =====================================================================
# GPIO layer (lgpio works on Pi 3, 4 and 5). Falls back to simulation
# when not running on a Pi, so the page can be tested on a PC.
# =====================================================================
class Gpio:
    def __init__(self):
        self.sim = False
        self.lg = None
        self.h = None
        self._sim_pins = {}
        try:
            import lgpio
            self.lg = lgpio
            self.h = self._open_chip()
            print("GPIO: using lgpio")
        except Exception as e:
            self.sim = True
            print("GPIO not available -> SIMULATION mode (%s)" % e)

    def _open_chip(self):
        if os.environ.get("GPIO_CHIP"):
            return self.lg.gpiochip_open(int(os.environ["GPIO_CHIP"]))
        for n in range(0, 8):
            try:
                h = self.lg.gpiochip_open(n)
            except Exception:
                continue
            label = ""
            try:
                info = self.lg.gpio_get_chip_info(h)
                label = str(info[3]) if len(info) > 3 else ""
            except Exception:
                pass
            if "rp1" in label or "bcm" in label:   # Pi 5 = pinctrl-rp1, Pi 3/4 = pinctrl-bcm27xx
                return h
            self.lg.gpiochip_close(h)
        raise RuntimeError("no Raspberry Pi GPIO chip found")

    def output(self, pin, level=0):
        if self.sim:
            self._sim_pins[pin] = level
        else:
            self.lg.gpio_claim_output(self.h, pin, level)

    def input(self, pin):
        if not self.sim:
            self.lg.gpio_claim_input(self.h, pin)

    def write(self, pin, level):
        if self.sim:
            self._sim_pins[pin] = level
        else:
            self.lg.gpio_write(self.h, pin, level)

    def read(self, pin):
        if self.sim:
            return self._sim_pins.get(pin, 0)
        return self.lg.gpio_read(self.h, pin)

    def pwm(self, pin, freq, duty):
        """duty in percent 0-100"""
        if self.sim:
            self._sim_pins[pin] = duty
            return
        if duty <= 0:
            self.lg.tx_pwm(self.h, pin, 0, 0)
            self.lg.gpio_write(self.h, pin, 0)
        else:
            self.lg.tx_pwm(self.h, pin, freq, min(100.0, duty))


GPIO = Gpio()


# =====================================================================
# Centrifuge (open-loop RPM -> PWM, with soft ramp and timer)
# =====================================================================
class Centrifuge:
    TICK = 0.05  # 20 Hz control loop

    def __init__(self, gpio, cfg):
        self.g = gpio
        self.cfg = cfg
        p = cfg["pins"]
        self.l_en, self.r_en, self.lpwm, self.rpwm = p["l_en"], p["r_en"], p["lpwm"], p["rpwm"]
        for pin in (self.l_en, self.r_en, self.lpwm, self.rpwm):
            self.g.output(pin, 0)
        self.lock = threading.Lock()
        self.on = False
        self.target_rpm = cfg["max_rpm"] // 2
        self.duty = 0.0           # actual duty being applied (ramps)
        self.timed = False
        self.start = 0.0
        self.dur = 0.0
        threading.Thread(target=self._loop, daemon=True).start()

    @property
    def max_rpm(self):
        return int(self.cfg["max_rpm"])

    def rpm_to_duty(self, rpm):
        if rpm <= 0:
            return 0.0
        rpm = min(rpm, self.max_rpm)
        mn = float(self.cfg.get("min_duty", 0))
        return mn + rpm * (100.0 - mn) / self.max_rpm

    def duty_to_rpm(self, duty):
        mn = float(self.cfg.get("min_duty", 0))
        if duty <= mn:
            return 0
        return round((duty - mn) * self.max_rpm / (100.0 - mn))

    def set_state(self, on, dur=0):
        with self.lock:
            self.on = bool(on)
            self.timed = self.on and dur > 0
            self.start = time.monotonic()
            self.dur = float(dur)
        print("Centrifuge ->", "ON" if on else "OFF", ("for %ss" % dur) if on and dur > 0 else "")

    def set_rpm(self, rpm):
        with self.lock:
            self.target_rpm = max(0, min(self.max_rpm, int(rpm)))
        print("Centrifuge target =", self.target_rpm, "rpm")

    def remaining(self):
        if not (self.on and self.timed):
            return 0
        return max(0, int(self.dur - (time.monotonic() - self.start) + 0.999))

    def _apply(self):
        freq = int(self.cfg.get("pwm_freq", 1000))
        enable = 1 if (self.on or self.duty > 0) else 0
        self.g.write(self.l_en, enable)
        self.g.write(self.r_en, enable)
        if self.cfg.get("direction", "forward") == "reverse":
            self.g.pwm(self.rpwm, freq, 0)
            self.g.pwm(self.lpwm, freq, self.duty)
        else:
            self.g.pwm(self.lpwm, freq, 0)
            self.g.pwm(self.rpwm, freq, self.duty)

    def _loop(self):
        last = None
        while True:
            with self.lock:
                if self.on and self.timed and time.monotonic() - self.start >= self.dur:
                    self.on = False
                    self.timed = False
                    print("[timer] Centrifuge -> OFF")
                target = self.rpm_to_duty(self.target_rpm) if self.on else 0.0
                ramp = max(0.1, float(self.cfg.get("ramp_seconds", 3.0)))
                step = 100.0 * self.TICK / ramp
                if self.duty < target:
                    self.duty = min(target, self.duty + step)
                elif self.duty > target:
                    self.duty = max(target, self.duty - step)
                state = (round(self.duty, 2), self.on)
                if state != last:
                    self._apply()
                    last = state
            time.sleep(self.TICK)

    def status(self):
        with self.lock:
            return {
                "on": self.on,
                "target_rpm": self.target_rpm,
                "current_rpm": self.duty_to_rpm(self.duty),
                "duty": round(self.duty, 1),
                "max_rpm": self.max_rpm,
                "remaining": self.remaining(),
            }

    def stop_now(self):
        with self.lock:
            self.on = False
            self.timed = False
            self.duty = 0.0
            self._apply()


# =====================================================================
# HX711 load cell
# =====================================================================
class HX711:
    def __init__(self, gpio, dt, sck):
        self.g = gpio
        self.dt, self.sck = dt, sck
        self.g.output(self.sck, 0)
        self.g.input(self.dt)

    def read_raw(self, timeout=0.5):
        if self.g.sim:                       # fake reading for testing on a PC
            time.sleep(0.1)
            return 84000 + int(300 * (time.time() % 3))
        t0 = time.monotonic()
        while self.g.read(self.dt) == 1:     # DT goes LOW when data is ready
            if time.monotonic() - t0 > timeout:
                return None
            time.sleep(0.001)
        value = 0
        for _ in range(24):
            self.g.write(self.sck, 1)
            self.g.write(self.sck, 0)
            value = (value << 1) | self.g.read(self.dt)
        self.g.write(self.sck, 1)            # 25th pulse: channel A, gain 128
        self.g.write(self.sck, 0)
        if value & 0x800000:
            value -= 1 << 24
        if value in (0x7FFFFF, -0x800000):   # saturated / glitched read
            return None
        return value


class LoadCell:
    def __init__(self, hx, cfg):
        self.hx = hx
        self.cfg = cfg
        self.buf = []
        self.lock = threading.Lock()
        self.ok = False
        self.last_ok = 0.0
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while True:
            v = self.hx.read_raw()
            with self.lock:
                if v is not None:
                    self.buf.append(v)
                    n = int(self.cfg.get("samples", 10))
                    self.buf = self.buf[-n:]
                    self.last_ok = time.monotonic()
                self.ok = (time.monotonic() - self.last_ok) < 2.0
            time.sleep(0.05)

    def raw(self):
        with self.lock:
            return statistics.median(self.buf) if self.buf else None

    def weight(self):
        r = self.raw()
        if r is None:
            return None
        scale = float(self.cfg.get("scale", 1.0)) or 1.0
        return (r - float(self.cfg.get("offset", 0))) / scale

    def _fresh_raw(self, seconds=1.5):
        with self.lock:
            self.buf = []
        time.sleep(seconds)
        return self.raw()

    def tare(self):
        r = self._fresh_raw()
        if r is None:
            return False
        self.cfg["offset"] = r
        save_config(CONFIG)
        return True

    def calibrate(self, known):
        r = self._fresh_raw()
        if r is None or known == 0:
            return False
        diff = r - float(self.cfg.get("offset", 0))
        if diff == 0:
            return False
        self.cfg["scale"] = diff / known
        save_config(CONFIG)
        return True

    def status(self):
        w = self.weight()
        return {
            "ok": self.ok,
            "weight": None if w is None else round(w, 2),
            "raw": self.raw(),
            "unit": self.cfg.get("unit", "g"),
            "calibrated": float(self.cfg.get("scale", 1.0)) != 1.0,
        }


# =====================================================================
# ESP32 clients. Both offer the same methods:
#   set_dev(dev, state, dur)   set_rpm(dev, rpm)   alloff()
#   raw(cmd)                   status()
# =====================================================================
SAFE_ID = re.compile(r"^[a-z0-9_]+$")


def _clean_id(dev):
    dev = str(dev or "").strip().lower()
    if not SAFE_ID.match(dev):
        raise ValueError("bad device name")
    return dev


class Esp32Serial:
    """Talks to the ESP32 over USB serial with its text commands.
    Status comes from the ESP32's `json` command, which answers
    with one line:  STATUS {...}"""

    def __init__(self, cfg):
        self.cfg = cfg
        self.lock = threading.Lock()      # protects data / log
        self.wlock = threading.Lock()     # protects the port
        self.ser = None
        self.port = None
        self.data = None
        self.last_rx = 0.0
        self.error = "connecting..."
        self.log = collections.deque(maxlen=60)
        self.new_status = threading.Event()
        threading.Thread(target=self._reader, daemon=True).start()
        threading.Thread(target=self._poller, daemon=True).start()

    # ---- port handling ----
    def _find_port(self):
        p = str(self.cfg.get("esp32_port", "auto") or "auto")
        if p != "auto":
            return p
        found = (sorted(glob.glob("/dev/serial/by-id/*")) +
                 sorted(glob.glob("/dev/ttyUSB*")) +
                 sorted(glob.glob("/dev/ttyACM*")))
        return found[0] if found else None

    def _open(self):
        import serial  # pyserial
        port = self._find_port()
        if not port:
            raise RuntimeError("no USB serial port found - is the ESP32 plugged in?")
        s = serial.Serial(port, int(self.cfg.get("esp32_baud", 115200)), timeout=0.2)
        time.sleep(2)                     # opening the port may reset the ESP32
        s.reset_input_buffer()
        with self.wlock:
            self.ser, self.port = s, port
        self._add_log("[connected to %s]" % port)
        print("ESP32 serial connected on", port)

    def _drop(self, err):
        with self.wlock:
            if self.ser is not None:
                try:
                    self.ser.close()
                except Exception:
                    pass
            self.ser = None
        self.error = err
        self._add_log("[disconnected: %s]" % err)

    def _add_log(self, text):
        with self.lock:
            self.log.append(time.strftime("%H:%M:%S ") + text)

    # ---- threads ----
    def _reader(self):
        buf = b""
        while True:
            if self.ser is None:
                try:
                    self._open()
                    buf = b""
                except Exception as e:
                    self.error = str(e)
                    time.sleep(2)
                    continue
            try:
                chunk = self.ser.read(self.ser.in_waiting or 1)
            except Exception as e:
                self._drop(str(e))
                time.sleep(1)
                continue
            if not chunk:
                continue
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                self._handle_line(line.decode("utf-8", "replace").strip())
            if len(buf) > 8192:
                buf = b""

    def _handle_line(self, text):
        if not text:
            return
        if text.startswith("STATUS "):
            try:
                d = json.loads(text[7:])
            except ValueError:
                return
            with self.lock:
                self.data = d
                self.last_rx = time.monotonic()
                self.error = None
            self.new_status.set()
        else:
            self._add_log(text)

    def _poller(self):
        while True:
            self._send("json", log=False)
            time.sleep(1)

    # ---- sending ----
    def _send(self, cmd, log=True):
        cmd = cmd.replace("\r", " ").replace("\n", " ").strip()[:60]
        err = None
        with self.wlock:
            if self.ser is None:
                return False, self.error or "ESP32 not connected"
            try:
                self.ser.write((cmd + "\n").encode())
            except Exception as e:
                err = str(e)
        if err:
            self._drop(err)
            return False, err
        if log:
            self._add_log("> " + cmd)
        return True, None

    def raw(self, cmd):
        ok, err = self._send(cmd)
        if not ok:
            return ok, err
        self.new_status.clear()
        self._send("json", log=False)
        self.new_status.wait(0.6)         # wait briefly so the page shows the new state
        return True, None

    def set_dev(self, dev, state, dur=0):
        dev = _clean_id(dev)
        if state == "on":
            return self.raw("%s on %d" % (dev, int(dur)) if dur else "%s on" % dev)
        return self.raw("%s off" % dev)

    def set_rpm(self, dev, rpm):
        return self.raw("%s rpm %d" % (_clean_id(dev), int(rpm)))

    def alloff(self):
        return self.raw("alloff")

    @property
    def online(self):
        return self.ser is not None and time.monotonic() - self.last_rx < 3.5

    def status(self):
        with self.lock:
            d = self.data or {}
            online = self.online
            return {
                "online": online,
                "mode": "serial",
                "link": "serial " + (self.port or str(self.cfg.get("esp32_port", "auto"))),
                "error": None if online else (self.error or "no status from ESP32 (old sketch without `json` command?)"),
                "temp": d.get("temp") if online else None,
                "maxRpm": d.get("maxRpm", 1544),
                "devices": d.get("devices", []),
                "log": list(self.log),
            }


class Esp32Http:
    """Talks to the ESP32 sketch's /api endpoints over WiFi."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.lock = threading.Lock()
        self.data = None
        self.online = False
        self.error = "connecting..."
        self.session = requests.Session()
        threading.Thread(target=self._poll, daemon=True).start()

    @property
    def url(self):
        return self.cfg["esp32_url"].rstrip("/")

    def _store(self, data=None, err=None):
        with self.lock:
            if data is not None:
                self.data, self.online, self.error = data, True, None
            else:
                self.online, self.error = False, err

    def call(self, path, params=None):
        try:
            r = self.session.get(self.url + path, params=params, timeout=2)
            r.raise_for_status()
            self._store(r.json())
            return True, None
        except Exception as e:
            self._store(err=str(e))
            return False, str(e)

    def _poll(self):
        while True:
            self.call("/api/status")
            time.sleep(1)

    def set_dev(self, dev, state, dur=0):
        params = {"dev": _clean_id(dev), "state": state}
        if dur:
            params["dur"] = int(dur)
        return self.call("/api/set", params)

    def set_rpm(self, dev, rpm):
        return self.call("/api/speed", {"dev": _clean_id(dev), "rpm": int(rpm)})

    def alloff(self):
        return self.call("/api/alloff")

    def raw(self, cmd):
        return False, "raw serial commands need esp32_mode = serial"

    def status(self):
        with self.lock:
            d = self.data or {}
            return {
                "online": self.online,
                "mode": "http",
                "link": self.url.replace("http://", ""),
                "error": self.error,
                "temp": d.get("temp") if self.online else None,
                "maxRpm": d.get("maxRpm", 1544),
                "devices": d.get("devices", []),
                "log": [],
            }


# =====================================================================
# Flask app
# =====================================================================
centrifuge = Centrifuge(GPIO, CONFIG["centrifuge"])
loadcell = LoadCell(HX711(GPIO, CONFIG["loadcell"]["dt"], CONFIG["loadcell"]["sck"]), CONFIG["loadcell"])
esp = Esp32Http(CONFIG) if CONFIG.get("esp32_mode") == "http" else Esp32Serial(CONFIG)

app = Flask(__name__)


def arg(name, default=None):
    data = request.get_json(silent=True) or {}
    return data.get(name, request.values.get(name, default))


def full_status():
    return {
        "sim": GPIO.sim,
        "settings": {k: CONFIG.get(k) for k in ("esp32_mode", "esp32_port", "esp32_url")},
        "esp32": esp.status(),
        "centrifuge": centrifuge.status(),
        "loadcell": loadcell.status(),
    }


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def api_status():
    return jsonify(full_status())


# ---- ESP32 ----
def reply(ok, err=None):
    return jsonify(full_status() | {"ok": ok, "error": err})


@app.route("/api/esp/set", methods=["POST"])
def api_esp_set():
    try:
        dur = int(float(arg("dur") or 0))
        state = "on" if arg("state") == "on" else "off"
        ok, err = esp.set_dev(arg("dev"), state, dur)
    except ValueError as e:
        ok, err = False, str(e)
    return reply(ok, err)


@app.route("/api/esp/rpm", methods=["POST"])
def api_esp_rpm():
    try:
        ok, err = esp.set_rpm(arg("dev"), int(float(arg("rpm", 0))))
    except ValueError as e:
        ok, err = False, str(e)
    return reply(ok, err)


@app.route("/api/esp/cmd", methods=["POST"])
def api_esp_cmd():
    """Send any ESP32 serial command, e.g. {"cmd": "pumpin on 30"}"""
    cmd = str(arg("cmd") or "").strip()
    if not cmd:
        return reply(False, "empty command")
    ok, err = esp.raw(cmd)
    return reply(ok, err)


# ---- Centrifuge ----
@app.route("/api/centrifuge/set", methods=["POST"])
def api_cf_set():
    state = arg("state")
    dur = float(arg("dur", 0) or 0)
    if arg("rpm") not in (None, ""):
        centrifuge.set_rpm(float(arg("rpm")))
    centrifuge.set_state(state == "on", dur if state == "on" else 0)
    return jsonify(full_status() | {"ok": True})


@app.route("/api/centrifuge/rpm", methods=["POST"])
def api_cf_rpm():
    centrifuge.set_rpm(float(arg("rpm", 0)))
    return jsonify(full_status() | {"ok": True})


# ---- Load cell ----
@app.route("/api/loadcell/tare", methods=["POST"])
def api_lc_tare():
    ok = loadcell.tare()
    return jsonify(full_status() | {"ok": ok, "error": None if ok else "no reading from HX711"})


@app.route("/api/loadcell/calibrate", methods=["POST"])
def api_lc_cal():
    try:
        known = float(arg("weight"))
    except (TypeError, ValueError):
        return jsonify(full_status() | {"ok": False, "error": "enter the known weight"})
    ok = loadcell.calibrate(known)
    return jsonify(full_status() | {"ok": ok, "error": None if ok else "calibration failed - tare first, then put the weight on"})


# ---- Everything ----
@app.route("/api/alloff", methods=["POST"])
def api_alloff():
    centrifuge.set_state(False)
    ok, err = esp.alloff()
    return reply(ok, err)


def _restart_soon():
    time.sleep(1)
    centrifuge.stop_now()
    print("Restarting to apply settings...")
    os.execv(sys.executable, [sys.executable] + sys.argv)


@app.route("/api/settings", methods=["POST"])
def api_settings():
    mode = arg("esp32_mode")
    if mode in ("serial", "http"):
        CONFIG["esp32_mode"] = mode
    port = str(arg("esp32_port") or "").strip()
    if port:
        CONFIG["esp32_port"] = port
    url = str(arg("esp32_url") or "").strip()
    if url:
        if not url.startswith("http"):
            url = "http://" + url
        CONFIG["esp32_url"] = url.rstrip("/")
    save_config(CONFIG)
    threading.Thread(target=_restart_soon, daemon=True).start()
    return reply(True)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", CONFIG.get("web_port", 5000)))
    print("Open http://<this-pi-ip>:%d" % port)
    try:
        app.run(host="0.0.0.0", port=port, threaded=True, use_reloader=False)
    finally:
        centrifuge.stop_now()
