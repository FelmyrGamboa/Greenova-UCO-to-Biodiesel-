"""Greenova backend, on the Raspberry Pi wired to the machine (ESP32 on USB, centrifuge, load cell).
Normally the greenova service runs it (setup-pi.sh). By hand, from the backend folder:
    python main.py                                (simplest: uses .venv by itself, restarts on edits)
    python -m uvicorn app.main:app --reload       (development, restarts when you edit the code)
    python -m app.main                            (or: python app/main.py)
"""
if __name__ == "__main__" and not __package__:
    # Started as "python app/main.py": make the "from . import ..." lines below work.
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    __package__ = "app"

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from . import config, db
from .api import auto_start_purification, emergency_stop_all, machine_active, router, stop_transfers
from .hardware import create_hardware
from .purification import MAXIMUM_TEMPERATURE_C, PurificationRunner
from .stages import StageRunner
from .transfers import PumpRunner

log = logging.getLogger("greenova")
if not log.handlers and not logging.getLogger().handlers:
    # uvicorn only sets up its own loggers: without this, Greenova's info lines (the hardware check,
    # "backend started") never reach journalctl / docker compose logs
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    log.addHandler(_handler)
    log.setLevel(logging.INFO)


async def sensor_loop(app: FastAPI) -> None:
    """Reads the sensors every second and runs the heater and electrode watchdog."""
    interval = 1.0 / getattr(app.state.hw, "time_scale", 1.0)   # 1 s (the tests' simulated machine runs faster)
    while True:
        try:
            await asyncio.to_thread(app.state.hw.refresh)
            s = app.state.settings
            alarm = app.state.hw.watchdog(MAXIMUM_TEMPERATURE_C, s.reaction_maximum_temperature)
            if alarm:
                app.state.alarm = alarm
                log.warning(alarm)
            # ESP32 controller lost (cable, power, reset) or an output that didn't follow its command:
            # stop every process and switch everything off. The ESP32's own 5 s timers already stop
            # its outputs when the Pi can't reach it.
            fault = app.state.hw.link_fault
            if fault and machine_active(app):
                log.error("%s: stopping every process", fault)
                await emergency_stop_all(app, fault)
                app.state.alarm = f"{fault}. Every process was stopped and every output switched off."
            auto_start_purification(app)
        except Exception:
            log.exception("Sensor loop error")
            try:
                app.state.hw.set_heater(False)
                app.state.hw.set_electrode_power(False)
            except Exception:
                log.exception("Could not switch the outputs off")
        await asyncio.sleep(interval)


def hardware_report(hw) -> list[tuple[bool, str]]:
    """(ok, line) for each part the process needs: the ESP32, the temperature, the output load
    cell and the centrifuge. Written to the log a few seconds after the start (docker compose logs
    backend / journalctl -u greenova), so a part that doesn't work is named before a batch."""
    r = hw.read()
    lines = []
    if "controllerOnline" in r:
        ok = bool(r.get("controllerOnline")) and not r.get("controllerError")
        lines.append((ok, f"ESP32 controller: online on {r.get('controllerPort')}" if ok else
                      f"ESP32 controller NOT WORKING: {r.get('controllerError') or 'offline'} (mixers, pumps, "
                      "electrode relay and heater can't switch on)"))
        min_pwm = getattr(hw, "sketch_min_pwm", None)
        if ok and callable(min_pwm):
            floor = min_pwm()
            lines.append((bool(floor), f"ESP32 sketch: MIN_PWM {floor}, mixers run at exactly the set RPM" if floor else
                          "ESP32 sketch: no minPwm in its status. Upload firmware/esp32_process_control/"
                          "esp32_process_control.ino (MIN_PWM 90), or slow mixer speeds (200 RPM) may not turn"))
    t = r.get("temperature")
    lines.append((t is not None, f"Temperature: {t} °C" if t is not None
                  else "Temperature: NO READING (DS18B20 on the ESP32's GPIO4); purification can't start"))
    w = r.get("outputWeightG")
    lines.append((w is not None, f"Output load cell: {w} g" if w is not None
                  else "Output load cell: NO READING (HX711 DT 17 / SCK 27); purification can't start"))
    describe = getattr(hw, "describe", None)
    info = describe() if callable(describe) else {}
    if isinstance(info, dict) and info.get("backend") == "esp32":
        c = info["centrifuge"]
        if c is None:
            lines.append((False, "Centrifuge: not enabled in hardware.toml ([centrifuge] enabled)"))
        else:
            lines.append((not c.get("error"), f"Centrifuge: NOT WORKING: {c['error']}" if c.get("error")
                          else f"Centrifuge: ready (BTS7960, up to {c.get('maxRpm'):g} RPM)"))
    return lines


async def report_hardware(app: FastAPI, delay: float = 8.0) -> None:
    await asyncio.sleep(delay)      # the ESP32 needs a few seconds after the port opens (it restarts)
    try:
        lines = await asyncio.to_thread(hardware_report, app.state.hw)
    except Exception:
        log.exception("Hardware check failed")
        return
    for ok, line in lines:
        (log.info if ok else log.warning)("Hardware check: %s", line)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # MySQL first: without the database there are no settings, so the backend doesn't start.
    try:
        db.init_db()
        app.state.settings = db.get_settings()
    except db.DatabaseError as e:
        log.error("Greenova backend can't use the MySQL database: %s  (Fix it in backend/.env or "
                  "app/config.py, then check with: python -m app.db   See database.md.)", e)
        raise
    app.state.hw = create_hardware()
    app.state.hw.all_off()                       # always start in the safe state
    scale = getattr(app.state.hw, "time_scale", 1.0)   # 1 on the machine (only the tests' simulator runs faster)
    app.state.purification = PurificationRunner(app.state.hw, scale)
    app.state.stage = StageRunner(app.state.hw, scale)      # the reaction stages and separation
    app.state.pump = PumpRunner(app.state.hw, scale)        # oil pump, pumps A and B (stopped by the operator)
    app.state.records = {}                       # measurements for batches not saved yet
    app.state.alarm = None
    app.state.purification_armed = None          # batch waiting to start purification by itself
    app.state.purification_wait = None           # why it hasn't started yet (shown on the website)
    task = asyncio.create_task(sensor_loop(app))
    report = asyncio.create_task(report_hardware(app, 8.0 / scale))
    log.info("Greenova backend started (%s outputs)", config.actuator_backend(config.HARDWARE))
    yield
    report.cancel()
    await stop_transfers(app, "backend shutting down")
    await app.state.purification.abort("backend shutting down")
    await app.state.stage.emergency_stop("backend shutting down")
    task.cancel()
    app.state.hw.all_off()
    app.state.hw.close()
    db.close()                                   # close the MySQL connections


app = FastAPI(title="Greenova API", version="0.2.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=config.CORS_ORIGINS,
                   allow_methods=["*"], allow_headers=["*"])
app.include_router(router)


def _field_path(loc) -> str:
    """("body", "purification", "heatingTimeSeconds") -> "purification → heatingTimeSeconds"."""
    parts = [str(part) for part in loc if part not in ("body", "query", "path")]
    return " → ".join(parts) or "request"


@app.exception_handler(RequestValidationError)
async def invalid_request(request: Request, error: RequestValidationError):
    """A request that doesn't pass validation (422): one readable sentence that names each field,
    e.g. "ffa: Use a whole number (no decimals)." instead of a bare "Field required"."""
    problems = [f"{_field_path(e.get('loc', ()))}: {str(e.get('msg', 'invalid')).removeprefix('Value error, ')}"
                for e in error.errors()]
    log.warning("Invalid request on %s %s: %s", request.method, request.url.path, "; ".join(problems))
    return JSONResponse(status_code=422, content={"detail": "; ".join(problems), "errors": jsonable(error.errors())})


def jsonable(errors) -> list:
    """Validation errors with only JSON-safe values (the input can hold anything)."""
    return [{"loc": list(e.get("loc", ())), "msg": str(e.get("msg", "")), "type": str(e.get("type", ""))} for e in errors]


@app.exception_handler(Exception)
async def unexpected_error(request: Request, error: Exception):
    """Answer unexpected errors in JSON, so the website shows them instead of treating the backend as offline."""
    log.exception("Unexpected error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": f"Backend error: {error}"})

# Serve the built website from the same address, so the Pi works without internet.
if config.FRONTEND_DIR.is_dir():
    frontend = config.FRONTEND_DIR.resolve()

    @app.get("/{full_path:path}", include_in_schema=False)
    async def website(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(404, "Not found")
        file = (frontend / full_path).resolve()
        if full_path and file.is_file() and frontend in file.parents:
            return FileResponse(file)
        return FileResponse(frontend / "index.html")   # let the website handle its own pages


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=False)
