"""All website endpoints, under /api. Open http://<pi-address>:8000/docs to try them.
JSON uses the website's camelCase names (see API.md)."""
import asyncio
import random
from datetime import date, datetime
from typing import Any, Optional

from fastapi import APIRouter, Body, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from . import analytics, calculations, config, db, system
from .hardware import PUMP_LABELS, VALVE_LABELS, InterlockError
from .models import (AfterEsterificationRequest, Batch, BatchIn, CalculateRequest, DemoAddIn, DemoOilIn,
                     DrainStart, EsterificationStage, LabResultIn, MotorIn, PumpIn, PumpStart,
                     PurificationRecord, PurificationStart, Settings, StageStart, SwitchIn, TimelineEvent,
                     ValveIn)
from .stages import REACTIONS, StageError
from .transfers import TransferError

router = APIRouter(prefix="/api")


# ---------- helpers ----------
def _settings(request: Request) -> Settings:
    return request.app.state.settings


def _batch_or_404(batch_id: str) -> Batch:
    b = db.get_batch(batch_id)
    if b is None:
        raise HTTPException(404, f"Batch {batch_id} not found.")
    return b


def _validation_message(e: ValidationError) -> str:
    return "; ".join(err["msg"].removeprefix("Value error, ") for err in e.errors())


def _live(app) -> dict:
    return {"mock": config.MOCK, "timestamp": datetime.now().isoformat(timespec="seconds"),
            "sensors": app.state.hw.read(), "alarm": app.state.alarm,
            "stage": app.state.stage.state, "purification": app.state.purification.state,
            "pump": app.state.pump.state, "drain": app.state.drain.state,
            # batch ID waiting to start purification by itself (after separation), or None
            "purificationAutoStart": getattr(app.state, "purification_armed", None)}


def _event(app, batch_id: Optional[str], label: str) -> None:
    """Adds a line to the batch's timeline (saved batch, or measurements waiting for the save)."""
    if not batch_id:
        return
    event = {"label": label, "time": datetime.now().isoformat()}
    saved = db.get_batch(batch_id)
    if saved is not None:
        saved.timeline.append(TimelineEvent.model_validate(event))
        db.save_batch(saved)
    else:
        _pending(app, batch_id)["timeline"].append(event)


async def stop_transfers(app, reason: str) -> None:
    """Stops a dosing pump and closes a draining valve (emergency stop, shutdown)."""
    await app.state.pump.stop(reason)
    await app.state.drain.stop(reason)


def _pending(app, batch_id: str) -> dict:
    """Measurements collected for a batch before the website saves it."""
    return app.state.records.setdefault(batch_id, {"timeline": [], "temperature": {}, "energyKwh": {},
                                                   "purification": None})


def _apply_pending(app, b: Batch, s: Settings) -> Batch:
    """Fill in what the Pi measured itself. Measured values replace the website's placeholders
    (temperature 27, yield 0, energy 0)."""
    rec = app.state.records.pop(b.id, None)
    if rec is None:
        return b
    b.timeline = sorted(b.timeline + [TimelineEvent.model_validate(e) for e in rec["timeline"]],
                        key=lambda e: e.time)
    temps = rec["temperature"]
    measured_temp = temps.get("Transesterification", temps.get("Esterification"))
    if measured_temp is not None:
        b.temperature = measured_temp
    if rec["purification"]:
        b.purification = PurificationRecord.model_validate(rec["purification"])
    heater_kwh = (rec["purification"] or {}).get("heaterOnSeconds", 0) * s.heater_power_watts / 3_600_000
    measured_kwh = sum(rec["energyKwh"].values()) + heater_kwh
    if measured_kwh > 0 and not b.energy:
        b.energy = round(measured_kwh, 3)
    return b


def _fill_batch(b: Batch, s: Settings) -> Batch:
    if b.oil_mass_g is None:
        b.oil_mass_g = round(b.oil_volume * s.oil_density, 1)
    output_g = b.purification.output_weight_g if b.purification else None
    if not b.biodiesel_output_ml and output_g:
        b.biodiesel_output_ml = round(output_g / s.biodiesel_density, 1)
    if b.biodiesel_output_ml and b.oil_volume:
        b.yield_ = round(b.biodiesel_output_ml / b.oil_volume * 100, 1)
    catalyst = b.catalyst_type or "NaOH"
    ratio = b.methanol_ratio or s.methanol_ratio.default
    if b.catalyst_to_weigh_g is None:
        last_ffa = next((st.ffa_after for st in reversed(b.esterification_stages) if st.ffa_after is not None), None)
        acid = last_ffa if last_ffa is not None else (s.ffa_target if b.esterification_run else b.ffa)
        b.catalyst_to_weigh_g = calculations.transesterification(b.oil_mass_g, acid, ratio, catalyst, s)["catalystToWeighG"]
    if b.materials is None:
        b.materials = calculations.materials(b.oil_volume, b.ffa, b.esterification_run, ratio, catalyst, s,
                                             b.catalyst_to_weigh_g, b.esterification_stages)
    if not b.duration and len(b.timeline) >= 2:
        b.duration = round((b.timeline[-1].time - b.timeline[0].time).total_seconds() / 60)
    return b


# ---------- system ----------
@router.get("/health")
def health():
    return {"status": "ok", "mock": config.MOCK}


@router.get("/config")
def process_config(request: Request):
    """The same structure as PROCESS_CONFIG in NewBatch.tsx, built from the settings."""
    s = _settings(request)
    return {
        "oil": {"minimumVolumeMl": s.oil_minimum_volume_ml, "maximumVolumeMl": s.oil_maximum_volume_ml,
                "densityGPerMl": s.oil_density, "averageTriglycerideMolecularWeight": s.oil_molar_mass},
        "ffaThreshold": s.ffa_threshold,
        "ffaTarget": s.ffa_target,
        "methanol": {"ratioDefault": s.methanol_ratio.default, "ratioMin": s.methanol_ratio.min,
                     "ratioMax": s.methanol_ratio.max, "molecularWeight": 32.04, "densityGPerMl": 0.792,
                     "convention": "Molar methanol-to-triglyceride-oil ratio"},
        "catalyst": {"loadingDefault": s.catalyst_loading, "kohPurity": s.koh_purity, "naohPurity": s.naoh_purity},
        "acetone": {"volumeFractionDefault": s.acetone_fraction, "provisional": True},
        "esterification": {**s.esterification.dump(), "sulfuricAcidMlPerGramFfa": calculations.H2SO4_ML_PER_G_FFA,
                           "designFfa": s.esterification_design_ffa, "stripMaxFfa": s.strip_max_ffa},
        "transesterification": s.transesterification.dump(),
        "separation": {"timeMinutes": s.separation_time, "speedRpm": s.separation_speed},
        "purification": {"targetTemperature": s.purification_target_temperature,
                         "maximumTemperature": s.purification_maximum_temperature,
                         "thermalFuseRating": s.thermal_fuse_rating,
                         "holdTimeMinutes": s.purification_hold_time,
                         "meshBedFlowRate": s.mesh_bed_flow_rate,
                         "drainTimeMinutes": s.drain_time,
                         "heatingTimeoutMinutes": s.heating_timeout,
                         "automatic": s.purification_auto_start,
                         "stirringSpeedRpm": s.purification_stirring_speed,
                         "targetRange": {"min": 40, "max": 70}},
        "pumps": {"catalystRateMlPerMinute": s.pump_catalyst_rate, "acidRateMlPerMinute": s.pump_acid_rate,
                  "noFlowSeconds": s.pump_no_flow_seconds},
        "drains": {"reactorMinutes": s.reactor_drain_time, "centrifugeMinutes": s.centrifuge_drain_time,
                   "centrifugeSpinDownSeconds": s.centrifuge_spin_down_time},
        "reactionMaximumTemperature": s.reaction_maximum_temperature,
    }


@router.get("/settings")
def get_settings(request: Request):
    return _settings(request).dump()


@router.put("/settings")
def put_settings(request: Request, updates: dict[str, Any] = Body(...)):
    """Accepts some or all of the website's settings keys and keeps the rest."""
    current = _settings(request).dump()
    merged = current | {k: v for k, v in updates.items() if v is not None or k == "thermalFuseRating"}
    try:
        new = Settings.model_validate(merged)
    except ValidationError as e:
        raise HTTPException(400, _validation_message(e))
    db.save_settings(new)
    request.app.state.settings = new
    return new.dump()


@router.get("/network")
def network():
    """Addresses a phone on the same Wi-Fi can use to reach this computer ("Open on phone")."""
    return {"addresses": system.lan_addresses()}


@router.get("/system/status")
def system_status(request: Request):
    app = request.app
    return system.status(app.state.hw.read(), app.state.stage.state, app.state.purification.state,
                         app.state.pump.state, app.state.drain.state)


@router.get("/live")
def live_snapshot(request: Request):
    return _live(request.app)


@router.websocket("/ws/live")
async def live(websocket: WebSocket):
    """Sends sensors, alarm, stage and purification state every second."""
    await websocket.accept()
    try:
        while True:
            await websocket.send_json(_live(websocket.app))
            await asyncio.sleep(1)
    except (WebSocketDisconnect, RuntimeError):
        pass


@router.post("/alarm/clear")
def clear_alarm(request: Request):
    request.app.state.alarm = None
    return {"alarm": None}


@router.post("/demo/load-oil")
def demo_load_oil(data: DemoOilIn, request: Request):
    """"Load demonstration sensor reading": sets the simulated load cell (demo mode only)."""
    hw = request.app.state.hw
    if not config.MOCK or not hasattr(hw, "demo_load_oil"):
        raise HTTPException(409, "Only available in demonstration mode.")
    hw.demo_load_oil(data.volume_ml, _settings(request).oil_density)
    return hw.refresh()


@router.post("/demo/add")
def demo_add(data: DemoAddIn, request: Request):
    """Demo mode: something poured by hand lands on a simulated load cell (acetone into the
    reactor, or biodiesel straight into the purification tank)."""
    hw = request.app.state.hw
    if not config.MOCK or not hasattr(hw, "demo_add"):
        raise HTTPException(409, "Only available in demonstration mode.")
    hw.demo_add(data.place, data.grams)
    return hw.refresh()


# ---------- calculator and FFA strip ----------
def _ratio(value: Optional[float], s: Settings) -> float:
    ratio = s.methanol_ratio.default if value is None else value
    if not s.methanol_ratio.min <= ratio <= s.methanol_ratio.max:
        raise HTTPException(400, f"Methanol ratio must be between {s.methanol_ratio.min:g}:1 and {s.methanol_ratio.max:g}:1.")
    return ratio


@router.post("/calculate")
def calculate(req: CalculateRequest, request: Request):
    """Same keys as calculateQuantityCards() on the website."""
    s = _settings(request)
    return calculations.quantity_cards(req.oil_mass_g, req.ffa, _ratio(req.methanol_ratio, s), req.catalyst, s)


@router.post("/calculate/after-esterification")
def calculate_after_esterification(req: AfterEsterificationRequest, request: Request):
    s = _settings(request)
    return calculations.after_esterification(req.oil_mass_g, req.ffa_after, req.stage_done,
                                             _ratio(req.methanol_ratio, s), req.catalyst, s)


@router.post("/strip/read")
async def read_strip():
    """Reads the FFA strip in the reader now (call it once the strip's wait time is over)."""
    if config.MOCK:
        return {"ffa": round(random.uniform(2.0, 8.0), 1), "warnings": ["Demonstration reading."]}
    try:
        from .strip_reader import measure_ffa
        ffa, warnings = await asyncio.to_thread(measure_ffa)
    except Exception as e:
        raise HTTPException(503, f"Strip reader error: {e}")
    return {"ffa": round(ffa, 1), "warnings": warnings}


# ---------- batches ----------
@router.get("/batches")
def list_batches():
    return [b.dump() for b in db.list_batches()]


@router.get("/batches/next-id")
def next_batch_id(request: Request):
    return {"id": db.next_batch_id(_settings(request).batch_format, date.today().year)}


@router.get("/batches/{batch_id}")
def get_batch(batch_id: str):
    return _batch_or_404(batch_id).dump()


@router.post("/batches", status_code=201)
def save_batch(data: BatchIn, request: Request):
    """Saves a batch (the website's saveCompletedBatch). Missing ID and date are filled in, and
    anything the Pi measured for this batch ID (temperatures, energy, purification, output
    weight) is added. Saving the same ID twice returns the saved batch unchanged."""
    s = _settings(request)
    batch_id = data.id or db.next_batch_id(s.batch_format, date.today().year)
    existing = db.get_batch(batch_id)
    if existing is not None:
        return existing.dump()
    fields = data.model_dump(by_alias=True) | {"id": batch_id, "date": data.date or date.today().isoformat(),
                                               "createdAt": datetime.now().isoformat()}
    b = Batch.model_validate(fields)
    b = _apply_pending(request.app, b, s)
    b.timeline.append(TimelineEvent(label="Batch saved", time=datetime.now()))
    b = _fill_batch(b, s)
    db.save_batch(b)
    return b.dump()


@router.patch("/batches/{batch_id}")
def update_batch(batch_id: str, request: Request, updates: dict[str, Any] = Body(...)):
    b = _batch_or_404(batch_id)
    merged = b.dump() | {k: v for k, v in updates.items() if k != "id"}
    try:
        b = Batch.model_validate(merged)
    except ValidationError as e:
        raise HTTPException(400, _validation_message(e))
    db.save_batch(b)
    return b.dump()


@router.post("/batches/{batch_id}/lab-result")
def record_lab_result(batch_id: str, data: LabResultIn):
    """The website's updateBatchLabResult."""
    b = _batch_or_404(batch_id)
    if b.status != "Completed":
        raise HTTPException(409, "Only completed batches can get a lab result.")
    b.lab_result = data.lab_result
    b.lab_reference = (data.lab_reference or "").strip() or None
    db.save_batch(b)
    return b.dump()


@router.post("/batches/{batch_id}/esterification-stages")
def add_esterification_stage(batch_id: str, stage: EsterificationStage):
    b = _batch_or_404(batch_id)
    b.esterification_stages = sorted([st for st in b.esterification_stages if st.stage != stage.stage] + [stage],
                                     key=lambda st: st.stage)
    db.save_batch(b)
    return b.dump()


# ---------- analytics ----------
@router.get("/analytics/summary")
def analytics_summary():
    return analytics.summary(db.list_batches())


@router.get("/analytics/ranges")
def analytics_ranges(request: Request):
    """Best Parameters per FFA Range table."""
    return analytics.range_rows(db.list_batches(), _settings(request))


@router.get("/analytics/recommended")
def analytics_recommended(ffa: float, request: Request):
    """The website's getRecommendedParametersForFfa: parameters, or null to keep the defaults."""
    return analytics.recommended_parameters(ffa, db.list_batches(), _settings(request))


@router.get("/analytics/cost")
def analytics_cost(request: Request):
    return analytics.cost_report(db.list_batches(), _settings(request))


# ---------- reaction and separation stages ----------
def _arm_purification(app, batch_id: Optional[str]) -> None:
    """Purification starts by itself once the level switch sees biodiesel at the heater
    (checked every second in main.sensor_loop)."""
    if batch_id and app.state.settings.purification_auto_start:
        app.state.purification_armed = batch_id


def start_drain(app, valve: str, batch_id: Optional[str]) -> None:
    """Opens an outlet valve for its drain time, then closes it:
    reactor outlet -> centrifuge, centrifuge outlet -> purification tank (then purification is armed).
    Raises TransferError or InterlockError."""
    s = app.state.settings
    minutes = s.reactor_drain_time if valve == "reactor_outlet" else s.centrifuge_drain_time
    label = VALVE_LABELS[valve]

    def finished(st: dict) -> None:
        if st["phase"] == "done":
            _event(app, batch_id, f"{label} closed ({st['elapsedSeconds']} s open)")
            if valve == "centrifuge_outlet":
                _arm_purification(app, batch_id)
        else:
            _event(app, batch_id, f"{label} closed early ({st['faultReason']})")
            if st["phase"] == "fault":
                app.state.alarm = f"{label}: {st['faultReason']}"

    centrifuge = valve == "centrifuge_outlet"
    app.state.drain.start(valve, minutes * 60, batch_id, finished,
                          wait_rpm="centrifugeRpm" if centrifuge else None,
                          spin_down_seconds=s.centrifuge_spin_down_time if centrifuge else 0,
                          on_open=lambda: _event(app, batch_id, f"{label} opened"))


def _after_stage(app, valve: str, batch_id: Optional[str]) -> None:
    """Drain after transesterification / separation. A drain time of 0 means the operator moves
    the liquid by hand."""
    s = app.state.settings
    minutes = s.reactor_drain_time if valve == "reactor_outlet" else s.centrifuge_drain_time
    if minutes <= 0:
        if valve == "centrifuge_outlet":
            _arm_purification(app, batch_id)
        return
    try:
        start_drain(app, valve, batch_id)
    except (TransferError, InterlockError) as e:
        app.state.alarm = f"{VALVE_LABELS[valve]} did not open: {e}"


def _stage_event(app):
    def record(label: str, st: dict) -> None:
        rec = _pending(app, st["batchId"])
        rec["timeline"].append({"label": label, "time": datetime.now().isoformat()})
        if label == "Transesterification completed":
            _after_stage(app, "reactor_outlet", st["batchId"])
        elif label == "Separation completed":
            _after_stage(app, "centrifuge_outlet", st["batchId"])
        if st["stage"] in REACTIONS:
            rec["energyKwh"][st["stage"]] = st["energyKwh"]
            if st["averageTemperature"] is not None:
                rec["temperature"][st["stage"]] = st["averageTemperature"]
    return record


@router.get("/process/stage")
def stage_state(request: Request):
    return request.app.state.stage.state


@router.post("/process/stage/start")
async def start_stage(data: StageStart, request: Request):
    app = request.app
    if app.state.purification.running:
        raise HTTPException(409, "Purification is running.")
    if app.state.pump.running:
        raise HTTPException(409, f"{PUMP_LABELS[app.state.pump.state['pump']]} is still loading.")
    if app.state.drain.running:
        raise HTTPException(409, f"Wait for the {VALVE_LABELS[app.state.drain.state['valve']].lower()} "
                                 "to finish draining.")
    app.state.purification_armed = None
    try:
        app.state.stage.start(data.stage, _settings(request), data.batch_id, data.voltage, data.time,
                              data.stirring, _stage_event(app))
    except (StageError, InterlockError) as e:
        raise HTTPException(409, str(e))
    if data.batch_id and data.oil_mass_g:
        _pending(app, data.batch_id)["oilMassG"] = data.oil_mass_g   # for the mesh bed flow time
    return app.state.stage.state


@router.post("/process/stage/{action}")
async def stage_action(action: str, request: Request):
    runner = request.app.state.stage
    try:
        if action == "pause":
            runner.pause()
        elif action == "resume":
            runner.resume()
        elif action == "complete":
            runner.complete()
        elif action == "emergency-stop":
            await stop_transfers(request.app, "emergency stop")
            await runner.emergency_stop()
        elif action == "reset":
            runner.reset()
        else:
            raise HTTPException(404, f"Unknown action: {action}")
    except StageError as e:
        raise HTTPException(409, str(e))
    return runner.state


# ---------- dosing pumps ----------
@router.get("/process/pump")
def pump_state(request: Request):
    return request.app.state.pump.state


@router.post("/process/pump/start")
async def start_pump(data: PumpStart, request: Request):
    """"Load": pump A (NaOH/KOH + methanol) or pump B (H2SO4 + methanol) adds one premixed dose
    to the reactor and stops when the reactor load cell has gained targetG."""
    app, s = request.app, _settings(request)
    if app.state.stage.active:
        raise HTTPException(409, f"{app.state.stage.state['stage']} is running. Load before starting the stage.")
    if app.state.drain.running and app.state.drain.state["valve"] == "reactor_outlet":
        raise HTTPException(409, "The reactor is still draining.")
    rate = s.pump_catalyst_rate if data.pump == "catalyst" else s.pump_acid_rate
    label = PUMP_LABELS[data.pump].split(" (")[0]

    def finished(st: dict) -> None:
        if st["phase"] == "done":
            _event(app, data.batch_id, f"{label} loaded {st['deliveredG']:g} g"
                                       + (f" for {data.stage}" if data.stage else ""))
        else:
            _event(app, data.batch_id, f"{label} stopped at {st['deliveredG']:g} of {st['targetG']:g} g "
                                       f"({st['faultReason']})")

    try:
        app.state.pump.start(data.pump, data.target_g, data.volume_ml, rate, s.pump_no_flow_seconds,
                             data.batch_id, data.stage, finished)
    except (TransferError, InterlockError) as e:
        raise HTTPException(409, str(e))
    return app.state.pump.state


@router.post("/process/pump/stop")
async def stop_pump(request: Request):
    await request.app.state.pump.stop()
    return request.app.state.pump.state


@router.post("/process/pump/skip")
async def skip_pump(request: Request):
    """Demo mode only: the rest of the dose arrives at once."""
    if not config.MOCK:
        raise HTTPException(409, "Only available in demonstration mode.")
    request.app.state.pump.skip()
    return request.app.state.pump.state


# ---------- outlet valves (draining) ----------
@router.get("/process/drain")
def drain_state(request: Request):
    return request.app.state.drain.state


@router.post("/process/drain/start")
async def start_drain_again(data: DrainStart, request: Request):
    """Opens the reactor or centrifuge outlet again for its drain time (it opens by itself after
    transesterification and separation)."""
    app = request.app
    if app.state.stage.active:
        raise HTTPException(409, f"{app.state.stage.state['stage']} is running.")
    if app.state.pump.running:
        raise HTTPException(409, "A dosing pump is running.")
    if data.valve == "centrifuge_outlet" and app.state.purification.running:
        raise HTTPException(409, "Purification is running.")
    try:
        start_drain(app, data.valve, data.batch_id)
    except (TransferError, InterlockError) as e:
        raise HTTPException(409, str(e))
    return app.state.drain.state


@router.post("/process/drain/stop")
async def stop_drain(request: Request):
    await request.app.state.drain.stop("closed by operator")
    return request.app.state.drain.state


@router.post("/process/drain/skip")
async def skip_drain(request: Request):
    """Demo mode only: everything arrives now and the valve closes."""
    if not config.MOCK:
        raise HTTPException(409, "Only available in demonstration mode.")
    request.app.state.drain.skip()
    return request.app.state.drain.state


# ---------- purification ----------
@router.get("/process/purification")
def purification_state(request: Request):
    return request.app.state.purification.state


def _biodiesel_ml(app, s: Settings, batch_id: Optional[str], oil_volume_ml: Optional[float] = None) -> Optional[float]:
    """The batch's biodiesel volume for the mesh bed flow time. It's about the same as the oil
    volume: the oil the website sent, else the oil measured when the batch's stage started,
    else the oil load cell now."""
    if oil_volume_ml:
        return oil_volume_ml
    oil_g = app.state.records.get(batch_id, {}).get("oilMassG") if batch_id else None
    if not oil_g:
        oil_g = app.state.hw.read().get("oilMassG")
    return oil_g / s.oil_density if oil_g else None


def begin_purification(app, s: Settings, target: float, batch_id: Optional[str], automatic: bool = False,
                       oil_volume_ml: Optional[float] = None) -> None:
    """Starts heating → hold → mesh bed flow → drain. Raises RuntimeError or InterlockError."""
    if app.state.drain.running and app.state.drain.state["valve"] == "centrifuge_outlet":
        raise RuntimeError("The centrifuge is still draining into the purification tank.")
    def save_record(record: dict) -> None:
        if not batch_id:
            return
        saved = db.get_batch(batch_id)
        if saved is not None:   # batch already saved: update it directly
            saved.purification = PurificationRecord.model_validate(record)
            db.save_batch(_fill_batch(saved, s))
        else:
            rec = _pending(app, batch_id)
            rec["purification"] = record
            rec["timeline"].append({"label": "Purification completed" if not record["safetyStopOccurred"]
                                    else f"Purification stopped ({record['safetyStopReason']})",
                                    "time": datetime.now().isoformat()})

    app.state.purification.start(s, target, batch_id, save_record,
                                 biodiesel_ml=_biodiesel_ml(app, s, batch_id, oil_volume_ml), automatic=automatic)
    app.state.purification_armed = None
    if batch_id:
        _pending(app, batch_id)["timeline"].append(
            {"label": "Purification started automatically" if automatic else "Purification started",
             "time": datetime.now().isoformat()})


def auto_start_purification(app) -> None:
    """Called every second: starts purification after separation, as soon as the level switch
    reports biodiesel covering the heater. Without a level switch, the operator starts it."""
    batch_id = getattr(app.state, "purification_armed", None)
    runner = app.state.purification
    # "complete" is the previous batch's finished run; a fault must be acknowledged first
    if not batch_id or runner.running or runner.state["phase"] not in ("ready", "complete") or app.state.stage.active:
        return
    if app.state.drain.running:   # wait until the centrifuge outlet has closed
        return
    if app.state.hw.read().get("heaterSubmerged") is not True:
        return
    s = app.state.settings
    try:
        begin_purification(app, s, s.purification_target_temperature, batch_id, automatic=True)
    except (RuntimeError, InterlockError) as e:
        app.state.purification_armed = None
        app.state.alarm = f"Purification did not start: {e}"


@router.post("/process/purification/start")
async def start_purification(data: PurificationStart, request: Request):
    app, s = request.app, _settings(request)
    level = app.state.hw.read().get("heaterSubmerged")
    if level is False:
        raise HTTPException(409, "The level switch doesn't detect biodiesel at the heater.")
    if not data.heater_submerged and level is not True:
        raise HTTPException(400, "Confirm that the heater is fully submerged first.")
    if app.state.stage.active:
        raise HTTPException(409, f"{app.state.stage.state['stage']} is still running.")
    target = s.purification_target_temperature if data.target_temperature is None else data.target_temperature
    try:
        begin_purification(app, s, target, data.batch_id, oil_volume_ml=data.oil_volume_ml)
    except (RuntimeError, InterlockError) as e:
        raise HTTPException(409, str(e))
    return app.state.purification.state


@router.post("/process/purification/skip")
async def skip_purification_phase(request: Request):
    """"Skip timer (demo)": finishes the current phase now. Demo mode only."""
    if not config.MOCK:
        raise HTTPException(409, "Only available in demonstration mode.")
    request.app.state.purification.skip()
    return request.app.state.purification.state


@router.post("/process/purification/abort")
async def abort_purification(request: Request):
    request.app.state.purification_armed = None
    runner = request.app.state.purification
    await runner.abort()
    return runner.state


@router.post("/process/purification/acknowledge")
async def acknowledge_purification(request: Request):
    runner = request.app.state.purification
    try:
        runner.acknowledge()
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    return runner.state


# ---------- manual control (for testing the hardware) ----------
def _manual_allowed(request: Request) -> None:
    app = request.app
    if app.state.purification.running or app.state.stage.active:
        raise HTTPException(409, "A process stage is running. Stop it first.")
    if app.state.pump.running or app.state.drain.running:
        raise HTTPException(409, "A pump or an outlet valve is working. Stop it first.")


@router.post("/control/heater")
async def control_heater(data: SwitchIn, request: Request):
    _manual_allowed(request)
    hw, s = request.app.state.hw, _settings(request)
    if data.on:
        t = hw.read().get("temperature")
        if t is None:
            raise HTTPException(409, "No temperature reading, so the heater stays off.")
        if t >= s.purification_maximum_temperature:
            raise HTTPException(409, f"Temperature is at or above {s.purification_maximum_temperature:g} °C.")
    try:
        hw.set_heater(data.on)
    except InterlockError as e:
        raise HTTPException(409, str(e))
    return hw.refresh()


@router.post("/control/electrode-power")
async def control_electrode_power(data: SwitchIn, request: Request):
    _manual_allowed(request)
    request.app.state.hw.set_electrode_power(data.on)
    return request.app.state.hw.refresh()


@router.post("/control/valve")
async def control_valve(data: ValveIn, request: Request):
    _manual_allowed(request)
    try:
        request.app.state.hw.set_valve(data.name, data.open)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except InterlockError as e:
        raise HTTPException(409, str(e))
    return request.app.state.hw.refresh()


@router.post("/control/motor")
async def control_motor(data: MotorIn, request: Request):
    _manual_allowed(request)
    try:
        request.app.state.hw.set_motor(data.name, data.duty)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except InterlockError as e:
        raise HTTPException(409, str(e))
    return request.app.state.hw.refresh()


@router.post("/control/pump")
async def control_pump(data: PumpIn, request: Request):
    """Runs a dosing pump by hand (priming the line, cleaning). Use "Load" for doses."""
    _manual_allowed(request)
    try:
        request.app.state.hw.set_pump(data.name, data.on)
    except InterlockError as e:
        raise HTTPException(409, str(e))
    return request.app.state.hw.refresh()


@router.post("/control/all-off")
async def all_off(request: Request):
    """Emergency stop: stops any stage and purification, then switches everything off."""
    app = request.app
    app.state.purification_armed = None
    await stop_transfers(app, "emergency stop")
    await app.state.purification.abort("emergency stop")
    await app.state.stage.emergency_stop()
    app.state.hw.all_off()
    return _live(app)
