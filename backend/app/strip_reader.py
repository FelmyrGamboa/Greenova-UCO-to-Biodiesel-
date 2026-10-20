#!/usr/bin/env python3
"""Greenova FFA strip reader: TCS34725 color sensor + its onboard white LED, on a Raspberry Pi 4.

Setup (once):
  sudo raspi-config          -> Interface Options -> I2C -> Enable, then reboot
  i2cdetect -y 1             -> the sensor should show up at address 29
  pip3 install adafruit-circuitpython-tcs34725 gpiozero --break-system-packages

Usage:
  python3 strip_reader.py white       # save the white reference (white card in the slot)
  python3 strip_reader.py cal 4.0     # add a calibration point: strip dipped in a known 4.0% FFA sample
  python3 strip_reader.py read        # measure an unknown oil; prints the FFA %

From other code (for example the dashboard):
  from strip_reader import measure_ffa
  ffa, warnings = measure_ffa()       # read the strip now (call it once the wait time has passed)
"""
import csv
import math
import os
import sys
import time

LED_PIN = 17            # GPIO17 = physical pin 11, wired to the sensor board's LED pin
WAIT_S = 120            # seconds from dipping to reading; set this from your strip's instructions
SAMPLES = 10            # readings averaged per measurement
INTEGRATION_MS = 154    # sensor exposure time per reading
GAIN = 4                # 1, 4, 16 or 60; lower it if you get a "too bright" warning
MAX_DISTANCE = 0.03     # color-mismatch warning threshold; tune it during calibration
SATURATED = 60000       # raw counts near the sensor's maximum (65535)

HERE = os.path.dirname(os.path.abspath(__file__))
WHITE_FILE = os.path.join(HERE, "white_ref.csv")
CAL_FILE = os.path.join(HERE, "ffa_calibration.csv")

_sensor = None
_led = None


# ---------- hardware ----------
def init_hardware():
    global _sensor, _led
    if _sensor is None:
        import board
        import adafruit_tcs34725
        from gpiozero import DigitalOutputDevice
        _sensor = adafruit_tcs34725.TCS34725(board.I2C())
        _sensor.integration_time = INTEGRATION_MS
        _sensor.gain = GAIN
        _led = DigitalOutputDevice(LED_PIN)


def _average_raw():
    total = [0.0, 0.0, 0.0]
    for _ in range(SAMPLES):
        time.sleep(INTEGRATION_MS / 1000 + 0.02)   # wait for a fresh reading
        r, g, b, _clear = _sensor.color_raw
        total[0] += r
        total[1] += g
        total[2] += b
    return [t / SAMPLES for t in total]


def read_rgb():
    """LED-on reading minus LED-off reading, so stray outside light cancels out."""
    init_hardware()
    _led.off()
    time.sleep(0.3)
    dark = _average_raw()
    _led.on()
    time.sleep(0.3)
    lit = _average_raw()
    _led.off()
    if max(lit) > SATURATED:
        print("Warning: too bright, the sensor is saturating. Lower GAIN.", file=sys.stderr)
    return [max(l - d, 0.0) for l, d in zip(lit, dark)]


# ---------- color math ----------
def chromaticity(rgb, white):
    """Divide by the white reference, then keep only the color proportions.
    This makes small brightness changes (oil gloss, LED aging) matter less."""
    refl = [v / w if w > 0 else 0.0 for v, w in zip(rgb, white)]
    total = sum(refl)
    if total <= 0:
        raise RuntimeError("No light detected. Check the LED and the wiring.")
    return [v / total for v in refl]


def load_white():
    if not os.path.exists(WHITE_FILE):
        raise RuntimeError("No white reference yet. Run: python3 strip_reader.py white")
    with open(WHITE_FILE) as f:
        return [float(x) for x in next(csv.reader(f))]


def load_calibration():
    """Average all rows for each FFA level, sorted from low to high FFA."""
    if not os.path.exists(CAL_FILE):
        raise RuntimeError("No calibration yet. Run: python3 strip_reader.py cal <FFA %>")
    groups = {}
    with open(CAL_FILE) as f:
        for row in csv.reader(f):
            if not row:
                continue
            ffa, *color = map(float, row)
            groups.setdefault(ffa, []).append(color)
    points = []
    for ffa in sorted(groups):
        rows = groups[ffa]
        points.append((ffa, [sum(c[i] for c in rows) / len(rows) for i in range(3)]))
    if len(points) < 2:
        raise RuntimeError("Need at least 2 different FFA levels in the calibration.")
    return points


def ffa_from_color(color, points):
    """Find the closest spot on the path through the calibration colors (in FFA order)
    and read the FFA % there by straight-line interpolation.
    Returns (ffa, distance from the path, at_edge)."""
    best_ffa, best_dist = None, None
    for (f0, c0), (f1, c1) in zip(points, points[1:]):
        seg = [b - a for a, b in zip(c0, c1)]
        seg_len2 = sum(s * s for s in seg)
        t = 0.0 if seg_len2 == 0 else sum((x - a) * s for x, a, s in zip(color, c0, seg)) / seg_len2
        t = min(max(t, 0.0), 1.0)
        nearest = [a + t * s for a, s in zip(c0, seg)]
        dist = math.dist(color, nearest)
        if best_dist is None or dist < best_dist:
            best_ffa, best_dist = f0 + t * (f1 - f0), dist
    at_edge = best_ffa <= points[0][0] or best_ffa >= points[-1][0]
    return best_ffa, best_dist, at_edge


def measure_ffa():
    """Read the strip in the slot now. Returns (FFA %, list of warnings)."""
    white = load_white()
    points = load_calibration()
    color = chromaticity(read_rgb(), white)
    ffa, dist, at_edge = ffa_from_color(color, points)
    warnings = []
    if dist > MAX_DISTANCE:
        warnings.append("Color doesn't match the calibration. Check the strip position, or re-dip.")
    if at_edge:
        warnings.append(f"At or beyond the calibrated range "
                        f"({points[0][0]:g}-{points[-1][0]:g}% FFA).")
    return ffa, warnings


# ---------- command line ----------
def countdown():
    input("Dip the strip, then press Enter right away...")
    print(f"Put the strip in the reader. Reading in {WAIT_S} s.")
    for left in range(WAIT_S, 0, -10):
        print(f"  {left} s")
        time.sleep(min(10, left))


def main(argv):
    if len(argv) < 2 or argv[1] not in ("white", "cal", "read"):
        print(__doc__)
        return 1
    mode = argv[1]
    if mode == "white":
        input("Put the white reference card in the slot, then press Enter...")
        rgb = read_rgb()
        with open(WHITE_FILE, "w", newline="") as f:
            csv.writer(f).writerow([f"{v:.1f}" for v in rgb])
        print("White reference saved:", [round(v) for v in rgb])
    elif mode == "cal":
        if len(argv) < 3:
            print("Give the known FFA %, for example: python3 strip_reader.py cal 4.0")
            return 1
        ffa = float(argv[2])
        white = load_white()
        countdown()
        color = chromaticity(read_rgb(), white)
        with open(CAL_FILE, "a", newline="") as f:
            csv.writer(f).writerow([ffa] + [f"{v:.5f}" for v in color])
        print(f"Saved calibration point: {ffa:g}% FFA -> color {[round(v, 4) for v in color]}")
    else:
        load_white()
        load_calibration()
        countdown()
        ffa, warnings = measure_ffa()
        print(f"FFA: {ffa:.1f}%")
        print("Esterification needed (FFA > 3%)." if ffa > 3 else "Esterification not needed.")
        for w in warnings:
            print("Warning:", w)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
