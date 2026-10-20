"""Small drivers for the Raspberry Pi sensors. Only PiHardware (hardware.py) and the hardware test
tool (hwtest.py) import this file, so a laptop in demo mode never needs these libraries.

Which parts, and how they're wired: docs/RASPBERRY_PI_SETUP.md. Pins and calibration: hardware.toml.

- HX711Scale        load cell amplifier (reactor and output load cells), bit-banged with lgpio
- PowerMonitor      INA226 (up to 36 V) or INA219 (up to 26 V) on I2C: electrode voltage and current
- RpmCounter        hall or IR sensor, one pulse (or more) per turn: reactor stirrer, centrifuge, dry wash stirrer
- read_ds18b20      waterproof DS18B20 temperature probe on 1-Wire
- SerialSupply      power supply with a USB/serial port (SCPI, Korad, ...): sets voltage and current

Every reader returns None when it has no valid value. The safety rules treat a missing
temperature as a fault, and the dosing pumps dose by time when the reactor load cell has no reading.
"""
import glob
import statistics
import threading
import time
from collections import deque
from typing import Optional


# ---------- GPIO chip (Pi 4: gpiochip0, Pi 5: the RP1 chip) ----------
def open_gpiochip(preferred: Optional[int] = None):
    """Opens the Raspberry Pi's GPIO header chip with lgpio and returns (lgpio, handle)."""
    import lgpio  # apt: python3-lgpio

    candidates = [preferred] if preferred is not None else list(range(0, 6))
    for number in candidates:
        try:
            handle = lgpio.gpiochip_open(number)
        except Exception:
            continue
        if preferred is not None:
            return lgpio, handle
        try:
            info = lgpio.gpio_get_chip_info(handle)      # (status, lines, name, label)
            label = str(info[3] if len(info) > 3 else "")
            lines = int(info[1]) if len(info) > 1 else 0
        except Exception:
            label, lines = "", 0
        # the header's chip: "pinctrl-bcm2711" / "pinctrl-bcm2835" (Pi 4 and older) or "pinctrl-rp1" (Pi 5)
        if "pinctrl" in label and lines >= 28:
            return lgpio, handle
        lgpio.gpiochip_close(handle)
    raise RuntimeError("Raspberry Pi GPIO chip not found. Set gpiochip = 0 (Pi 4) or 4 (Pi 5) in hardware.toml.")


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
        lgpio.gpio_claim_input(chip, data_pin)
        lgpio.gpio_claim_output(chip, clock_pin, 0)     # SCK low = powered up

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
