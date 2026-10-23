# Greenova backend for the Raspberry Pi wired to the machine: the ESP32 controller on USB serial
# (pyserial) and the Pi's own GPIO for the centrifuge and the output load cell (lgpio).
# Built by docker-compose.yaml (context: ../backend).
#
# Python 3.11 on purpose: lgpio has ready-made wheels for Python 3.9-3.12 (64-bit and 32-bit Pi OS),
# but not for 3.13, where pip would try to compile it and fail ("cannot find -llgpio").
FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    LG_WD=/tmp \
    GREENOVA_HARDWARE=/app/data/hardware.toml \
    GREENOVA_CALIBRATION=/app/data/loadcell_calibration.json

WORKDIR /app

# requirements.txt: FastAPI, uvicorn, PyMySQL. requirements-pi.txt: pyserial (the ESP32), smbus2.
# lgpio: the motor driver (BTS7960: mixer 1, mixer 2, centrifuge) and the HX711 load cell. The last line stops the build if one is missing.
COPY requirements.txt requirements-pi.txt ./
RUN pip install -r requirements.txt -r requirements-pi.txt "lgpio>=0.2.2,<0.3" \
 && python -c "import fastapi, pymysql, serial, lgpio; print('Greenova backend: FastAPI, PyMySQL, pyserial and lgpio installed')"

COPY . .
# /app/data: hardware.toml (optional, else the built-in pins) and loadcell_calibration.json,
# mounted from backend/data so the calibration survives a rebuild.
RUN mkdir -p /app/data

EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
