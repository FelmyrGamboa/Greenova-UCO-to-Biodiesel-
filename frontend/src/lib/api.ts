/**
 * Greenova backend client (FastAPI on the Raspberry Pi that drives the machine).
 *
 * Everything comes from the Raspberry Pi: the batches, the settings and the machine. There is no
 * demo or offline mode: when the Pi can't be reached, the calls fail with an "offline" ApiError
 * (isOffline) and the pages say so.
 *
 * Leave VITE_API_URL unset in the usual setups: in development, vite.config.ts forwards /api to
 * the backend on localhost:8000, and on the Pi the backend serves the website itself. Set it
 * only to call a backend somewhere else, for example http://192.168.1.50:8000.
 */
import { useEffect, useRef, useState } from "react";
import type { BatchData } from "./greenovaData";

export const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");

// ---------- types (same field names as the backend's JSON) ----------
export type Catalyst = "NaOH" | "KOH";
/** Dry wash adsorbent for purification, chosen per batch. */
export type Adsorbent = "Magnesol" | "Bentonite";
export type StageName = "Esterification" | "Transesterification" | "Separation";
export type StageState = "ready" | "running" | "paused" | "complete" | "fault";
/** Dry wash with Magnesol or bentonite: methanol removal straight away (stirrer on, heater in 4 s
 * pulses: the next pulse when the temperature is getting lower again, none at or above 90 °C) → add
 * the adsorbent (operator; the phase is still called "magnesol") → contact (stirred at 200 RPM,
 * heater off) → settle (1 min, stirrer off) → drain (valve + pumpout, until the output load cell is
 * stable for 30 s) → complete. ("heating" is no longer used.) */
export type PurificationPhase =
  | "ready" | "heating" | "methanol" | "magnesol" | "contact" | "settle" | "drain" | "complete" | "fault";
export type TileState = "ready" | "checking" | "fault";
/** Pump A ("catalyst", dispenser 1) = NaOH/KOH dissolved in methanol. Pump B ("acid", dispenser 2) =
 * H₂SO₄ in methanol. "oil" = the oil pump. Each runs until the operator presses Done. */
export type PumpName = "catalyst" | "acid" | "oil";
/** "done" = the operator pressed Done (everything pumped in); "stopped" = Stop (start it again). */
export type PumpPhase = "idle" | "pumping" | "done" | "fault" | "stopped";

export type BatchRecord = BatchData & {
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

/** The best parameters for an FFA range, from the batches with a passed lab result. */
export type RecommendedParameters = {
  esterificationVoltage?: number | null;
  esterificationTime?: number | null;
  esterificationStirring?: number | null;
  transesterificationVoltage: number;
  transesterificationTime: number;
  transesterificationStirring: number;
  methanolRatio: number;
};

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
  /** The pumps this machine has ("oil" only with the automated oil input). */
  pumps: Partial<Record<PumpName, boolean>>;
  timestamp: number;
  /** ESP32 hardware mode only: the USB link to the ESP32 controller. */
  controllerOnline?: boolean;
  controllerError?: string | null;
  controllerPort?: string | null;
  /** ESP32 mode: the RPMs are worked out from the speed setting (no RPM sensors). */
  rpmEstimated?: boolean;
  /** ESP32 mode: which HX711 load cells hardware.toml enables. */
  loadCellsFitted?: { reactor: boolean; output: boolean };
};

/** The oil pump or a dispenser emptying its container into the reactor. The operator measured the
 * computed amount (targetG / volumeMl) into the container; the pump runs until Done (deliveredG =
 * targetG) or Stop. It stops by itself with a fault after maxSeconds. */
export type PumpStatus = {
  pump: PumpName | null;
  phase: PumpPhase;
  batchId: string | null;
  stage: string | null;
  targetG: number;
  volumeMl: number;
  deliveredG: number;
  elapsedSeconds: number;
  maxSeconds: number;
  faultReason: string | null;
  /** When this run started: tells it apart from the previous run. */
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
  faultReason: string | null;
  /** Separation only: "settling" (in the reactor, 1 min, everything off), then "separating" (the
   * reactor pump, the centrifuge and pumpin run together). */
  phase?: "settling" | "separating" | null;
  settleTotalSeconds?: number;
  settleRemainingSeconds?: number;
};

/** Automatic purification (dry wash with Magnesol). The step timer is stepRemainingSeconds. */
export type PurificationStatus = {
  phase: PurificationPhase;
  batchId: string | null;
  /** Started by itself after separation (level switch), rather than by hand. */
  automatic: boolean;
  /** Fixed: no heater pulse at or above 90 °C, safety cutoff above 95 °C. */
  targetTemperature: number;
  maximumTemperature: number;
  liveTemperature: number | null;
  startingTemperature: number | null;
  highestTemperature: number | null;
  /** Always 0 now (no heating step). */
  heatingTimeSeconds: number;
  /** Methanol removal: the heater's pulse length (2 s) and the pulses so far. */
  heaterPulseSeconds?: number;
  heaterPulses?: number;
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
  /** The 1 min settle after contact (stirrer off). */
  settleTotalSeconds?: number;
  settleRemainingSeconds?: number;
  drainElapsedSeconds: number;
  /** Seconds the output weight has stayed within ±2 g; the run completes at stableTargetSeconds (30). */
  stableSeconds: number;
  stableTargetSeconds: number;
  /** Biodiesel collected in this run (output load cell). */
  outputWeightG: number | null;
  oilWeightG: number | null;
  /** The current step's timer (null for steps without one, e.g. the Magnesol prompt). */
  stepRemainingSeconds: number | null;
  stepTotalSeconds: number | null;
  heaterOn: boolean;
  valveOpen: boolean;
  heaterOnSeconds: number;
  /** Dry wash stirrer: target 200 RPM (fixed). stirrerRpm (the ESP32's reading) is reported during methanol removal and contact (null otherwise). */
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
  timestamp: string;
  sensors: Sensors;
  alarm: string | null;
  stage: StageStatus;
  purification: PurificationStatus;
  pump: PumpStatus;
  /** Batch ID waiting for purification to start by itself (after separation), or null. */
  purificationAutoStart: string | null;
  /** Why that purification hasn't started yet (no temperature or output load cell reading, an
   * earlier safety stop not acknowledged), or null. It starts by itself once this is fixed. */
  purificationWaiting?: string | null;
};

export type SystemStatus = {
  mode: "live";
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
  /** Separation time and speed are set per batch (Volume & Parameters): these are the defaults and
   * limits. It starts by itself after transesterification and a settle of settleSeconds. */
  separation: { timeMinutes: number; speedRpm: number; timeMin: number; timeMax: number; speedMin: number;
    speedMax: number; settleSeconds: number };
  purification: { holdTemperature: number; heaterPulseSeconds: number; pulseDropC: number; maximumTemperature: number;
    methanolRemovalMinutes: number; contactMinutes: number; settleSeconds: number;
    stirringSpeedRpm: number; drainStableGrams: number; drainStableSeconds: number;
    lowOutputFraction: number; magnesolGramsPerMlOil: number; bentoniteGramsPerMlOil?: number; adsorbents?: Adsorbent[];
    defaultAdsorbent?: Adsorbent; magnesolDosePct?: number; bentoniteDosePct?: number; thermalFuseRating: number | null; automatic: boolean };
  /** currentControl: the Pi sets the power supply's current limit (otherwise the operator does). */
  powerSupply: { currentControl: boolean };
  /** The oil pump and the dispensers run until the operator presses Done (stopStyle "manual"). */
  pumps: { oilPump: boolean; stopStyle: "manual"; maxRunMinutes: number };
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
  /** Not used any more (no settling or cooling step); kept because the MySQL settings table has them. */
  settlingTime: number;
  maxDrainTemperature: number;
  thermalFuseRating: number | null;
  esterificationDesignFfa: number;
  stripMaxFfa: number;
  pumpCatalystRate: number;
  pumpAcidRate: number;
  /** Not used any more (the outlets have no drain time); kept because the MySQL settings table has them. */
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

// ---------- batches (stored in MySQL by the Raspberry Pi) ----------
export function getBatches(): Promise<BatchRecord[]> {
  return get<BatchRecord[]>("/api/batches");
}

export function getBatch(id: string): Promise<BatchRecord | undefined> {
  return get<BatchRecord>(`/api/batches/${encodeURIComponent(id)}`);
}

/** Saves a finished batch. The backend fills in what the Pi measured (temperature, energy,
 * purification, output weight and yield) for the same batch ID. */
export function saveCompletedBatch(batch: Partial<BatchData>): Promise<BatchRecord> {
  return send<BatchRecord>("POST", "/api/batches", batch);
}

/** Records or changes the batch's lab result (its one lab result row is updated). testedAt is
 * when the operator recorded it: this device's clock, sent along so the time is never missing. */
export function updateBatchLabResult(id: string, labResult: "Passed" | "Failed", labReference?: string): Promise<BatchRecord | undefined> {
  const testedAt = new Date().toISOString();
  return send<BatchRecord>("POST", `/api/batches/${encodeURIComponent(id)}/lab-result`, { labResult, labReference, testedAt });
}

export function getRecommendedParametersForFfa(ffa: number): Promise<RecommendedParameters | null> {
  return get<RecommendedParameters | null>(`/api/analytics/recommended?ffa=${encodeURIComponent(ffa)}`);
}

export async function getNextBatchId(): Promise<string> {
  return (await get<{ id: string }>("/api/batches/next-id")).id;
}

// ---------- the batch in progress (only one at a time) ----------
/** The batch in progress, with where the Process page is, or null when no batch is running. */
export function getActiveBatch(): Promise<ActiveBatch | null> {
  return request<ActiveBatch | null>("/api/batches/active", { timeoutMs: 5000 });
}

/** "Start batch": records the batch as In Progress (shown in Batch History at once). Fails with
 * 409 while another batch is in progress: only one batch can be processed at a time. */
export function startBatch(id?: string): Promise<ActiveBatch> {
  return send<ActiveBatch>("POST", "/api/batches/start", { id });
}

/** Saves where the ongoing batch is (stage + the page's state) and its setup so far, so it can be
 * continued later, from the Dashboard or on another device. */
export async function saveBatchProgress(id: string, stage: string, state: Record<string, unknown>, batch?: Partial<BatchData>): Promise<void> {
  await send("PUT", `/api/batches/${encodeURIComponent(id)}/progress`, { stage, state, batch });
}

/** Cancels the batch in progress (it stays in Batch History as Cancelled). */
export function cancelBatch(id: string): Promise<BatchRecord> {
  return send<BatchRecord>("POST", `/api/batches/${encodeURIComponent(id)}/cancel`);
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

/** The batches for a page, from the Raspberry Pi. source: "loading" until the first answer,
 * "offline" while the Pi can't be reached (then the list is empty; it tries again every 5 s). */
export function useBatches(): { batches: BatchRecord[]; source: "loading" | "backend" | "offline"; reload: () => void } {
  const [batches, setBatches] = useState<BatchRecord[]>([]);
  const [source, setSource] = useState<"loading" | "backend" | "offline">("loading");
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let retry: number | undefined;
    const load = () =>
      getBatches()
        .then((rows) => {
          if (cancelled) return;
          setBatches(rows);
          setSource("backend");
        })
        .catch(() => {
          if (cancelled) return;
          setSource("offline");
          retry = window.setTimeout(load, 5000);
        });
    load();
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
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

/** The settings from the Raspberry Pi (and copied to this browser, where the pages read them). */
export async function getSettings(): Promise<Settings> {
  const settings = await get<Settings>("/api/settings");
  writeLocalSettings(settings);
  return settings;
}

/** Saves some or all settings on the Raspberry Pi (which keeps the keys you leave out) and copies
 * them to this browser, so the pages see them right away. Fails while the Pi is offline. */
export async function saveSettings(changes: Partial<Settings>): Promise<Settings> {
  const saved = await send<Settings>("PUT", "/api/settings", changes);
  writeLocalSettings(saved);
  return saved;
}

export const getProcessConfig = () => get<ProcessConfig>("/api/config");
export const getSystemStatus = () => get<SystemStatus>("/api/system/status");

// ---------- hardware (Settings -> Hardware) ----------
export type LoadCellInfo = {
  key: "reactor" | "output" | string;
  label: string;
  enabled: boolean;
  dataPin: number;
  clockPin: number;
  grams: number | null;
  ok: boolean;
  raw?: number | null;
  offset?: number;
  scale?: number;
  busy?: boolean;
  calibratedAt?: string | null;
  taredAt?: string | null;
  /** The known weights the current scale was worked out from, with what each reads now. */
  calibrationPoints?: LoadCellPoint[];
  /** Known weights added since the last Tare (this sitting). */
  sessionPoints?: number;
  /** A Tare was done in this sitting, so Calibrate can be pressed. */
  readyToCalibrate?: boolean;
};

export type LoadCellPoint = { grams: number; readsG: number; errorG: number };

export type HardwareInfo = {
  /** "esp32" (ESP32 relays + the Pi's motor driver and load cell) or "gpio" (older all-Pi wiring). */
  backend: "esp32" | "gpio";
  /** Why the output controller can't be trusted right now, or null. */
  fault: string | null;
  controller: null | {
    online: boolean;
    port: string | null;
    error: string | null;
    temperature: number | null;
    leaseSeconds: number;
    /** every ESP32 output is a relay (on/off) */
    devices: Array<{ id: string; label: string; on: boolean; used: boolean }>;
    messages: string[];
  };
  /** Greenova job -> the ESP32 output(s) that do it (hardware.toml [esp32.devices]). For a motor,
   * rpm is the speed the Pi's motor driver runs it at (0 when off). */
  roles: Array<{ role: string; label: string; devices: string[]; on: boolean; rpm: number | null;
    maxOnSeconds: number | null; controllerOn: Array<boolean | null> }>;
  /** The Pi's one BTS7960 for mixer 1, mixer 2 and the centrifuge (the ESP32's relays pick the motor). */
  motorDriver: null | {
    motor: "stirrer" | "purification_stirrer" | "centrifuge" | null;
    motorLabel: string | null;
    targetRpm: number;
    rpm: number;
    duty: number;
    /** each motor's RPM at 100 % PWM */
    maxRpm: Record<string, number>;
    error: string | null;
  };
  loadCells: LoadCellInfo[];
};

export const getHardware = () => get<HardwareInfo>("/api/hardware");
/** Zero the load cell: nothing on it (or only the empty container). Starts a new calibration. Takes about 5 s. */
export const tareLoadCell = (key: string) =>
  send<{ result: { offset: number; noiseG: number }; loadCells: LoadCellInfo[] }>("POST", `/api/hardware/load-cells/${key}/tare`);
/** A known weight (grams) is on the load cell, tared just before: adds it as a point and works out the
 * scale from every weight since the Tare. Takes about 5 s. */
export const calibrateLoadCell = (key: string, grams: number) =>
  send<{ result: { scale: number; resolutionG: number; points: LoadCellPoint[]; maxErrorG: number }; loadCells: LoadCellInfo[] }>(
    "POST", `/api/hardware/load-cells/${key}/calibrate`, { grams });
/** A known weight is on the load cell: what it reads and the error. Changes nothing. Takes about 5 s. */
export const checkLoadCell = (key: string, grams: number) =>
  send<{ result: { knownG: number; readsG: number; errorG: number; errorPercent: number; resolutionG: number }; loadCells: LoadCellInfo[] }>(
    "POST", `/api/hardware/load-cells/${key}/check`, { grams });
/** This computer's addresses on the local network, for "Open on phone". */
export const getNetworkAddresses = async () => (await get<{ addresses: string[] }>("/api/network")).addresses;
export const getLive = () => get<LiveData>("/api/live");
export const clearAlarm = () => send<{ alarm: null }>("POST", "/api/alarm/clear");

// ---------- calculator and FFA strip ----------
export const calculateQuantities = (input: { oilMassG: number; ffa: number; methanolRatio?: number; catalyst: Catalyst; adsorbent?: Adsorbent }) =>
  send<QuantityCards>("POST", "/api/calculate", input);

export const calculateAfterEsterification = (input: { oilMassG: number; ffaAfter: number; stageDone: number; methanolRatio?: number; catalyst: Catalyst }) =>
  send<AfterEsterification>("POST", "/api/calculate/after-esterification", input);

// ---------- the oil pump and the dispensers (stopped by the operator) ----------
/** Switches the pump on: it empties the container the operator filled (targetG / volumeMl, the
 * computed amount) into the reactor until finishPump (Done) or stopPump. */
export const startPump = (input: { pump: PumpName; targetG: number; volumeMl: number; batchId?: string; stage?: string }) =>
  send<PumpStatus>("POST", "/api/process/pump/start", input);

/** "Done": the container is empty, everything is in the reactor; the pump stops. */
export const finishPump = () => send<PumpStatus>("POST", "/api/process/pump/finish");

/** Stops the pump now (it can be started again for the rest). */
export const stopPump = () => send<PumpStatus>("POST", "/api/process/pump/stop");

// ---------- process stages ----------
/** separationTime / separationSpeed: the batch's separation (Volume & Parameters), sent with the
 * Transesterification start (the Pi starts the separation by itself after it) and with a Separation start. */
export const startStage = (input: { stage: StageName; batchId?: string; voltage?: number; time?: number; stirring?: number;
  current?: number; oilMassG?: number; adsorbent?: Adsorbent; separationTime?: number; separationSpeed?: number }) =>
  send<StageStatus>("POST", "/api/process/stage/start", input);

export const stageAction = (action: "pause" | "resume" | "complete" | "emergency-stop" | "reset") =>
  send<StageStatus>("POST", `/api/process/stage/${action}`);

/** Purification normally starts by itself after separation. Use this only when there's no level
 * switch (heaterSubmerged = the operator's confirmation) or to start again after a stop. */
export const startPurification = (input: { heaterSubmerged?: boolean; batchId?: string; oilVolumeMl?: number; adsorbent?: Adsorbent }) =>
  send<PurificationStatus>("POST", "/api/process/purification/start", input);

/** "magnesol-added" = the operator's Confirm after adding the adsorbent (Magnesol or bentonite). */
export const purificationAction = (action: "abort" | "acknowledge" | "magnesol-added" | "complete") =>
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
