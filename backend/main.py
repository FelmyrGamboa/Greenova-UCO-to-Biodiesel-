"""Greenova backend. Start it with:  uvicorn app.main:app --host 0.0.0.0 --port 8000"""
import os
import sys

# Support running with: python3 app/main.py
if __name__ == "__main__" and not __package__:
    sys.path.insert(
        0,
        os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    )
    __package__ = "app"

import asyncio
import uvicorn
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from app import config, db
from app.api import auto_start_purification, router
from app.hardware import create_hardware
from app.purification import PurificationRunner
from app.stages import StageRunner

log = logging.getLogger("greenova")


async def sensor_loop(app: FastAPI) -> None:
    """Reads the sensors every second and runs the heater and electrode watchdog."""
    interval = 1.0 / config.TIME_SCALE
    while True:
        try:
            await asyncio.to_thread(app.state.hw.refresh)
            s = app.state.settings
            alarm = app.state.hw.watchdog(s.purification_maximum_temperature, s.reaction_maximum_temperature)
            if alarm:
                app.state.alarm = alarm
                log.warning(alarm)
            auto_start_purification(app)
        except Exception:
            log.exception("Sensor loop error")
            try:
                app.state.hw.set_heater(False)
                app.state.hw.set_electrode_power(False)
            except Exception:
                log.exception("Could not switch the outputs off")
        await asyncio.sleep(interval)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    app.state.settings = db.get_settings()
    app.state.hw = create_hardware()
    app.state.hw.all_off()                       # always start in the safe state
    app.state.purification = PurificationRunner(app.state.hw, config.TIME_SCALE)
    app.state.stage = StageRunner(app.state.hw, config.TIME_SCALE)
    app.state.records = {}                       # measurements for batches not saved yet
    app.state.alarm = None
    app.state.purification_armed = None          # batch waiting to start purification by itself
    task = asyncio.create_task(sensor_loop(app))
    log.info("Greenova backend started (%s mode)", "demo" if config.MOCK else "hardware")
    yield
    await app.state.purification.abort("backend shutting down")
    await app.state.stage.emergency_stop("backend shutting down")
    task.cancel()
    app.state.hw.all_off()
    app.state.hw.close()


app = FastAPI(title="Greenova API", version="0.2.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=config.CORS_ORIGINS,
                   allow_methods=["*"], allow_headers=["*"])
app.include_router(router)


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
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=False,
    )