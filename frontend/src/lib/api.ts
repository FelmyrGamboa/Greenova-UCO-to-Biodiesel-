/**
 * Greenova backend client (FastAPI on the Raspberry Pi).
 *
 * The batch functions have the same names as src/lib/greenovaData.ts, but return Promises.
 * When the backend can't be reached, they fall back to the browser's local demo data, so the
 * website still works without the Pi.
 *
 * Leave VITE_API_URL unset in the usual setups: in development, vite.config.ts forwards /api to
 * the backend on localhost:8000, and on the Pi the backend serves the website itself. Set it
 * only to call a backend somewhere else, for example http://192.168.1.50:8000.
 */
import { useEffect, useRef, useState } from "react";
import * as local from "./greenovaData";
import type { DemoBatch } from "./greenovaData";

export const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");

// ---------- types (same field names as the backend's JSON) ----------
export type Catalyst = "NaOH" | "KOH";
/** Dry wash adsorbent for purification, chosen per batch. */
export type Adsorbent = "Magnesol" | "Bentonite";
export type StageName = "Esterification" | "Transesterification" | "Separation";
export type StageState = "ready" | "running" | "paused" | "complete" | "fault";
/** Dry wash with Magnesol or bentonite: heating → methanol removal → add the adsorbent (operator;
 * the phase is still called "magnesol") → contact → settling → cooling (only if needed) → drain → complete. */
export type PurificationPhase =
  | "ready" | "heating" | "methanol" | "magnesol" | "contact" | "settling" | "cooling" | "drain" | "complete" | "fault";
export type TileState = "ready" | "checking" | "fault";
/** Pump A ("catalyst") = NaOH/KOH dissolved in methanol. Pump B ("acid") = H₂SO₄ in methanol. */
export type PumpName = "catalyst" | "acid";
export type PumpPhase = "idle" | "pumping" | "done" | "fault" | "stopped";
/** Outlet valves that open by themselves: after transesterification and after separation. */
export type DrainValve = "reactor_outlet" | "centrifuge_outlet";
export type DrainPhase = "idle" | "waiting" | "draining" | "done" | "stopped" | "fault";

export type BatchRecord = DemoBatch & {
  oilMassG?: number | null;
  catalystToWeighG?: number | null;
  esterificationStages?: Array<{
    stage: number;
    ffaBefore: number;
    ffaAfter?: number | null;
    /** FFA the dose was calculated for (the uniform design FFA in stage 1). */
    doseFfa?: number | null;
    methanolMl: number;
    sulfuricAcidMl: number;
    acetoneMl: number;
  }>;
  timeline?: Array<{ label: string; time: string }>;
  notes?: string | null;
  createdAt?: string | null;
  /** While the batch is in progress: the Process page stage it is at ("Transesterification"). */
  currentStage?: string | null;
};

/** Where the ongoing batch is on the Process page. state is the page's own data, for continuing. */
export type BatchProgress = { stage: string; state: Record<string, unknown> | null; updatedAt: string | null };

/** The batch in progress. Only one batch can be processed at a time. */
export type ActiveBatch = BatchRecord & { progress: BatchProgress | null };

export type RecommendedParameters = NonNullable<ReturnType<typeof local.getRecommendedParametersForFfa>>;

/** Same keys as calculateQuantityCards() in NewBatch.tsx, plus a few extras. */
export type QuantityCards = {
  oilMassG: number;
  oilVolumeMl: number;
  ffa: number;
  methanolRatio: number;
  catalyst: Catalyst;
  ffaMassG: number;
  /** FFA the esterification dose is calculated for: the design FFA (default 10%). */
  doseFfa: number;
  uniformDose: boolean;
  esterificationNeeded: boolean;
  esterificationMethanolMl: number;
  sulfuricAcidMl: number;
  sulfuricAcidG: number;
  acetoneMl: number;
  acetoneG: number;
  /** Pump B premix (methanol + H₂SO₄): its volume and what the reactor load cell should gain. */
  esterificationPremixMl: number;
  esterificationPremixG: number;
  transesterificationMethanolMl: number;
  catalystBaseG: number;
  neutralizationG: number;
  catalystToWeighG: number;
  purity: number;
  transesterificationAcetoneMl: number;
  /** Pump A premix (methanol + NaOH/KOH). */
  transesterificationPremixMl: number;
  transesterificationPremixG: number;
  /** Magnesol for the dry wash: oil mL × 0.0092 g (1% of the oil weight). */
  magnesolG: number;
  /** Bentonite for the dry wash: oil mL × 0.0184 g (2% of the oil weight). */
  bentoniteG: number;
  adsorbent: Adsorbent;
  adsorbentG: number;
  adsorbentDosePct: number;
  isEstimate: boolean;
  warnings: string[];
};

export type AfterEsterification =
  | { action: "anotherStage"; stage: number; doseFfa: number; uniformDose: boolean; ffaMassG: number;
      esterificationMethanolMl: number; sulfuricAcidMl: number; sulfuricAcidG: number; acetoneMl: number;
      acetoneG: number; esterificationPremixMl: number; esterificationPremixG: number }
  | { action: "transesterification"; ffa: number; isEstimate: false; transesterificationMethanolMl: number;
      catalystBaseG: number; neutralizationG: number; catalystToWeighG: number; purity: number; acetoneMl: number;
      acetoneG: number; transesterificationPremixMl: number; transesterificationPremixG: number };

export type Sensors = {
  /** Reactor load cell: the oil, then everything poured or pumped in. */
  oilMassG: number | null;
  /** Output load cell under the biodiesel container (the yield). */
  outputWeightG: number | null;
  temperature: number | null;
  voltage: number | null;
  current: number | null;
  stirrerRpm: number | null;
  centrifugeRpm: number | null;
  /** Dry wash stirrer in the purification tank. */
  purificationStirrerRpm: number | null;
  /** Level switch at the heater: true = biodiesel covers it, null = no switch installed. */
  heaterSubmerged: boolean | null;
  heaterOn: boolean;
  electrodePowerOn: boolean;
  /** Purification outlet valve (through the filter to the biodiesel container). */
  meshBedValveOpen: boolean;
  reactorValveOpen: boolean;
  centrifugeValveOpen: boolean;
  valves: Record<string, boolean>;
  motorDuty: Record<string, number>;
  pumps: Record<PumpName, boolean>;
  timestamp: number;
};

/** A dose being loaded by pump A or B. It stops when the reactor load cell has gained targetG. */
export type PumpStatus = {
  pump: PumpName | null;
  phase: PumpPhase;
  batchId: string | null;
  stage: string | null;
  targetG: number;
  volumeMl: number;
  deliveredG: number;
  startWeightG: number | null;
  /** No load cell reading: dosed by time at the pump's rate. */
  byTime: boolean;
  elapsedSeconds: number;
  maxSeconds: number;
  faultReason: string | null;
  /** When this run started: tells it apart from the previous run. */
  startedAt: string | null;
};

/** An outlet valve open for its drain time. "waiting" = waiting for the centrifuge to stop. */
export type DrainStatus = {
  valve: DrainValve | null;
  phase: DrainPhase;
  batchId: string | null;
  elapsedSeconds: number;
  totalSeconds: number;
  remainingSeconds: number;
  waitingFor: string | null;
  waitedSeconds: number;
  faultReason: string | null;
  startedAt: string | null;
};

export type StageStatus = {
  stage: StageName | null;
  state: StageState;
  batchId: string | null;
  voltage: number | null;
  timeMinutes: number | null;
  stirringRpm: number | null;
  speedRpm: number | null;
  /** The current setting (A); the electrodes stop if the measured current goes above it. */
  current: number | null;
  /** True when the Pi set the power supply's current limit itself. */
  currentLimitSet: boolean;
  elapsedSeconds: number;
  remainingSeconds: number;
  liveVoltage: number | null;
  liveCurrent: number | null;
  liveTemperature: number | null;
  liveRpm: number | null;
  averageTemperature: number | null;
  energyKwh: number;
  faultReason: string | null;
};

/** Automatic purification (dry wash with Magnesol). The step timer is stepRemainingSeconds. */
export type PurificationStatus = {
  phase: PurificationPhase;
  batchId: string | null;
  /** Started by itself after separation (level switch), rather than by hand. */
  automatic: boolean;
  /** Fixed: hold at 90 °C (±2), heater stops above 95 °C. */
  targetTemperature: number;
  maximumTemperature: number;
  liveTemperature: number | null;
  startingTemperature: number | null;
  highestTemperature: number | null;
  heatingTimeSeconds: number;
  heatingTimeoutSeconds: number;
  methanolTotalSeconds: number;
  methanolRemainingSeconds: number;
  /** Adsorbent to add (g): Magnesol oil mL × 0.0092, bentonite oil mL × 0.0184. */
  magnesolG: number | null;
  adsorbent?: Adsorbent;
  adsorbentG?: number | null;
  magnesolAdded: boolean;
  magnesolWaitSeconds: number;
  contactTotalSeconds: number;
  contactRemainingSeconds: number;
  settlingTotalSeconds: number;
  settlingRemainingSeconds: number;
  coolingSeconds: number;
  maxDrainTemperature: number | null;
  drainElapsedSeconds: number;
  drainMaximumSeconds: number;
  /** Seconds the output weight has stayed within ±2 g. */
  stableSeconds: number;
  /** Biodiesel collected in this run (output load cell). */
  outputWeightG: number | null;
  oilWeightG: number | null;
  /** The current step's timer (null for steps without one, e.g. heating). */
  stepRemainingSeconds: number | null;
  stepTotalSeconds: number | null;
  heaterOn: boolean;
  valveOpen: boolean;
  heaterOnSeconds: number;
  /** Dry wash stirrer: target 200 RPM (fixed). */
  stirrerOn: boolean;
  stirrerRpm: number | null;
  stirringSpeed: number;
  /** "Low output – check the filter" when less than 70% of the oil weight came out. */
  warning: string | null;
  safetyStopReason: string | null;
  safetyStopOccurred: boolean;
  record: Record<string, unknown> | null;
};

export type LiveData = {
  mock: boolean;
  timestamp: string;
  sensors: Sensors;
  alarm: string | null;
  stage: StageStatus;
  purification: PurificationStatus;
  pump: PumpStatus;
  drain: DrainStatus;
  /** Batch ID waiting for purification to start by itself (after separation), or null. */
  purificationAutoStart: string | null;
};

export type SystemStatus = {
  mode: "demonstration" | "live";
  ready: boolean;
  readiness: number;
  tiles: Array<{ label: string; value: string; secondary: string; state: TileState }>;
  devices: Array<{ label: string; status: string }>;
};

type Limit = { min: number; max: number; default: number };
type StageLimits = { voltage: Limit; time: Limit; stirring: Limit; current: Limit };

/** Same structure as PROCESS_CONFIG in NewBatch.tsx. */
export type ProcessConfig = {
  oil: { minimumVolumeMl: number; maximumVolumeMl: number; densityGPerMl: number; averageTriglycerideMolecularWeight: number };
  /** FFA at or below this (1%) goes straight to transesterification. */
  ffaThreshold: number;
  ffaTarget: number;
  /** Operator inputs are whole numbers only. */
  wholeNumberInputs?: boolean;
  /** After a drain the next stage starts by itself (the Pi starts the separation). */
  autoAdvance?: boolean;
  methanol: { ratioDefault: number; ratioMin: number; ratioMax: number; molecularWeight: number; densityGPerMl: number; convention: string };
  catalyst: { loadingDefault: number; kohPurity: number; naohPurity: number };
  acetone: { volumeFractionDefault: number; provisional: boolean };
  esterification: StageLimits & { sulfuricAcidMlPerGramFfa: number; designFfa: number; stripMaxFfa: number };
  transesterification: StageLimits;
  separation: { timeMinutes: number; speedRpm: number };
  purification: { holdTemperature: number; holdBand: number; maximumTemperature: number; heatingTimeoutMinutes: number;
    methanolRemovalMinutes: number; contactMinutes: number; settlingMinutes: number; maxDrainTemperature: number;
    stirringSpeedRpm: number; drainStableGrams: number; drainStableSeconds: number; drainMaximumMinutes: number;
    lowOutputFraction: number; magnesolGramsPerMlOil: number; bentoniteGramsPerMlOil?: number; adsorbents?: Adsorbent[];
    defaultAdsorbent?: Adsorbent; magnesolDosePct?: number; bentoniteDosePct?: number; thermalFuseRating: number | null; automatic: boolean };
  /** currentControl: the Pi sets the power supply's current limit (otherwise the operator does). */
  powerSupply: { currentControl: boolean };
  pumps: { catalystRateMlPerMinute: number; acidRateMlPerMinute: number; noFlowSeconds: number };
  drains: { reactorMinutes: number; centrifugeMinutes: number; centrifugeSpinDownSeconds: number };
  reactionMaximumTemperature: number;
};

/** The Settings page keys (same as localStorage "greenova_settings") plus backend-only values. */
export type Settings = Record<string, unknown> & {
  systemName: string;
  operator: string;
  units: string;
  format: string;
  /** Purification: the only editable values (the 90 °C hold and 200 RPM are fixed). */
  methanolRemovalTime: number;
  contactTime: number;
  settlingTime: number;
  maxDrainTemperature: number;
  thermalFuseRating: number | null;
  esterificationDesignFfa: number;
  stripMaxFfa: number;
  pumpCatalystRate: number;
  pumpAcidRate: number;
  reactorDrainTime: number;
  centrifugeDrainTime: number;
  centrifugeSpinDownTime: number;
  ffaRangeBoundaries: string;
  provenBatchCount: number;
  provenYieldTolerance: number;
  oilPrice: number;
  methanolPrice: number;
  kohPrice: number;
  naohPrice: number;
  sulfuricAcidPrice: number;
  acetonePrice: number;
  bentonitePrice: number;
  magnesolPrice: number;
  /** Dry wash doses, % of the oil weight (Magnesol 1, bentonite 2). */
  magnesolDose: number;
  bentoniteDose: number;
  defaultAdsorbent: Adsorbent;
  /** After a drain, the next stage starts by itself. */
  autoAdvance: boolean;
  electricityPrice: number;
  dieselPrice: number;
  oilMolarMass: number;
  kohPurity: number;
  naohPurity: number;
};

export type RangeRow = {
  range: { key: string; label: string; min: number; max: number | null };
  testedBatches: number;
  passedBatches: number;
  labPassRate: number | null;
  recommendedBatchId: string | null;
  recommendedParameters: RecommendedParameters | null;
  esterificationRun: boolean | null;
  averageYield: number | null;
  minimumYield: number | null;
  maximumYield: number | null;
  status: "No data" | "Testing" | "Proven";
};

export type AnalyticsSummary = {
  totalBatches: number;
  completed: number;
  completionRate: number;
  tested: number;
  passed: number;
  labPassRate: number | null;
  averageYield: number;
};

export type CostReport = {
  batches: Array<{ id: string; costPerLiter: number }>;
  averageCost: number | null;
  dieselPrice: number;
  targetCost: number;
  tone: "neutral" | "green" | "yellow" | "red";
};

// ---------- requests ----------
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** True when the error means the backend couldn't be reached at all. */
export function isOffline(error: unknown): boolean {
  return error instanceof ApiError && error.status === 0;
}

async function request<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  let response: Response;
  const controller = new AbortController();
  const timer = init?.timeoutMs ? window.setTimeout(() => controller.abort(), init.timeoutMs) : undefined;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, "Backend offline");
  } finally {
    window.clearTimeout(timer);
  }
  // Not the backend answering: the Vite proxy couldn't reach it, or a static host (like the
  // Figma Make preview) returned its own page instead of JSON.
  const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
  if (!isJson || response.headers.get("x-greenova-offline") || response.status === 502 || response.status === 504) {
    throw new ApiError(0, "Backend offline");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body && typeof body === "object" && "detail" in body ? (body as { detail: unknown }).detail : null;
    // FastAPI sends a list of problems when a request doesn't pass validation (422). Name the field
    // in each one ("purification → heatingTimeSeconds: Field required"), not just "Field required".
    const describe = (item: unknown) => {
      if (!item || typeof item !== "object" || !("msg" in item)) return String(item);
      const { msg, loc } = item as { msg: unknown; loc?: unknown };
      const field = Array.isArray(loc) ? loc.filter((part) => part !== "body" && part !== "query").join(" → ") : "";
      return field ? `${field}: ${String(msg)}` : String(msg);
    };
    const message = typeof detail === "string"
      ? detail
      : Array.isArray(detail)
        ? detail.map(describe).join("; ")
        : "";
    throw new ApiError(response.status, message || response.statusText || "Request failed");
  }
  return body as T;
}

function get<T>(path: string): Promise<T> {
  return request<T>(path);
}

function send<T>(method: "POST" | "PUT" | "PATCH", path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function withLocalFallback<T>(remote: () => Promise<T>, fallback: () => T): Promise<T> {
  try {
    return await remote();
  } catch (error) {
    if (isOffline(error)) return fallback();
    throw error;
  }
}

// ---------- same functions as greenovaData.ts ----------
/** This browser's batches, with the Process page stage of the one in progress. */
function localBatches(): BatchRecord[] {
  const progress = local.getLocalProgress();
  return local.getBatches().map((batch) =>
    batch.status === "In Progress" ? { ...batch, currentStage: progress?.id === batch.id ? progress.stage : null } : batch,
  );
}

export function getBatches(): Promise<BatchRecord[]> {
  return withLocalFallback(() => get<BatchRecord[]>("/api/batches"), localBatches);
}

export function getBatch(id: string): Promise<BatchRecord | undefined> {
  return withLocalFallback(
    () => get<BatchRecord>(`/api/batches/${encodeURIComponent(id)}`),
    () => local.getBatches().find((batch) => batch.id === id),
  );
}

/** Saves a finished batch. The backend fills in what the Pi measured (temperature, energy,
 * purification, output weight and yield) for the same batch ID. */
export function saveCompletedBatch(batch: Partial<DemoBatch>): Promise<BatchRecord> {
  return withLocalFallback(
    () => send<BatchRecord>("POST", "/api/batches", batch),
    () => {
      local.saveCompletedBatch(batch as DemoBatch);
      return batch as BatchRecord;
    },
  );
}

/** Records or changes the batch's lab result (its one lab result row is updated). testedAt is
 * when the operator recorded it: this device's clock, sent along so the time is never missing. */
export function updateBatchLabResult(id: string, labResult: "Passed" | "Failed", labReference?: string): Promise<BatchRecord | undefined> {
  const testedAt = new Date().toISOString();
  return withLocalFallback(
    () => send<BatchRecord>("POST", `/api/batches/${encodeURIComponent(id)}/lab-result`, { labResult, labReference, testedAt }),
    () => local.updateBatchLabResult(id, labResult, labReference, testedAt),
  );
}

export function getRecommendedParametersForFfa(ffa: number): Promise<RecommendedParameters | null> {
  return withLocalFallback(
    () => get<RecommendedParameters | null>(`/api/analytics/recommended?ffa=${encodeURIComponent(ffa)}`),
    () => local.getRecommendedParametersForFfa(ffa),
  );
}

function localBatchId(): string {
  return `B-${new Date().getFullYear()}-${String(Date.now()).slice(-3)}`;
}

export function getNextBatchId(): Promise<string> {
  return withLocalFallback(async () => (await get<{ id: string }>("/api/batches/next-id")).id, localBatchId);
}

// ---------- the batch in progress (only one at a time) ----------
/** Batch fields the Process page saves while the batch runs (its setup so far, not its results). */
const PROGRESS_FIELDS = [
  "oilVolume", "oilMassG", "ffa", "ffaAboveStrip", "esterificationRun", "esterificationVoltage", "esterificationTime",
  "esterificationStirring", "esterificationCurrent", "reactionTime", "stirringSpeed", "voltage", "current",
  "methanolRatio", "catalystType", "adsorbent", "catalystToWeighG",
] as const;

function activeMessage(id: string) {
  return `Batch ${id} is still in progress. Only one batch can be processed at a time: continue it, or cancel it, before starting a new one.`;
}

function localActiveBatch(): ActiveBatch | null {
  const batch = localBatches().find((item) => item.status === "In Progress");
  if (!batch) return null;
  const progress = local.getLocalProgress();
  const own = progress?.id === batch.id ? progress : null;
  return { ...batch, progress: own ? { stage: own.stage, state: own.state, updatedAt: own.updatedAt } : null };
}

/** The batch in progress, with where the Process page is, or null when no batch is running. */
export function getActiveBatch(): Promise<ActiveBatch | null> {
  return withLocalFallback(() => get<ActiveBatch | null>("/api/batches/active"), localActiveBatch);
}

/** "Start batch": records the batch as In Progress (shown in Batch History at once). Fails with
 * 409 while another batch is in progress: only one batch can be processed at a time. */
export function startBatch(id?: string): Promise<ActiveBatch> {
  return withLocalFallback(
    () => send<ActiveBatch>("POST", "/api/batches/start", { id }),
    () => {
      const active = localActiveBatch();
      if (active && active.id === id) return active;
      if (active) throw new ApiError(409, activeMessage(active.id));
      const taken = new Set(local.getBatches().map((batch) => batch.id));
      let batchId = id && !taken.has(id) ? id : localBatchId();
      while (taken.has(batchId)) batchId = `${batchId}-1`;
      return { ...local.startLocalBatch(batchId), currentStage: null, progress: null };
    },
  );
}

/** Saves where the ongoing batch is (stage + the page's state) and its setup so far, so it can be
 * continued later, from the Dashboard or on another device. */
/** Offline: the batch in progress in this browser, or (when it is the Pi's batch) the offline
 * error again, so the page tries later instead of losing the batch. */
function localOngoing(id: string, offline: unknown) {
  const current = local.getBatches().find((item) => item.id === id && item.status === "In Progress");
  if (!current) throw offline;
  return current;
}

export async function saveBatchProgress(id: string, stage: string, state: Record<string, unknown>, batch?: Partial<DemoBatch>): Promise<void> {
  try {
    await send("PUT", `/api/batches/${encodeURIComponent(id)}/progress`, { stage, state, batch });
  } catch (error) {
    if (!isOffline(error)) throw error;
    localOngoing(id, error);
    const setup = Object.fromEntries(PROGRESS_FIELDS.filter((key) => batch?.[key] !== undefined).map((key) => [key, batch?.[key]]));
    local.updateLocalBatch(id, setup as Partial<DemoBatch>);
    local.setLocalProgress({ id, stage, state, updatedAt: new Date().toISOString() });
  }
}

/** Cancels the batch in progress (it stays in Batch History as Cancelled). */
export async function cancelBatch(id: string): Promise<BatchRecord> {
  try {
    return await send<BatchRecord>("POST", `/api/batches/${encodeURIComponent(id)}/cancel`);
  } catch (error) {
    if (!isOffline(error)) throw error;
    localOngoing(id, error);
    local.setLocalProgress(null);
    return local.updateLocalBatch(id, { status: "Cancelled", labResult: "Not tested" }) as BatchRecord;
  }
}

/** Marks the ongoing batch Completed on the backend without its full record (used when the Pi
 * refused the record and the operator kept it in this browser), so it doesn't stay "In Progress". */
export function markBatchCompleted(id: string): Promise<BatchRecord> {
  return send<BatchRecord>("PATCH", `/api/batches/${encodeURIComponent(id)}`, { status: "Completed" });
}

/** The batch in progress for a page, checked again every few seconds (another device may start,
 * finish or cancel it). */
export function useActiveBatch(refreshMs = 4000): { active: ActiveBatch | null; loaded: boolean } {
  const [active, setActive] = useState<ActiveBatch | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let stopped = false;
    const load = () =>
      getActiveBatch()
        .then((found) => {
          if (!stopped) setActive(found);
        })
        .catch(() => undefined)
        .finally(() => {
          if (!stopped) setLoaded(true);
        });
    load();
    const timer = window.setInterval(load, refreshMs);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [refreshMs]);

  return { active, loaded };
}

/** Batches for a page: shows the local data at once, then the backend's when it answers. */
export function useBatches(): { batches: BatchRecord[]; source: "backend" | "local"; reload: () => void } {
  const [batches, setBatches] = useState<BatchRecord[]>(localBatches);
  const [source, setSource] = useState<"backend" | "local">("local");
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    get<BatchRecord[]>("/api/batches")
      .then((rows) => {
        if (cancelled) return;
        setBatches(rows);
        setSource("backend");
      })
      .catch(() => {
        if (cancelled) return;
        setBatches(localBatches());
        setSource("local");
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  return { batches, source, reload: () => setVersion((value) => value + 1) };
}

// ---------- settings and configuration ----------
const SETTINGS_KEY = "greenova_settings";

function readLocalSettings(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeLocalSettings(settings: Record<string, unknown>): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...readLocalSettings(), ...settings }));
  } catch {
    // storage unavailable: the backend still has the settings
  }
}

/** Copies the backend's settings into localStorage, where the pages read them. Call it once at
 * startup; it gives up quickly when the backend can't be reached. */
export async function syncSettingsFromBackend(): Promise<void> {
  try {
    writeLocalSettings(await request<Settings>("/api/settings", { timeoutMs: 1500 }));
  } catch {
    // offline: keep the local settings
  }
}

export function getSettings(): Promise<Settings> {
  return withLocalFallback(
    () => get<Settings>("/api/settings"),
    () => readLocalSettings() as Settings,
  );
}

/** Saves some or all settings to the backend (which keeps the keys you leave out) and to
 * localStorage, so the pages see them right away. */
export function saveSettings(changes: Partial<Settings>): Promise<Settings> {
  return withLocalFallback(
    async () => {
      const saved = await send<Settings>("PUT", "/api/settings", changes);
      writeLocalSettings(saved);
      return saved;
    },
    () => {
      writeLocalSettings(changes);
      return readLocalSettings() as Settings;
    },
  );
}

export const getProcessConfig = () => get<ProcessConfig>("/api/config");
export const getSystemStatus = () => get<SystemStatus>("/api/system/status");
/** This computer's addresses on the local network, for "Open on phone". */
export const getNetworkAddresses = async () => (await get<{ addresses: string[] }>("/api/network")).addresses;
export const getLive = () => get<LiveData>("/api/live");
export const clearAlarm = () => send<{ alarm: null }>("POST", "/api/alarm/clear");

// ---------- calculator and FFA strip ----------
export const calculateQuantities = (input: { oilMassG: number; ffa: number; methanolRatio?: number; catalyst: Catalyst; adsorbent?: Adsorbent }) =>
  send<QuantityCards>("POST", "/api/calculate", input);

export const calculateAfterEsterification = (input: { oilMassG: number; ffaAfter: number; stageDone: number; methanolRatio?: number; catalyst: Catalyst }) =>
  send<AfterEsterification>("POST", "/api/calculate/after-esterification", input);

export const readFfaStrip = () => send<{ ffa: number; warnings: string[] }>("POST", "/api/strip/read");

/** "Load demonstration sensor reading" (demo mode only). */
export const loadDemoOil = (volumeMl: number) => send<Sensors>("POST", "/api/demo/load-oil", { volumeMl });

/** Demo mode: something poured by hand lands on a simulated load cell (e.g. acetone). */
export const demoAdd = (grams: number, place: "reactor" | "purificationTank" = "reactor") =>
  send<Sensors>("POST", "/api/demo/add", { place, grams });

// ---------- dosing pumps and outlet valves ----------
/** "Load": the pump adds one premixed dose and stops when the reactor has gained targetG. */
export const startPump = (input: { pump: PumpName; targetG: number; volumeMl: number; batchId?: string; stage?: string }) =>
  send<PumpStatus>("POST", "/api/process/pump/start", input);

export const pumpAction = (action: "stop" | "skip") => send<PumpStatus>("POST", `/api/process/pump/${action}`);

/** Opens an outlet again for its drain time (it opens by itself after transesterification and separation). */
export const startDrain = (valve: DrainValve, batchId?: string) =>
  send<DrainStatus>("POST", "/api/process/drain/start", { valve, batchId });

export const drainAction = (action: "stop" | "skip") => send<DrainStatus>("POST", `/api/process/drain/${action}`);

// ---------- process stages ----------
export const startStage = (input: { stage: StageName; batchId?: string; voltage?: number; time?: number; stirring?: number; current?: number; oilMassG?: number; adsorbent?: Adsorbent }) =>
  send<StageStatus>("POST", "/api/process/stage/start", input);

export const stageAction = (action: "pause" | "resume" | "complete" | "emergency-stop" | "reset") =>
  send<StageStatus>("POST", `/api/process/stage/${action}`);

/** Purification normally starts by itself after separation. Use this only when there's no level
 * switch (heaterSubmerged = the operator's confirmation) or to start again after a stop. */
export const startPurification = (input: { heaterSubmerged?: boolean; batchId?: string; oilVolumeMl?: number; adsorbent?: Adsorbent }) =>
  send<PurificationStatus>("POST", "/api/process/purification/start", input);

/** "magnesol-added" = the operator's Confirm after adding the adsorbent (Magnesol or bentonite). */
export const purificationAction = (action: "skip" | "abort" | "acknowledge" | "magnesol-added") =>
  send<PurificationStatus>("POST", `/api/process/purification/${action}`);

/** Emergency stop for everything: stage, pumps, purification, heater, valves and motors. */
export const emergencyStop = () => send<LiveData>("POST", "/api/control/all-off");

// ---------- analytics ----------
export const getAnalyticsSummary = () => get<AnalyticsSummary>("/api/analytics/summary");
export const getRangeRows = () => get<RangeRow[]>("/api/analytics/ranges");
export const getCostReport = () => get<CostReport>("/api/analytics/cost");

// ---------- live readings ----------
function liveSocketUrl(): string {
  if (API_BASE) return `${API_BASE.replace(/^http/, "ws")}/api/ws/live`;
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}/api/ws/live`;
}

/** Live sensors, alarm, stage and purification state, updated every second.
 * `connected` is false while the backend can't be reached; it retries every 3 seconds. */
export function useLive(): { live: LiveData | null; connected: boolean; checked: boolean } {
  const [live, setLive] = useState<LiveData | null>(null);
  const [connected, setConnected] = useState(false);
  // False until the first connection attempt has succeeded or failed.
  const [checked, setChecked] = useState(false);
  const retry = useRef<number | undefined>(undefined);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let stopped = false;
    const connect = () => {
      socket = new WebSocket(liveSocketUrl());
      // "stopped" guards against a closed socket from an earlier render (React StrictMode
      // mounts twice) reporting "disconnected" after the new socket has connected.
      socket.onopen = () => {
        if (!stopped) setConnected(true);
      };
      socket.onmessage = (event) => {
        if (stopped) return;
        try {
          setLive(JSON.parse(event.data) as LiveData);
          setChecked(true);
        } catch {
          // ignore a malformed message
        }
      };
      socket.onclose = () => {
        if (stopped) return;
        setConnected(false);
        setChecked(true);
        retry.current = window.setTimeout(connect, 3000);
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(retry.current);
      socket?.close();
    };
  }, []);

  return { live, connected, checked };
}
