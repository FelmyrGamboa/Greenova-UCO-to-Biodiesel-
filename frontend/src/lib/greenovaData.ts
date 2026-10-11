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
  esterificationRun: boolean;
  temperature: number;
  reactionTime: number;
  stirringSpeed: number;
  voltage?: number;
  methanolRatio?: number;
  esterificationVoltage?: number;
  esterificationTime?: number;
  esterificationStirring?: number;
  biodieselOutputMl?: number;
  catalystType?: "NaOH" | "KOH";
  materials?: {
    oilL: number;
    methanolL: number;
    catalystKg: number;
    sulfuricAcidL: number;
    acetoneL: number;
    bentoniteKg: number;
  };
  purification?: {
    targetTemperature: number;
    highestTemperature: number;
    heatingTimeSeconds: number;
    holdTimeSeconds: number;
    flowTimeSeconds: number;
    drainTimeSeconds?: number;
    expectedBiodieselMl?: number | null;
    plannedFlowSeconds?: number;
    automatic?: boolean;
    warning?: string | null;
    safetyStopOccurred: boolean;
  };
};

export const demoBatches: DemoBatch[] = [
  { id: "B-2026-024", date: "2026-10-18", oilVolume: 1000, ffa: 2.8, esterificationRun: false, yield: 88.4, duration: 132, energy: 1.84, status: "Completed", labResult: "Passed", temperature: 42, reactionTime: 58, stirringSpeed: 450 },
  { id: "B-2026-023", date: "2026-10-16", oilVolume: 1000, ffa: 5.6, esterificationRun: true, yield: 86.9, duration: 138, energy: 1.91, status: "Completed", labResult: "Pending", temperature: 41, reactionTime: 62, stirringSpeed: 440 },
  { id: "B-2026-022", date: "2026-10-12", oilVolume: 1200, ffa: 3.4, esterificationRun: false, yield: 89.1, duration: 147, energy: 2.16, status: "Completed", labResult: "Passed", temperature: 43, reactionTime: 65, stirringSpeed: 470 },
  { id: "B-2026-021", date: "2026-10-09", oilVolume: 1000, ffa: 7.2, esterificationRun: true, yield: 0, duration: 51, energy: 0.82, status: "Failed", labResult: "Not tested", temperature: 40, reactionTime: 31, stirringSpeed: 430 },
  { id: "B-2026-020", date: "2026-10-04", oilVolume: 800, ffa: 4.6, esterificationRun: true, yield: 85.7, duration: 121, energy: 1.52, status: "Completed", labResult: "Passed", temperature: 41, reactionTime: 54, stirringSpeed: 420 },
  { id: "B-2026-019", date: "2026-09-29", oilVolume: 1000, ffa: 3.1, esterificationRun: false, yield: 87.6, duration: 135, energy: 1.88, status: "Completed", labResult: "Pending", temperature: 42, reactionTime: 60, stirringSpeed: 450 },
];

const STORAGE_KEY = "greenova_batches_v2";
const LEGACY_SAMPLE_FFA: Record<string, number> = {
  "B-2026-024": 2.8,
  "B-2026-023": 5.6,
  "B-2026-022": 3.4,
  "B-2026-021": 7.2,
  "B-2026-020": 4.6,
  "B-2026-019": 3.1,
};

function hydrateAnalyticsData(batch: DemoBatch): DemoBatch {
  const oilMassG = batch.oilVolume * 0.92;
  const ratio = batch.methanolRatio ?? 7;
  const transMethanolMl = (oilMassG * ratio * 40.45) / 880;
  const esterMethanolMl = batch.esterificationRun ? oilMassG * (batch.ffa / 100) * 2.84 : 0;
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
      sulfuricAcidL: batch.esterificationRun ? oilMassG * (batch.ffa / 100) * 0.027 / 1000 : 0,
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
      const ffa = batch.ffa ?? LEGACY_SAMPLE_FFA[batch.id || ""] ?? 0;
      return {
        ...batch,
        ffa,
        esterificationRun: batch.esterificationRun ?? ffa > 4,
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
  let boundaries = [0, 2, 4, 6, 8, 10];
  try {
    const settings = JSON.parse(localStorage.getItem("greenova_settings") || "{}") as Record<string, unknown>;
    const parsed = String(settings.ffaRangeBoundaries || "")
      .split(",")
      .map(Number)
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
    if (parsed.length >= 2) boundaries = [...new Set(parsed)];
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

export function saveCompletedBatch(batch: DemoBatch) {
  const batches = getBatches();
  if (batches.some((item) => item.id === batch.id)) return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify([batch, ...batches]));
}
