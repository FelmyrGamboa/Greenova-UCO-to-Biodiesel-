import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import {
  Button,
  Card,
  Field,
  Heading,
  Metric,
  Progress,
  SelectField,
  Status,
} from "../components/ui";
import { useLiveData } from "../contexts/LiveContext";
import {
  demoAdd,
  getNextBatchId,
  getRecommendedParametersForFfa,
  getSystemStatus,
  isOffline,
  loadDemoOil,
  pumpAction,
  purificationAction,
  saveCompletedBatch,
  stageAction,
  startPump,
  startPurification,
  startStage,
  type BatchRecord,
  type DrainPhase,
  type DrainValve,
  type PumpName,
  type PumpPhase,
  type PurificationPhase,
  type StageName,
  type StageStatus,
  type SystemStatus,
} from "../lib/api";
import { formatFfa } from "../lib/greenovaData";
import { useT, type TFunction } from "../lib/i18n";

type DeviceState = "ready" | "checking" | "fault";
type StageState = "ready" | "running" | "paused" | "complete" | "fault";
const PURIFYING: PurificationPhase[] = ["heating", "methanol", "magnesol", "contact", "settling", "cooling", "drain"];
type ChemistrySettings = {
  oilMolarMass: number;
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

const CURRENT_LIMITS = { min: 0.5, max: 2, default: 1 };

export const PROCESS_CONFIG = {
  oil: {
    minimumVolumeMl: 100,
    maximumVolumeMl: 1000,
    densityGPerMl: 0.92,
    averageTriglycerideMolecularWeight: 885,
  },
  ffaThreshold: 4,
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
    timeMinutes: 10,
    speedRpm: 2600,
  },
  // Purification (dry wash with Magnesol): fixed values, same as the backend's purification.py
  purification: {
    holdTemperature: 90,
    holdBand: 2,
    maximumTemperature: 95,
    heatingTimeoutMinutes: 15,
    stirringSpeedRpm: 200,
    drainStableGrams: 2,
    drainStableSeconds: 30,
    drainMaximumMinutes: 20,
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
      ["Magnesol", "Magnesol is a fine powder: wear a dust mask and avoid breathing the dust."],
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

function decimalError(
  t: TFunction,
  value: string,
  limits: { min: number; max: number },
  messages?: { empty?: string; min?: string; max?: string },
) {
  if (!value.trim() || !/^(?:\d+\.?\d*|\.\d+)$/.test(value)) {
    return messages?.empty ?? t("Enter a valid numeric value.");
  }
  const number = Number(value);
  if (number < limits.min) return messages?.min ?? t("Minimum value is {value}.", { value: limits.min });
  if (number > limits.max) return messages?.max ?? t("Maximum value is {value}.", { value: limits.max });
  return "";
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
    kohPurity: positive("kohPurity", 90),
    naohPurity: positive("naohPurity", 98),
    designFfa: positive("esterificationDesignFfa", 10),
    stripMaxFfa: positive("stripMaxFfa", 5),
    ffaTarget: positive("ffaTarget", 1),
  };
}

/** Outlet valves (Settings → Esterification and Dosing). */
function getTransferSettings() {
  const settings = readSettings();
  return {
    reactorDrainMinutes: settingNumber(settings, "reactorDrainTime", 1),
    centrifugeDrainMinutes: settingNumber(settings, "centrifugeDrainTime", 3),
  };
}

/** Purification: the four editable values (Settings → Purification). */
function getPurificationSettings() {
  const settings = readSettings();
  return {
    methanolRemovalMinutes: settingNumber(settings, "methanolRemovalTime", 10, 1),
    contactMinutes: settingNumber(settings, "contactTime", 15, 1),
    settlingMinutes: settingNumber(settings, "settlingTime", 10),
    maxDrainTemperature: settingNumber(settings, "maxDrainTemperature", 50, 1),
  };
}

type PurificationSettings = ReturnType<typeof getPurificationSettings>;

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

/** Magnesol for the dry wash: oil mL × 0.92 × 1% = oil mL × 0.0092 g, rounded to 0.1 g. */
function magnesolGrams(oilVolumeMl: number | null) {
  return oilVolumeMl ? Math.round(oilVolumeMl * 0.0092 * 10 + 1e-9) / 10 : 0;
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
) {
  const esterificationNeeded = ffa > PROCESS_CONFIG.ffaThreshold;
  const ester = esterificationDose(oilMassG, oilVolumeMl, ffa, 1, settings);
  // With esterification the catalyst is an "up to" amount (neutralizing the 1% target); the
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
    magnesolG: magnesolGrams(oilVolumeMl),
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
  settlingRemaining: number;
  coolingSeconds: number;
  drainElapsed: number;
  stableSeconds: number;
  anchorG: number | null;
  outputG: number;
  tankG: number;
  oilG: number;
  warning: string | null;
  stopReason: string | null;
};

function stepLocalPurification(sim: LocalPurification, settings: PurificationSettings) {
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
    if (sim.temperature >= p.holdTemperature) sim.phase = "methanol";
    else if (sim.heatingSeconds >= p.heatingTimeoutMinutes * 60) fault(`${p.holdTemperature} °C not reached within ${p.heatingTimeoutMinutes} min`);
  } else if (sim.phase === "methanol") {
    if (sim.temperature <= p.holdTemperature - p.holdBand) sim.heaterOn = true;
    if (sim.temperature >= p.holdTemperature + p.holdBand) sim.heaterOn = false;
    sim.methanolRemaining = Math.max(sim.methanolRemaining - 1, 0);
    if (sim.methanolRemaining === 0) {
      sim.heaterOn = false;
      sim.phase = "magnesol";
    }
  } else if (sim.phase === "magnesol") {
    if (sim.magnesolAdded) sim.phase = "contact";
  } else if (sim.phase === "contact") {
    sim.contactRemaining = Math.max(sim.contactRemaining - 1, 0);
    if (sim.contactRemaining === 0) {
      sim.stirrerOn = false;
      sim.phase = "settling";
    }
  } else if (sim.phase === "settling") {
    sim.settlingRemaining = Math.max(sim.settlingRemaining - 1, 0);
    if (sim.settlingRemaining === 0) sim.phase = sim.temperature > settings.maxDrainTemperature ? "cooling" : "drain";
  } else if (sim.phase === "cooling") {
    sim.coolingSeconds += 1;
    if (sim.temperature <= settings.maxDrainTemperature) sim.phase = "drain";
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
    const started = sim.outputG > p.drainStableGrams;
    if ((started && sim.stableSeconds >= p.drainStableSeconds) || sim.drainElapsed >= p.drainMaximumMinutes * 60) {
      sim.phase = "complete";
      if (sim.oilG > 0 && sim.outputG < p.lowOutputFraction * sim.oilG) {
        sim.warning = `Low output – check the filter. ${sim.outputG.toFixed(0)} g collected from ${sim.oilG.toFixed(0)} g of oil.`;
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
  const error = decimalError(t, value, limits);
  return (
    <div>
      <Field
        label={t(label)}
        inputMode="decimal"
        value={value}
        onChange={(event) => setValue(event.target.value)}
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
};

type PumpView = { phase: PumpPhase; deliveredG: number; faultReason: string | null; byTime: boolean };

/** Before a reaction stage: the pump loads the dose by itself (by the reactor load cell), the
 * operator pours the acetone, and the stage starts by itself once both are in. */
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
  acetone?: { ml: number; g: number; addedG: number; onDemoAdd?: () => void } | null;
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
                <span className="text-gray-300">{t("Pour {ml} mL acetone through the inlet", { ml: acetone.ml.toFixed(1) })}</span>
                <span className="font-mono text-white">{acetone.addedG.toFixed(1)} / {acetone.g.toFixed(1)} g</span>
              </div>
              <div className="mt-2"><Progress value={acetone.g > 0 ? (acetone.addedG / acetone.g) * 100 : 100} /></div>
              {acetone.onDemoAdd && acetone.addedG < acetone.g * 0.95 && (
                <Button variant="secondary" className="mt-3" onClick={acetone.onDemoAdd}>{t("Pour acetone (demo)")}</Button>
              )}
            </div>
          ) : (
            <p className="text-sm text-gray-500">{t("Then pour {ml} mL acetone through the inlet. Wait until the pump has finished: it doses by the reactor's weight.", { ml: acetone.ml.toFixed(1) })}</p>
          )
        )}
        {currentByHand && (
          <p className="rounded-lg border border-amber-400/25 bg-amber-400/[0.05] px-3 py-2 text-sm font-semibold text-amber-400">
            {t("Set the power supply current to {amps} A", { amps: current })}
          </p>
        )}
      </div>
    </div>
  );
}

type DrainView = { phase: DrainPhase; remainingSeconds: number; totalSeconds: number; waitingFor: string | null; faultReason: string | null };

const DRAIN_INFO: Record<DrainValve, { label: string; to: string }> = {
  reactor_outlet: { label: "Reactor outlet valve", to: "draining to the centrifuge" },
  centrifuge_outlet: { label: "Centrifuge outlet valve", to: "draining to the purification tank" },
};

/** An outlet valve that opens by itself: only an Open / Closed indicator. */
function ValveIndicator({ valve, view }: { valve: DrainValve; view: DrainView | null }) {
  const t = useT();
  const info = DRAIN_INFO[valve];
  const phase = view?.phase ?? "idle";
  const open = phase === "draining";
  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.07] bg-gv-inset px-5 py-4" data-testid={`valve-${valve}`}>
      <div className="text-sm text-gray-300">
        <span className="font-semibold text-white">{t(info.label)}</span>
        {open && <span> · {t(info.to)} · {formatTimer(view?.remainingSeconds ?? 0)}</span>}
        {phase === "waiting" && <span> · {t("waiting for the centrifuge to stop")}</span>}
      </div>
      <Status tone={open ? "green" : "neutral"}>{open ? t("OPEN") : t("CLOSED")}</Status>
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
  const error = aboveStrip ? "" : decimalError(t, value, { min: 0, max: settings.stripMaxFfa }, {
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
          <Field label={t("FFA after esterification")} inputMode="decimal" value={aboveStrip ? String(settings.stripMaxFfa) : value} disabled={aboveStrip} onChange={(event) => setValue(event.target.value)} unit="%" aria-invalid={Boolean(error) && value !== ""} />
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
            {t("FFA {ffa}% is at or below {target}%. Transesterification uses the exact amount: {grams} g {catalyst}.", { ffa: next.ffa.toFixed(1), target: settings.ffaTarget, grams: next.trans.catalystToWeighG.toFixed(2), catalyst })}
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-amber-400/25 bg-amber-400/[0.05] p-4 text-sm text-amber-400">
            {t("FFA is still above {target}%. Stage {stage}: {methanol} mL methanol (40:1) + {acid} mL H₂SO₄, dosed for {dose}% FFA. No more acetone.", { target: settings.ffaTarget, stage: stage + 1, methanol: next.ester.methanolMl.toFixed(1), acid: next.ester.sulfuricAcidMl.toFixed(2), dose: next.ester.doseFfa.toFixed(1) })}
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
                ? t("FFA was still above 1% after the last stage: another acid stage, dosed for the re-check reading.")
                : t("Acid pretreatment of high-FFA feedstock before transesterification. The dose is the same for every oil above 4% FFA.")
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
                sub={isEsterification ? t("{ratio} methanol to FFA · dose for {dose}% FFA", { ratio: esterStage === 1 ? "20:1" : "40:1", dose: esterDose.doseFfa.toFixed(1) }) : t("{ratio}:1 molar ratio · calculated", { ratio })}
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
type LocalDrain = { valve: DrainValve; phase: DrainPhase; remainingSeconds: number; totalSeconds: number };
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
  magnesolG: number | null;
  warning: string | null;
  stopReason: string | null;
  stopOccurred: boolean;
  automatic: boolean;
  heatingSeconds: number;
  methanolSeconds: number;
  contactSeconds: number;
  settlingSeconds: number;
  coolingSeconds: number;
  drainSeconds: number;
};

const READY_PURIFICATION: PurificationView = {
  phase: "ready", temperature: null, highest: null, heaterOn: false, stirrerOn: false, stirrerRpm: null,
  valveOpen: false, stepRemaining: null, outputG: 0, oilG: null, magnesolG: null, warning: null, stopReason: null,
  stopOccurred: false, automatic: true, heatingSeconds: 0, methanolSeconds: 0, contactSeconds: 0,
  settlingSeconds: 0, coolingSeconds: 0, drainSeconds: 0,
};

const PURIFICATION_STEPS: Array<[PurificationPhase, string]> = [
  ["heating", "Heating"],
  ["methanol", "Methanol removal"],
  ["magnesol", "Add Magnesol"],
  ["contact", "Contact"],
  ["settling", "Settling"],
  ["cooling", "Cooling"],
  ["drain", "Draining"],
  ["complete", "Done"],
];

export default function NewBatch() {
  const t = useT();
  const [step, setStep] = useState(0);
  // Reactor load cell: the oil, then everything poured or pumped in (live, or the local demo).
  const [reactorG, setReactorG] = useState(0);
  // The oil weight recorded when the oil loading is confirmed; the calculations use it from then on.
  const [confirmedOilG, setConfirmedOilG] = useState<number | null>(null);
  const oilMassG = confirmedOilG ?? reactorG;
  const [targetVolume, setTargetVolume] = useState("500");
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
  const [localDrain, setLocalDrain] = useState<LocalDrain | null>(null);
  // Reactor weight when each dose's step opened, to show the acetone poured since
  const [acetoneBase, setAcetoneBase] = useState<Record<string, number>>({});
  const transferSettings = useMemo(getTransferSettings, []);
  const purificationSettings = useMemo(getPurificationSettings, []);
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
  const [transCompletedAt, setTransCompletedAt] = useState<number | null>(null);
  const [separationState, setSeparationState] = useState<StageState>("ready");
  const [purification, setPurification] = useState<PurificationView>(READY_PURIFICATION);
  const localPurification = useRef<LocalPurification | null>(null);
  const autoStarted = useRef(false);
  const [heaterConfirmed, setHeaterConfirmed] = useState(false); // only used without a level switch
  const [saved, setSaved] = useState(false);
  const { live, backend, mock } = useLiveData();
  const [actionError, setActionError] = useState<string | null>(null);
  const [savedBatch, setSavedBatch] = useState<BatchRecord | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [batchId, setBatchId] = useState(() => `B-${new Date().getFullYear()}-${String(Date.now()).slice(-3)}`);
  const [processConfigCurrentControl, setProcessConfigCurrentControl] = useState(false);

  // Batch ID from the backend's naming format (local ID when offline).
  useEffect(() => {
    let cancelled = false;
    getNextBatchId().then((id) => { if (!cancelled) setBatchId(id); }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
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
        if (!cancelled) setProcessConfigCurrentControl(Boolean(config.powerSupply?.currentControl));
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
      stirrerRpm: sim.stirrerOn ? PROCESS_CONFIG.purification.stirringSpeedRpm - 2 : 0,
      valveOpen: sim.phase === "drain",
      stepRemaining:
        sim.phase === "methanol" ? sim.methanolRemaining
          : sim.phase === "contact" ? sim.contactRemaining
            : sim.phase === "settling" ? sim.settlingRemaining
              : sim.phase === "drain" ? PROCESS_CONFIG.purification.drainMaximumMinutes * 60 - sim.drainElapsed
                : null,
      outputG: sim.outputG,
      oilG: sim.oilG,
      magnesolG: magnesolGrams(oilVolumeMl),
      warning: sim.warning,
      stopReason: sim.stopReason,
      stopOccurred: Boolean(sim.stopReason),
      automatic: true,
      heatingSeconds: sim.heatingSeconds,
      methanolSeconds: total(purificationSettings.methanolRemovalMinutes) - sim.methanolRemaining,
      contactSeconds: total(purificationSettings.contactMinutes) - sim.contactRemaining,
      settlingSeconds: total(purificationSettings.settlingMinutes) - sim.settlingRemaining,
      coolingSeconds: sim.coolingSeconds,
      drainSeconds: sim.drainElapsed,
    });
  }

  // No backend: run the purification as a local demonstration, one step per second.
  useEffect(() => {
    if (backend || !PURIFYING.includes(purification.phase)) return;
    const timer = window.setInterval(() => {
      const sim = localPurification.current;
      if (!sim) return;
      stepLocalPurification(sim, purificationSettings);
      showLocalPurification({ ...sim });
    }, 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, purification.phase, purificationSettings]);

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
      magnesolG: p.magnesolG,
      warning: p.warning,
      stopReason: p.safetyStopReason,
      stopOccurred: p.safetyStopOccurred,
      automatic: p.automatic,
      heatingSeconds: p.heatingTimeSeconds,
      methanolSeconds: p.methanolTotalSeconds - p.methanolRemainingSeconds,
      contactSeconds: p.contactTotalSeconds - p.contactRemainingSeconds,
      settlingSeconds: p.settlingTotalSeconds - p.settlingRemainingSeconds,
      coolingSeconds: p.coolingSeconds,
      drainSeconds: p.drainElapsedSeconds,
    });
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

  // Local demonstration of an outlet valve: open for its drain time, one step per second.
  useEffect(() => {
    if (backend || !localDrain || localDrain.phase !== "draining") return;
    const timer = window.setTimeout(() => {
      const remaining = Math.max(localDrain.remainingSeconds - 1, 0);
      if (remaining === 0 && localDrain.valve === "reactor_outlet") setReactorG(0);
      setLocalDrain({ ...localDrain, remainingSeconds: remaining, phase: remaining === 0 ? "done" : "draining" });
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [backend, localDrain]);

  const oilVolumeMl =
    PROCESS_CONFIG.oil.densityGPerMl > 0
      ? oilMassG / PROCESS_CONFIG.oil.densityGPerMl
      : null;
  const targetError = decimalError(
    t,
    targetVolume,
    {
      min: PROCESS_CONFIG.oil.minimumVolumeMl,
      max: PROCESS_CONFIG.oil.maximumVolumeMl,
    },
    {
      min: t("Minimum oil volume is 100 mL."),
      max: t("Maximum supported oil volume is 1000 mL."),
    },
  );
  const ffaError = ffaAboveStrip ? "" : decimalError(t, ffa, { min: 0, max: 100 }, { empty: t("Enter a valid FFA percentage.") });
  // Above the strip's range the batch is recorded at the strip's maximum (5%), marked "≥".
  const ffaNumber = ffaAboveStrip ? chemistrySettings.stripMaxFfa : Number(ffa);
  const requiresEsterification =
    !ffaError && ffaNumber > PROCESS_CONFIG.ffaThreshold;
  const measuredOilError =
    oilMassG <= 0 || oilVolumeMl === null
      ? t("Load-cell reading is unavailable.")
      : oilVolumeMl < PROCESS_CONFIG.oil.minimumVolumeMl
        ? t("Minimum oil volume is 100 mL.")
        : oilVolumeMl > PROCESS_CONFIG.oil.maximumVolumeMl
          ? t("Maximum supported oil volume is 1000 mL.")
          : "";
  const esterErrors = [
    decimalError(t, esterVoltage, PROCESS_CONFIG.esterification.voltage),
    decimalError(t, esterTime, PROCESS_CONFIG.esterification.time),
    decimalError(t, esterStirring, PROCESS_CONFIG.esterification.stirring),
    decimalError(t, esterCurrent, PROCESS_CONFIG.esterification.current),
  ];
  const transErrors = [
    decimalError(t, transVoltage, PROCESS_CONFIG.transesterification.voltage),
    decimalError(t, transTime, PROCESS_CONFIG.transesterification.time),
    decimalError(t, transStirring, PROCESS_CONFIG.transesterification.stirring),
    decimalError(t, transCurrent, PROCESS_CONFIG.transesterification.current),
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
  );
  const calculatorReady = oilMassG > 0 && !ffaError;

  // ----- esterification stages and the FFA re-check -----
  const esterDoseNow = esterificationDose(oilMassG, oilVolumeMl, esterStage === 1 ? ffaNumber : nextDoseFfa ?? ffaNumber, esterStage, chemistrySettings);
  const recheckError = recheckAbove ? "" : decimalError(t, recheckValue, { min: 0, max: chemistrySettings.stripMaxFfa });
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
  const magnesolG = purification.magnesolG ?? calculatorValues.magnesolG;
  useEffect(() => {
    if (ffaError) return;
    let cancelled = false;
    // Best parameters for this FFA range, from the Raspberry Pi's batch records (local records offline).
    getRecommendedParametersForFfa(ffaNumber)
      .then((recommendation) => {
        if (cancelled || !recommendation) return;
        if (recommendation.esterificationVoltage != null) {
          setEsterVoltage(String(recommendation.esterificationVoltage));
        }
        if (recommendation.esterificationTime != null) {
          setEsterTime(String(recommendation.esterificationTime));
        }
        if (recommendation.esterificationStirring != null) {
          setEsterStirring(String(recommendation.esterificationStirring));
        }
        setTransVoltage(String(recommendation.transesterificationVoltage));
        setTransTime(String(recommendation.transesterificationTime));
        setTransStirring(String(recommendation.transesterificationStirring));
        setRatio(recommendation.methanolRatio);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ffaError, ffaNumber]);

  const targetReached =
    !targetError &&
    oilVolumeMl !== null &&
    Math.abs(oilVolumeMl - Number(targetVolume)) <= Math.max(Number(targetVolume) * 0.02, 5);
  const loadingStatus =
    oilMassG <= 0
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
    {
      label: "Oil Input",
      value: reactorG > 0 ? `${reactorG.toFixed(1)} g` : "No oil detected",
      secondary: "Pour the oil through the inlet filter",
      state: "ready",
    },
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
  const loadCellReading = !backend || (live?.sensors.oilMassG ?? null) !== null;
  const acetoneNeeded = reactionDose !== null && reactionDose.acetoneG > 0 && !(currentStage === "Esterification" && esterStage > 1);
  const acetoneOk = !doseKey || !acetoneNeeded || !loadCellReading || acetonePouredG(doseKey) >= (reactionDose?.acetoneG ?? 0) * 0.95;
  const doseIn = doseKey !== null && reactionDose !== null && doseLoaded(doseKey, reactionDose.targetG);

  // ----- outlet valves -----
  function drainViewFor(valve: DrainValve): DrainView | null {
    if (backend) {
      const d = live?.drain;
      if (!d || d.valve !== valve || d.batchId !== batchId || d.phase === "idle") return null;
      return d;
    }
    if (!localDrain || localDrain.valve !== valve) return null;
    return { ...localDrain, waitingFor: null, faultReason: null };
  }

  const drainMinutes = (valve: DrainValve) =>
    valve === "reactor_outlet" ? transferSettings.reactorDrainMinutes : transferSettings.centrifugeDrainMinutes;

  function draining(valve: DrainValve) {
    const view = drainViewFor(valve);
    return view !== null && (view.phase === "waiting" || view.phase === "draining");
  }

  function startLocalDrain(valve: DrainValve) {
    const seconds = Math.round(drainMinutes(valve) * 60);
    if (seconds <= 0) return;
    setLocalDrain({ valve, phase: "draining", remainingSeconds: seconds, totalSeconds: seconds });
  }

  const reactorDraining = draining("reactor_outlet");
  // "Continue to Separation" appears once the reactor outlet has closed again.
  const reactorView = drainViewFor("reactor_outlet");
  const reactorDrained =
    drainMinutes("reactor_outlet") <= 0 ||
    (reactorView !== null && ["done", "stopped", "fault"].includes(reactorView.phase)) ||
    (reactorView === null && transCompletedAt !== null && Date.now() - transCompletedAt > 5000);

  // The dose loads by itself when its stage opens (once per dose; Retry after a pump problem).
  useEffect(() => {
    if (!doseKey || !reactionDose || reactionDose.state !== "ready") return;
    if (autoPumped.current.has(doseKey) || doseLoaded(doseKey, reactionDose.targetG) || pumpRunning || reactorDraining) return;
    autoPumped.current.add(doseKey);
    loadDose(doseKey, reactionDose.pump, reactionDose.targetG, reactionDose.premixMl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doseKey, reactionDose?.state, pumpRunning, reactorDraining]);

  // ... and the stage starts by itself once the dose (and the acetone) is in.
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
    if (nextState === "complete" && kind === "Transesterification") setTransCompletedAt(Date.now());
    if (!backend) {
      setLocal(nextState);
      // the outlet valves open by themselves after these stages (the Pi does this itself)
      if (nextState === "complete" && kind === "Transesterification") startLocalDrain("reactor_outlet");
      if (nextState === "complete" && kind === "Separation") startLocalDrain("centrifuge_outlet");
      return;
    }
    try {
      let result: StageStatus;
      if (nextState === "running" && current === "ready") {
        result = await startStage(
          kind === "Separation"
            ? { stage: kind, batchId, oilMassG }
            : {
                stage: kind,
                batchId,
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
  /** Starts purification now. Normally it starts by itself: the backend starts it after separation
   * when the level switch detects biodiesel, and the local demonstration starts it on this screen. */
  async function startPurificationNow() {
    setActionError(null);
    if (backend) {
      try {
        await startPurification({ heaterSubmerged: heaterConfirmed, batchId, oilVolumeMl: oilVolumeMl ?? undefined });
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
      settlingRemaining: Math.round(purificationSettings.settlingMinutes * 60),
      coolingSeconds: 0,
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
    else if (sim.phase === "settling") sim.settlingRemaining = 1;
    else if (sim.phase === "cooling") sim.temperature = purificationSettings.maxDrainTemperature;
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

  // Separation complete: go on to Purification by itself.
  useEffect(() => {
    if (currentStage !== "Separation" || separationState !== "complete") return;
    const timer = window.setTimeout(next, 1500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStage, separationState]);

  // Local demonstration: purification starts by itself on the Purification screen (once per batch),
  // after the centrifuge outlet has closed. With the backend, the Raspberry Pi starts it itself.
  useEffect(() => {
    if (backend || currentStage !== "Purification" || autoStarted.current || purification.phase !== "ready") return;
    if (localDrain && localDrain.valve === "centrifuge_outlet" && localDrain.phase === "draining") return;
    autoStarted.current = true;
    startPurificationNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, currentStage, purification.phase, localDrain]);

  const levelSwitch = backend && live ? live.sensors.heaterSubmerged : null;
  const autoStartPending = backend && live !== null && live.purificationAutoStart === batchId;
  const centrifugeDraining = draining("centrifuge_outlet");
  const showManualStart =
    purification.phase === "ready" && !purification.stopReason && !centrifugeDraining && (!backend || !autoStartPending || levelSwitch === null);

  async function completeBatch() {
    if (!saved) {
      setActionError(null);
      const totalReactionTime =
        Number(transTime) + (requiresEsterification ? Number(esterTime) * esterStagesRun : 0);
      const oilVolume = Number((oilVolumeMl ?? 0).toFixed(1));
      // Offline the website works out the yield itself from the output load cell; the Pi does it on its own.
      const localOutputMl = !backend && purification.outputG > 0 ? Number((purification.outputG / 0.88).toFixed(1)) : undefined;
      let result: BatchRecord;
      try {
        result = await saveCompletedBatch({
          id: batchId,
          date: new Date().toISOString().slice(0, 10),
          oilVolume,
          yield: localOutputMl && oilVolume ? Number(((localOutputMl / oilVolume) * 100).toFixed(1)) : 0,
          biodieselOutputMl: localOutputMl,
          duration: totalReactionTime + PROCESS_CONFIG.separation.timeMinutes,
          energy: 0,
          status: "Completed",
          labResult: "Pending",
          ffa: ffaNumber,
          ffaAboveStrip,
          oilMassG: Number(oilMassG.toFixed(1)),
          catalystToWeighG: Number(transDoseNow.catalystToWeighG.toFixed(3)),
          esterificationStages: esterRecords,
          esterificationRun: requiresEsterification,
          temperature: 27,
          reactionTime: Number(transTime),
          stirringSpeed: Number(transStirring),
          voltage: Number(transVoltage),
          current: Number(transCurrent),
          methanolRatio: ratio,
          esterificationVoltage: requiresEsterification ? Number(esterVoltage) : undefined,
          esterificationTime: requiresEsterification ? Number(esterTime) : undefined,
          esterificationStirring: requiresEsterification ? Number(esterStirring) : undefined,
          esterificationCurrent: requiresEsterification ? Number(esterCurrent) : undefined,
          catalystType: catalyst,
          purification: {
            targetTemperature: PROCESS_CONFIG.purification.holdTemperature,
            highestTemperature: purification.highest ?? 0,
            heatingTimeSeconds: purification.heatingSeconds,
            holdTimeSeconds: purification.methanolSeconds,
            drainTimeSeconds: purification.drainSeconds,
            contactTimeSeconds: purification.contactSeconds,
            settlingTimeSeconds: purification.settlingSeconds,
            coolingTimeSeconds: purification.coolingSeconds,
            magnesolG,
            magnesolAdded: true,
            automatic: purification.automatic,
            warning: purification.warning,
            safetyStopOccurred: purification.stopOccurred,
            stirringSpeed: PROCESS_CONFIG.purification.stirringSpeedRpm,
            outputWeightG: purification.outputG || null,
            oilWeightG: purification.oilG ?? Number(oilMassG.toFixed(1)),
          },
        });
      } catch (error) {
        setActionError(errorText(t, error));
        return;
      }
      setSavedBatch(result);
      setSaved(true);
    }
    next();
  }

  const p = PROCESS_CONFIG.purification;
  const purifying = PURIFYING.includes(purification.phase);
  const purificationStepIndex = PURIFICATION_STEPS.findIndex(([phase]) => phase === purification.phase);
  const stepLabel = purificationStepIndex >= 0 ? PURIFICATION_STEPS[purificationStepIndex][1] : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="section-kicker">{t("Batch {id}", { id: batchId })}</div>
          <Heading as="h1" className="mt-2 text-3xl font-bold tracking-tight">{t("Process")}</Heading>
          <p className="mt-2 text-sm text-gray-500">{t("Guided electrochemical biodiesel production workflow.")}</p>
        </div>
        <Status tone={currentStage === "Process Complete" ? "green" : "blue"}>
          {currentStage === "Process Complete" ? t("Completed") : t(currentStage)}
        </Status>
      </div>
      <Stepper steps={steps} step={step} />

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
            <Button onClick={next}>{t("Continue")} →</Button>
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
              <p className="mt-1 text-sm text-gray-500">{t("Pour the oil through the inlet filter. The reactor load cell is authoritative for the actual oil mass.")}</p>
              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <ReadOnlyTile label="Live oil mass" value={`${oilMassG.toFixed(1)} g`} secondary={realHardware ? "Reactor load cell · live" : "Reactor load cell · demonstration channel"} state={oilMassG > 0 ? "ready" : "checking"} />
                <ReadOnlyTile label="Converted volume" value={oilVolumeMl === null ? "Unavailable" : `${oilVolumeMl.toFixed(1)} mL`} secondary={t("Configured density: {density} g/mL · assumed", { density: PROCESS_CONFIG.oil.densityGPerMl })} state={oilMassG > 0 ? "ready" : "checking"} />
              </div>
              <div className="mt-5">
                <Field label={t("Target batch volume")} inputMode="decimal" value={targetVolume} onChange={(event) => { setTargetVolume(event.target.value); setConfirmedOilG(null); }} unit="mL" aria-invalid={Boolean(targetError)} />
                <p className={`mt-2 text-xs ${targetError ? "text-red-400" : "text-gray-600"}`}>{targetError || t("Supported prototype capacity: 100–1,000 mL.")}</p>
              </div>
              <div className="mt-5 flex flex-wrap items-center gap-3">
                {!realHardware && <Button variant="secondary" disabled={Boolean(targetError)} onClick={loadDemoReading}>{t("Load demonstration sensor reading")}</Button>}
                {realHardware ? <Status>{t("Live load cell")}</Status> : <Status tone="yellow">{t("Not live hardware")}</Status>}
              </div>
              {measuredOilError && <p className="mt-3 text-xs text-red-400">{measuredOilError}</p>}
            </Card>

            <Card className="p-6 sm:p-8">
              <Heading as="h2" className="text-lg font-semibold">{t("2. FFA Measurement")}</Heading>
              <p className="mt-1 text-sm text-gray-500">{t("Measure the feedstock using the FFA test strips, then enter the observed result. The strip reads up to {max}%.", { max: chemistrySettings.stripMaxFfa })}</p>
              <div className="mt-6">
                <Field label={t("FFA Percentage")} inputMode="decimal" value={ffaAboveStrip ? String(chemistrySettings.stripMaxFfa) : ffa} disabled={ffaAboveStrip} onChange={(event) => setFfa(event.target.value)} unit="%" aria-invalid={Boolean(ffaError)} />
                {ffaError && <p className="mt-2 text-xs text-red-400">{ffaError}</p>}
                {!ffaError && !ffaAboveStrip && ffaNumber > chemistrySettings.stripMaxFfa && (
                  <p className="mt-2 text-xs text-amber-400">{t("The strip reads only up to {max}%. If it shows its darkest color, tick the box below.", { max: chemistrySettings.stripMaxFfa })}</p>
                )}
                <label className="mt-4 flex items-center gap-2 text-sm text-gray-300">
                  <input className="gv-checkbox" type="checkbox" checked={ffaAboveStrip} onChange={(event) => setFfaAboveStrip(event.target.checked)} />
                  {t("The strip shows its darkest color ({max}% or more)", { max: chemistrySettings.stripMaxFfa })}
                </label>
              </div>
              {!ffaError && (
                <div className="mt-5 rounded-xl border border-white/[0.08] bg-white/[0.025] p-4">
                  <div className="gv-label">{t("Pathway decision · threshold {value}%", { value: PROCESS_CONFIG.ffaThreshold.toFixed(1) })}</div>
                  <p className="text-sm text-gray-300">
                    {ffaAboveStrip
                      ? t("FFA {max}% or more (recorded as ≥ {max}%). Esterification with the uniform dose for {design}% FFA, then an FFA re-check.", { max: chemistrySettings.stripMaxFfa, design: chemistrySettings.designFfa })
                      : requiresEsterification
                        ? t("Esterification required before transesterification: the uniform dose for {design}% FFA, then an FFA re-check.", { design: chemistrySettings.designFfa })
                        : t("Proceed directly to transesterification.")}
                  </p>
                </div>
              )}
            </Card>
          </div>

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
                  {t("Esterification not needed — FFA is 4% or below.")}
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
                <ReadOnlyTile
                  label="Magnesol (dry wash)"
                  value={calculatorReady ? `${calculatorValues.magnesolG.toFixed(1)} g` : "—"}
                  secondary={calculatorReady ? t("Oil volume × 0.0092 (1% of the biodiesel)") : undefined}
                />
              </div>
            </div>
          </Card>

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
          <SectionHeader eyebrow={t("Manual stage")} title={t("Oil Loading")} description={t("Pour the oil through the inlet filter while the reactor load cell weighs it.")} />
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="p-5"><Metric label={t("Target oil volume")} value={`${Number(targetVolume).toFixed(1)} mL`} /></Card>
            <Card className="p-5"><Metric label={t("Live measured mass")} value={`${oilMassG.toFixed(1)} g`} sub={realHardware ? t("Live load-cell data") : t("Demonstration load-cell data")} /></Card>
            <Card className="p-5"><Metric label={t("Converted volume")} value={oilVolumeMl === null ? t("Unavailable") : `${oilVolumeMl.toFixed(1)} mL`} sub={t("Using configured assumed density")} /></Card>
            <Card className="p-5"><Metric label={t("Loading status")} value={loadingStatus} accent={targetReached} /></Card>
          </div>
          <div className="mt-6 rounded-xl border border-white/[0.07] bg-gv-inset p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="gv-label">{t("Load-cell status")}</div>
                <p className="text-sm text-gray-300">{targetReached ? t("Required quantity detected within ±2% tolerance.") : t("Continue loading until the target quantity is detected.")}</p>
              </div>
              <Status tone={targetReached ? "green" : measuredOilError ? "red" : "yellow"}>{loadingStatus}</Status>
            </div>
          </div>
          <div className="mt-7 flex flex-wrap gap-3">
            {!targetReached && !realHardware && <Button variant="secondary" onClick={loadDemoReading}>{t("Simulate target reading")}</Button>}
            <Button
              disabled={!targetReached}
              onClick={() => {
                setConfirmedOilG(reactorG);
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
                  onDemoAdd: realHardware ? undefined : () => pourDemoAcetone(transDoseNow.acetoneG - acetonePouredG(key)),
                } : null}
                current={Number(transCurrent)}
                currentByHand={!processConfigCurrentControl}
                status={autoUsed ? "loaded" : doseIn && acetoneOk ? "starting" : "loading"}
              />
            }
            footer={transState === "complete" ? (
              <>
                <ValveIndicator valve="reactor_outlet" view={reactorView} />
                {reactorDrained && (
                  <div className="mt-6"><Button onClick={next}>{t("Continue to Separation")} →</Button></div>
                )}
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
          <p className="mt-4 text-xs leading-5 text-gray-500">{t("The centrifuge controller must verify lid interlock, balance, and required safety conditions before operation. When separation finishes and the centrifuge has stopped, its outlet valve opens by itself and the biodiesel flows to the purification tank; purification then starts by itself.")}</p>
          {separationState === "ready" && reactorDraining && <ValveIndicator valve="reactor_outlet" view={reactorView} />}
          <StageControls state={separationState} setState={(nextState) => controlStage("Separation", nextState, separationState, setSeparationState)} startLabel={backend ? t("Start centrifuge") : t("Record centrifuge start")} onContinue={next} continueLabel={t("Continue to Purification")} onReset={() => resetStage(setSeparationState)} startBlocked={reactorDraining ? t("Wait for the reactor outlet to close: the reactor is still draining into the centrifuge.") : null} />
        </Card>
      )}

      {currentStage === "Purification" && (
        <Card className="p-6 sm:p-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <SectionHeader
              eyebrow={t("Batch {id}", { id: batchId })}
              title={t("Purification")}
              description={t("Dry wash with Magnesol. It runs by itself: you only add the Magnesol when asked, then confirm at the end.")}
            />
            <Status tone={purification.phase === "complete" ? "green" : purification.phase === "fault" ? "red" : purifying ? "yellow" : "neutral"}>
              {purification.phase === "ready" ? t("WAITING") : purification.phase === "fault" ? t("STOPPED") : t(stepLabel ?? "").toUpperCase()}
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
                    <div className={`mt-2 text-[11px] leading-4 ${active ? "text-white" : done ? "text-green-400" : "text-gray-600"}`}>{t(label)}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {(purification.phase === "ready" || centrifugeDraining) && drainViewFor("centrifuge_outlet") && (
            <ValveIndicator valve="centrifuge_outlet" view={drainViewFor("centrifuge_outlet")} />
          )}

          {(purification.phase === "heating" || purification.phase === "methanol") && (
            <p className="mt-6 text-sm text-gray-400" data-testid="prepare-magnesol">{t("Prepare {grams} g Magnesol", { grams: magnesolG.toFixed(1) })}</p>
          )}

          {purification.phase === "magnesol" && (
            <div className="mt-6 rounded-xl border border-green-500/30 bg-green-500/[0.06] p-5" data-testid="add-magnesol">
              <div className="font-display text-lg font-semibold text-green-400">{t("Add {grams} g Magnesol (1% of biodiesel)", { grams: magnesolG.toFixed(1) })}</div>
              <p className="mt-1 text-sm text-gray-400">{t("The heater is off and the stirrer keeps running. Wear a dust mask.")}</p>
              <Button className="mt-4" onClick={confirmMagnesol}>{t("Confirm")}</Button>
            </div>
          )}

          {purification.phase !== "ready" && (
            <LiveReadings source={sourceLabel}>
              <Metric label={t("Temperature")} value={purification.temperature === null ? "—" : `${purification.temperature.toFixed(1)} °C`} sub={purification.phase === "heating" || purification.phase === "methanol" ? t("target {value} °C", { value: p.holdTemperature }) : purification.phase === "cooling" ? t("drain at {value} °C or below", { value: purificationSettings.maxDrainTemperature }) : undefined} />
              <Metric label={t("Stirrer")} value={purification.stirrerOn ? `${purification.stirrerRpm ?? "—"} / ${p.stirringSpeedRpm} RPM` : t("Off")} />
              <Metric label={t("Heater")} value={purification.heaterOn ? t("On") : t("Off")} />
              <Metric label={t("Outlet valve")} value={purification.valveOpen ? t("Open") : t("Closed")} />
              {purification.phase === "drain" ? (
                <Metric label={t("Collected")} value={`${purification.outputG.toFixed(1)} g`} sub={t("output load cell")} />
              ) : (
                <Metric label={t("Step time left")} value={purification.stepRemaining === null ? "—" : formatTimer(purification.stepRemaining)} sub={stepLabel ? t(stepLabel) : undefined} />
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
              <p className="mt-1 text-xs text-gray-500">{t("Heater OFF · stirrer OFF · valve CLOSED")}</p>
              <Button className="mt-4" variant="danger" onClick={acknowledgeSafetyStop}>{t("Acknowledge")}</Button>
            </div>
          )}

          {purification.phase === "complete" && (
            <div className="mt-6 rounded-xl border border-green-500/25 bg-green-500/[0.05] p-5">
              <div className="font-display font-semibold text-green-400">{t("Purification complete")}</div>
              <p className="mt-1 text-sm text-gray-400">{t("The valve is closed. Check the collected biodiesel, then confirm that the process is finished.")}</p>
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
            {purification.phase === "complete" && <Button onClick={completeBatch}>{t("Confirm process finished")} →</Button>}
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
                  value={esterRecords.length ? [formatFfa({ ffa: ffaNumber, ffaAboveStrip }), ...esterRecords.map((record) => `${(record.ffaAfter ?? 0).toFixed(1)}%`)].join(" → ") : t("Not recorded")}
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
                value={purification.phase === "complete" || saved ? t("Magnesol {grams} g · {temp} °C", { grams: magnesolG.toFixed(1), temp: p.holdTemperature }) : t("Not recorded")}
                sub={t("{methanol} methanol removal · {contact} contact · {settling} settling · {drain} drain", { methanol: formatMinutes(purification.methanolSeconds), contact: formatMinutes(purification.contactSeconds), settling: formatMinutes(purification.settlingSeconds), drain: formatTimer(purification.drainSeconds) })}
              />
              <Metric label={t("Biodiesel output")} value={savedBatch?.biodieselOutputMl ? t("{ml} mL · {pct}% yield", { ml: savedBatch.biodieselOutputMl.toFixed(1), pct: savedBatch.yield }) : t("Not measured")} sub={savedBatch?.biodieselOutputMl ? `${t("Output load cell")}${savedBatch.purification?.outputWeightG ? ` · ${savedBatch.purification.outputWeightG.toFixed(1)} g` : ""}` : undefined} />
              {savedBatch?.createdAt && <Metric label={t("Average reaction temperature")} value={`${savedBatch.temperature} °C`} sub={t("Measured during transesterification")} />}
              {savedBatch?.createdAt && <Metric label={t("Energy used")} value={`${savedBatch.energy} kWh`} sub={t("Electrodes (plus heater, if configured)")} />}
              <Metric label={t("Completion date")} value={new Date().toLocaleString()} />
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
