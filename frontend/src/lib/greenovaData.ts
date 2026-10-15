export type DemoBatch = {
  id: string;
  date: string;
  oilVolume: number;
  yield: number;
  duration: number;
  energy: number;
  status: "Completed" | "Failed" | "In Progress" | "Cancelled";
  labResult: "Pending" | "Passed" | "Failed" | "Not tested";
  labReference?: string;
  ffa: number;
  /** The FFA strip showed its darkest color: FFA is at least `ffa` (the strip's maximum, 5%). */
  ffaAboveStrip?: boolean;
  esterificationRun: boolean;
  temperature: number;
  reactionTime: number;
  stirringSpeed: number;
  voltage?: number;
  /** Transesterification current setting (A). */
  current?: number;
  methanolRatio?: number;
  esterificationVoltage?: number;
  esterificationTime?: number;
  esterificationStirring?: number;
  esterificationCurrent?: number;
  biodieselOutputMl?: number;
  catalystType?: "NaOH" | "KOH";
  /** Dry wash adsorbent used in purification. */
  adsorbent?: "Magnesol" | "Bentonite";
  /** Oil weighed by the reactor load cell. */
  oilMassG?: number;
  catalystToWeighG?: number;
  /** One entry per esterification stage, with the FFA re-check after it. */
  esterificationStages?: Array<{
    stage: number;
    ffaBefore: number;
    ffaAfter?: number | null;
    doseFfa?: number | null;
    methanolMl: number;
    sulfuricAcidMl: number;
    acetoneMl: number;
  }>;
  materials?: {
    oilL: number;
    methanolL: number;
    catalystKg: number;
    sulfuricAcidL: number;
    acetoneL: number;
    bentoniteKg: number;
    magnesolKg?: number;
  };
  purification?: {
    targetTemperature?: number;
    highestTemperature?: number | null;
    heatingTimeSeconds?: number;
    /** Methanol removal at 90 °C. */
    holdTimeSeconds?: number;
    /** Older records only (mesh bed flow). */
    flowTimeSeconds?: number;
    drainTimeSeconds?: number;
    contactTimeSeconds?: number;
    settlingTimeSeconds?: number;
    coolingTimeSeconds?: number;
    magnesolAdded?: boolean;
    oilWeightG?: number | null;
    expectedBiodieselMl?: number | null;
    plannedFlowSeconds?: number;
    automatic?: boolean;
    warning?: string | null;
    safetyStopOccurred?: boolean;
    /** Dry wash stirrer RPM (fixed 200). */
    stirringSpeed?: number;
    /** Adsorbent for the dry wash (g); the name is from when it was Magnesol only. */
    magnesolG?: number | null;
    adsorbent?: "Magnesol" | "Bentonite";
    adsorbentG?: number | null;
    outputWeightG?: number | null;
  };
};

// FFA is a whole percent. FFA <= 1% goes straight to transesterification; higher is esterified first.
export const demoBatches: DemoBatch[] = [
  { id: "B-2026-024", date: "2026-10-18", oilVolume: 1000, ffa: 1, esterificationRun: false, yield: 88.4, duration: 132, energy: 1.84, status: "Completed", labResult: "Passed", temperature: 42, reactionTime: 58, stirringSpeed: 450 },
  { id: "B-2026-023", date: "2026-10-16", oilVolume: 1000, ffa: 5, ffaAboveStrip: true, esterificationRun: true, yield: 86.9, duration: 138, energy: 1.91, status: "Completed", labResult: "Pending", temperature: 41, reactionTime: 62, stirringSpeed: 440 },
  { id: "B-2026-022", date: "2026-10-12", oilVolume: 1200, ffa: 1, esterificationRun: false, yield: 89.1, duration: 147, energy: 2.16, status: "Completed", labResult: "Passed", temperature: 43, reactionTime: 65, stirringSpeed: 470 },
  { id: "B-2026-021", date: "2026-10-09", oilVolume: 1000, ffa: 5, ffaAboveStrip: true, esterificationRun: true, yield: 0, duration: 51, energy: 0.82, status: "Failed", labResult: "Not tested", temperature: 40, reactionTime: 31, stirringSpeed: 430 },
  { id: "B-2026-020", date: "2026-10-04", oilVolume: 800, ffa: 4, esterificationRun: true, yield: 85.7, duration: 121, energy: 1.52, status: "Completed", labResult: "Passed", temperature: 41, reactionTime: 54, stirringSpeed: 420 },
  { id: "B-2026-019", date: "2026-09-29", oilVolume: 1000, ffa: 1, esterificationRun: false, yield: 87.6, duration: 135, energy: 1.88, status: "Completed", labResult: "Pending", temperature: 42, reactionTime: 60, stirringSpeed: 450 },
];

const STORAGE_KEY = "greenova_batches_v2";
const LEGACY_SAMPLE_FFA: Record<string, number> = {
  "B-2026-024": 1,
  "B-2026-023": 5,
  "B-2026-022": 1,
  "B-2026-021": 5,
  "B-2026-020": 4,
  "B-2026-019": 1,
};
/** Sample FFA values saved by earlier versions (decimals, the old 4% rule): shown as the new ones. */
const DECIMAL_SAMPLE_FFA: Record<string, [number, number]> = {
  "B-2026-024": [2.8, 1],
  "B-2026-022": [3.4, 1],
  "B-2026-020": [4.6, 4],
  "B-2026-019": [3.1, 1],
};
/** Sample values saved by older versions, before the strip's 5% limit. */
const OLD_SAMPLE_FFA: Record<string, number> = { "B-2026-023": 5.6, "B-2026-021": 7.2 };

// With whole-number FFA the ranges are 0–1% (no esterification), 2–3%, 4% and 5%+.
export const DEFAULT_FFA_BOUNDARIES = "0,2,4,5";
const OLD_DEFAULT_FFA_BOUNDARIES = "0,2,4,6,8,10";

/** The FFA range boundaries from Settings. The last range is "5% and above": the strip's darkest
 * color. The old default (ranges up to 10%) counts as the new default. */
export function ffaBoundaries(value: unknown): number[] {
  const text = String(value ?? "").replace(/\s/g, "");
  const source = !text || text === OLD_DEFAULT_FFA_BOUNDARIES ? DEFAULT_FFA_BOUNDARIES : text;
  const parsed = source.split(",").map(Number).filter((item) => Number.isFinite(item)).sort((a, b) => a - b);
  const unique = [...new Set(parsed)];
  return unique.length >= 2 ? unique : [0, 2, 4, 5];
}

/** FFA (%) every esterification dose is calculated for (Settings, default 10%). */
export function esterificationDesignFfa(): number {
  try {
    const settings = JSON.parse(localStorage.getItem("greenova_settings") || "{}") as Record<string, unknown>;
    const value = Number(settings.esterificationDesignFfa);
    return Number.isFinite(value) && value > 0 ? value : 10;
  } catch {
    return 10;
  }
}

/** "3%", or "≥ 5%" when the strip showed its darkest color. FFA is a whole percent; an older
 * record with a decimal keeps it ("2.8%"). */
export function formatFfa(batch: Pick<DemoBatch, "ffa" | "ffaAboveStrip">): string {
  const value = Number.isInteger(batch.ffa) ? String(batch.ffa) : batch.ffa.toFixed(1);
  return `${batch.ffaAboveStrip ? "≥ " : ""}${value}%`;
}

function hydrateAnalyticsData(batch: DemoBatch): DemoBatch {
  const oilMassG = batch.oilVolume * 0.92;
  const ratio = batch.methanolRatio ?? 7;
  const transMethanolMl = (oilMassG * ratio * 40.45) / 880;
  // Uniform dose: every esterified batch is dosed as if its FFA were the design FFA.
  const doseFfaMassG = oilMassG * (esterificationDesignFfa() / 100);
  const stages = batch.esterificationStages ?? [];
  const esterMethanolMl = !batch.esterificationRun ? 0
    : stages.length ? stages.reduce((sum, stage) => sum + stage.methanolMl, 0) : doseFfaMassG * 2.84;
  const sulfuricAcidMl = !batch.esterificationRun ? 0
    : stages.length ? stages.reduce((sum, stage) => sum + stage.sulfuricAcidMl, 0) : doseFfaMassG * 0.027;
  return {
    ...batch,
    voltage: batch.voltage ?? 30,
    methanolRatio: ratio,
    esterificationVoltage: batch.esterificationRun ? batch.esterificationVoltage ?? 20 : undefined,
    esterificationTime: batch.esterificationRun ? batch.esterificationTime ?? 120 : undefined,
    esterificationStirring: batch.esterificationRun ? batch.esterificationStirring ?? 500 : undefined,
    biodieselOutputMl: batch.biodieselOutputMl ?? batch.oilVolume * (batch.yield / 100),
    catalystType: batch.catalystType ?? "NaOH",
    materials: batch.materials ?? {
      oilL: batch.oilVolume / 1000,
      methanolL: (transMethanolMl + esterMethanolMl) / 1000,
      catalystKg: oilMassG * 0.01 / 1000,
      sulfuricAcidL: sulfuricAcidMl / 1000,
      acetoneL: batch.oilVolume * 0.1 / 1000,
      bentoniteKg: batch.oilVolume * 0.02 / 1000,
    },
  };
}

export function getBatches(): DemoBatch[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return demoBatches.map(hydrateAnalyticsData);
    return (JSON.parse(stored) as Array<Partial<DemoBatch> & { engineTest?: string }>).map((batch) => {
      const oldSample = batch.id !== undefined && batch.ffa === OLD_SAMPLE_FFA[batch.id];
      const decimalSample = batch.id !== undefined ? DECIMAL_SAMPLE_FFA[batch.id] : undefined;
      const ffa = oldSample ? 5
        : decimalSample && batch.ffa === decimalSample[0] ? decimalSample[1]
          : batch.ffa ?? LEGACY_SAMPLE_FFA[batch.id || ""] ?? 0;
      return {
        ...batch,
        ffa,
        ffaAboveStrip: oldSample ? true : batch.ffaAboveStrip,
        esterificationRun: batch.esterificationRun ?? ffa > 1,
        labResult:
          batch.labResult ??
          (batch.status === "Failed"
            ? "Not tested"
            : batch.engineTest === "Passed" || batch.engineTest === "Failed"
              ? batch.engineTest
              : "Pending"),
      };
    }).map((batch) => hydrateAnalyticsData(batch as DemoBatch));
  } catch {
    return demoBatches;
  }
}

export function updateBatchLabResult(
  id: string,
  labResult: "Passed" | "Failed",
  labReference?: string,
) {
  const batches = getBatches().map((batch) =>
    batch.id === id ? { ...batch, labResult, labReference: labReference?.trim() || undefined } : batch,
  );
  localStorage.setItem(STORAGE_KEY, JSON.stringify(batches));
  return batches.find((batch) => batch.id === id);
}

export function getRecommendedParametersForFfa(ffa: number) {
  let boundaries = ffaBoundaries(DEFAULT_FFA_BOUNDARIES);
  try {
    const settings = JSON.parse(localStorage.getItem("greenova_settings") || "{}") as Record<string, unknown>;
    boundaries = ffaBoundaries(settings.ffaRangeBoundaries);
  } catch {
    // Use the documented default ranges.
  }
  const rangeIndex = boundaries.findIndex((minimum, index) => {
    const maximum = boundaries[index + 1];
    return ffa >= minimum && (maximum === undefined || ffa < maximum);
  });
  const minimum = boundaries[Math.max(rangeIndex, 0)];
  const maximum = boundaries[Math.max(rangeIndex, 0) + 1];
  const candidates = getBatches().filter(
    (batch) =>
      batch.labResult === "Passed" &&
      batch.ffa >= minimum &&
      (maximum === undefined || batch.ffa < maximum),
  );
  const groups = new Map<string, DemoBatch[]>();
  candidates.forEach((batch) => {
    const signature = [
      batch.esterificationVoltage ?? "none",
      batch.esterificationTime ?? "none",
      batch.esterificationStirring ?? "none",
      batch.voltage ?? 30,
      batch.reactionTime,
      batch.stirringSpeed,
      batch.methanolRatio ?? 7,
    ].join("|");
    groups.set(signature, [...(groups.get(signature) || []), batch]);
  });
  const recommendation = [...groups.values()]
    .map((batches) => ({
      batch: batches[0],
      averageYield: batches.reduce((sum, batch) => sum + batch.yield, 0) / batches.length,
    }))
    .sort((a, b) => b.averageYield - a.averageYield)[0]?.batch;
  if (!recommendation) return null;
  return {
    esterificationVoltage: recommendation.esterificationVoltage,
    esterificationTime: recommendation.esterificationTime,
    esterificationStirring: recommendation.esterificationStirring,
    transesterificationVoltage: recommendation.voltage ?? 30,
    transesterificationTime: recommendation.reactionTime,
    transesterificationStirring: recommendation.stirringSpeed,
    methanolRatio: recommendation.methanolRatio ?? 7,
  };
}

/** Saves a finished batch. The batch that was in progress is completed in its own entry (never a
 * second entry with the same ID); any other ID that is already saved stays as it is. */
export function saveCompletedBatch(batch: DemoBatch) {
  const batches = getBatches();
  const existing = batches.find((item) => item.id === batch.id);
  if (existing && existing.status !== "In Progress") return;
  const next = existing ? batches.map((item) => (item.id === batch.id ? batch : item)) : [batch, ...batches];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  if (getLocalProgress()?.id === batch.id) setLocalProgress(null);
}

// ---------- the batch in progress, without the backend ----------
const PROGRESS_KEY = "greenova_active_process";

/** Where the ongoing batch is on the Process page (same as the backend's batch_progress row). */
export type LocalProgress = { id: string; stage: string; state: Record<string, unknown> | null; updatedAt: string };

export function getLocalProgress(): LocalProgress | null {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY) || "null") as LocalProgress | null;
  } catch {
    return null;
  }
}

export function setLocalProgress(progress: LocalProgress | null) {
  if (progress) localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  else localStorage.removeItem(PROGRESS_KEY);
}

/** Records a new batch as "In Progress", so it shows in Batch History at once. */
export function startLocalBatch(id: string): DemoBatch {
  const batch: DemoBatch = {
    id, date: new Date().toISOString().slice(0, 10), oilVolume: 0, yield: 0, duration: 0, energy: 0,
    status: "In Progress", labResult: "Pending", ffa: 0, esterificationRun: false, temperature: 0,
    reactionTime: 0, stirringSpeed: 0,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify([batch, ...getBatches()]));
  return batch;
}

/** Changes some fields of a saved batch (in place). */
export function updateLocalBatch(id: string, changes: Partial<DemoBatch>): DemoBatch | undefined {
  const batches = getBatches().map((batch) => (batch.id === id ? { ...batch, ...changes } : batch));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(batches));
  return batches.find((batch) => batch.id === id);
}
