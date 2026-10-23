#!/usr/bin/env python3
"""
Raspberry Pi Process Control Panel (Flask)

- Controls the ESP32 (relays, heater, temperature) over the USB serial
  cable using the ESP32's serial commands (or over WiFi through its web
  API if esp32_mode is "http").
- Drives Mixer 1, Mixer 2 and the Centrifuge with ONE BTS7960 on Pi GPIO:
    every motor's + (positive) wire goes to the BTS7960 output,
    every motor's - (ground) wire goes through its own ESP32 relay
    (4-channel board: IN1 mixer1, IN2 mixer2, IN3 centrifuge).
  The relay chooses WHICH motor runs, the BTS7960 sets HOW FAST (RPM).
  Only one motor runs at a time - starting one stops the other first.
  Relays are only switched with the BTS7960 off (ramp down -> relay).
- Reads the HX711 load cell directly from Pi GPIO.

Pins are BCM (GPIO) numbers:
  BTS7960    : L_EN=23  R_EN=24  LPWM=25  RPWM=21
  HX711      : DT=17    SCK=27

Settings live in config.json (created automatically on first run).
The web page is inside this file (INDEX_HTML) - no templates folder needed.
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
from flask import Flask, Response, jsonify, request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")

DEFAULT_CONFIG = {
    "esp32_mode": "serial",               # "serial" (USB cable) or "http" (WiFi)
    "esp32_port": "auto",                 # serial port, e.g. /dev/ttyUSB0; "auto" finds it
    "esp32_baud": 115200,
    "esp32_url": "http://192.168.1.50",   # only used in http mode
    "web_port": 5000,
    "open_browser": True,                 # open the page on the Pi's screen at start
    "browser_kiosk": False,               # True = full screen, no address bar (touch screen)
    # The single BTS7960 shared by all motors
    "bts7960": {
        "pins": {"l_en": 23, "r_en": 24, "lpwm": 25, "rpwm": 21},
        "pwm_freq": 1000,       # Hz
        "direction": "forward", # forward = RPWM, reverse = LPWM (a motor can override)
        "relay_settle": 0.3,    # seconds to wait after the relay closes before driving
        "supply_volts": 24,     # power supply on the BTS7960 (B+ / B-)
    },
    # Motors on the BTS7960. "relay" = the ESP32 device id of its ground relay.
    #   volts        : the motor's rated voltage. The BTS7960 duty is capped at
    #                  volts / supply_volts (12 V motor on 24 V -> max 50%)
    #   max_duty     : (optional) overrides the volts-based cap, in % duty
    #   max_rpm      : the motor's RPM at its top duty (open loop, no speed sensor)
    #   min_duty     : % duty at 1 RPM; raise if the motor hums but won't spin
    #   ramp_seconds : time to ramp 0 -> 100% (soft start / soft stop)
    #   rpm          : the speed setting (changed from the web page, remembered)
    "motors": {
        "mixer1": {"label": "Mixer 1", "relay": "mixer1", "volts": 12, "max_duty": 75, "max_rpm": 1544,
                   "min_duty": 0, "ramp_seconds": 2.0, "rpm": 800},
        "mixer2": {"label": "Mixer 2", "relay": "mixer2", "volts": 12, "max_duty": 75, "max_rpm": 1544,
                   "min_duty": 0, "ramp_seconds": 2.0, "rpm": 800},
        "centrifuge": {"label": "Centrifuge", "relay": "centrifuge", "volts": 24, "max_rpm": 2500,
                       "min_duty": 0, "ramp_seconds": 3.0, "rpm": 1250},
    },
    "loadcell": {
        "dt": 17,
        "sck": 27,
        "offset": 0,                # raw reading with nothing on the scale (set by Tare / Step 1)
        "calibration_factor": 1.0,  # raw counts per unit (set by Step 2 from the known weight)
        "unit": "g",
        "samples": 10,              # median filter size for the live reading
        "cal_seconds": 3.0,         # how long each calibration step averages readings
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


def _migrate(saved):
    """Older config.json had a single "centrifuge" section - move it over."""
    old = saved.pop("centrifuge", None)
    if not isinstance(old, dict):
        return
    bts = saved.setdefault("bts7960", {})
    for k in ("pins", "pwm_freq", "direction"):
        if k in old:
            bts.setdefault(k, old[k])
    cf = saved.setdefault("motors", {}).setdefault("centrifuge", {})
    for k in ("max_rpm", "min_duty", "ramp_seconds"):
        if k in old:
            cf.setdefault(k, old[k])


def load_config():
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE) as f:
                saved = json.load(f)
            _migrate(saved)
            _merge(cfg, saved)
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
        self._pwm_active = set()      # pins that currently have PWM running
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
        freq = max(1, int(freq))          # lgpio rejects 0 Hz ("bad PWM micros")
        if duty <= 0:
            if pin in self._pwm_active:
                try:
                    self.lg.tx_pwm(self.h, pin, freq, 0)   # duty 0 stops the PWM
                except Exception:
                    pass
                self._pwm_active.discard(pin)
            self.lg.gpio_write(self.h, pin, 0)             # hold the pin LOW
        else:
            self.lg.tx_pwm(self.h, pin, freq, min(100.0, float(duty)))
            self._pwm_active.add(pin)


GPIO = Gpio()


# =====================================================================
# Motors: one BTS7960 + one ESP32 ground relay per motor
# =====================================================================
class MotorDriver:
    """Mixer 1, Mixer 2 and Centrifuge share ONE BTS7960.

    Each motor's + goes to the BTS7960 output and its - (ground) goes
    through its own ESP32 relay, so:
        relay closed  -> that motor is connected
        BTS7960 duty  -> its speed (open loop RPM -> PWM)
    Only one motor can run at a time.

    Start : other motor relays opened -> this relay closed (and confirmed by
            the ESP32) -> wait relay_settle -> BTS7960 enabled, ramp up to RPM
    Stop  : ramp down to 0 -> BTS7960 disabled -> relay opened
    A relay is never switched while current flows through it.
    If the ESP32 reports the relay open (reset, turned off elsewhere) or the
    ESP32 stops answering, the BTS7960 is shut off.
    """
    TICK = 0.05  # 20 Hz control loop

    def __init__(self, gpio, esp, cfg):
        self.g = gpio
        self.esp = esp
        self.cfg = cfg
        self.drv = cfg["bts7960"]
        p = self.drv["pins"]
        self.l_en, self.r_en, self.lpwm, self.rpwm = p["l_en"], p["r_en"], p["lpwm"], p["rpwm"]
        for pin in (self.l_en, self.r_en, self.lpwm, self.rpwm):
            self.g.output(pin, 0)
        self.lock = threading.Lock()
        self.want = None          # motor the user wants running (None = all off)
        self.want_dur = 0.0       # its timer, seconds (0 = no timer)
        self.active = None        # motor whose relay is closed and is being driven
        self.duty = 0.0           # BTS7960 duty being applied (ramps)
        self.start = 0.0
        self.dur = 0.0
        self.errors = {}
        self._applied = None
        self._last_fix = 0.0
        threading.Thread(target=self._loop, daemon=True).start()

    # ---- helpers ----
    @property
    def motors(self):
        return self.cfg["motors"]

    def label(self, name):
        return self.motors[name].get("label", name)

    def relay_of(self, name):
        return self.motors[name].get("relay", name)

    def relays(self):
        return [self.relay_of(n) for n in self.motors]

    def find(self, word):
        """Motor name from a motor name or a relay id."""
        word = str(word or "").strip().lower()
        if word in self.motors:
            return word
        for n in self.motors:
            if self.relay_of(n) == word:
                return n
        return None

    def max_rpm(self, name):
        return int(self.motors[name].get("max_rpm", 1000))

    def target_rpm(self, name):
        return max(0, min(self.max_rpm(name), int(self.motors[name].get("rpm", 0))))

    def supply_volts(self):
        return float(self.drv.get("supply_volts", 24)) or 24.0

    def motor_volts(self, name):
        return float(self.motors[name].get("volts", self.supply_volts()))

    def max_duty(self, name):
        """Highest duty allowed for this motor: "max_duty" if set, otherwise
        its rated volts / supply volts (12 V on 24 V -> 50%)."""
        m = self.motors[name]
        if m.get("max_duty") not in (None, ""):
            top = float(m["max_duty"])
        else:
            top = 100.0 * self.motor_volts(name) / self.supply_volts()
        return max(1.0, min(100.0, top))

    def rpm_to_duty(self, name, rpm):
        if rpm <= 0:
            return 0.0
        rpm = min(rpm, self.max_rpm(name))
        top = self.max_duty(name)
        mn = min(float(self.motors[name].get("min_duty", 0)), top)
        return min(top, mn + rpm * (top - mn) / self.max_rpm(name))

    def duty_to_rpm(self, name, duty):
        top = self.max_duty(name)
        mn = min(float(self.motors[name].get("min_duty", 0)), top)
        if duty <= mn or top <= mn:
            return 0
        return min(self.max_rpm(name), round((duty - mn) * self.max_rpm(name) / (top - mn)))

    # ---- commands (from the web page / API) ----
    def start_motor(self, name, dur=0, rpm=None):
        if name not in self.motors:
            return False, "unknown motor"
        if rpm is not None:
            self.set_rpm(name, rpm)
        if not self.esp.online:
            return False, "ESP32 offline - can't switch the %s relay" % self.label(name)
        dur = max(0.0, float(dur or 0))
        with self.lock:
            self.errors.pop(name, None)
            if self.active == name and self.want == name:
                self.start, self.dur = time.monotonic(), dur     # already running: new timer
            else:
                self.want, self.want_dur = name, dur
        print("%s -> ON%s at %d rpm" % (self.label(name), (" for %ds" % dur) if dur else "",
                                        self.target_rpm(name)))
        return True, None

    def stop_motor(self, name=None):
        with self.lock:
            if name is None or self.want == name:
                self.want = None
        return True, None

    def set_rpm(self, name, rpm):
        if name not in self.motors:
            return False, "unknown motor"
        self.motors[name]["rpm"] = max(0, min(self.max_rpm(name), int(float(rpm))))
        save_config(CONFIG)
        print("%s target = %d rpm" % (self.label(name), self.motors[name]["rpm"]))
        return True, None

    def emergency_stop(self):
        """Cut the BTS7960 at once (the loop then opens the relay)."""
        with self.lock:
            self.want = None
            self.duty = 0.0
            try:
                self._apply()
            except Exception as e:
                print("BTS7960 stop error:", e)

    # ---- BTS7960 output (call with self.lock held) ----
    def _apply(self):
        m = self.motors.get(self.active, {})
        direction = m.get("direction") or self.drv.get("direction", "forward")
        state = (round(self.duty, 2), direction)
        if state == self._applied:
            return
        freq = int(self.drv.get("pwm_freq", 1000))
        if self.duty <= 0:
            # both PWM low AND enables low = outputs off (no braking current
            # through the relay, so it can open safely)
            self.g.pwm(self.lpwm, freq, 0)
            self.g.pwm(self.rpwm, freq, 0)
            self.g.write(self.l_en, 0)
            self.g.write(self.r_en, 0)
        else:
            self.g.write(self.l_en, 1)
            self.g.write(self.r_en, 1)
            if direction == "reverse":
                self.g.pwm(self.rpwm, freq, 0)
                self.g.pwm(self.lpwm, freq, self.duty)
            else:
                self.g.pwm(self.lpwm, freq, 0)
                self.g.pwm(self.rpwm, freq, self.duty)
        self._applied = state

    def _ramp(self, target):
        if self.active:
            target = min(target, self.max_duty(self.active))   # never over the motor's voltage
        ramp = max(0.1, float(self.motors.get(self.active, {}).get("ramp_seconds", 3.0)))
        step = 100.0 * self.TICK / ramp
        if self.duty < target:
            self.duty = min(target, self.duty + step)
        elif self.duty > target:
            self.duty = max(target, self.duty - step)
        self._apply()

    # ---- control loop ----
    def _loop(self):
        last_err = None
        while True:
            try:
                self._step()
                last_err = None
            except Exception as e:
                # never let one error kill the motor control loop
                if str(e) != last_err:
                    print("Motor control error:", e)
                    last_err = str(e)
                self._applied = None      # retry applying next tick
            time.sleep(self.TICK)

    def _fail(self, name, msg):
        with self.lock:
            if self.want == name:
                self.want = None
            self.errors[name] = msg
        print("%s: %s" % (self.label(name), msg))

    def _step(self):
        now = time.monotonic()
        with self.lock:
            want, active = self.want, self.active
            if active and want == active and self.dur > 0 and now - self.start >= self.dur:
                self.want = want = None
                print("[timer] %s -> OFF" % self.label(active))

        # 1) a motor is connected but should stop (off, timer, or switching motor)
        if active and want != active:
            with self.lock:
                if self.duty > 0:
                    self._ramp(0.0)
                    return
            self._disconnect(active)
            return

        # 2) a motor is running: watch its relay, follow its RPM
        if active:
            st = self.esp.dev_state(self.relay_of(active))
            if st is not True:
                with self.lock:
                    if st is False:         # relay already open -> cut now
                        self.duty = 0.0
                        self._apply()
                if st is False:
                    self._fail(active, "ground relay was switched off (ESP32 reset or turned off "
                                       "elsewhere) - motor stopped")
                elif not self.esp.online:
                    self._fail(active, "ESP32 connection lost - motor stopped")
                else:
                    self._fail(active, "ESP32 has no relay called '%s'" % self.relay_of(active))
                return
            self._open_others(active, throttle=True)
            with self.lock:
                self._ramp(self.rpm_to_duty(active, self.target_rpm(active)))
            return

        # 3) nothing connected: connect the wanted motor, or make sure all is off
        if want:
            self._connect(want)
        else:
            with self.lock:
                if self.duty > 0 or self._applied is None:
                    self.duty = 0.0
                    self._apply()

    def _open_others(self, name, throttle=False):
        """Any other motor's relay closed would put it on the BTS7960 too."""
        if throttle and time.monotonic() - self._last_fix < 2.0:
            return
        for other in self.motors:
            r = self.relay_of(other)
            if other != name and r != self.relay_of(name) and self.esp.dev_state(r):
                self._last_fix = time.monotonic()
                print("Opening %s relay (only one motor may be connected)" % self.label(other))
                self.esp.set_dev(r, "off")

    def _wait_relay(self, relay, state, timeout=2.5):
        t0 = time.monotonic()
        while time.monotonic() - t0 < timeout:
            if self.esp.dev_state(relay) is state:
                return True
            time.sleep(0.1)
        return False

    def _connect(self, name):
        relay = self.relay_of(name)
        if not self.esp.online:
            self._fail(name, "ESP32 offline - can't close the ground relay")
            return
        with self.lock:
            self.duty = 0.0
            self._apply()
        self._open_others(name)
        ok, err = self.esp.set_dev(relay, "on")
        if ok and not self._wait_relay(relay, True):
            ok, err = False, "ESP32 did not confirm the '%s' relay is ON" % relay
        if not ok:
            self.esp.set_dev(relay, "off")
            self._fail(name, err or "relay did not switch on")
            return
        time.sleep(float(self.drv.get("relay_settle", 0.3)))
        with self.lock:
            if self.want == name:
                self.active = name
                self.start = time.monotonic()
                self.dur = self.want_dur
                print("%s relay closed - ramping to %d rpm" % (self.label(name), self.target_rpm(name)))
                return
        self.esp.set_dev(relay, "off")      # cancelled while the relay was closing

    def _disconnect(self, name):
        with self.lock:
            self.duty = 0.0
            self._apply()
        time.sleep(0.15)                     # let the motor current die away
        ok, err = self.esp.set_dev(self.relay_of(name), "off")
        if not ok:
            print("%s relay off failed: %s (BTS7960 is off)" % (self.label(name), err))
        with self.lock:
            if self.active == name:
                self.active = None
        print("%s -> OFF" % self.label(name))

    # ---- status ----
    def status(self):
        now = time.monotonic()
        with self.lock:
            out = []
            for n in self.motors:
                running = self.active == n
                wanted = self.want == n
                if running and wanted:
                    state = "ON"
                elif running:
                    state = "STOPPING"
                elif wanted:
                    state = "STARTING"
                else:
                    state = "OFF"
                remaining = 0
                if running and wanted and self.dur > 0:
                    remaining = max(0, int(self.dur - (now - self.start) + 0.999))
                elif wanted and not running:
                    remaining = int(self.want_dur)
                out.append({
                    "id": n,
                    "label": self.label(n),
                    "relay": self.relay_of(n),
                    "relay_on": self.esp.dev_state(self.relay_of(n)),
                    "state": state,
                    "on": wanted,
                    "target_rpm": self.target_rpm(n),
                    "current_rpm": self.duty_to_rpm(n, self.duty) if running else 0,
                    "duty": round(self.duty, 1) if running else 0,
                    "max_rpm": self.max_rpm(n),
                    "volts": self.motor_volts(n),
                    "max_duty": round(self.max_duty(n), 1),
                    "supply_volts": self.supply_volts(),
                    "remaining": remaining,
                    "error": self.errors.get(n),
                })
            return {"list": out, "relays": self.relays(), "active": self.active}


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
    """Live weight + calibration.

    weight = (raw - offset) / calibration_factor

    Calibration (done from the web page or the API):
      Step 1  empty scale   -> offset = average raw reading
      Step 2  known weight  -> calibration_factor = (average raw - offset) / known weight
    A negative factor is fine: it just means the load cell is wired the other way round.
    """

    def __init__(self, hx, cfg):
        self.hx = hx
        self.cfg = cfg
        # older config files called the factor "scale"
        if "scale" in cfg:
            old = cfg.pop("scale")
            if float(cfg.get("calibration_factor", 1.0)) == 1.0:
                cfg["calibration_factor"] = old
            save_config(CONFIG)
        self.buf = []
        self.collect = None          # list that gathers every reading during a calibration step
        self.lock = threading.Lock()
        self.cal_lock = threading.Lock()
        self.ok = False
        self.last_ok = 0.0
        self.zeroed = float(cfg.get("offset", 0)) != 0
        self.last_cal = None         # details of the last calibration, shown on the page
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        last_err = None
        while True:
            try:
                v = self.hx.read_raw()
                last_err = None
            except Exception as e:
                if str(e) != last_err:
                    print("HX711 read error:", e)
                    last_err = str(e)
                v = None
                time.sleep(0.5)
            with self.lock:
                if v is not None:
                    self.buf.append(v)
                    n = int(self.cfg.get("samples", 10))
                    self.buf = self.buf[-n:]
                    if self.collect is not None:
                        self.collect.append(v)
                    self.last_ok = time.monotonic()
                self.ok = (time.monotonic() - self.last_ok) < 2.0
            time.sleep(0.05)

    # ---- readings ----
    @property
    def factor(self):
        return float(self.cfg.get("calibration_factor", 1.0)) or 1.0

    def raw(self):
        with self.lock:
            return statistics.median(self.buf) if self.buf else None

    def weight(self):
        r = self.raw()
        if r is None:
            return None
        return (r - float(self.cfg.get("offset", 0))) / self.factor

    def _average(self, seconds=None):
        """Collect readings for a few seconds and return (average, noise, count).
        The highest and lowest 20% are dropped so a bump doesn't spoil it."""
        seconds = float(seconds or self.cfg.get("cal_seconds", 3.0))
        with self.lock:
            self.collect = []
        time.sleep(seconds)
        with self.lock:
            vals, self.collect = self.collect, None
        if len(vals) < 5:
            return None, None, len(vals)
        vals.sort()
        cut = len(vals) // 5
        core = vals[cut:len(vals) - cut] or vals
        avg = sum(core) / len(core)
        noise = statistics.pstdev(core)
        return avg, noise, len(vals)

    # ---- calibration ----
    def tare(self):
        """Step 1 (or plain Tare): zero the scale with nothing on it."""
        with self.cal_lock:
            avg, noise, n = self._average()
            if avg is None:
                return False, "not enough readings from HX711 (got %d) - check wiring" % n, None
            self.cfg["offset"] = round(avg, 2)
            self.zeroed = True
            save_config(CONFIG)
            info = {"offset": round(avg, 1), "noise_raw": round(noise, 1), "samples": n}
            print("Load cell zeroed: offset=%.1f (noise %.1f, %d samples)" % (avg, noise, n))
            return True, None, info

    def calibrate(self, known):
        """Step 2: known weight is on the scale -> work out calibration_factor."""
        if known is None or known <= 0:
            return False, "enter the known weight (more than 0)", None
        if not self.zeroed:
            return False, "do Step 1 first: zero the scale with nothing on it", None
        with self.cal_lock:
            avg, noise, n = self._average()
            if avg is None:
                return False, "not enough readings from HX711 (got %d) - check wiring" % n, None
            diff = avg - float(self.cfg.get("offset", 0))
            # the weight must move the reading clearly more than the noise
            if abs(diff) < max(50.0, 10 * noise):
                return False, ("reading barely changed (%d counts). Do Step 1 with the scale empty, "
                               "then put the weight on and try again" % round(diff)), None
            factor = diff / known
            self.cfg["calibration_factor"] = round(factor, 6)
            save_config(CONFIG)
            unit = self.cfg.get("unit", "g")
            self.last_cal = {
                "known": known,
                "unit": unit,
                "factor": factor,
                "samples": n,
                "resolution": round(abs(noise / factor), 3),   # noise expressed in units
                "time": time.strftime("%Y-%m-%d %H:%M"),
            }
            print("Load cell calibrated: factor=%.4f using %s %s (%d samples)" % (factor, known, unit, n))
            return True, None, self.last_cal

    def set_factor(self, factor):
        if factor == 0:
            return False, "calibration factor can't be 0"
        self.cfg["calibration_factor"] = float(factor)
        save_config(CONFIG)
        return True, None

    def set_unit(self, unit):
        unit = str(unit).strip()[:8]
        if unit:
            self.cfg["unit"] = unit
            save_config(CONFIG)

    def status(self):
        w = self.weight()
        return {
            "ok": self.ok,
            "weight": None if w is None else round(w, 2),
            "raw": self.raw(),
            "unit": self.cfg.get("unit", "g"),
            "offset": round(float(self.cfg.get("offset", 0)), 1),
            "calibration_factor": round(self.factor, 4),
            "zeroed": self.zeroed,
            "calibrated": self.factor != 1.0,
            "busy": self.cal_lock.locked(),
            "last_cal": self.last_cal,
        }


# =====================================================================
# ESP32 clients. Both offer the same methods:
#   set_dev(dev, state, dur)   dev_state(dev)   alloff()
#   raw(cmd)                   status()
# =====================================================================
SAFE_ID = re.compile(r"^[a-z0-9_]+$")


def _clean_id(dev):
    dev = str(dev or "").strip().lower()
    if not SAFE_ID.match(dev):
        raise ValueError("bad device name")
    return dev


def _find_state(data, dev):
    """True / False from the ESP32's last status, None if not reported."""
    for d in (data or {}).get("devices", []):
        if d.get("id") == dev:
            return bool(d.get("on"))
    return None


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
        self.opened_at = 0.0
        self.rx_lines = 0
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
        try:
            import serial  # pyserial
        except ImportError:
            raise RuntimeError("pyserial is not installed for %s - run: %s -m pip install pyserial"
                               % (sys.executable, sys.executable))
        port = self._find_port()
        if not port:
            raise RuntimeError("no USB serial port found - is the ESP32 plugged in?")
        s = serial.Serial()
        s.port = port
        s.baudrate = int(self.cfg.get("esp32_baud", 115200))
        s.timeout = 0.2
        # Keep DTR/RTS released so the ESP32 runs normally instead of being
        # held in reset / boot mode by its auto-reset circuit.
        s.dtr = False
        s.rts = False
        try:
            s.open()
        except serial.SerialException as e:
            msg = str(e)
            if "ermission" in msg:
                raise RuntimeError("permission denied on %s - run: sudo usermod -aG dialout $USER  then reboot" % port)
            if "busy" in msg.lower() or "lock" in msg.lower():
                raise RuntimeError("%s is busy - close Arduino Serial Monitor / other programs using it" % port)
            raise RuntimeError("cannot open %s: %s" % (port, msg))
        time.sleep(2)                     # give the ESP32 time if the port opening reset it
        s.reset_input_buffer()
        with self.wlock:
            self.ser, self.port = s, port
        self.error = None
        self.opened_at = time.monotonic()
        self.rx_lines = 0
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
                    if str(e) != self.error:
                        print("ESP32 serial:", e)
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
        self.rx_lines += 1
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

    def alloff(self):
        return self.raw("alloff")

    def dev_state(self, dev):
        if not self.online:
            return None
        with self.lock:
            return _find_state(self.data, dev)

    @property
    def online(self):
        return self.ser is not None and time.monotonic() - self.last_rx < 3.5

    def _why_offline(self):
        if self.ser is None:
            return self.error or "not connected"
        waited = time.monotonic() - self.opened_at
        if self.last_rx > self.opened_at:
            return "ESP32 stopped answering - was it reset or unplugged?"
        if waited < 15:
            return "port open, waiting for the ESP32 to answer (it can take ~12 s after a reset)..."
        if self.rx_lines > 0:
            return ("ESP32 is talking but doesn't answer the `json` command - upload the updated "
                    "esp32_process_controller.ino")
        return ("port %s is open but nothing comes back - check the baud rate (115200), that the "
                "ESP32 sketch is uploaded, and press the ESP32's EN/RST button" % self.port)

    def status(self):
        with self.lock:
            d = self.data or {}
            online = self.online
            return {
                "online": online,
                "mode": "serial",
                "link": "serial " + (self.port or str(self.cfg.get("esp32_port", "auto"))),
                "error": None if online else self._why_offline(),
                "temp": d.get("temp") if online else None,
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

    def dev_state(self, dev):
        with self.lock:
            return _find_state(self.data, dev) if self.online else None

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
                "devices": d.get("devices", []),
                "log": [],
            }


# =====================================================================
# Flask app
# =====================================================================
esp = Esp32Http(CONFIG) if CONFIG.get("esp32_mode") == "http" else Esp32Serial(CONFIG)
motors = MotorDriver(GPIO, esp, CONFIG)
loadcell = LoadCell(HX711(GPIO, CONFIG["loadcell"]["dt"], CONFIG["loadcell"]["sck"]), CONFIG["loadcell"])

app = Flask(__name__)


def arg(name, default=None):
    data = request.get_json(silent=True) or {}
    return data.get(name, request.values.get(name, default))


def full_status():
    return {
        "sim": GPIO.sim,
        "settings": {k: CONFIG.get(k) for k in ("esp32_mode", "esp32_port", "esp32_url")},
        "esp32": esp.status(),
        "motors": motors.status(),
        "loadcell": loadcell.status(),
    }


@app.route("/")
def index():
    return Response(INDEX_HTML, mimetype="text/html")


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
        name = motors.find(arg("dev"))
        if name:                          # motor relays go through the motor driver
            ok, err = motors.start_motor(name, dur) if state == "on" else motors.stop_motor(name)
        else:
            ok, err = esp.set_dev(arg("dev"), state, dur)
    except ValueError as e:
        ok, err = False, str(e)
    return reply(ok, err)


def motor_command(words):
    """Console commands for motors: <motor> on [sec] [rpm] | off | rpm <n>"""
    name = motors.find(words[0])
    if not name:
        return None
    try:
        if len(words) >= 2 and words[1] == "on":
            dur = float(words[2]) if len(words) >= 3 else 0
            rpm = float(words[3]) if len(words) >= 4 else None
            return motors.start_motor(name, dur, rpm)
        if len(words) >= 2 and words[1] == "off":
            return motors.stop_motor(name)
        if len(words) >= 3 and words[1] in ("rpm", "speed"):
            return motors.set_rpm(name, float(words[2]))
    except ValueError:
        return False, "bad number"
    return False, "use: %s on [seconds] [rpm]  |  %s off  |  %s rpm <0-%d>" % (
        name, name, name, motors.max_rpm(name))


@app.route("/api/esp/cmd", methods=["POST"])
def api_esp_cmd():
    """Send any ESP32 serial command, e.g. {"cmd": "pumpin on 30"}.
    Motor commands (mixer1 / mixer2 / centrifuge) and alloff are handled
    here so the BTS7960 and the relays always stay in step."""
    cmd = str(arg("cmd") or "").strip()
    if not cmd:
        return reply(False, "empty command")
    words = cmd.lower().split()
    if words[0] == "alloff":
        ok, err = do_alloff()
        return reply(ok, err)
    res = motor_command(words)
    if res is not None:
        return reply(*res)
    ok, err = esp.raw(cmd)
    return reply(ok, err)


# ---- Motors (BTS7960 + ESP32 ground relays) ----
@app.route("/api/motor/set", methods=["POST"])
def api_motor_set():
    """Body: {"motor": "mixer1", "state": "on", "dur": 30, "rpm": 900}"""
    name = motors.find(arg("motor"))
    if not name:
        return reply(False, "unknown motor")
    try:
        rpm = arg("rpm")
        rpm = None if rpm in (None, "") else float(rpm)
        if arg("state") == "on":
            ok, err = motors.start_motor(name, float(arg("dur", 0) or 0), rpm)
        else:
            ok, err = motors.stop_motor(name)
    except (TypeError, ValueError):
        ok, err = False, "bad number"
    return reply(ok, err)


@app.route("/api/motor/rpm", methods=["POST"])
def api_motor_rpm():
    """Body: {"motor": "centrifuge", "rpm": 1800}"""
    name = motors.find(arg("motor"))
    if not name:
        return reply(False, "unknown motor")
    try:
        ok, err = motors.set_rpm(name, float(arg("rpm", 0)))
    except (TypeError, ValueError):
        ok, err = False, "bad number"
    return reply(ok, err)


# ---- Load cell ----
def _num(name):
    try:
        return float(arg(name))
    except (TypeError, ValueError):
        return None


@app.route("/api/loadcell/tare", methods=["POST"])
def api_lc_tare():
    """Tare / calibration Step 1: nothing on the scale."""
    ok, err, info = loadcell.tare()
    return jsonify(full_status() | {"ok": ok, "error": err, "result": info})


@app.route("/api/loadcell/calibrate", methods=["POST"])
def api_lc_cal():
    """Calibration Step 2: known weight on the scale -> sets calibration_factor.
    Body: {"weight": 500}  (optional "unit": "g")"""
    if arg("unit"):
        loadcell.set_unit(arg("unit"))
    ok, err, info = loadcell.calibrate(_num("weight"))
    return jsonify(full_status() | {"ok": ok, "error": err, "result": info})


@app.route("/api/loadcell/factor", methods=["POST"])
def api_lc_factor():
    """Type in a calibration_factor by hand. Body: {"calibration_factor": -412.7}"""
    f = _num("calibration_factor")
    if f is None:
        return jsonify(full_status() | {"ok": False, "error": "enter a number"})
    ok, err = loadcell.set_factor(f)
    return jsonify(full_status() | {"ok": ok, "error": err})


# ---- Everything ----
def do_alloff():
    motors.emergency_stop()               # BTS7960 off first ...
    time.sleep(0.2)
    return esp.alloff()                   # ... then every relay opens


@app.route("/api/alloff", methods=["POST"])
def api_alloff():
    ok, err = do_alloff()
    return reply(ok, err)


def _restart_soon():
    time.sleep(1)
    motors.emergency_stop()
    print("Restarting to apply settings...")
    os.environ["PI_CONTROL_NO_BROWSER"] = "1"   # browser is already open
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


# =====================================================================
# Web page (HTML, CSS and JavaScript all in this one file)
# =====================================================================
INDEX_HTML = r'''<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Process Control</title>
<style>
:root{--bg:#eef1f5;--card:#fff;--text:#1f2328;--muted:#5f6b7a;--line:#d6dbe1;
  --on:#2e7d32;--off:#c62828;--run:#1565c0;--warn:#b26a00}
*{box-sizing:border-box}
body{font-family:system-ui,Arial,sans-serif;background:var(--bg);margin:0;padding:14px;color:var(--text)}
h1{font-size:21px;margin:2px 0 12px}
h2{font-size:15px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:22px 0 10px}
.top{display:flex;gap:10px;flex-wrap:wrap;align-items:stretch;margin-bottom:6px}
.tile{background:var(--card);border-radius:10px;padding:10px 16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.tile .k{font-size:12px;color:var(--muted)}
.tile .v{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums}
.tile .v small{font-size:14px;font-weight:400;color:var(--muted)}
.conn{display:flex;align-items:center;gap:8px;font-size:14px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--off)}
.dot.ok{background:var(--on)}
.alloff{background:#111;color:#fff;border:0;border-radius:10px;padding:0 22px;font-size:16px;font-weight:700;cursor:pointer;margin-left:auto}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}
.card{background:var(--card);border-radius:10px;padding:12px;box-shadow:0 1px 3px rgba(0,0,0,.08);border-left:6px solid #bbb}
.card.on{border-left-color:var(--on)}
.card.wide{grid-column:1/-1}
.name{font-weight:700;display:flex;justify-content:space-between;align-items:center}
.st{font-size:12px;padding:2px 9px;border-radius:10px;background:#ddd}
.on .st{background:var(--on);color:#fff}
.row{display:flex;gap:6px;margin-top:9px;align-items:center}
button.b{flex:1;padding:10px;border:0;border-radius:6px;font-size:15px;cursor:pointer;color:#fff}
.b-on{background:var(--on)}.b-off{background:var(--off)}.b-run{background:var(--run)}.b-grey{background:#455a64}
input[type=number],input[type=text]{width:90px;padding:9px;border:1px solid var(--line);border-radius:6px;font-size:15px;background:#fff;color:var(--text)}
input[type=text]{flex:1;width:auto}
input[type=range]{flex:1}
.spd{font-size:14px;margin-top:10px}
.rem{font-size:13px;color:var(--run);min-height:16px;margin-top:6px}
.muted{color:var(--muted);font-size:13px}
.big{font-size:54px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.1}
.big small{font-size:22px;color:var(--muted);font-weight:400}
.lc{display:flex;flex-wrap:wrap;gap:24px;align-items:center}
.lc .ctl{flex:1;min-width:260px}
.banner{background:#fff3cd;color:#664d03;border-radius:8px;padding:8px 12px;margin-bottom:10px;font-size:14px;display:none}
.msg{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);background:#222;color:#fff;padding:10px 16px;border-radius:8px;font-size:14px;display:none;max-width:90%}
.empty{padding:14px;color:var(--muted)}
details{margin-top:24px}
.cal{border-top:1px solid var(--line);margin-top:14px;padding-top:12px}
.calhead{font-weight:700;margin-bottom:6px}
.step{display:flex;gap:12px;padding:10px 0;border-bottom:1px dashed var(--line)}
.step:last-child{border-bottom:0}
.sn{flex:0 0 28px;height:28px;border-radius:50%;background:#cfd6de;color:#333;display:flex;align-items:center;justify-content:center;font-weight:700}
.step.done .sn{background:var(--on);color:#fff}
.sb{flex:1;min-width:0}
.res{font-size:13px;margin-top:6px;min-height:16px;color:var(--on)}
.st.wait{background:var(--warn);color:#fff}
.merr{color:var(--off);font-size:13px;margin-top:4px}
.note{color:var(--muted);font-size:13px;margin:-4px 0 10px}
button:disabled{opacity:.45;cursor:not-allowed}
.res.err{color:var(--off)}
.log{background:#11161c;color:#d6e2ee;border-radius:6px;padding:10px;height:190px;overflow:auto;margin:0;font-size:12.5px;line-height:1.45;white-space:pre-wrap}
select{padding:9px;border:1px solid var(--line);border-radius:6px;font-size:15px;background:#fff;flex:1}
summary{cursor:pointer;color:var(--muted);font-size:14px}
</style></head>
<body>
<h1>Process Control Panel</h1>
<div class="banner" id="sim">Simulation mode: no Raspberry Pi GPIO found. The BTS7960 and load cell are simulated.</div>

<div class="top">
  <div class="tile"><div class="k">Temperature (ESP32)</div><div class="v"><span id="temp">--</span> <small>&deg;C</small></div></div>
  <div class="tile"><div class="k">Load cell</div><div class="v"><span id="wtop">--</span> <small class="unit">g</small></div></div>
  <div class="tile conn"><span class="dot" id="espdot"></span><span id="espconn">ESP32: connecting...</span></div>
  <button class="alloff" onclick="post('/api/alloff')">ALL OFF</button>
</div>

<div class="banner" id="esperr" style="background:#fde2e1;color:#7a1712;margin-top:10px"></div>
<h2>ESP32 devices</h2>
<div class="grid" id="espgrid"><div class="empty">Waiting for ESP32...</div></div>

<h2>Motors (BTS7960 on the Pi)</h2>
<div class="note">The motors share one BTS7960, and each one's ground relay on the ESP32 picks which motor runs.
Only one motor runs at a time, so starting a motor stops the one that is running first.</div>
<div class="grid" id="mgrid"><div class="empty">Loading...</div></div>

<h2>Load cell (HX711)</h2>
<div class="card wide">
  <div class="lc">
    <div>
      <div class="big"><span id="w">--</span> <small class="unit">g</small></div>
      <div class="muted">raw: <span id="raw">--</span> &middot; <span id="lcstate">--</span></div>
    </div>
    <div class="ctl">
      <div class="row"><button class="b b-grey" onclick="tare()">Tare (zero)</button></div>
      <div class="muted" style="margin-top:8px">calibration_factor: <b id="cf_now">--</b> &middot; offset: <span id="off_now">--</span></div>
    </div>
  </div>

  <div class="cal">
    <div class="calhead">Calibration</div>
    <div class="step" id="st1">
      <div class="sn">1</div>
      <div class="sb">
        <b>Empty the scale</b>
        <div class="muted">Remove everything from the load cell, then press Zero. Keep it still for 3 seconds.</div>
        <div class="row"><button class="b b-grey" onclick="calZero()">Zero (empty scale)</button></div>
        <div class="res" id="r1"></div>
      </div>
    </div>
    <div class="step" id="st2">
      <div class="sn">2</div>
      <div class="sb">
        <b>Put a known weight on and enter it</b>
        <div class="muted">Use something you know the exact weight of. The calibration_factor is calculated from it automatically.</div>
        <div class="row">
          <input type="number" step="any" min="0" placeholder="e.g. 500" id="calw">
          <select id="calu" style="flex:0 0 80px"><option>g</option><option>kg</option><option>lb</option><option>oz</option></select>
          <button class="b b-run" onclick="calibrate()">Calculate factor</button>
        </div>
        <div class="res" id="r2"></div>
      </div>
    </div>
    <div class="step" id="st3">
      <div class="sn">3</div>
      <div class="sb">
        <b>Check</b>
        <div class="muted">The reading above should now show your weight. Try a different weight to confirm. Saved automatically.</div>
        <div class="row">
          <input type="number" step="any" placeholder="factor" id="cfman" style="width:150px">
          <button class="b b-grey" onclick="setFactor()">Set factor manually</button>
        </div>
      </div>
    </div>
  </div>
</div>

<details open>
  <summary>ESP32 serial console</summary>
  <div class="card" style="margin-top:8px">
    <pre class="log" id="log">No messages yet.</pre>
    <div class="row">
      <input type="text" id="cmd" placeholder="e.g. pumpin on 30  /  mixer1 on 60 900  /  centrifuge rpm 2000  /  status"
        onkeydown="if(event.key==='Enter')sendCmd()">
      <button class="b b-run" style="flex:0 0 auto;padding:10px 18px" onclick="sendCmd()">Send</button>
    </div>
  </div>
</details>

<details>
  <summary>Settings</summary>
  <div class="card" style="margin-top:8px;max-width:560px">
    <div class="muted">How the Pi talks to the ESP32</div>
    <div class="row">
      <select id="mode" onchange="modeUi()">
        <option value="serial">USB serial cable</option>
        <option value="http">WiFi (ESP32 IP address)</option>
      </select>
    </div>
    <div class="row" id="portrow"><input type="text" id="port" placeholder="auto  or  /dev/ttyUSB0"></div>
    <div class="row" id="urlrow"><input type="text" id="espurl" placeholder="http://192.168.1.50"></div>
    <div class="row"><button class="b b-run" onclick="saveSettings()">Save &amp; restart app</button></div>
  </div>
</details>

<div class="msg" id="msg"></div>

<script>
let espKey='', mKey='', urlFilled=false, busy=false, motorRelays=[], espOnline=false;
const $=id=>document.getElementById(id);

function toast(t){const m=$('msg');m.textContent=t;m.style.display='block';clearTimeout(m._t);m._t=setTimeout(()=>m.style.display='none',3500);}

function post(url,body){
  return fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})})
    .then(r=>r.json()).then(s=>{ if(s.ok===false&&s.error)toast(s.error); render(s); return s; })
    .catch(()=>toast('Pi not reachable'));
}
function poll(){ if(busy)return; fetch('/api/status').then(r=>r.json()).then(render).catch(()=>{}); }

/* ---------- ESP32 ---------- */
function espSet(id,state){post('/api/esp/set',{dev:id,state:state});}
function espRun(id){
  const v=parseInt($('d_'+id).value);
  if(!(v>0)){toast('Enter duration in seconds');return;}
  post('/api/esp/set',{dev:id,state:'on',dur:v});
}
function buildEsp(devs){
  let h='';
  devs.forEach(d=>{
    h+='<div class="card" id="c_'+d.id+'"><div class="name">'+d.label+'<span class="st" id="s_'+d.id+'">OFF</span></div>'+
      '<div class="row"><button class="b b-on" onclick="espSet(\''+d.id+'\',\'on\')">ON</button>'+
      '<button class="b b-off" onclick="espSet(\''+d.id+'\',\'off\')">OFF</button></div>'+
      '<div class="row"><input type="number" min="1" placeholder="sec" id="d_'+d.id+'">'+
      '<button class="b b-run" onclick="espRun(\''+d.id+'\')">ON for duration</button></div>'+
      '<div class="rem" id="r_'+d.id+'"></div></div>';
  });
  $('espgrid').innerHTML=h||'<div class="empty">No devices reported.</div>';
}
function renderEsp(e){
  $('espdot').className='dot'+(e.online?' ok':'');
  $('espconn').textContent='ESP32 '+(e.online?'online':'offline')+' ('+e.link+')';
  $('espconn').title=e.error||'';
  const ew=$('esperr'); ew.textContent=e.online?'':('ESP32: '+(e.error||'not connected')); ew.style.display=e.online?'none':'block';
  $('temp').textContent=(e.temp===null||e.temp===undefined)?'--':Number(e.temp).toFixed(1);
  const lg=$('log'), txt=(e.log&&e.log.length)?e.log.join('\n'):(e.online?'No messages yet.':('Not connected: '+(e.error||'')));
  if(lg.textContent!==txt){const atEnd=lg.scrollTop+lg.clientHeight>=lg.scrollHeight-20;lg.textContent=txt;if(atEnd)lg.scrollTop=lg.scrollHeight;}
  const devs=e.devices.filter(d=>motorRelays.indexOf(d.id)<0);  // motor relays are run from the Motors cards
  if(!devs.length)return;
  const key=devs.map(d=>d.id).join(',');
  if(key!==espKey){buildEsp(devs);espKey=key;}
  devs.forEach(d=>{
    $('c_'+d.id).className='card'+(d.on?' on':'');
    $('s_'+d.id).textContent=d.on?'ON':'OFF';
    $('r_'+d.id).textContent=d.remaining>0?('Auto-off in '+d.remaining+' s'):'';
  });
  document.querySelectorAll('#espgrid button').forEach(b=>b.disabled=!e.online);
}

/* ---------- Motors ---------- */
function mSet(id,state){post('/api/motor/set',{motor:id,state:state});}
function mRun(id){
  const v=parseInt($('md_'+id).value);
  if(!(v>0)){toast('Enter duration in seconds');return;}
  post('/api/motor/set',{motor:id,state:'on',dur:v});
}
function mRpm(id,v,max){
  v=Math.max(0,Math.min(max,parseInt(v)||0));
  $('msl_'+id).value=v;$('mrn_'+id).value=v;$('msl_'+id).dataset.t=v;
  post('/api/motor/rpm',{motor:id,rpm:v});
}
function buildMotors(list){
  let h='';
  list.forEach(m=>{
    const id=m.id, x=m.max_rpm, q="'"+id+"'";
    h+='<div class="card" id="mc_'+id+'"><div class="name">'+m.label+'<span class="st" id="ms_'+id+'">OFF</span></div>'+
      '<div class="row"><button class="b b-on need" onclick="mSet('+q+',\'on\')">ON</button>'+
      '<button class="b b-off" onclick="mSet('+q+',\'off\')">OFF</button></div>'+
      '<div class="row"><input type="number" min="1" placeholder="sec" id="md_'+id+'">'+
      '<button class="b b-run need" onclick="mRun('+q+')">ON for duration</button></div>'+
      '<div class="spd">Target: <b id="mt_'+id+'">'+m.target_rpm+'</b> / '+x+' RPM '+
      '<span class="muted">&middot; now ~<span id="mn_'+id+'">0</span> RPM</span></div>'+
      '<div class="row"><input type="range" min="0" max="'+x+'" step="1" value="'+m.target_rpm+'" id="msl_'+id+'" data-t="'+m.target_rpm+'" '+
      'oninput="$(\'mrn_'+id+'\').value=this.value" onchange="mRpm('+q+',this.value,'+x+')"></div>'+
      '<div class="row"><input type="number" min="0" max="'+x+'" value="'+m.target_rpm+'" id="mrn_'+id+'">'+
      '<button class="b b-run" onclick="mRpm('+q+',$(\'mrn_'+id+'\').value,'+x+')">Set RPM</button></div>'+
      '<div class="muted" id="mi_'+id+'" style="margin-top:8px"></div>'+
      '<div class="rem" id="mr_'+id+'"></div><div class="merr" id="me_'+id+'"></div></div>';
  });
  $('mgrid').innerHTML=h;
}
function renderMotors(M){
  const key=M.list.map(m=>m.id+':'+m.max_rpm).join(',');  // rebuild if a max changes
  if(key!==mKey){buildMotors(M.list);mKey=key;}
  M.list.forEach(m=>{
    const id=m.id, st=m.state, s=$('ms_'+id);
    $('mc_'+id).className='card'+(st=='OFF'?'':' on');
    s.textContent=st; s.className='st'+((st=='STARTING'||st=='STOPPING')?' wait':'');
    $('mt_'+id).textContent=m.target_rpm; $('mn_'+id).textContent=m.current_rpm;
    const sl=$('msl_'+id), rn=$('mrn_'+id);
    if(document.activeElement!==sl&&document.activeElement!==rn&&sl.dataset.t!=String(m.target_rpm)){
      sl.value=m.target_rpm;rn.value=m.target_rpm;sl.dataset.t=m.target_rpm;}
    $('mi_'+id).textContent=m.volts+' V motor (max '+m.max_duty+'% of '+m.supply_volts+' V)  \u00b7  Ground relay: '+
      (m.relay_on===null?'unknown':(m.relay_on?'closed':'open'))+
      (m.duty>0?('  \u00b7  BTS7960 '+m.duty+'% \u2248 '+(m.duty*m.supply_volts/100).toFixed(1)+' V'):'');
    $('mr_'+id).textContent=m.remaining>0?((st=='STARTING'?'Will run for ':'Auto-off in ')+m.remaining+' s'):'';
    $('me_'+id).textContent=m.error||'';
  });
  document.querySelectorAll('#mgrid .need').forEach(b=>b.disabled=!espOnline);
}

/* ---------- Load cell ---------- */
let calZeroDone=false, unitFilled=false;
function setRes(id,text,err){const r=$(id);r.textContent=text;r.className='res'+(err?' err':'');}
function tare(){busy=true;toast('Taring... keep the scale empty');post('/api/loadcell/tare').then(s=>{busy=false;if(s&&s.ok)toast('Tared');});}
function calZero(){
  busy=true;setRes('r1','Reading for 3 seconds... keep the scale empty and still');
  post('/api/loadcell/tare').then(s=>{
    busy=false;if(!s)return;
    if(s.ok){calZeroDone=true;$('st1').classList.add('done');
      setRes('r1','Zeroed. offset = '+s.result.offset+' (noise '+s.result.noise_raw+' counts, '+s.result.samples+' readings). Now do Step 2.');}
    else setRes('r1',s.error,true);
  });
}
function calibrate(){
  const w=parseFloat($('calw').value);
  if(!(w>0)){setRes('r2','Enter the known weight first',true);return;}
  busy=true;setRes('r2','Reading for 3 seconds... keep the weight still');
  post('/api/loadcell/calibrate',{weight:w,unit:$('calu').value}).then(s=>{
    busy=false;if(!s)return;
    if(s.ok){const r=s.result;$('st2').classList.add('done');$('st3').classList.add('done');
      $('cfman').value=Number(r.factor.toFixed(4));
      setRes('r2','calibration_factor = '+r.factor.toFixed(4)+'  (from '+r.known+' '+r.unit+', '+r.samples+' readings, about \u00b1'+r.resolution+' '+r.unit+')');}
    else setRes('r2',s.error,true);
  });
}
function setFactor(){
  const f=parseFloat($('cfman').value);
  if(!f){toast('Enter a calibration factor (not 0)');return;}
  post('/api/loadcell/factor',{calibration_factor:f}).then(s=>{if(s&&s.ok)toast('Factor saved');});
}
function renderLc(l){
  const dec=Math.abs(l.weight||0)>=1000?0:(l.unit=='kg'||l.unit=='lb'?3:1);
  const w=(l.weight===null)?'--':l.weight.toFixed(dec);
  $('w').textContent=w;$('wtop').textContent=w;
  document.querySelectorAll('.unit').forEach(u=>u.textContent=l.unit);
  $('raw').textContent=l.raw===null?'--':Math.round(l.raw);
  $('lcstate').textContent=l.busy?'reading for calibration...':(!l.ok?'no signal from HX711':(l.calibrated?'calibrated':'not calibrated yet'));
  $('cf_now').textContent=l.calibration_factor;
  $('off_now').textContent=l.offset;
  if(!unitFilled){$('calu').value=l.unit;if(l.calibrated&&!$('cfman').value)$('cfman').value=l.calibration_factor;unitFilled=true;}
}

function sendCmd(){
  const c=$('cmd').value.trim(); if(!c)return;
  post('/api/esp/cmd',{cmd:c}); $('cmd').value='';
}
function modeUi(){const m=$('mode').value;$('portrow').style.display=m=='serial'?'flex':'none';$('urlrow').style.display=m=='http'?'flex':'none';}
function saveSettings(){
  post('/api/settings',{esp32_mode:$('mode').value,esp32_port:$('port').value.trim(),esp32_url:$('espurl').value.trim()})
    .then(()=>{toast('Saved - restarting...');setTimeout(()=>location.reload(),6000);});
}

function render(s){
  if(!s||!s.esp32)return;
  if(!urlFilled&&s.settings){$('mode').value=s.settings.esp32_mode;$('port').value=s.settings.esp32_port;$('espurl').value=s.settings.esp32_url;modeUi();urlFilled=true;}
  $('sim').style.display=s.sim?'block':'none';
  motorRelays=s.motors.relays||[]; espOnline=!!s.esp32.online;
  renderEsp(s.esp32);renderMotors(s.motors);renderLc(s.loadcell);
}
poll();setInterval(poll,1000);
</script>
</body></html>
'''


def open_browser(port):
    """Wait until Flask answers, then open the page on the Pi's own screen."""
    import shutil
    import subprocess
    import webbrowser

    url = "http://127.0.0.1:%d" % port
    if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        print("No desktop screen found - not opening a browser. Open %s yourself." % url)
        return
    for _ in range(60):                       # wait up to 30 s for the server
        try:
            requests.get(url + "/api/status", timeout=1)
            break
        except Exception:
            time.sleep(0.5)

    chromium = shutil.which("chromium-browser") or shutil.which("chromium")
    try:
        if chromium:
            args = [chromium, "--noerrdialogs", "--disable-infobars",
                    "--disable-session-crashed-bubble", "--password-store=basic"]
            args += ["--kiosk", url] if CONFIG.get("browser_kiosk") else ["--new-window", url]
            subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
        else:
            webbrowser.open(url)
        print("Browser opened at", url)
    except Exception as e:
        print("Could not open browser:", e)


def lan_ip():
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))            # no data is sent; just picks the LAN interface
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "<this-pi-ip>"


if __name__ == "__main__":
    port = int(os.environ.get("PORT", CONFIG.get("web_port", 5000)))
    print("Open http://127.0.0.1:%d on the Pi, or http://%s:%d from another device" % (port, lan_ip(), port))
    no_browser = "--no-browser" in sys.argv or os.environ.get("PI_CONTROL_NO_BROWSER") == "1"
    if CONFIG.get("open_browser", True) and not no_browser:
        threading.Thread(target=open_browser, args=(port,), daemon=True).start()
    try:
        app.run(host="0.0.0.0", port=port, threaded=True, use_reloader=False)
    finally:
        motors.emergency_stop()
