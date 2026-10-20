import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import {
  Button,
  Card,
  Dialog,
  Field,
  Heading,
  Metric,
  Progress,
  SelectField,
  Status,
} from "../components/ui";
import { useLiveData } from "../contexts/LiveContext";
import {
  ApiError,
  cancelBatch,
  demoAdd,
  getActiveBatch,
  getNextBatchId,
  getRecommendedParametersForFfa,
  getSystemStatus,
  isOffline,
  loadDemoOil,
  markBatchCompleted,
  pumpAction,
  purificationAction,
  saveBatchProgress,
  saveCompletedBatch,
  stageAction,
  startBatch,
  startPump,
  startPurification,
  startStage,
  type ActiveBatch,
  type Adsorbent,
  type BatchRecord,
  type DrainValve,
  type PumpName,
  type PumpPhase,
  type PurificationPhase,
  type StageName,
  type StageStatus,
  type SystemStatus,
} from "../lib/api";
import { formatFfa, saveCompletedBatch as saveBatchInThisBrowser, type DemoBatch } from "../lib/greenovaData";
import { useT, type TFunction } from "../lib/i18n";

type DeviceState = "ready" | "checking" | "fault";
type StageState = "ready" | "running" | "paused" | "complete" | "fault";
const PURIFYING: PurificationPhase[] = ["heating", "methanol", "magnesol", "contact", "drain"];
type ChemistrySettings = {
  oilMolarMass: number;
  ffaThreshold: number;
  kohPurity: number;
  naohPurity: number;
  /** FFA every first esterification stage is dosed for (the strip can't read above stripMaxFfa). */
  designFfa: number;
  stripMaxFfa: number;
  /** Esterification goes on until the FFA re-check is at or below this. */
  ffaTarget: number;
};
type EsterStageRecord = {
  stage: number;
  ffaBefore: number;
  ffaAfter: number | null;
  doseFfa: number;
  methanolMl: number;
  sulfuricAcidMl: number;
  acetoneMl: number;
};

// Whole amperes only (every operator input is a whole number): 1 or 2 A.
const CURRENT_LIMITS = { min: 1, max: 2, default: 1 };

export const PROCESS_CONFIG = {
  oil: {
    minimumVolumeMl: 1500,
    maximumVolumeMl: 5000,
    densityGPerMl: 0.92,
    averageTriglycerideMolecularWeight: 885,
  },
  // FFA <= 3%: straight to transesterification. Above 3% is esterified first.
  ffaThreshold: 3,
  methanol: {
    ratioDefault: 7,
    ratioMin: 6,
    ratioMax: 9,
    molecularWeight: 32.04,
    densityGPerMl: 0.792,
    convention: "Molar methanol-to-triglyceride-oil ratio",
  },
  catalyst: {
    loadingDefault: 0.01,
  },
  acetone: {
    volumeFractionDefault: 0.1,
    provisional: true,
  },
  esterification: {
    voltage: { min: 10, max: 30, default: 20 },
    time: { min: 30, max: 180, default: 120 },
    stirring: { min: 400, max: 700, default: 500 },
    current: CURRENT_LIMITS,
    sulfuricAcidDosage: null,
  },
  transesterification: {
    voltage: { min: 10, max: 30, default: 30 },
    time: { min: 30, max: 180, default: 120 },
    stirring: { min: 400, max: 700, default: 500 },
    current: CURRENT_LIMITS,
  },
  separation: {
    timeMinutes: 60,
    speedRpm: 2600,
  },
  // Purification (dry wash with Magnesol or bentonite): fixed values, same as the backend's purification.py.
  // The heater switches off at 90 °C and comes back on at 89 °C (holdTemperature - holdBand) during
  // methanol removal. The drain has no time limit: it ends when the output is stable for 30 s.
  purification: {
    holdTemperature: 90,
    holdBand: 1,
    maximumTemperature: 95,
    heatingTimeoutMinutes: 25,
    stirringSpeedRpm: 200,
    drainStableGrams: 2,
    drainStableSeconds: 30,
    lowOutputFraction: 0.7,
  },
} as const;

const SAFETY_GROUPS = [
  {
    title: "Chemical Handling",
    items: [
      ["Methanol", "Toxic and highly flammable. Keep away from ignition sources and use suitable ventilation."],
      ["Sulfuric acid (H₂SO₄)", "Corrosive. Use appropriate chemical-resistant PPE and the approved dilution and handling procedure."],
      ["NaOH or KOH", "Corrosive alkaline catalysts. Handle according to the laboratory procedure."],
      ["Acetone", "Highly flammable. Keep away from ignition sources and use suitable ventilation."],
      ["Magnesol / bentonite", "Magnesol and bentonite are fine powders: wear a dust mask and avoid breathing the dust."],
      ["Chemical mixing", "Follow the validated order of addition. Do not mix incompatible chemicals or add chemicals without the approved procedure."],
      ["Containers", "Use compatible, closed, clearly labeled containers."],
    ],
  },
  {
    title: "Electrical and Process Safety",
    items: [
      ["Isolation", "Turn off and isolate the power supply before touching electrodes or reactor connections."],
      ["Electronics", "Keep electronics protected from spills, liquid, and chemical vapors."],
      ["Monitoring", "Monitor voltage, current, and temperature during the reaction."],
      ["Hot purification tank", "The purification tank gets hot (90 °C): don't touch it, keep the area ventilated, no flames nearby."],
      ["Attendance", "Never leave an operating batch unattended."],
      ["Interlocks", "Stop the process if an interlock or configured safety limit is triggered."],
    ],
  },
  {
    title: "Emergency Response",
    items: [
      ["Spills", "Follow the laboratory's chemical-specific spill response procedure."],
      ["Skin or eye contact", "Immediately use the appropriate emergency washing equipment and seek medical assistance."],
      ["Fire", "Activate the emergency procedure and use only an appropriate extinguisher if trained and safe to do so."],
      ["Emergency equipment", "Know the location of the emergency stop, eyewash, safety shower, and fire extinguisher."],
    ],
  },
];

/** Every operator input is a whole number (no decimals): 3, not 3.5. */
function wholeNumberError(
  t: TFunction,
  value: string,
  limits: { min: number; max: number },
  messages?: { empty?: string; min?: string; max?: string },
) {
  if (/[.,]/.test(value)) return t("Use a whole number (no decimals).");
  if (!value.trim() || !/^\d+$/.test(value.trim())) return messages?.empty ?? t("Enter a whole number.");
  const number = Number(value);
  if (number < limits.min) return messages?.min ?? t("Minimum value is {value}.", { value: limits.min });
  if (number > limits.max) return messages?.max ?? t("Maximum value is {value}.", { value: limits.max });
  return "";
}

/** onChange for a whole-number field: letters can't be typed. A decimal point can, so "2.5" is
 * shown with "Use a whole number" and blocks Continue, instead of silently turning into 25. */
function wholeInput(setValue: (value: string) => void) {
  return (event: { target: { value: string } }) => {
    if (/^[\d.,]*$/.test(event.target.value)) setValue(event.target.value);
  };
}

/** FFA input helper: accept only numeric typing that stays at or below the hard cap.
 * Decimal typing is still shown to validation when its numeric value is within range. */
function wholeInputMax(setValue: (value: string) => void, max: number) {
  return (event: { target: { value: string } }) => {
    const value = event.target.value;
    if (!/^[\d.,]*$/.test(value)) return;
    if (!value || /^[.,]$/.test(value)) { setValue(value); return; }
    const parsed = Number(value.replace(",", "."));
    if (Number.isFinite(parsed) && parsed <= max) setValue(value);
  };
}

/** A whole number from a stored value (older records and settings may have decimals). */
function whole(value: number) {
  return String(Math.round(value));
}

/** "3%": FFA is a whole percent (older decimal records still show their decimal). */
function pct(value: number) {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

/** A finite number for the saved record, so nothing is ever missing or NaN. */
function num(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function errorText(t: TFunction, error: unknown) {
  if (isOffline(error)) return t("Backend offline. Check that the Greenova backend is running.");
  return t(error instanceof Error ? error.message : String(error));
}

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem("greenova_settings") || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function settingNumber(settings: Record<string, unknown>, key: string, fallback: number, minimum = 0) {
  const value = settings[key];
  const parsed = Number(value);
  return value !== undefined && value !== null && value !== "" && Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function getChemistrySettings(): ChemistrySettings {
  const settings = readSettings();
  const positive = (key: string, fallback: number) => settingNumber(settings, key, fallback, Number.MIN_VALUE);
  return {
    oilMolarMass: positive("oilMolarMass", 880),
    // The accepted direct-transesterification limit is fixed at 3%, regardless of stale browser settings.
    ffaThreshold: 3,
    kohPurity: positive("kohPurity", 90),
    naohPurity: positive("naohPurity", 98),
    designFfa: positive("esterificationDesignFfa", 10),
    stripMaxFfa: 5,
    // Esterification re-check passes at 3% or below.
    ffaTarget: 3,
  };
}

/** Purification: the two editable times (Settings → Purification). There is no settling or cooling step. */
function getPurificationSettings() {
  const settings = readSettings();
  return {
    methanolRemovalMinutes: settingNumber(settings, "methanolRemovalTime", 10, 1),
    contactMinutes: settingNumber(settings, "contactTime", 10, 1),
  };
}

/** Dry wash adsorbent doses (Settings → Purification, % of the oil weight) and the default choice. */
function getAdsorbentSettings() {
  const settings = readSettings();
  const preferred = settings.defaultAdsorbent === "Bentonite" ? "Bentonite" : "Magnesol";
  return {
    magnesolDose: settingNumber(settings, "magnesolDose", 1, Number.MIN_VALUE),
    bentoniteDose: settingNumber(settings, "bentoniteDose", 2, Number.MIN_VALUE),
    defaultAdsorbent: preferred as Adsorbent,
    /** After a drain, the next stage starts by itself (Settings → Esterification and Dosing). */
    autoAdvance: settings.autoAdvance !== false,
  };
}

type AdsorbentSettings = ReturnType<typeof getAdsorbentSettings>;

function formatMinutes(seconds: number) {
  const minutes = seconds / 60;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} min`;
}

function formatTimer(totalSeconds: number) {
  const minutes = Math.floor(Math.max(totalSeconds, 0) / 60);
  const seconds = Math.max(totalSeconds, 0) % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

const METHANOL_DENSITY = 0.792;
const ACETONE_DENSITY = 0.784;

function adsorbentDose(adsorbent: Adsorbent, doses: AdsorbentSettings) {
  return adsorbent === "Bentonite" ? doses.bentoniteDose : doses.magnesolDose;
}

/** Dry wash adsorbent: oil mL × 0.92 × dose %, rounded to 0.1 g (same as the backend's adsorbent_g).
 * Magnesol 1% → oil mL × 0.0092 (500 mL → 4.6 g). Bentonite 2% → oil mL × 0.0184 (500 mL → 9.2 g). */
function adsorbentGrams(oilVolumeMl: number | null, adsorbent: Adsorbent, doses: AdsorbentSettings) {
  const fraction = (PROCESS_CONFIG.oil.densityGPerMl * adsorbentDose(adsorbent, doses)) / 100;
  return oilVolumeMl ? Math.round(oilVolumeMl * fraction * 10 + 1e-9) / 10 : 0;
}

/** One esterification stage (same rules as the backend's calculations.py). Stage 1 is the uniform
 * dose for the design FFA (default 10%), because the strip can't read above 5%. Later stages are
 * dosed for the re-check reading, at 40:1 methanol to FFA; the acetone from stage 1 is still there. */
function esterificationDose(
  oilMassG: number,
  oilVolumeMl: number | null,
  ffa: number,
  stage: number,
  settings: ChemistrySettings,
) {
  const doseFfa = stage === 1 ? settings.designFfa : ffa;
  const ffaMassG = oilMassG * (doseFfa / 100);
  const methanolMl = ffaMassG * (stage === 1 ? 2.84 : 5.68);
  const sulfuricAcidMl = ffaMassG * 0.027;
  const sulfuricAcidG = ffaMassG * 0.05;
  const acetoneMl = stage === 1 && oilVolumeMl !== null ? oilVolumeMl * 0.1 : 0;
  return {
    stage,
    doseFfa,
    uniform: stage === 1,
    ffaMassG,
    methanolMl,
    sulfuricAcidMl,
    sulfuricAcidG,
    acetoneMl,
    acetoneG: acetoneMl * ACETONE_DENSITY,
    // pump B premix: what the reactor load cell should gain
    premixMl: methanolMl + sulfuricAcidMl,
    premixG: methanolMl * METHANOL_DENSITY + sulfuricAcidG,
  };
}

/** Transesterification. acidPct = the last FFA re-check (exact), or the starting FFA. */
function transesterificationDose(
  oilMassG: number,
  oilVolumeMl: number | null,
  acidPct: number,
  ratio: number,
  catalyst: "NaOH" | "KOH",
  settings: ChemistrySettings,
) {
  const catalystBaseG = oilMassG * 0.01;
  const neutralizationG = oilMassG * (acidPct / 100) * (catalyst === "KOH" ? 0.199 : 0.142);
  const purity = catalyst === "KOH" ? settings.kohPurity : settings.naohPurity;
  const methanolMl = (oilMassG * ratio * 40.45) / settings.oilMolarMass;
  const catalystToWeighG = (catalystBaseG + neutralizationG) / (purity / 100);
  const acetoneMl = oilVolumeMl === null ? null : oilVolumeMl * 0.1;
  return {
    methanolMl,
    catalystBaseG,
    neutralizationG,
    catalystToWeighG,
    purity,
    acetoneMl,
    acetoneG: (acetoneMl ?? 0) * ACETONE_DENSITY,
    // pump A premix (the dissolved catalyst barely changes the volume)
    premixMl: methanolMl,
    premixG: methanolMl * METHANOL_DENSITY + catalystToWeighG,
  };
}

type EsterDose = ReturnType<typeof esterificationDose>;
type TransDose = ReturnType<typeof transesterificationDose>;

function calculateQuantityCards(
  oilMassG: number,
  oilVolumeMl: number | null,
  ffa: number,
  ratio: number,
  catalyst: "NaOH" | "KOH",
  settings: ChemistrySettings,
  adsorbent: Adsorbent,
  doses: AdsorbentSettings,
) {
  const esterificationNeeded = ffa > settings.ffaThreshold;
  const ester = esterificationDose(oilMassG, oilVolumeMl, ffa, 1, settings);
  // With esterification the catalyst is an "up to" amount (neutralizing the accepted 3% target); the
  // exact amount comes after the FFA re-check.
  const trans = transesterificationDose(oilMassG, oilVolumeMl, esterificationNeeded ? settings.ffaTarget : ffa, ratio, catalyst, settings);

  return {
    ffaMassG: ester.ffaMassG,
    doseFfa: ester.doseFfa,
    esterificationNeeded,
    esterificationMethanolMl: ester.methanolMl,
    sulfuricAcidMl: ester.sulfuricAcidMl,
    acetoneMl: oilVolumeMl === null ? null : oilVolumeMl * 0.1,
    esterificationPremixG: ester.premixG,
    transesterificationMethanolMl: trans.methanolMl,
    catalystBaseG: trans.catalystBaseG,
    neutralizationG: trans.neutralizationG,
    catalystToWeighG: trans.catalystToWeighG,
    purity: trans.purity,
    transesterificationPremixG: trans.premixG,
    adsorbentG: adsorbentGrams(oilVolumeMl, adsorbent, doses),
    adsorbentDosePct: adsorbentDose(adsorbent, doses),
  };
}

/** Local demonstration of the purification (no backend): same steps and rules as the Pi. */
type LocalPurification = {
  phase: PurificationPhase;
  temperature: number;
  highest: number;
  heaterOn: boolean;
  stirrerOn: boolean;
  heatingSeconds: number;
  methanolRemaining: number;
  magnesolAdded: boolean;
  contactRemaining: number;
  drainElapsed: number;
  stableSeconds: number;
  anchorG: number | null;
  outputG: number;
  tankG: number;
  oilG: number;
  warning: string | null;
  stopReason: string | null;
};

function stepLocalPurification(sim: LocalPurification) {
  const p = PROCESS_CONFIG.purification;
  const fault = (reason: string) => {
    sim.phase = "fault";
    sim.heaterOn = false;
    sim.stirrerOn = false;
    sim.stopReason = reason;
  };
  // the heater warms about 0.75 °C/s; without it the tank cools toward 27 °C
  sim.temperature = Number((sim.heaterOn ? sim.temperature + 0.75 : sim.temperature - (sim.temperature - 27) * 0.002).toFixed(2));
  sim.highest = Math.max(sim.highest, sim.temperature);
  if (sim.temperature > p.maximumTemperature) return fault(`temperature exceeded ${p.maximumTemperature} °C`);
  if (sim.phase === "heating") {
    sim.heatingSeconds += 1;
    if (sim.temperature >= p.holdTemperature) {
      sim.heaterOn = false; // 90 °C reached: heater off, then methanol removal at 90 °C
      sim.phase = "methanol";
    } else if (sim.heatingSeconds >= p.heatingTimeoutMinutes * 60) fault(`${p.holdTemperature} °C not reached within ${p.heatingTimeoutMinutes} min`);
  } else if (sim.phase === "methanol") {
    if (sim.temperature >= p.holdTemperature) sim.heaterOn = false;
    else if (sim.temperature <= p.holdTemperature - p.holdBand) sim.heaterOn = true;
    sim.methanolRemaining = Math.max(sim.methanolRemaining - 1, 0);
    if (sim.methanolRemaining === 0) {
      sim.heaterOn = false;
      sim.phase = "magnesol";
    }
  } else if (sim.phase === "magnesol") {
    if (sim.magnesolAdded) sim.phase = "contact";
  } else if (sim.phase === "contact") {
    // stirred with the heater off: the biodiesel cools down
    sim.contactRemaining = Math.max(sim.contactRemaining - 1, 0);
    if (sim.contactRemaining === 0) {
      sim.stirrerOn = false;
      sim.phase = "drain"; // no settling, no cooling: the outlet opens right away
    }
  } else if (sim.phase === "drain") {
    const moved = Math.min(sim.tankG, 3); // about 3 g/s through the outlet and filter
    sim.tankG -= moved;
    sim.outputG = Number((sim.outputG + moved).toFixed(1));
    sim.drainElapsed += 1;
    if (sim.anchorG !== null && Math.abs(sim.outputG - sim.anchorG) <= p.drainStableGrams) sim.stableSeconds += 1;
    else {
      sim.anchorG = sim.outputG;
      sim.stableSeconds = 0;
    }
    // done only when the output load cell has been stable for 30 s (no time limit)
    const started = sim.outputG > p.drainStableGrams;
    if (started && sim.stableSeconds >= p.drainStableSeconds) {
      sim.phase = "complete";
      if (sim.oilG > 0 && sim.outputG < p.lowOutputFraction * sim.oilG) {
        sim.warning = `Low output – check the polishing filter. ${sim.outputG.toFixed(0)} g collected from ${sim.oilG.toFixed(0)} g of oil.`;
      }
    }
  }
}

function SectionHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div>
      <div className="section-kicker">{eyebrow}</div>
      <Heading as="h1" className="mt-2 text-3xl font-bold tracking-tight">
        {title}
      </Heading>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-500">{description}</p>
    </div>
  );
}

function StateDot({ state }: { state: DeviceState }) {
  const color =
    state === "ready"
      ? "bg-gv-green"
      : state === "checking"
        ? "bg-amber-400"
        : "bg-red-500";
  return <span className={`h-2 w-2 shrink-0 rounded-full ${color}`} />;
}

function ReadOnlyTile({
  label,
  value,
  secondary,
  state = "ready",
}: {
  label: string;
  value: string;
  secondary?: string;
  state?: DeviceState;
}) {
  const t = useT();
  const stateLabel = state === "ready" ? t("ready") : state === "checking" ? t("checking") : t("fault");
  return (
    <div className="rounded-xl border border-white/[0.07] bg-gv-inset p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="gv-label !mb-0">{t(label)}</div>
        <div className="flex items-center gap-2">
          <StateDot state={state} />
          <span className="text-[9px] font-bold uppercase tracking-wider text-gray-500">
            {stateLabel}
          </span>
        </div>
      </div>
      <div className="mt-3 font-display text-base font-semibold text-white">{t(value)}</div>
      {secondary && <div className="mt-1 text-xs leading-5 text-gray-500">{t(secondary)}</div>}
    </div>
  );
}

function Stepper({ steps, step }: { steps: string[]; step: number }) {
  const t = useT();
  return (
    <Card className="overflow-x-auto p-4 sm:p-5">
      <div className="flex min-w-[900px] items-start">
        {steps.map((label, index) => {
          const active = step === index;
          const complete = step > index;
          return (
            <div key={label} className="relative flex flex-1 flex-col items-center text-center">
              {index < steps.length - 1 && (
                <div
                  className={`absolute left-1/2 top-4 h-px w-full ${
                    complete ? "bg-green-500/60" : "bg-white/[0.08]"
                  }`}
                />
              )}
              <div
                className={`relative z-10 flex h-8 w-8 items-center justify-center rounded-full border text-xs font-semibold ${
                  complete
                    ? "border-green-500 bg-green-500 text-black"
                    : active
                      ? "border-green-400 bg-green-500/15 text-green-400 ring-4 ring-green-500/[0.06]"
                      : "border-white/10 bg-gv-surface text-gray-600"
                }`}
              >
                {complete ? "✓" : String(index + 1).padStart(2, "0")}
              </div>
              <div
                className={`mt-2 max-w-24 text-[10px] font-medium leading-4 ${
                  active ? "text-white" : complete ? "text-green-400" : "text-gray-600"
                }`}
              >
                {t(label)}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function ParameterField({
  label,
  value,
  setValue,
  unit,
  limits,
}: {
  label: string;
  value: string;
  setValue: (value: string) => void;
  unit: string;
  limits: { min: number; max: number };
}) {
  const t = useT();
  const error = wholeNumberError(t, value, limits);
  return (
    <div>
      <Field
        label={t(label)}
        inputMode="numeric"
        pattern="[0-9]*"
        value={value}
        onChange={wholeInput(setValue)}
        unit={unit}
        aria-invalid={Boolean(error)}
      />
      <p className={`mt-2 text-xs ${error ? "text-red-400" : "text-gray-600"}`}>
        {error || t("Allowed range: {min}–{max} {unit}", { min: limits.min, max: limits.max, unit })}
      </p>
    </div>
  );
}

function StageControls({
  state,
  setState,
  startLabel,
  onContinue,
  continueLabel,
  onReset,
  error,
  startBlocked,
  hideContinue = false,
  hideStart = false,
}: {
  state: StageState;
  setState: (state: StageState) => void;
  startLabel: string;
  onContinue: () => void;
  continueLabel: string;
  onReset?: () => void;
  error?: string | null;
  /** Why the stage can't start yet, or nothing. */
  startBlocked?: string | null;
  hideContinue?: boolean;
  /** The stage starts by itself (once the dose is in): no Start button. */
  hideStart?: boolean;
}) {
  const t = useT();
  if ((state === "complete" && hideContinue) || (state === "ready" && hideStart)) {
    return error ? <p className="mt-3 text-xs text-red-400">{error}</p> : null;
  }
  return (
    <>
    <div className="mt-7 flex flex-wrap items-center gap-3">
      {state === "ready" && <Button disabled={Boolean(startBlocked)} onClick={() => setState("running")}>{startLabel}</Button>}
      {state === "ready" && startBlocked && <span className="text-xs text-amber-400">{startBlocked}</span>}
      {state === "running" && (
        <>
          <Button variant="secondary" onClick={() => setState("paused")}>{t("Pause")}</Button>
          <Button variant="secondary" onClick={() => setState("complete")}>{t("Record completion")}</Button>
        </>
      )}
      {state === "paused" && (
        <>
          <Button onClick={() => setState("running")}>{t("Resume")}</Button>
          <Button variant="secondary" onClick={() => setState("complete")}>{t("Record completion")}</Button>
        </>
      )}
      {state === "complete" && <Button onClick={onContinue}>{continueLabel} →</Button>}
      {(state === "running" || state === "paused") && (
        <Button variant="danger" onClick={() => setState("fault")}>{t("Emergency stop")}</Button>
      )}
      {state === "fault" && <Status tone="red">{t("Fault — controller reset required")}</Status>}
      {state === "fault" && onReset && <Button variant="secondary" onClick={onReset}>{t("Reset controller")}</Button>}
    </div>
    {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
    </>
  );
}

const PUMP_INFO: Record<PumpName, { label: string; tank: string }> = {
  catalyst: { label: "Pump A · NaOH/KOH + methanol", tank: "A" },
  acid: { label: "Pump B · H₂SO₄ + methanol", tank: "B" },
  oil: { label: "Oil pump", tank: "Oil" },
};

/** Oil Loading with the automated oil input: the oil pump loads the target (by the reactor load
 * cell, or by time at the pump's rate without one). */
function OilPumpPanel({
  targetG,
  volumeMl,
  deliveredG,
  run,
  loaded,
  onStart,
  onStop,
  onSkip,
}: {
  targetG: number;
  volumeMl: number;
  /** Grams the oil pump has loaded so far (all runs). */
  deliveredG: number;
  run: PumpView | null;
  loaded: boolean;
  onStart: () => void;
  onStop: () => void;
  onSkip?: () => void;
}) {
  const t = useT();
  const pumping = run?.phase === "pumping";
  const problem = !loaded && !pumping && run !== null && (run.phase === "fault" || run.phase === "stopped");
  const started = deliveredG > 0.5;
  return (
    <div className="mt-6 rounded-xl border border-white/[0.07] bg-gv-inset p-5" data-testid="oil-pump">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="gv-label">{t("Oil pump")}</div>
        <Status tone={loaded ? "green" : problem ? "red" : pumping ? "blue" : "yellow"}>
          {loaded ? t("Oil loaded") : problem ? (run?.phase === "stopped" ? t("Stopped") : t("Pump problem")) : pumping ? t("Loading oil") : t("Ready to load")}
        </Status>
      </div>
      <div className="mt-3 flex items-baseline justify-between gap-3 text-sm">
        <span className="text-gray-300">{t("{volume} mL of oil into the reactor", { volume: volumeMl })}{run?.byTime ? ` · ${t("by time (no reactor load cell)")}` : ""}</span>
        <span className="font-mono text-white">{Math.min(deliveredG, targetG).toFixed(1)} / {targetG.toFixed(1)} g</span>
      </div>
      <div className="mt-2"><Progress value={targetG > 0 ? (deliveredG / targetG) * 100 : 0} /></div>
      {problem && run?.faultReason && <p className="mt-3 text-sm text-red-400">{t(run.faultReason)}</p>}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {!loaded && !pumping && (
          <Button onClick={onStart}>{started ? t("Continue loading") : t("Start oil pump")}</Button>
        )}
        {pumping && <Button variant="secondary" onClick={onStop}>{t("Stop")}</Button>}
        {pumping && onSkip && <Button variant="secondary" onClick={onSkip}>{t("Skip (demo)")}</Button>}
        {!loaded && !pumping && !started && <span className="text-xs text-gray-500">{t("Check the oil tank and the line to the reactor, then start the pump.")}</span>}
      </div>
    </div>
  );
}

type PumpView = { phase: PumpPhase; deliveredG: number; faultReason: string | null; byTime: boolean };

/** Before a reaction stage: the pump loads the dose by itself (by the reactor load cell), the
 * acetone is optional: the operator can pour it or explicitly continue without it. */
function LoadingPanel({
  pump,
  premixParts,
  targetG,
  run,
  deliveredG,
  onRetry,
  onSkip,
  acetone,
  current,
  currentByHand,
  status,
}: {
  pump: PumpName;
  premixParts: string[];
  targetG: number;
  /** The pump run for this dose, when one is running or just ended. */
  run: PumpView | null;
  /** Grams this dose has received so far (all runs). */
  deliveredG: number;
  onRetry: () => void;
  onSkip?: () => void;
  acetone?: { ml: number; g: number; addedG: number; skipped: boolean; onSkip: () => void; onDemoAdd?: () => void } | null;
  current: number;
  /** No current control on the Pi: the operator sets the power supply's current. */
  currentByHand: boolean;
  /** loading: the stage starts by itself once loaded; loaded: start it with the button. */
  status: "loading" | "starting" | "loaded";
}) {
  const t = useT();
  const info = PUMP_INFO[pump];
  const pumping = run?.phase === "pumping";
  const loaded = deliveredG >= targetG - 1;
  const problem = !loaded && !pumping && run !== null && (run.phase === "fault" || run.phase === "stopped");
  return (
    <div className="mt-6 rounded-xl border border-white/[0.07] bg-gv-inset p-5" data-testid={`dosing-${pump}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="gv-label">{t("Loading the reactor")}</div>
        <Status tone={problem ? "red" : status === "loading" ? "blue" : "green"}>
          {problem ? t("Pump problem") : status === "starting" ? t("Starting…") : status === "loaded" ? t("Dose loaded") : t("Starts by itself when loaded")}
        </Status>
      </div>
      <div className="mt-3 space-y-4">
        <div>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="text-gray-300">{t(info.label)} <span className="text-xs text-gray-500">({premixParts.join(" + ")})</span></span>
            <span className="font-mono text-white">{deliveredG.toFixed(1)} / {targetG.toFixed(1)} g</span>
          </div>
          <div className="mt-2"><Progress value={targetG > 0 ? (deliveredG / targetG) * 100 : 0} /></div>
          {problem && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <span className="text-sm font-semibold text-red-400">{t("Pump problem – check the line")}</span>
              <Button variant="secondary" onClick={onRetry}>{t("Retry")}</Button>
            </div>
          )}
          {pumping && onSkip && <Button variant="secondary" className="mt-3" onClick={onSkip}>{t("Skip (demo)")}</Button>}
        </div>
        {acetone && (
          // The pump doses by the reactor's weight gain, so nothing may be poured in while it runs.
          loaded ? (
            <div>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-gray-300">{t("Optional acetone: pour {ml} mL through the inlet", { ml: acetone.ml.toFixed(1) })}</span>
                <span className="font-mono text-white">{acetone.addedG.toFixed(1)} / {acetone.g.toFixed(1)} g</span>
              </div>
              <div className="mt-2"><Progress value={acetone.g > 0 ? (acetone.addedG / acetone.g) * 100 : 100} /></div>
              <div className="mt-3 flex flex-wrap gap-3">
                {acetone.onDemoAdd && acetone.addedG < acetone.g * 0.95 && !acetone.skipped && (
                  <Button variant="secondary" onClick={acetone.onDemoAdd}>{t("Pour acetone (demo)")}</Button>
                )}
                {acetone.addedG < acetone.g * 0.95 && !acetone.skipped && (
                  <Button variant="secondary" onClick={acetone.onSkip}>{t("Continue without acetone")}</Button>
                )}
                {acetone.skipped && <span className="self-center text-sm text-gray-500">{t("Continuing without acetone")}</span>}
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-500">{t("Acetone is optional. After the pump finishes, add it if you are using it, or continue without it.")}</p>
          )
        )}
      </div>
    </div>
  );
}

/** A transfer outlet as the page shows it: open, closed, or about to open (the centrifuge outlet
 * waits for the centrifuge to stop). There is no drain time: an outlet opens when its process
 * finishes, the next process starts right away, and every valve closes when the batch is complete. */
type ValveView = "open" | "closed" | "waiting";

const DRAIN_INFO: Record<DrainValve, { label: string; to: string }> = {
  reactor_outlet: { label: "Reactor outlet valve", to: "flowing to the centrifuge" },
  centrifuge_outlet: { label: "Centrifuge outlet valve", to: "flowing to the purification tank" },
};

/** An outlet valve that opens by itself: only an Open / Closed indicator. */
function ValveIndicator({ valve, view }: { valve: DrainValve; view: ValveView }) {
  const t = useT();
  const info = DRAIN_INFO[valve];
  const open = view === "open";
  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.07] bg-gv-inset px-5 py-4" data-testid={`valve-${valve}`}>
      <div className="text-sm text-gray-300">
        <span className="font-semibold text-white">{t(info.label)}</span>
        {open && <span> · {t(info.to)} · {t("stays open until the batch is complete")}</span>}
        {view === "waiting" && <span> · {t("waiting for the centrifuge to stop")}</span>}
      </div>
      <Status tone={open ? "green" : view === "waiting" ? "yellow" : "neutral"}>{open ? t("OPEN") : t("CLOSED")}</Status>
    </div>
  );
}

/** After an esterification stage: the FFA re-check with a new strip decides what comes next. */
function RecheckPanel({
  stage,
  value,
  setValue,
  aboveStrip,
  setAboveStrip,
  settings,
  next,
  catalyst,
  onAnotherStage,
  onContinue,
}: {
  stage: number;
  value: string;
  setValue: (value: string) => void;
  aboveStrip: boolean;
  setAboveStrip: (value: boolean) => void;
  settings: ChemistrySettings;
  next: { ffa: number; ester: EsterDose; trans: TransDose } | null;
  catalyst: "NaOH" | "KOH";
  onAnotherStage: () => void;
  onContinue: () => void;
}) {
  const t = useT();
  const error = aboveStrip ? "" : wholeNumberError(t, value, { min: 0, max: settings.stripMaxFfa }, {
    empty: t("Enter the re-check FFA."),
    max: t("The strip reads up to {max}%. Tick the darkest color instead.", { max: settings.stripMaxFfa }),
  });
  const done = next !== null && next.ffa <= settings.ffaTarget;
  return (
    <div className="mt-6 rounded-xl border border-green-500/20 bg-green-500/[0.03] p-5" data-testid="ffa-recheck">
      <div className="gv-label">{t("FFA re-check after stage {stage}", { stage })}</div>
      <p className="text-sm text-gray-300">{t("Test a sample from the oil layer with a new strip. At or below {target}%, go on to transesterification; above it, run another esterification stage.", { target: settings.ffaTarget })}</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <Field label={t("FFA after esterification (0–5%)")} inputMode="numeric" pattern="[0-9]*" max={5} value={aboveStrip ? "5" : value} disabled={aboveStrip} onChange={wholeInputMax(setValue, 5)} unit="%" aria-invalid={Boolean(error) && value !== ""} />
          {error && value !== "" && <p className="mt-2 text-xs text-red-400">{error}</p>}
        </div>
        <label className="flex items-center gap-2 self-end pb-3 text-sm text-gray-300">
          <input className="gv-checkbox" type="checkbox" checked={aboveStrip} onChange={(event) => setAboveStrip(event.target.checked)} />
          {t("Still the darkest color ({max}% or more)", { max: settings.stripMaxFfa })}
        </label>
      </div>
      {next && !error && (
        done ? (
          <div className="mt-4 rounded-xl border border-green-500/20 bg-green-500/[0.05] p-4 text-sm text-green-400">
            {t("FFA {ffa}% is at or below {target}%. Transesterification uses the exact amount: {grams} g {catalyst}.", { ffa: next.ffa, target: settings.ffaTarget, grams: next.trans.catalystToWeighG.toFixed(2), catalyst })}
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-amber-400/25 bg-amber-400/[0.05] p-4 text-sm text-amber-400">
            {t("FFA is still above {target}%. Stage {stage}: {methanol} mL methanol (40:1) + {acid} mL H₂SO₄, dosed for {dose}% FFA. No more acetone.", { target: settings.ffaTarget, stage: stage + 1, methanol: next.ester.methanolMl.toFixed(1), acid: next.ester.sulfuricAcidMl.toFixed(2), dose: next.ester.doseFfa })}
            {aboveStrip && <span className="mt-1 block text-xs">{t("The oil may have more than {design}% FFA. Stage {stage} is dosed for {design}% again.", { design: settings.designFfa, stage: stage + 1 })}</span>}
            {stage >= 3 && <span className="mt-1 block text-xs">{t("Several stages haven't brought the FFA down. Consider checking the strip, the reaction time, or using a different feedstock.")}</span>}
          </div>
        )
      )}
      <div className="mt-4 flex flex-wrap gap-3">
        {done && <Button onClick={onContinue}>{t("Continue to Transesterification")} →</Button>}
        {next && !error && !done && <Button onClick={onAnotherStage}>{t("Prepare esterification stage {stage}", { stage: stage + 1 })} →</Button>}
      </div>
    </div>
  );
}

/** Live readings of a running stage: only these, nothing else. */
function LiveReadings({ children, source, progress, fault }: { children: ReactNode; source: string; progress?: number; fault?: string | null }) {
  const t = useT();
  return (
    <div className="mt-6 rounded-xl border border-white/[0.07] bg-gv-inset p-5" data-testid="live-readings">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="gv-label !mb-0">{t("Live monitoring")}</div>
        <span className="text-xs text-gray-500">{t(source)}</span>
      </div>
      <div className="grid gap-5 sm:grid-cols-3 lg:grid-cols-5">{children}</div>
      {progress !== undefined && <div className="mt-5"><Progress value={progress} /></div>}
      {fault && <p className="mt-4 text-sm text-red-400">{t("Stopped:")} {t(fault)}</p>}
    </div>
  );
}

function ReactionStage({
  kind,
  state,
  setState,
  oilMass,
  oilVolume,
  catalyst,
  ratio,
  esterDose,
  transDose,
  transExact,
  esterStage = 1,
  voltage,
  current,
  time,
  stirring,
  batchId,
  onContinue,
  liveStage,
  sourceLabel,
  onReset,
  error,
  preparation,
  footer,
  startBlocked,
  hideContinue,
  hideStart,
}: {
  kind: "Esterification" | "Transesterification";
  state: StageState;
  setState: (state: StageState) => void;
  oilMass: number;
  oilVolume: number | null;
  catalyst: "NaOH" | "KOH";
  ratio: number;
  esterDose: EsterDose;
  transDose: TransDose;
  /** The catalyst amount is exact (after the FFA re-check, or without esterification). */
  transExact: boolean;
  esterStage?: number;
  voltage: number;
  current: number;
  time: number;
  stirring: number;
  batchId: string;
  onContinue: () => void;
  liveStage: StageStatus | null;
  sourceLabel: string;
  onReset?: () => void;
  error?: string | null;
  /** Loading the reactor (shown before the stage starts). */
  preparation?: ReactNode;
  /** Shown under the controls: the FFA re-check, or the reactor outlet. */
  footer?: ReactNode;
  startBlocked?: string | null;
  hideContinue?: boolean;
  hideStart?: boolean;
}) {
  const t = useT();
  const isEsterification = kind === "Esterification";
  const totalSeconds = time * 60;
  const elapsedSeconds = liveStage
    ? liveStage.elapsedSeconds
    : (state === "ready" ? 0 : state === "complete" ? time : Math.min(42, time)) * 60;
  const remainingSeconds = liveStage ? liveStage.remainingSeconds : Math.max(totalSeconds - elapsedSeconds, 0);
  const title = isEsterification && esterStage > 1 ? t("Esterification · stage {stage}", { stage: esterStage }) : t(kind);
  const running = state === "running" || state === "paused" || state === "fault";
  const stateLabel = { ready: "READY", running: "RUNNING", paused: "PAUSED", complete: "COMPLETE", fault: "FAULT" }[state];
  return (
    <Card className="p-6 sm:p-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <SectionHeader
          eyebrow={t("Batch {id}", { id: batchId })}
          title={title}
          description={
            isEsterification
              ? esterStage > 1
                ? t("FFA was still above 3% after the last stage: another acid stage, dosed for the re-check reading.")
                : t("Acid pretreatment of high-FFA feedstock before transesterification. The dose is the same for every oil above 3% FFA.")
              : t("Base-catalyzed conversion of the prepared oil into biodiesel.")
          }
        />
        <Status
          tone={
            state === "complete"
              ? "green"
              : state === "fault"
                ? "red"
                : state === "paused"
                  ? "yellow"
                  : "blue"
          }
        >
          {t(stateLabel)}
        </Status>
      </div>

      {state === "ready" && (
        <>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="p-5"><Metric label={t("Oil in this batch")} value={`${oilMass.toFixed(1)} g`} sub={oilVolume === null ? t("Volume unavailable") : t("{ml} mL · recorded at oil loading", { ml: oilVolume.toFixed(1) })} /></Card>
            <Card className="p-5">
              <Metric
                label={t("Methanol")}
                value={`${(isEsterification ? esterDose.methanolMl : transDose.methanolMl).toFixed(1)} mL`}
                sub={isEsterification ? t("{ratio} methanol to FFA · dose for {dose}% FFA", { ratio: esterStage === 1 ? "20:1" : "40:1", dose: esterDose.doseFfa }) : t("{ratio}:1 molar ratio · calculated", { ratio })}
              />
            </Card>
            {isEsterification ? (
              <Card className="p-5"><Metric label={t("Sulfuric acid (H₂SO₄)")} value={`${esterDose.sulfuricAcidMl.toFixed(2)} mL`} sub={t("98% · 5% of the dose's FFA weight · mixed into the methanol")} /></Card>
            ) : (
              <Card className="p-5"><Metric label={t("{catalyst} to weigh", { catalyst })} value={`${transExact ? "" : t("Up to") + " "}${transDose.catalystToWeighG.toFixed(2)} g`} sub={t("{base} g catalyst + {neutral} g to neutralize · {purity}% purity", { base: transDose.catalystBaseG.toFixed(1), neutral: transDose.neutralizationG.toFixed(2), purity: transDose.purity }) + (transExact ? ` · ${t("exact")}` : "")} /></Card>
            )}
            <Card className="p-5">
              <Metric
                label={t("Acetone")}
                value={isEsterification && esterStage > 1 ? t("None") : transDose.acetoneMl === null ? t("Unavailable") : `${(isEsterification ? esterDose.acetoneMl : transDose.acetoneMl).toFixed(1)} mL`}
                sub={isEsterification && esterStage > 1 ? t("Still in the reactor from stage 1") : t("Provisional 10% · poured by hand through the inlet")}
              />
            </Card>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="p-5"><Metric label={t("Voltage setting")} value={`${voltage} V`} /></Card>
            <Card className="p-5"><Metric label={t("Current setting")} value={`${current} A`} /></Card>
            <Card className="p-5"><Metric label={t("Reaction time")} value={`${time} min`} /></Card>
            <Card className="p-5"><Metric label={t("Stirring speed")} value={`${stirring} RPM`} /></Card>
          </div>
          {preparation}
        </>
      )}

      {running && (
        <LiveReadings source={sourceLabel} progress={(elapsedSeconds / totalSeconds) * 100} fault={liveStage?.faultReason}>
          <Metric label={t("Time remaining")} value={liveStage ? formatTimer(remainingSeconds) : `${Math.round(remainingSeconds / 60)} min`} />
          <Metric label={t("Voltage")} value={liveStage ? (liveStage.liveVoltage == null ? "—" : `${liveStage.liveVoltage.toFixed(1)} V`) : state === "running" ? `${voltage} V` : "0 V"} />
          <Metric label={t("Current")} value={liveStage ? (liveStage.liveCurrent == null ? "—" : `${liveStage.liveCurrent.toFixed(2)} A`) : state === "running" ? `${(current * 0.9).toFixed(2)} A` : "0 A"} sub={t("limit {amps} A", { amps: current })} />
          <Metric label={t("Stirrer")} value={liveStage ? (liveStage.liveRpm == null ? "—" : `${liveStage.liveRpm} RPM`) : state === "running" ? `${stirring} RPM` : "0 RPM"} />
          <Metric label={t("Temperature")} value={liveStage ? (liveStage.liveTemperature == null ? "—" : `${liveStage.liveTemperature.toFixed(1)} °C`) : "27 °C"} />
        </LiveReadings>
      )}
      <StageControls
        state={state}
        setState={setState}
        startLabel={isEsterification && esterStage > 1 ? t("Start esterification stage {stage}", { stage: esterStage }) : t("Start {stage}", { stage: t(kind) })}
        onContinue={onContinue}
        continueLabel={isEsterification ? t("Continue to Transesterification") : t("Continue to Separation")}
        onReset={onReset}
        error={error}
        startBlocked={startBlocked}
        hideContinue={hideContinue}
        hideStart={hideStart}
      />
      {footer}
    </Card>
  );
}

type LocalPump = { key: string; pump: PumpName; base: number; targetG: number; deliveredG: number; phase: PumpPhase; faultReason: string | null };
/** Local demonstration: which transfer outlets are open (they stay open until the batch is complete). */
type LocalValves = Record<DrainValve, boolean>;
const ALL_CLOSED: LocalValves = { reactor_outlet: false, centrifuge_outlet: false };
type DoseLoad = { completedG: number };

/** What the Purification screen shows, from the Pi or from the local demonstration. */
type PurificationView = {
  phase: PurificationPhase;
  temperature: number | null;
  highest: number | null;
  heaterOn: boolean;
  stirrerOn: boolean;
  stirrerRpm: number | null;
  valveOpen: boolean;
  stepRemaining: number | null;
  outputG: number;
  oilG: number | null;
  /** Amount of the dry wash adsorbent (Magnesol or bentonite), g. */
  magnesolG: number | null;
  adsorbent: Adsorbent;
  warning: string | null;
  stopReason: string | null;
  stopOccurred: boolean;
  automatic: boolean;
  heatingSeconds: number;
  methanolSeconds: number;
  contactSeconds: number;
  drainSeconds: number;
  /** Seconds the output load cell has stayed within ±2 g while draining (done at 30). */
  stableSeconds: number;
};

const READY_PURIFICATION: PurificationView = {
  phase: "ready", temperature: null, highest: null, heaterOn: false, stirrerOn: false, stirrerRpm: null,
  valveOpen: false, stepRemaining: null, outputG: 0, oilG: null, magnesolG: null, adsorbent: "Magnesol", warning: null, stopReason: null,
  stopOccurred: false, automatic: true, heatingSeconds: 0, methanolSeconds: 0, contactSeconds: 0,
  drainSeconds: 0, stableSeconds: 0,
};

const PURIFICATION_STEPS: Array<[PurificationPhase, string]> = [
  ["heating", "Heating"],
  ["methanol", "Methanol removal"],
  ["magnesol", "Add adsorbent"],   // shown as "Add Magnesol" or "Add Bentonite"
  ["contact", "Contact"],
  ["drain", "Draining"],
  ["complete", "Done"],
];

/** Everything this page knows about the batch in progress. It is saved while the batch runs
 * (on the Raspberry Pi, or in this browser offline), so the batch is continued where it was after
 * leaving the page, a reload, or on another device, instead of being started again. */
type ProcessSnapshot = {
  version: 1;
  step: number;
  stage: string;
  reactorG: number;
  confirmedOilG: number | null;
  targetVolume: string;
  ffa: string;
  ffaAboveStrip: boolean;
  esterStage: number;
  esterRecords: EsterStageRecord[];
  nextDoseFfa: number | null;
  recheckValue: string;
  recheckAbove: boolean;
  finalFfa: number | null;
  loads: Record<string, DoseLoad>;
  acetoneBase: Record<string, number>;
  acetoneSkipped: Record<string, boolean>;
  adsorbent: Adsorbent;
  ratio: number;
  catalyst: "NaOH" | "KOH";
  esterVoltage: string;
  esterTime: string;
  esterStirring: string;
  esterCurrent: string;
  transVoltage: string;
  transTime: string;
  transStirring: string;
  transCurrent: string;
  esterState: StageState;
  transState: StageState;
  separationState: StageState;
  separationWaitOver: boolean;
  purification: PurificationView;
  heaterConfirmed: boolean;
  // what already happened by itself, so it isn't done twice (a pump run counted, a dose loaded, ...)
  accountedRuns: string[];
  autoPumped: string[];
  autoStageStarted: string[];
  autoStarted: boolean;
  autoSeparation: boolean;
  // the local demonstration (no backend)
  localPump: LocalPump | null;
  localValves: LocalValves;
  localPurification: LocalPurification | null;
};

export default function NewBatch() {
  const t = useT();
  const [step, setStep] = useState(0);
  // Reactor load cell: the oil, then everything poured or pumped in (live, or the local demo).
  const [reactorG, setReactorG] = useState(0);
  // The oil weight recorded when the oil loading is confirmed; the calculations use it from then on.
  const [confirmedOilG, setConfirmedOilG] = useState<number | null>(null);
  const [targetVolume, setTargetVolume] = useState("2000");
  const [ffa, setFfa] = useState("");
  // The strip shows its darkest color: FFA is at least the strip's maximum (5%).
  const [ffaAboveStrip, setFfaAboveStrip] = useState(false);
  // Esterification stages and the FFA re-check after each one
  const [esterStage, setEsterStage] = useState(1);
  const [esterRecords, setEsterRecords] = useState<EsterStageRecord[]>([]);
  const [nextDoseFfa, setNextDoseFfa] = useState<number | null>(null);
  const [recheckValue, setRecheckValue] = useState("");
  const [recheckAbove, setRecheckAbove] = useState(false);
  const [finalFfa, setFinalFfa] = useState<number | null>(null);
  // Dosing pumps: what each dose ("Esterification 1", "Transesterification") has received
  const [loads, setLoads] = useState<Record<string, DoseLoad>>({});
  // Pump runs on the Pi already added to their dose (by start time), so none is counted twice
  const accountedRuns = useRef(new Set<string>());
  const autoPumped = useRef(new Set<string>());
  const autoStageStarted = useRef(new Set<string>());
  const [localPump, setLocalPump] = useState<LocalPump | null>(null);
  // Local demonstration: the transfer outlets (open from the end of their process until the batch is complete)
  const [localValves, setLocalValves] = useState<LocalValves>(ALL_CLOSED);
  // Reactor weight when each dose's step opened, to show the acetone poured since.
  const [acetoneBase, setAcetoneBase] = useState<Record<string, number>>({});
  // Acetone remains available, but each reaction stage can explicitly continue without it.
  const [acetoneSkipped, setAcetoneSkipped] = useState<Record<string, boolean>>({});
  const purificationSettings = useMemo(getPurificationSettings, []);
  const adsorbentSettings = useMemo(getAdsorbentSettings, []);
  // Dry wash adsorbent for this batch: Magnesol or bentonite (Volume & Parameters → Purification)
  const [adsorbent, setAdsorbent] = useState<Adsorbent>(adsorbentSettings.defaultAdsorbent);
  const [ratio, setRatio] = useState(7);
  const [catalyst, setCatalyst] = useState<"NaOH" | "KOH">("NaOH");
  const [esterVoltage, setEsterVoltage] = useState("20");
  const [esterTime, setEsterTime] = useState("120");
  const [esterStirring, setEsterStirring] = useState("500");
  const [esterCurrent, setEsterCurrent] = useState(String(CURRENT_LIMITS.default));
  const [transVoltage, setTransVoltage] = useState("30");
  const [transTime, setTransTime] = useState("120");
  const [transStirring, setTransStirring] = useState("500");
  const [transCurrent, setTransCurrent] = useState(String(CURRENT_LIMITS.default));
  const [esterState, setEsterState] = useState<StageState>("ready");
  const [transState, setTransState] = useState<StageState>("ready");
  const [separationState, setSeparationState] = useState<StageState>("ready");
  const [purification, setPurification] = useState<PurificationView>(READY_PURIFICATION);
  const localPurification = useRef<LocalPurification | null>(null);
  const autoStarted = useRef(false);
  const [heaterConfirmed, setHeaterConfirmed] = useState(false); // only used without a level switch
  const [saved, setSaved] = useState(false);
  // The Pi refused the batch record: offer to retry, or to keep it in this browser and finish.
  const [saveFailed, setSaveFailed] = useState(false);
  const { live, backend, mock, connecting } = useLiveData();
  // Real machine without a reactor load cell (hardware.toml): the oil is measured by volume, the
  // operator confirms it was poured, and the pumps dose by time.
  const byVolume = Boolean(backend && !mock && live?.sensors.loadCellsFitted?.reactor === false);
  const [oilPouredByVolume, setOilPouredByVolume] = useState(false);
  // Automated oil input: the oil pump loads the oil on the Oil Loading step (the local
  // demonstration has one too). Before the oil is in, the quantities use the target volume.
  const oilPumpFitted = backend ? Boolean(live && "oil" in (live.sensors.pumps ?? {})) : true;
  const plannedOilG = /^\d+$/.test(targetVolume) ? Number(targetVolume) * PROCESS_CONFIG.oil.densityGPerMl : 0;
  const oilMassG = confirmedOilG ?? (oilPumpFitted ? plannedOilG : reactorG);
  const navigate = useNavigate();
  const [actionError, setActionError] = useState<string | null>(null);
  const [savedBatch, setSavedBatch] = useState<BatchRecord | null>(null);
  // When the process was completed: captured once, when the batch is saved, and only shown after
  // (never the current time, which would keep changing as the page updates).
  const [completedAt, setCompletedAt] = useState<Date | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [batchId, setBatchId] = useState(() => `B-${new Date().getFullYear()}-${String(Date.now()).slice(-3)}`);
  const [processConfigCurrentControl, setProcessConfigCurrentControl] = useState(false);
  // Process handoffs continue automatically after each transfer; autoAdvance is a legacy DB field.
  // ----- one batch at a time -----
  // The batch in progress when the page opened (null: none; undefined: still checking).
  const [ongoing, setOngoing] = useState<ActiveBatch | null | undefined>(undefined);
  // True once that batch has been continued here (or there was none): the page can be used.
  const [restored, setRestored] = useState(false);
  // "Start Batch" recorded this batch as In Progress (or it was continued): its progress is saved.
  const [batchStarted, setBatchStarted] = useState(false);
  const [resumed, setResumed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  // The batch was finished or cancelled elsewhere (another device): nothing more is saved for it.
  const [batchClosed, setBatchClosed] = useState(false);
  // While continuing a batch, its saved parameters are kept (not replaced by the recommended ones).
  const restoring = useRef(false);
  const [restoreCount, setRestoreCount] = useState(0);

  // The batch in progress, if there is one: this page continues it instead of starting another.
  // Otherwise the next batch ID from the backend's naming format (local ID when offline).
  useEffect(() => {
    let cancelled = false;
    getActiveBatch()
      .then(async (active) => {
        // Resolve the loading gate immediately after the active-batch request. Fetching the next ID
        // is secondary and must never leave the Process page stuck if that endpoint stalls.
        if (!cancelled) setOngoing(active);
        if (!active) {
          const id = await getNextBatchId().catch(() => null);
          if (!cancelled && id) setBatchId(id);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setActionError(errorText(t, error));
        setOngoing(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const chemistrySettings = useMemo(getChemistrySettings, []);

  // Can the Pi set the power supply's current limit? (otherwise the operator sets it by hand)
  useEffect(() => {
    if (!backend) {
      setProcessConfigCurrentControl(false);
      return;
    }
    let cancelled = false;
    fetch("/api/config")
      .then((response) => response.json())
      .then((config: { powerSupply?: { currentControl?: boolean } }) => {
        if (cancelled) return;
        setProcessConfigCurrentControl(Boolean(config.powerSupply?.currentControl));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [backend]);

  /** Shows the local demonstration state on the screen. */
  function showLocalPurification(sim: LocalPurification) {
    const total = (minutes: number) => Math.round(minutes * 60);
    setPurification({
      phase: sim.phase,
      temperature: sim.temperature,
      highest: sim.highest,
      heaterOn: sim.heaterOn,
      stirrerOn: sim.stirrerOn,
      // the stirrer's RPM reading is shown during contact only
      stirrerRpm: sim.phase === "contact" ? (sim.stirrerOn ? PROCESS_CONFIG.purification.stirringSpeedRpm - 2 : 0) : null,
      valveOpen: sim.phase === "drain",
      stepRemaining:
        sim.phase === "methanol" ? sim.methanolRemaining
          : sim.phase === "contact" ? sim.contactRemaining
            : null,
      outputG: sim.outputG,
      oilG: sim.oilG,
      magnesolG: adsorbentGrams(oilVolumeMl, adsorbent, adsorbentSettings),
      adsorbent,
      warning: sim.warning,
      stopReason: sim.stopReason,
      stopOccurred: Boolean(sim.stopReason),
      automatic: true,
      heatingSeconds: sim.heatingSeconds,
      methanolSeconds: total(purificationSettings.methanolRemovalMinutes) - sim.methanolRemaining,
      contactSeconds: total(purificationSettings.contactMinutes) - sim.contactRemaining,
      drainSeconds: sim.drainElapsed,
      stableSeconds: sim.stableSeconds,
    });
  }

  // No backend: run the purification as a local demonstration, one step per second.
  useEffect(() => {
    if (backend || !PURIFYING.includes(purification.phase)) return;
    const timer = window.setInterval(() => {
      const sim = localPurification.current;
      if (!sim) return;
      stepLocalPurification(sim);
      showLocalPurification({ ...sim });
    }, 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, purification.phase]);

  // Local demonstration: when purification ends (done or stopped) every valve is closed.
  useEffect(() => {
    if (backend || (purification.phase !== "complete" && purification.phase !== "fault")) return;
    setLocalValves(ALL_CLOSED);
  }, [backend, purification.phase]);

  // Backend connected: show its live readings and the state of its stages.
  useEffect(() => {
    if (!backend || !live) return;
    if (live.sensors.oilMassG !== null) setReactorG(live.sensors.oilMassG);
    const stage = live.stage;
    if (stage.stage && stage.batchId === batchId) {
      if (stage.stage === "Esterification") setEsterState(stage.state);
      else if (stage.stage === "Transesterification") setTransState(stage.state);
      else setSeparationState(stage.state);
    }
    const p = live.purification;
    if (p.phase === "ready" || p.batchId !== batchId) {
      setPurification((current) => (current.phase === "ready" ? { ...current, temperature: live.sensors.temperature } : current));
      return;
    }
    setPurification({
      phase: p.phase,
      temperature: p.liveTemperature ?? live.sensors.temperature,
      highest: p.highestTemperature,
      heaterOn: p.heaterOn,
      stirrerOn: p.stirrerOn,
      stirrerRpm: p.stirrerRpm,
      valveOpen: p.valveOpen,
      stepRemaining: p.stepRemainingSeconds,
      outputG: p.outputWeightG ?? 0,
      oilG: p.oilWeightG,
      magnesolG: p.adsorbentG ?? p.magnesolG,
      adsorbent: p.adsorbent ?? adsorbent,
      warning: p.warning,
      stopReason: p.safetyStopReason,
      stopOccurred: p.safetyStopOccurred,
      automatic: p.automatic,
      heatingSeconds: p.heatingTimeSeconds,
      methanolSeconds: p.methanolTotalSeconds - p.methanolRemainingSeconds,
      contactSeconds: p.contactTotalSeconds - p.contactRemainingSeconds,
      drainSeconds: p.drainElapsedSeconds,
      stableSeconds: p.stableSeconds ?? 0,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, live, batchId]);

  // A pump run on the Pi has ended: add what it delivered to its dose (once).
  useEffect(() => {
    if (!backend || !live) return;
    const p = live.pump;
    if (!p.startedAt || !p.stage || p.batchId !== batchId || accountedRuns.current.has(p.startedAt)) return;
    if (p.phase === "done" || p.phase === "fault" || p.phase === "stopped") {
      accountedRuns.current.add(p.startedAt);
      const key = p.stage;
      setLoads((current) => ({ ...current, [key]: { completedG: (current[key]?.completedG ?? 0) + p.deliveredG } }));
    }
  }, [backend, live, batchId]);

  // Local demonstration of a pump: the dose arrives in about 5 seconds.
  useEffect(() => {
    if (backend || !localPump || localPump.phase !== "pumping") return;
    const timer = window.setTimeout(() => {
      const stepG = Math.min(localPump.targetG / 5, localPump.targetG - localPump.deliveredG);
      const delivered = localPump.deliveredG + stepG;
      setReactorG((grams) => grams + stepG);
      if (delivered >= localPump.targetG - 0.01) {
        setLocalPump({ ...localPump, deliveredG: localPump.targetG, phase: "done" });
        setLoads((current) => ({ ...current, [localPump.key]: { completedG: localPump.base + localPump.targetG } }));
      } else {
        setLocalPump({ ...localPump, deliveredG: delivered });
      }
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [backend, localPump]);

  const oilVolumeMl =
    PROCESS_CONFIG.oil.densityGPerMl > 0
      ? oilMassG / PROCESS_CONFIG.oil.densityGPerMl
      : null;
  const targetError = wholeNumberError(
    t,
    targetVolume,
    {
      min: PROCESS_CONFIG.oil.minimumVolumeMl,
      max: PROCESS_CONFIG.oil.maximumVolumeMl,
    },
    {
      min: t("Minimum oil volume is 1500 mL."),
      max: t("Maximum supported oil volume is 5000 mL."),
    },
  );
  // By volume: the target volume is the oil quantity (there is no reactor reading to show).
  useEffect(() => {
    if (byVolume) setReactorG(targetError ? 0 : Number(targetVolume) * PROCESS_CONFIG.oil.densityGPerMl);
  }, [byVolume, targetVolume, targetError]);
  const ffaError = ffaAboveStrip ? "" : wholeNumberError(t, ffa, { min: 0, max: 5 }, { empty: t("Enter the FFA as a whole percent from 0 to 5 (for example 1 or 3)."), max: t("Maximum FFA input is 5%. If the strip shows its darkest color, tick the checkbox below.") });
  // Above the strip's range the batch is recorded at the strip's maximum (5%), marked "≥".
  const ffaNumber = ffaAboveStrip ? chemistrySettings.stripMaxFfa : Number(ffa);
  const requiresEsterification =
    !ffaError && ffaNumber > chemistrySettings.ffaThreshold;
  const measuredOilError =
    oilMassG <= 0 || oilVolumeMl === null
      ? t("Load-cell reading is unavailable.")
      : oilVolumeMl < PROCESS_CONFIG.oil.minimumVolumeMl
        ? t("Minimum oil volume is 1500 mL.")
        : oilVolumeMl > PROCESS_CONFIG.oil.maximumVolumeMl
          ? t("Maximum supported oil volume is 5000 mL.")
          : "";
  const esterErrors = [
    wholeNumberError(t, esterVoltage, PROCESS_CONFIG.esterification.voltage),
    wholeNumberError(t, esterTime, PROCESS_CONFIG.esterification.time),
    wholeNumberError(t, esterStirring, PROCESS_CONFIG.esterification.stirring),
    wholeNumberError(t, esterCurrent, PROCESS_CONFIG.esterification.current),
  ];
  const transErrors = [
    wholeNumberError(t, transVoltage, PROCESS_CONFIG.transesterification.voltage),
    wholeNumberError(t, transTime, PROCESS_CONFIG.transesterification.time),
    wholeNumberError(t, transStirring, PROCESS_CONFIG.transesterification.stirring),
    wholeNumberError(t, transCurrent, PROCESS_CONFIG.transesterification.current),
  ];
  const parametersValid =
    !targetError &&
    !ffaError &&
    !measuredOilError &&
    !transErrors.some(Boolean) &&
    (!requiresEsterification || !esterErrors.some(Boolean));
  const calculatorValues = calculateQuantityCards(
    oilMassG,
    oilVolumeMl,
    ffaNumber,
    ratio,
    catalyst,
    chemistrySettings,
    adsorbent,
    adsorbentSettings,
  );
  const calculatorReady = oilMassG > 0 && !ffaError;

  // ----- esterification stages and the FFA re-check -----
  const esterDoseNow = esterificationDose(oilMassG, oilVolumeMl, esterStage === 1 ? ffaNumber : nextDoseFfa ?? ffaNumber, esterStage, chemistrySettings);
  const recheckError = recheckAbove ? "" : wholeNumberError(t, recheckValue, { min: 0, max: 5 }, { max: t("Maximum FFA input is 5%. Tick the darkest-color checkbox if that is what the strip shows.") });
  const recheckFfa = recheckAbove ? chemistrySettings.stripMaxFfa : Number(recheckValue);
  const recheckNext = recheckError
    ? null
    : {
        ffa: recheckFfa,
        ester: esterificationDose(oilMassG, oilVolumeMl, recheckAbove ? chemistrySettings.designFfa : recheckFfa, esterStage + 1, chemistrySettings),
        trans: transesterificationDose(oilMassG, oilVolumeMl, recheckFfa, ratio, catalyst, chemistrySettings),
      };
  // Transesterification neutralizes the last re-check reading (exact), or the starting FFA.
  const transAcidPct = requiresEsterification ? finalFfa ?? chemistrySettings.ffaTarget : ffaNumber;
  const transDoseNow = transesterificationDose(oilMassG, oilVolumeMl, transAcidPct, ratio, catalyst, chemistrySettings);
  const transExact = !requiresEsterification || finalFfa !== null;
  const esterStagesRun = esterRecords.length || (requiresEsterification ? 1 : 0);
  const esterMethanolTotal = esterRecords.length ? esterRecords.reduce((sum, record) => sum + record.methanolMl, 0) : requiresEsterification ? calculatorValues.esterificationMethanolMl : 0;
  const acetoneTotalMl =
    (requiresEsterification ? esterRecords.find((record) => record.stage === 1)?.acetoneMl ?? calculatorValues.acetoneMl ?? 0 : 0) +
    (transDoseNow.acetoneMl ?? 0);
  const esterAcidTotal = esterRecords.length ? esterRecords.reduce((sum, record) => sum + record.sulfuricAcidMl, 0) : requiresEsterification ? calculatorValues.sulfuricAcidMl : 0;
  const magnesolG = purification.magnesolG ?? calculatorValues.adsorbentG;   // adsorbent amount (g)
  const adsorbentName = purification.phase === "ready" ? adsorbent : purification.adsorbent;
  useEffect(() => {
    if (ffaError) return;
    // A continued batch keeps the parameters it was set up with.
    if (restoring.current) {
      restoring.current = false;
      return;
    }
    let cancelled = false;
    // Best parameters for this FFA range, from the Raspberry Pi's batch records (local records offline).
    getRecommendedParametersForFfa(ffaNumber)
      .then((recommendation) => {
        if (cancelled || !recommendation) return;
        // whole numbers only (older records may have decimals)
        if (recommendation.esterificationVoltage != null) {
          setEsterVoltage(whole(recommendation.esterificationVoltage));
        }
        if (recommendation.esterificationTime != null) {
          setEsterTime(whole(recommendation.esterificationTime));
        }
        if (recommendation.esterificationStirring != null) {
          setEsterStirring(whole(recommendation.esterificationStirring));
        }
        setTransVoltage(whole(recommendation.transesterificationVoltage));
        setTransTime(whole(recommendation.transesterificationTime));
        setTransStirring(whole(recommendation.transesterificationStirring));
        setRatio(recommendation.methanolRatio);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ffaError, ffaNumber]);
  // (runs after the effect above: the guard covers only the render that continued the batch)
  useEffect(() => {
    restoring.current = false;
  }, [restoreCount]);

  const OIL_KEY = "Oil loading";
  const oilRun = pumpRunFor(OIL_KEY);
  const oilLoaded = oilPumpFitted && !targetError && doseLoaded(OIL_KEY, plannedOilG);
  // What is in the reactor: the load cell's reading, or (no reactor load cell) what the oil pump loaded
  const hasReactorReading = backend ? live?.sensors.oilMassG != null : true;
  const oilInReactorG = oilPumpFitted && !hasReactorReading ? pumpedG(OIL_KEY) : reactorG;
  const targetReached =
    !targetError &&
    (oilPumpFitted
      ? oilLoaded
      : (!byVolume || oilPouredByVolume) &&
        oilVolumeMl !== null &&
        Math.abs(oilVolumeMl - Number(targetVolume)) <= Math.max(Number(targetVolume) * 0.02, 5));
  const loadingStatus =
    oilPumpFitted
      ? oilLoaded
        ? t("Target quantity reached")
        : oilRun?.phase === "pumping"
          ? t("Loading oil")
          : t("Waiting for oil")
      : byVolume && !oilPouredByVolume
      ? t("Waiting for oil")
      : oilMassG <= 0
      ? t("Waiting for oil")
      : measuredOilError
        ? t("Invalid quantity")
        : targetReached
          ? t("Target quantity reached")
          : t("Oil detected");
  const systemTiles: Array<{
    label: string;
    value: string;
    secondary?: string;
    state?: DeviceState;
  }> = [
    { label: "Power Supply", value: "Ready", secondary: "Output off · 0–30 V DC" },
    { label: "Electrodes", value: "Graphite – graphite", secondary: "Connected" },
    { label: "Reactor Stirrer", value: "Ready", secondary: "Stopped · RPM sensor online" },
    { label: "Centrifuge Motor", value: "Ready", secondary: "Stopped · RPM sensor online" },
    { label: "Purification Stirrer", value: "Ready", secondary: "Stopped · RPM sensor online" },
    { label: "Heater", value: "Ready", secondary: "Off · stops above 95 °C" },
    { label: "Temperature Sensor", value: "Online", secondary: "27.0 °C · demonstration reading" },
    { label: "Reactor Load Cell", value: "Online", secondary: `${reactorG.toFixed(1)} g in the reactor · demonstration mode` },
    { label: "Oil Input", value: "Oil pump", secondary: "Loads the target volume on the Oil Loading step (by weight)", state: "ready" },
    { label: "Dosing Pumps", value: "Ready", secondary: "A: NaOH/KOH + methanol · B: H₂SO₄ + methanol" },
    { label: "Outlet Valves", value: "All closed", secondary: "Reactor, centrifuge and purification outlets" },
    { label: "Output Load Cell", value: "Online", secondary: "0.0 g in the biodiesel container" },
  ];
  const tiles = systemStatus?.tiles ?? systemTiles;
  const fault = tiles.find((tile) => tile.state === "fault");
  const checking = tiles.find((tile) => tile.state === "checking");
  const systemReady = !fault && !checking;
  const steps = useMemo(
    () => [
      "Before You Start",
      "Volume & Parameters",
      "Oil Loading",
      ...(requiresEsterification ? ["Esterification"] : []),
      "Transesterification",
      "Separation",
      "Purification",
      "Process Complete",
    ],
    [requiresEsterification],
  );
  const currentStage = steps[step];
  const next = () => setStep((current) => Math.min(steps.length - 1, current + 1));

  useEffect(() => {
    if (!backend) {
      setSystemStatus(null);
      return;
    }
    if (currentStage !== "Before You Start") return;
    let stopped = false;
    const load = () => getSystemStatus().then((status) => { if (!stopped) setSystemStatus(status); }).catch(() => undefined);
    load();
    const timer = window.setInterval(load, 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [backend, currentStage]);

  const liveStageFor = (kind: StageName) =>
    backend && live && live.stage.stage === kind && live.stage.batchId === batchId ? live.stage : null;
  const liveSeparation = liveStageFor("Separation");
  const realHardware = backend && !mock;
  const sourceLabel = backend ? (mock ? "Simulated by the Greenova backend (demo mode)" : "Live readings from the Raspberry Pi") : "Demonstration data — no hardware controller connected";

  async function loadDemoReading() {
    setConfirmedOilG(null);
    setActionError(null);
    if (backend) {
      try {
        const sensors = await loadDemoOil(Number(targetVolume || 0));
        if (sensors.oilMassG !== null) setReactorG(sensors.oilMassG);
      } catch (error) {
        setActionError(errorText(t, error));
      }
      return;
    }
    setReactorG(Number(targetVolume || 0) * PROCESS_CONFIG.oil.densityGPerMl);
  }

  // ----- dosing pumps: each stage's dose loads by itself -----
  const doseKey = currentStage === "Esterification" ? `Esterification ${esterStage}` : currentStage === "Transesterification" ? "Transesterification" : null;
  const reactionDose = currentStage === "Esterification"
    ? { pump: "acid" as PumpName, targetG: esterDoseNow.premixG, premixMl: esterDoseNow.premixMl, acetoneMl: esterDoseNow.acetoneMl, acetoneG: esterDoseNow.acetoneG, state: esterState }
    : currentStage === "Transesterification"
      ? { pump: "catalyst" as PumpName, targetG: transDoseNow.premixG, premixMl: transDoseNow.premixMl, acetoneMl: transDoseNow.acetoneMl ?? 0, acetoneG: transDoseNow.acetoneG, state: transState }
      : null;

  function pumpRunFor(key: string): PumpView | null {
    if (backend) {
      const p = live?.pump;
      if (!p || p.phase === "idle" || p.batchId !== batchId || p.stage !== key) return null;
      return { phase: p.phase, deliveredG: p.deliveredG, faultReason: p.faultReason, byTime: p.byTime };
    }
    if (!localPump || localPump.key !== key) return null;
    return { phase: localPump.phase, deliveredG: localPump.deliveredG, faultReason: localPump.faultReason, byTime: false };
  }

  const pumpRunning = backend ? live?.pump.phase === "pumping" : localPump?.phase === "pumping";

  function doseLoaded(key: string, targetG: number) {
    return (loads[key]?.completedG ?? 0) >= targetG - 1;
  }

  /** The pump adds the dose (or what's left of it) and stops at its weight. */
  async function loadDose(key: string, pump: PumpName, targetG: number, premixMl: number) {
    setActionError(null);
    const base = loads[key]?.completedG ?? 0;
    const remainingG = targetG - base;
    if (remainingG <= 0.5) return;
    const volumeMl = (premixMl * remainingG) / targetG;
    if (backend) {
      try {
        await startPump({
          pump,
          targetG: Number(remainingG.toFixed(1)),
          volumeMl: Number(Math.max(volumeMl, 0.1).toFixed(1)),
          batchId,
          stage: key,
        });
      } catch (error) {
        setActionError(errorText(t, error));
      }
      return;
    }
    setLocalPump({ key, pump, base, targetG: remainingG, deliveredG: 0, phase: "pumping", faultReason: null });
  }

  /** Stop button while a pump loads (the oil pump on Oil Loading). Start again to load the rest. */
  function stopPump() {
    if (backend) {
      pumpAction("stop").catch((error) => setActionError(errorText(t, error)));
      return;
    }
    if (localPump?.phase === "pumping") {
      setLocalPump({ ...localPump, phase: "stopped", faultReason: "stopped by operator" });
      setLoads((current) => ({ ...current, [localPump.key]: { completedG: localPump.base + localPump.deliveredG } }));
    }
  }

  function skipPump() {
    if (backend) {
      pumpAction("skip").catch((error) => setActionError(errorText(t, error)));
      return;
    }
    if (localPump?.phase === "pumping") {
      setReactorG((grams) => grams + localPump.targetG - localPump.deliveredG);
      setLocalPump({ ...localPump, deliveredG: localPump.targetG, phase: "done" });
      setLoads((current) => ({ ...current, [localPump.key]: { completedG: localPump.base + localPump.targetG } }));
    }
  }

  /** Demo: acetone poured through the inlet lands on the reactor load cell. */
  async function pourDemoAcetone(grams: number) {
    setActionError(null);
    if (grams < 0.5) return;
    if (backend) {
      try {
        const sensors = await demoAdd(Number(grams.toFixed(1)));
        if (sensors.oilMassG !== null) setReactorG(sensors.oilMassG);
      } catch (error) {
        setActionError(errorText(t, error));
      }
      return;
    }
    setReactorG((current) => current + grams);
  }

  // Remember the reactor weight when a dose's step opens: acetone poured since = the rise.
  useEffect(() => {
    if (!doseKey || acetoneBase[doseKey] !== undefined) return;
    setAcetoneBase((current) => ({ ...current, [doseKey]: reactorG }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doseKey]);

  /** Grams the pump has put in for this dose, including a run that just ended and isn't added up yet. */
  function pumpedG(key: string) {
    const completed = loads[key]?.completedG ?? 0;
    if (backend) {
      const p = live?.pump;
      const running = p && p.startedAt && p.stage === key && p.batchId === batchId && !accountedRuns.current.has(p.startedAt);
      return running ? completed + p.deliveredG : completed;
    }
    if (localPump && localPump.key === key) return Math.max(completed, localPump.base + localPump.deliveredG);
    return completed;
  }

  function acetonePouredG(key: string) {
    return Math.max(reactorG - (acetoneBase[key] ?? reactorG) - pumpedG(key), 0);
  }

  // Without a reactor load cell reading the acetone can't be seen: then the stage doesn't wait for it.
  const loadCellReading = backend ? (live?.sensors.oilMassG ?? null) !== null : true;
  const acetoneNeeded = reactionDose !== null && reactionDose.acetoneG > 0 && !(currentStage === "Esterification" && esterStage > 1);
  const acetoneOk = !doseKey || !acetoneNeeded || !loadCellReading || acetoneSkipped[doseKey] === true || acetonePouredG(doseKey) >= (reactionDose?.acetoneG ?? 0) * 0.95;
  function continueWithoutAcetone(key: string) {
    setAcetoneSkipped((current) => ({ ...current, [key]: true }));
  }
  const doseIn = doseKey !== null && reactionDose !== null && doseLoaded(doseKey, reactionDose.targetG);

  // ----- transfer outlets -----
  // No drain time: an outlet opens when its process finishes, the next process starts right away,
  // and the outlets stay open until the batch's purification has finished (then every valve closes).
  function valveView(valve: DrainValve): ValveView {
    if (backend) {
      const d = live?.drain;
      if (d && d.valve === valve && d.phase === "waiting" && d.batchId === batchId) return "waiting";
      return live?.sensors.valves?.[valve] ? "open" : "closed";
    }
    return localValves[valve] ? "open" : "closed";
  }

  const reactorOutletOpen = valveView("reactor_outlet") === "open";
  const centrifugeOutletView = valveView("centrifuge_outlet");

  // The dose loads by itself when its stage opens (once per dose; Retry after a pump problem).
  useEffect(() => {
    if (!doseKey || !reactionDose || reactionDose.state !== "ready") return;
    if (autoPumped.current.has(doseKey) || doseLoaded(doseKey, reactionDose.targetG) || pumpRunning || reactorOutletOpen) return;
    autoPumped.current.add(doseKey);
    loadDose(doseKey, reactionDose.pump, reactionDose.targetG, reactionDose.premixMl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doseKey, reactionDose?.state, pumpRunning, reactorOutletOpen]);

  // ... and the stage starts by itself once the dose is loaded and acetone was poured or skipped.
  useEffect(() => {
    if (!doseKey || !reactionDose || reactionDose.state !== "ready" || !doseIn || !acetoneOk || pumpRunning) return;
    if (autoStageStarted.current.has(doseKey)) return;
    autoStageStarted.current.add(doseKey);
    if (currentStage === "Esterification") controlStage("Esterification", "running", "ready", setEsterState);
    else controlStage("Transesterification", "running", "ready", setTransState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doseKey, reactionDose?.state, doseIn, acetoneOk, pumpRunning]);

  // ----- FFA re-check after an esterification stage -----
  function recordEsterStage(ffaAfter: number) {
    const record: EsterStageRecord = {
      stage: esterStage,
      ffaBefore: esterStage === 1 ? ffaNumber : esterRecords[esterRecords.length - 1]?.ffaAfter ?? ffaNumber,
      ffaAfter,
      doseFfa: esterDoseNow.doseFfa,
      methanolMl: Number(esterDoseNow.methanolMl.toFixed(2)),
      sulfuricAcidMl: Number(esterDoseNow.sulfuricAcidMl.toFixed(3)),
      acetoneMl: Number(esterDoseNow.acetoneMl.toFixed(1)),
    };
    setEsterRecords((current) => [...current.filter((item) => item.stage !== esterStage), record]);
  }

  async function prepareNextEsterStage() {
    if (!recheckNext) return;
    setActionError(null);
    recordEsterStage(recheckNext.ffa);
    if (backend) {
      try {
        await stageAction("reset");
      } catch (error) {
        setActionError(errorText(t, error));
        return;
      }
    }
    setNextDoseFfa(recheckNext.ester.doseFfa);
    setEsterStage((current) => current + 1);
    setRecheckValue("");
    setRecheckAbove(false);
    setEsterState("ready");
  }

  function finishEsterification() {
    if (!recheckNext) return;
    recordEsterStage(recheckNext.ffa);
    setFinalFfa(recheckNext.ffa);
    next();
  }

  /** Stage buttons: the backend runs the stage when it's connected; otherwise the local demo. */
  async function controlStage(kind: StageName, nextState: StageState, current: StageState, setLocal: (state: StageState) => void) {
    setActionError(null);
    if (!backend) {
      setLocal(nextState);
      // the outlet opens by itself after these stages and stays open (the Pi does this itself)
      if (nextState === "complete" && kind === "Transesterification") {
        setLocalValves((valves) => ({ ...valves, reactor_outlet: true }));
        setReactorG(0); // the mixture flows into the centrifuge
      }
      if (nextState === "complete" && kind === "Separation") setLocalValves((valves) => ({ ...valves, centrifuge_outlet: true }));
      if (nextState === "fault") setLocalValves(ALL_CLOSED); // emergency stop closes every valve
      return;
    }
    try {
      let result: StageStatus;
      if (nextState === "running" && current === "ready") {
        result = await startStage(
          kind === "Separation"
            ? { stage: kind, batchId, oilMassG, adsorbent }
            : {
                stage: kind,
                batchId,
                adsorbent,
                voltage: Number(kind === "Esterification" ? esterVoltage : transVoltage),
                time: Number(kind === "Esterification" ? esterTime : transTime),
                stirring: Number(kind === "Esterification" ? esterStirring : transStirring),
                current: Number(kind === "Esterification" ? esterCurrent : transCurrent),
                oilMassG,
              },
        );
      } else if (nextState === "running") {
        result = await stageAction("resume");
      } else if (nextState === "paused") {
        result = await stageAction("pause");
      } else if (nextState === "complete") {
        result = await stageAction("complete");
      } else if (nextState === "fault") {
        result = await stageAction("emergency-stop");
      } else {
        result = await stageAction("reset");
      }
      setLocal(result.state);
    } catch (error) {
      setActionError(errorText(t, error));
    }
  }

  async function resetStage(setLocal: (state: StageState) => void) {
    setActionError(null);
    if (!backend) {
      setLocal("ready");
      return;
    }
    try {
      setLocal((await stageAction("reset")).state);
    } catch (error) {
      setActionError(errorText(t, error));
    }
  }

  // ----- purification -----
  /** Starts purification now. The backend starts it automatically after transfer; the local demo
   * starts it automatically when the Purification screen is reached. */
  async function startPurificationNow() {
    setActionError(null);
    if (backend) {
      try {
        await startPurification({ heaterSubmerged: heaterConfirmed, batchId, oilVolumeMl: oilVolumeMl ?? undefined, adsorbent });
      } catch (error) {
        setActionError(errorText(t, error));
      }
      return;
    }
    const temperature = purification.temperature ?? 27;
    const sim: LocalPurification = {
      phase: "heating",
      temperature,
      highest: temperature,
      heaterOn: true,
      stirrerOn: true,
      heatingSeconds: 0,
      methanolRemaining: Math.round(purificationSettings.methanolRemovalMinutes * 60),
      magnesolAdded: false,
      contactRemaining: Math.round(purificationSettings.contactMinutes * 60),
      drainElapsed: 0,
      stableSeconds: 0,
      anchorG: null,
      outputG: 0,
      tankG: oilMassG * 0.85,
      oilG: oilMassG,
      warning: null,
      stopReason: null,
    };
    localPurification.current = sim;
    showLocalPurification({ ...sim });
  }

  async function confirmMagnesol() {
    setActionError(null);
    if (backend) {
      try {
        await purificationAction("magnesol-added");
      } catch (error) {
        setActionError(errorText(t, error));
      }
      return;
    }
    const sim = localPurification.current;
    if (sim && sim.phase === "magnesol") {
      sim.magnesolAdded = true;
      sim.phase = "contact";
      showLocalPurification({ ...sim });
    }
  }

  /** "Skip timer (demo)": finishes the current step now (not the Magnesol: that's the operator's). */
  function skipPurificationPhase() {
    if (backend) {
      purificationAction("skip").catch((error) => setActionError(errorText(t, error)));
      return;
    }
    const sim = localPurification.current;
    if (!sim) return;
    if (sim.phase === "heating") sim.temperature = PROCESS_CONFIG.purification.holdTemperature;
    else if (sim.phase === "methanol") sim.methanolRemaining = 1;
    else if (sim.phase === "contact") sim.contactRemaining = 1;
    else if (sim.phase === "drain") {
      sim.outputG = Number((sim.outputG + sim.tankG).toFixed(1));
      sim.tankG = 0;
      sim.anchorG = sim.outputG;
      sim.stableSeconds = PROCESS_CONFIG.purification.drainStableSeconds;
    }
    showLocalPurification({ ...sim });
  }

  async function stopPurification() {
    setActionError(null);
    if (backend) {
      try {
        await purificationAction("abort");
      } catch (error) {
        setActionError(errorText(t, error));
      }
      return;
    }
    const sim = localPurification.current;
    if (sim) {
      sim.phase = "fault";
      sim.heaterOn = false;
      sim.stirrerOn = false;
      sim.stopReason = "stopped by operator";
      showLocalPurification({ ...sim });
    }
  }

  async function acknowledgeSafetyStop() {
    setActionError(null);
    if (backend) {
      try {
        await purificationAction("acknowledge");
      } catch (error) {
        setActionError(errorText(t, error));
        return;
      }
    }
    localPurification.current = null;
    setPurification((current) => ({ ...READY_PURIFICATION, temperature: current.temperature, stopOccurred: true }));
    setHeaterConfirmed(false);
  }

  // ----- going straight on to the next process -----
  // Transesterification done: the reactor outlet opens and separation starts at once (no drain
  // time). The backend starts the machine stage itself; the page follows.
  const goToSeparation = currentStage === "Transesterification" && transState === "complete";
  useEffect(() => {
    if (!goToSeparation) return;
    const timer = window.setTimeout(next, 1500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goToSeparation]);

  // The separation starts by itself as soon as the reactor outlet opens. With the backend the
  // Raspberry Pi starts it (so it goes on even if this page is closed); the local demonstration
  // starts it here.
  const autoSeparation = useRef(false);
  const startSeparationHere = !backend && currentStage === "Separation" && separationState === "ready";
  useEffect(() => {
    if (!startSeparationHere || autoSeparation.current) return;
    const timer = window.setTimeout(() => {
      autoSeparation.current = true;
      controlStage("Separation", "running", "ready", setSeparationState);
    }, 1000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startSeparationHere]);
  // If the Pi hasn't started it a few seconds later (for example, a fault), expose the Start
  // control instead of leaving the page stuck.
  const [separationWaitOver, setSeparationWaitOver] = useState(false);
  const waitingForPi = backend && currentStage === "Separation" && separationState === "ready";
  useEffect(() => {
    if (!waitingForPi) return;
    const timer = window.setTimeout(() => setSeparationWaitOver(true), 8000);
    return () => window.clearTimeout(timer);
  }, [waitingForPi]);
  const separationStartsByItself =
    separationState === "ready" && (backend ? !separationWaitOver : !autoSeparation.current);

  // Purification done (drained until the output was stable; every valve is now closed): the batch is
  // saved and the process finishes by itself (Process Complete shows the result and any low-output warning).
  const autoFinished = useRef(false);
  const finishNow = currentStage === "Purification" && purification.phase === "complete" && !saved;
  useEffect(() => {
    if (!finishNow || autoFinished.current) return;
    const timer = window.setTimeout(() => {
      autoFinished.current = true;
      completeBatch();
    }, 1500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishNow]);

  // Separation complete: go on to Purification by itself.
  useEffect(() => {
    if (currentStage !== "Separation" || separationState !== "complete") return;
    const timer = window.setTimeout(next, 1500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStage, separationState]);

  // Local demonstration: purification starts by itself on the Purification screen (once per batch),
  // as soon as the centrifuge outlet is open. With the backend, the Raspberry Pi starts it itself.
  useEffect(() => {
    if (backend || currentStage !== "Purification" || autoStarted.current || purification.phase !== "ready") return;
    autoStarted.current = true;
    startPurificationNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, currentStage, purification.phase]);

  const levelSwitch = backend && live ? live.sensors.heaterSubmerged : null;
  const autoStartPending = backend && live !== null && live.purificationAutoStart === batchId;
  const centrifugeOutletWaiting = centrifugeOutletView === "waiting";
  const showManualStart =
    purification.phase === "ready" && !purification.stopReason && !centrifugeOutletWaiting && (!backend || !autoStartPending);

  /** The batch record the website saves. The Pi adds what it measured itself (temperatures, energy,
   * purification, output weight and yield). Every number goes through num(), so no field is ever
   * missing or NaN (a missing value used to stop the save with "Field required"). */
  function batchRecord(): Partial<DemoBatch> & { id: string } {
    const totalReactionTime = num(Number(transTime)) + (requiresEsterification ? num(Number(esterTime)) * esterStagesRun : 0);
    const oilVolume = Number(num(oilVolumeMl).toFixed(1));
    // Offline the website works out the yield itself from the output load cell; the Pi does it on its own.
    const localOutputMl = !backend && purification.outputG > 0 ? Number((purification.outputG / 0.88).toFixed(1)) : undefined;
    return {
      id: batchId,
      date: new Date().toISOString().slice(0, 10),
      oilVolume,
      yield: localOutputMl && oilVolume ? Number(((localOutputMl / oilVolume) * 100).toFixed(1)) : 0,
      biodieselOutputMl: localOutputMl,
      duration: totalReactionTime + PROCESS_CONFIG.separation.timeMinutes,
      energy: 0,
      status: "Completed",
      labResult: "Pending",
      ffa: num(ffaNumber),
      ffaAboveStrip,
      oilMassG: Number(num(oilMassG).toFixed(1)),
      catalystToWeighG: Number(num(transDoseNow.catalystToWeighG).toFixed(3)),
      esterificationStages: esterRecords,
      esterificationRun: requiresEsterification,
      temperature: 27,
      reactionTime: num(Number(transTime)),
      stirringSpeed: num(Number(transStirring)),
      voltage: num(Number(transVoltage)),
      current: num(Number(transCurrent)),
      methanolRatio: ratio,
      esterificationVoltage: requiresEsterification ? num(Number(esterVoltage)) : undefined,
      esterificationTime: requiresEsterification ? num(Number(esterTime)) : undefined,
      esterificationStirring: requiresEsterification ? num(Number(esterStirring)) : undefined,
      esterificationCurrent: requiresEsterification ? num(Number(esterCurrent)) : undefined,
      catalystType: catalyst,
      adsorbent: purification.adsorbent,
      purification: {
        targetTemperature: PROCESS_CONFIG.purification.holdTemperature,
        highestTemperature: num(purification.highest),
        heatingTimeSeconds: num(purification.heatingSeconds),
        holdTimeSeconds: num(purification.methanolSeconds),
        drainTimeSeconds: num(purification.drainSeconds),
        contactTimeSeconds: num(purification.contactSeconds),
        // no settling or cooling step
        settlingTimeSeconds: 0,
        coolingTimeSeconds: 0,
        magnesolG: num(magnesolG),
        adsorbent: purification.adsorbent,
        adsorbentG: num(magnesolG),
        magnesolAdded: true,
        automatic: purification.automatic,
        warning: purification.warning,
        safetyStopOccurred: purification.stopOccurred,
        stirringSpeed: PROCESS_CONFIG.purification.stirringSpeedRpm,
        outputWeightG: purification.outputG || null,
        oilWeightG: num(purification.oilG, Number(num(oilMassG).toFixed(1))),
      },
    };
  }

  async function completeBatch() {
    if (!saved) {
      setActionError(null);
      setSaveFailed(false);
      closedRef.current = true;   // no more progress saves: the batch is being completed
      let result: BatchRecord;
      try {
        result = await saveCompletedBatch(batchRecord());
      } catch (error) {
        closedRef.current = false;   // still in progress
        setActionError(errorText(t, error));
        setSaveFailed(true);
        return;
      }
      setSavedBatch(result);
      setCompletedAt((current) => current ?? new Date());
      setSaved(true);
    }
    next();
  }

  /** The Pi refused the record: keep it in this browser, so the operator is never stuck at the end. */
  function finishInThisBrowser() {
    const record = batchRecord();
    saveBatchInThisBrowser(record as DemoBatch);
    // the Pi's row must not stay "In Progress" (it would block the next batch)
    if (backend) markBatchCompleted(batchId).catch(() => undefined);
    setSavedBatch(record as BatchRecord);
    setCompletedAt((current) => current ?? new Date());
    setSaved(true);
    setSaveFailed(false);
    setActionError(null);
    next();
  }

  // ----- one batch at a time: continue the batch in progress, save where it is -----
  /** Puts the page back where the batch in progress was (its saved snapshot). */
  function applySnapshot(active: ActiveBatch) {
    setBatchId(active.id);
    setBatchStarted(true);
    setResumed(true);
    const s = active.progress?.state as Partial<ProcessSnapshot> | null | undefined;
    if (!s || s.version !== 1) {
      setStep(1);   // started, but nothing saved yet: Volume & Parameters
      return;
    }
    restoring.current = true;
    setRestoreCount((count) => count + 1);
    setReactorG(s.reactorG ?? 0);
    setConfirmedOilG(s.confirmedOilG ?? null);
    setTargetVolume(s.targetVolume ?? "2000");
    setFfa(s.ffa ?? "");
    setFfaAboveStrip(s.ffaAboveStrip ?? false);
    setEsterStage(s.esterStage ?? 1);
    setEsterRecords(s.esterRecords ?? []);
    setNextDoseFfa(s.nextDoseFfa ?? null);
    setRecheckValue(s.recheckValue ?? "");
    setRecheckAbove(s.recheckAbove ?? false);
    setFinalFfa(s.finalFfa ?? null);
    setLoads(s.loads ?? {});
    setAcetoneBase(s.acetoneBase ?? {});
    setAcetoneSkipped(s.acetoneSkipped ?? {});
    if (s.adsorbent) setAdsorbent(s.adsorbent);
    if (s.ratio) setRatio(s.ratio);
    if (s.catalyst) setCatalyst(s.catalyst);
    if (s.esterVoltage) setEsterVoltage(s.esterVoltage);
    if (s.esterTime) setEsterTime(s.esterTime);
    if (s.esterStirring) setEsterStirring(s.esterStirring);
    if (s.esterCurrent) setEsterCurrent(s.esterCurrent);
    if (s.transVoltage) setTransVoltage(s.transVoltage);
    if (s.transTime) setTransTime(s.transTime);
    if (s.transStirring) setTransStirring(s.transStirring);
    if (s.transCurrent) setTransCurrent(s.transCurrent);
    setEsterState(s.esterState ?? "ready");
    setTransState(s.transState ?? "ready");
    setSeparationState(s.separationState ?? "ready");
    setSeparationWaitOver(s.separationWaitOver ?? false);
    // (a snapshot saved by an older version may still have settling/cooling fields: they are ignored)
    setPurification({ ...READY_PURIFICATION, ...(s.purification ?? {}) });
    setHeaterConfirmed(s.heaterConfirmed ?? false);
    accountedRuns.current = new Set(s.accountedRuns ?? []);
    autoPumped.current = new Set(s.autoPumped ?? []);
    autoStageStarted.current = new Set(s.autoStageStarted ?? []);
    autoStarted.current = s.autoStarted ?? false;
    autoSeparation.current = s.autoSeparation ?? false;
    setLocalPump(s.localPump ?? null);
    setLocalValves({ ...ALL_CLOSED, ...(s.localValves ?? {}) });
    localPurification.current = s.localPurification ?? null;
    setStep(Math.max(s.step ?? 1, 1));
  }

  // Restore as soon as the active-batch request settles. A stalled live-sensor connection must not
  // hold the whole Process page on “Checking for a batch in progress…”. The live connection is
  // independent of the persisted batch/progress API.
  useEffect(() => {
    if (ongoing === undefined || restored) return;
    if (ongoing) applySnapshot(ongoing);
    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ongoing, connecting, restored]);

  // A saved step that no longer exists (e.g. the FFA path changed): the last step there is.
  useEffect(() => {
    if (step > steps.length - 1) setStep(steps.length - 1);
  }, [step, steps.length]);

  // The Raspberry Pi goes on by itself, also while this page is closed (separation as soon as the
  // reactor outlet opens, purification after separation): catch up with it.
  useEffect(() => {
    if (!backend || !live || !restored || !batchStarted || saved) return;
    const separationStep = steps.indexOf("Separation");
    const purificationStep = steps.indexOf("Purification");
    const purificationHere =
      (live.purification.batchId === batchId && live.purification.phase !== "ready") || live.purificationAutoStart === batchId;
    if (purificationHere && step < purificationStep) {
      setTransState("complete");
      setSeparationState("complete");
      setStep(purificationStep);
    } else if (live.stage.batchId === batchId && live.stage.stage === "Separation" && step < separationStep) {
      setTransState("complete");
      setStep(separationStep);
    }
  }, [backend, live, restored, batchStarted, saved, batchId, step, steps]);

  /** "Start Batch": records the batch as In Progress. Refused while another batch is in progress
   * (only one at a time): then that batch is continued here instead. */
  async function beginBatch() {
    setActionError(null);
    setStarting(true);
    try {
      const started = await startBatch(batchId);
      setBatchId(started.id);
      // Fresh batch: no dosing/acetone choice or automatic-stage marker may leak from the last run.
      setLoads({});
      setAcetoneBase({});
      setAcetoneSkipped({});
      setOilPouredByVolume(false);
      if (!backend) setReactorG(0);            // local demonstration: a new batch starts with an empty reactor
      accountedRuns.current.clear();
      autoPumped.current.clear();
      autoStageStarted.current.clear();
      autoStarted.current = false;
      autoSeparation.current = false;
      setLocalValves(ALL_CLOSED);
      setBatchStarted(true);
      next();
    } catch (error) {
      const active = error instanceof ApiError && error.status === 409 ? await getActiveBatch().catch(() => null) : null;
      if (active) applySnapshot(active);   // started on another device meanwhile
      else setActionError(errorText(t, error));
    } finally {
      setStarting(false);
    }
  }

  // The machine is working for this batch: it can't be cancelled until that step is stopped.
  // (Open outlets alone don't count: cancelling the batch closes them.)
  const machineBusy = backend
    ? live !== null && (
      live.stage.state === "running" || live.stage.state === "paused" || live.pump.phase === "pumping" ||
      live.drain.phase === "waiting" || PURIFYING.includes(live.purification.phase))
    : localPump?.phase === "pumping" || PURIFYING.includes(purification.phase) ||
      [esterState, transState, separationState].some((state) => state === "running" || state === "paused");
  const canCancel = batchStarted && !saved && !batchClosed && currentStage !== "Process Complete";

  /** Cancels the batch in progress (it stays in Batch History as Cancelled); a new one can start. */
  async function cancelThisBatch() {
    setConfirmCancel(false);
    setActionError(null);
    closedRef.current = true;   // no more progress saves for it
    try {
      await cancelBatch(batchId);
    } catch (error) {
      closedRef.current = false;
      setActionError(errorText(t, error));
      return;
    }
    navigate("/dashboard");
  }

  // Where the batch is, saved every few seconds when something changed, at each new step and when
  // leaving the page. Live readings that change every second (the load cell, the purification
  // tank) aren't a reason to save on the Pi: it has them itself when the batch is continued.
  const persisting = batchStarted && restored && !saved && !batchClosed;
  const snapshot: ProcessSnapshot = {
    version: 1, step, stage: currentStage, reactorG, confirmedOilG, targetVolume, ffa, ffaAboveStrip, esterStage,
    esterRecords, nextDoseFfa, recheckValue, recheckAbove, finalFfa, loads, acetoneBase, acetoneSkipped, adsorbent, ratio, catalyst,
    esterVoltage, esterTime, esterStirring, esterCurrent, transVoltage, transTime, transStirring, transCurrent,
    esterState, transState, separationState, separationWaitOver, purification, heaterConfirmed,
    accountedRuns: [...accountedRuns.current], autoPumped: [...autoPumped.current],
    autoStageStarted: [...autoStageStarted.current], autoStarted: autoStarted.current,
    autoSeparation: autoSeparation.current, localPump, localValves, localPurification: localPurification.current,
  };
  const changeKey = JSON.stringify(backend ? { ...snapshot, reactorG: 0, purification: purification.phase } : snapshot);
  const latest = useRef({ batchId, stage: currentStage, snapshot, changeKey, record: {} as Partial<DemoBatch> });
  latest.current = { batchId, stage: currentStage, snapshot, changeKey, record: batchRecord() };
  const persistingRef = useRef(false);
  persistingRef.current = persisting;
  const closedRef = useRef(false);
  const lastSaved = useRef("");
  const saving = useRef<Promise<void>>(Promise.resolve());

  function flushProgress() {
    const current = latest.current;
    if (!persistingRef.current || closedRef.current || current.changeKey === lastSaved.current) return;
    lastSaved.current = current.changeKey;
    // one save at a time, in order, so an older save never lands after a newer one
    saving.current = saving.current.then(() =>
      saveBatchProgress(current.batchId, current.stage, current.snapshot, current.record).catch((error) => {
        lastSaved.current = "";   // try again at the next save
        if (isOffline(error) || closedRef.current) return;   // completed or cancelled here meanwhile
        if (error instanceof ApiError && (error.status === 404 || error.status === 409)) setBatchClosed(true);
        setActionError(errorText(t, error));
      }),
    );
  }

  useEffect(() => {
    if (!persisting) return;
    const timer = window.setInterval(flushProgress, 2000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persisting]);
  useEffect(() => {
    flushProgress();   // a new step (or the first one) is saved at once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, persisting]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => flushProgress(), []);   // leaving the page

  const p = PROCESS_CONFIG.purification;
  const purifying = PURIFYING.includes(purification.phase);
  const purificationStepIndex = PURIFICATION_STEPS.findIndex(([phase]) => phase === purification.phase);
  const stepLabel = purificationStepIndex >= 0 ? PURIFICATION_STEPS[purificationStepIndex][1] : null;
  const stepText = purification.phase === "magnesol" ? t("Add {adsorbent}", { adsorbent: t(adsorbentName) }) : stepLabel ? t(stepLabel) : "";

  // Nothing can be done before it is known whether a batch is already in progress.
  if (!restored) {
    return (
      <div className="space-y-6">
        <div>
          <div className="section-kicker">{t("Production workflow")}</div>
          <Heading as="h1" className="mt-2 text-3xl font-bold tracking-tight">{t("Process")}</Heading>
        </div>
        <Card className="p-8 text-center text-sm text-gray-500">{t("Checking for a batch in progress…")}</Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="section-kicker">{t("Batch {id}", { id: batchId })}</div>
          <Heading as="h1" className="mt-2 text-3xl font-bold tracking-tight">{t("Process")}</Heading>
          <p className="mt-2 text-sm text-gray-500">{t("Guided electrochemical biodiesel production workflow.")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {canCancel && (
            <Button
              variant="ghost"
              className="!py-1.5 text-xs text-red-400"
              disabled={machineBusy}
              title={machineBusy ? t("Stop the running step first.") : undefined}
              onClick={() => setConfirmCancel(true)}
            >
              {t("Cancel batch")}
            </Button>
          )}
          <Status tone={currentStage === "Process Complete" ? "green" : "blue"}>
            {currentStage === "Process Complete" ? t("Completed") : t(currentStage)}
          </Status>
        </div>
      </div>
      <Stepper steps={steps} step={step} />

      {resumed && !saved && !batchClosed && (
        <div className="rounded-xl border border-blue-500/20 bg-blue-500/[0.05] p-4 text-sm text-blue-300" data-testid="resumed">
          {t("Continuing batch {id}. Only one batch can be processed at a time: finish this one, or cancel it, before starting a new one.", { id: batchId })}
        </div>
      )}

      {confirmCancel && (
        <Dialog
          title={t("Cancel batch {id}?", { id: batchId })}
          onClose={() => setConfirmCancel(false)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setConfirmCancel(false)}>{t("Keep the batch")}</Button>
              <Button variant="danger" onClick={cancelThisBatch}>{t("Cancel batch")}</Button>
            </>
          }
        >
          {t("The batch stays in Batch History as Cancelled, and a new batch can be started. This can't be undone.")}
        </Dialog>
      )}

      {actionError && (
        <div role="alert" className="flex items-start justify-between gap-4 rounded-xl border border-red-500/25 bg-red-500/[0.06] p-4 text-sm text-red-300">
          <span>{actionError}</span>
          <button type="button" className="text-xs text-gray-400 hover:text-white" onClick={() => setActionError(null)}>{t("Dismiss")}</button>
        </div>
      )}

      {currentStage === "Before You Start" && (
        <div className="space-y-6">
          <SectionHeader
            eyebrow={t("Process introduction")}
            title={t("Before You Start")}
            description={t("Greenova checks the system automatically. Review the safety guidance before preparing your batch.")}
          />
          <Card className="p-6 sm:p-8">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <Heading as="h2" className="text-lg font-semibold">{t("System Status")}</Heading>
                <p className="mt-1 text-sm text-gray-500">{t("Read-only prototype channels update automatically.")}</p>
              </div>
              <Status tone={realHardware ? "green" : "yellow"}>{backend ? (mock ? t("Demonstration backend") : t("Live hardware")) : t("Demonstration mode")}</Status>
            </div>
            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {tiles.map((tile) => <ReadOnlyTile key={tile.label} {...tile} />)}
            </div>
            <div className={`mt-5 rounded-xl border p-5 ${systemReady ? "border-green-500/25 bg-green-500/[0.06]" : fault ? "border-red-500/25 bg-red-500/[0.05]" : "border-amber-400/25 bg-amber-400/[0.05]"}`}>
              <div className="flex items-start gap-3">
                <StateDot state={systemReady ? "ready" : fault ? "fault" : "checking"} />
                <div>
                  <div className={`font-display font-semibold ${systemReady ? "text-green-400" : fault ? "text-red-400" : "text-amber-400"}`}>
                    {systemReady ? t("System Ready") : fault ? t("System Fault / Not Ready") : t("Checking system")}
                  </div>
                  <p className="mt-1 text-sm text-gray-400">{t("Automatic safety monitoring must remain active throughout the process.")}</p>
                  <p className="mt-2 text-xs leading-5 text-gray-600">{t("A Ready display does not energize the reactor. The controller must verify all required interlocks before power is enabled.")}</p>
                </div>
              </div>
            </div>
          </Card>

          <Card className="border-amber-400/15 p-6 sm:p-8">
            <Heading as="h2" className="text-lg font-semibold">{t("Safety Guidance")}</Heading>
            <p className="mt-1 text-sm text-gray-500">{t("Review the approved laboratory procedures before starting.")}</p>
            <div className="mt-6 grid gap-7 lg:grid-cols-3">
              {SAFETY_GROUPS.map((group) => (
                <div key={group.title}>
                  <div className="border-b border-amber-400/15 pb-3 text-xs font-semibold uppercase tracking-[0.12em] text-amber-400">{t(group.title)}</div>
                  <div className="mt-4 space-y-4">
                    {group.items.map(([title, description]) => (
                      <div key={title} className="flex gap-3">
                        <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-amber-400/25 text-[10px] font-bold text-amber-400">i</div>
                        <div>
                          <div className="text-sm font-medium text-gray-300">{t(title)}</div>
                          <p className="mt-1 text-xs leading-5 text-gray-500">{t(description)}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Card>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Link to="/dashboard" className="btn-ghost justify-center">{t("Back to Dashboard")}</Link>
            <div className="flex flex-col items-stretch gap-2 sm:items-end">
              <Button disabled={starting} onClick={batchStarted ? next : beginBatch}>
                {batchStarted ? t("Continue") : starting ? t("Starting…") : t("Start Batch")} →
              </Button>
              {!batchStarted && (
                <p className="max-w-sm text-xs text-gray-600 sm:text-right">{t("Starting records the batch as In Progress in Batch History. Only one batch can be processed at a time.")}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {currentStage === "Volume & Parameters" && (
        <div className="space-y-6">
          <SectionHeader
            eyebrow={t("Operator setup")}
            title={t("Volume & Parameters")}
            description={t("Review the live oil measurement, enter the test-strip FFA result, and configure the validated operating parameters.")}
          />
          <div className="grid gap-6 xl:grid-cols-2">
            <Card className="p-6 sm:p-8">
              <Heading as="h2" className="text-lg font-semibold">{t("1. Oil Input")}</Heading>
              <p className="mt-1 text-sm text-gray-500">{oilPumpFitted ? t("The oil pump loads the target volume on the Oil Loading step; until then the quantities below use the target volume.") : t("Pour the oil through the first 5 µm filter. The reactor load cell is authoritative for the actual oil mass.")}</p>
              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <ReadOnlyTile label={oilPumpFitted ? "Oil to load" : byVolume ? "Oil mass (by volume)" : "Live oil mass"} value={`${oilMassG.toFixed(1)} g`} secondary={oilPumpFitted ? "Oil pump · loads on the Oil Loading step" : byVolume ? "No reactor load cell · target volume × density" : realHardware ? "Reactor load cell · live" : "Reactor load cell · demonstration channel"} state={oilMassG > 0 ? "ready" : "checking"} />
                <ReadOnlyTile label="Converted volume" value={oilVolumeMl === null ? "Unavailable" : `${oilVolumeMl.toFixed(1)} mL`} secondary={t("Configured density: {density} g/mL · assumed", { density: PROCESS_CONFIG.oil.densityGPerMl })} state={oilMassG > 0 ? "ready" : "checking"} />
              </div>
              <div className="mt-5">
                <Field label={t("Target batch volume")} inputMode="numeric" pattern="[0-9]*" value={targetVolume} onChange={wholeInput((value) => { setTargetVolume(value); setConfirmedOilG(null); setOilPouredByVolume(false); })} unit="mL" aria-invalid={Boolean(targetError)} />
                <p className={`mt-2 text-xs ${targetError ? "text-red-400" : "text-gray-600"}`}>{targetError || t("Target batch volume: 1,500–5,000 mL.")}</p>
              </div>
              <div className="mt-5 flex flex-wrap items-center gap-3">
                {!realHardware && !oilPumpFitted && <Button variant="secondary" disabled={Boolean(targetError)} onClick={loadDemoReading}>{t("Load demonstration sensor reading")}</Button>}
                {oilPumpFitted ? <Status tone="blue">{t("Automatic oil pump")}</Status> : byVolume ? <Status tone="blue">{t("Oil measured by volume")}</Status> : realHardware ? <Status>{t("Live load cell")}</Status> : <Status tone="yellow">{t("Not live hardware")}</Status>}
              </div>
              {measuredOilError && <p className="mt-3 text-xs text-red-400">{measuredOilError}</p>}
            </Card>

            <Card className="p-6 sm:p-8">
              <Heading as="h2" className="text-lg font-semibold">{t("2. FFA Measurement")}</Heading>
              <p className="mt-1 text-sm text-gray-500">{t("Measure the feedstock using the FFA test strips, then enter the observed result. The strip reads up to {max}%.", { max: chemistrySettings.stripMaxFfa })}</p>
              <div className="mt-6">
                <Field label={t("FFA Percentage (0–5%)")} inputMode="numeric" pattern="[0-9]*" max={5} value={ffaAboveStrip ? "5" : ffa} disabled={ffaAboveStrip} onChange={wholeInputMax(setFfa, 5)} unit="%" aria-invalid={Boolean(ffaError)} />
                {ffaError && <p className="mt-2 text-xs text-red-400">{ffaError}</p>}
                {!ffaError && <p className="mt-2 text-xs text-gray-600">{t("Whole numbers only. {threshold}% or below goes straight to transesterification; higher goes to esterification first.", { threshold: chemistrySettings.ffaThreshold })}</p>}
                <label className="mt-4 flex items-center gap-2 text-sm text-gray-300">
                  <input className="gv-checkbox" type="checkbox" checked={ffaAboveStrip} onChange={(event) => { setFfaAboveStrip(event.target.checked); if (event.target.checked) setFfa("5"); }} />
                  {t("The strip shows its darkest color ({max}% or more)", { max: chemistrySettings.stripMaxFfa })}
                </label>
              </div>
              {!ffaError && (
                <div className="mt-5 rounded-xl border border-white/[0.08] bg-white/[0.025] p-4">
                  <div className="gv-label">{t("Pathway decision · threshold {value}%", { value: 3 })}</div>
                  <p className="text-sm text-gray-300">
                    {ffaAboveStrip
                      ? t("FFA 5% or more (recorded as ≥ 5%). Esterification with the uniform dose for {design}% FFA, then an FFA re-check.", { design: chemistrySettings.designFfa })
                      : requiresEsterification
                        ? t("FFA is above 3%: esterification is required before transesterification, followed by an FFA re-check.")
                        : t("FFA is 3% or below: proceed directly to transesterification.")}
                  </p>
                </div>
              )}
            </Card>
          </div>

          <details className="group rounded-xl border border-white/[0.08] bg-gv-inset">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 text-sm font-semibold text-gray-200 [&::-webkit-details-marker]:hidden">
              <span>{t("Show chemical calculations")}</span>
              <span aria-hidden="true" className="text-lg text-gray-400 transition-transform group-open:rotate-180">⌄</span>
            </summary>
            <div className="px-3 pb-3 sm:px-4 sm:pb-4">
          <Card className="p-6 sm:p-8">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <Heading as="h2" className="text-lg font-semibold">{t("3. Chemical Quantity Calculator")}</Heading>
                <p className="mt-1 text-sm text-gray-500">{t("Calculated values are planning quantities, not actual dispensed amounts.")}</p>
              </div>
              <Status tone="neutral">{t("Read only calculations")}</Status>
            </div>
            <div className="mt-6 grid gap-5 sm:grid-cols-2">
              <SelectField label={t("Methanol-to-oil ratio")} value={ratio} onChange={(event) => setRatio(Number(event.target.value))}>
                {[6, 7, 8, 9].map((value) => <option key={value} value={value}>{value}:1</option>)}
              </SelectField>
              <SelectField label={t("Base catalyst")} value={catalyst} onChange={(event) => setCatalyst(event.target.value as "NaOH" | "KOH")}>
                <option value="NaOH">NaOH</option>
                <option value="KOH">KOH</option>
              </SelectField>
            </div>

            <div className="mt-7">
              <div className="mb-3 flex items-center justify-between gap-3">
                <Heading as="h3" className="text-base font-semibold">{t("Esterification")}</Heading>
                {calculatorReady && requiresEsterification && <Status tone="yellow">{t("Uniform dose · {design}% design FFA", { design: calculatorValues.doseFfa })}</Status>}
              </div>
              {calculatorReady && !requiresEsterification ? (
                <div className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-5 text-sm text-gray-500">
                  {t("Esterification not needed — FFA is 3% or below.")}
                </div>
              ) : (
                <>
                  <div className="grid gap-4 md:grid-cols-3">
                    <ReadOnlyTile
                      label="Methanol"
                      value={calculatorReady ? `${calculatorValues.esterificationMethanolMl.toFixed(1)} mL` : "—"}
                      secondary={calculatorReady ? t("20:1 methanol to FFA · dosed for {dose}% FFA: {grams} g × 2.84", { dose: calculatorValues.doseFfa, grams: calculatorValues.ffaMassG.toFixed(1) }) : undefined}
                    />
                    <ReadOnlyTile
                      label="Sulfuric acid 98%"
                      value={calculatorReady ? `${calculatorValues.sulfuricAcidMl.toFixed(2)} mL` : "—"}
                      secondary={calculatorReady ? t("5% of the dose's FFA weight · {grams} g × 0.027", { grams: calculatorValues.ffaMassG.toFixed(1) }) : undefined}
                    />
                    <ReadOnlyTile
                      label="Acetone"
                      value={calculatorReady && calculatorValues.acetoneMl !== null ? `${calculatorValues.acetoneMl.toFixed(1)} mL` : "—"}
                      secondary={calculatorReady ? "Provisional 10% of oil volume" : undefined}
                    />
                  </div>
                  {calculatorReady && requiresEsterification && (
                    <p className="mt-3 text-xs leading-5 text-gray-500">
                      {t("Every batch above {threshold}% FFA gets this dose, because the strip can't measure above {max}%. It covers oil up to {design}% FFA. Pump B loads it as one premix ({premix} g). After the stage, an FFA re-check decides: at or below {target}%, transesterification with the exact catalyst; above it, another stage dosed for the reading.", { threshold: PROCESS_CONFIG.ffaThreshold, max: chemistrySettings.stripMaxFfa, design: chemistrySettings.designFfa, premix: calculatorValues.esterificationPremixG.toFixed(1), target: chemistrySettings.ffaTarget })}
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="mt-7 border-t border-white/[0.07] pt-7">
              <div className="mb-3 flex items-center justify-between gap-3">
                <Heading as="h3" className="text-base font-semibold">{t("Transesterification")}</Heading>
                <span className="text-xs text-gray-600">
                  {t("Oil molar mass: {value} g/mol", { value: chemistrySettings.oilMolarMass })}
                </span>
              </div>
              <div className="grid gap-4 md:grid-cols-3">
                <ReadOnlyTile
                  label="Methanol"
                  value={calculatorReady ? `${calculatorValues.transesterificationMethanolMl.toFixed(1)} mL` : "—"}
                  secondary={calculatorReady ? t("{ratio}:1 molar ratio · {grams} g oil", { ratio, grams: oilMassG.toFixed(1) }) : undefined}
                />
                <ReadOnlyTile
                  label={t("{catalyst} to weigh", { catalyst })}
                  value={calculatorReady ? `${requiresEsterification ? t("Up to") + " " : ""}${calculatorValues.catalystToWeighG.toFixed(1)} g` : "—"}
                  secondary={
                    calculatorReady
                      ? requiresEsterification
                        ? t("{base} g catalyst + up to {neutral} g to neutralize acid · final amount after the FFA re-check", { base: calculatorValues.catalystBaseG.toFixed(1), neutral: calculatorValues.neutralizationG.toFixed(1) })
                        : t("{base} g catalyst + {neutral} g to neutralize FFA · {purity}% purity · pump A premix {premix} g", { base: calculatorValues.catalystBaseG.toFixed(1), neutral: calculatorValues.neutralizationG.toFixed(1), purity: calculatorValues.purity, premix: calculatorValues.transesterificationPremixG.toFixed(1) })
                      : undefined
                  }
                />
                <ReadOnlyTile
                  label="Acetone"
                  value={calculatorReady && calculatorValues.acetoneMl !== null ? `${calculatorValues.acetoneMl.toFixed(1)} mL` : "—"}
                  secondary={calculatorReady ? "Provisional 10% of oil volume" : undefined}
                />
              </div>
            </div>

            <div className="mt-7 border-t border-white/[0.07] pt-7">
              <Heading as="h3" className="mb-3 text-base font-semibold">{t("Purification")}</Heading>
              <div className="grid gap-4 md:grid-cols-3">
                <SelectField label={t("Dry wash adsorbent")} value={adsorbent} onChange={(event) => setAdsorbent(event.target.value as Adsorbent)}>
                  <option value="Magnesol">Magnesol</option>
                  <option value="Bentonite">{t("Bentonite")}</option>
                </SelectField>
                <ReadOnlyTile
                  label={adsorbent === "Bentonite" ? "Bentonite (dry wash)" : "Magnesol (dry wash)"}
                  value={calculatorReady ? `${calculatorValues.adsorbentG.toFixed(1)} g` : "—"}
                  secondary={calculatorReady ? t("Oil volume × {factor} ({dose}% of the oil weight)", { factor: ((PROCESS_CONFIG.oil.densityGPerMl * calculatorValues.adsorbentDosePct) / 100).toFixed(4), dose: calculatorValues.adsorbentDosePct }) : undefined}
                />
              </div>
              <p className="mt-3 text-xs leading-5 text-gray-500">{t("Same purification steps for both. The dose is set in Settings → Purification (default: Magnesol 1%, bentonite 2% of the oil weight).")}</p>
            </div>
          </Card>
            </div>
          </details>

          <Card className="p-6 sm:p-8">
            <Heading as="h2" className="text-lg font-semibold">{t("4. Reaction Parameters")}</Heading>
            <p className="mt-1 text-sm text-gray-500">{t("Temperature is monitored live and is not an operator-configurable parameter.")}</p>
            <div className={`mt-6 grid gap-6 ${requiresEsterification ? "xl:grid-cols-2" : ""}`}>
              {requiresEsterification && (
                <div className="rounded-xl border border-white/[0.07] bg-gv-inset p-5">
                  <div className="flex items-center justify-between gap-3"><Heading as="h3" className="text-base font-semibold">{t("Esterification Settings")}</Heading><Status tone="yellow">{t("Pump B · acid + methanol")}</Status></div>
                  <div className="mt-5 grid gap-5 sm:grid-cols-2">
                    <ParameterField label="Voltage" value={esterVoltage} setValue={setEsterVoltage} unit="V" limits={PROCESS_CONFIG.esterification.voltage} />
                    <ParameterField label="Current" value={esterCurrent} setValue={setEsterCurrent} unit="A" limits={PROCESS_CONFIG.esterification.current} />
                    <ParameterField label="Reaction time" value={esterTime} setValue={setEsterTime} unit="min" limits={PROCESS_CONFIG.esterification.time} />
                    <ParameterField label="Stirring speed" value={esterStirring} setValue={setEsterStirring} unit="RPM" limits={PROCESS_CONFIG.esterification.stirring} />
                  </div>
                  <p className="mt-4 text-xs text-amber-400">{t("Sulfuric acid (98%): {ml}, mixed by hand into the methanol in tank B. Pump B loads the premix into the reactor.", { ml: calculatorReady ? `${calculatorValues.sulfuricAcidMl.toFixed(2)} mL` : "—" })}</p>
                </div>
              )}
              <div className="rounded-xl border border-green-500/15 bg-green-500/[0.025] p-5">
                <div className="flex items-center justify-between gap-3"><Heading as="h3" className="text-base font-semibold">{t("Transesterification Settings")}</Heading><Status tone="green">{t("Project defaults")}</Status></div>
                <div className="mt-5 grid gap-5 sm:grid-cols-2">
                  <ParameterField label="Voltage" value={transVoltage} setValue={setTransVoltage} unit="V" limits={PROCESS_CONFIG.transesterification.voltage} />
                  <ParameterField label="Current" value={transCurrent} setValue={setTransCurrent} unit="A" limits={PROCESS_CONFIG.transesterification.current} />
                  <ParameterField label="Reaction time" value={transTime} setValue={setTransTime} unit="min" limits={PROCESS_CONFIG.transesterification.time} />
                  <ParameterField label="Stirring speed" value={transStirring} setValue={setTransStirring} unit="RPM" limits={PROCESS_CONFIG.transesterification.stirring} />
                </div>
              </div>
            </div>
            <p className="mt-4 text-xs leading-5 text-gray-500">
              {processConfigCurrentControl
                ? t("The Pi sets the power supply's current limit to the current setting. The electrodes stop if the measured current goes above it.")
                : t("Set the power supply's current limit to the current setting before each stage. The electrodes stop if the measured current goes above it.")}
            </p>
          </Card>
          <div className="flex justify-end"><Button disabled={!parametersValid} onClick={next}>{t("Continue to Oil Loading")} →</Button></div>
        </div>
      )}

      {currentStage === "Oil Loading" && (
        <Card className="p-6 sm:p-8">
          <SectionHeader
            eyebrow={oilPumpFitted ? t("Automatic oil input") : t("Manual stage")}
            title={t("Oil Loading")}
            description={oilPumpFitted
              ? hasReactorReading
                ? t("The oil pump loads the target volume; the reactor load cell weighs it and stops the pump.")
                : t("The oil pump loads the target volume by time at its measured rate (there is no reactor load cell).")
              : t("Pour the oil through the first 5 µm filter while the reactor load cell weighs it.")}
          />
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="p-5"><Metric label={t("Target oil volume")} value={`${Number(targetVolume).toFixed(1)} mL`} /></Card>
            <Card className="p-5">{oilPumpFitted
              ? <Metric label={t("Oil in the reactor")} value={`${oilInReactorG.toFixed(1)} g`} sub={!hasReactorReading ? t("Loaded by the oil pump (by time)") : realHardware ? t("Live load-cell data") : t("Demonstration load-cell data")} />
              : <Metric label={byVolume ? t("Oil mass (by volume)") : t("Live measured mass")} value={`${oilMassG.toFixed(1)} g`} sub={byVolume ? t("No reactor load cell") : realHardware ? t("Live load-cell data") : t("Demonstration load-cell data")} />}</Card>
            <Card className="p-5"><Metric label={t("Converted volume")} value={oilVolumeMl === null ? t("Unavailable") : `${oilVolumeMl.toFixed(1)} mL`} sub={t("Using configured assumed density")} /></Card>
            <Card className="p-5"><Metric label={t("Loading status")} value={loadingStatus} accent={targetReached} /></Card>
          </div>
          {oilPumpFitted ? (
            <OilPumpPanel
              targetG={plannedOilG}
              volumeMl={Number(targetVolume)}
              deliveredG={pumpedG(OIL_KEY)}
              run={oilRun}
              loaded={oilLoaded}
              onStart={() => loadDose(OIL_KEY, "oil", plannedOilG, Number(targetVolume))}
              onStop={stopPump}
              onSkip={realHardware ? undefined : skipPump}
            />
          ) : (
          <div className="mt-6 rounded-xl border border-white/[0.07] bg-gv-inset p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="gv-label">{byVolume ? t("Oil by volume") : t("Load-cell status")}</div>
                <p className="text-sm text-gray-300">
                  {byVolume
                    ? oilPouredByVolume
                      ? t("Confirmed: {volume} mL of oil poured.", { volume: Number(targetVolume) })
                      : t("There is no reactor load cell: pour {volume} mL of oil through the inlet filter, measured by volume, then confirm.", { volume: Number(targetVolume) })
                    : targetReached ? t("Required quantity detected within ±2% tolerance.") : t("Continue loading until the target quantity is detected.")}
                </p>
              </div>
              {byVolume ? (
                <Button variant={oilPouredByVolume ? "secondary" : "primary"} disabled={Boolean(targetError)} onClick={() => setOilPouredByVolume((done) => !done)}>
                  {oilPouredByVolume ? t("Undo") : t("I poured {volume} mL", { volume: Number(targetVolume) })}
                </Button>
              ) : (
                <Status tone={targetReached ? "green" : measuredOilError ? "red" : "yellow"}>{loadingStatus}</Status>
              )}
            </div>
          </div>
          )}
          <div className="mt-7 flex flex-wrap gap-3">
            {!targetReached && !realHardware && !oilPumpFitted && <Button variant="secondary" onClick={loadDemoReading}>{t("Simulate target reading")}</Button>}
            <Button
              disabled={!targetReached || oilRun?.phase === "pumping"}
              onClick={() => {
                // the oil the batch's quantities use: the load cell's reading, or what the pump loaded by time
                setConfirmedOilG(oilPumpFitted && !hasReactorReading ? plannedOilG : reactorG);
                next();
              }}
            >
              {requiresEsterification ? t("Continue to Esterification") : t("Continue to Transesterification")} →
            </Button>
          </div>
        </Card>
      )}

      {currentStage === "Esterification" && doseKey && (() => {
        const key = doseKey;
        const run = pumpRunFor(key);
        const autoUsed = autoStageStarted.current.has(key);
        return (
          <ReactionStage
            kind="Esterification"
            esterStage={esterStage}
            state={esterState}
            setState={(nextState) => controlStage("Esterification", nextState, esterState, setEsterState)}
            oilMass={oilMassG}
            oilVolume={oilVolumeMl}
            catalyst={catalyst}
            ratio={ratio}
            esterDose={esterDoseNow}
            transDose={transDoseNow}
            transExact={transExact}
            voltage={Number(esterVoltage)}
            current={Number(esterCurrent)}
            time={Number(esterTime)}
            stirring={Number(esterStirring)}
            batchId={batchId}
            onContinue={next}
            liveStage={liveStageFor("Esterification")}
            sourceLabel={sourceLabel}
            onReset={() => resetStage(setEsterState)}
            hideStart={!autoUsed}
            startBlocked={!doseIn ? t("The dose isn't loaded yet.") : null}
            hideContinue
            preparation={
              <LoadingPanel
                pump="acid"
                premixParts={[`${esterDoseNow.methanolMl.toFixed(1)} mL ${t("methanol")}`, `${esterDoseNow.sulfuricAcidMl.toFixed(2)} mL H₂SO₄`]}
                targetG={esterDoseNow.premixG}
                run={run}
                deliveredG={pumpedG(key)}
                onRetry={() => loadDose(key, "acid", esterDoseNow.premixG, esterDoseNow.premixMl)}
                onSkip={realHardware ? undefined : skipPump}
                acetone={acetoneNeeded ? {
                  ml: esterDoseNow.acetoneMl,
                  g: esterDoseNow.acetoneG,
                  addedG: acetonePouredG(key),
                  skipped: acetoneSkipped[key] === true,
                  onSkip: () => continueWithoutAcetone(key),
                  onDemoAdd: realHardware ? undefined : () => pourDemoAcetone(esterDoseNow.acetoneG - acetonePouredG(key)),
                } : null}
                current={Number(esterCurrent)}
                currentByHand={!processConfigCurrentControl}
                status={autoUsed ? "loaded" : doseIn && acetoneOk ? "starting" : "loading"}
              />
            }
            footer={esterState === "complete" ? (
              <RecheckPanel
                stage={esterStage}
                value={recheckValue}
                setValue={setRecheckValue}
                aboveStrip={recheckAbove}
                setAboveStrip={setRecheckAbove}
                settings={chemistrySettings}
                next={recheckNext}
                catalyst={catalyst}
                onAnotherStage={prepareNextEsterStage}
                onContinue={finishEsterification}
              />
            ) : null}
          />
        );
      })()}

      {currentStage === "Transesterification" && doseKey && (() => {
        const key = doseKey;
        const run = pumpRunFor(key);
        const autoUsed = autoStageStarted.current.has(key);
        return (
          <ReactionStage
            kind="Transesterification"
            state={transState}
            setState={(nextState) => controlStage("Transesterification", nextState, transState, setTransState)}
            oilMass={oilMassG}
            oilVolume={oilVolumeMl}
            catalyst={catalyst}
            ratio={ratio}
            esterDose={esterDoseNow}
            transDose={transDoseNow}
            transExact={transExact}
            voltage={Number(transVoltage)}
            current={Number(transCurrent)}
            time={Number(transTime)}
            stirring={Number(transStirring)}
            batchId={batchId}
            onContinue={next}
            liveStage={liveStageFor("Transesterification")}
            sourceLabel={sourceLabel}
            onReset={() => resetStage(setTransState)}
            hideStart={!autoUsed}
            startBlocked={!doseIn ? t("The dose isn't loaded yet.") : null}
            hideContinue
            preparation={
              <LoadingPanel
                pump="catalyst"
                premixParts={[`${transDoseNow.catalystToWeighG.toFixed(2)} g ${catalyst}`, `${transDoseNow.methanolMl.toFixed(1)} mL ${t("methanol")}`]}
                targetG={transDoseNow.premixG}
                run={run}
                deliveredG={pumpedG(key)}
                onRetry={() => loadDose(key, "catalyst", transDoseNow.premixG, transDoseNow.premixMl)}
                onSkip={realHardware ? undefined : skipPump}
                acetone={acetoneNeeded ? {
                  ml: transDoseNow.acetoneMl ?? 0,
                  g: transDoseNow.acetoneG,
                  addedG: acetonePouredG(key),
                  skipped: acetoneSkipped[key] === true,
                  onSkip: () => continueWithoutAcetone(key),
                  onDemoAdd: realHardware ? undefined : () => pourDemoAcetone(transDoseNow.acetoneG - acetonePouredG(key)),
                } : null}
                current={Number(transCurrent)}
                currentByHand={!processConfigCurrentControl}
                status={autoUsed ? "loaded" : doseIn && acetoneOk ? "starting" : "loading"}
              />
            }
            footer={transState === "complete" ? (
              <>
                <ValveIndicator valve="reactor_outlet" view={valveView("reactor_outlet")} />
                <p className="mt-4 text-sm text-green-400" data-testid="auto-next">
                  {t("The reactor outlet is open and the mixture flows into the centrifuge. Going on to separation…")}
                </p>
              </>
            ) : null}
          />
        );
      })()}

      {currentStage === "Separation" && (
        <Card className="p-6 sm:p-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <SectionHeader eyebrow={t("Batch {id}", { id: batchId })} title={t("Separation")} description={t("Separating biodiesel and glycerol.")} />
            <Status tone={separationState === "complete" ? "green" : separationState === "fault" ? "red" : "blue"}>{t({ ready: "READY", running: "RUNNING", paused: "PAUSED", complete: "COMPLETE", fault: "FAULT" }[separationState])}</Status>
          </div>
          {separationState === "ready" && (
            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              <Card className="p-5"><Metric label={t("Configured duration")} value={`${PROCESS_CONFIG.separation.timeMinutes} min`} /></Card>
              <Card className="p-5"><Metric label={t("Configured speed")} value={`${PROCESS_CONFIG.separation.speedRpm.toLocaleString()} RPM`} /></Card>
            </div>
          )}
          {separationState !== "ready" && (
            <LiveReadings
              source={sourceLabel}
              progress={liveSeparation && liveSeparation.timeMinutes ? (liveSeparation.elapsedSeconds / (liveSeparation.timeMinutes * 60)) * 100 : separationState === "complete" ? 100 : 60}
              fault={liveSeparation?.faultReason}
            >
              <Metric label={t("Time remaining")} value={liveSeparation ? formatTimer(liveSeparation.remainingSeconds) : separationState === "complete" ? "0 min" : "4 min"} />
              <Metric label={t("Centrifuge")} value={liveSeparation && liveSeparation.liveRpm != null ? `${liveSeparation.liveRpm.toLocaleString()} / ${PROCESS_CONFIG.separation.speedRpm.toLocaleString()} RPM` : `${PROCESS_CONFIG.separation.speedRpm.toLocaleString()} RPM`} />
            </LiveReadings>
          )}
          <p className="mt-4 text-xs leading-5 text-gray-500">{t("The centrifuge controller must verify lid interlock, balance, and required safety conditions before operation. When separation finishes and the centrifuge has stopped, its outlet valve opens and the biodiesel flows to the purification tank; purification starts right away. The outlet valves stay open until the batch is complete, then every valve closes.")}</p>
          {reactorOutletOpen && <ValveIndicator valve="reactor_outlet" view="open" />}
          {separationStartsByItself && (
            <p className="mt-6 text-sm text-blue-400" data-testid="separation-auto">{t("Starting the centrifuge…")}</p>
          )}
          <StageControls state={separationState} setState={(nextState) => controlStage("Separation", nextState, separationState, setSeparationState)} startLabel={backend ? t("Start centrifuge") : t("Record centrifuge start")} onContinue={next} continueLabel={t("Continue to Purification")} onReset={() => resetStage(setSeparationState)} hideStart={separationStartsByItself} />
        </Card>
      )}

      {currentStage === "Purification" && (
        <Card className="p-6 sm:p-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <SectionHeader
              eyebrow={t("Batch {id}", { id: batchId })}
              title={t("Purification")}
              description={t("Dry wash with {adsorbent}. It runs by itself: you only add the {adsorbent} when asked. It is done when the output load cell has been stable for 30 s; then every valve closes, the batch is saved and the process finishes by itself.", { adsorbent: t(adsorbentName) })}
            />
            <Status tone={purification.phase === "complete" ? "green" : purification.phase === "fault" ? "red" : purifying ? "yellow" : "neutral"}>
              {purification.phase === "ready" ? t("WAITING") : purification.phase === "fault" ? t("STOPPED") : stepText.toUpperCase()}
            </Status>
          </div>

          <div className="mt-7 overflow-x-auto">
            <div className="flex min-w-[640px] items-center">
              {PURIFICATION_STEPS.map(([phase, label], index) => {
                const done = index < purificationStepIndex || purification.phase === "complete";
                const active = index === purificationStepIndex && purification.phase !== "complete";
                return (
                  <div key={phase} className="relative flex flex-1 flex-col items-center text-center">
                    {index < PURIFICATION_STEPS.length - 1 && <div className={`absolute left-1/2 top-3 h-px w-full ${index < purificationStepIndex ? "bg-green-500/60" : "bg-white/10"}`} />}
                    <div className={`relative z-10 h-6 w-6 rounded-full border ${done ? "border-green-500 bg-green-500" : active ? "border-green-400 bg-green-500/15" : "border-white/10 bg-gv-surface"}`} />
                    <div className={`mt-2 text-[11px] leading-4 ${active ? "text-white" : done ? "text-green-400" : "text-gray-600"}`}>{phase === "magnesol" ? t("Add {adsorbent}", { adsorbent: t(adsorbentName) }) : t(label)}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {(purification.phase === "ready" || PURIFYING.includes(purification.phase)) && centrifugeOutletView !== "closed" && (
            <ValveIndicator valve="centrifuge_outlet" view={centrifugeOutletView} />
          )}

          {(purification.phase === "heating" || purification.phase === "methanol") && (
            <p className="mt-6 text-sm text-gray-400" data-testid="prepare-magnesol">{t("Prepare {grams} g {adsorbent}", { grams: magnesolG.toFixed(1), adsorbent: t(adsorbentName) })}</p>
          )}

          {purification.phase === "magnesol" && (
            <div className="mt-6 rounded-xl border border-green-500/30 bg-green-500/[0.06] p-5" data-testid="add-magnesol">
              <div className="font-display text-lg font-semibold text-green-400">{t("Add {grams} g {adsorbent} ({dose}% of the oil weight)", { grams: magnesolG.toFixed(1), adsorbent: t(adsorbentName), dose: adsorbentDose(adsorbentName, adsorbentSettings) })}</div>
              <p className="mt-1 text-sm text-gray-400">{t("The heater is off and the stirrer keeps running. Wear a dust mask.")}</p>
              <Button className="mt-4" onClick={confirmMagnesol}>{t("Confirm")}</Button>
            </div>
          )}

          {purification.phase !== "ready" && (
            <LiveReadings source={sourceLabel}>
              <Metric
                label={t("Temperature")}
                value={purification.temperature === null ? "—" : `${purification.temperature.toFixed(1)} °C`}
                sub={
                  purification.phase === "heating"
                    ? t("heater off at {value} °C", { value: p.holdTemperature })
                    : purification.phase === "methanol"
                      ? t("held at {value} °C", { value: p.holdTemperature })
                      : purification.phase === "contact"
                        ? t("heater off · cooling down")
                        : undefined
                }
              />
              {/* The stirrer's RPM reading is shown during contact only. */}
              {purification.phase === "contact" && (
                <Metric label={t("Stirrer")} value={purification.stirrerOn ? `${purification.stirrerRpm ?? "—"} / ${p.stirringSpeedRpm} RPM` : t("Off")} />
              )}
              <Metric label={t("Heater")} value={purification.heaterOn ? t("On") : t("Off")} />
              <Metric label={t("Outlet valve")} value={purification.valveOpen ? t("Open") : t("Closed")} />
              {purification.phase === "drain" ? (
                <>
                  <Metric label={t("Collected")} value={`${purification.outputG.toFixed(1)} g`} sub={t("output load cell")} />
                  <Metric
                    label={t("Stable reading")}
                    value={`${Math.min(purification.stableSeconds, p.drainStableSeconds)} / ${p.drainStableSeconds} s`}
                    sub={t("done when stable (±{grams} g) for {seconds} s", { grams: p.drainStableGrams, seconds: p.drainStableSeconds })}
                  />
                </>
              ) : (
                <Metric label={t("Step time left")} value={purification.stepRemaining === null ? "—" : formatTimer(purification.stepRemaining)} sub={stepText || undefined} />
              )}
            </LiveReadings>
          )}

          {purification.phase === "ready" && autoStartPending && levelSwitch === false && (
            <div className="mt-6 rounded-xl border border-amber-400/20 bg-amber-400/[0.04] p-5 text-sm text-amber-400">
              {t("Waiting for biodiesel to cover the heater. Purification starts by itself when the level switch detects it.")}
            </div>
          )}
          {purification.phase === "ready" && autoStartPending && levelSwitch === true && (
            <div className="mt-6 rounded-xl border border-green-500/20 bg-green-500/[0.04] p-5 text-sm text-green-400">{t("Starting purification…")}</div>
          )}

          {purification.warning && (
            <div className="mt-6 rounded-xl border border-amber-400/25 bg-amber-400/[0.05] p-5 text-sm text-amber-400">{t(purification.warning)}</div>
          )}

          {purification.stopReason && purification.phase === "fault" && (
            <div className="mt-6 rounded-xl border border-red-500/25 bg-red-500/[0.06] p-5">
              <div className="font-display font-semibold text-red-400">{t("Heater stopped:")} {t(purification.stopReason)}</div>
              <p className="mt-1 text-xs text-gray-500">{t("Heater OFF · stirrer OFF · valves CLOSED")}</p>
              <Button className="mt-4" variant="danger" onClick={acknowledgeSafetyStop}>{t("Acknowledge")}</Button>
            </div>
          )}

          {purification.phase === "complete" && (
            <div className="mt-6 rounded-xl border border-green-500/25 bg-green-500/[0.05] p-5" data-testid="purification-complete">
              <div className="font-display font-semibold text-green-400">{t("Purification complete")}</div>
              <p className="mt-1 text-sm text-gray-400">
                {saveFailed
                  ? t("The batch couldn't be saved on the Raspberry Pi (see the message above). Try again, or keep the record in this browser and finish.")
                  : t("The output load cell was stable for 30 s and every valve is closed. Saving the batch and finishing…")}
              </p>
            </div>
          )}

          <p className="mt-6 text-xs leading-5 text-amber-400">{t("The heater stops above {max} °C. The tank gets hot (90 °C): don't touch it, keep the area ventilated, no flames nearby.", { max: p.maximumTemperature })}</p>

          <div className="mt-6 flex flex-wrap items-center gap-4">
            {showManualStart && (
              <>
                {backend && levelSwitch === null && (
                  <label className="flex items-center gap-2 text-sm text-gray-300">
                    <input className="gv-checkbox" type="checkbox" checked={heaterConfirmed} onChange={(event) => setHeaterConfirmed(event.target.checked)} />
                    {t("No level switch installed: I checked that the heater is fully submerged")}
                  </label>
                )}
                <Button
                  disabled={(backend && levelSwitch === null && !heaterConfirmed) || (backend && levelSwitch === false)}
                  onClick={startPurificationNow}
                >
                  {purification.stopOccurred ? t("Start purification again") : t("Start purification")}
                </Button>
                {backend && levelSwitch === false && <span className="text-xs text-amber-400">{t("The level switch doesn't detect biodiesel at the heater.")}</span>}
              </>
            )}
            {purifying && <Button variant="danger" onClick={stopPurification}>{t("Stop")}</Button>}
            {purifying && purification.phase !== "magnesol" && !realHardware && (
              <Button variant="secondary" onClick={skipPurificationPhase}>{t("Skip timer (demo)")}</Button>
            )}
            {purification.phase === "complete" && saveFailed && (
              <>
                <Button onClick={completeBatch}>{t("Try saving again")}</Button>
                <Button variant="secondary" onClick={finishInThisBrowser}>{t("Finish and keep the record in this browser")} →</Button>
              </>
            )}
          </div>
        </Card>
      )}

      {currentStage === "Process Complete" && (
        <Card className="overflow-hidden">
          <div className="border-b border-green-500/10 bg-green-500/[0.04] p-8 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-gv-green text-2xl font-bold text-black">✓</div>
            <Heading as="h1" className="mt-5 text-3xl font-bold">{t("Process Complete")}</Heading>
            <p className="mt-2 text-sm text-gray-500">{savedBatch?.createdAt ? t("The batch has been saved on the Raspberry Pi, together with the values it measured.") : t("The recorded batch information has been saved to local history.")}</p>
            <p className="mt-3 text-sm text-amber-400">{t("Lab result pending. Record it in Batch History when the lab certificate arrives.")}</p>
            {purification.warning && <p className="mx-auto mt-3 max-w-xl rounded-lg border border-amber-400/25 bg-amber-400/[0.05] px-3 py-2 text-sm text-amber-400">{t(purification.warning)}</p>}
          </div>
          <div className="p-6 sm:p-8">
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              <Metric label={t("Batch ID")} value={batchId} accent />
              <Metric label={t("Oil volume")} value={oilVolumeMl === null ? t("Not available") : `${oilVolumeMl.toFixed(1)} mL`} sub={t("Converted using configured density")} />
              <Metric label={t("Oil mass")} value={`${oilMassG.toFixed(1)} g`} sub={realHardware ? t("Load-cell record") : t("Demonstration load-cell record")} />
              <Metric label={t("FFA percentage")} value={formatFfa({ ffa: ffaNumber, ffaAboveStrip })} sub={ffaAboveStrip ? t("Strip's darkest color · operator entered") : t("Test strip · operator entered")} />
              <Metric label={t("Reaction pathway")} value={requiresEsterification ? `${t("Esterification")}${esterStagesRun > 1 ? ` (${t("{count} stages", { count: esterStagesRun })})` : ""} → ${t("Transesterification")}` : t("Transesterification")} />
              {requiresEsterification && (
                <Metric
                  label={t("FFA re-checks")}
                  value={esterRecords.length ? [formatFfa({ ffa: ffaNumber, ffaAboveStrip }), ...esterRecords.map((record) => pct(record.ffaAfter ?? 0))].join(" → ") : t("Not recorded")}
                  sub={t("Stage 1 dosed for {design}% FFA (uniform)", { design: chemistrySettings.designFfa })}
                />
              )}
              {requiresEsterification && <Metric label={t("Esterification duration")} value={`${Number(esterTime) * esterStagesRun} min`} sub={esterStagesRun > 1 ? `${esterStagesRun} × ${esterTime} min` : undefined} />}
              <Metric label={t("Transesterification duration")} value={`${transTime} min`} />
              <Metric label={t("Methanol-to-oil ratio")} value={`${ratio}:1`} sub={t("Molar convention")} />
              <Metric label={t("Methanol")} value={`${(transDoseNow.methanolMl + esterMethanolTotal).toFixed(1)} mL`} sub={requiresEsterification ? t("Esterification + transesterification · loaded by the pumps") : t("Loaded by pump A")} />
              <Metric label={catalyst} value={`${transExact ? "" : t("Up to") + " "}${transDoseNow.catalystToWeighG.toFixed(2)} g`} sub={t("Including neutralization · {purity}% purity", { purity: transDoseNow.purity }) + (transExact ? ` · ${t("exact")}` : "")} />
              <Metric label={t("Acetone")} value={transDoseNow.acetoneMl === null ? t("Unavailable") : `${acetoneTotalMl.toFixed(1)} mL`} sub={t("Per reaction stage · provisional · poured by hand")} />
              {requiresEsterification && <Metric label={t("Sulfuric acid")} value={`${esterAcidTotal.toFixed(2)} mL`} sub={t("98% · in the pump B premix")} />}
              <Metric label={t("Separation")} value={`${PROCESS_CONFIG.separation.timeMinutes} min · ${PROCESS_CONFIG.separation.speedRpm.toLocaleString()} RPM`} />
              <Metric
                label={t("Purification")}
                value={purification.phase === "complete" || saved ? t("{adsorbent} {grams} g · {temp} °C", { adsorbent: t(adsorbentName), grams: magnesolG.toFixed(1), temp: p.holdTemperature }) : t("Not recorded")}
                sub={t("{methanol} methanol removal · {contact} contact · {drain} drain", { methanol: formatMinutes(purification.methanolSeconds), contact: formatMinutes(purification.contactSeconds), drain: formatTimer(purification.drainSeconds) })}
              />
              <Metric label={t("Biodiesel output")} value={savedBatch?.biodieselOutputMl ? t("{ml} mL · {pct}% yield", { ml: savedBatch.biodieselOutputMl.toFixed(1), pct: savedBatch.yield }) : t("Not measured")} sub={savedBatch?.biodieselOutputMl ? `${t("Output load cell")}${savedBatch.purification?.outputWeightG ? ` · ${savedBatch.purification.outputWeightG.toFixed(1)} g` : ""}` : undefined} />
              {savedBatch?.createdAt && <Metric label={t("Average reaction temperature")} value={`${savedBatch.temperature} °C`} sub={t("Measured during transesterification")} />}
              {savedBatch?.createdAt && <Metric label={t("Energy used")} value={`${savedBatch.energy} kWh`} sub={t("Electrodes (plus heater, if configured)")} />}
              <Metric label={t("Completion date")} value={completedAt ? completedAt.toLocaleString() : "—"} />
            </div>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link to="/dashboard" className="btn-primary">{t("Return to Dashboard")}</Link>
              <Link to="/batches" className="btn-secondary">{t("View Batch History")} →</Link>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
