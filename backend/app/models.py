"""Data shapes. The JSON uses the same camelCase names as the website
(src/lib/greenovaData.ts, the greenova_settings keys, and PROCESS_CONFIG in NewBatch.tsx).
Text lengths follow the MySQL columns (schema.sql), e.g. a batch ID is at most 50 characters."""
import re
from datetime import date as _date
from datetime import datetime
from typing import Annotated, Any, Literal, Optional

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel

Catalyst = Literal["NaOH", "KOH"]
# Dry wash adsorbent for purification (chosen per batch on the website's Volume & Parameters step)
Adsorbent = Literal["Magnesol", "Bentonite"]


def _whole(value: Optional[float]) -> Optional[float]:
    """Operator inputs are whole numbers only (no decimals): 3, not 3.5."""
    if value is not None and float(value) != int(float(value)):
        raise ValueError("Use a whole number (no decimals).")
    return value


# A number the operator typed: must be a whole number (3 or 3.0 are fine, 3.5 is refused).
WholeNumber = Annotated[float, AfterValidator(_whole)]
BatchStatus = Literal["Completed", "Failed", "In Progress", "Cancelled"]
LabResult = Literal["Pending", "Passed", "Failed", "Not tested"]
StageName = Literal["Esterification", "Transesterification", "Separation"]


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    def dump(self) -> dict:
        return self.model_dump(by_alias=True, mode="json")


# ---------- settings ----------
class Limit(CamelModel):
    min: float
    max: float
    default: float


def _current_limit() -> "Limit":
    # Whole amperes only (operator inputs have no decimals): 1 or 2 A.
    return Limit(min=1, max=2, default=1)


class StageLimits(CamelModel):
    voltage: Limit
    time: Limit        # minutes
    stirring: Limit    # RPM
    # A: the power supply's current limit. The electrodes stop if the measured current goes above it.
    current: Limit = Field(default_factory=_current_limit)


def _esterification_limits() -> StageLimits:
    return StageLimits(voltage=Limit(min=10, max=30, default=20), time=Limit(min=30, max=180, default=120),
                       stirring=Limit(min=400, max=700, default=500), current=_current_limit())


def _transesterification_limits() -> StageLimits:
    return StageLimits(voltage=Limit(min=10, max=30, default=30), time=Limit(min=30, max=180, default=120),
                       stirring=Limit(min=400, max=700, default=500), current=_current_limit())


class Settings(CamelModel):
    # --- the website's Settings page (same keys as localStorage "greenova_settings") ---
    system_name: str = Field(default="Greenova Production System", max_length=150)
    operator: str = Field(default="Operator 01", max_length=100)
    units: str = Field(default="metric", max_length=20)
    batch_format: str = Field(default="B-{YEAR}-{SEQ}", alias="format", max_length=50)
    # Purification (dry wash with Magnesol) runs by itself: heat to 90 °C, methanol removal, the
    # operator adds the Magnesol, contact, settling, cooling if needed, drain. The 90 °C hold, the
    # 95 °C cutoff and the 200 RPM stirrer are fixed (purification.py); only these are settings:
    methanol_removal_time: float = 10         # minutes at 90 ±2 °C (5-30)
    contact_time: float = 15                  # minutes stirring the Magnesol, heater off
    settling_time: float = 10                 # minutes, stirrer off, so the Magnesol settles
    max_drain_temperature: float = 50         # °C: the outlet opens only at or below this (water filter limit)
    thermal_fuse_rating: Optional[float] = None
    purification_auto_start: bool = True      # start by itself after separation, once the level switch sees biodiesel
    # Dry wash adsorbent doses, in % of the oil weight (the website lets the operator pick one per batch).
    # Magnesol: 1% (Faccini et al.). Bentonite: 2% default; studies use 1% (10 min) up to 10 wt% (acid-activated).
    magnesol_dose: float = 1                  # % of oil weight
    bentonite_dose: float = 2                 # % of oil weight
    default_adsorbent: Adsorbent = "Magnesol"
    # After a drain, go straight on to the next stage: when the reactor outlet has closed after
    # transesterification, the Pi starts the separation by itself (the centrifuge outlet -> purification
    # step already ran by itself). Off = the operator presses Start on the website.
    auto_advance: bool = True
    # Esterification: the FFA strip reads only up to strip_max_ffa, so every batch above the
    # threshold gets one uniform dose, calculated as if the oil had esterification_design_ffa.
    esterification_design_ffa: float = 10     # %
    strip_max_ffa: float = 5                  # %, the strip's darkest color
    # Dosing pumps (A: NaOH/KOH + methanol, B: H2SO4 + methanol) and outlet valves
    pump_catalyst_rate: float = 100           # mL/min of pump A, for its time limit (and dosing without a load cell)
    pump_acid_rate: float = 100               # mL/min of pump B
    reactor_drain_time: float = 1             # minutes the reactor outlet stays open after transesterification
    centrifuge_drain_time: float = 2          # minutes the centrifuge outlet stays open after separation
    centrifuge_spin_down_time: float = 30     # seconds to wait for the centrifuge to stop when there's no RPM reading
    # With whole-number FFA, the first range 0-2% holds 0% and 1%: exactly the batches that skip esterification.
    ffa_range_boundaries: str = Field(default="0,2,4,5", max_length=100)
    proven_batch_count: int = 3
    proven_yield_tolerance: float = 2         # ± percentage points
    oil_price: float = 45                     # ₱/L
    methanol_price: float = 70                # ₱/L
    koh_price: float = 180                    # ₱/kg
    naoh_price: float = 160                   # ₱/kg
    sulfuric_acid_price: float = 120          # ₱/L
    acetone_price: float = 100                # ₱/L
    bentonite_price: float = 80               # ₱/kg
    magnesol_price: float = 250               # ₱/kg (placeholder: enter your supplier's price in Settings)
    electricity_price: float = 12             # ₱/kWh
    diesel_price: float = 55                  # ₱/L
    oil_molar_mass: float = 880               # g/mol; about 660 for coconut oil
    koh_purity: float = 90                    # %
    naoh_purity: float = 98                   # %

    # --- process constants (PROCESS_CONFIG in NewBatch.tsx); not on the Settings page yet ---
    oil_density: float = 0.92                 # g/mL
    biodiesel_density: float = 0.88           # g/mL
    oil_minimum_volume_ml: float = 100
    oil_maximum_volume_ml: float = 1000
    ffa_threshold: float = 1                  # esterification when FFA is above this (FFA <= 1%: straight to transesterification)
    ffa_target: float = 1                     # FFA to reach before transesterification
    catalyst_loading: float = 0.01            # fraction of oil weight
    acetone_fraction: float = 0.10            # fraction of oil volume
    bentonite_fraction: float = 0.02          # old records only (mesh bed); the dry wash uses bentonite_dose
    methanol_ratio: Limit = Field(default_factory=lambda: Limit(min=6, max=9, default=7))
    esterification: StageLimits = Field(default_factory=_esterification_limits)
    transesterification: StageLimits = Field(default_factory=_transesterification_limits)
    separation_time: float = 10               # minutes
    separation_speed: float = 2600            # RPM

    # --- safety and hardware (backend only) ---
    reaction_maximum_temperature: float = 60  # electrodes stop above this (methanol boils at 64.7 °C)
    stirrer_max_rpm: float = 900              # RPM at full PWM, for the open-loop speed setting
    centrifuge_max_rpm: float = 3000
    purification_stirrer_max_rpm: float = 600
    pump_no_flow_seconds: float = 20          # a pump stops with a fault when the load cell doesn't rise for this long
    heater_power_watts: float = 0             # set it to include heater energy in "energy"

    @field_validator("batch_format", mode="before")
    @classmethod
    def _blank_format_is_default(cls, value):
        """An empty batch naming format would give IDs like "-001": use the default instead."""
        return value if isinstance(value, str) and value.strip() else "B-{YEAR}-{SEQ}"

    @field_validator("ffa_range_boundaries", mode="before")
    @classmethod
    def _boundaries_to_text(cls, value):
        if isinstance(value, (list, tuple)):
            return ",".join(f"{float(v):g}" for v in value)
        return value

    @model_validator(mode="after")
    def _check(self):
        if len(self.boundaries()) < 2:
            raise ValueError("ffaRangeBoundaries needs at least two numbers, e.g. 0,2,4,6,8,10.")
        if not 5 <= self.methanol_removal_time <= 30:
            raise ValueError("methanolRemovalTime must be between 5 and 30 min.")
        if not 1 <= self.contact_time <= 60:
            raise ValueError("contactTime must be between 1 and 60 min.")
        if not 0 <= self.settling_time <= 60:
            raise ValueError("settlingTime must be between 0 and 60 min.")
        if not 30 <= self.max_drain_temperature <= 85:
            raise ValueError("maxDrainTemperature must be between 30 and 85 °C.")
        if not self.ffa_threshold < self.esterification_design_ffa <= 30:
            raise ValueError(f"esterificationDesignFfa must be above the {self.ffa_threshold:g}% threshold and at most 30%.")
        if not 0 < self.magnesol_dose <= 10 or not 0 < self.bentonite_dose <= 10:
            raise ValueError("magnesolDose and bentoniteDose must be between 1 and 10% of the oil weight.")
        if self.pump_catalyst_rate <= 0 or self.pump_acid_rate <= 0:
            raise ValueError("Pump rates must be more than 0 mL/min.")
        if self.reactor_drain_time < 0 or self.centrifuge_drain_time < 0 or self.centrifuge_spin_down_time < 0:
            raise ValueError("Drain times can't be negative.")
        return self

    def boundaries(self) -> list[float]:
        """Same parsing as the website: numbers only, sorted, without duplicates."""
        values = []
        for part in str(self.ffa_range_boundaries).split(","):
            try:
                values.append(float(part))
            except ValueError:
                continue
        return sorted(set(values))


# ---------- batches (same fields as DemoBatch, plus a few backend extras) ----------
class Materials(CamelModel):
    oil_l: float
    methanol_l: float
    catalyst_kg: float
    sulfuric_acid_l: float
    acetone_l: float
    bentonite_kg: float
    magnesol_kg: float = 0


class PurificationRecord(CamelModel):
    # Every field has a default: a save must never fail because a purification value is missing
    # (e.g. a run that stopped early, or a record from an older version).
    target_temperature: float = 90
    highest_temperature: Optional[float] = None
    heating_time_seconds: float = 0
    hold_time_seconds: float = 0               # methanol removal at 90 °C
    flow_time_seconds: float = 0               # old records (mesh bed flow)
    drain_time_seconds: float = 0
    contact_time_seconds: float = 0
    settling_time_seconds: float = 0
    cooling_time_seconds: float = 0
    magnesol_added: bool = False
    oil_weight_g: Optional[float] = None
    expected_biodiesel_ml: Optional[float] = None
    planned_flow_seconds: Optional[float] = None
    automatic: bool = False
    warning: Optional[str] = None
    safety_stop_occurred: bool = False
    safety_stop_reason: Optional[str] = None
    output_weight_g: Optional[float] = None
    stirring_speed: Optional[float] = None    # dry wash stirrer RPM during heating and hold
    magnesol_g: Optional[float] = None        # adsorbent amount (g); name kept for older records (was Magnesol only)
    adsorbent: Optional[Adsorbent] = None     # "Magnesol" or "Bentonite"
    adsorbent_g: Optional[float] = None       # oil mL × 0.92 × dose% (Magnesol 1%, bentonite 2%)
    heater_on_seconds: Optional[float] = None


class EsterificationStage(CamelModel):
    stage: int = Field(ge=1)
    ffa_before: float
    ffa_after: Optional[float] = None
    dose_ffa: Optional[float] = None           # FFA the dose was calculated for (the uniform design FFA in stage 1)
    methanol_ml: float
    sulfuric_acid_ml: float
    acetone_ml: float = 0


class TimelineEvent(CamelModel):
    label: str
    time: datetime


class Batch(CamelModel):
    id: str = Field(max_length=50)             # production_batches.batch_id is varchar(50)
    date: str                                  # YYYY-MM-DD
    oil_volume: float                          # mL
    yield_: float = Field(default=0, alias="yield")   # % by volume: biodieselOutputMl ÷ oilVolume
    duration: float = 0                        # minutes
    energy: float = 0                          # kWh
    status: BatchStatus = "Completed"
    lab_result: LabResult = "Pending"
    lab_reference: Optional[str] = Field(default=None, max_length=100)
    lab_tested_at: Optional[datetime] = None   # when the lab result was recorded (batch_lab_results.tested_at)
    ffa: float = 0
    ffa_above_strip: bool = False              # the strip showed its darkest color: FFA is at least ffa
    esterification_run: bool = False
    temperature: float = 0                     # average reaction temperature, °C
    reaction_time: float = 0                   # transesterification minutes
    stirring_speed: float = 0                  # transesterification RPM
    voltage: Optional[float] = None            # transesterification V
    current: Optional[float] = None            # transesterification current limit, A
    methanol_ratio: Optional[float] = None
    esterification_voltage: Optional[float] = None
    esterification_time: Optional[float] = None
    esterification_stirring: Optional[float] = None
    esterification_current: Optional[float] = None
    biodiesel_output_ml: Optional[float] = None
    catalyst_type: Optional[Catalyst] = None
    adsorbent: Optional[Adsorbent] = None       # dry wash adsorbent used in purification
    materials: Optional[Materials] = None
    purification: Optional[PurificationRecord] = None
    # backend extras (the website can ignore these)
    oil_mass_g: Optional[float] = None
    catalyst_to_weigh_g: Optional[float] = None
    esterification_stages: list[EsterificationStage] = Field(default_factory=list)
    timeline: list[TimelineEvent] = Field(default_factory=list)
    notes: Optional[str] = None
    created_at: Optional[datetime] = None

    @field_validator("date")
    @classmethod
    def _iso_date(cls, value):
        """The date goes into a MySQL DATE column: YYYY-MM-DD, e.g. 2026-10-13."""
        if value is not None:
            try:
                ok = bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", value)) and _date.fromisoformat(value)
            except ValueError:
                ok = False
            if not ok:
                raise ValueError("Use a date like 2026-10-13 (YYYY-MM-DD).")
        return value

    @model_validator(mode="after")
    def _failed_is_not_tested(self):
        if self.status in ("Failed", "Cancelled") and self.lab_result == "Pending":
            self.lab_result = "Not tested"
        return self


class BatchIn(Batch):
    """What the website sends when it saves a batch. The backend fills in the ID, date, the oil
    volume (from oilMassG when missing) and anything it measured itself."""
    id: Optional[str] = Field(default=None, max_length=50)
    date: Optional[str] = None
    oil_volume: Optional[float] = None


class BatchStartIn(CamelModel):
    """"Start batch" on the website's Process page. The ID is the one the page shows (from
    /api/batches/next-id); the backend takes the next free one if it's taken or missing."""
    id: Optional[str] = Field(default=None, max_length=50)


class ProgressIn(CamelModel):
    """Where the ongoing batch is on the Process page, so it can be continued later or on
    another device. state is the page's own data (stored as it is); batch holds the batch's
    setup so far (oil, FFA, parameters), in the same fields as a saved batch."""
    stage: str = Field(min_length=1, max_length=50)
    state: dict[str, Any] = Field(default_factory=dict)
    batch: Optional[dict[str, Any]] = None


class LabResultIn(CamelModel):
    lab_result: Literal["Passed", "Failed"]
    lab_reference: Optional[str] = Field(default=None, max_length=100)   # batch_lab_results.lab_reference
    # When the operator recorded it (the website sends its clock); missing = the Pi's time now.
    tested_at: Optional[datetime] = None


# ---------- requests ----------
class CalculateRequest(CamelModel):
    oil_mass_g: float = Field(gt=0)
    ffa: WholeNumber = Field(ge=0, le=100)          # whole percent from the test strip
    methanol_ratio: Optional[float] = None
    catalyst: Catalyst = "NaOH"
    adsorbent: Optional[Adsorbent] = None


class AfterEsterificationRequest(CamelModel):
    oil_mass_g: float = Field(gt=0)
    ffa_after: WholeNumber = Field(ge=0, le=100)
    stage_done: int = Field(default=1, ge=1)
    methanol_ratio: Optional[float] = None
    catalyst: Catalyst = "NaOH"


class StageStart(CamelModel):
    stage: StageName
    batch_id: Optional[str] = None
    # operator settings: whole numbers only
    voltage: Optional[WholeNumber] = None
    time: Optional[WholeNumber] = None       # minutes
    stirring: Optional[WholeNumber] = None   # RPM
    current: Optional[WholeNumber] = None    # A, the power supply's current limit
    oil_mass_g: Optional[float] = None  # measured oil; sets the adsorbent amount and the low-output check
    adsorbent: Optional[Adsorbent] = None   # the batch's dry wash adsorbent (used when purification starts by itself)


class PurificationStart(CamelModel):
    heater_submerged: bool = False   # operator confirmation; only needed when there's no level switch
    batch_id: Optional[str] = None
    oil_volume_ml: Optional[float] = None   # sets the adsorbent amount; else the batch's measured oil
    adsorbent: Optional[Adsorbent] = None   # else the one sent with the batch's stages, else defaultAdsorbent


class DemoOilIn(CamelModel):
    volume_ml: float = Field(gt=0, le=2000)


class DemoAddIn(CamelModel):
    """Demo mode: put something on a simulated load cell (e.g. acetone poured into the reactor)."""
    place: Literal["reactor", "purificationTank"] = "reactor"
    grams: float = Field(gt=0, le=3000)


class PumpStart(CamelModel):
    """Load one dose with a dosing pump. The pump stops when the reactor load cell has risen by
    target_g (or, without a load cell, after volume_ml at the pump's rate)."""
    pump: Literal["catalyst", "acid"]
    target_g: float = Field(gt=0, le=2500)
    volume_ml: float = Field(gt=0, le=3000)
    batch_id: Optional[str] = None
    stage: Optional[str] = None


class DrainStart(CamelModel):
    """Open an outlet valve again for its drain time (when something is left behind)."""
    valve: Literal["reactor_outlet", "centrifuge_outlet"]
    batch_id: Optional[str] = None


class PumpIn(CamelModel):
    name: Literal["catalyst", "acid"]
    on: bool


class SwitchIn(CamelModel):
    on: bool


class ValveIn(CamelModel):
    name: str
    open: bool


class MotorIn(CamelModel):
    name: str
    duty: float = Field(ge=0, le=1)
