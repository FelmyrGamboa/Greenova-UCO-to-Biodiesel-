"""Small drivers for the Raspberry Pi sensors. Only PiHardware (hardware.py) and the hardware test
tool (hwtest.py) import this file, so the automated tests never need these libraries.

Which parts, and how they're wired: docs/RASPBERRY_PI_SETUP.md. Pins and calibration: hardware.toml.

- HX711Scale        load cell amplifier (reactor and output load cells), bit-banged with lgpio
- PowerMonitor      INA226 (up to 36 V) or INA219 (up to 26 V) on I2C: electrode voltage and current
- RpmCounter        hall or IR sensor, one pulse (or more) per turn: reactor stirrer, centrifuge, dry wash stirrer
- read_ds18b20      waterproof DS18B20 temperature probe on 1-Wire
- SerialSupply      power supply with a USB/serial port (SCPI, Korad, ...): sets voltage and current
- LoadCell          an HX711 read continuously (median filter), with Tare and Calibrate from the
                    website; the calibration is kept in loadcell_calibration.json (ESP32 mode)
- Centrifuge        DC motor on a BTS7960 driver (L_EN, R_EN, LPWM, RPWM) on the Pi's own pins,
                    open-loop RPM -> PWM with a soft start and stop (ESP32 mode)

Every reader returns None when it has no valid value. The safety rules treat a missing
temperature as a fault, and the dosing pumps dose by time when the reactor load cell has no reading.
"""
import glob
import json
import logging
import os
import statistics
import threading
import time
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Optional

log = logging.getLogger("greenova.drivers")


# ---------- GPIO chip (Pi 4: gpiochip0, Pi 5: the RP1 chip) ----------
def open_gpiochip(preferred: Optional[int] = None):
    """Opens the Raspberry Pi's GPIO header chip with lgpio and returns (lgpio, handle)."""
    import lgpio  # apt: python3-lgpio

    if preferred is None and os.getenv("GPIO_CHIP"):
        preferred = int(os.environ["GPIO_CHIP"])
    candidates = [preferred] if preferred is not None else list(range(0, 8))
    for number in candidates:
        try:
            handle = lgpio.gpiochip_open(number)
        except Exception as e:
            if preferred is not None:
                raise RuntimeError(f"Can't open /dev/gpiochip{number} ({e}). In Docker, pass the device: "
                                   f"devices: - /dev/gpiochip{number}:/dev/gpiochip{number}") from None
            continue
        try:
            info = lgpio.gpio_get_chip_info(handle)      # (status, lines, name, label)
            label = str(info[3] if len(info) > 3 else "")
            lines = int(info[1]) if len(info) > 1 else 0
        except Exception:
            label, lines = "", 0
        # the header's chip: "pinctrl-bcm2711" / "pinctrl-bcm2835" (Pi 4 and older) or "pinctrl-rp1" (Pi 5)
        header = ("pinctrl" in label and lines >= 28) or "rp1" in label or "bcm" in label
        if preferred is not None:
            if label and not header:
                lgpio.gpiochip_close(handle)
                raise RuntimeError(
                    f"gpiochip{number} is \"{label}\", not the Raspberry Pi's GPIO header, so the centrifuge "
                    "and the load cell would not work. Run  gpiodetect  on the Pi and use the chip called "
                    "pinctrl-rp1 (Pi 5) or pinctrl-bcm2711 / pinctrl-bcm2835 (Pi 4 and older) for gpiochip "
                    "in hardware.toml or GPIO_CHIP (and the matching /dev/gpiochipN in Docker).")
            return lgpio, handle
        if header:
            return lgpio, handle
        lgpio.gpiochip_close(handle)
    raise RuntimeError("Raspberry Pi GPIO chip not found. Set gpiochip = 0 (Pi 4) or 4 (Pi 5) in hardware.toml.")


def claim_pin(lgpio, chip, pin: int, purpose: str, output: bool = True, level: int = 0) -> None:
    """Claims one GPIO pin, with a clear message when another program already uses it."""
    try:
        if output:
            lgpio.gpio_claim_output(chip, pin, level)
        else:
            lgpio.gpio_claim_input(chip, pin)
    except Exception as e:
        if "busy" in str(e).lower():
            raise RuntimeError(
                f"GPIO {pin} ({purpose}) is busy: another program is using it. Stop the old Pi control "
                "panel (sudo systemctl disable --now pi-control; rm ~/.config/autostart/pi-control.desktop; "
                "pkill -f pi_control/app.py) and any other Greenova backend, then start again.") from None
        raise RuntimeError(f"GPIO {pin} ({purpose}): {e}") from None


# ---------- HX711 load cell amplifier ----------
class HX711Scale:
    """HX711 on two GPIO pins (DT = data_pin, SCK = clock_pin), channel A, gain 128.

    grams = (raw - offset) / scale. Find offset and scale with:
        python -m app.hwtest calibrate reactor      (or: output)
    Each reading takes the median of `samples` conversions (at 10 samples/s, 3 samples ≈ 0.3 s),
    which also throws away the odd bad conversion when Linux pauses the program mid-read."""

    TIMEOUT_S = 0.6

    def __init__(self, lgpio, chip, data_pin: int, clock_pin: int, offset: float = 0, scale: float = 1.0,
                 samples: int = 3):
        self.lg, self.chip = lgpio, chip
        self.dout, self.sck = data_pin, clock_pin
        self.offset, self.scale = float(offset), float(scale) or 1.0
        self.samples = max(1, int(samples))
        self._lock = threading.Lock()
        claim_pin(lgpio, chip, data_pin, "HX711 DT", output=False)
        claim_pin(lgpio, chip, clock_pin, "HX711 SCK")  # SCK low = powered up

    def read_raw(self) -> Optional[int]:
        """One 24-bit conversion, or None (not ready in time / not connected)."""
        lg, chip = self.lg, self.chip
        with self._lock:
            end = time.monotonic() + self.TIMEOUT_S
            while lg.gpio_read(chip, self.dout) == 1:       # DT goes low when a value is ready
                if time.monotonic() > end:
                    return None
                time.sleep(0.002)
            value = 0
            for _ in range(24):
                lg.gpio_write(chip, self.sck, 1)
                value = (value << 1) | lg.gpio_read(chip, self.dout)
                lg.gpio_write(chip, self.sck, 0)
            lg.gpio_write(chip, self.sck, 1)                # 25th pulse: channel A, gain 128 next time
            lg.gpio_write(chip, self.sck, 0)
        if value & 0x800000:
            value -= 0x1000000
        if value in (-0x800000, 0x7FFFFF):                  # saturated: check the wiring
            return None
        return value

    def read_average_raw(self, samples: Optional[int] = None) -> Optional[float]:
        values = [v for v in (self.read_raw() for _ in range(samples or self.samples)) if v is not None]
        return statistics.median(values) if values else None

    def read_grams(self) -> Optional[float]:
        raw = self.read_average_raw()
        return None if raw is None else round((raw - self.offset) / self.scale, 1)

    def close(self) -> None:
        for pin in (self.dout, self.sck):
            try:
                self.lg.gpio_free(self.chip, pin)
            except Exception:
                pass


# ---------- INA226 / INA219 power monitor (electrode voltage and current) ----------
class PowerMonitor:
    """Bus voltage and current from an INA226 (up to 36 V: fits the 0-30 V supply) or INA219
    (up to 26 V only). Current = shunt voltage ÷ shunt_ohms, so no calibration register is needed.
    Shunt for 2 A: INA226 reads up to 81.9 mV across the shunt -> use 0.02 Ω (max ≈ 4 A).
    Many INA226 boards come with 0.1 Ω (R100): that only reads up to 0.8 A, so replace it."""

    def __init__(self, kind: str, bus: int = 1, address: int = 0x40, shunt_ohms: float = 0.02):
        from smbus2 import SMBus  # pip: smbus2 (requirements-pi.txt)

        self.kind, self.address, self.shunt_ohms = kind.lower(), int(address), float(shunt_ohms)
        if self.kind not in ("ina226", "ina219"):
            raise ValueError(f"power_monitor type must be ina226, ina219 or none, not {kind!r}")
        self.bus = SMBus(int(bus))
        if self.kind == "ina226":
            # average 16 samples, 1.1 ms conversions, shunt and bus continuous
            self._write(0x00, 0x4000 | (0b010 << 9) | (0b100 << 6) | (0b100 << 3) | 0b111)
        else:
            self._write(0x00, 0x399F)   # INA219: 32 V range, ±320 mV shunt, 12-bit, continuous

    def _write(self, register: int, value: int) -> None:
        self.bus.write_i2c_block_data(self.address, register, [(value >> 8) & 0xFF, value & 0xFF])

    def _read(self, register: int) -> int:
        high, low = self.bus.read_i2c_block_data(self.address, register, 2)
        return (high << 8) | low

    def read(self) -> tuple[Optional[float], Optional[float]]:
        """(volts, amps), or (None, None) when the chip doesn't answer."""
        try:
            shunt = self._read(0x01)
            if shunt & 0x8000:
                shunt -= 0x10000
            bus = self._read(0x02)
        except OSError:
            return None, None
        if self.kind == "ina226":
            volts, shunt_volts = bus * 0.00125, shunt * 2.5e-6
        else:
            volts, shunt_volts = (bus >> 3) * 0.004, shunt * 1e-5
        # abs(): a shunt wired the other way round must still trip the over-current stop
        return round(volts, 2), round(abs(shunt_volts / self.shunt_ohms), 3)

    def read_or_none(self) -> Optional[tuple[float, float]]:
        """(volts, amps), or None when the chip doesn't answer (for the background sampler)."""
        volts, amps = self.read()
        return None if volts is None else (volts, amps)

    def close(self) -> None:
        try:
            self.bus.close()
        except Exception:
            pass


# ---------- RPM from pulses ----------
class RpmCounter:
    """Counts pulses from a hall sensor (magnet on the shaft) or an IR slot sensor. The sensor's
    output goes to the pin (open collector to GND is fine: the pull-up is on). RPM = pulses in the
    last `window` seconds ÷ pulses_per_rev × 60. A stopped motor reads 0."""

    def __init__(self, pin: int, pulses_per_rev: float = 1, window: float = 2.0):
        from gpiozero import DigitalInputDevice  # apt: python3-gpiozero

        self.pulses_per_rev = float(pulses_per_rev) or 1.0
        self.window = window
        self._times: deque = deque(maxlen=20000)
        self._device = DigitalInputDevice(pin, pull_up=True)
        self._device.when_activated = self._pulse

    def _pulse(self) -> None:
        self._times.append(time.monotonic())

    def rpm(self) -> float:
        cutoff = time.monotonic() - self.window
        while self._times and self._times[0] < cutoff:
            self._times.popleft()
        return round(len(self._times) / self.window / self.pulses_per_rev * 60)

    def close(self) -> None:
        self._device.close()


# ---------- DS18B20 temperature probe ----------
def read_ds18b20(sensor_id: str = "") -> Optional[float]:
    """Waterproof DS18B20 on 1-Wire (GPIO4; enable 1-Wire in raspi-config). sensor_id picks one
    probe ("28-0123456789ab") when several are connected; empty = the first one found."""
    pattern = f"/sys/bus/w1/devices/{sensor_id or '28-*'}/w1_slave"
    files = sorted(glob.glob(pattern))
    if not files:
        return None
    try:
        with open(files[0]) as f:
            lines = f.read().splitlines()
        if len(lines) < 2 or not lines[0].endswith("YES"):
            return None
        value = int(lines[1].split("t=")[1]) / 1000
    except (OSError, ValueError, IndexError):
        return None
    if value in (85.0, -127.0):          # the probe's power-on / error values
        return None
    return round(value, 1)


# ---------- power supply with a serial port ----------
class SerialSupply:
    """Sends the voltage and current to a power supply over USB/serial. The commands are
    templates from hardware.toml, e.g. SCPI "VOLT {volts:.2f}\\n" / "CURR {amps:.2f}\\n", or a Korad
    KA3005P "VSET1:{volts:.2f}" / "ISET1:{amps:.3f}". Check your supply's manual."""

    def __init__(self, port: str, baudrate: int, voltage_command: str, current_command: str,
                 output_on_command: str = "", output_off_command: str = ""):
        import serial  # pip: pyserial (requirements-pi.txt)

        self.port = serial.Serial(port, int(baudrate), timeout=1)
        self.voltage_command, self.current_command = voltage_command, current_command
        self.output_on_command, self.output_off_command = output_on_command, output_off_command
        self._lock = threading.Lock()

    def _send(self, text: str) -> None:
        if not text:
            return
        with self._lock:
            self.port.write(text.encode("ascii"))
            self.port.flush()
            time.sleep(0.05)               # many supplies need a short gap between commands

    def set_voltage(self, volts: float) -> None:
        self._send(self.voltage_command.format(volts=volts))

    def set_current(self, amps: float) -> None:
        self._send(self.current_command.format(amps=amps))

    def output(self, on: bool) -> None:
        self._send(self.output_on_command if on else self.output_off_command)

    def close(self) -> None:
        try:
            self.port.close()
        except Exception:
            pass


# ---------- load cell with Tare / Calibrate (ESP32 mode) ----------
class CalibrationStore:
    """Load cell calibrations made from the website (Tare, Calibrate), kept in a small JSON file
    next to hardware.toml so they survive a restart. A value here wins over hardware.toml."""

    def __init__(self, path: Path):
        path = Path(path)
        if path.is_dir():
            # Docker makes a folder when a mounted file doesn't exist yet: keep the file inside it
            log.warning("%s is a folder (Docker creates one when the file is missing): load cell "
                        "calibrations are kept in %s", path, path / path.name)
            path = path / path.name
        self.path = path
        self._lock = threading.Lock()

    def load(self) -> dict:
        try:
            with open(self.path, encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except FileNotFoundError:
            return {}
        except (OSError, ValueError) as e:
            log.warning("Load cell calibration file %s unreadable (%s); using hardware.toml", self.path, e)
            return {}

    def get(self, key: str) -> dict:
        value = self.load().get(key)
        return value if isinstance(value, dict) else {}

    def save(self, key: str, values: dict) -> None:
        with self._lock:
            data = self.load()
            data[key] = {**data.get(key, {}), **values}
            tmp = self.path.with_suffix(self.path.suffix + ".tmp")
            try:
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2)
                os.replace(tmp, self.path)
            except OSError:
                # A single file mounted into a Docker container can't be replaced ("Device or
                # resource busy") and its folder may be read-only: write the file itself instead.
                try:
                    tmp.unlink()
                except OSError:
                    pass
                with open(self.path, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2)


class LoadCell:
    """An HX711 read all the time in its own thread; the reading is the median of the last
    `samples` conversions (10 at 10 samples/s = the last second), so one bad conversion never shows.

        grams = (raw - offset) / scale        (scale = raw counts per gram; negative is fine)

    Calibration, from the website (Settings -> Hardware) or `python -m app.hwtest calibrate`:
      Tare       nothing on the scale (or the empty container) -> offset = average raw reading
      Calibrate  a known weight on it -> scale = (average raw - offset) / grams
    Each step averages `cal_seconds` of readings and drops the highest and lowest 20 %."""

    POLL_S = 0.02
    MAX_AGE_S = 2.0          # no good conversion for this long = no reading (None)

    def __init__(self, hx: "HX711Scale", key: str, offset: float = 0.0, scale: float = 1.0, samples: int = 10,
                 cal_seconds: float = 3.0, store: Optional[CalibrationStore] = None):
        self.hx, self.key, self.store = hx, key, store
        saved = store.get(key) if store else {}
        self.offset = float(saved.get("offset", offset))
        self.scale = float(saved.get("scale", scale)) or 1.0
        self.calibrated_at: Optional[str] = saved.get("calibratedAt")
        self.tared_at: Optional[str] = saved.get("taredAt")
        self.samples = max(1, int(samples))
        self.cal_seconds = float(cal_seconds)
        self._buf: deque = deque(maxlen=self.samples)
        self._collect: Optional[list] = None
        self._last_ok = 0.0
        self._lock = threading.Lock()
        self._cal_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name=f"greenova-loadcell-{key}", daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        last_error = None
        while not self._stop.is_set():
            try:
                value = self.hx.read_raw()
                last_error = None
            except Exception as e:          # never let one GPIO error stop the readings
                if str(e) != last_error:
                    log.warning("HX711 %s read error: %s", self.key, e)
                    last_error = str(e)
                value = None
                self._stop.wait(0.5)
            if value is not None:
                with self._lock:
                    self._buf.append(value)
                    if self._collect is not None:
                        self._collect.append(value)
                    self._last_ok = time.monotonic()
            self._stop.wait(self.POLL_S)

    @property
    def ok(self) -> bool:
        return time.monotonic() - self._last_ok < self.MAX_AGE_S

    def raw(self) -> Optional[float]:
        with self._lock:
            if not self._buf or not self.ok:
                return None
            return statistics.median(self._buf)

    def grams(self) -> Optional[float]:
        raw = self.raw()
        return None if raw is None else round((raw - self.offset) / self.scale, 1)

    def _average(self) -> tuple[Optional[float], float, int]:
        with self._lock:
            self._collect = []
        self._stop.wait(self.cal_seconds)
        with self._lock:
            values, self._collect = self._collect or [], None
        if len(values) < 5:
            return None, 0.0, len(values)
        values.sort()
        cut = len(values) // 5
        core = values[cut:len(values) - cut] or values
        return sum(core) / len(core), statistics.pstdev(core), len(values)

    def tare(self) -> dict:
        """Zero: nothing on the scale (or only the empty container). Takes cal_seconds."""
        with self._cal_lock:
            average, noise, n = self._average()
            if average is None:
                raise ValueError(f"Not enough readings from the HX711 ({n}). Check its wiring (VCC 3.3 V, GND, DT, SCK).")
            self.offset = round(average, 2)
            self.tared_at = datetime.now().isoformat(timespec="seconds")
            if self.store:
                self.store.save(self.key, {"offset": self.offset, "taredAt": self.tared_at})
            return {"offset": self.offset, "noiseRaw": round(noise, 1), "samples": n}

    def calibrate(self, grams: float) -> dict:
        """A known weight (in grams) is on the scale: works out the scale factor. Tare first."""
        if grams is None or grams <= 0:
            raise ValueError("Enter the known weight in grams (more than 0).")
        with self._cal_lock:
            average, noise, n = self._average()
            if average is None:
                raise ValueError(f"Not enough readings from the HX711 ({n}). Check its wiring.")
            diff = average - self.offset
            if abs(diff) < max(50.0, 10 * noise):
                raise ValueError(f"The reading barely changed ({diff:.0f} counts). Tare with the scale empty, "
                                 "then put the weight on and try again.")
            self.scale = round(diff / grams, 6)
            self.calibrated_at = datetime.now().isoformat(timespec="seconds")
            if self.store:
                self.store.save(self.key, {"offset": self.offset, "scale": self.scale, "calibratedAt": self.calibrated_at})
            return {"scale": self.scale, "offset": self.offset, "samples": n,
                    "resolutionG": round(abs(noise / self.scale), 2)}

    def status(self) -> dict:
        return {"grams": self.grams(), "raw": self.raw(), "ok": self.ok, "offset": round(self.offset, 2),
                "scale": self.scale, "busy": self._cal_lock.locked(), "calibratedAt": self.calibrated_at,
                "taredAt": self.tared_at}

    def close(self) -> None:
        self._stop.set()
        self._thread.join(timeout=1.5)
        self.hx.close()


# ---------- centrifuge on a BTS7960 driver, from the Pi's own pins (ESP32 mode) ----------
class Centrifuge:
    """DC motor on a BTS7960 (IBT-2) board: L_EN and R_EN enable it, PWM on RPWM turns it forward
    (LPWM for "reverse"). Open loop: duty % = min_duty + fraction × (100 - min_duty), where
    fraction = target RPM ÷ max_rpm. The duty ramps over ramp_seconds (0 -> 100 %), so it starts
    and stops softly. rpm() is the estimate from the duty (there is no speed sensor)."""

    TICK = 0.05              # 20 Hz control loop

    def __init__(self, lgpio, chip, cfg: dict):
        self.lg, self.chip = lgpio, chip
        self.l_en, self.r_en = int(cfg["l_en"]), int(cfg["r_en"])
        self.lpwm, self.rpwm = int(cfg["lpwm"]), int(cfg["rpwm"])
        self.max_rpm = float(cfg.get("max_rpm", 2500))
        self.min_duty = float(cfg.get("min_duty", 0))
        self.freq = max(1, int(cfg.get("pwm_freq", 1000)))   # lgpio rejects 0 Hz
        self.ramp_s = max(0.1, float(cfg.get("ramp_seconds", 3.0)))
        self.reverse = str(cfg.get("direction", "forward")).lower() == "reverse"
        for pin, purpose in ((self.l_en, "centrifuge L_EN"), (self.r_en, "centrifuge R_EN"),
                             (self.lpwm, "centrifuge LPWM"), (self.rpwm, "centrifuge RPWM")):
            claim_pin(lgpio, chip, pin, purpose)
        self._pwm_active: set = set()
        self._target = 0.0       # duty % asked for
        self._duty = 0.0         # duty % applied now (ramps towards the target)
        self._applied = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self.error: Optional[str] = None
        self._thread = threading.Thread(target=self._loop, name="greenova-centrifuge", daemon=True)
        self._thread.start()

    def fraction_to_duty(self, fraction: float) -> float:
        fraction = min(max(fraction, 0.0), 1.0)
        return 0.0 if fraction <= 0 else self.min_duty + fraction * (100.0 - self.min_duty)

    def duty_to_rpm(self, duty: float) -> float:
        if duty <= self.min_duty or duty <= 0:
            return 0
        return round((duty - self.min_duty) * self.max_rpm / (100.0 - self.min_duty))

    def set_fraction(self, fraction: float) -> None:
        with self._lock:
            self._target = self.fraction_to_duty(fraction)

    def rpm(self) -> float:
        with self._lock:
            return self.duty_to_rpm(self._duty)

    def status(self) -> dict:
        with self._lock:
            return {"targetRpm": self.duty_to_rpm(self._target), "rpm": self.duty_to_rpm(self._duty),
                    "duty": round(self._duty, 1), "maxRpm": self.max_rpm, "error": self.error}

    def _pwm(self, pin: int, duty: float) -> None:
        if duty <= 0:
            if pin in self._pwm_active:
                try:
                    self.lg.tx_pwm(self.chip, pin, self.freq, 0)   # duty 0 stops the PWM
                except Exception:
                    pass
                self._pwm_active.discard(pin)
            self.lg.gpio_write(self.chip, pin, 0)                  # and holds the pin LOW
        else:
            self.lg.tx_pwm(self.chip, pin, self.freq, min(100.0, float(duty)))
            self._pwm_active.add(pin)

    def _apply(self) -> None:
        enable = 1 if (self._target > 0 or self._duty > 0) else 0
        self.lg.gpio_write(self.chip, self.l_en, enable)
        self.lg.gpio_write(self.chip, self.r_en, enable)
        forward, backward = (self.lpwm, self.rpwm) if self.reverse else (self.rpwm, self.lpwm)
        self._pwm(backward, 0)
        self._pwm(forward, self._duty)

    def _tick(self) -> None:
        with self._lock:
            step = 100.0 * self.TICK / self.ramp_s
            if self._duty < self._target:
                self._duty = min(self._target, self._duty + step)
            elif self._duty > self._target:
                self._duty = max(self._target, self._duty - step)
            state = (round(self._duty, 2), self._target > 0)
            if state != self._applied:
                self._apply()
                self._applied = state

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self._tick()
                self.error = None
            except Exception as e:         # never let one GPIO error kill the control loop
                if str(e) != self.error:
                    log.warning("Centrifuge GPIO error: %s", e)
                self.error = str(e)
                self._applied = None       # try again on the next tick
            self._stop.wait(self.TICK)

    def stop_now(self) -> None:
        """Power off at once (no ramp): shutdown and faults."""
        with self._lock:
            self._target = self._duty = 0.0
            try:
                self._apply()
                self._applied = (0.0, False)
            except Exception as e:
                log.warning("Centrifuge stop error: %s", e)

    def close(self) -> None:
        self._stop.set()
        self._thread.join(timeout=1)
        self.stop_now()
        for pin in (self.l_en, self.r_en, self.lpwm, self.rpwm):
            try:
                self.lg.gpio_free(self.chip, pin)
            except Exception:
                pass
