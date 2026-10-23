/** Batch data and FFA helpers shared by the pages. The batches themselves are stored by the
 * Raspberry Pi in MySQL (lib/api.ts); nothing is kept in the browser and there is no sample data. */
export type BatchData = {
  id: string;
  date: string;
  oilVolume: number;
  yield: number;
  duration: number;
  energy: number;
  status: "Completed" | "Failed" | "In Progress" | "Cancelled";
  labResult: "Pending" | "Passed" | "Failed" | "Not tested";
  labReference?: string;
  /** When the lab result was recorded (ISO time). */
  labTestedAt?: string | null;
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

// With whole-number FFA, 0–3% goes direct; 4% is esterified; 5%+ is recorded with the darkest-strip checkbox.
export const DEFAULT_FFA_BOUNDARIES = "0,4,5";
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
export function formatFfa(batch: Pick<BatchData, "ffa" | "ffaAboveStrip">): string {
  const value = Number.isInteger(batch.ffa) ? String(batch.ffa) : batch.ffa.toFixed(1);
  return `${batch.ffaAboveStrip ? "≥ " : ""}${value}%`;
}
