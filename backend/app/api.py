"""All website endpoints, under /api. Open http://<pi-address>:8000/docs to try them.
JSON uses the website's camelCase names (see API.md)."""
import asyncio
import logging
import threading
from datetime import date, datetime
from typing import Any, Optional

from fastapi import APIRouter, Body, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from . import analytics, calculations, config, db, system
from .hardware import PUMP_LABELS, InterlockError
from .models import (AfterEsterificationRequest, Batch, BatchIn, BatchStartIn, CalculateRequest,
                     EsterificationStage, LabResultIn, LoadCellCalibrateIn, MotorIn, ProgressIn, PumpIn,
                     PumpStart, PurificationRecord, PurificationStart, Settings, StageStart, SwitchIn,
                     TimelineEvent, ValveIn)
from . import purification as dry_wash
from .stages import REACTIONS, REACTOR_SETTLE_S, StageError, separation_limits
from .transfers import MAX_RUN_MINUTES, TransferError

router = APIRouter(prefix="/api")
log = logging.getLogger("greenova.api")

# Starting, completing and cancelling a batch run one at a time (db.start_batch checks again in
# MySQL), so two clicks at the same moment can never make two ongoing batches.
_batch_lock = threading.Lock()


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
    armed = getattr(app.state, "purification_armed", None)
    return {"timestamp": datetime.now().isoformat(timespec="seconds"),
            "sensors": app.state.hw.read(), "alarm": app.state.alarm,
            "stage": app.state.stage.state, "purification": app.state.purification.state,
            "pump": app.state.pump.state,
            # batch ID waiting to start purification by itself (after separation), or None
            "purificationAutoStart": armed,
            # why it hasn't started yet (no temperature / output load cell reading, unacknowledged
            # safety stop), or None
            "purificationWaiting": getattr(app.state, "purification_wait", None) if armed else None}


def _event(app, batch_id: Optional[str], label: str) -> None:
    """Adds a line to the batch's timeline (saved or ongoing batch, or measurements waiting for the save)."""
    if not batch_id:
        return
    now = datetime.now()
    try:
        if db.add_timeline_event(batch_id, label, now):
            return
    except Exception:   # MySQL unavailable: keep the event for the save, never stop the machine for it
        log.exception("Timeline event for batch %s not saved in MySQL", batch_id)
    _pending(app, batch_id)["timeline"].append({"label": label, "time": now.isoformat()})


def _machine_busy(app) -> Optional[str]:
    """What the machine is doing right now ("Transesterification is running (batch B-2026-004)"),
    or None when it is idle."""
    st = app.state
    if st.stage.active:
        what, batch_id = f"{st.stage.state['stage']} is {st.stage.state['state']}", st.stage.state["batchId"]
    elif st.pump.running:
        what, batch_id = f"{PUMP_LABELS[st.pump.state['pump']]} is pumping", st.pump.state["batchId"]
    elif st.purification.running:
        what, batch_id = "purification is running", st.purification.state["batchId"]
    else:
        return None
    return f"{what} (batch {batch_id})" if batch_id else what


def _check_batch(batch_id: Optional[str]) -> None:
    """While a batch is in progress, the machine runs only for that batch."""
    if not batch_id:
        return
    try:
        active = db.active_batch_id()
    except Exception:   # MySQL unreachable: don't stop the batch for it (a new batch can't start without MySQL)
        log.exception("Couldn't check the batch in progress")
        return
    if active is not None and active != batch_id:
        raise HTTPException(409, f"Batch {active} is in progress: the machine can only run that batch. "
                                 "Continue it, or cancel it, first.")


async def stop_transfers(app, reason: str) -> None:
    """Stops the oil pump or a dispenser (emergency stop, shutdown). The reactor pump and pumpin
    stop with the separation stage, the valve + pumpout with purification."""
    await app.state.pump.stop(reason)


async def emergency_stop_all(app, reason: str = "emergency stop") -> None:
    """Stops every process (stage, purification, pumps) and switches everything off.
    The website's emergency stop, and main.py when the ESP32 controller is lost or faulty."""
    app.state.purification_armed = None
    await stop_transfers(app, reason)
    await app.state.purification.abort(reason)
    await app.state.stage.emergency_stop(reason)
    app.state.hw.all_off()


def machine_active(app) -> bool:
    """A process is running or an output is on (then a controller fault must stop everything)."""
    st = app.state
    return bool(st.stage.active or st.purification.running or st.pump.running or st.hw.any_output_on())


def _pending(app, batch_id: str) -> dict:
    """Measurements collected for a batch before the website saves it."""
    return app.state.records.setdefault(batch_id, {"timeline": [], "temperature": {}, "energyKwh": {},
                                                   "purification": None})


def _merge_purification(website: Optional[PurificationRecord], measured: Optional[dict]) -> Optional[PurificationRecord]:
    """The Pi's own record of the dry wash wins; anything it doesn't have comes from the website.
    Never raises: a save must not fail because of the purification record."""
    if not measured:
        return website
    base = website.dump() if website else {}
    merged = base | {k: v for k, v in measured.items() if v is not None}
    try:
        return PurificationRecord.model_validate(merged)
    except ValidationError:
        return website


def _apply_pending(app, b: Batch, s: Settings) -> Batch:
    """Fill in what the Pi measured itself. Measured values replace the website's placeholders
    (temperature 27, yield 0, energy 0)."""
    rec = app.state.records.pop(b.id, None)
    if rec is None:
        return b
    if b.adsorbent is None and rec.get("adsorbent"):
        b.adsorbent = rec["adsorbent"]
    b.timeline = sorted(b.timeline + [TimelineEvent.model_validate(e) for e in rec["timeline"]],
                        key=lambda e: e.time)
    temps = rec["temperature"]
    measured_temp = temps.get("Transesterification", temps.get("Esterification"))
    if measured_temp is not None:
        b.temperature = measured_temp
    if rec["purification"]:
        b.purification = _merge_purification(b.purification, rec["purification"])
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
    if b.adsorbent is None and b.purification and b.purification.adsorbent:
        b.adsorbent = b.purification.adsorbent
    if b.catalyst_to_weigh_g is None:
        last_ffa = next((st.ffa_after for st in reversed(b.esterification_stages) if st.ffa_after is not None), None)
        acid = last_ffa if last_ffa is not None else (s.ffa_target if b.esterification_run else b.ffa)
        b.catalyst_to_weigh_g = calculations.transesterification(b.oil_mass_g, acid, ratio, catalyst, s)["catalystToWeighG"]
    if b.materials is None:
        used_g = (b.purification.adsorbent_g or b.purification.magnesol_g) if b.purification else None
        b.materials = calculations.materials(b.oil_volume, b.ffa, b.esterification_run, ratio, catalyst, s,
                                             b.catalyst_to_weigh_g, b.esterification_stages,
                                             b.adsorbent, used_g)
    if not b.duration and len(b.timeline) >= 2:
        b.duration = round((b.timeline[-1].time - b.timeline[0].time).total_seconds() / 60)
    return b


# ---------- system ----------
@router.get("/health")
def health():
    return {"status": "ok"}


@router.get("/config")
def process_config(request: Request):
    """The same structure as PROCESS_CONFIG in NewBatch.tsx, built from the settings."""
    s = _settings(request)
    return {
        "oil": {"minimumVolumeMl": s.oil_minimum_volume_ml, "maximumVolumeMl": s.oil_maximum_volume_ml,
                "densityGPerMl": s.oil_density, "averageTriglycerideMolecularWeight": s.oil_molar_mass},
        "ffaThreshold": s.ffa_threshold,
        "ffaTarget": s.ffa_target,
        # operator inputs (FFA, volume, voltage, current, time, stirring) are whole numbers only
        "wholeNumberInputs": True,
        # Effective process behavior: handoffs are automatic; legacy saved values are left untouched.
        "autoAdvance": True,
        "methanol": {"ratioDefault": s.methanol_ratio.default, "ratioMin": s.methanol_ratio.min,
                     "ratioMax": s.methanol_ratio.max, "molecularWeight": 32.04, "densityGPerMl": 0.792,
                     "convention": "Molar methanol-to-triglyceride-oil ratio"},
        "catalyst": {"loadingDefault": s.catalyst_loading, "kohPurity": s.koh_purity, "naohPurity": s.naoh_purity},
        "acetone": {"volumeFractionDefault": s.acetone_fraction, "provisional": True},
        "esterification": {**s.esterification.dump(), "sulfuricAcidMlPerGramFfa": calculations.H2SO4_ML_PER_G_FFA,
                           "designFfa": s.esterification_design_ffa, "stripMaxFfa": s.strip_max_ffa},
        "transesterification": s.transesterification.dump(),
        # set per batch on Volume & Parameters (these are the defaults and limits); it starts by
        # itself after transesterification and a settle of settleSeconds in the reactor
        "separation": _separation_config(request.app, s),
        # heating -> methanol removal (87-90 °C) -> add adsorbent -> contact -> settle -> drain
        "purification": {"holdTemperature": dry_wash.HOLD_TEMPERATURE_C, "holdBand": dry_wash.HOLD_BAND_C,
                         "settleSeconds": dry_wash.PURIFIER_SETTLE_S,
                         "maximumTemperature": dry_wash.MAXIMUM_TEMPERATURE_C,
                         "heatingTimeoutMinutes": dry_wash.HEATING_TIMEOUT_S / 60,
                         "methanolRemovalMinutes": s.methanol_removal_time, "contactMinutes": s.contact_time,
                         "stirringSpeedRpm": dry_wash.STIRRING_SPEED_RPM,
                         "drainStableGrams": dry_wash.DRAIN_STABLE_G, "drainStableSeconds": dry_wash.DRAIN_STABLE_S,
                         "lowOutputFraction": dry_wash.LOW_OUTPUT_FRACTION,
                         "magnesolGramsPerMlOil": round(s.oil_density * s.magnesol_dose / 100, 4),
                         "bentoniteGramsPerMlOil": round(s.oil_density * s.bentonite_dose / 100, 4),
                         "adsorbents": list(calculations.ADSORBENTS),
                         "defaultAdsorbent": s.default_adsorbent,
                         "magnesolDosePct": s.magnesol_dose, "bentoniteDosePct": s.bentonite_dose,
                         "thermalFuseRating": s.thermal_fuse_rating, "automatic": True},
        "powerSupply": {"currentControl": config.POWER_SUPPLY_CURRENT_CONTROL},
        # the oil pump and the dispensers run until the operator presses Done (stopStyle "manual")
        "pumps": {"oilPump": request.app.state.hw.has_oil_pump, "stopStyle": "manual",
                  "maxRunMinutes": MAX_RUN_MINUTES},
        "reactionMaximumTemperature": s.reaction_maximum_temperature,
    }


@router.get("/settings")
def get_settings(request: Request):
    return _settings(request).dump()


# Settings page values the operator types: whole numbers only (no decimals).
WHOLE_NUMBER_SETTINGS = (
    "methanolRemovalTime", "contactTime", "settlingTime", "maxDrainTemperature", "ffaThreshold", "ffaTarget",
    "oilMinimumVolumeMl", "oilMaximumVolumeMl", "separationTime", "separationSpeed", "heaterPowerWatts", "esterificationDesignFfa",
    "stripMaxFfa", "pumpCatalystRate", "pumpAcidRate", "reactorDrainTime", "centrifugeDrainTime",
    "centrifugeSpinDownTime", "provenBatchCount", "provenYieldTolerance", "oilPrice", "methanolPrice", "kohPrice",
    "naohPrice", "sulfuricAcidPrice", "acetonePrice", "bentonitePrice", "magnesolPrice", "electricityPrice",
    "dieselPrice", "magnesolDose", "bentoniteDose", "oilMolarMass", "kohPurity", "naohPurity")


@router.put("/settings")
def put_settings(request: Request, updates: dict[str, Any] = Body(...)):
    """Accepts some or all of the website's settings keys and keeps the rest."""
    for key in WHOLE_NUMBER_SETTINGS:
        value = updates.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and float(value) != int(value):
            raise HTTPException(400, f"{key} must be a whole number (no decimals).")
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
                         app.state.pump.state)


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
    return calculations.quantity_cards(req.oil_mass_g, req.ffa, _ratio(req.methanol_ratio, s), req.catalyst, s,
                                       req.adsorbent)


@router.post("/calculate/after-esterification")
def calculate_after_esterification(req: AfterEsterificationRequest, request: Request):
    s = _settings(request)
    return calculations.after_esterification(req.oil_mass_g, req.ffa_after, req.stage_done,
                                             _ratio(req.methanol_ratio, s), req.catalyst, s)


# ---------- batches ----------
# Only one batch is processed at a time. "Start batch" on the Process page records it as
# "In Progress" (so it is in Batch History at once); the page saves where it is (progress), so the
# batch can be continued from the Dashboard or another device; completing or cancelling it
# updates the same row. While it is in progress, no other batch can be started.
def _with_stage(b: Batch, stage: Optional[str] = None) -> dict:
    """The batch's JSON, plus currentStage (the Process page stage) while it is in progress."""
    if b.status != db.IN_PROGRESS:
        return b.dump()
    if stage is None:
        progress = db.get_progress(b.id)
        stage = progress["stage"] if progress else None
    return b.dump() | {"currentStage": stage}


def _active_dump(b: Batch) -> dict:
    """The ongoing batch with its saved progress ({"stage", "state", "updatedAt"} or null)."""
    progress = db.get_progress(b.id)
    return b.dump() | {"currentStage": progress["stage"] if progress else None, "progress": progress}


def _start(app, s: Settings, b: Batch) -> dict:
    """Records b as the batch in progress. 409 when another batch is in progress or the machine
    is still busy. Starting the ongoing batch again (same ID) just returns it."""
    with _batch_lock:
        active = db.active_batch_id()
        if active is not None:
            if active == b.id:
                return _active_dump(db.get_batch(active))
            raise HTTPException(409, str(db.ActiveBatchError(active)))
        busy = _machine_busy(app)
        if busy:
            raise HTTPException(409, f"The machine is still busy: {busy}. Wait for it to finish, or stop it, "
                                     "before starting a new batch.")
        try:
            started = db.start_batch(b, s.batch_format, date.today().year)
        except db.ActiveBatchError as e:
            raise HTTPException(409, str(e))
        return _active_dump(started)


def _finish_ongoing(existing: Batch, b: Batch) -> Batch:
    """The website completes the batch that was in progress: the same row is updated, keeping what
    was recorded while it ran (start time, timeline, the Pi's purification record)."""
    b.created_at = existing.created_at
    b.timeline = existing.timeline + b.timeline
    b.notes = b.notes or existing.notes
    if existing.purification is not None:
        b.purification = _merge_purification(b.purification, existing.purification.dump())
    return b


@router.get("/batches")
def list_batches():
    stages = db.progress_stages()
    return [_with_stage(b, stages.get(b.id)) for b in db.list_batches()]


@router.get("/batches/next-id")
def next_batch_id(request: Request):
    return {"id": db.next_batch_id(_settings(request).batch_format, date.today().year)}


@router.get("/batches/active")
def active_batch():
    """The batch in progress, with where the Process page is (progress), or null when there's none."""
    batch_id = db.active_batch_id()
    b = db.get_batch(batch_id) if batch_id else None
    return _active_dump(b) if b else None


@router.post("/batches/start", status_code=201)
def start_batch(request: Request, data: Optional[BatchStartIn] = None):
    """"Start batch" on the Process page: records a new batch as In Progress. 409 when a batch is
    already in progress (only one at a time) or the machine is still busy."""
    now = datetime.now()
    b = Batch(id=(data.id if data else None) or "", date=date.today().isoformat(), oil_volume=0,
              status=db.IN_PROGRESS, created_at=now, timeline=[TimelineEvent(label="Batch started", time=now)])
    return _start(request.app, _settings(request), b)


@router.get("/batches/{batch_id}")
def get_batch(batch_id: str):
    return _with_stage(_batch_or_404(batch_id))


@router.post("/batches", status_code=201)
def save_batch(data: BatchIn, request: Request):
    """Saves a batch (the website's saveCompletedBatch). Missing ID and date are filled in, and
    anything the Pi measured for this batch ID (temperatures, energy, purification, output
    weight) is added. The batch in progress is completed in its own row (never a second row for
    the same ID); saving any other existing ID returns the saved batch unchanged."""
    s = _settings(request)
    oil_volume = data.oil_volume
    if not oil_volume and data.oil_mass_g:
        oil_volume = round(data.oil_mass_g / s.oil_density, 1)
    fields = data.model_dump(by_alias=True) | {"date": data.date or date.today().isoformat(),
                                               "oilVolume": oil_volume or 0,
                                               "createdAt": datetime.now().isoformat()}
    if data.status == db.IN_PROGRESS:            # an ongoing batch: the same rule as "Start batch"
        b = Batch.model_validate(fields | {"id": data.id or ""})
        b.timeline.append(TimelineEvent(label="Batch started", time=datetime.now()))
        return _start(request.app, s, b)
    with _batch_lock:
        batch_id = data.id or db.next_batch_id(s.batch_format, date.today().year)
        existing = db.get_batch(batch_id)
        if existing is not None and existing.status != db.IN_PROGRESS:
            return existing.dump()
        b = Batch.model_validate(fields | {"id": batch_id})
        if existing is not None:
            b = _finish_ongoing(existing, b)
        b = _apply_pending(request.app, b, s)
        if getattr(request.app.state, "purification_armed", None) == batch_id:
            request.app.state.purification_armed = None      # the batch is finished: nothing more starts for it
        b.timeline.append(TimelineEvent(label="Batch saved", time=datetime.now()))
        b = _fill_batch(b, s)
        db.save_batch(b)
    return b.dump()


# Batch fields the Process page sends while the batch is in progress (its setup so far). The
# results (yield, energy, purification, timeline) are recorded when the batch is completed.
PROGRESS_FIELDS = ("oilVolume", "oilMassG", "ffa", "ffaAboveStrip", "esterificationRun", "esterificationVoltage",
                   "esterificationTime", "esterificationStirring", "esterificationCurrent", "reactionTime",
                   "stirringSpeed", "voltage", "current", "methanolRatio", "catalystType", "adsorbent",
                   "catalystToWeighG")


@router.put("/batches/{batch_id}/progress")
def save_progress(batch_id: str, data: ProgressIn):
    """Saves where the ongoing batch is on the Process page (and its setup so far), so it can be
    continued later or on another device. 409 when the batch isn't in progress."""
    b = _batch_or_404(batch_id)
    if b.status != db.IN_PROGRESS:
        raise HTTPException(409, f"Batch {batch_id} is {b.status.lower()}: it can't be continued.")
    setup = {k: v for k, v in (data.batch or {}).items() if k in PROGRESS_FIELDS}
    try:
        b = Batch.model_validate(b.dump() | setup)
    except ValidationError as e:
        raise HTTPException(400, _validation_message(e))
    if not db.save_progress(b, data.stage, data.state):
        raise HTTPException(409, f"Batch {batch_id} is no longer in progress.")
    return {"id": batch_id, "stage": data.stage}


@router.post("/batches/{batch_id}/cancel")
def cancel_batch(batch_id: str, request: Request):
    """Cancels the batch in progress. It stays in Batch History as Cancelled (lab result: Not
    tested), and a new batch can be started. 409 while the machine is still working."""
    app = request.app
    with _batch_lock:
        b = _batch_or_404(batch_id)
        if b.status != db.IN_PROGRESS:
            raise HTTPException(409, f"Only a batch in progress can be cancelled: {batch_id} is {b.status.lower()}.")
        busy = _machine_busy(app)
        if busy:
            raise HTTPException(409, f"Stop the machine first: {busy}.")
        b = Batch.model_validate(b.dump() | {"status": "Cancelled"})
        b = _apply_pending(app, b, _settings(request))     # keep what the Pi recorded before the cancel
        app.state.hw.all_off()                              # nothing stays on after the batch
        b.timeline.append(TimelineEvent(label="Batch cancelled", time=datetime.now()))
        db.save_batch(b)
    if getattr(app.state, "purification_armed", None) == batch_id:
        app.state.purification_armed = None
    return b.dump()


@router.patch("/batches/{batch_id}")
def update_batch(batch_id: str, request: Request, updates: dict[str, Any] = Body(...)):
    b = _batch_or_404(batch_id)
    if updates.get("status") == db.IN_PROGRESS and b.status != db.IN_PROGRESS:
        raise HTTPException(409, "A finished batch can't be put back in progress. Start a new batch instead.")
    merged = b.dump() | {k: v for k, v in updates.items() if k != "id"}
    try:
        b = Batch.model_validate(merged)
    except ValidationError as e:
        raise HTTPException(400, _validation_message(e))
    db.save_batch(b)
    return _with_stage(db.get_batch(batch_id))   # as saved (e.g. a lab result time is never cleared)


@router.post("/batches/{batch_id}/lab-result")
def record_lab_result(batch_id: str, data: LabResultIn):
    """The website's updateBatchLabResult: records or changes the batch's lab result. The batch's
    one batch_lab_results row is updated (never a second row). tested_at is the time the website
    sends (else now); sending the same result and reference again changes nothing, so the time
    it was first recorded stays. An empty reference keeps the saved one."""
    b = _batch_or_404(batch_id)
    if b.status != "Completed":
        raise HTTPException(409, "Only completed batches can get a lab result.")
    reference = (data.lab_reference or "").strip() or b.lab_reference
    if (b.lab_result, b.lab_reference) == (data.lab_result, reference) and b.lab_tested_at is not None:
        return b.dump()
    when = data.tested_at or datetime.now()
    if when.tzinfo is not None:                  # the website's time (UTC) in the Pi's local time, like every DATETIME
        when = when.astimezone().replace(tzinfo=None)
    b.lab_result, b.lab_reference, b.lab_tested_at = data.lab_result, reference, when
    b.timeline.append(TimelineEvent(label=f"Lab result recorded: {data.lab_result}"
                                          + (f" ({reference})" if reference else ""), time=when))
    db.save_batch(b)
    return db.get_batch(batch_id).dump()


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
def _separation_config(app, s: Settings) -> dict:
    limits = separation_limits(app.state.hw, s)
    return {"timeMinutes": limits["timeDefault"], "speedRpm": limits["speedDefault"],
            "timeMin": limits["timeMin"], "timeMax": limits["timeMax"],
            "speedMin": limits["speedMin"], "speedMax": limits["speedMax"],
            "settleSeconds": limits["settleSeconds"]}


def _arm_purification(app, batch_id: Optional[str]) -> None:
    """Separation has finished: everything is in the purifier, so purification starts right away.

    The sensor loop starts it within a second. A fitted level switch that reads not-submerged
    holds the heater off until the biodiesel covers it; without a level switch it starts at once.
    """
    if batch_id:
        app.state.purification_armed = batch_id
        app.state.purification_wait = None


def _auto_start_separation(app, batch_id: Optional[str]) -> None:
    """Transesterification has finished: the mixture settles in the reactor for REACTOR_SETTLE_S,
    then the reactor pump, the centrifuge and pumpin run together (stages.py), with the batch's
    separation time and speed from Volume & Parameters (else the Settings defaults).

    It runs on the Pi even if the website is closed. Any problem becomes an alarm rather than a
    silent pause; the Separation step on the website can then start it by hand."""
    if not batch_id:
        return
    runner = app.state.stage
    busy = ("another stage is running" if runner.active else "a stage fault must be reset first"
            if runner.state["state"] == "fault" else "a pump into the reactor is running" if app.state.pump.running
            else "purification is running" if app.state.purification.running else None)
    if busy:
        app.state.alarm = f"Separation did not start by itself: {busy}."
        return
    sep = _pending(app, batch_id).get("separation") or {}
    try:
        runner.start("Separation", app.state.settings, batch_id, time_min=sep.get("time"),
                     speed=sep.get("speed"), on_event=_stage_event(app), settle_seconds=REACTOR_SETTLE_S)
    except (StageError, InterlockError) as e:
        app.state.alarm = f"Separation did not start by itself: {e}"
    except Exception as e:   # never leave the batch silently stuck
        log.exception("Separation did not start by itself")
        app.state.alarm = f"Separation did not start by itself: unexpected error: {e}"


def _soon(callback, *args) -> None:
    """Runs callback just after the current step, so the stage that has just finished has fully
    ended first (and a request that finished it still answers with that stage's state)."""
    try:
        asyncio.get_running_loop().call_soon(callback, *args)
    except RuntimeError:     # no running event loop
        callback(*args)


def _stage_event(app):
    def record(label: str, st: dict) -> None:
        rec = _pending(app, st["batchId"])
        _event(app, st["batchId"], label)
        if st["stage"] in REACTIONS and st.get("faultReason") and "current" in st["faultReason"]:
            app.state.alarm = f"Electrodes stopped: {st['faultReason']}."
        if label == "Transesterification completed":
            _soon(_auto_start_separation, app, st["batchId"])
        elif label == "Separation completed":
            _arm_purification(app, st["batchId"])
        if st["stage"] in REACTIONS:
            rec["energyKwh"][st["stage"]] = st["energyKwh"]
            if st["averageTemperature"] is not None:
                rec["temperature"][st["stage"]] = st["averageTemperature"]
    return record


def _separation_values(app, s: Settings, data: StageStart) -> dict:
    """The batch's separation time and speed sent with a stage start (checked now, so a wrong
    value is caught before the reaction, not when separation starts by itself)."""
    limits = separation_limits(app.state.hw, s)
    time_min = data.separation_time if data.separation_time is not None else (
        data.time if data.stage == "Separation" else None)
    speed = data.separation_speed
    if time_min is not None and not limits["timeMin"] <= time_min <= limits["timeMax"]:
        raise HTTPException(400, f"Separation time must be between {limits['timeMin']:g} and {limits['timeMax']:g} min.")
    if speed is not None and not limits["speedMin"] <= speed <= limits["speedMax"]:
        raise HTTPException(400, f"Centrifuge speed must be between {limits['speedMin']:g} and "
                                 f"{limits['speedMax']:g} RPM.")
    return {k: v for k, v in (("time", time_min), ("speed", speed)) if v is not None}


@router.get("/process/stage")
def stage_state(request: Request):
    return request.app.state.stage.state


@router.post("/process/stage/start")
async def start_stage(data: StageStart, request: Request):
    app = request.app
    await asyncio.to_thread(_check_batch, data.batch_id)
    if app.state.purification.running:
        raise HTTPException(409, "Purification is running.")
    if app.state.pump.running:
        raise HTTPException(409, f"{PUMP_LABELS[app.state.pump.state['pump']]} is still pumping: press Done "
                                 "when its container is empty.")
    if data.stage in REACTIONS and app.state.hw.valves.get("reactor_outlet"):
        raise HTTPException(409, "The reactor pump is running: stop it before a reaction stage.")
    s = _settings(request)
    separation = _separation_values(app, s, data)
    if data.batch_id and separation:
        _pending(app, data.batch_id)["separation"] = separation   # for the separation that starts by itself
    app.state.purification_armed = None
    try:
        if data.stage == "Separation":   # started by hand: no settle (the mixture has had its time)
            app.state.stage.start("Separation", s, data.batch_id, time_min=separation.get("time"),
                                  speed=separation.get("speed"), on_event=_stage_event(app))
        else:
            app.state.stage.start(data.stage, s, data.batch_id, data.voltage, data.time,
                                  data.stirring, _stage_event(app), current=data.current)
    except (StageError, InterlockError) as e:
        raise HTTPException(409, str(e))
    if data.batch_id and data.oil_mass_g:
        _pending(app, data.batch_id)["oilMassG"] = data.oil_mass_g   # for the adsorbent and the output check
    if data.batch_id and data.adsorbent:
        _pending(app, data.batch_id)["adsorbent"] = data.adsorbent   # used when purification starts by itself
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


# ---------- oil pump and dispensers (stopped by the operator) ----------
@router.get("/process/pump")
def pump_state(request: Request):
    return request.app.state.pump.state


@router.post("/process/pump/start")
async def start_pump(data: PumpStart, request: Request):
    """Switches on the oil pump ("oil", Oil Loading step), pump A ("catalyst": NaOH/KOH +
    methanol) or pump B ("acid": H2SO4 + methanol). The operator has measured the computed amount
    (targetG / volumeMl) into its container; the pump runs until they press Done (or Stop)."""
    app = request.app
    await asyncio.to_thread(_check_batch, data.batch_id)
    if app.state.stage.active:
        raise HTTPException(409, f"{app.state.stage.state['stage']} is running. Pump it in before starting the stage.")
    if app.state.purification.running:
        raise HTTPException(409, "Purification is running.")
    label = PUMP_LABELS[data.pump].split(" (")[0]

    def finished(st: dict) -> None:
        took = f"{st['elapsedSeconds'] // 60} min {st['elapsedSeconds'] % 60} s"
        if st["phase"] == "done":
            _event(app, data.batch_id, f"{label}: all {st['targetG']:g} g pumped in ({took})"
                                       + (f" for {data.stage}" if data.stage else ""))
        else:
            _event(app, data.batch_id, f"{label} stopped after {took} ({st['faultReason']})")
            if st["phase"] == "fault":
                app.state.alarm = f"{label} stopped: {st['faultReason']}."

    try:
        app.state.pump.start(data.pump, data.target_g, data.volume_ml, data.batch_id, data.stage, finished)
    except (TransferError, InterlockError) as e:
        raise HTTPException(409, str(e))
    _event(app, data.batch_id, f"{label} started")
    return app.state.pump.state


@router.post("/process/pump/finish")
async def finish_pump(request: Request):
    """"Done": the operator sees its container empty; the pump stops and the dose counts as loaded."""
    runner = request.app.state.pump
    try:
        runner.finish()
    except TransferError as e:
        raise HTTPException(409, str(e))
    for _ in range(50):                     # the pump task switches it off within a moment
        if not runner.running:
            break
        await asyncio.sleep(0.02)
    return runner.state


@router.post("/process/pump/stop")
async def stop_pump(request: Request):
    """Stops the pump now (it can be started again for the rest)."""
    await request.app.state.pump.stop()
    return request.app.state.pump.state


# ---------- purification ----------
@router.get("/process/purification")
def purification_state(request: Request):
    return request.app.state.purification.state


def _oil_volume_ml(app, s: Settings, batch_id: Optional[str], oil_volume_ml: Optional[float] = None) -> Optional[float]:
    """The batch's oil volume, for the Magnesol amount and the low-output check: the oil the
    website sent, else the oil measured when the batch's stage started."""
    if oil_volume_ml:
        return oil_volume_ml
    oil_g = app.state.records.get(batch_id, {}).get("oilMassG") if batch_id else None
    return oil_g / s.oil_density if oil_g else None


def _store_purification(app, s: Settings, batch_id: str, record: dict, label: str) -> None:
    """Saves the Pi's purification record (and its timeline line) for the batch."""
    try:
        saved = db.get_batch(batch_id)
        if saved is not None and saved.status == db.IN_PROGRESS:   # kept for when the website completes it
            db.set_purification(batch_id, PurificationRecord.model_validate(record))
            db.add_timeline_event(batch_id, label)
            return
        if saved is not None:   # batch already saved: update it directly
            saved.purification = PurificationRecord.model_validate(record)
            db.save_batch(_fill_batch(saved, s))
            return
    except Exception:   # MySQL unavailable: keep the record for the save
        log.exception("Purification record for batch %s not saved in MySQL", batch_id)
    rec = _pending(app, batch_id)
    rec["purification"] = record
    rec["timeline"].append({"label": label, "time": datetime.now().isoformat()})


def begin_purification(app, s: Settings, batch_id: Optional[str], automatic: bool = False,
                       oil_volume_ml: Optional[float] = None, adsorbent: Optional[str] = None) -> None:
    """Starts heating → methanol removal (87-90 °C) → add adsorbent → contact → settle → drain.
    When it ends (completed, stopped or faulted) every output is switched off.
    The adsorbent (Magnesol or bentonite) is the one given, else the one sent with the batch's
    stages, else Settings defaultAdsorbent. Raises RuntimeError or InterlockError."""
    if app.state.stage.active:
        raise RuntimeError(f"{app.state.stage.state['stage']} is still running.")

    def save_record(record: dict) -> None:
        try:
            app.state.hw.all_off()            # the batch's process is over: everything off
        except Exception:
            log.exception("Could not switch every output off after purification")
        if not batch_id:
            return
        label = ("Purification completed" if not record["safetyStopOccurred"]
                 else f"Purification stopped ({record['safetyStopReason']})")
        _store_purification(app, s, batch_id, record, label)

    volume = _oil_volume_ml(app, s, batch_id, oil_volume_ml)
    chosen = adsorbent or (app.state.records.get(batch_id, {}).get("adsorbent") if batch_id else None) \
        or s.default_adsorbent
    if batch_id:
        _pending(app, batch_id)["adsorbent"] = chosen
    app.state.purification.start(s, batch_id, save_record, oil_g=volume * s.oil_density if volume else None,
                                 magnesol_g=calculations.adsorbent_g(volume, chosen, s) if volume else None,
                                 automatic=automatic, adsorbent=chosen)
    app.state.purification_armed = None
    app.state.purification_wait = None
    if (app.state.alarm or "").startswith("Purification is waiting:"):
        app.state.alarm = None                  # fixed: it has started
    _event(app, batch_id, "Purification started automatically" if automatic else "Purification started")


def auto_start_purification(app) -> None:
    """Called every second: start purification as soon as separation has finished (everything
    has been pumped into the purifier).

    If a level switch is installed and says the heater is not submerged yet, keep waiting until
    the biodiesel flowing in covers it. Without the optional switch (None) it starts at once.

    It never gives up on its own: with no temperature reading, no output load cell reading, or an
    earlier purification safety stop not acknowledged yet, it waits (nothing is switched on), shows
    why on the website, and starts as soon as that is fixed.
    """
    batch_id = getattr(app.state, "purification_armed", None)
    runner = app.state.purification
    if not batch_id or runner.running or app.state.stage.active:
        return
    if runner.state["phase"] == "fault":       # an earlier run's safety stop must be acknowledged first
        reason = runner.state.get("safetyStopReason")
        _purification_waits(app, "the last purification run ended in a safety stop"
                            + (f" ({reason})" if reason else "") + ". Press Acknowledge on the Purification step.")
        return
    if runner.state["phase"] not in ("ready", "complete"):   # "complete": the previous batch's finished run
        return
    if app.state.hw.read().get("heaterSubmerged") is False:
        return
    s = app.state.settings
    try:
        begin_purification(app, s, batch_id, automatic=True)
        app.state.purification_wait = None
    except (RuntimeError, InterlockError) as e:
        _purification_waits(app, str(e))


def _purification_waits(app, reason: str) -> None:
    """Purification can't start yet: keep the batch waiting and say why (the alarm once per reason,
    so the operator can clear it; the Purification step shows the reason until it starts)."""
    if getattr(app.state, "purification_wait", None) != reason:
        app.state.purification_wait = reason
        app.state.alarm = f"Purification is waiting: {reason} It starts by itself once this is fixed."
        log.warning("Purification is waiting: %s", reason)


@router.post("/process/purification/start")
async def start_purification(data: PurificationStart, request: Request):
    app, s = request.app, _settings(request)
    await asyncio.to_thread(_check_batch, data.batch_id)
    level = app.state.hw.read().get("heaterSubmerged")
    if level is False:
        raise HTTPException(409, "The level switch doesn't detect biodiesel at the heater.")
    if not data.heater_submerged and level is not True:
        raise HTTPException(400, "Confirm that the heater is fully submerged first.")
    if app.state.stage.active:
        raise HTTPException(409, f"{app.state.stage.state['stage']} is still running.")
    try:
        begin_purification(app, s, data.batch_id, oil_volume_ml=data.oil_volume_ml, adsorbent=data.adsorbent)
    except (RuntimeError, InterlockError) as e:
        raise HTTPException(409, str(e))
    return app.state.purification.state


@router.post("/process/purification/magnesol-added")
async def confirm_magnesol(request: Request):
    """"Confirm" on the website: the operator has added the adsorbent (Magnesol or bentonite)."""
    runner = request.app.state.purification
    try:
        runner.confirm_magnesol()
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    if runner.state["batchId"]:
        _event(request.app, runner.state["batchId"],
               f"{runner.state.get('adsorbent') or 'Magnesol'} added ({runner.state['magnesolG'] or '?'} g)")
    return runner.state


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
    if app.state.pump.running:
        raise HTTPException(409, "A pump into the reactor is running. Stop it first.")


@router.post("/control/heater")
async def control_heater(data: SwitchIn, request: Request):
    _manual_allowed(request)
    hw, s = request.app.state.hw, _settings(request)
    if data.on:
        t = hw.read().get("temperature")
        if t is None:
            raise HTTPException(409, "No temperature reading, so the heater stays off.")
        if t >= dry_wash.MAXIMUM_TEMPERATURE_C:
            raise HTTPException(409, f"Temperature is at or above {dry_wash.MAXIMUM_TEMPERATURE_C:g} °C.")
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
    await emergency_stop_all(app, "emergency stop")
    return _live(app)


# ---------- hardware (Settings -> Hardware) ----------
@router.get("/hardware")
def hardware_info(request: Request):
    """The output controller (ESP32: online, port, its devices), which ESP32 output does which job,
    the centrifuge, and the load cells with their calibration."""
    return request.app.state.hw.describe()


async def _load_cell_step(request: Request, key: str, step, *args) -> dict:
    _manual_allowed(request)                      # never re-zero a scale in the middle of a batch
    hw = request.app.state.hw
    try:
        result = await asyncio.to_thread(step, key, *args)   # averages the readings for ~3 s
    except NotImplementedError as e:
        raise HTTPException(409, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    hw.refresh()
    return {"result": result, "loadCells": hw.load_cells()}


@router.post("/hardware/load-cells/{key}/tare")
async def tare_load_cell(key: str, request: Request):
    """Zero the load cell: nothing on it (or only the empty container)."""
    return await _load_cell_step(request, key, request.app.state.hw.tare_load_cell)


@router.post("/hardware/load-cells/{key}/calibrate")
async def calibrate_load_cell(key: str, data: LoadCellCalibrateIn, request: Request):
    """A known weight is on the (tared) load cell: works out its scale factor."""
    return await _load_cell_step(request, key, request.app.state.hw.calibrate_load_cell, data.grams)
