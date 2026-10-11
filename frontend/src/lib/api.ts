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
export type StageName = "Esterification" | "Transesterification" | "Separation";
export type StageState = "ready" | "running" | "paused" | "complete" | "fault";
export type PurificationPhase = "ready" | "heating" | "hold" | "flow" | "drain" | "complete" | "fault";
export type TileState = "ready" | "checking" | "fault";

export type BatchRecord = DemoBatch & {
  oilMassG?: number | null;
  catalystToWeighG?: number | null;
  esterificationStages?: Array<{
    stage: number;
    ffaBefore: number;
    ffaAfter?: number | null;
    methanolMl: number;
    sulfuricAcidMl: number;
    acetoneMl: number;
  }>;
  timeline?: Array<{ label: string; time: string }>;
  notes?: string | null;
  createdAt?: string | null;
};

export type RecommendedParameters = NonNullable<ReturnType<typeof local.getRecommendedParametersForFfa>>;

/** Same keys as calculateQuantityCards() in NewBatch.tsx, plus a few extras. */
export type QuantityCards = {
  oilMassG: number;
  oilVolumeMl: number;
  ffa: number;
  methanolRatio: number;
  catalyst: Catalyst;
  ffaMassG: number;
  esterificationNeeded: boolean;
  esterificationMethanolMl: number;
  sulfuricAcidMl: number;
  sulfuricAcidG: number;
  acetoneMl: number;
  transesterificationMethanolMl: number;
  catalystBaseG: number;
  neutralizationG: number;
  catalystToWeighG: number;
  purity: number;
  isEstimate: boolean;
  warnings: string[];
};

export type AfterEsterification =
  | { action: "anotherStage"; stage: number; ffaMassG: number; esterificationMethanolMl: number;
      sulfuricAcidMl: number; sulfuricAcidG: number; acetoneMl: number }
  | { action: "transesterification"; ffa: number; isEstimate: false; transesterificationMethanolMl: number;
      catalystBaseG: number; neutralizationG: number; catalystToWeighG: number; purity: number; acetoneMl: number };

export type Sensors = {
  oilMassG: number | null;
  outputWeightG: number | null;
  temperature: number | null;
  voltage: number | null;
  current: number | null;
  stirrerRpm: number | null;
  centrifugeRpm: number | null;
  /** Level switch at the heater: true = biodiesel covers it, null = no switch installed. */
  heaterSubmerged: boolean | null;
  heaterOn: boolean;
  electrodePowerOn: boolean;
  meshBedValveOpen: boolean;
  valves: Record<string, boolean>;
  motorDuty: Record<string, number>;
  timestamp: number;
};

export type StageStatus = {
  stage: StageName | null;
  state: StageState;
  batchId: string | null;
  voltage: number | null;
  timeMinutes: number | null;
  stirringRpm: number | null;
  speedRpm: number | null;
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

/** Automatic purification: heating → hold → mesh bed flow → drain → complete. */
export type PurificationStatus = {
  phase: PurificationPhase;
  batchId: string | null;
  /** Started by itself after separation (level switch), rather than by hand. */
  automatic: boolean;
  targetTemperature: number | null;
  liveTemperature: number | null;
  startingTemperature: number | null;
  highestTemperature: number | null;
  heatingTimeSeconds: number;
  holdTimeSeconds: number;
  holdTotalSeconds: number;
  holdRemainingSeconds: number;
  /** About the batch's oil volume; sets plannedFlowSeconds. */
  expectedBiodieselMl: number | null;
  plannedFlowSeconds: number;
  flowElapsedSeconds: number;
  flowRemainingSeconds: number;
  drainElapsedSeconds: number;
  drainMaximumSeconds: number;
  flowStableSeconds: number;
  /** Biodiesel collected in this run (output load cell). */
  outputWeightG: number | null;
  flowRateGPerMinute: number | null;
  heaterOn: boolean;
  valveOpen: boolean;
  heaterOnSeconds: number;
  /** E.g. less output than expected: check the mesh bed. */
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
type StageLimits = { voltage: Limit; time: Limit; stirring: Limit };

/** Same structure as PROCESS_CONFIG in NewBatch.tsx. */
export type ProcessConfig = {
  oil: { minimumVolumeMl: number; maximumVolumeMl: number; densityGPerMl: number; averageTriglycerideMolecularWeight: number };
  ffaThreshold: number;
  ffaTarget: number;
  methanol: { ratioDefault: number; ratioMin: number; ratioMax: number; molecularWeight: number; densityGPerMl: number; convention: string };
  catalyst: { loadingDefault: number; kohPurity: number; naohPurity: number };
  acetone: { volumeFractionDefault: number; provisional: boolean };
  esterification: StageLimits & { sulfuricAcidMlPerGramFfa: number };
  transesterification: StageLimits;
  separation: { timeMinutes: number; speedRpm: number };
  purification: { targetTemperature: number; maximumTemperature: number; thermalFuseRating: number | null;
    holdTimeMinutes: number; meshBedFlowRate: number; drainTimeMinutes: number; heatingTimeoutMinutes: number;
    automatic: boolean; targetRange: { min: number; max: number } };
  reactionMaximumTemperature: number;
};

/** The Settings page keys (same as localStorage "greenova_settings") plus backend-only values. */
export type Settings = Record<string, unknown> & {
  systemName: string;
  operator: string;
  units: string;
  format: string;
  purificationTargetTemperature: number;
  purificationMaximumTemperature: number;
  thermalFuseRating: number | null;
  purificationHoldTime: number;
  meshBedFlowRate: number;
  drainTime: number;
  heatingTimeout: number;
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
    // FastAPI sends a list of problems when a request doesn't pass validation (422).
    const message = typeof detail === "string"
      ? detail
      : Array.isArray(detail)
        ? detail.map((item) => (item && typeof item === "object" && "msg" in item ? String((item as { msg: unknown }).msg) : String(item))).join("; ")
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
export function getBatches(): Promise<BatchRecord[]> {
  return withLocalFallback(() => get<BatchRecord[]>("/api/batches"), () => local.getBatches());
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

export function updateBatchLabResult(id: string, labResult: "Passed" | "Failed", labReference?: string): Promise<BatchRecord | undefined> {
  return withLocalFallback(
    () => send<BatchRecord>("POST", `/api/batches/${encodeURIComponent(id)}/lab-result`, { labResult, labReference }),
    () => local.updateBatchLabResult(id, labResult, labReference),
  );
}

export function getRecommendedParametersForFfa(ffa: number): Promise<RecommendedParameters | null> {
  return withLocalFallback(
    () => get<RecommendedParameters | null>(`/api/analytics/recommended?ffa=${encodeURIComponent(ffa)}`),
    () => local.getRecommendedParametersForFfa(ffa),
  );
}

export function getNextBatchId(): Promise<string> {
  return withLocalFallback(
    async () => (await get<{ id: string }>("/api/batches/next-id")).id,
    () => `B-${new Date().getFullYear()}-${String(Date.now()).slice(-3)}`,
  );
}

/** Batches for a page: shows the local data at once, then the backend's when it answers. */
export function useBatches(): { batches: BatchRecord[]; source: "backend" | "local"; reload: () => void } {
  const [batches, setBatches] = useState<BatchRecord[]>(() => local.getBatches());
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
        setBatches(local.getBatches());
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
export const getLive = () => get<LiveData>("/api/live");
export const clearAlarm = () => send<{ alarm: null }>("POST", "/api/alarm/clear");

// ---------- calculator and FFA strip ----------
export const calculateQuantities = (input: { oilMassG: number; ffa: number; methanolRatio?: number; catalyst: Catalyst }) =>
  send<QuantityCards>("POST", "/api/calculate", input);

export const calculateAfterEsterification = (input: { oilMassG: number; ffaAfter: number; stageDone: number; methanolRatio?: number; catalyst: Catalyst }) =>
  send<AfterEsterification>("POST", "/api/calculate/after-esterification", input);

export const readFfaStrip = () => send<{ ffa: number; warnings: string[] }>("POST", "/api/strip/read");

/** "Load demonstration sensor reading" (demo mode only). */
export const loadDemoOil = (volumeMl: number) => send<Sensors>("POST", "/api/demo/load-oil", { volumeMl });

// ---------- process stages ----------
export const startStage = (input: { stage: StageName; batchId?: string; voltage?: number; time?: number; stirring?: number; oilMassG?: number }) =>
  send<StageStatus>("POST", "/api/process/stage/start", input);

export const stageAction = (action: "pause" | "resume" | "complete" | "emergency-stop" | "reset") =>
  send<StageStatus>("POST", `/api/process/stage/${action}`);

/** Purification normally starts by itself after separation. Use this only when there's no level
 * switch (heaterSubmerged = the operator's confirmation) or to start again after a stop. */
export const startPurification = (input: { heaterSubmerged?: boolean; targetTemperature?: number; batchId?: string; oilVolumeMl?: number }) =>
  send<PurificationStatus>("POST", "/api/process/purification/start", input);

export const purificationAction = (action: "skip" | "abort" | "acknowledge") =>
  send<PurificationStatus>("POST", `/api/process/purification/${action}`);

/** Emergency stop for everything: stage, purification, heater, valves and motors. */
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
